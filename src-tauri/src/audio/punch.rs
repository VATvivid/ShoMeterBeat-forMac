//! Perceptual punch meter after Fenton & Lee (AES 138 "Hybrid Multiresolution Analysis of
//! Punch", AES 139 "Towards a Perceptual Model of Punch", JAES 2019 "weighted transient
//! loudness"; the authors' free "Perceptual Punch Tool" reports the same PM95 figures):
//!
//! 1. STFT (1024 Hann, hop 256 ≈ 5.3 ms @ 48 kHz) of the mono mix.
//! 2. Transient / steady-state separation by median filtering (Fitzgerald 2010) with the
//!    Driedger binary mask: a bin is transient when its frequency-median (vertical) energy is
//!    ≥ βt = 3 × its time-median (horizontal) energy. Only the transient part is measured.
//! 3. Modified BS.1770 loudness weighting: RLB high-pass (38 Hz) + high shelf whose corner is
//!    1 kHz and gain +10 dB (the authors' change from 1.68 kHz / +4 dB), normalised to 0 dB at
//!    1 kHz, applied per bin as an amplitude weight.
//! 4. Octave-band energies 63 Hz … 16 kHz. Bands 63 Hz … 1 kHz carry the regression weight
//!    `EstPunch = 0.954 − 0.171·Band − 0.088·Onset` (Band 1…5 = 63 Hz…1 kHz, Onset 1…5 =
//!    0/5/10/20/60 ms attack), used as the amplitude gain `1 + EstPunch` (so 63 Hz with a
//!    0 ms attack is +4.6 dB above 1 kHz, a 60 ms attack costs 2–4 dB). Bands above 1 kHz keep
//!    the 1 kHz weight — the paper leaves 2–8 kHz "ongoing", so they are neutral here.
//! 5. Momentary punch = the weighted transient energy averaged over a 280 ms block (the
//!    paper's shortened momentary window), in dB where 0 dB is the energy of a full-scale sine
//!    (a full-scale sine → −3 dB, like BS.1770). Sustained tones are not transient and read ≈ −∞.
//!
//! Hits: an onset in the broadband transient energy (≥ 8 dB over the tracked floor) opens a
//! hit; its attack time is onset → transient peak, its punch is the 280 ms block from the
//! onset with the attack-dependent weights, and PM95 / mean over the session come from a
//! histogram of momentary frames that carry signal (PM95M = PM95 − mean, in dB).
//!
//! The "flash" (화려함) index is **not** from the papers — it is this app's own heuristic for
//! how showy a hit is: high-band share (sparkle), octave coverage (spread), stereo width and
//! tail length, each 0…1, mixed 35/25/25/15 into 0…100.

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::collections::VecDeque;
use std::sync::Arc;

pub const N_OCT: usize = 9;
const OCT_FC: [f32; N_OCT] = [63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];
const WIN: usize = 1024;
const HOP: usize = 256;
const LT: usize = 17; // time-median length (frames) ≈ 90 ms
const LF: usize = 17; // frequency-median length (bins) ≈ 800 Hz
const BETA_T: f32 = 3.0;
const BLOCK_MS: f32 = 280.0;
const HIT_MS: f32 = 500.0;
const ATTACK_MAX_MS: f32 = 80.0;
const MIN_GAP_MS: f32 = 60.0;
const ONSET_RISE_DB: f32 = 8.0;
const FLOOR_DB: f32 = -75.0;
const FLOOR_RISE_DB_PER_S: f32 = 40.0;
const HIST_LO: f32 = -90.0;
const HIST_STEP: f32 = 0.5;
const HIST_N: usize = 200; // −90 … +10 dB
const SILENCE: f32 = -120.0;

#[derive(Clone, Debug, serde::Serialize)]
pub struct Hit {
    pub seq: u64,
    /// Seconds since capture start (onset).
    pub t: f64,
    /// Weighted transient punch of the 280 ms block from the onset, dB re full-scale sine.
    pub punch_db: f32,
    /// Onset → transient-energy peak, ms.
    pub attack_ms: f32,
    /// Transient octave energies over the block (loudness-weighted, no punch weights), dB.
    pub bands: Vec<f32>,
    /// 0…100 — this app's showiness heuristic (see module doc).
    pub flash: f32,
    pub sparkle: f32,
    pub spread: f32,
    pub width: f32,
    pub tail: f32,
    /// Sample peak over the hit window, dBFS.
    pub peak_db: f32,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct PunchStats {
    /// Live 280 ms punch, dB.
    pub momentary: f32,
    /// Transient-to-steady-state ratio over the block, dB (AES 138 "TSR").
    pub tsr: f32,
    pub pm95: f32,
    pub mean: f32,
    pub frames: u64,
}

impl Default for PunchStats {
    fn default() -> Self {
        Self { momentary: SILENCE, tsr: 0.0, pm95: SILENCE, mean: SILENCE, frames: 0 }
    }
}

#[derive(Clone, Copy, Default)]
struct Rec {
    bands: [f32; N_OCT], // transient, loudness-weighted power per octave
    trans: f32,          // Σ bands
    total: f32,          // all components, loudness-weighted power
    mid: f32,
    side: f32,
    peak: f32,
}

struct Pending {
    onset: u64,
    peak_idx: u64,
    peak_val: f32,
}

pub struct PunchMeter {
    sr: f32,
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    norm: f32,
    weight: Vec<f32>,          // per-bin amplitude weight (modified K)
    band_bins: Vec<(usize, usize)>,
    band_x: [f32; N_OCT],      // regression "Band" code per octave
    g2_fast: [f32; N_OCT],     // power gains for a 0 ms attack (momentary meter)
    buf: Vec<f32>,             // mono ring, WIN
    pos: usize,
    filled: usize,
    hop_n: usize,
    hop_mid: f32,
    hop_side: f32,
    hop_peak: f32,
    ms_queue: VecDeque<(f32, f32, f32)>, // (mid, side, peak) delayed to the median centre
    mags: VecDeque<Vec<f32>>,  // last LT magnitude frames
    scratch: Vec<Complex<f32>>,
    med_scratch: Vec<f32>,
    freq_med: Vec<f32>,
    time_med: Vec<f32>,
    recs: VecDeque<Rec>,       // centre-frame records, newest last
    recs_base: u64,            // absolute index of recs[0]
    frames_total: u64,         // centre frames produced
    block_n: usize,
    hit_n: usize,
    floor_db: f32,
    prev_t_db: f32,
    pending: Option<Pending>,
    last_onset: i64,
    hist: Vec<u32>,
    hist_sum: f64,
    hist_n: u64,
    pub stats: PunchStats,
    hits: VecDeque<Hit>,
    hit_seq: u64,
}

fn median(v: &mut [f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    let m = v.len() / 2;
    let (_, x, _) = v.select_nth_unstable_by(m, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    *x
}

/// |H(e^jω)| of an RBJ biquad given its coefficients.
fn biquad_mag(b: [f64; 3], a: [f64; 3], w: f64) -> f64 {
    let (c1, s1) = (w.cos(), w.sin());
    let (c2, s2) = ((2.0 * w).cos(), (2.0 * w).sin());
    let nr = b[0] + b[1] * c1 + b[2] * c2;
    let ni = -(b[1] * s1 + b[2] * s2);
    let dr = a[0] + a[1] * c1 + a[2] * c2;
    let di = -(a[1] * s1 + a[2] * s2);
    ((nr * nr + ni * ni) / (dr * dr + di * di).max(1e-30)).sqrt()
}

fn rbj_highpass(sr: f64, f0: f64, q: f64) -> ([f64; 3], [f64; 3]) {
    let w0 = 2.0 * std::f64::consts::PI * f0 / sr;
    let alpha = w0.sin() / (2.0 * q);
    let c = w0.cos();
    ([(1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0], [1.0 + alpha, -2.0 * c, 1.0 - alpha])
}

fn rbj_highshelf(sr: f64, f0: f64, gain_db: f64, s: f64) -> ([f64; 3], [f64; 3]) {
    let a = 10f64.powf(gain_db / 40.0);
    let w0 = 2.0 * std::f64::consts::PI * f0 / sr;
    let c = w0.cos();
    let alpha = w0.sin() / 2.0 * ((a + 1.0 / a) * (1.0 / s - 1.0) + 2.0).sqrt();
    let sq = 2.0 * a.sqrt() * alpha;
    (
        [a * ((a + 1.0) + (a - 1.0) * c + sq), -2.0 * a * ((a - 1.0) + (a + 1.0) * c), a * ((a + 1.0) + (a - 1.0) * c - sq)],
        [(a + 1.0) - (a - 1.0) * c + sq, 2.0 * ((a - 1.0) - (a + 1.0) * c), (a + 1.0) - (a - 1.0) * c - sq],
    )
}

/// Regression weight (AES 139 eq. 3) as an amplitude gain `1 + EstPunch`, squared for power.
fn punch_gain2(band_x: f32, onset_y: f32) -> f32 {
    let est = 0.954 - 0.171 * band_x - 0.088 * onset_y;
    let g = (1.0 + est).max(0.1);
    g * g
}

/// Attack time → the regression's onset code (0/5/10/20/60 ms = 1…5), interpolated.
fn onset_code(attack_ms: f32) -> f32 {
    const PTS: [(f32, f32); 5] = [(0.0, 1.0), (5.0, 2.0), (10.0, 3.0), (20.0, 4.0), (60.0, 5.0)];
    if attack_ms <= 0.0 {
        return 1.0;
    }
    for w in PTS.windows(2) {
        let (x0, y0) = w[0];
        let (x1, y1) = w[1];
        if attack_ms <= x1 {
            return y0 + (y1 - y0) * (attack_ms - x0) / (x1 - x0);
        }
    }
    5.0
}

fn db(p: f32) -> f32 {
    if p > 1e-12 { (10.0 * p.log10()).max(SILENCE) } else { SILENCE }
}

impl PunchMeter {
    pub fn new(sr: u32) -> Self {
        let srf = sr as f32;
        let window: Vec<f32> = (0..WIN).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / WIN as f32).cos()).collect();
        let w2: f32 = window.iter().map(|w| w * w).sum();
        // One-sided Parseval with window power correction: mean-square = norm · Σ|X_k|².
        let norm = 2.0 / (WIN as f32 * w2);
        let bins = WIN / 2 + 1;
        let bin_hz = srf / WIN as f32;
        let hp = rbj_highpass(sr as f64, 38.0, 0.5);
        let sh = rbj_highshelf(sr as f64, 1000.0, 10.0, 1.0);
        let mag_at = |hz: f64| {
            let w = 2.0 * std::f64::consts::PI * hz / sr as f64;
            biquad_mag(hp.0, hp.1, w) * biquad_mag(sh.0, sh.1, w)
        };
        let ref1k = mag_at(1000.0);
        let weight: Vec<f32> = (0..bins).map(|k| (mag_at(k as f64 * bin_hz as f64) / ref1k) as f32).collect();
        let band_bins: Vec<(usize, usize)> = OCT_FC
            .iter()
            .map(|fc| {
                let lo = ((fc / 2f32.sqrt() / bin_hz).round() as usize).max(1);
                let hi = ((fc * 2f32.sqrt() / bin_hz).round() as usize).clamp(lo + 1, bins);
                (lo, hi.max(lo + 1).min(bins))
            })
            .collect();
        let mut band_x = [5.0f32; N_OCT];
        for (b, x) in band_x.iter_mut().enumerate().take(5) {
            *x = (b + 1) as f32;
        }
        let mut g2_fast = [1.0f32; N_OCT];
        for b in 0..N_OCT {
            g2_fast[b] = punch_gain2(band_x[b], 1.0);
        }
        let hop_ms = HOP as f32 / srf * 1000.0;
        Self {
            sr: srf,
            fft: FftPlanner::<f32>::new().plan_fft_forward(WIN),
            window,
            norm,
            weight,
            band_bins,
            band_x,
            g2_fast,
            buf: vec![0.0; WIN],
            pos: 0,
            filled: 0,
            hop_n: 0,
            hop_mid: 0.0,
            hop_side: 0.0,
            hop_peak: 0.0,
            ms_queue: VecDeque::with_capacity(LT + 1),
            mags: VecDeque::with_capacity(LT + 1),
            scratch: vec![Complex::new(0.0, 0.0); WIN],
            med_scratch: vec![0.0; LT.max(LF)],
            freq_med: vec![0.0; bins],
            time_med: vec![0.0; bins],
            recs: VecDeque::with_capacity(1024),
            recs_base: 0,
            frames_total: 0,
            block_n: (BLOCK_MS / hop_ms).round().max(1.0) as usize,
            hit_n: (HIT_MS / hop_ms).round().max(2.0) as usize,
            floor_db: FLOOR_DB,
            prev_t_db: SILENCE,
            pending: None,
            last_onset: -1_000_000,
            hist: vec![0; HIST_N],
            hist_sum: 0.0,
            hist_n: 0,
            stats: PunchStats::default(),
            hits: VecDeque::with_capacity(256),
            hit_seq: 0,
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sr as u32
    }

    fn hop_ms(&self) -> f32 {
        HOP as f32 / self.sr * 1000.0
    }

    /// Clears session statistics (PM95 / mean) and the hit list.
    pub fn reset(&mut self) {
        self.hist.iter_mut().for_each(|h| *h = 0);
        self.hist_sum = 0.0;
        self.hist_n = 0;
        self.hits.clear();
        self.stats.pm95 = SILENCE;
        self.stats.mean = SILENCE;
        self.stats.frames = 0;
    }

    pub fn hits_since(&self, after: u64) -> Vec<Hit> {
        self.hits.iter().filter(|h| h.seq > after).cloned().collect()
    }

    /// Interleaved stereo.
    pub fn feed(&mut self, stereo: &[f32]) {
        for fr in stereo.chunks_exact(2) {
            let (l, r) = (fr[0], fr[1]);
            let m = 0.5 * (l + r);
            let s = 0.5 * (l - r);
            self.buf[self.pos] = m;
            self.pos = (self.pos + 1) % WIN;
            self.filled = (self.filled + 1).min(WIN);
            self.hop_mid += m * m;
            self.hop_side += s * s;
            self.hop_peak = self.hop_peak.max(l.abs()).max(r.abs());
            self.hop_n += 1;
            if self.hop_n >= HOP {
                let n = self.hop_n as f32;
                let ms = (self.hop_mid / n, self.hop_side / n, self.hop_peak);
                self.hop_n = 0;
                self.hop_mid = 0.0;
                self.hop_side = 0.0;
                self.hop_peak = 0.0;
                if self.filled >= WIN {
                    self.hop(ms);
                }
            }
        }
    }

    fn hop(&mut self, ms: (f32, f32, f32)) {
        // ---- magnitude spectrum of the newest WIN samples
        for i in 0..WIN {
            let s = self.buf[(self.pos + i) % WIN];
            self.scratch[i] = Complex::new(s * self.window[i], 0.0);
        }
        self.fft.process(&mut self.scratch);
        let bins = WIN / 2 + 1;
        let mags: Vec<f32> = (0..bins).map(|k| self.scratch[k].norm()).collect();
        self.mags.push_back(mags);
        self.ms_queue.push_back(ms);
        if self.mags.len() < LT {
            return;
        }
        while self.mags.len() > LT {
            self.mags.pop_front();
        }
        while self.ms_queue.len() > LT / 2 + 1 {
            self.ms_queue.pop_front();
        }
        let (mid, side, peak) = self.ms_queue.front().copied().unwrap_or(ms);
        let c = LT / 2;
        // ---- median filters (Fitzgerald): horizontal → steady state, vertical → transient
        for k in 0..bins {
            for (i, fr) in self.mags.iter().enumerate() {
                self.med_scratch[i] = fr[k];
            }
            self.time_med[k] = median(&mut self.med_scratch[..LT]);
        }
        {
            let centre = &self.mags[c];
            let half = LF / 2;
            for k in 0..bins {
                let lo = k.saturating_sub(half);
                let hi = (k + half + 1).min(bins);
                let n = hi - lo;
                self.med_scratch[..n].copy_from_slice(&centre[lo..hi]);
                self.freq_med[k] = median(&mut self.med_scratch[..n]);
            }
        }
        // ---- transient mask + loudness weighting → octave powers
        let mut rec = Rec { mid, side, peak, ..Default::default() };
        {
            let centre = &self.mags[c];
            let mut total = 0.0f32;
            for k in 1..bins {
                let a = centre[k] * self.weight[k];
                let p = a * a * self.norm;
                total += p;
            }
            rec.total = total;
            for b in 0..N_OCT {
                let (lo, hi) = self.band_bins[b];
                let mut e = 0.0f32;
                for k in lo..hi {
                    if self.freq_med[k] >= BETA_T * self.time_med[k] + 1e-9 {
                        let a = centre[k] * self.weight[k];
                        e += a * a * self.norm;
                    }
                }
                rec.bands[b] = e;
                rec.trans += e;
            }
        }
        self.recs.push_back(rec);
        let idx = self.frames_total;
        self.frames_total += 1;
        let keep = self.hit_n + self.block_n + 64;
        while self.recs.len() > keep {
            self.recs.pop_front();
            self.recs_base += 1;
        }

        // ---- momentary (280 ms) punch + TSR
        let n = self.recs.len().min(self.block_n);
        let (mut wsum, mut tr, mut tot) = (0.0f32, 0.0f32, 0.0f32);
        for r in self.recs.iter().rev().take(n) {
            for b in 0..N_OCT {
                wsum += self.g2_fast[b] * r.bands[b];
            }
            tr += r.trans;
            tot += r.total;
        }
        let momentary = db(wsum / n as f32);
        self.stats.momentary = momentary;
        self.stats.tsr = if tr > 1e-12 && tot - tr > 1e-12 { (10.0 * (tr / (tot - tr)).log10()).clamp(-40.0, 40.0) } else { 0.0 };
        if momentary > FLOOR_DB {
            let bin = (((momentary - HIST_LO) / HIST_STEP).round() as isize).clamp(0, HIST_N as isize - 1) as usize;
            self.hist[bin] += 1;
            self.hist_sum += momentary as f64;
            self.hist_n += 1;
            self.stats.frames = self.hist_n;
            self.stats.mean = (self.hist_sum / self.hist_n as f64) as f32;
            let target = (self.hist_n as f64 * 0.05).ceil() as u64;
            let mut acc = 0u64;
            let mut p95 = HIST_LO;
            for (i, h) in self.hist.iter().enumerate().rev() {
                acc += *h as u64;
                if acc >= target {
                    p95 = HIST_LO + i as f32 * HIST_STEP;
                    break;
                }
            }
            self.stats.pm95 = p95;
        }

        // ---- onset → hit
        let hop_ms = self.hop_ms();
        let t_db = db(rec.trans);
        self.floor_db = (self.floor_db + FLOOR_RISE_DB_PER_S * hop_ms / 1000.0).min(t_db).max(FLOOR_DB - 10.0);
        let gap_ok = idx as i64 - self.last_onset >= (MIN_GAP_MS / hop_ms) as i64;
        if self.pending.is_none() && t_db > FLOOR_DB && t_db > self.prev_t_db && t_db >= self.floor_db + ONSET_RISE_DB && gap_ok {
            self.pending = Some(Pending { onset: idx, peak_idx: idx, peak_val: rec.trans });
            self.last_onset = idx as i64;
            // The floor jumps to the onset level so the same hit cannot re-trigger as it decays.
            self.floor_db = t_db;
        } else if let Some(p) = self.pending.as_mut() {
            let since_ms = (idx - p.onset) as f32 * hop_ms;
            if since_ms <= ATTACK_MAX_MS && rec.trans > p.peak_val {
                p.peak_val = rec.trans;
                p.peak_idx = idx;
            }
            self.floor_db = self.floor_db.max(t_db - ONSET_RISE_DB + 2.0).min(t_db);
            if idx - p.onset + 1 >= self.hit_n as u64 {
                let p = self.pending.take().unwrap();
                self.finish_hit(p);
            }
        }
        self.prev_t_db = t_db;
    }

    fn rec_at(&self, abs: u64) -> Option<&Rec> {
        if abs < self.recs_base {
            return None;
        }
        self.recs.get((abs - self.recs_base) as usize)
    }

    fn finish_hit(&mut self, p: Pending) {
        let hop_ms = self.hop_ms();
        let attack_ms = (p.peak_idx - p.onset) as f32 * hop_ms;
        let y = onset_code(attack_ms);
        let start = p.onset.saturating_sub(1);
        let mut bands = [0.0f32; N_OCT];
        let (mut wsum, mut mid, mut side, mut peak, mut nb) = (0.0f32, 0.0f32, 0.0f32, 0.0f32, 0usize);
        for i in 0..self.block_n as u64 {
            let Some(r) = self.rec_at(start + i) else { break };
            for b in 0..N_OCT {
                bands[b] += r.bands[b];
                wsum += punch_gain2(self.band_x[b], y) * r.bands[b];
            }
            mid += r.mid;
            side += r.side;
            peak = peak.max(r.peak);
            nb += 1;
        }
        if nb == 0 {
            return;
        }
        let punch_db = db(wsum / nb as f32);
        if punch_db <= FLOOR_DB {
            return;
        }
        let band_db: Vec<f32> = bands.iter().map(|e| db(e / nb as f32)).collect();
        // ---- flash (own heuristic)
        let lo: f32 = bands[..5].iter().sum::<f32>() / nb as f32;
        let hi: f32 = bands[5..].iter().sum::<f32>() / nb as f32;
        let sparkle = (((hi + 1e-12) / (lo + 1e-12)).log10() * 10.0 + 20.0) / 40.0;
        let sparkle = sparkle.clamp(0.0, 1.0);
        let max_b = band_db.iter().cloned().fold(SILENCE, f32::max);
        let spread = band_db.iter().filter(|&&d| d >= max_b - 15.0).count() as f32 / N_OCT as f32;
        let width = if mid + side > 1e-12 { (2.0 * side / (mid + side)).clamp(0.0, 1.0) } else { 0.0 };
        // tail: how long the whole (not just transient) energy stays within 20 dB of its peak
        let mut peak_total = 0.0f32;
        let mut peak_at = p.onset;
        for i in 0..self.hit_n as u64 {
            if let Some(r) = self.rec_at(p.onset + i) {
                if r.total > peak_total {
                    peak_total = r.total;
                    peak_at = p.onset + i;
                }
            }
        }
        let mut t20 = 0u64;
        for i in 0..self.hit_n as u64 {
            match self.rec_at(peak_at + i) {
                Some(r) if r.total >= peak_total * 0.01 => t20 = i,
                _ => break,
            }
        }
        let t20_ms = t20 as f32 * hop_ms;
        let tail = ((t20_ms - 60.0) / 380.0).clamp(0.0, 1.0);
        let flash = 100.0 * (0.35 * sparkle + 0.25 * spread + 0.25 * width + 0.15 * tail);
        self.hit_seq += 1;
        self.hits.push_back(Hit {
            seq: self.hit_seq,
            t: (p.onset * HOP as u64) as f64 / self.sr as f64,
            punch_db,
            attack_ms,
            bands: band_db,
            flash,
            sparkle,
            spread,
            width,
            tail,
            peak_db: if peak > 1e-6 { 20.0 * peak.log10() } else { SILENCE },
        });
        while self.hits.len() > 200 {
            self.hits.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo(mono: &[f32]) -> Vec<f32> {
        mono.iter().flat_map(|&s| [s, s]).collect()
    }

    fn burst(sr: f32, hz: f32, attack_ms: f32, len_ms: f32, amp: f32) -> Vec<f32> {
        let n = (len_ms / 1000.0 * sr) as usize;
        let mut seed = 12345u32;
        (0..n)
            .map(|i| {
                let t = i as f32 / sr * 1000.0;
                let env = if attack_ms <= 0.0 { 1.0 } else { (t / attack_ms).min(1.0) } * (-(t - attack_ms).max(0.0) / 60.0).exp();
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let noise = (seed >> 9) as f32 / (1u32 << 23) as f32 - 1.0;
                let tone = (2.0 * std::f32::consts::PI * hz * i as f32 / sr).sin();
                amp * env * (0.7 * tone + 0.3 * noise)
            })
            .collect()
    }

    fn run(sig: &[f32]) -> PunchMeter {
        let mut m = PunchMeter::new(48_000);
        let silence = vec![0.0f32; 48_000 / 2];
        m.feed(&stereo(&silence));
        m.feed(&stereo(sig));
        m.feed(&stereo(&silence)); // lets the pending hit finish
        m.feed(&stereo(&silence));
        m
    }

    #[test]
    fn sustained_tone_has_no_punch() {
        let sr = 48_000.0;
        let tone: Vec<f32> = (0..(2.0 * sr) as usize).map(|i| 0.5 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr).sin()).collect();
        let mut m = PunchMeter::new(48_000);
        m.feed(&stereo(&vec![0.0f32; 24_000]));
        m.feed(&stereo(&tone[..tone.len() / 2]));
        let mid = m.stats.momentary; // 1 s into the sustain: nothing transient left
        m.feed(&stereo(&tone[tone.len() / 2..]));
        m.feed(&stereo(&vec![0.0f32; 48_000]));
        assert!(mid < -40.0, "momentary mid-tone {mid}");
        // the hard start and the hard cut are real broadband transients — nothing else may fire
        assert!(m.hits.len() <= 2, "hits {}", m.hits.len());
    }

    #[test]
    fn fast_low_hit_punches_harder_than_slow_high() {
        let fast_low = run(&burst(48_000.0, 90.0, 0.0, 400.0, 0.8));
        let slow_high = run(&burst(48_000.0, 4000.0, 60.0, 400.0, 0.8));
        assert_eq!(fast_low.hits.len(), 1, "fast hits {}", fast_low.hits.len());
        assert_eq!(slow_high.hits.len(), 1, "slow hits {}", slow_high.hits.len());
        let a = &fast_low.hits[0];
        let b = &slow_high.hits[0];
        assert!(a.attack_ms < 15.0, "fast attack {}", a.attack_ms);
        assert!(b.attack_ms > 30.0, "slow attack {}", b.attack_ms);
        assert!(a.punch_db > b.punch_db + 3.0, "punch {} vs {}", a.punch_db, b.punch_db);
        assert!(b.sparkle > a.sparkle, "sparkle {} vs {}", a.sparkle, b.sparkle);
        assert!(a.punch_db > -40.0 && a.punch_db < 6.0, "scale {}", a.punch_db);
    }

    #[test]
    fn louder_hit_reads_higher_by_about_the_gain() {
        let q = run(&burst(48_000.0, 200.0, 0.0, 300.0, 0.25));
        let l = run(&burst(48_000.0, 200.0, 0.0, 300.0, 0.5));
        let d = l.hits[0].punch_db - q.hits[0].punch_db;
        assert!((d - 6.0).abs() < 2.0, "delta {d}");
        assert!(l.stats.pm95 > l.stats.mean, "pm95 {} mean {}", l.stats.pm95, l.stats.mean);
    }

    #[test]
    fn weights_follow_the_regression() {
        assert!((onset_code(0.0) - 1.0).abs() < 1e-6);
        assert!((onset_code(7.5) - 2.5).abs() < 1e-6);
        assert!((onset_code(200.0) - 5.0).abs() < 1e-6);
        assert!(punch_gain2(1.0, 1.0) > punch_gain2(5.0, 1.0));
        assert!(punch_gain2(1.0, 1.0) > punch_gain2(1.0, 5.0));
    }
}
