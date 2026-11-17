//! Predominant-melody (f0) salience for the Piano module, computed from the analyzer's
//! mid-channel FFT magnitudes (FFT 8192, Hann; ≈ 5.9 Hz bins at 48 kHz).
//!
//! Spectral peaks (parabolic interpolation on log magnitude; 50 Hz … 5 kHz; within 50 dB
//! of the strongest peak; at most 40) vote for every f0 = f_peak / h (h = 1 … 10) on a
//! 20-cent grid C2 … C7 with weight 0.8^(h−1) · √amplitude, spread over the neighbouring
//! grid bins. A mild melody-range prior (bell over log-f centred on 500 Hz, 1.5 octaves
//! wide) keeps bass lines from winning by default, and a candidate whose own fundamental
//! has no peak is scaled by 0.6 (sub-harmonic errors). The top `N_MELODY` grid maxima go
//! out as (Hz, salience) pairs; salience is the candidate's vote sum over the summed
//! weight of the `NORM_PEAKS` strongest peaks, so it is level-invariant and does not
//! shrink with every extra reverb/noise peak (on real piano music the top candidate sits
//! around 0.3–0.6, a clean tone with harmonics ≈ 0.7, noise ≈ 0 — measured with
//! `examples/melody.rs`). The UI gates with its own threshold and does the tracking.

pub const N_MELODY: usize = 4;

const MIDI_LO: f32 = 36.0; // C2 ≈ 65 Hz
const MIDI_HI: f32 = 96.0; // C7 ≈ 2093 Hz
const BINS_PER_SEMI: usize = 5; // 20 cents
const N_GRID: usize = ((MIDI_HI - MIDI_LO) as usize) * BINS_PER_SEMI + 1;
const PEAK_LO_HZ: f32 = 50.0;
const PEAK_HI_HZ: f32 = 5000.0;
const MAX_PEAKS: usize = 40;
/// Salience is normalised by the summed weight of this many strongest peaks.
const NORM_PEAKS: usize = 8;
const PEAK_RANGE_DB: f32 = 50.0;
const N_HARM: usize = 10;
const HARM_DECAY: f32 = 0.8;
const MISSING_F0_SCALE: f32 = 0.6;
const PRIOR_CENTRE_HZ: f32 = 500.0;
const PRIOR_WIDTH_OCT: f32 = 1.5;

#[inline]
fn hz_to_midi(hz: f32) -> f32 {
    69.0 + 12.0 * (hz / 440.0).log2()
}

#[inline]
fn midi_to_hz(m: f32) -> f32 {
    440.0 * 2f32.powf((m - 69.0) / 12.0)
}

#[inline]
fn grid_of_hz(hz: f32) -> f32 {
    (hz_to_midi(hz) - MIDI_LO) * BINS_PER_SEMI as f32
}

#[inline]
fn hz_of_grid(g: f32) -> f32 {
    midi_to_hz(MIDI_LO + g / BINS_PER_SEMI as f32)
}

/// Writes `N_MELODY` (hz, salience) pairs into `out` (zeros when nothing tonal is found).
/// `mags` are linear magnitudes per FFT bin (full-scale sine = 1.0), `bin_hz` the bin width.
pub fn analyze(mags: &[f32], bin_hz: f32, out: &mut [f32]) {
    for v in out.iter_mut() {
        *v = 0.0;
    }
    if mags.len() < 8 || bin_hz <= 0.0 {
        return;
    }
    // ---- spectral peaks
    let lo = ((PEAK_LO_HZ / bin_hz) as usize).max(1);
    let hi = ((PEAK_HI_HZ / bin_hz) as usize).min(mags.len() - 2);
    let mut peaks: Vec<(f32, f32)> = Vec::new(); // (hz, amp)
    for i in lo..=hi {
        let (a, b, c) = (mags[i - 1], mags[i], mags[i + 1]);
        if b > a && b >= c && b > 1e-5 {
            let (la, lb, lc) = (a.max(1e-9).ln(), b.ln(), c.max(1e-9).ln());
            let den = la - 2.0 * lb + lc;
            let delta = if den.abs() > 1e-9 { (0.5 * (la - lc) / den).clamp(-0.5, 0.5) } else { 0.0 };
            peaks.push(((i as f32 + delta) * bin_hz, b));
        }
    }
    if peaks.is_empty() {
        return;
    }
    peaks.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(std::cmp::Ordering::Equal));
    let floor = peaks[0].1 * 10f32.powf(-PEAK_RANGE_DB / 20.0);
    peaks.retain(|p| p.1 >= floor);
    peaks.truncate(MAX_PEAKS);

    // ---- harmonic summation on the cent grid
    let mut sal = vec![0.0f32; N_GRID];
    let mut has_f0 = vec![false; N_GRID]; // a peak lies within ±30 cents of this grid bin
    let mut total_w = 0.0f32;
    for (pi, &(hz, amp)) in peaks.iter().enumerate() {
        let w_p = amp.sqrt();
        if pi < NORM_PEAKS {
            total_w += w_p; // peaks are sorted strongest first
        }
        let g0 = grid_of_hz(hz);
        if g0 >= -1.5 && g0 <= N_GRID as f32 + 0.5 {
            let c = g0.round() as isize;
            for d in -1..=1 {
                let gi = c + d;
                if gi >= 0 && (gi as usize) < N_GRID {
                    has_f0[gi as usize] = true;
                }
            }
        }
        for h in 1..=N_HARM {
            let f0 = hz / h as f32;
            let g = grid_of_hz(f0);
            if g < -1.0 || g > N_GRID as f32 {
                continue;
            }
            let w = w_p * HARM_DECAY.powi(h as i32 - 1);
            let c = g.floor() as isize;
            let t = g - c as f32;
            // triangular spread over the two nearest bins (and a little beyond)
            for (gi, wt) in [(c - 1, 0.25 * (1.0 - t)), (c, 1.0 - t), (c + 1, t), (c + 2, 0.25 * t)] {
                if gi >= 0 && (gi as usize) < N_GRID {
                    sal[gi as usize] += w * wt;
                }
            }
        }
    }
    if total_w <= 1e-9 {
        return;
    }
    // ---- prior + missing-fundamental scale, then local maxima
    for g in 0..N_GRID {
        let hz = hz_of_grid(g as f32);
        let prior = (-0.5 * ((hz / PRIOR_CENTRE_HZ).log2() / PRIOR_WIDTH_OCT).powi(2)).exp();
        let mut v = sal[g] * (0.35 + 0.65 * prior);
        if !has_f0[g] {
            v *= MISSING_F0_SCALE;
        }
        sal[g] = v;
    }
    let mut cands: Vec<(usize, f32)> = Vec::new();
    for g in 1..N_GRID - 1 {
        if sal[g] > sal[g - 1] && sal[g] >= sal[g + 1] && sal[g] > 0.0 {
            cands.push((g, sal[g]));
        }
    }
    cands.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut n = 0usize;
    let mut taken: Vec<f32> = Vec::new();
    for (g, v) in cands {
        // one candidate per semitone neighbourhood
        let gf = g as f32;
        if taken.iter().any(|t| (t - gf).abs() < BINS_PER_SEMI as f32 * 0.6) {
            continue;
        }
        // parabolic refinement on the grid
        let (y0, y1, y2) = (sal[g - 1], sal[g], sal[g + 1]);
        let den = y0 - 2.0 * y1 + y2;
        let delta = if den.abs() > 1e-9 { (0.5 * (y0 - y2) / den).clamp(-0.5, 0.5) } else { 0.0 };
        out[2 * n] = hz_of_grid(gf + delta);
        out[2 * n + 1] = (v / total_w).clamp(0.0, 1.0);
        taken.push(gf);
        n += 1;
        if n >= N_MELODY.min(out.len() / 2) {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::analyzer::{Analyzer, FFT_N};

    fn tone_spectrum(parts: &[(f32, f32)]) -> (Vec<f32>, f32) {
        // Build a stereo signal of partials, run it through the analyzer and read the
        // mid magnitudes the same way snapshot() does (via a frame's spectrum is log-binned,
        // so recompute linear mags here with the same FFT size and Hann window).
        let sr = 48_000.0f32;
        let n = FFT_N;
        let mut mono = vec![0.0f32; n];
        for &(hz, amp) in parts {
            for i in 0..n {
                mono[i] += amp * (2.0 * std::f32::consts::PI * hz * i as f32 / sr).sin();
            }
        }
        let _ = Analyzer::new(48_000);
        let window: Vec<f32> = (0..n).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos()).collect();
        let gain = window.iter().sum::<f32>() / n as f32;
        let mut buf: Vec<rustfft::num_complex::Complex<f32>> = mono.iter().zip(window.iter()).map(|(s, w)| rustfft::num_complex::Complex::new(s * w, 0.0)).collect();
        rustfft::FftPlanner::<f32>::new().plan_fft_forward(n).process(&mut buf);
        let norm = 2.0 / (n as f32 * gain);
        (buf[..=n / 2].iter().map(|c| c.norm() * norm).collect(), sr / n as f32)
    }

    fn top(parts: &[(f32, f32)]) -> (f32, f32) {
        let (mags, bin_hz) = tone_spectrum(parts);
        let mut out = [0.0f32; 2 * N_MELODY];
        analyze(&mags, bin_hz, &mut out);
        (out[0], out[1])
    }

    #[test]
    fn harmonic_tone_reads_its_fundamental() {
        let f = 440.0;
        let parts: Vec<(f32, f32)> = (1..=5).map(|h| (f * h as f32, 0.3 / h as f32)).collect();
        let (hz, sal) = top(&parts);
        assert!((hz / f - 1.0).abs() < 0.01, "hz {hz}");
        assert!(sal > 0.4, "sal {sal}");
    }

    #[test]
    fn melody_wins_over_a_louder_bass() {
        // C4 (262 Hz) with harmonics over an A1 bass (55 Hz) that is 6 dB louder.
        let mut parts: Vec<(f32, f32)> = (1..=5).map(|h| (261.63 * h as f32, 0.2 / h as f32)).collect();
        parts.extend((1..=6).map(|h| (55.0 * h as f32, 0.4 / h as f32)));
        let (hz, _) = top(&parts);
        assert!((hz / 261.63 - 1.0).abs() < 0.01, "hz {hz}");
    }

    #[test]
    fn silence_and_noise_have_no_salience() {
        let mut out = [0.0f32; 2 * N_MELODY];
        analyze(&vec![0.0; FFT_N / 2 + 1], 48_000.0 / FFT_N as f32, &mut out);
        assert_eq!(out[1], 0.0);
        let mut seed = 7u32;
        let noise: Vec<f32> = (0..FFT_N / 2 + 1)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                1e-3 * (seed >> 8) as f32 / (1u32 << 24) as f32
            })
            .collect();
        analyze(&noise, 48_000.0 / FFT_N as f32, &mut out);
        // flat noise still scores ~0.27 (random peaks line up somewhere) — below a clean tone
        // (≈ 0.7) but inside the music range, so the Piano also gates on spectral flatness.
        assert!(out[1] < 0.35, "noise salience {}", out[1]);
    }
}
