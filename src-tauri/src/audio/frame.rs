//! One analysis frame and its binary wire format.
//!
//! The UI polls `frame()` every animation frame and receives a little-endian `f32`
//! array (`ArrayBuffer`). Layout, in f32 indices — keep `src/engine/frame.ts` in sync:
//!
//! ```text
//! 0  magic 7331          1  seq            2  sample_rate
//! 3  N_SPEC              4  N_SCOPE        5  N_LISSA
//! 6  peak L (dBFS)       7  peak R         8  rms L (dBFS)      9  rms R
//! 10 true peak L (dBTP)  11 true peak R    12 correlation (-1..1)
//! 13 LUFS momentary      14 LUFS short     15 LUFS integrated   16 LRA (LU)
//! 17 max true peak       18 max momentary  19 max short
//! 20 running (1/0)       21 channels
//! 22 f0 (Hz)            23 F1 (Hz)       24 F2 (Hz)          25 F3 (Hz)
//! 26 voiced (0..1)      27 rec seconds (<0 = not recording)
//! 28 spectral flatness (0..1, noise-like → 1)   29 spectral centroid (Hz)
//! 30 punch momentary (dB, 280 ms weighted transient — see punch.rs)   31 TSR (dB)
//! 32                      spectrum L  [N_SPEC] dB
//! 32+N_SPEC               spectrum R  [N_SPEC] dB
//! 32+2*N_SPEC             scope L     [N_SCOPE]
//! +N_SCOPE                scope R     [N_SCOPE]
//! +N_SCOPE                lissajous   [2*N_LISSA] interleaved L,R
//! +2*N_LISSA              LPC envelope [N_ENV] dB, 0..5 kHz linear
//! +N_ENV                  stereo bands [2*N_BANDS]: (correlation, width) per band
//!                         bands: <150 Hz, 150–600, 600–2.5k, 2.5k–20k
//! +2*N_BANDS              spectrum M  [N_SPEC] dB   (mid = (L+R)/2)
//! +N_SPEC                 spectrum S  [N_SPEC] dB   (side = (L−R)/2)
//! +N_SPEC                 melody      [2*N_MELODY]: (Hz, salience 0..1) per candidate,
//!                         strongest first (0 Hz = none) — see melody.rs
//! +2*N_MELODY             poly        [2*N_KEYS]: piano note activity (88, A0…C8) then note
//!                         onset (88), 0..1 — Basic Pitch, see transcribe.rs (zeros when off)
//! ```

pub const MAGIC: f32 = 7331.0;
pub const HEADER: usize = 32;
pub const N_SPEC: usize = 256;
pub const N_SCOPE: usize = 1024;
pub const N_LISSA: usize = 512;
pub const N_ENV: usize = 128;
pub const N_BANDS: usize = 4;
pub const N_MELODY: usize = super::melody::N_MELODY;
pub const N_KEYS: usize = super::transcribe::N_KEYS;
pub const BAND_EDGES: [f32; 5] = [20.0, 150.0, 600.0, 2500.0, 20000.0];
pub const SILENCE_DB: f32 = -120.0;

#[derive(Clone, Debug)]
pub struct Frame {
    pub seq: u32,
    pub sample_rate: f32,
    pub running: bool,
    pub channels: u16,
    pub peak: [f32; 2],
    pub rms: [f32; 2],
    pub true_peak: [f32; 2],
    pub correlation: f32,
    pub lufs_m: f32,
    pub lufs_s: f32,
    pub lufs_i: f32,
    pub lra: f32,
    pub max_tp: f32,
    pub max_m: f32,
    pub max_s: f32,
    pub f0: f32,
    pub f1: f32,
    pub f2: f32,
    pub f3: f32,
    pub voiced: f32,
    pub rec_seconds: f32,
    pub flatness: f32,
    pub centroid: f32,
    pub punch_m: f32,
    pub tsr: f32,
    pub spectrum_l: Vec<f32>,
    pub spectrum_r: Vec<f32>,
    pub scope_l: Vec<f32>,
    pub scope_r: Vec<f32>,
    pub lissa: Vec<f32>,
    pub envelope: Vec<f32>,
    pub bands: Vec<f32>,
    pub spectrum_m: Vec<f32>,
    pub spectrum_s: Vec<f32>,
    /// (Hz, salience) × N_MELODY, strongest first — see melody.rs.
    pub melody: Vec<f32>,
    /// Piano transcription: note activity [88] then onset [88] — see transcribe.rs.
    pub poly: Vec<f32>,
}

impl Default for Frame {
    fn default() -> Self {
        Self {
            seq: 0,
            sample_rate: 0.0,
            running: false,
            channels: 0,
            peak: [SILENCE_DB; 2],
            rms: [SILENCE_DB; 2],
            true_peak: [SILENCE_DB; 2],
            correlation: 0.0,
            lufs_m: SILENCE_DB,
            lufs_s: SILENCE_DB,
            lufs_i: SILENCE_DB,
            lra: 0.0,
            max_tp: SILENCE_DB,
            max_m: SILENCE_DB,
            max_s: SILENCE_DB,
            f0: 0.0,
            f1: 0.0,
            f2: 0.0,
            f3: 0.0,
            voiced: 0.0,
            rec_seconds: -1.0,
            flatness: 0.0,
            centroid: 0.0,
            punch_m: SILENCE_DB,
            tsr: 0.0,
            spectrum_l: vec![SILENCE_DB; N_SPEC],
            spectrum_r: vec![SILENCE_DB; N_SPEC],
            scope_l: vec![0.0; N_SCOPE],
            scope_r: vec![0.0; N_SCOPE],
            lissa: vec![0.0; 2 * N_LISSA],
            envelope: vec![SILENCE_DB; N_ENV],
            bands: vec![0.0; 2 * N_BANDS],
            spectrum_m: vec![SILENCE_DB; N_SPEC],
            spectrum_s: vec![SILENCE_DB; N_SPEC],
            melody: vec![0.0; 2 * N_MELODY],
            poly: vec![0.0; 2 * N_KEYS],
        }
    }
}

impl Frame {
    pub fn pack(&self) -> Vec<u8> {
        let total = HEADER + 2 * N_SPEC + 2 * N_SCOPE + 2 * N_LISSA + N_ENV + 2 * N_BANDS + 2 * N_SPEC + 2 * N_MELODY + 2 * N_KEYS;
        let mut v: Vec<f32> = Vec::with_capacity(total);
        v.extend_from_slice(&[
            MAGIC,
            self.seq as f32,
            self.sample_rate,
            N_SPEC as f32,
            N_SCOPE as f32,
            N_LISSA as f32,
            self.peak[0],
            self.peak[1],
            self.rms[0],
            self.rms[1],
            self.true_peak[0],
            self.true_peak[1],
            self.correlation,
            self.lufs_m,
            self.lufs_s,
            self.lufs_i,
            self.lra,
            self.max_tp,
            self.max_m,
            self.max_s,
            if self.running { 1.0 } else { 0.0 },
            self.channels as f32,
            self.f0,
            self.f1,
            self.f2,
            self.f3,
            self.voiced,
            self.rec_seconds,
            self.flatness,
            self.centroid,
            self.punch_m,
            self.tsr,
        ]);
        v.resize(HEADER, 0.0);
        v.extend_from_slice(&self.spectrum_l);
        v.extend_from_slice(&self.spectrum_r);
        v.extend_from_slice(&self.scope_l);
        v.extend_from_slice(&self.scope_r);
        v.extend_from_slice(&self.lissa);
        v.extend_from_slice(&self.envelope);
        v.extend_from_slice(&self.bands);
        v.extend_from_slice(&self.spectrum_m);
        v.extend_from_slice(&self.spectrum_s);
        v.extend_from_slice(&self.melody);
        v.extend_from_slice(&self.poly);
        debug_assert_eq!(v.len(), total);
        let mut bytes = Vec::with_capacity(total * 4);
        for x in v {
            bytes.extend_from_slice(&x.to_le_bytes());
        }
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_layout_is_stable() {
        let mut f = Frame::default();
        f.seq = 9;
        f.peak = [-3.0, -6.0];
        let b = f.pack();
        assert_eq!(b.len(), 4 * (HEADER + 2 * N_SPEC + 2 * N_SCOPE + 2 * N_LISSA + N_ENV + 2 * N_BANDS + 2 * N_SPEC + 2 * N_MELODY + 2 * N_KEYS));
        let at = |i: usize| f32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap());
        assert_eq!(at(0), MAGIC);
        assert_eq!(at(1), 9.0);
        assert_eq!(at(6), -3.0);
        assert_eq!(at(7), -6.0);
        assert_eq!(at(HEADER), SILENCE_DB);
    }
}
