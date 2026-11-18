//! AI sound-event tagging (AudioSet) through ONNX Runtime, with a choice of model.
//!
//! Models (picked at run time from the UI, `set_tag_model`):
//!   yamnet          Google YAMNet (2019, Apache-2.0) — 16 kHz waveform [N] in, one score row per
//!                   0.96 s patch out (521 classes); window 0.975 s.
//!   efficientat     EfficientAT mn10_as (Schmid et al. 2023, MIT) — 32 kHz waveform [1, N] in
//!                   (log-mel front end inside the graph, scripts/export_efficientat.py), AudioSet
//!                   probabilities [1, 527] out; window 6 s (it needs ≥ 6 s — see MODELS).
//!                   AudioSet mAP 0.471 vs YAMNet ≈ 0.31.
//! A dedicated thread runs the selected model every `interval` on the newest window while
//! tagging is enabled (off → zero cost) and reloads it when the selection changes. Models whose
//! files are missing are listed as unavailable; see THIRD_PARTY_NOTICES.md for licences.

use ort::session::Session;
use ort::value::Tensor;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// One selectable tagging model.
pub struct ModelSpec {
    pub id: &'static str,
    pub file: &'static str,
    pub labels: &'static str,
    pub sr: usize,
    /// Samples per inference at `sr`.
    pub window: usize,
    pub input: &'static str,
    pub output: &'static str,
    /// Input tensor is [1, N] (true) or [N] (false).
    pub batched: bool,
}

pub const MODELS: [ModelSpec; 2] = [
    ModelSpec { id: "yamnet", file: "yamnet.onnx", labels: "yamnet_class_map.csv", sr: 16_000, window: 15_600, input: "waveform", output: "output_0", batched: false },
    // 6 s window: the model was trained on 10 s clips and collapses on short input (measured
    // 2026-11-17 on the exported graph: ≤ 3 s → every class ≈ 1.0 even on silence, 4 s borderline,
    // 6 s ≈ 10 s results — Music 0.74 / Piano 0.37 on a piano piece, Silence 0.49 on silence).
    ModelSpec { id: "efficientat", file: "efficientat_mn10_as.onnx", labels: "efficientat_class_map.csv", sr: 32_000, window: 192_000, input: "waveform", output: "probs", batched: true },
];

pub fn spec(id: &str) -> &'static ModelSpec {
    MODELS.iter().find(|m| m.id == id).unwrap_or(&MODELS[0])
}

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
    /// Model currently selected (id).
    pub model: String,
    /// Model ids whose files were found.
    pub models: Vec<String>,
}

pub struct TaggerState {
    pub enabled: bool,
    pub interval: Duration,
    pub sr_in: u32,
    /// Selected model id; the thread reloads when it differs from the loaded one.
    pub model: String,
    /// Sample rate of `buf` (the selected model's rate).
    model_sr: usize,
    /// Mono history at `model_sr` (last 3 s).
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
            model: MODELS[0].id.into(),
            model_sr: MODELS[0].sr,
            buf: VecDeque::with_capacity(MODELS[0].sr * 3),
            tags: VecDeque::with_capacity(256),
            seq: 0,
            frames_in: 0,
            status: TagStatus { interval_ms: 500, model: MODELS[0].id.into(), ..Default::default() },
            fir: Vec::new(),
            hist: VecDeque::new(),
            phase: 0.0,
        }
    }

    /// Selects a model (unknown ids fall back to YAMNet). The history restarts at the new rate.
    pub fn set_model(&mut self, id: &str) {
        let s = spec(id);
        if self.model == s.id {
            return;
        }
        self.model = s.id.into();
        self.status.model = s.id.into();
        self.model_sr = s.sr;
        self.buf.clear();
        self.fir.clear();
    }

    fn design_fir(&mut self, sr_in: u32) {
        // 47-tap windowed-sinc low-pass at 0.4375 × the model rate (7 kHz for 16 kHz, 14 kHz for 32 kHz).
        let n = 47usize;
        let fc = (0.4375 * self.model_sr as f32).min(0.45 * sr_in as f32) / sr_in as f32;
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

    /// Feed interleaved stereo at `sr_in`; keeps a mono history at the model rate.
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
        let step = sr_in as f64 / self.model_sr as f64;
        let n = self.fir.len();
        let cap = (self.model_sr * 3).max(spec(&self.model).window + self.model_sr);
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
                if self.buf.len() > cap {
                    self.buf.pop_front();
                }
            }
        }
    }

    fn window(&self, len: usize) -> Option<Vec<f32>> {
        if self.buf.len() < len {
            return None;
        }
        Some(self.buf.iter().skip(self.buf.len() - len).cloned().collect())
    }

    pub fn tags_since(&self, after: u64) -> Vec<Tag> {
        self.tags.iter().filter(|t| t.seq > after).cloned().collect()
    }
}

/// Finds the model folder (dev: src-tauri/models, bundled: resources/models): the first
/// candidate that holds ONNX Runtime and at least one model.
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
    cands.into_iter().find(|p| p.join("onnxruntime.dll").exists() && MODELS.iter().any(|m| has_model(p, m)))
}

fn has_model(dir: &Path, m: &ModelSpec) -> bool {
    dir.join(m.file).exists() && dir.join(m.labels).exists()
}

fn load_labels(path: &Path) -> Result<Vec<String>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(527);
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

/// Mean over patch rows of a [rows, classes] (or [1, classes]) score tensor.
fn row_mean(shape: &[i64], data: &[f32], classes: usize) -> Vec<f32> {
    let rows = if shape.len() >= 2 { shape[0].max(1) as usize } else { 1 };
    let mut acc = vec![0.0f32; classes];
    for r in 0..rows {
        for c in 0..classes {
            if let Some(v) = data.get(r * classes + c) {
                acc[c] += v / rows as f32;
            }
        }
    }
    acc
}

/// Spawns the inference thread. Returns immediately; errors land in `status.error`.
pub fn start(state: Arc<Mutex<TaggerState>>, dir: Option<PathBuf>) {
    std::thread::Builder::new()
        .name("ai-tagger".into())
        .spawn(move || {
            let Some(dir) = dir else {
                state.lock().status.error = Some("models 폴더(onnxruntime.dll + 모델) 없음 — scripts/fetch_models.py 실행".into());
                return;
            };
            state.lock().status.models = MODELS.iter().filter(|m| has_model(&dir, m)).map(|m| m.id.to_string()).collect();
            // ONNX Runtime is loaded at run time from models/onnxruntime.dll (no link-time dependency);
            // one environment per process, shared with the piano transcriber (ortenv.rs).
            let env = match super::ortenv::get(&dir) {
                Ok(env) => env,
                Err(e) => {
                    state.lock().status.error = Some(e);
                    return;
                }
            };
            let load_session = |path: &Path| -> Result<Session, String> {
                let builder = Session::builder(&env).map_err(|e| format!("세션 빌더 실패: {e}"))?;
                let mut builder = builder.with_intra_threads(2).map_err(|e| format!("세션 옵션 실패: {e}"))?;
                builder.commit_from_file(path).map_err(|e| format!("ONNX 로드 실패 ({}): {e}", path.display()))
            };
            let mut loaded: Option<(&'static ModelSpec, Session, Vec<String>)> = None;
            let mut last = Instant::now();
            let mut last_frames = 0u64;
            loop {
                std::thread::sleep(Duration::from_millis(40));
                // (re)load the selected model when the selection changes
                let want = spec(&state.lock().model);
                if loaded.as_ref().map(|l| l.0.id) != Some(want.id) {
                    loaded = None;
                    if !has_model(&dir, want) {
                        let mut s = state.lock();
                        s.status.available = false;
                        s.status.error = Some(format!("{} 모델 파일 없음 ({}) — 모델 선택을 바꾸거나 파일을 넣으세요", want.id, want.file));
                        drop(s);
                        std::thread::sleep(Duration::from_millis(500));
                        continue;
                    }
                    let labels = match load_labels(&dir.join(want.labels)) {
                        Ok(l) => l,
                        Err(e) => {
                            state.lock().status.error = Some(format!("클래스 표 읽기 실패: {e}"));
                            std::thread::sleep(Duration::from_millis(500));
                            continue;
                        }
                    };
                    match load_session(&dir.join(want.file)) {
                        Ok(sess) => {
                            log::info!("tagger: {} ready ({} classes)", want.id, labels.len());
                            let mut s = state.lock();
                            s.status.available = true;
                            s.status.error = None;
                            drop(s);
                            loaded = Some((want, sess, labels));
                        }
                        Err(e) => {
                            state.lock().status.error = Some(e);
                            std::thread::sleep(Duration::from_millis(500));
                            continue;
                        }
                    }
                }
                let Some((m, session, labels)) = loaded.as_mut() else { continue };
                let (enabled, interval, win, t_end, frames_in) = {
                    let s = state.lock();
                    (s.enabled, s.interval, if s.enabled { s.window(m.window) } else { None }, s.frames_in as f64 / s.sr_in.max(1) as f64, s.frames_in)
                };
                if !enabled || last.elapsed() < interval || frames_in == last_frames {
                    continue;
                }
                let Some(win) = win else { continue };
                last_frames = frames_in;
                last = Instant::now();
                // skip silence (< −60 dBFS RMS) — nothing to tag
                let rms = (win.iter().map(|v| v * v).sum::<f32>() / win.len() as f32).sqrt();
                if rms < 0.001 {
                    continue;
                }
                let t0 = Instant::now();
                let n = win.len();
                let input = if m.batched { Tensor::from_array(([1usize, n], win)) } else { Tensor::from_array(([n], win)) };
                let input = match input {
                    Ok(t) => t,
                    Err(e) => {
                        state.lock().status.error = Some(e.to_string());
                        continue;
                    }
                };
                let outputs = match session.run(ort::inputs![m.input => input]) {
                    Ok(o) => o,
                    Err(e) => {
                        state.lock().status.error = Some(format!("추론 실패: {e}"));
                        continue;
                    }
                };
                let scores: Vec<f32> = match outputs[m.output].try_extract_tensor::<f32>() {
                    Ok((shape, data)) => row_mean(shape, data, labels.len()),
                    Err(e) => {
                        state.lock().status.error = Some(format!("출력 해석 실패: {e}"));
                        continue;
                    }
                };
                let mut idx: Vec<usize> = (0..scores.len()).collect();
                idx.sort_by(|a, b| scores[*b].partial_cmp(&scores[*a]).unwrap_or(std::cmp::Ordering::Equal));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_switch_resamples_at_the_new_rate() {
        let mut t = TaggerState::new();
        t.enabled = true;
        let one_sec = vec![0.1f32; 48_000 * 2];
        t.feed(&one_sec, 48_000);
        assert!((t.buf.len() as i64 - 16_000).abs() <= 2, "yamnet buf {}", t.buf.len());
        t.set_model("efficientat");
        assert_eq!(t.buf.len(), 0);
        t.feed(&one_sec, 48_000);
        assert!((t.buf.len() as i64 - 32_000).abs() <= 2, "efficientat buf {}", t.buf.len());
        assert_eq!(spec("nope").id, "yamnet");
    }

    #[test]
    fn row_mean_handles_batched_and_patch_outputs() {
        assert_eq!(row_mean(&[1, 3], &[0.1, 0.2, 0.3], 3), vec![0.1, 0.2, 0.3]);
        let m = row_mean(&[2, 2], &[0.0, 1.0, 1.0, 0.0], 2);
        assert!((m[0] - 0.5).abs() < 1e-6 && (m[1] - 0.5).abs() < 1e-6);
    }
}
