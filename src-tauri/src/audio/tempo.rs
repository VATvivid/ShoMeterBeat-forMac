//! Offline tempo estimation (same method as the Transient module, run over a whole
//! file): 10 ms spectral flux → local-mean-subtracted onset function → autocorrelation
//! of 6 s segments accumulated with decay → harmonic summation → tempo prior →
//! parabolic lag refinement. Also reports how consistently the segments agree.

use rustfft::num_complex::Complex;
use rustfft::FftPlanner;

pub const RATE: usize = 100;
const FLUX_N: usize = 2048;
const SEG: usize = 6 * RATE;
const STEP: usize = 2 * RATE;
const DECAY: f32 = 0.85;
const ACF_LEN: usize = RATE * 60 / 40 * 4;

/// 100 Hz spectral-flux onset detection function of a mono signal.
pub fn flux_columns(mono: &[f32], sr: u32) -> Vec<f32> {
    let hop = (sr as usize / RATE).max(1);
    let fft = FftPlanner::<f32>::new().plan_fft_forward(FLUX_N);
    let window: Vec<f32> = (0..FLUX_N).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FLUX_N as f32).cos()).collect();
    let mut scratch = vec![Complex::new(0.0, 0.0); FLUX_N];
    let mut prev = vec![0.0f32; FLUX_N / 2 + 1];
    let mut out = Vec::with_capacity(mono.len() / hop + 1);
    let mut end = FLUX_N;
    while end <= mono.len() {
        for i in 0..FLUX_N {
            scratch[i] = Complex::new(mono[end - FLUX_N + i] * window[i], 0.0);
        }
        fft.process(&mut scratch);
        let mut flux = 0.0f32;
        for k in 0..=FLUX_N / 2 {
            let lg = (1.0 + 200.0 * scratch[k].norm() * (2.0 / FLUX_N as f32)).ln();
            let d = lg - prev[k];
            if d > 0.0 {
                flux += d;
            }
            prev[k] = lg;
        }
        out.push(flux);
        end += hop;
    }
    out
}

pub struct Tempo {
    pub bpm: f32,
    pub confidence: f32,
    /// Fraction of 2 s steps whose running estimate was within 3 % of the final BPM.
    pub agreement: f32,
}

pub fn estimate(flux: &[f32], prior_bpm: f32) -> Tempo {
    // onset function: flux minus its trailing 1 s mean, half-wave rectified
    let mut od = Vec::with_capacity(flux.len());
    let mut sum = 0.0f32;
    for (i, &f) in flux.iter().enumerate() {
        sum += f;
        if i >= RATE {
            sum -= flux[i - RATE];
        }
        let mean = sum / (i.min(RATE - 1) + 1) as f32;
        od.push((f - mean).max(0.0));
    }
    let mut acc = vec![0.0f32; ACF_LEN];
    let mut running: Vec<f32> = Vec::new();
    let lag_min = RATE * 60 / 200;
    let lag_max = RATE * 60 / 60;
    let harm = |a: &[f32], l: usize| -> f32 {
        let mut v = a[l - 1];
        for (k, w) in [(2usize, 0.5f32), (3, 0.33), (4, 0.25)] {
            if k * l - 1 < a.len() {
                v += w * a[k * l - 1];
            }
        }
        v
    };
    let prior = |l: usize| -> f32 { (-0.5 * ((60.0 * RATE as f32 / l as f32 / prior_bpm).log2() / 0.8).powi(2)).exp() + 0.25 };
    let pick = |a: &[f32]| -> (f32, f32) {
        let (mut best, mut best_l, mut sum, mut cnt) = (f32::NEG_INFINITY, 0usize, 0.0f32, 0usize);
        for l in lag_min..=lag_max {
            let s = harm(a, l) * prior(l);
            sum += s;
            cnt += 1;
            if s > best {
                best = s;
                best_l = l;
            }
        }
        if best_l == 0 || best <= 0.0 {
            return (0.0, 0.0);
        }
        let (y0, y1, y2) = (harm(a, best_l - 1), harm(a, best_l), harm(a, best_l + 1));
        let den = y0 - 2.0 * y1 + y2;
        let delta = if den.abs() > 1e-9 { (0.5 * (y0 - y2) / den).clamp(-0.5, 0.5) } else { 0.0 };
        let bpm = 60.0 * RATE as f32 / (best_l as f32 + delta);
        let conf = ((best - sum / cnt as f32) / best.max(1e-6)).clamp(0.0, 1.0);
        (bpm, conf)
    };
    let mut start = 0usize;
    while start + SEG <= od.len() {
        let seg = &od[start..start + SEG];
        let mean = seg.iter().sum::<f32>() / SEG as f32;
        let x: Vec<f32> = seg.iter().map(|v| v - mean).collect();
        let e0: f32 = x.iter().map(|v| v * v).sum();
        if e0 > 1e-9 {
            for lag in 1..=ACF_LEN {
                let mut s = 0.0f32;
                for i in 0..x.len().saturating_sub(lag) {
                    s += x[i] * x[i + lag];
                }
                acc[lag - 1] = acc[lag - 1] * DECAY + s / e0;
            }
            running.push(pick(&acc).0);
        }
        start += STEP;
    }
    let (bpm, confidence) = pick(&acc);
    let agreement = if running.is_empty() || bpm <= 0.0 {
        0.0
    } else {
        running.iter().filter(|b| (**b / bpm - 1.0).abs() < 0.03).count() as f32 / running.len() as f32
    };
    Tempo { bpm, confidence, agreement }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn click_track_at_120_bpm() {
        let sr = 48_000u32;
        let secs = 20;
        let mut x = vec![0.0f32; sr as usize * secs];
        let period = (sr as f32 * 0.5) as usize; // 120 BPM
        for i in (0..x.len()).step_by(period) {
            for k in 0..200 {
                if i + k < x.len() {
                    x[i + k] = 0.8 * (1.0 - k as f32 / 200.0) * if k % 2 == 0 { 1.0 } else { -1.0 };
                }
            }
        }
        let flux = flux_columns(&x, sr);
        let t = estimate(&flux, 110.0);
        assert!((t.bpm - 120.0).abs() < 2.0, "bpm {}", t.bpm);
        assert!(t.confidence > 0.3, "conf {}", t.confidence);
    }
}
