// Shared vowel reference data for the Vowel Map and Vocal Tract modules.
// Average formants of American English vowels, adult male speakers
// (Peterson & Barney 1952, public data). Values in Hz.
export interface VowelRef { ipa: string; f1: number; f2: number; hint: string }

export const VOWELS: VowelRef[] = [
  { ipa: "i", f1: 270, f2: 2290, hint: "beat" },
  { ipa: "ɪ", f1: 390, f2: 1990, hint: "bit" },
  { ipa: "ɛ", f1: 530, f2: 1840, hint: "bet" },
  { ipa: "æ", f1: 660, f2: 1720, hint: "bat" },
  { ipa: "ɑ", f1: 730, f2: 1090, hint: "father" },
  { ipa: "ɔ", f1: 570, f2: 840, hint: "bought" },
  { ipa: "ʊ", f1: 440, f2: 1020, hint: "book" },
  { ipa: "u", f1: 300, f2: 870, hint: "boot" },
  { ipa: "ʌ", f1: 640, f2: 1190, hint: "but" },
  { ipa: "ɝ", f1: 490, f2: 1350, hint: "bird" },
];

/** Perceptual-ish distance in log-formant space, F1 weighted more than F2. */
export function vowelDistance(f1: number, f2: number, v: VowelRef): number {
  const a = 2.2 * Math.log(f1 / v.f1);
  const b = Math.log(f2 / v.f2);
  return Math.hypot(a, b);
}

export function nearestVowel(f1: number, f2: number): { v: VowelRef; d: number } | null {
  if (!(f1 > 0) || !(f2 > 0)) return null;
  let best: VowelRef | null = null, bd = Infinity;
  for (const v of VOWELS) {
    const d = vowelDistance(f1, f2, v);
    if (d < bd) { bd = d; best = v; }
  }
  return best ? { v: best, d: bd } : null;
}

/** 0..1 tongue height (close=1) and frontness (front=1) from F1/F2 on log scales. */
export function tongueFromFormants(f1: number, f2: number): { height: number; front: number } {
  const n = (v: number, lo: number, hi: number) => Math.min(1, Math.max(0, (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))));
  return { height: 1 - n(f1, 250, 900), front: n(f2, 800, 2400) };
}
