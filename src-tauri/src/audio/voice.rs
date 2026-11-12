//! Voice analysis for the Vocal Tract / Vowel Map modules: LPC formant estimation
//! (F1–F3) and autocorrelation pitch + voicing on a mono down-sampled window.
//! All instantaneous; the UI smooths.

use super::frame::N_ENV;

/// Analysis rate after 4× decimation of 48 kHz (also fine for 44.1 kHz → 11.025 kHz).
const DECIM: usize = 4;
const LPC_ORDER: usize = 14;
const ENV_MAX_HZ: f32 = 5000.0;
const PRE_EMPHASIS: f32 = 0.97;

#[derive(Clone, Copy, Debug, Default)]
pub struct Voice {
    pub f0: f32,
    pub f1: f32,
    pub f2: f32,
    pub f3: f32,
    /// 0..1 — normalised autocorrelation peak gated by level.
    pub voiced: f32,
}

pub struct VoiceAnalyzer {
    fs: f32, // decimated rate
    win: Vec<f32>,
    pub envelope: Vec<f32>,
}

impl VoiceAnalyzer {
    pub fn new(sr: u32) -> Self {
        let fs = sr as f32 / DECIM as f32;
        let n = (fs * 0.040) as usize; // 40 ms
        let win = (0..n)
            .map(|i| 0.54 - 0.46 * (2.0 * std::f32::consts::PI * i as f32 / (n - 1) as f32).cos())
            .collect();
        Self { fs, win, envelope: vec![-120.0; N_ENV] }
    }

    /// Number of full-rate mono samples needed for one analysis.
    pub fn needed_samples(&self) -> usize {
        self.win.len() * DECIM
    }

    /// `mono` is full-rate, oldest first, at least `needed_samples()` long.
    pub fn analyze(&mut self, mono: &[f32]) -> Voice {
        let n = self.win.len();
        let src = &mono[mono.len() - n * DECIM..];
        // Decimate with a 4-tap box filter (crude anti-alias, fine for formant tracking).
        let mut x: Vec<f32> = (0..n)
            .map(|i| {
                let b = i * DECIM;
                (src[b] + src[b + 1] + src[b + 2] + src[b + 3]) * 0.25
            })
            .collect();
        let energy = x.iter().map(|v| v * v).sum::<f32>() / n as f32;
        let level_db = if energy > 1e-12 { 10.0 * energy.log10() } else { -120.0 };
        let mut out = Voice::default();
        if level_db < -65.0 {
            for v in self.envelope.iter_mut() {
                *v = -120.0;
            }
            return out;
        }

        // ---- pitch / voicing: normalised autocorrelation on the un-emphasised frame
        let lag_min = (self.fs / 1000.0) as usize;
        let lag_max = ((self.fs / 60.0) as usize).min(n / 2);
        let r0: f32 = x.iter().map(|v| v * v).sum::<f32>().max(1e-9);
        let (mut best_lag, mut best) = (0usize, 0.0f32);
        for lag in lag_min..=lag_max {
            let mut s = 0.0;
            for i in 0..n - lag {
                s += x[i] * x[i + lag];
            }
            let e2: f32 = x[lag..].iter().map(|v| v * v).sum::<f32>().max(1e-9);
            let r = s / (r0 * e2).sqrt();
            if r > best {
                best = r;
                best_lag = lag;
            }
        }
        if best_lag > 0 {
            out.f0 = self.fs / best_lag as f32;
        }
        out.voiced = ((best - 0.3) / 0.5).clamp(0.0, 1.0);

        // ---- LPC on pre-emphasised, windowed frame
        for i in (1..n).rev() {
            x[i] -= PRE_EMPHASIS * x[i - 1];
        }
        for i in 0..n {
            x[i] *= self.win[i];
        }
        let mut r = [0.0f32; LPC_ORDER + 1];
        for (k, rk) in r.iter_mut().enumerate() {
            let mut s = 0.0;
            for i in 0..n - k {
                s += x[i] * x[i + k];
            }
            *rk = s;
        }
        if r[0] <= 1e-9 {
            return out;
        }
        let a = levinson(&r);
        // Spectral envelope 0..ENV_MAX_HZ
        for (k, e) in self.envelope.iter_mut().enumerate() {
            let hz = ENV_MAX_HZ * k as f32 / (N_ENV - 1) as f32;
            let w = 2.0 * std::f32::consts::PI * hz / self.fs;
            let (mut re, mut im) = (1.0f32, 0.0f32);
            for (i, ai) in a.iter().enumerate().skip(1) {
                re += ai * (w * i as f32).cos();
                im -= ai * (w * i as f32).sin();
            }
            let mag = 1.0 / (re * re + im * im).sqrt().max(1e-6);
            *e = 20.0 * mag.log10();
        }
        // Peaks → formants
        let mut peaks: Vec<(f32, f32)> = Vec::new();
        for k in 1..N_ENV - 1 {
            if self.envelope[k] > self.envelope[k - 1] && self.envelope[k] >= self.envelope[k + 1] {
                let hz = ENV_MAX_HZ * k as f32 / (N_ENV - 1) as f32;
                peaks.push((hz, self.envelope[k]));
            }
        }
        let mut f = [0.0f32; 3];
        let mut last = 0.0f32;
        let mut idx = 0;
        for (hz, _) in peaks {
            let (lo, hi) = match idx {
                0 => (180.0, 1200.0),
                1 => (500.0, 3200.0),
                _ => (1400.0, 4500.0),
            };
            if hz < lo || hz > hi || hz < last + 150.0 {
                continue;
            }
            f[idx] = hz;
            last = hz;
            idx += 1;
            if idx == 3 {
                break;
            }
        }
        out.f1 = f[0];
        out.f2 = f[1];
        out.f3 = f[2];
        out
    }
}

/// Levinson–Durbin: autocorrelation r[0..=p] → predictor a[0..=p] with a[0] = 1.
fn levinson(r: &[f32; LPC_ORDER + 1]) -> [f32; LPC_ORDER + 1] {
    let p = LPC_ORDER;
    let mut a = [0.0f32; LPC_ORDER + 1];
    a[0] = 1.0;
    let mut err = r[0];
    for i in 1..=p {
        let mut acc = r[i];
        for j in 1..i {
            acc += a[j] * r[i - j];
        }
        let k = -acc / err.max(1e-12);
        let prev = a;
        for j in 1..i {
            a[j] = prev[j] + k * prev[i - j];
        }
        a[i] = k;
        err *= 1.0 - k * k;
        if err <= 1e-12 {
            break;
        }
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_resonances_and_pitch() {
        // 150 Hz pulse train through two damped resonators at 700 and 1200 Hz.
        let sr = 48_000u32;
        let mut v = VoiceAnalyzer::new(sr);
        let n = v.needed_samples() + 4800;
        let fs = sr as f32;
        let mut y = vec![0.0f32; n];
        let mut res = [(700.0f32, 0.0f32, 0.0f32), (1200.0f32, 0.0f32, 0.0f32)];
        let period = (fs / 150.0) as usize;
        for i in 0..n {
            let x = if i % period == 0 { 1.0 } else { 0.0 };
            let mut s = 0.0;
            for (f, y1, y2) in res.iter_mut() {
                let r = 0.985f32;
                let c = 2.0 * r * (2.0 * std::f32::consts::PI * *f / fs).cos();
                let out = x + c * *y1 - r * r * *y2;
                *y2 = *y1;
                *y1 = out;
                s += out;
            }
            y[i] = s * 0.05;
        }
        let out = v.analyze(&y);
        assert!((out.f1 - 700.0).abs() < 80.0, "f1 {}", out.f1);
        assert!((out.f2 - 1200.0).abs() < 100.0, "f2 {}", out.f2);
        assert!((out.f0 - 150.0).abs() < 8.0, "f0 {}", out.f0);
        assert!(out.voiced > 0.5, "voiced {}", out.voiced);
    }

    #[test]
    fn silence_is_unvoiced() {
        let mut v = VoiceAnalyzer::new(48_000);
        let out = v.analyze(&vec![0.0; v.needed_samples()]);
        assert_eq!(out.voiced, 0.0);
        assert_eq!(out.f1, 0.0);
    }
}
