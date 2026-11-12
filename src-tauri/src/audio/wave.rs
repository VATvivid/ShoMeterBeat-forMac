//! Rolling audio history for the Waveform module: the last `CAP_SECS` of the captured
//! stereo stream (for exporting a selection to WAV) plus a 100-column-per-second
//! min/max envelope (for drawing). Positions are absolute frame counts (`head`).

use hound::{SampleFormat, WavSpec, WavWriter};
use std::path::Path;

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
    cols_cap: usize,
    cur_min: f32,
    cur_max: f32,
    cur_sq: f32,
    cur_n: usize,
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
            cols_cap: CAP_SECS * COLS_PER_SEC,
            cur_min: 0.0,
            cur_max: 0.0,
            cur_sq: 0.0,
            cur_n: 0,
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
                if self.cols_min.len() > self.cols_cap {
                    let drop = self.cols_min.len() - self.cols_cap;
                    self.cols_min.drain(..drop);
                    self.cols_max.drain(..drop);
                    self.cols_rms.drain(..drop);
                }
                self.cur_n = 0;
            }
        }
    }

    /// Packed overview: [sr, n, head_hi, head_lo, min0, max0, rms0, min1, max1, rms1, …]
    /// for the last `seconds` (n ≤ seconds·100 columns, oldest first).
    pub fn overview(&self, seconds: f32) -> Vec<u8> {
        let want = ((seconds.max(0.1) * COLS_PER_SEC as f32) as usize).min(self.cols_min.len());
        let start = self.cols_min.len() - want;
        let mut v: Vec<f32> = Vec::with_capacity(4 + want * 3);
        v.push(self.sr as f32);
        v.push(want as f32);
        v.push((self.head / 65536) as f32);
        v.push((self.head % 65536) as f32);
        for i in start..self.cols_min.len() {
            v.push(self.cols_min[i]);
            v.push(self.cols_max[i]);
            v.push(self.cols_rms[i]);
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
        assert_eq!(v.len(), 4 + 100 * 3);
        assert!((v[6] - 0.5).abs() < 1e-5); // rms of ±0.5 square
        let dir = std::env::temp_dir().join("re-minimeter-test");
        let dst = dir.join("sel.wav");
        let n = h.export(1500, 1600, &dst).unwrap();
        assert_eq!(n, 100);
        let r = hound::WavReader::open(&dst).unwrap();
        assert_eq!(r.spec().sample_rate, 1000);
        assert_eq!(r.len(), 200);
        let _ = std::fs::remove_file(&dst);
    }
}
