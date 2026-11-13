//! Live subtitles with whisper.cpp (whisper-rs). Speech is gated by level into
//! utterances (≥ 0.6 s, cut after 400 ms of silence or at 10 s); each utterance is
//! transcribed on a worker thread holding the loaded ggml model. Off → zero cost.
//! Models (`ggml-base.bin`, `ggml-small.bin`, MIT, from ggerganov/whisper.cpp) are looked
//! up in the app's models dir and in `%APPDATA%\ShowMeterBeat\models`.

use parking_lot::Mutex;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
#[cfg(feature = "subtitles")]
use std::time::Duration;

const SR: usize = 16_000;
const GATE_DB: f32 = -50.0;
const MIN_UTT_S: f32 = 0.6;
const MAX_UTT_S: f32 = 10.0;
const SILENCE_S: f32 = 0.4;

#[derive(Clone, Debug, serde::Serialize)]
pub struct Subtitle {
    pub seq: u64,
    /// Utterance start / end in seconds since capture start.
    pub t0: f64,
    pub t1: f64,
    pub text: String,
    pub lang: String,
    pub ms: f32,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct SubStatus {
    pub enabled: bool,
    pub model: String,
    pub loaded: bool,
    pub loading: bool,
    pub lang: String,
    pub queue: usize,
    pub last_ms: f32,
    pub error: Option<String>,
    pub models_dir: String,
}

#[allow(dead_code)]
struct Utterance {
    t0: f64,
    t1: f64,
    audio: Vec<f32>,
}

pub struct SubtitleState {
    pub enabled: bool,
    pub lang: String,
    pub model: String,
    pub status: SubStatus,
    pub subs: VecDeque<Subtitle>,
    pub seq: u64,
    queue: VecDeque<Utterance>,
    // resampler → 16 kHz mono
    sr_in: u32,
    fir: Vec<f32>,
    hist: VecDeque<f32>,
    phase: f64,
    frames_in: u64,
    // utterance gate
    cur: Vec<f32>,
    cur_t0: f64,
    block: Vec<f32>,
    speech_s: f32,
    silence_s: f32,
    in_speech: bool,
}

impl SubtitleState {
    pub fn new() -> Self {
        Self {
            enabled: false,
            lang: "auto".into(),
            model: "base".into(),
            status: SubStatus { model: "base".into(), lang: "auto".into(), ..Default::default() },
            subs: VecDeque::with_capacity(256),
            seq: 0,
            queue: VecDeque::new(),
            sr_in: 0,
            fir: Vec::new(),
            hist: VecDeque::new(),
            phase: 0.0,
            frames_in: 0,
            cur: Vec::new(),
            cur_t0: 0.0,
            block: Vec::new(),
            speech_s: 0.0,
            silence_s: 0.0,
            in_speech: false,
        }
    }

    fn design_fir(&mut self, sr_in: u32) {
        let n = 47usize;
        let fc = 7_000.0 / sr_in as f32;
        let mut h: Vec<f32> = (0..n)
            .map(|i| {
                let m = i as f32 - (n - 1) as f32 / 2.0;
                let sinc = if m == 0.0 { 2.0 * fc } else { (2.0 * std::f32::consts::PI * fc * m).sin() / (std::f32::consts::PI * m) };
                sinc * (0.54 - 0.46 * (2.0 * std::f32::consts::PI * i as f32 / (n - 1) as f32).cos())
            })
            .collect();
        let s: f32 = h.iter().sum();
        for v in h.iter_mut() {
            *v /= s;
        }
        self.fir = h;
        self.hist = VecDeque::from(vec![0.0f32; n]);
        self.phase = 0.0;
        self.sr_in = sr_in;
    }

    pub fn feed(&mut self, stereo: &[f32], sr_in: u32) {
        if !self.enabled {
            return;
        }
        if self.sr_in != sr_in || self.fir.is_empty() {
            self.design_fir(sr_in);
        }
        let step = sr_in as f64 / SR as f64;
        let n = self.fir.len();
        for fr in stereo.chunks_exact(2) {
            let m = 0.5 * (fr[0] + fr[1]);
            self.hist.push_back(m);
            if self.hist.len() > n {
                self.hist.pop_front();
            }
            self.frames_in += 1;
            let mut y = 0.0f32;
            for (k, h) in self.fir.iter().enumerate() {
                y += h * self.hist[n - 1 - k];
            }
            self.phase += 1.0;
            while self.phase >= step {
                self.phase -= step;
                self.push16k(y);
            }
        }
    }

    fn push16k(&mut self, s: f32) {
        self.block.push(s);
        if self.block.len() < SR / 10 {
            return;
        }
        // 100 ms block decision
        let rms = (self.block.iter().map(|v| v * v).sum::<f32>() / self.block.len() as f32).sqrt();
        let db = if rms > 1e-9 { 20.0 * rms.log10() } else { -120.0 };
        let now = self.frames_in as f64 / self.sr_in.max(1) as f64;
        let speech = db > GATE_DB;
        if speech {
            if !self.in_speech {
                self.in_speech = true;
                self.cur_t0 = now - 0.1;
                self.cur.clear();
                self.speech_s = 0.0;
            }
            self.silence_s = 0.0;
            self.speech_s += 0.1;
        } else if self.in_speech {
            self.silence_s += 0.1;
        }
        if self.in_speech {
            self.cur.extend_from_slice(&self.block);
            let end = self.silence_s >= SILENCE_S || self.speech_s >= MAX_UTT_S;
            if end {
                self.in_speech = false;
                if self.speech_s >= MIN_UTT_S {
                    // pad to ≥ 1.1 s (whisper wants some context)
                    while self.cur.len() < SR * 11 / 10 {
                        self.cur.push(0.0);
                    }
                    self.queue.push_back(Utterance { t0: self.cur_t0, t1: now, audio: std::mem::take(&mut self.cur) });
                    if self.queue.len() > 4 {
                        self.queue.pop_front();
                    }
                }
                self.cur.clear();
            }
        }
        self.block.clear();
        self.status.queue = self.queue.len();
    }

    pub fn subs_since(&self, after: u64) -> Vec<Subtitle> {
        self.subs.iter().filter(|s| s.seq > after).cloned().collect()
    }
}

/// Model file lookup: `<models_dir>/ggml-<name>.bin`, then `%APPDATA%\ShowMeterBeat\models`.
pub fn find_model(models_dir: &Option<PathBuf>, name: &str) -> Option<PathBuf> {
    let file = format!("ggml-{name}.bin");
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(d) = models_dir {
        cands.push(d.join(&file));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        cands.push(PathBuf::from(&appdata).join("ShowMeterBeat").join("models").join(&file));
        cands.push(PathBuf::from(&appdata).join("re-minimeter").join("models").join(&file)); // pre-rename folder
    }
    cands.push(PathBuf::from("src-tauri").join("models").join(&file));
    cands.into_iter().find(|p| p.exists())
}

/// Build without the `subtitles` feature: report that the feature is missing.
#[cfg(not(feature = "subtitles"))]
pub fn start(state: Arc<Mutex<SubtitleState>>, models_dir: Option<PathBuf>) {
    let mut s = state.lock();
    s.status.models_dir = models_dir.map(|p| p.display().to_string()).unwrap_or_default();
    s.status.error = Some("이 빌드에는 자막(whisper) 기능이 포함되지 않았습니다 — LLVM 설치 후 `--features subtitles`로 빌드".into());
}

#[cfg(feature = "subtitles")]
pub fn start(state: Arc<Mutex<SubtitleState>>, models_dir: Option<PathBuf>) {
    use std::time::Instant;
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
    std::thread::Builder::new()
        .name("subtitles".into())
        .spawn(move || {
            let mut ctx: Option<(String, WhisperContext)> = None;
            {
                let mut s = state.lock();
                s.status.models_dir = models_dir.as_ref().map(|p| p.display().to_string()).unwrap_or_default();
            }
            loop {
                std::thread::sleep(Duration::from_millis(60));
                let (enabled, model, lang, job) = {
                    let mut s = state.lock();
                    let job = if s.enabled { s.queue.pop_front() } else { None };
                    (s.enabled, s.model.clone(), s.lang.clone(), job)
                };
                if !enabled {
                    continue;
                }
                // (re)load the model when needed
                if ctx.as_ref().map(|(n, _)| n != &model).unwrap_or(true) {
                    let Some(path) = find_model(&models_dir, &model) else {
                        let mut s = state.lock();
                        s.status.error = Some(format!("모델 없음: ggml-{model}.bin — scripts/fetch_models.py --whisper {model} 또는 %APPDATA%\\ShowMeterBeat\\models 에 넣으세요"));
                        s.status.loaded = false;
                        std::thread::sleep(Duration::from_secs(2));
                        continue;
                    };
                    state.lock().status.loading = true;
                    match WhisperContext::new_with_params(path.to_string_lossy().as_ref(), WhisperContextParameters::default()) {
                        Ok(c) => {
                            ctx = Some((model.clone(), c));
                            let mut s = state.lock();
                            s.status.loaded = true;
                            s.status.loading = false;
                            s.status.error = None;
                            log::info!("whisper model loaded: {}", path.display());
                        }
                        Err(e) => {
                            let mut s = state.lock();
                            s.status.error = Some(format!("모델 로드 실패: {e}"));
                            s.status.loading = false;
                            std::thread::sleep(Duration::from_secs(2));
                            continue;
                        }
                    }
                }
                let Some(job) = job else { continue };
                let Some((_, c)) = ctx.as_ref() else { continue };
                let t0 = Instant::now();
                let mut st = match c.create_state() {
                    Ok(s) => s,
                    Err(e) => {
                        state.lock().status.error = Some(format!("state 실패: {e}"));
                        continue;
                    }
                };
                let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
                let lang_opt: Option<&str> = if lang == "auto" { None } else { Some(lang.as_str()) };
                params.set_language(lang_opt);
                params.set_translate(false);
                params.set_print_progress(false);
                params.set_print_special(false);
                params.set_print_realtime(false);
                params.set_print_timestamps(false);
                // Utterances are ≤ 10 s: shrink the encoder context (default 1500 = 30 s)
                // so short clips don't pay for a 30 s encode. 512 ≈ 10.2 s of audio.
                params.set_audio_ctx(512);
                params.set_n_threads(std::thread::available_parallelism().map(|n| (n.get() / 2).clamp(4, 8) as i32).unwrap_or(4));
                params.set_no_context(true);
                params.set_suppress_blank(true);
                if let Err(e) = st.full(params, &job.audio) {
                    state.lock().status.error = Some(format!("인식 실패: {e}"));
                    continue;
                }
                let mut text = String::new();
                for seg in st.as_iter() {
                    if let Ok(t) = seg.to_str_lossy() {
                        let t = t.trim();
                        if !t.is_empty() {
                            if !text.is_empty() {
                                text.push(' ');
                            }
                            text.push_str(t);
                        }
                    }
                }
                let lang_id = st.full_lang_id_from_state();
                let lang_name = whisper_rs::get_lang_str(lang_id).unwrap_or("?").to_string();
                let ms = t0.elapsed().as_secs_f32() * 1000.0;
                let mut s = state.lock();
                s.status.last_ms = ms;
                s.status.error = None;
                if !text.is_empty() {
                    s.seq += 1;
                    let seq = s.seq;
                    s.subs.push_back(Subtitle { seq, t0: job.t0, t1: job.t1, text, lang: lang_name, ms });
                    if s.subs.len() > 500 {
                        s.subs.pop_front();
                    }
                }
            }
        })
        .expect("spawn subtitle thread");
}
