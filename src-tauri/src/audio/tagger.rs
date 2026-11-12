//! AI sound-event tagging with YAMNet (AudioSet, 521 classes) through ONNX Runtime.
//!
//! The model takes a 16 kHz mono waveform and returns one score row per 0.96 s patch.
//! A dedicated thread runs it every `interval` on the newest 0.975 s while tagging is
//! enabled (off → zero cost). Model files: `models/yamnet.onnx`, `models/yamnet_class_map.csv`
//! (Apache-2.0; see THIRD_PARTY_NOTICES.md). Nothing runs if the files are missing.

use ort::session::Session;
use ort::value::Tensor;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const MODEL_SR: usize = 16_000;
const WINDOW: usize = 15_600; // 0.975 s — the first full YAMNet patch

#[derive(Clone, Debug, serde::Serialize)]
pub struct Tag {
    pub seq: u64,
    /// Seconds since capture start (window end).
    pub t: f64,
    /// (class index, display name, score) — top 5 above 0.05.
    pub top: Vec<(usize, String, f32)>,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct TagStatus {
    pub available: bool,
    pub enabled: bool,
    pub interval_ms: u32,
    pub last_ms: f32,
    pub error: Option<String>,
}

pub struct TaggerState {
    pub enabled: bool,
    pub interval: Duration,
    pub sr_in: u32,
    /// 16 kHz mono history (last 2 s).
    buf: VecDeque<f32>,
    pub tags: VecDeque<Tag>,
    pub seq: u64,
    /// Absolute input-frame count at the end of `buf` (for timestamps).
    pub frames_in: u64,
    pub status: TagStatus,
    // resampler: FIR low-pass on the input rate, then linear interpolation
    fir: Vec<f32>,
    hist: VecDeque<f32>,
    phase: f64,
}

impl TaggerState {
    pub fn new() -> Self {
        Self {
            enabled: false,
            interval: Duration::from_millis(500),
            sr_in: 0,
            buf: VecDeque::with_capacity(MODEL_SR * 2),
            tags: VecDeque::with_capacity(256),
            seq: 0,
            frames_in: 0,
            status: TagStatus { interval_ms: 500, ..Default::default() },
            fir: Vec::new(),
            hist: VecDeque::new(),
            phase: 0.0,
        }
    }

    fn design_fir(&mut self, sr_in: u32) {
        // 47-tap windowed-sinc low-pass at 7 kHz for the input rate.
        let n = 47usize;
        let fc = 7_000.0 / sr_in as f32;
        let mut h: Vec<f32> = (0..n)
            .map(|i| {
                let m = i as f32 - (n - 1) as f32 / 2.0;
                let sinc = if m == 0.0 { 2.0 * fc } else { (2.0 * std::f32::consts::PI * fc * m).sin() / (std::f32::consts::PI * m) };
                let w = 0.54 - 0.46 * (2.0 * std::f32::consts::PI * i as f32 / (n - 1) as f32).cos();
                sinc * w
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

    /// Feed interleaved stereo at `sr_in`; keeps a 16 kHz mono history.
    pub fn feed(&mut self, stereo: &[f32], sr_in: u32) {
        // Time base = frames since capture start (same clock as the waveform history),
        // counted even while tagging is off so tag times line up with the Waveform.
        self.frames_in += (stereo.len() / 2) as u64;
        if self.sr_in != sr_in {
            self.sr_in = sr_in;
            self.fir.clear();
        }
        if !self.enabled {
            return;
        }
        if self.fir.is_empty() {
            self.design_fir(sr_in);
        }
        let step = sr_in as f64 / MODEL_SR as f64;
        let n = self.fir.len();
        for fr in stereo.chunks_exact(2) {
            let m = 0.5 * (fr[0] + fr[1]);
            self.hist.push_back(m);
            if self.hist.len() > n {
                self.hist.pop_front();
            }
            // low-passed value at this input sample
            let mut y = 0.0f32;
            for (k, h) in self.fir.iter().enumerate() {
                y += h * self.hist[n - 1 - k];
            }
            self.phase += 1.0;
            while self.phase >= step {
                self.phase -= step;
                self.buf.push_back(y);
                if self.buf.len() > MODEL_SR * 2 {
                    self.buf.pop_front();
                }
            }
        }
    }

    fn window(&self) -> Option<Vec<f32>> {
        if self.buf.len() < WINDOW {
            return None;
        }
        Some(self.buf.iter().skip(self.buf.len() - WINDOW).cloned().collect())
    }

    pub fn tags_since(&self, after: u64) -> Vec<Tag> {
        self.tags.iter().filter(|t| t.seq > after).cloned().collect()
    }
}

/// Finds the bundled model files (dev: src-tauri/models, bundled: resources/models).
pub fn model_dir(resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(r) = resource_dir {
        cands.push(r.join("models"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            cands.push(d.join("models"));
            cands.push(d.join("resources").join("models"));
        }
    }
    cands.push(PathBuf::from("src-tauri").join("models"));
    cands.push(PathBuf::from("models"));
    cands.into_iter().find(|p| p.join("yamnet.onnx").exists() && p.join("yamnet_class_map.csv").exists())
}

fn load_labels(path: &Path) -> Result<Vec<String>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(521);
    for (i, line) in text.lines().enumerate() {
        if i == 0 {
            continue;
        }
        // index,mid,display_name — display_name may be quoted and contain commas
        let mut parts = line.splitn(3, ',');
        let (_idx, _mid, name) = (parts.next(), parts.next(), parts.next().unwrap_or(""));
        out.push(name.trim().trim_matches('"').to_string());
    }
    Ok(out)
}

/// Spawns the inference thread. Returns immediately; errors land in `status.error`.
pub fn start(state: Arc<Mutex<TaggerState>>, dir: Option<PathBuf>) {
    std::thread::Builder::new()
        .name("ai-tagger".into())
        .spawn(move || {
            let Some(dir) = dir else {
                state.lock().status.error = Some("models/yamnet.onnx 없음 — scripts/fetch_models.py 실행".into());
                return;
            };
            let labels = match load_labels(&dir.join("yamnet_class_map.csv")) {
                Ok(l) => l,
                Err(e) => {
                    state.lock().status.error = Some(format!("클래스 표 읽기 실패: {e}"));
                    return;
                }
            };
            // ONNX Runtime is loaded at run time from models/onnxruntime.dll (no link-time dependency).
            let dll = dir.join("onnxruntime.dll");
            let env = match ort::init_from(&dll) {
                Ok(b) => match b.with_name("re-minimeter").build() {
                    Ok(env) => env,
                    Err(e) => {
                        state.lock().status.error = Some(format!("ONNX Runtime 초기화 실패: {e}"));
                        return;
                    }
                },
                Err(e) => {
                    state.lock().status.error = Some(format!("onnxruntime.dll 로드 실패 ({}): {e}", dll.display()));
                    return;
                }
            };
            let mut session: Session = {
                let builder = match Session::builder(&env) {
                    Ok(b) => b,
                    Err(e) => {
                        state.lock().status.error = Some(format!("세션 빌더 실패: {e}"));
                        return;
                    }
                };
                let mut builder = match builder.with_intra_threads(2) {
                    Ok(b) => b,
                    Err(e) => {
                        state.lock().status.error = Some(format!("세션 옵션 실패: {e}"));
                        return;
                    }
                };
                match builder.commit_from_file(dir.join("yamnet.onnx")) {
                    Ok(s) => s,
                    Err(e) => {
                        state.lock().status.error = Some(format!("ONNX 로드 실패: {e}"));
                        return;
                    }
                }
            };
            state.lock().status.available = true;
            log::info!("YAMNet ready ({} classes) from {}", labels.len(), dir.display());
            let mut last = Instant::now();
            let mut last_frames = 0u64;
            loop {
                std::thread::sleep(Duration::from_millis(40));
                let (enabled, interval, win, t_end, frames_in) = {
                    let s = state.lock();
                    (s.enabled, s.interval, if s.enabled { s.window() } else { None }, s.frames_in as f64 / s.sr_in.max(1) as f64, s.frames_in)
                };
                if !enabled || last.elapsed() < interval || frames_in == last_frames {
                    continue;
                }
                let Some(win) = win else { continue };
                last_frames = frames_in;
                // skip silence (< −60 dBFS RMS) — nothing to tag
                let rms = (win.iter().map(|v| v * v).sum::<f32>() / win.len() as f32).sqrt();
                if rms < 0.001 {
                    last = Instant::now();
                    continue;
                }
                last = Instant::now();
                let t0 = Instant::now();
                let input = match Tensor::from_array(([win.len()], win)) {
                    Ok(t) => t,
                    Err(e) => {
                        state.lock().status.error = Some(e.to_string());
                        continue;
                    }
                };
                let result = session.run(ort::inputs!["waveform" => input]);
                let outputs = match result {
                    Ok(o) => o,
                    Err(e) => {
                        state.lock().status.error = Some(format!("추론 실패: {e}"));
                        continue;
                    }
                };
                let scores: Vec<f32> = match outputs["output_0"].try_extract_tensor::<f32>() {
                    Ok((shape, data)) => {
                        // average over patch rows → 521 scores
                        let rows = if shape.len() >= 2 { shape[0] as usize } else { 1 };
                        let cols = labels.len();
                        let mut acc = vec![0.0f32; cols];
                        for r in 0..rows {
                            for c in 0..cols {
                                acc[c] += data[r * cols + c] / rows as f32;
                            }
                        }
                        acc
                    }
                    Err(e) => {
                        state.lock().status.error = Some(format!("출력 해석 실패: {e}"));
                        continue;
                    }
                };
                let mut idx: Vec<usize> = (0..scores.len()).collect();
                idx.sort_by(|a, b| scores[*b].partial_cmp(&scores[*a]).unwrap());
                let top: Vec<(usize, String, f32)> = idx.iter().take(5).filter(|&&i| scores[i] >= 0.05).map(|&i| (i, labels[i].clone(), scores[i])).collect();
                let mut s = state.lock();
                s.seq += 1;
                let seq = s.seq;
                s.tags.push_back(Tag { seq, t: t_end, top });
                if s.tags.len() > 256 {
                    s.tags.pop_front();
                }
                s.status.last_ms = t0.elapsed().as_secs_f32() * 1000.0;
                s.status.error = None;
            }
        })
        .expect("spawn tagger thread");
}
