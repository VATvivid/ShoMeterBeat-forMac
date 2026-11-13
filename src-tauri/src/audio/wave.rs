//! Rolling audio history for the Waveform module: the last `CAP_SECS` of the captured
//! stereo stream (for exporting a selection to WAV) plus a 100-column-per-second
//! min/max envelope (for drawing). Positions are absolute frame counts (`head`).

use super::events::{Event, FeatureExtractor, POST_MS, PRE_MS};
use hound::{SampleFormat, WavSpec, WavWriter};
use std::collections::VecDeque;
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::path::Path;
use std::sync::Arc;

const FLUX_N: usize = 2048;

pub const CAP_SECS: usize = 120;
pub const COLS_PER_SEC: usize = 100;

pub struct WaveHistory {
    sr: u32,
    ring: Vec<f32>, // interleaved stereo, cap_frames * 2
    cap_frames: usize,
    /// Total frames ever written (absolute position of the next frame).
    pub head: u64,
    col_frames: usize,
    cols_min: Vec<f32>,
    cols_max: Vec<f32>,
    cols_rms: Vec<f32>,
    cols_flux: Vec<f32>,
    cols_cap: usize,
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    scratch: Vec<Complex<f32>>,
    prev_log: Vec<f32>,
    cur_min: f32,
    cur_max: f32,
    cur_sq: f32,
    cur_n: usize,
    // ---- onset / event extraction (Variation Map)
    cols_total: u64,
    flux_win: VecDeque<f32>, // last 101 flux columns for the centred mean
    od_hist: VecDeque<f32>,  // onset function history (4 s) for the adaptive threshold
    last_onset_col: i64,
    pub onset_k: f32,
    fx: FeatureExtractor,
    events: VecDeque<Event>,
    event_seq: u64,
}

impl WaveHistory {
    pub fn new(sr: u32) -> Self {
        let cap_frames = CAP_SECS * sr as usize;
        Self {
            sr,
            ring: vec![0.0; cap_frames * 2],
            cap_frames,
            head: 0,
            col_frames: (sr as usize / COLS_PER_SEC).max(1),
            cols_min: Vec::new(),
            cols_max: Vec::new(),
            cols_rms: Vec::new(),
            cols_flux: Vec::new(),
            cols_cap: CAP_SECS * COLS_PER_SEC,
            fft: FftPlanner::<f32>::new().plan_fft_forward(FLUX_N),
            window: (0..FLUX_N).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FLUX_N as f32).cos()).collect(),
            scratch: vec![Complex::new(0.0, 0.0); FLUX_N],
            prev_log: vec![0.0; FLUX_N / 2 + 1],
            cur_min: 0.0,
            cur_max: 0.0,
            cur_sq: 0.0,
            cur_n: 0,
            cols_total: 0,
            flux_win: VecDeque::with_capacity(102),
            od_hist: VecDeque::with_capacity(401),
            last_onset_col: -1000,
            onset_k: 2.5,
            fx: FeatureExtractor::new(sr),
            events: VecDeque::with_capacity(512),
            event_seq: 0,
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sr
    }

    pub fn push(&mut self, stereo: &[f32]) {
        for fr in stereo.chunks_exact(2) {
            let idx = (self.head as usize % self.cap_frames) * 2;
            self.ring[idx] = fr[0];
            self.ring[idx + 1] = fr[1];
            self.head += 1;
            let m = 0.5 * (fr[0] + fr[1]);
            if self.cur_n == 0 {
                self.cur_min = m;
                self.cur_max = m;
                self.cur_sq = 0.0;
            } else {
                self.cur_min = self.cur_min.min(m);
                self.cur_max = self.cur_max.max(m);
            }
            self.cur_sq += m * m;
            self.cur_n += 1;
            if self.cur_n >= self.col_frames {
                self.cols_min.push(self.cur_min);
                self.cols_max.push(self.cur_max);
                self.cols_rms.push((self.cur_sq / self.cur_n as f32).sqrt());
                let flux = self.flux();
                self.cols_flux.push(flux);
                self.detect_onset(flux);
                if self.cols_min.len() > self.cols_cap {
                    let drop = self.cols_min.len() - self.cols_cap;
                    self.cols_min.drain(..drop);
                    self.cols_max.drain(..drop);
                    self.cols_rms.drain(..drop);
                    self.cols_flux.drain(..drop);
                }
                self.cur_n = 0;
            }
        }
    }

    /// Centred-mean onset function with a 0.5 s delay; an onset at column `o` is
    /// confirmed once column `o + 51` exists, so the clip (−20 … +320 ms) is already in
    /// the ring. Adaptive threshold: mean + onset_k·std over the last 4 s.
    fn detect_onset(&mut self, flux: f32) {
        self.cols_total += 1;
        self.flux_win.push_back(flux);
        if self.flux_win.len() > 101 {
            self.flux_win.pop_front();
        }
        if self.flux_win.len() < 101 {
            return;
        }
        let mean = self.flux_win.iter().sum::<f32>() / 101.0;
        let od = (self.flux_win[50] - mean).max(0.0); // column cols_total-1-50
        self.od_hist.push_back(od);
        if self.od_hist.len() > 400 {
            self.od_hist.pop_front();
        }
        let n = self.od_hist.len();
        if n < 60 {
            return;
        }
        // candidate = previous od (column cols_total-1-51): local max above threshold
        let (c0, c1, c2) = (self.od_hist[n - 3], self.od_hist[n - 2], self.od_hist[n - 1]);
        let m = self.od_hist.iter().sum::<f32>() / n as f32;
        let sd = (self.od_hist.iter().map(|v| (v - m) * (v - m)).sum::<f32>() / n as f32).sqrt().max(1e-6);
        let thr = m + self.onset_k * sd;
        let col = self.cols_total as i64 - 1 - 51;
        if c1 >= thr && c1 > c0 && c1 >= c2 && col - self.last_onset_col >= 10 {
            self.last_onset_col = col;
            self.extract_event(col as u64, c1);
        }
    }

    fn extract_event(&mut self, col: u64, _strength: f32) {
        let onset_frame = col * self.col_frames as u64;
        let pre = (PRE_MS / 1000.0 * self.sr as f32) as u64;
        let post = (POST_MS / 1000.0 * self.sr as f32) as u64;
        let start = onset_frame.saturating_sub(pre);
        let end = (onset_frame + post).min(self.head);
        if end <= start || start + (self.cap_frames as u64) < self.head {
            return;
        }
        let mono: Vec<f32> = (start..end)
            .map(|p| {
                let idx = (p as usize % self.cap_frames) * 2;
                0.5 * (self.ring[idx] + self.ring[idx + 1])
            })
            .collect();
        let features = self.fx.features(&mono);
        let peak_db = features[56];
        if peak_db < -60.0 {
            return;
        }
        self.event_seq += 1;
        self.events.push_back(Event { seq: self.event_seq, t: onset_frame as f64 / self.sr as f64, peak_db, features });
        if self.events.len() > 500 {
            self.events.pop_front();
        }
    }

    /// Events with seq > `after` (oldest first).
    pub fn events_since(&self, after: u64) -> Vec<Event> {
        self.events.iter().filter(|e| e.seq > after).cloned().collect()
    }

    /// Spectral flux of the newest FLUX_N mono samples vs the previous column: sum of
    /// positive log-magnitude increases (onset detection function for tempo/onsets).
    fn flux(&mut self) -> f32 {
        if self.head < FLUX_N as u64 {
            return 0.0;
        }
        let start = self.head as usize - FLUX_N;
        for i in 0..FLUX_N {
            let idx = ((start + i) % self.cap_frames) * 2;
            let m = 0.5 * (self.ring[idx] + self.ring[idx + 1]);
            self.scratch[i] = Complex::new(m * self.window[i], 0.0);
        }
        self.fft.process(&mut self.scratch);
        let mut flux = 0.0f32;
        for k in 0..=FLUX_N / 2 {
            let lg = (1.0 + 200.0 * self.scratch[k].norm()).ln();
            let d = lg - self.prev_log[k];
            if d > 0.0 {
                flux += d;
            }
            self.prev_log[k] = lg;
        }
        flux
    }

    /// Packed overview: [sr, n, head_hi, head_lo, min0, max0, rms0, flux0, min1, …]
    /// for the last `seconds` (n ≤ seconds·100 columns, oldest first).
    pub fn overview(&self, seconds: f32) -> Vec<u8> {
        let want = ((seconds.max(0.1) * COLS_PER_SEC as f32) as usize).min(self.cols_min.len());
        let start = self.cols_min.len() - want;
        let mut v: Vec<f32> = Vec::with_capacity(4 + want * 4);
        v.push(self.sr as f32);
        v.push(want as f32);
        v.push((self.head / 65536) as f32);
        v.push((self.head % 65536) as f32);
        for i in start..self.cols_min.len() {
            v.push(self.cols_min[i]);
            v.push(self.cols_max[i]);
            v.push(self.cols_rms[i]);
            v.push(self.cols_flux[i]);
        }
        let mut bytes = Vec::with_capacity(v.len() * 4);
        for x in v {
            bytes.extend_from_slice(&x.to_le_bytes());
        }
        bytes
    }

    /// Writes frames [start, end) (absolute positions) as a 32-bit float stereo WAV.
    pub fn export(&self, start: u64, end: u64, dst: &Path) -> Result<u64, String> {
        if end <= start {
            return Err("빈 구간입니다".into());
        }
        let oldest = self.head.saturating_sub(self.cap_frames as u64);
        if start < oldest {
            return Err("선택 구간이 이미 버퍼에서 밀려났습니다 (최근 2분만 보관)".into());
        }
        let end = end.min(self.head);
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let spec = WavSpec { channels: 2, sample_rate: self.sr, bits_per_sample: 32, sample_format: SampleFormat::Float };
        let mut w = WavWriter::create(dst, spec).map_err(|e| e.to_string())?;
        for pos in start..end {
            let idx = (pos as usize % self.cap_frames) * 2;
            w.write_sample(self.ring[idx]).map_err(|e| e.to_string())?;
            w.write_sample(self.ring[idx + 1]).map_err(|e| e.to_string())?;
        }
        w.finalize().map_err(|e| e.to_string())?;
        Ok(end - start)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_and_export_roundtrip() {
        let mut h = WaveHistory::new(1000); // tiny rate for the test: 10 frames per column
        let data: Vec<f32> = (0..2000).flat_map(|i| { let s = if i % 20 < 10 { 0.5 } else { -0.5 }; [s, s] }).collect();
        h.push(&data);
        assert_eq!(h.head, 2000);
        let ov = h.overview(1.0);
        let v: Vec<f32> = ov.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        assert_eq!(v[0], 1000.0);
        assert_eq!(v[1] as usize, 100);
        assert_eq!(v[2] * 65536.0 + v[3], 2000.0);
        assert_eq!(v.len(), 4 + 100 * 4);
        assert!((v[6] - 0.5).abs() < 1e-5); // rms of ±0.5 square
        let dir = std::env::temp_dir().join("ShowMeterBeat-test");
        let dst = dir.join("sel.wav");
        let n = h.export(1500, 1600, &dst).unwrap();
        assert_eq!(n, 100);
        let r = hound::WavReader::open(&dst).unwrap();
        assert_eq!(r.spec().sample_rate, 1000);
        assert_eq!(r.len(), 200);
        let _ = std::fs::remove_file(&dst);
    }
}
