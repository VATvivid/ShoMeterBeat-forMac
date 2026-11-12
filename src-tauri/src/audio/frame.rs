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
//! 22..32 reserved
//! 32                      spectrum L  [N_SPEC] dB
//! 32+N_SPEC               spectrum R  [N_SPEC] dB
//! 32+2*N_SPEC             scope L     [N_SCOPE]
//! +N_SCOPE                scope R     [N_SCOPE]
//! +N_SCOPE                lissajous   [2*N_LISSA] interleaved L,R
//! ```

pub const MAGIC: f32 = 7331.0;
pub const HEADER: usize = 32;
pub const N_SPEC: usize = 256;
pub const N_SCOPE: usize = 1024;
pub const N_LISSA: usize = 512;
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
    pub spectrum_l: Vec<f32>,
    pub spectrum_r: Vec<f32>,
    pub scope_l: Vec<f32>,
    pub scope_r: Vec<f32>,
    pub lissa: Vec<f32>,
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
            spectrum_l: vec![SILENCE_DB; N_SPEC],
            spectrum_r: vec![SILENCE_DB; N_SPEC],
            scope_l: vec![0.0; N_SCOPE],
            scope_r: vec![0.0; N_SCOPE],
            lissa: vec![0.0; 2 * N_LISSA],
        }
    }
}

impl Frame {
    pub fn pack(&self) -> Vec<u8> {
        let total = HEADER + 2 * N_SPEC + 2 * N_SCOPE + 2 * N_LISSA;
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
        ]);
        v.resize(HEADER, 0.0);
        v.extend_from_slice(&self.spectrum_l);
        v.extend_from_slice(&self.spectrum_r);
        v.extend_from_slice(&self.scope_l);
        v.extend_from_slice(&self.scope_r);
        v.extend_from_slice(&self.lissa);
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
        assert_eq!(b.len(), 4 * (HEADER + 2 * N_SPEC + 2 * N_SCOPE + 2 * N_LISSA));
        let at = |i: usize| f32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap());
        assert_eq!(at(0), MAGIC);
        assert_eq!(at(1), 9.0);
        assert_eq!(at(6), -3.0);
        assert_eq!(at(7), -6.0);
        assert_eq!(at(HEADER), SILENCE_DB);
    }
}
