//! Voice analysis for the Vocal Tract / Vowel Map modules: LPC formant estimation
//! (F1–F3) and autocorrelation pitch + voicing on a mono down-sampled window.
//! All instantaneous; the UI smooths.

use super::frame::N_ENV;

/// Analysis rate after 4× decimation of 48 kHz (also fine for 44.1 kHz → 11.025 kHz).
const DECIM: usize = 4;
const LPC_MAX: usize = 14;
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
    /// Last accepted f0 (continuity) and a pending big jump awaiting confirmation.
    prev_f0: f32,
    pending: Option<(f32, u8)>,
    ac: Vec<f32>,
}

impl VoiceAnalyzer {
    pub fn new(sr: u32) -> Self {
        let fs = sr as f32 / DECIM as f32;
        let n = (fs * 0.040) as usize; // 40 ms
        let win = (0..n)
            .map(|i| 0.54 - 0.46 * (2.0 * std::f32::consts::PI * i as f32 / (n - 1) as f32).cos())
            .collect();
        Self { fs, win, envelope: vec![-120.0; N_ENV], prev_f0: 0.0, pending: None, ac: Vec::new() }
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
            self.prev_f0 = 0.0;
            self.pending = None;
            return out;
        }

        // ---- pitch / voicing: normalised autocorrelation (both segments normalised),
        // main lobe skipped, local maxima only, octave-down avoided, continuity +
        // confirmation for big jumps, parabolic interpolation.
        {
            let mean = x.iter().sum::<f32>() / n as f32;
            let d: Vec<f32> = x.iter().map(|v| v - mean).collect();
            let lag_min = (self.fs / 1000.0) as usize;
            let lag_max = ((self.fs / 60.0) as usize).min(n / 2);
            // prefix sums of squares for the two-sided normalisation
            let mut cum = vec![0.0f32; n + 1];
            for i in 0..n {
                cum[i + 1] = cum[i] + d[i] * d[i];
            }
            self.ac.clear();
            self.ac.resize(lag_max + 2, 0.0);
            for lag in 1..lag_max + 2 {
                let mut s = 0.0f32;
                for i in 0..n - lag {
                    s += d[i] * d[i + lag];
                }
                let e1 = (cum[n - lag]).max(1e-9);
                let e2 = (cum[n] - cum[lag]).max(1e-9);
                self.ac[lag] = s / (e1 * e2).sqrt();
            }
            let ac = &self.ac;
            // skip the main lobe: first dip below zero or first local minimum past lag_min
            let mut start = lag_min;
            for lag in 1..lag_max {
                if ac[lag] < 0.0 || (lag >= lag_min && ac[lag] < ac[lag - 1] && ac[lag] <= ac[lag + 1]) {
                    start = lag.max(lag_min);
                    break;
                }
            }
            let cands: Vec<(f32, usize)> = (start.max(lag_min + 1)..lag_max)
                .filter(|&l| ac[l] > ac[l - 1] && ac[l] >= ac[l + 1] && ac[l] > 0.3)
                .map(|l| (ac[l], l))
                .collect();
            if cands.is_empty() {
                self.pending = None;
            } else {
                let best = cands.iter().map(|c| c.0).fold(0.0f32, f32::max);
                // shortest lag nearly as strong as the best → no octave-down error
                let mut pick = cands.iter().filter(|c| c.0 >= 0.85 * best).map(|c| c.1).min().unwrap();
                let prev = self.prev_f0;
                if prev > 0.0 {
                    if let Some(c) = cands
                        .iter()
                        .filter(|c| ((self.fs / c.1 as f32) / prev - 1.0).abs() < 0.25 && c.0 >= 0.75 * best)
                        .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap())
                    {
                        pick = c.1;
                    }
                }
                let interp = |l: usize| -> f32 {
                    let (a, b, c) = (ac[l - 1], ac[l], ac[l + 1]);
                    let den = a - 2.0 * b + c;
                    let delta = if den.abs() > 1e-9 { 0.5 * (a - c) / den } else { 0.0 };
                    self.fs / (l as f32 + delta)
                };
                let mut f0 = interp(pick);
                let mut v = ac[pick];
                let mut voiced = ((v - 0.3) / 0.5).clamp(0.0, 1.0);
                if f0 > 500.0 && v < 0.7 {
                    voiced *= 0.5;
                }
                // big jump: accept only when a second frame agrees; meanwhile stay near prev
                if prev > 0.0 && (f0 / prev > 1.8 || f0 / prev < 0.55) {
                    let confirmed = matches!(self.pending, Some((pf, _)) if (f0 / pf - 1.0).abs() < 0.2);
                    if !confirmed {
                        self.pending = Some((f0, 1));
                        if let Some(c) = cands
                            .iter()
                            .filter(|c| ((self.fs / c.1 as f32) / prev - 1.0).abs() < 0.35 && c.0 >= 0.6 * best)
                            .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap())
                        {
                            f0 = interp(c.1);
                            v = c.0;
                            voiced = ((v - 0.3) / 0.5).clamp(0.0, 1.0);
                        } else {
                            voiced = 0.0;
                        }
                    } else {
                        self.pending = None;
                    }
                } else {
                    self.pending = None;
                }
                let _ = v;
                out.f0 = f0;
                out.voiced = voiced;
                if voiced > 0.35 {
                    self.prev_f0 = f0;
                }
            }
        }

        // ---- LPC on pre-emphasised, windowed frame
        for i in (1..n).rev() {
            x[i] -= PRE_EMPHASIS * x[i - 1];
        }
        for i in 0..n {
            x[i] *= self.win[i];
        }
        // Higher-pitched voices have widely spaced harmonics that a high-order LPC
        // locks onto; lower the order with pitch (standard practice for female/child voices).
        let order = if out.f0 > 260.0 { 10 } else if out.f0 > 180.0 { 12 } else { LPC_MAX };
        let mut r = [0.0f32; LPC_MAX + 1];
        for (k, rk) in r.iter_mut().enumerate().take(order + 1) {
            let mut s = 0.0;
            for i in 0..n - k {
                s += x[i] * x[i + k];
            }
            *rk = s;
        }
        if r[0] <= 1e-9 {
            return out;
        }
        let a = levinson(&r, order);
        // Spectral envelope 0..ENV_MAX_HZ
        for (k, e) in self.envelope.iter_mut().enumerate() {
            let hz = ENV_MAX_HZ * k as f32 / (N_ENV - 1) as f32;
            let w = 2.0 * std::f32::consts::PI * hz / self.fs;
            let (mut re, mut im) = (1.0f32, 0.0f32);
            for (i, ai) in a.iter().enumerate().take(order + 1).skip(1) {
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
        // F1 can't sit on the first harmonics: keep it above ~1.2·f0 (and 210 Hz).
        let f1_lo = if out.f0 > 0.0 { (1.2 * out.f0).max(210.0) } else { 210.0 };
        for (hz, _) in peaks {
            let (lo, hi) = match idx {
                0 => (f1_lo, 1400.0),
                1 => (500.0, 3700.0),
                _ => (1400.0, 4900.0),
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
fn levinson(r: &[f32; LPC_MAX + 1], p: usize) -> [f32; LPC_MAX + 1] {
    let mut a = [0.0f32; LPC_MAX + 1];
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
