//! Spectrum (FFT, log-spaced), sample peak / RMS, correlation, scope and Lissajous
//! buffers. Everything here is instantaneous; ballistics (release, peak hold,
//! smoothing) live in the UI so they can be tuned without touching Rust.

use super::frame::{Frame, N_LISSA, N_SCOPE, N_SPEC, SILENCE_DB};
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;

pub const FFT_N: usize = 8192;
const F_LO: f32 = 20.0;
const F_HI: f32 = 20_000.0;
/// RMS / correlation window ≈ 50 ms at 48 kHz.
const RMS_N: usize = 2400;

pub struct Analyzer {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    window_gain: f32,
    hist: [Vec<f32>; 2], // ring buffers, length FFT_N
    pos: usize,
    /// FFT bin range [lo, hi) for each log-spaced output point.
    bands: Vec<(usize, usize)>,
    /// Fractional bin centre for interpolation where a band is narrower than one bin.
    centres: Vec<f32>,
    scratch: Vec<Complex<f32>>,
    mags: Vec<f32>,
    block_peak: [f32; 2],
    sr: f32,
    flatness: f32,
    centroid: f32,
}

impl Analyzer {
    pub fn new(sr: u32) -> Self {
        let sr = sr as f32;
        let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_N);
        let window: Vec<f32> = (0..FFT_N)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FFT_N as f32).cos())
            .collect();
        let window_gain = window.iter().sum::<f32>() / FFT_N as f32; // 0.5 for Hann
        let bin_hz = sr / FFT_N as f32;
        let mut bands = Vec::with_capacity(N_SPEC);
        let mut centres = Vec::with_capacity(N_SPEC);
        for i in 0..N_SPEC {
            let f = point_freq(i);
            let f_prev = if i == 0 { F_LO } else { point_freq(i - 1) };
            let f_next = if i + 1 == N_SPEC { F_HI } else { point_freq(i + 1) };
            let lo = ((f * f_prev).sqrt() / bin_hz).round() as usize;
            let hi = ((f * f_next).sqrt() / bin_hz).round() as usize;
            let hi = hi.min(FFT_N / 2);
            bands.push((lo, hi.max(lo)));
            centres.push(f / bin_hz);
        }
        Self {
            fft,
            window,
            window_gain,
            hist: [vec![0.0; FFT_N], vec![0.0; FFT_N]],
            pos: 0,
            bands,
            centres,
            scratch: vec![Complex::new(0.0, 0.0); FFT_N],
            mags: vec![0.0; FFT_N / 2 + 1],
            block_peak: [0.0; 2],
            sr,
            flatness: 0.0,
            centroid: 0.0,
        }
    }

    /// Push interleaved stereo samples.
    pub fn feed(&mut self, stereo: &[f32]) {
        let mut pk = [0.0f32; 2];
        for fr in stereo.chunks_exact(2) {
            self.hist[0][self.pos] = fr[0];
            self.hist[1][self.pos] = fr[1];
            self.pos = (self.pos + 1) % FFT_N;
            pk[0] = pk[0].max(fr[0].abs());
            pk[1] = pk[1].max(fr[1].abs());
        }
        // Peak since the last snapshot (so short transients are never missed).
        self.block_peak[0] = self.block_peak[0].max(pk[0]);
        self.block_peak[1] = self.block_peak[1].max(pk[1]);
    }

    /// Last `n` mono (L+R)/2 samples, oldest first.
    pub fn mono_tail(&self, n: usize) -> Vec<f32> {
        let n = n.min(FFT_N);
        let start = (self.pos + FFT_N - n) % FFT_N;
        (0..n)
            .map(|i| {
                let k = (start + i) % FFT_N;
                0.5 * (self.hist[0][k] + self.hist[1][k])
            })
            .collect()
    }

    /// Last `n` samples of channel `ch`, oldest first.
    fn tail(&self, ch: usize, n: usize) -> Vec<f32> {
        let n = n.min(FFT_N);
        let mut out = Vec::with_capacity(n);
        let start = (self.pos + FFT_N - n) % FFT_N;
        for i in 0..n {
            out.push(self.hist[ch][(start + i) % FFT_N]);
        }
        out
    }

    fn spectrum(&mut self, ch: usize, out: &mut Vec<f32>) {
        let start = self.pos; // oldest sample
        for i in 0..FFT_N {
            let s = self.hist[ch][(start + i) % FFT_N];
            self.scratch[i] = Complex::new(s * self.window[i], 0.0);
        }
        self.fft.process(&mut self.scratch);
        // Full-scale sine → 0 dB: |X| = N * gain * A / 2, so A = 2|X| / (N * gain).
        let norm = 2.0 / (FFT_N as f32 * self.window_gain);
        for i in 0..=FFT_N / 2 {
            self.mags[i] = self.scratch[i].norm() * norm;
        }
        if ch == 0 {
            // Noise-likeness and brightness over 100 Hz … 8 kHz (power domain).
            let bin_hz = self.sr / FFT_N as f32;
            let lo = (100.0 / bin_hz) as usize;
            let hi = ((8000.0 / bin_hz) as usize).min(FFT_N / 2);
            let (mut log_sum, mut sum, mut wsum, mut n) = (0.0f64, 0.0f64, 0.0f64, 0usize);
            for i in lo..hi {
                let p = (self.mags[i] as f64).powi(2) + 1e-18;
                log_sum += p.ln();
                sum += p;
                wsum += p * (i as f64 * bin_hz as f64);
                n += 1;
            }
            if n > 0 && sum > 1e-14 {
                let geo = (log_sum / n as f64).exp();
                let arith = sum / n as f64;
                self.flatness = (geo / arith).clamp(0.0, 1.0) as f32;
                self.centroid = (wsum / sum) as f32;
            } else {
                self.flatness = 0.0;
                self.centroid = 0.0;
            }
        }
        out.clear();
        for i in 0..N_SPEC {
            let (lo, hi) = self.bands[i];
            let amp = if hi > lo {
                self.mags[lo..hi].iter().cloned().fold(0.0f32, f32::max)
            } else {
                let c = self.centres[i];
                let b = c.floor() as usize;
                let t = c - b as f32;
                let m0 = self.mags[b.min(FFT_N / 2)];
                let m1 = self.mags[(b + 1).min(FFT_N / 2)];
                m0 + (m1 - m0) * t
            };
            out.push(to_db(amp));
        }
    }

    pub fn snapshot(&mut self) -> Frame {
        let mut f = Frame::default();
        self.spectrum(0, &mut f.spectrum_l);
        self.spectrum(1, &mut f.spectrum_r);

        let l = self.tail(0, RMS_N);
        let r = self.tail(1, RMS_N);
        let (mut sll, mut srr, mut slr) = (0.0f32, 0.0f32, 0.0f32);
        for i in 0..RMS_N {
            sll += l[i] * l[i];
            srr += r[i] * r[i];
            slr += l[i] * r[i];
        }
        f.rms = [to_db((sll / RMS_N as f32).sqrt()), to_db((srr / RMS_N as f32).sqrt())];
        let denom = (sll * srr).sqrt();
        f.correlation = if denom > 1e-9 { (slr / denom).clamp(-1.0, 1.0) } else { 0.0 };

        f.peak = [to_db(self.block_peak[0]), to_db(self.block_peak[1])];
        self.block_peak = [0.0; 2];
        f.flatness = self.flatness;
        f.centroid = self.centroid;

        f.scope_l = self.tail(0, N_SCOPE);
        f.scope_r = self.tail(1, N_SCOPE);
        let ll = self.tail(0, N_LISSA);
        let rr = self.tail(1, N_LISSA);
        f.lissa.clear();
        for i in 0..N_LISSA {
            f.lissa.push(ll[i]);
            f.lissa.push(rr[i]);
        }
        f
    }
}

/// Log-spaced centre frequency of output point `i` (20 Hz … 20 kHz).
pub fn point_freq(i: usize) -> f32 {
    F_LO * (F_HI / F_LO).powf(i as f32 / (N_SPEC - 1) as f32)
}

#[inline]
pub fn to_db(amp: f32) -> f32 {
    if amp <= 1e-6 {
        SILENCE_DB
    } else {
        (20.0 * amp.log10()).max(SILENCE_DB)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(sr: f32, hz: f32, amp: f32, n: usize) -> Vec<f32> {
        (0..n)
            .flat_map(|i| {
                let s = amp * (2.0 * std::f32::consts::PI * hz * i as f32 / sr).sin();
                [s, s]
            })
            .collect()
    }

    #[test]
    fn full_scale_sine_reads_zero_db_at_its_frequency() {
        // Bin-centred frequency (bin 171 @ 48 kHz / 8192) so Hann scalloping loss is zero.
        let hz = 171.0 * 48_000.0 / FFT_N as f32;
        let mut a = Analyzer::new(48_000);
        a.feed(&sine(48_000.0, hz, 1.0, FFT_N));
        let f = a.snapshot();
        let (idx, _) = (0..N_SPEC)
            .map(|i| (i, (point_freq(i) - hz).abs()))
            .min_by(|x, y| x.1.partial_cmp(&y.1).unwrap())
            .unwrap();
        let peak = f.spectrum_l[idx.saturating_sub(1)..=(idx + 1).min(N_SPEC - 1)]
            .iter()
            .cloned()
            .fold(SILENCE_DB, f32::max);
        assert!(peak.abs() < 0.5, "peak {peak} dB");
        assert!((f.rms[0] - (-3.01)).abs() < 0.2, "rms {}", f.rms[0]);
        assert!(f.peak[0].abs() < 0.05, "peak {}", f.peak[0]);
        assert!(f.correlation > 0.999);
    }

    #[test]
    fn silence_is_floor() {
        let mut a = Analyzer::new(48_000);
        a.feed(&vec![0.0; FFT_N * 2]);
        let f = a.snapshot();
        assert_eq!(f.peak[0], SILENCE_DB);
        assert_eq!(f.correlation, 0.0);
        assert!(f.spectrum_l.iter().all(|&d| d == SILENCE_DB));
    }
}
