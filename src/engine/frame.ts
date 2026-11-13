// Binary frame contract — must match src-tauri/src/audio/frame.rs.
export const MAGIC = 7331;
export const HEADER = 32;
export const N_SPEC = 256;
export const N_SCOPE = 1024;
export const N_LISSA = 512;
export const N_ENV = 128;
export const N_BANDS = 4;
export const BAND_LABELS = ["Low <150", "Low-mid 150–600", "Mid 600–2.5k", "High 2.5k+"];
export const ENV_MAX_HZ = 5000;
export const SILENCE_DB = -120;
export const F_LO = 20;
export const F_HI = 20000;

export interface Frame {
  seq: number;
  sampleRate: number;
  running: boolean;
  channels: number;
  peak: [number, number];
  rms: [number, number];
  truePeak: [number, number];
  correlation: number;
  lufsM: number;
  lufsS: number;
  lufsI: number;
  lra: number;
  maxTP: number;
  maxM: number;
  maxS: number;
  f0: number;
  f1: number;
  f2: number;
  f3: number;
  voiced: number;
  /** Seconds recorded so far, or -1 when not recording. */
  recSeconds: number;
  /** Spectral flatness 0..1 (1 = white-noise-like). */
  flatness: number;
  /** Spectral centroid in Hz. */
  centroid: number;
  /** Momentary perceptual punch (280 ms weighted transient energy), dB; see punch.rs. */
  punchM: number;
  /** Transient-to-steady-state ratio, dB. */
  tsr: number;
  specL: Float32Array;
  specR: Float32Array;
  scopeL: Float32Array;
  scopeR: Float32Array;
  lissa: Float32Array; // interleaved L,R
  envelope: Float32Array; // LPC envelope dB, 0..ENV_MAX_HZ linear
  /** (correlation, width) per band — see BAND_LABELS. */
  bands: Float32Array;
}

export function pointFreq(i: number): number {
  return F_LO * Math.pow(F_HI / F_LO, i / (N_SPEC - 1));
}

/** Fractional spectrum index for a frequency (inverse of pointFreq). */
export function freqToIndex(f: number): number {
  return (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * (N_SPEC - 1);
}

export function parseFrame(buf: ArrayBuffer): Frame | null {
  const v = new Float32Array(buf);
  if (v.length < HEADER || v[0] !== MAGIC) return null;
  const nSpec = v[3] | 0, nScope = v[4] | 0, nLissa = v[5] | 0;
  if (nSpec !== N_SPEC || nScope !== N_SCOPE || nLissa !== N_LISSA) return null;
  let o = HEADER;
  const take = (n: number) => { const s = v.subarray(o, o + n); o += n; return s; };
  return {
    seq: v[1],
    sampleRate: v[2],
    running: v[20] > 0.5,
    channels: v[21] | 0,
    peak: [v[6], v[7]],
    rms: [v[8], v[9]],
    truePeak: [v[10], v[11]],
    correlation: v[12],
    lufsM: v[13],
    lufsS: v[14],
    lufsI: v[15],
    lra: v[16],
    maxTP: v[17],
    maxM: v[18],
    maxS: v[19],
    f0: v[22],
    f1: v[23],
    f2: v[24],
    f3: v[25],
    voiced: v[26],
    recSeconds: v[27],
    flatness: v[28],
    centroid: v[29],
    punchM: v[30],
    tsr: v[31],
    specL: take(N_SPEC),
    specR: take(N_SPEC),
    scopeL: take(N_SCOPE),
    scopeR: take(N_SCOPE),
    lissa: take(2 * N_LISSA),
    envelope: v.length >= o + N_ENV ? take(N_ENV) : new Float32Array(N_ENV).fill(SILENCE_DB),
    bands: v.length >= o + 2 * N_BANDS ? take(2 * N_BANDS) : new Float32Array(2 * N_BANDS),
  };
}

export function emptyFrame(): Frame {
  return {
    seq: 0, sampleRate: 0, running: false, channels: 0,
    peak: [SILENCE_DB, SILENCE_DB], rms: [SILENCE_DB, SILENCE_DB], truePeak: [SILENCE_DB, SILENCE_DB],
    correlation: 0, lufsM: SILENCE_DB, lufsS: SILENCE_DB, lufsI: SILENCE_DB, lra: 0,
    maxTP: SILENCE_DB, maxM: SILENCE_DB, maxS: SILENCE_DB,
    f0: 0, f1: 0, f2: 0, f3: 0, voiced: 0, recSeconds: -1, flatness: 0, centroid: 0, punchM: SILENCE_DB, tsr: 0,
    specL: new Float32Array(N_SPEC).fill(SILENCE_DB), specR: new Float32Array(N_SPEC).fill(SILENCE_DB),
    scopeL: new Float32Array(N_SCOPE), scopeR: new Float32Array(N_SCOPE), lissa: new Float32Array(2 * N_LISSA),
    envelope: new Float32Array(N_ENV).fill(SILENCE_DB),
    bands: new Float32Array(2 * N_BANDS),
  };
}
