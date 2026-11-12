// Formants → articulation: inverse-distance blend of the calibrated vowel targets
// nearest to the measured (F1, F2), in log-formant space with F1 weighted 2.2×
// (the same metric the vowel map uses). Gives a smooth, physically plausible
// tongue/jaw/lip configuration for any formant pair.
import { ARTIC_KEYS, rowArtic, VOWEL_TARGETS, type Artic, type Body, type TargetRow } from "./vowelTargets";

export const REST: Artic = { tbX: 2.4, tbY: 6.9, jaw: 0.35, lipAp: 0.6, lipProt: 0.1, lipWidth: 0.8, root: 0, larynx: 0, ttX: 6.0, ttY: 6.6, ttCurl: 0 };
/** Mouth-breathing posture: jaw dropped, lips apart, tongue low and back. */
export const BREATH_OPEN: Artic = { tbX: 2.0, tbY: 6.2, jaw: 1.0, lipAp: 1.5, lipProt: 0.05, lipWidth: 0.9, root: -0.3, larynx: -0.3, ttX: 5.8, ttY: 5.9, ttCurl: 0 };

function dist(f1: number, f2: number, r: TargetRow): number {
  return Math.hypot(2.2 * Math.log(f1 / r[1]), Math.log(f2 / r[2]));
}

/** Vowel sets for the blend. "common" drops front-rounded/central vowels that neither
 *  English nor Korean uses (they otherwise attract low-F1 estimates). */
export type VowelSet = "common" | "all";
const UNCOMMON = new Set(["y", "ø", "œ", "ɨ"]);

const stats = new Map<string, { mean: Artic; lo: Artic; hi: Artic }>();
function tableStats(body: Body, set: VowelSet) {
  const key = body + set;
  let s = stats.get(key);
  if (s) return s;
  const rows = VOWEL_TARGETS[body].filter((r) => set === "all" || !UNCOMMON.has(r[0]));
  const mean = {} as Artic, lo = {} as Artic, hi = {} as Artic;
  for (const k of ARTIC_KEYS) {
    const vals = rows.map((r) => rowArtic(r)[k]);
    mean[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
    lo[k] = Math.min(...vals); hi[k] = Math.max(...vals);
  }
  s = { mean, lo, hi };
  stats.set(key, s);
  return s;
}

/** Blend of the 4 nearest calibrated vowels (weight 1/(d+0.02)^3), then the deviation
 *  from the table mean scaled by `gain` (expressiveness), clamped near the table range. */
export function articForFormants(f1: number, f2: number, body: Body, set: VowelSet = "common", gain = 1): { artic: Artic; ipa: string; d: number } {
  const rows = VOWEL_TARGETS[body].filter((r) => set === "all" || !UNCOMMON.has(r[0]));
  const scored = rows.map((r) => ({ r, d: dist(f1, f2, r) })).sort((a, b) => a.d - b.d).slice(0, 4);
  const out = {} as Artic;
  for (const k of ARTIC_KEYS) out[k] = 0;
  let wsum = 0;
  for (const { r, d } of scored) {
    const w = 1 / Math.pow(d + 0.02, 3);
    const a = rowArtic(r);
    for (const k of ARTIC_KEYS) out[k] += a[k] * w;
    wsum += w;
  }
  const { mean, lo, hi } = tableStats(body, set);
  for (const k of ARTIC_KEYS) {
    const v = out[k] / wsum;
    const span = hi[k] - lo[k];
    out[k] = Math.max(lo[k] - span * 0.12, Math.min(hi[k] + span * 0.12, mean[k] + (v - mean[k]) * gain));
  }
  return { artic: out, ipa: scored[0].r[0], d: scored[0].d };
}

export function lerpArtic(a: Artic, b: Artic, t: number): Artic {
  const o = {} as Artic;
  for (const k of ARTIC_KEYS) o[k] = a[k] + (b[k] - a[k]) * t;
  return o;
}

/** Formant reference points for the map (ipa, F1, F2) for a body. */
export function targetFormants(body: Body): { ipa: string; f1: number; f2: number }[] {
  return VOWEL_TARGETS[body].map((r) => ({ ipa: r[0], f1: r[1], f2: r[2] }));
}
