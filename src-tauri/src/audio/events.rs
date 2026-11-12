//! Sound-event extraction for the Variation Map: when the history's spectral-flux
//! onset detector fires, a short clip (−20 ms … +320 ms around the onset) is cut
//! from the ring and summarised as a feature vector:
//!   [0..24)  mean log energy per Bark-like band (24 bands)
//!   [24..48) band slope: second-half minus first-half log energy
//!   48 centroid (log2 Hz)  49 bandwidth (oct)  50 roll-off 85 % (log2 Hz)  51 flatness
//!   52 attack ms (onset → envelope peak)  53 decay ms (peak → −20 dB)  54 length ms (> −40 dB)
//!   55 crest dB  56 peak dBFS  57 zero-crossing rate (per ms)
//! Everything is cheap (one 1024-point FFT every 256 samples of a 340 ms clip).

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;

pub const N_FEATURES: usize = 58;
pub const PRE_MS: f32 = 20.0;
pub const POST_MS: f32 = 320.0;
const WIN: usize = 1024;
const HOP: usize = 256;
const BARK: [f32; 25] = [20.0, 100.0, 200.0, 300.0, 400.0, 510.0, 630.0, 770.0, 920.0, 1080.0, 1270.0, 1480.0, 1720.0, 2000.0, 2320.0, 2700.0, 3150.0, 3700.0, 4400.0, 5300.0, 6400.0, 7700.0, 9500.0, 12000.0, 15500.0];

#[derive(Clone, Debug, serde::Serialize)]
pub struct Event {
    pub seq: u64,
    /// Seconds since capture start (absolute frame / sample rate).
    pub t: f64,
    pub peak_db: f32,
    pub features: Vec<f32>,
}

pub struct FeatureExtractor {
    sr: f32,
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    scratch: Vec<Complex<f32>>,
    band_bins: Vec<(usize, usize)>,
}

impl FeatureExtractor {
    pub fn new(sr: u32) -> Self {
        let srf = sr as f32;
        let bin_hz = srf / WIN as f32;
        let band_bins = (0..24)
            .map(|b| {
                let lo = ((BARK[b] / bin_hz) as usize).max(1);
                let hi = ((BARK[b + 1] / bin_hz) as usize).max(lo + 1).min(WIN / 2);
                (lo, hi)
            })
            .collect();
        Self {
            sr: srf,
            fft: FftPlanner::<f32>::new().plan_fft_forward(WIN),
            window: (0..WIN).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / WIN as f32).cos()).collect(),
            scratch: vec![Complex::new(0.0, 0.0); WIN],
            band_bins,
        }
    }

    /// `clip` is mono, starting PRE_MS before the onset.
    pub fn features(&mut self, clip: &[f32]) -> Vec<f32> {
        let mut f = vec![0.0f32; N_FEATURES];
        if clip.len() < WIN {
            return f;
        }
        let bin_hz = self.sr / WIN as f32;
        let n_frames = (clip.len() - WIN) / HOP + 1;
        let mut band_log = vec![[0.0f32; 24]; n_frames];
        let (mut cent, mut bw, mut roll, mut flat) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        let mut mags = vec![0.0f32; WIN / 2 + 1];
        for (fi, frame) in band_log.iter_mut().enumerate() {
            let s = &clip[fi * HOP..fi * HOP + WIN];
            for i in 0..WIN {
                self.scratch[i] = Complex::new(s[i] * self.window[i], 0.0);
            }
            self.fft.process(&mut self.scratch);
            let (mut sum, mut wsum, mut wsum2, mut lsum) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
            for k in 1..=WIN / 2 {
                let m = self.scratch[k].norm();
                mags[k] = m;
                let p = (m * m) as f64 + 1e-18;
                let hz = (k as f32 * bin_hz) as f64;
                sum += p;
                wsum += p * hz.log2();
                wsum2 += p * hz.log2() * hz.log2();
                lsum += p.ln();
            }
            let n = (WIN / 2) as f64;
            let c = wsum / sum;
            cent += c as f32;
            bw += (wsum2 / sum - c * c).max(0.0).sqrt() as f32;
            flat += ((lsum / n).exp() / (sum / n)) as f32;
            // roll-off 85 %
            let (mut acc, mut r) = (0.0f64, WIN / 2);
            for k in 1..=WIN / 2 {
                acc += (mags[k] * mags[k]) as f64;
                if acc >= 0.85 * sum {
                    r = k;
                    break;
                }
            }
            roll += ((r as f32 * bin_hz).max(20.0)).log2();
            for b in 0..24 {
                let (lo, hi) = self.band_bins[b];
                let e: f32 = mags[lo..hi].iter().map(|m| m * m).sum::<f32>() / (hi - lo) as f32;
                frame[b] = (e + 1e-10).log10() * 10.0;
            }
        }
        let nf = n_frames as f32;
        let half = n_frames / 2;
        for b in 0..24 {
            let mean = band_log.iter().map(|fr| fr[b]).sum::<f32>() / nf;
            let first = band_log[..half.max(1)].iter().map(|fr| fr[b]).sum::<f32>() / half.max(1) as f32;
            let second = band_log[half..].iter().map(|fr| fr[b]).sum::<f32>() / (n_frames - half).max(1) as f32;
            f[b] = mean;
            f[24 + b] = second - first;
        }
        f[48] = cent / nf;
        f[49] = bw / nf;
        f[50] = roll / nf;
        f[51] = flat / nf;
        // envelope (1 ms RMS) for attack / decay / length / crest / peak
        let ms = (self.sr / 1000.0) as usize;
        let env: Vec<f32> = clip.chunks(ms.max(1)).map(|c| (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32).sqrt()).collect();
        let (mut pk_i, mut pk) = (0usize, 0.0f32);
        for (i, &v) in env.iter().enumerate() {
            if v > pk {
                pk = v;
                pk_i = i;
            }
        }
        let onset_i = PRE_MS as usize;
        f[52] = pk_i.saturating_sub(onset_i) as f32;
        let thr20 = pk * 0.1;
        f[53] = env.iter().skip(pk_i).position(|&v| v < thr20).unwrap_or(env.len() - pk_i) as f32;
        let thr40 = pk * 0.01;
        f[54] = env.iter().filter(|&&v| v >= thr40).count() as f32;
        let sample_peak = clip.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        let rms = (clip.iter().map(|v| v * v).sum::<f32>() / clip.len() as f32).sqrt();
        f[55] = if rms > 1e-9 { 20.0 * (sample_peak / rms).log10() } else { 0.0 };
        f[56] = if sample_peak > 1e-9 { 20.0 * sample_peak.log10() } else { -120.0 };
        let zc = clip.windows(2).filter(|w| (w[0] >= 0.0) != (w[1] >= 0.0)).count() as f32;
        f[57] = zc / (clip.len() as f32 / self.sr * 1000.0);
        f
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bright_and_dark_clicks_differ() {
        let sr = 48_000u32;
        let mut fx = FeatureExtractor::new(sr);
        let n = ((PRE_MS + POST_MS) / 1000.0 * sr as f32) as usize;
        let mk = |hz: f32| -> Vec<f32> {
            (0..n)
                .map(|i| {
                    let t = i as f32 / sr as f32 - PRE_MS / 1000.0;
                    if t < 0.0 { 0.0 } else { (-t * 25.0).exp() * (2.0 * std::f32::consts::PI * hz * t).sin() }
                })
                .collect()
        };
        let a = fx.features(&mk(200.0));
        let b = fx.features(&mk(4000.0));
        assert_eq!(a.len(), N_FEATURES);
        assert!(b[48] > a[48] + 2.0, "centroid {} vs {}", a[48], b[48]); // > 2 octaves apart
        assert!(a[52] < 15.0 && b[52] < 15.0, "attack {} {}", a[52], b[52]);
        assert!(a[53] > 30.0, "decay {}", a[53]);
    }
}
