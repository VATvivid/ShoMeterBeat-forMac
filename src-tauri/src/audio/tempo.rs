//! Offline tempo estimation (same method as the BPM Checker module, run over a whole
//! file): 10 ms spectral flux + column RMS → onset function (centred-mean subtracted,
//! half-wave rectified, accent-weighted by the column's level against the loudest column
//! within ±0.5 s) → autocorrelation of 6 s segments accumulated with decay (segments are
//! widened by a 5-tap kernel first so one-column click pulses interpolate between lags)
//! → harmonic summation on a ½-column lag grid → wide tempo prior (120 BPM, σ = 1 octave;
//! or the user's prior, σ = 0.8) → octave tie-break (a half lag that is nearly as strong
//! wins, so a 160 BPM click is not read as 80) → parabolic lag refinement. Also reports
//! how consistently the segments agree.
//!
//! The accent weight matters because the log-compressed flux is almost level-invariant:
//! a −14 dB hi-hat on every eighth looks as strong as the kick, which doubles the tempo
//! of slow songs. Weighting each column by its RMS relative to the loudest column nearby
//! puts the dynamics back without changing the onset positions.

use rustfft::num_complex::Complex;
use rustfft::FftPlanner;

pub const RATE: usize = 100;
const FLUX_N: usize = 2048;
const SEG: usize = 6 * RATE;
const STEP: usize = 2 * RATE;
const DECAY: f32 = 0.85;
const ACF_LEN: usize = RATE * 60 / 40 * 4;
const LAG_MIN: f32 = (RATE * 60 / 200) as f32;
const LAG_MAX: f32 = (RATE * 60 / 60) as f32;
/// A half lag whose harmonic sum reaches this fraction of the winner's takes over.
const OCTAVE_TIE: f32 = 0.9;
/// Exponent of the accent weight (column RMS / local max RMS).
const ACCENT_POW: f32 = 1.0;
/// Widening kernel applied to each ACF segment (centre = 1).
const WIDEN: [f32; 5] = [0.25, 0.5, 1.0, 0.5, 0.25];

/// 100 Hz onset-detection inputs of a mono signal: spectral flux and column RMS.
pub struct Onsets {
    pub flux: Vec<f32>,
    pub rms: Vec<f32>,
}

/// 100 Hz spectral-flux onset detection function + column RMS of a mono signal.
pub fn onset_columns(mono: &[f32], sr: u32) -> Onsets {
    let hop = (sr as usize / RATE).max(1);
    let fft = FftPlanner::<f32>::new().plan_fft_forward(FLUX_N);
    let window: Vec<f32> = (0..FLUX_N).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FLUX_N as f32).cos()).collect();
    let mut scratch = vec![Complex::new(0.0, 0.0); FLUX_N];
    let mut prev = vec![0.0f32; FLUX_N / 2 + 1];
    let mut flux_out = Vec::with_capacity(mono.len() / hop + 1);
    let mut rms_out = Vec::with_capacity(mono.len() / hop + 1);
    let mut end = FLUX_N;
    while end <= mono.len() {
        for i in 0..FLUX_N {
            scratch[i] = Complex::new(mono[end - FLUX_N + i] * window[i], 0.0);
        }
        fft.process(&mut scratch);
        let mut flux = 0.0f32;
        for k in 0..=FLUX_N / 2 {
            let lg = (1.0 + 200.0 * scratch[k].norm()).ln();
            let d = lg - prev[k];
            if d > 0.0 {
                flux += d;
            }
            prev[k] = lg;
        }
        flux_out.push(flux);
        let col = &mono[end - hop..end];
        rms_out.push((col.iter().map(|v| v * v).sum::<f32>() / hop as f32).sqrt());
        end += hop;
    }
    Onsets { flux: flux_out, rms: rms_out }
}

/// Flux only (for callers that do not need the accent weight).
pub fn flux_columns(mono: &[f32], sr: u32) -> Vec<f32> {
    onset_columns(mono, sr).flux
}

/// Onset function: flux minus its centred 1 s mean (±0.5 s), half-wave rectified, times the
/// accent weight (column RMS over the max RMS within ±0.5 s)^ACCENT_POW. `rms` may be
/// shorter than `flux` (or empty) — columns without an RMS get weight 1.
/// (A trailing mean leaves slow swells in and biases the tempogram toward short lags.)
pub fn onset_function(flux: &[f32], rms: &[f32]) -> Vec<f32> {
    let n = flux.len();
    let mut prefix = vec![0.0f32; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + flux[i];
    }
    let half = RATE / 2;
    let mut od = Vec::with_capacity(n);
    for i in 0..n {
        let lo = i.saturating_sub(half);
        let hi = (i + half + 1).min(n);
        let mean = (prefix[hi] - prefix[lo]) / (hi - lo) as f32;
        let mut v = (flux[i] - mean).max(0.0);
        if i < rms.len() {
            let mx = rms[lo..hi.min(rms.len())].iter().cloned().fold(0.0f32, f32::max);
            // the column's own level = max RMS of i−1…i+1 (a click that starts late in its
            // column has a partial RMS there but its flux peaks there)
            let own = rms[i.saturating_sub(1)..(i + 2).min(rms.len())].iter().cloned().fold(0.0f32, f32::max);
            v *= if mx > 1e-9 { (own / mx).min(1.0).powf(ACCENT_POW) } else { 0.0 };
        }
        od.push(v);
    }
    od
}

/// Linear interpolation of the accumulated ACF at a fractional lag (1-based lags).
fn acf_at(acc: &[f32], lag: f32) -> f32 {
    if lag < 1.0 || lag > acc.len() as f32 {
        return 0.0;
    }
    let i = lag.floor() as usize;
    let t = lag - i as f32;
    let a0 = acc[i - 1];
    let a1 = if i < acc.len() { acc[i] } else { a0 };
    a0 + (a1 - a0) * t
}

/// Harmonic summation: ACF at lag, 2·lag, 3·lag, 4·lag with decreasing weights.
fn harm(acc: &[f32], lag: f32) -> f32 {
    let mut v = acf_at(acc, lag);
    for (k, w) in [(2.0f32, 0.5f32), (3.0, 0.33), (4.0, 0.25)] {
        if k * lag <= acc.len() as f32 {
            v += w * acf_at(acc, k * lag);
        }
    }
    v
}

/// Tempo prior over lag: a bell in log-tempo plus a floor so nothing is excluded.
/// Without a user prior it is centred on 120 BPM and one octave wide — wide enough that
/// clicks from 60 to 200 BPM are read as they are (the octave tie-break does the rest).
fn prior(lag: f32, prior_bpm: Option<f32>) -> f32 {
    let (centre, width) = match prior_bpm {
        Some(b) if b > 0.0 => (b, 0.8),
        _ => (120.0, 1.0),
    };
    (-0.5 * ((60.0 * RATE as f32 / lag / centre).log2() / width).powi(2)).exp() + 0.25
}

/// Best (bpm, confidence) of an accumulated ACF.
pub fn pick(acc: &[f32], prior_bpm: Option<f32>) -> (f32, f32) {
    let n_grid = ((LAG_MAX - LAG_MIN) * 2.0) as usize + 1;
    let lag_of = |i: usize| LAG_MIN + i as f32 * 0.5;
    let scores: Vec<f32> = (0..n_grid).map(|i| harm(acc, lag_of(i)) * prior(lag_of(i), prior_bpm)).collect();
    let (mut best, mut best_i) = (f32::NEG_INFINITY, 0usize);
    for (i, &s) in scores.iter().enumerate() {
        if s > best {
            best = s;
            best_i = i;
        }
    }
    if best <= 0.0 {
        return (0.0, 0.0);
    }
    let mut best_l = lag_of(best_i);
    // octave tie-break: if the half lag (double tempo) is nearly as strong, it wins —
    // a plain click track is a tie by construction and should read at its click rate.
    loop {
        let h = best_l / 2.0;
        if h < LAG_MIN {
            break;
        }
        let mut hb = h;
        let mut hv = f32::NEG_INFINITY;
        let mut l = h - 1.0;
        while l <= h + 1.0 + 1e-6 {
            let v = harm(acc, l);
            if v > hv {
                hv = v;
                hb = l;
            }
            l += 0.25;
        }
        if hb >= LAG_MIN && hv >= OCTAVE_TIE * harm(acc, best_l) {
            best_l = hb;
        } else {
            break;
        }
    }
    let (y0, y1, y2) = (harm(acc, best_l - 0.5), harm(acc, best_l), harm(acc, best_l + 0.5));
    let den = y0 - 2.0 * y1 + y2;
    let delta = if den.abs() > 1e-9 { (0.25 * (y0 - y2) / den).clamp(-0.25, 0.25) } else { 0.0 };
    let bpm = 60.0 * RATE as f32 / (best_l + delta);
    // confidence = how much the winner stands above the strongest competing peak: local
    // maxima more than 8 % away in lag, excluding metrically related lags (½, 2, ⅓, 3, ⅔,
    // 3/2, ¼, 4 — the octave question is settled by the tie-break above, and on a plain
    // click those peaks are as tall as the winner, which pinned the old figure to ~45 %)
    let mut second = 0.0f32;
    for i in 1..scores.len().saturating_sub(1) {
        let l = lag_of(i);
        let r = l / best_l;
        let metrical = [2.0f32, 0.5, 3.0, 1.0 / 3.0, 1.5, 2.0 / 3.0, 4.0, 0.25].iter().any(|m| (r / m - 1.0).abs() < 0.06);
        if scores[i] > scores[i - 1] && scores[i] >= scores[i + 1] && (r - 1.0).abs() > 0.08 && !metrical {
            second = second.max(scores[i]);
        }
    }
    let conf = (1.0 - second.max(0.0) / best).clamp(0.0, 1.0);
    (bpm, conf)
}

/// Adds one onset-function segment to the accumulated ACF (widened, mean-removed,
/// energy-normalised). Returns false when the segment is silent.
pub fn accumulate(acc: &mut [f32], seg: &[f32]) -> bool {
    let n = seg.len();
    let mut x = vec![0.0f32; n];
    for i in 0..n {
        let mut s = 0.0;
        for (k, w) in WIDEN.iter().enumerate() {
            let j = i as isize + k as isize - 2;
            if j >= 0 && (j as usize) < n {
                s += w * seg[j as usize];
            }
        }
        x[i] = s;
    }
    let mean = x.iter().sum::<f32>() / n.max(1) as f32;
    for v in x.iter_mut() {
        *v -= mean;
    }
    let e0: f32 = x.iter().map(|v| v * v).sum();
    if e0 <= 1e-9 {
        return false;
    }
    for lag in 1..=acc.len() {
        let mut s = 0.0f32;
        for i in 0..n.saturating_sub(lag) {
            s += x[i] * x[i + lag];
        }
        acc[lag - 1] = acc[lag - 1] * DECAY + s / e0;
    }
    true
}

pub struct Tempo {
    pub bpm: f32,
    pub confidence: f32,
    /// Fraction of 2 s steps whose running estimate was within 3 % of the final BPM.
    pub agreement: f32,
    /// Running estimate after each 2 s step (diagnostics).
    pub trace: Vec<f32>,
}

/// Tempo of a whole onset-input sequence. `prior_bpm = None` is the automatic mode.
pub fn estimate(on: &Onsets, prior_bpm: Option<f32>) -> Tempo {
    let od = onset_function(&on.flux, &on.rms);
    let mut acc = vec![0.0f32; ACF_LEN];
    let mut running: Vec<f32> = Vec::new();
    let mut start = 0usize;
    while start + SEG <= od.len() {
        if accumulate(&mut acc, &od[start..start + SEG]) {
            running.push(pick(&acc, prior_bpm).0);
        }
        start += STEP;
    }
    let (bpm, confidence) = pick(&acc, prior_bpm);
    let agreement = if running.is_empty() || bpm <= 0.0 {
        0.0
    } else {
        running.iter().filter(|b| (**b / bpm - 1.0).abs() < 0.03).count() as f32 / running.len() as f32
    };
    Tempo { bpm, confidence, agreement, trace: running }
}

/// One stretch of a file with a steady tempo (see [`segments`]).
#[derive(Clone, Debug, serde::Serialize)]
pub struct TempoSeg {
    pub t0: f32,
    pub t1: f32,
    pub bpm: f32,
    pub confidence: f32,
}

const WIN_S: usize = 8;
const HOP_S: usize = 2;

/// Tempo over time: the estimator is run on 8 s windows every 2 s, and consecutive windows
/// whose BPM stays within 4 % are merged into one segment. A new segment needs two windows
/// in a row that agree with each other (one odd window is a blip, not a change). Windows
/// with confidence < 0.2 or no tempo are skipped. Returns at most one segment for a file
/// with a steady tempo.
pub fn segments(on: &Onsets, prior_bpm: Option<f32>) -> Vec<TempoSeg> {
    let win = WIN_S * RATE;
    let hop = HOP_S * RATE;
    let mut local: Vec<(f32, f32, f32)> = Vec::new(); // (t_centre, bpm, conf)
    let mut start = 0usize;
    while start + win <= on.flux.len() {
        let r0 = start.min(on.rms.len());
        let r1 = (start + win).min(on.rms.len());
        let part = Onsets { flux: on.flux[start..start + win].to_vec(), rms: on.rms[r0..r1].to_vec() };
        let t = estimate(&part, prior_bpm);
        if t.bpm > 0.0 && t.confidence >= 0.2 {
            local.push(((start + win / 2) as f32 / RATE as f32, t.bpm, t.confidence));
        }
        start += hop;
    }
    let mut out: Vec<TempoSeg> = Vec::new();
    let close = |a: f32, b: f32| (a / b - 1.0).abs() <= 0.04;
    let mut i = 0usize;
    while i < local.len() {
        let (t, bpm, conf) = local[i];
        match out.last_mut() {
            Some(seg) if close(bpm, seg.bpm) => {
                // running mean keeps the segment's BPM honest
                let n = ((seg.t1 - seg.t0) / HOP_S as f32).max(1.0);
                seg.bpm = (seg.bpm * n + bpm) / (n + 1.0);
                seg.confidence = seg.confidence.max(conf);
                seg.t1 = t + (WIN_S as f32) / 2.0;
                i += 1;
            }
            Some(_) if i + 1 < local.len() && !close(local[i + 1].1, bpm) => {
                i += 1; // a lone odd window: ignore it
            }
            _ => {
                out.push(TempoSeg { t0: if out.is_empty() { 0.0 } else { t - (WIN_S as f32) / 2.0 }, t1: t + (WIN_S as f32) / 2.0, bpm, confidence: conf });
                i += 1;
            }
        }
    }
    if let Some(last) = out.last_mut() {
        last.t1 = on.flux.len() as f32 / RATE as f32;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clicks(sr: u32, bpm: f32, secs: usize, accent: bool) -> Vec<f32> {
        let mut x = vec![0.0f32; sr as usize * secs];
        let period = sr as f32 * 60.0 / bpm;
        let n = (0.02 * sr as f32) as usize;
        let mut t = 0.0f32;
        let mut k = 0usize;
        while (t as usize) + n < x.len() {
            let i = t as usize;
            let (amp, hz) = if accent && k % 4 == 0 { (1.0, 2000.0) } else { (0.6, 1500.0) };
            for j in 0..n {
                x[i + j] += amp * (2.0 * std::f32::consts::PI * hz * j as f32 / sr as f32).sin() * (-(j as f32) / (0.004 * sr as f32)).exp();
            }
            t += period;
            k += 1;
        }
        x
    }

    #[test]
    fn tempo_change_makes_two_segments() {
        let sr = 48_000u32;
        let mut x = clicks(sr, 100.0, 24, false);
        x.extend(clicks(sr, 150.0, 24, false));
        let on = onset_columns(&x, sr);
        let segs = segments(&on, None);
        assert!(segs.len() >= 2, "segments {:?}", segs);
        assert!((segs[0].bpm - 100.0).abs() < 3.0, "first {:?}", segs[0]);
        assert!((segs.last().unwrap().bpm - 150.0).abs() < 4.0, "last {:?}", segs.last());
        assert!((segs[1].t0 - 24.0).abs() < 6.0, "change at {}", segs[1].t0);
    }

    #[test]
    fn click_track_at_120_bpm() {
        let sr = 48_000u32;
        let x = clicks(sr, 120.0, 20, false);
        let t = estimate(&onset_columns(&x, sr), None);
        assert!((t.bpm - 120.0).abs() < 2.0, "bpm {}", t.bpm);
        assert!(t.confidence > 0.3, "conf {}", t.confidence);
    }

    /// Metronomes from 60 to 200 BPM read at their click rate in automatic mode — no
    /// octave halving above 150 (the old prior-only pick read 160 as 80), with and
    /// without an accent on beat 1.
    #[test]
    fn click_tracks_read_at_their_click_rate() {
        let sr = 48_000u32;
        for bpm in [60.0f32, 90.0, 130.0, 160.0, 180.0, 200.0] {
            for accent in [false, true] {
                let x = clicks(sr, bpm, 30, accent);
                let t = estimate(&onset_columns(&x, sr), None);
                assert!((t.bpm / bpm - 1.0).abs() < 0.02, "{bpm} BPM accent={accent} read as {}", t.bpm);
            }
        }
    }

    /// Quiet eighth-note hi-hats (−14 dB) under a kick/snare pattern at 90 BPM: the accent
    /// weight keeps the tempo at 90 instead of doubling to 180.
    #[test]
    fn quiet_hats_do_not_double_the_tempo() {
        let sr = 48_000u32;
        let bpm = 90.0f32;
        let secs = 30;
        let mut x = vec![0.0f32; sr as usize * secs];
        let period = sr as f32 * 60.0 / bpm;
        let mut seed = 12345u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
        };
        let kick_n = (0.15 * sr as f32) as usize;
        let hit_n = (0.03 * sr as f32) as usize;
        let mut t = 0.0f32;
        let mut k = 0usize;
        while (t as usize) + kick_n + (period as usize) < x.len() {
            let i = t as usize;
            if k % 2 == 0 {
                for j in 0..kick_n {
                    x[i + j] += 0.9 * (2.0 * std::f32::consts::PI * 60.0 * j as f32 / sr as f32).sin() * (-(j as f32) / (0.08 * sr as f32)).exp();
                }
            } else {
                for j in 0..hit_n {
                    x[i + j] += 0.8 * rnd() * (-(j as f32) / (0.03 * sr as f32)).exp();
                }
            }
            for s in 0..2 {
                let h = i + (s as f32 * period / 2.0) as usize;
                for j in 0..hit_n {
                    x[h + j] += 0.2 * rnd() * (-(j as f32) / (0.01 * sr as f32)).exp();
                }
            }
            t += period;
            k += 1;
        }
        let t = estimate(&onset_columns(&x, sr), None);
        assert!((t.bpm / bpm - 1.0).abs() < 0.03, "read as {}", t.bpm);
    }
}
