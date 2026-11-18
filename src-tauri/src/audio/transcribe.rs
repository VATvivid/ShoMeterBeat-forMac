//! Polyphonic piano transcription for the Piano module (2026-11-18 사용자: 양손 피아노까지 잘 찍혀
//! 나오게; 이어서 우클릭 딜레이 모드 즉시 / 1 s / 3 s).
//!
//! Three modes, one per model setup (`Spec`):
//!   즉시 (0)  Spotify Basic Pitch (ICASSP 2022, Apache-2.0; `models/nmp.onnx`, 230 kB): 2 s of mono at
//!             22 050 Hz → note activity + onset per 256-sample frame (≈ 86 fps) for the 88 keys. Every
//!             8 frames (≈ 93 ms), keeping the frames ending 8 frames before the window's end (frame
//!             agreement with the offline transcription 0.75 at 0 latency, 0.95 at 8 frames). Shown
//!             ≈ 0.1–0.2 s after the sound. Real covers vs a piano-specific reference: note F1 ≈ 0.87
//!             (normal arrangement) / 0.73 (dense) — the model's own ceiling (offline ≈ 0.86 / 0.71).
//!   1 s / 3 s (1, 2)  Kong et al. 2021 (ByteDance high-resolution piano transcription; checkpoint
//!             CC BY 4.0, zenodo 4034264; inference code MIT),
//!             note model only, exported to ONNX by scripts/export_kong.py (`models/kong_note.onnx`,
//!             99 MB): 16 kHz → frame (activity) + regressed onset at 100 fps. A longer window and more
//!             right context buy accuracy with delay; window / hop / context per mode in `SPECS`
//!             (measured in scratchpad bp/kong_stream.py).
//! Frames are released to the UI at their own rate (`display`), max-pooled over each UI frame.
//! Runs only while the Piano module asks for it (`want`, a heartbeat — off → zero cost).

use ort::session::Session;
use ort::value::Tensor;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const N_KEYS: usize = 88;
const FIR_N: usize = 63;

/// One transcription setup.
pub struct Spec {
    pub file: &'static str,
    pub sr: usize,
    /// Window (samples at `sr`), hop (frames), right context kept unused (frames).
    pub win: usize,
    pub hop_fr: usize,
    pub lat_fr: usize,
    /// Samples per output frame.
    pub frame: usize,
    pub input: &'static str,
    /// Input tensor [1, N, 1] (true) or [1, N] (false).
    pub chan_axis: bool,
    pub note: &'static str,
    pub onset: &'static str,
    pub threads: usize,
}

impl Spec {
    fn fps(&self) -> f64 {
        self.sr as f64 / self.frame as f64
    }
    fn hop(&self) -> usize {
        self.hop_fr * self.frame
    }
}

pub const SPECS: [Spec; 3] = [
    Spec { file: "nmp.onnx", sr: 22_050, win: 43_844, hop_fr: 8, lat_fr: 8, frame: 256, input: "serving_default_input_2:0", chan_axis: true, note: "StatefulPartitionedCall:1", onset: "StatefulPartitionedCall:2", threads: 1 },
    // 1 s: 1.2 s window every 0.4 s, 0.3 s right context — shown ≈ 0.9 s late; ≈ 170 ms per window on
    // 2 threads (≈ 43 % of them). 3 s: 4 s window every 1.5 s, 1 s right context — ≈ 3.3 s late,
    // ≈ 0.8 s per window (≈ 55 %). Against the offline transcription of a dense two-hand cover (note
    // onset F1, scratchpad bp/kong_stream.py): 0.90 (1 s) / 0.91 (3 s) vs Basic Pitch 0.73; a normal
    // arrangement 0.98 vs 0.87. (The reference is the same model offline — this measures what the
    // streaming loses, not the model's own error, ≈ 3 % on MAESTRO.)
    Spec { file: "kong_note.onnx", sr: 16_000, win: 19_200, hop_fr: 40, lat_fr: 30, frame: 160, input: "waveform", chan_axis: false, note: "frame", onset: "onset", threads: 2 },
    Spec { file: "kong_note.onnx", sr: 16_000, win: 64_000, hop_fr: 150, lat_fr: 100, frame: 160, input: "waveform", chan_axis: false, note: "frame", onset: "onset", threads: 2 },
];

pub fn spec(mode: usize) -> &'static Spec {
    &SPECS[mode.min(SPECS.len() - 1)]
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct TranscribeStatus {
    pub available: bool,
    pub active: bool,
    pub error: Option<String>,
    pub last_ms: f32,
    /// Running mode (0 즉시, 1 = 1 s, 2 = 3 s) and which modes have their model file.
    pub mode: usize,
    pub modes: Vec<bool>,
}

pub struct TranscriberState {
    /// The Piano module's heartbeat: transcription runs until this instant.
    pub want_until: Option<Instant>,
    pub mode: usize,
    /// Rate / mode the resampler and buffers were set up for.
    built_for: Option<(u32, usize)>,
    fir: Vec<f32>,
    hist: VecDeque<f32>,
    phase: f64,
    prev: f32,
    /// Mono history at the model rate.
    buf: VecDeque<f32>,
    /// Samples added since the last inference.
    pending: usize,
    /// Frames waiting to be shown: [note 88 | onset 88].
    out: VecDeque<[f32; 2 * N_KEYS]>,
    release_acc: f64,
    last_release: Option<Instant>,
    shown: [f32; 2 * N_KEYS],
    pub status: TranscribeStatus,
}

impl TranscriberState {
    pub fn new() -> Self {
        Self {
            want_until: None,
            mode: 0,
            built_for: None,
            fir: Vec::new(),
            hist: VecDeque::new(),
            phase: 0.0,
            prev: 0.0,
            buf: VecDeque::new(),
            pending: 0,
            out: VecDeque::new(),
            release_acc: 0.0,
            last_release: None,
            shown: [0.0; 2 * N_KEYS],
            status: TranscribeStatus::default(),
        }
    }

    pub fn active(&self) -> bool {
        self.want_until.map_or(false, |t| Instant::now() < t)
    }

    /// Heartbeat from the UI (keeps transcription on for 3 s) with the wanted mode.
    pub fn want(&mut self, on: bool, mode: usize) {
        self.want_until = if on { Some(Instant::now() + Duration::from_secs(3)) } else { None };
        let mode = mode.min(SPECS.len() - 1);
        if mode != self.mode {
            self.mode = mode;
            self.reset();
        }
    }

    fn reset(&mut self) {
        self.built_for = None;
        self.buf.clear();
        self.out.clear();
        self.pending = 0;
        self.shown = [0.0; 2 * N_KEYS];
    }

    fn design_fir(&mut self, sr_in: u32) {
        // windowed-sinc low-pass at 0.45 × the model rate, Blackman
        let sr = spec(self.mode).sr as f32;
        let fc = (0.45 * sr).min(0.45 * sr_in as f32) / sr_in as f32;
        let mut h: Vec<f32> = (0..FIR_N)
            .map(|i| {
                let m = i as f32 - (FIR_N - 1) as f32 / 2.0;
                let sinc = if m == 0.0 { 2.0 * fc } else { (2.0 * std::f32::consts::PI * fc * m).sin() / (std::f32::consts::PI * m) };
                let x = 2.0 * std::f32::consts::PI * i as f32 / (FIR_N - 1) as f32;
                sinc * (0.42 - 0.5 * x.cos() + 0.08 * (2.0 * x).cos())
            })
            .collect();
        let s: f32 = h.iter().sum();
        for v in h.iter_mut() {
            *v /= s;
        }
        self.fir = h;
        self.hist = VecDeque::from(vec![0.0f32; FIR_N]);
        self.phase = 0.0;
        self.prev = 0.0;
    }

    /// Feed interleaved stereo at `sr_in` (only buffered while active).
    pub fn feed(&mut self, stereo: &[f32], sr_in: u32) {
        if !self.active() {
            if !self.buf.is_empty() || !self.out.is_empty() {
                self.reset();
            }
            return;
        }
        if self.built_for != Some((sr_in, self.mode)) {
            self.reset();
            self.design_fir(sr_in);
            self.built_for = Some((sr_in, self.mode));
        }
        let sp = spec(self.mode);
        // low-pass at the input rate, then linear interpolation at the model rate
        let step = sr_in as f64 / sp.sr as f64;
        for fr in stereo.chunks_exact(2) {
            self.hist.push_back(0.5 * (fr[0] + fr[1]));
            self.hist.pop_front();
            let mut y = 0.0f32;
            for (k, h) in self.fir.iter().enumerate() {
                y += h * self.hist[FIR_N - 1 - k];
            }
            // output samples falling between the previous input sample and this one
            self.phase += 1.0;
            while self.phase >= step {
                self.phase -= step;
                let t = self.phase as f32; // distance back from this sample, 0..1
                self.buf.push_back(y + (self.prev - y) * t);
                self.pending += 1;
            }
            self.prev = y;
        }
        let cap = sp.win + 4 * sp.hop();
        while self.buf.len() > cap {
            self.buf.pop_front();
        }
    }

    /// The newest window and how many frames it should emit: as many as the audio advanced since
    /// the last window (the window always ends at the newest sample), at most what one window can
    /// give (its frames minus the right context); a longer backlog is skipped, so the time line
    /// never stretches (a leftover once made the 3 s mode emit 1.5 s per 0.5 s of audio).
    fn take_window(&mut self) -> Option<(Vec<f32>, usize, usize)> {
        let sp = spec(self.mode);
        if self.pending < sp.hop() || self.buf.len() < sp.win {
            return None;
        }
        let max_emit = (sp.win / sp.frame).saturating_sub(sp.lat_fr).max(1);
        let n = self.pending / sp.frame;
        let n_emit = n.min(max_emit);
        self.pending = if n > max_emit { 0 } else { self.pending - n_emit * sp.frame };
        Some((self.buf.iter().skip(self.buf.len() - sp.win).cloned().collect(), n_emit, self.mode))
    }

    /// For offline runs (examples): the next window, as the thread would take it.
    pub fn next_window(&mut self) -> Option<(Vec<f32>, usize, usize)> {
        self.take_window()
    }

    /// Note / onset values for one UI frame: the frames that came due since the last call,
    /// max-pooled (the previous values when none did). [note 88 | onset 88].
    pub fn display(&mut self) -> [f32; 2 * N_KEYS] {
        let now = Instant::now();
        let dt = self.last_release.map_or(0.0, |t| (now - t).as_secs_f64());
        self.last_release = Some(now);
        if !self.active() {
            return [0.0; 2 * N_KEYS];
        }
        let sp = spec(self.mode);
        self.release_acc += dt * sp.fps();
        let mut n = self.release_acc.floor() as usize;
        self.release_acc -= n as f64;
        // a hop's worth arrives at once; let at most ~1.5 hops wait, catch up beyond that
        let slack = sp.hop_fr + sp.hop_fr / 2 + 2;
        if self.out.len() > slack + sp.hop_fr {
            n += self.out.len() - slack;
        }
        n = n.min(self.out.len());
        if n > 0 {
            let mut pooled = [0.0f32; 2 * N_KEYS];
            for _ in 0..n {
                let f = self.out.pop_front().unwrap();
                for (p, v) in pooled.iter_mut().zip(f.iter()) {
                    *p = p.max(*v);
                }
            }
            self.shown = pooled;
        }
        self.shown
    }

    fn push_frames(&mut self, frames: Vec<[f32; 2 * N_KEYS]>, mode: usize) {
        if mode != self.mode {
            return; // the mode changed while this window was being computed
        }
        self.out.extend(frames);
        let cap = 6 * spec(self.mode).hop_fr + 64;
        while self.out.len() > cap {
            self.out.pop_front();
        }
    }
}

/// Loads the session for `mode` from `dir` (shared ONNX Runtime environment).
pub fn load_session(dir: &Path, mode: usize) -> Result<Session, String> {
    let sp = spec(mode);
    let path = dir.join(sp.file);
    let env = super::ortenv::get(dir)?;
    let builder = Session::builder(&env).map_err(|e| format!("세션 빌더 실패: {e}"))?;
    let mut builder = builder.with_intra_threads(sp.threads).map_err(|e| format!("세션 옵션 실패: {e}"))?;
    builder.commit_from_file(&path).map_err(|e| format!("ONNX 로드 실패 ({}): {e}", path.display()))
}

/// One inference on a window: the `n_emit` frames ending `lat_fr` before the window's end.
/// Near-silent windows skip the model (zeros).
pub fn infer(sess: &mut Session, mode: usize, win: Vec<f32>, n_emit: usize) -> Result<Vec<[f32; 2 * N_KEYS]>, String> {
    let sp = spec(mode);
    let mut frames: Vec<[f32; 2 * N_KEYS]> = vec![[0.0; 2 * N_KEYS]; n_emit];
    let rms = (win.iter().map(|v| v * v).sum::<f32>() / win.len().max(1) as f32).sqrt();
    if rms < 3e-4 {
        return Ok(frames);
    }
    let n = win.len();
    let input = if sp.chan_axis { Tensor::from_array(([1usize, n, 1usize], win)) } else { Tensor::from_array(([1usize, n], win)) };
    let input = input.map_err(|e| e.to_string())?;
    let outputs = sess.run(ort::inputs![sp.input => input]).map_err(|e| format!("추론 실패: {e}"))?;
    let (shape, note) = outputs[sp.note].try_extract_tensor::<f32>().map_err(|e| format!("출력 해석 실패: {e}"))?;
    let n_out = shape.get(1).copied().unwrap_or(0) as usize;
    let note = note.to_vec();
    let (_, onset) = outputs[sp.onset].try_extract_tensor::<f32>().map_err(|e| format!("출력 해석 실패: {e}"))?;
    if n_out < sp.lat_fr + n_emit || note.len() < n_out * N_KEYS || onset.len() < n_out * N_KEYS {
        return Err(format!("출력 프레임 부족 ({n_out})"));
    }
    let j0 = n_out - sp.lat_fr - n_emit;
    for (i, fr) in frames.iter_mut().enumerate() {
        let j = j0 + i;
        fr[..N_KEYS].copy_from_slice(&note[j * N_KEYS..(j + 1) * N_KEYS]);
        fr[N_KEYS..].copy_from_slice(&onset[j * N_KEYS..(j + 1) * N_KEYS]);
    }
    Ok(frames)
}

/// Spawns the transcription thread (idle until the Piano module asks).
pub fn start(state: Arc<Mutex<TranscriberState>>, dir: Option<PathBuf>) {
    std::thread::Builder::new()
        .name("piano-transcribe".into())
        .spawn(move || {
            let Some(dir) = dir else {
                state.lock().status.error = Some("models 폴더 없음 — scripts/fetch_models.py 실행".into());
                return;
            };
            let have: Vec<bool> = SPECS.iter().map(|s| dir.join(s.file).exists()).collect();
            state.lock().status.modes = have.clone();
            let mut sessions: Vec<Option<Session>> = (0..SPECS.len()).map(|_| None).collect();
            loop {
                std::thread::sleep(Duration::from_millis(8));
                let job = {
                    let mut s = state.lock();
                    let a = s.active();
                    s.status.active = a;
                    s.status.mode = s.mode;
                    if a { s.take_window() } else { None }
                };
                let Some((win, n_emit, mode)) = job else { continue };
                if !have[mode] {
                    let mut s = state.lock();
                    s.status.available = false;
                    s.status.error = Some(format!("{} 없음 — scripts/fetch_models.py 실행", spec(mode).file));
                    continue;
                }
                if sessions[mode].is_none() {
                    // the two Kong modes share one file but differ only in window handling — one session
                    let twin = (0..SPECS.len()).find(|&m| m != mode && SPECS[m].file == spec(mode).file && sessions[m].is_some());
                    if let Some(t) = twin {
                        sessions[mode] = sessions[t].take();
                    } else {
                        match load_session(&dir, mode) {
                            Ok(sess) => {
                                log::info!("transcribe: {} ready", spec(mode).file);
                                sessions[mode] = Some(sess);
                            }
                            Err(e) => {
                                state.lock().status.error = Some(e);
                                std::thread::sleep(Duration::from_secs(2));
                                continue;
                            }
                        }
                    }
                    let mut st = state.lock();
                    st.status.available = true;
                    st.status.error = None;
                }
                let sess = sessions[mode].as_mut().unwrap();
                let t0 = Instant::now();
                let frames = match infer(sess, mode, win, n_emit) {
                    Ok(f) => f,
                    Err(e) => {
                        state.lock().status.error = Some(e);
                        continue;
                    }
                };
                let mut s = state.lock();
                s.status.last_ms = t0.elapsed().as_secs_f32() * 1000.0;
                s.push_frames(frames, mode);
            }
        })
        .expect("spawn transcribe thread");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_to_the_model_rate_only_while_wanted() {
        let mut t = TranscriberState::new();
        let one_sec = vec![0.1f32; 48_000 * 2];
        t.feed(&one_sec, 48_000);
        assert_eq!(t.buf.len(), 0);
        t.want(true, 0);
        t.feed(&one_sec, 48_000);
        assert!((t.buf.len() as i64 - 22_050).abs() <= 2, "buf {}", t.buf.len());
        let v = *t.buf.back().unwrap();
        assert!((v - 0.1).abs() < 1e-3, "dc {v}");
        // the 1 s mode runs at 16 kHz and starts over
        t.want(true, 1);
        assert_eq!(t.buf.len(), 0);
        t.feed(&one_sec, 48_000);
        assert!((t.buf.len() as i64 - 16_000).abs() <= 2, "buf {}", t.buf.len());
    }

    #[test]
    fn windows_come_in_hops_and_frames_are_released_smoothly() {
        let mut t = TranscriberState::new();
        t.want(true, 0);
        t.feed(&vec![0.0f32; 48_000 * 2 * 3], 48_000);
        // 3 s of audio, the first window: all it can give (171 frames − 8 right context)
        let (w, n, mode) = t.take_window().unwrap();
        assert_eq!((w.len(), n, mode), (SPECS[0].win, (SPECS[0].win / 256) - 8, 0));
        assert!(t.take_window().is_none());
        // then exactly as many frames as the audio advanced
        t.feed(&vec![0.0f32; 4800 * 2], 48_000); // 0.1 s ≈ 2205 samples ≈ 8.6 frames
        let (_, n, _) = t.take_window().unwrap();
        assert_eq!(n, 8);
        t.push_frames(vec![[0.5; 2 * N_KEYS]; 8], 0);
        t.push_frames(vec![[0.9; 2 * N_KEYS]; 8], 1); // stale mode: dropped
        t.display();
        std::thread::sleep(Duration::from_millis(30));
        let d = t.display();
        assert_eq!(d[0], 0.5);
        assert!(t.out.len() < 8 && t.out.len() >= 4, "released {} of 8 in 30 ms", 8 - t.out.len());
    }
}
