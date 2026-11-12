//! EBU R128 loudness (momentary / short-term / integrated / LRA / true peak)
//! through the `ebur128` crate.

use super::frame::{Frame, SILENCE_DB};
use ebur128::{EbuR128, Mode};

pub struct Loudness {
    sr: u32,
    e: EbuR128,
    max_m: f32,
    max_s: f32,
}

fn new_meter(sr: u32) -> EbuR128 {
    EbuR128::new(2, sr, Mode::M | Mode::S | Mode::I | Mode::LRA | Mode::TRUE_PEAK)
        .expect("ebur128 init")
}

fn db(v: Result<f64, ebur128::Error>) -> f32 {
    match v {
        Ok(x) if x.is_finite() => (x as f32).max(SILENCE_DB),
        _ => SILENCE_DB,
    }
}

fn lin_to_db(v: Result<f64, ebur128::Error>) -> f32 {
    match v {
        Ok(x) if x > 1e-6 => (20.0 * (x as f32).log10()).max(SILENCE_DB),
        _ => SILENCE_DB,
    }
}

impl Loudness {
    pub fn new(sr: u32) -> Self {
        Self { sr, e: new_meter(sr), max_m: SILENCE_DB, max_s: SILENCE_DB }
    }

    pub fn reset(&mut self) {
        self.e = new_meter(self.sr);
        self.max_m = SILENCE_DB;
        self.max_s = SILENCE_DB;
    }

    /// Interleaved stereo.
    pub fn feed(&mut self, stereo: &[f32]) {
        let even = stereo.len() - stereo.len() % 2;
        if even == 0 {
            return;
        }
        if let Err(e) = self.e.add_frames_f32(&stereo[..even]) {
            log::warn!("ebur128 add_frames: {e}");
        }
    }

    pub fn fill(&mut self, f: &mut Frame) {
        f.lufs_m = db(self.e.loudness_momentary());
        f.lufs_s = db(self.e.loudness_shortterm());
        f.lufs_i = db(self.e.loudness_global());
        f.lra = match self.e.loudness_range() {
            Ok(x) if x.is_finite() => x as f32,
            _ => 0.0,
        };
        f.true_peak = [lin_to_db(self.e.prev_true_peak(0)), lin_to_db(self.e.prev_true_peak(1))];
        f.max_tp = lin_to_db(self.e.true_peak(0)).max(lin_to_db(self.e.true_peak(1)));
        if f.lufs_m > self.max_m {
            self.max_m = f.lufs_m;
        }
        if f.lufs_s > self.max_s {
            self.max_s = f.lufs_s;
        }
        f.max_m = self.max_m;
        f.max_s = self.max_s;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minus_23_lufs_tone() {
        // EBU Tech 3341: a 1 kHz sine at -23 dBFS peak (both channels) reads -23 LUFS.
        let sr = 48_000u32;
        let amp = 10f32.powf(-23.0 / 20.0); // peak -23 dBFS
        let mut l = Loudness::new(sr);
        let secs = 5;
        let buf: Vec<f32> = (0..sr as usize * secs)
            .flat_map(|i| {
                let s = amp * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr as f32).sin();
                [s, s]
            })
            .collect();
        l.feed(&buf);
        let mut f = Frame::default();
        l.fill(&mut f);
        assert!((f.lufs_i + 23.0).abs() < 0.2, "integrated {}", f.lufs_i);
        assert!((f.lufs_s + 23.0).abs() < 0.2, "short {}", f.lufs_s);
        assert!((f.max_tp + 23.0).abs() < 0.3, "true peak {}", f.max_tp);
    }
}
