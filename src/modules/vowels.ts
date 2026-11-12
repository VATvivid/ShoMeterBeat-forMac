// Shared vowel reference data for the Vowel Map and Vocal Tract modules.
// Average formants of American English vowels (Peterson & Barney 1952, public data),
// per speaker group. Values in Hz.
import { modSetting, setModSetting } from "../state";

export interface VowelRef { ipa: string; f1: number; f2: number; hint: string }
export type VoiceType = "male" | "female" | "child";

const HINTS: Record<string, string> = { i: "beat", "ɪ": "bit", "ɛ": "bet", "æ": "bat", "ɑ": "father", "ɔ": "bought", "ʊ": "book", u: "boot", "ʌ": "but", "ɝ": "bird" };
const ORDER = ["i", "ɪ", "ɛ", "æ", "ɑ", "ɔ", "ʊ", "u", "ʌ", "ɝ"];
const TABLE: Record<VoiceType, [number, number][]> = {
  // [F1, F2] in ORDER
  male:   [[270, 2290], [390, 1990], [530, 1840], [660, 1720], [730, 1090], [570, 840], [440, 1020], [300, 870], [640, 1190], [490, 1350]],
  female: [[310, 2790], [430, 2480], [610, 2330], [860, 2050], [850, 1220], [590, 920], [470, 1160], [370, 950], [760, 1400], [500, 1640]],
  child:  [[370, 3200], [530, 2730], [690, 2610], [1010, 2320], [1030, 1370], [680, 1060], [560, 1410], [430, 1170], [850, 1590], [560, 1820]],
};

/** Axis ranges per voice type (log scales): [F1 lo, F1 hi, F2 lo, F2 hi]. */
export const RANGES: Record<VoiceType, [number, number, number, number]> = {
  male: [220, 1000, 700, 2600],
  female: [250, 1200, 800, 3200],
  child: [300, 1400, 900, 3700],
};

export const VOICE_LABELS: Record<VoiceType, string> = { male: "남성", female: "여성", child: "아동" };

/** Shared setting (stored under the vowelmap module so both modules agree). */
export function voiceType(): VoiceType {
  return modSetting<VoiceType>("vowelmap", "voice", "male");
}
export function setVoiceType(v: VoiceType) {
  setModSetting("vowelmap", "voice", v);
}

export function vowels(type: VoiceType = voiceType()): VowelRef[] {
  return TABLE[type].map(([f1, f2], i) => ({ ipa: ORDER[i], f1, f2, hint: HINTS[ORDER[i]] }));
}

/** Perceptual-ish distance in log-formant space, F1 weighted more than F2. */
export function vowelDistance(f1: number, f2: number, v: VowelRef): number {
  const a = 2.2 * Math.log(f1 / v.f1);
  const b = Math.log(f2 / v.f2);
  return Math.hypot(a, b);
}

export function nearestVowel(f1: number, f2: number, type: VoiceType = voiceType()): { v: VowelRef; d: number } | null {
  if (!(f1 > 0) || !(f2 > 0)) return null;
  let best: VowelRef | null = null, bd = Infinity;
  for (const v of vowels(type)) {
    const d = vowelDistance(f1, f2, v);
    if (d < bd) { bd = d; best = v; }
  }
  return best ? { v: best, d: bd } : null;
}

/** 0..1 tongue height (close=1) and frontness (front=1) from F1/F2 on log scales,
 *  normalised to the current voice type's range. */
export function tongueFromFormants(f1: number, f2: number, type: VoiceType = voiceType()): { height: number; front: number } {
  const [f1lo, f1hi, f2lo, f2hi] = RANGES[type];
  const n = (v: number, lo: number, hi: number) => Math.min(1, Math.max(0, (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))));
  return { height: 1 - n(f1, f1lo * 1.1, f1hi * 0.9), front: n(f2, f2lo * 1.1, f2hi * 0.9) };
}

/** Small median filter for jittery formant tracks. */
export class Median {
  private buf: number[] = [];
  constructor(private size = 5) {}
  push(v: number): number {
    this.buf.push(v);
    if (this.buf.length > this.size) this.buf.shift();
    const s = [...this.buf].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
  reset() { this.buf = []; }
}
