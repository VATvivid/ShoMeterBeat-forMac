import { freqToIndex, pointFreq, type Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

// Melodyne-style note blocks: time runs left→right (newest at the right edge),
// pitch on a semitone grid with piano keys. Consecutive frames on the same
// semitone merge into one block; the exact pitch is drawn as a curve through it.
//
// Two modes (right-click → 모드):
//   음성   — the engine's voice tracker (autocorrelation f0 gated by voicing), 60–1000 Hz.
//   효과음 — the strongest spectral peak of the live spectrum (parabolic interpolation on
//            the log-spaced points) gated by tonality: the peak must stand ≥ 12 dB over the
//            spectrum's median and the spectral flatness must be low. Follows sweeps, hits
//            with a tonal body, UI blips and drones that the voice tracker rejects.

const RATE = 50;            // history samples per second
const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);
const KEY_W = 30;

const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);
const noteName = (m: number) => `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

export class PitchModule implements Module {
  readonly id = "pitch";
  readonly title = "Pitch";
  private hist: Float32Array;          // midi or NaN
  private note: Float32Array;          // block note (hysteresis) or NaN
  private conf: Float32Array;          // 0..1
  private len = 0;                     // valid samples (≤ capacity)
  private acc = 0;
  private center = 60;                 // smoothed window centre (midi)
  private lastMidi = NaN;
  private curNote = NaN;               // note with hysteresis (±0.6 st before switching)

  constructor() {
    const cap = 30 * RATE;
    this.hist = new Float32Array(cap).fill(NaN);
    this.note = new Float32Array(cap).fill(NaN);
    this.conf = new Float32Array(cap);
  }

  private get seconds() { return modSetting(this.id, "seconds", 10); }
  private get octaves() { return modSetting(this.id, "octaves", 2); }
  private get showCurve() { return modSetting(this.id, "curve", true); }
  private get minConf() { return modSetting(this.id, "minConf", 0.35); }
  private get mode() { return modSetting(this.id, "mode", "voice") as "voice" | "sfx"; }
  private get sfxFlat() { return modSetting(this.id, "sfxFlat", 0.35); }

  /** Pitch estimate for the current frame according to the mode: Hz (0 = none) and 0…1 confidence. */
  private estimate(f: Frame): { hz: number; conf: number } {
    if (this.mode === "voice") return f.voiced >= this.minConf && f.f0 > 0 ? { hz: f.f0, conf: f.voiced } : { hz: 0, conf: 0 };
    // 효과음: strongest spectral peak 30 Hz … 10 kHz with parabolic refinement
    const spec = f.specL;
    const i0 = Math.max(1, Math.ceil(freqToIndex(30))), i1 = Math.min(spec.length - 2, Math.floor(freqToIndex(10000)));
    let bi = -1, bv = -Infinity;
    for (let i = i0; i <= i1; i++) if (spec[i] > bv && spec[i] >= spec[i - 1] && spec[i] >= spec[i + 1]) { bv = spec[i]; bi = i; }
    if (bi < 0 || bv < -70) return { hz: 0, conf: 0 };
    const vals = Array.from(spec.subarray(i0, i1 + 1)).sort((a, b) => a - b);
    const med = vals[vals.length >> 1];
    const prominence = bv - med;
    if (prominence < 12 || f.flatness > this.sfxFlat) return { hz: 0, conf: 0 };
    const y0 = spec[bi - 1], y1 = spec[bi], y2 = spec[bi + 1];
    const den = y0 - 2 * y1 + y2;
    const delta = Math.abs(den) > 1e-6 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den)) : 0;
    const hz = pointFreq(bi + delta);
    return { hz, conf: Math.max(0, Math.min(1, (prominence - 12) / 18)) * (1 - f.flatness / this.sfxFlat * 0.5) };
  }

  settings(): SettingItem[] {
    return [
      { type: "select", label: "모드", value: this.mode, options: [{ value: "voice", label: "음성 전용 (유성음 f0)" }, { value: "sfx", label: "효과음 전용 (스펙트럼 피크 · 톤 문턱)" }], onChange: (v) => { setModSetting(this.id, "mode", v); this.hist.fill(NaN); this.note.fill(NaN); this.conf.fill(0); this.len = 0; } },
      { type: "select", label: "시간 범위", value: String(this.seconds), options: [5, 10, 20, 30].map((v) => ({ value: String(v), label: `${v}초` })), onChange: (v) => setModSetting(this.id, "seconds", Number(v)) },
      { type: "select", label: "음역 폭", value: String(this.octaves), options: [1, 2, 3].map((v) => ({ value: String(v), label: `${v}옥타브` })), onChange: (v) => setModSetting(this.id, "octaves", Number(v)) },
      { type: "range", label: "감도 (유성음 문턱 · 음성 모드)", value: this.minConf, min: 0.1, max: 0.8, step: 0.05, format: (v) => v.toFixed(2), onChange: (v) => setModSetting(this.id, "minConf", v) },
      { type: "range", label: "톤 문턱 (평탄도 · 효과음 모드)", value: this.sfxFlat, min: 0.1, max: 0.7, step: 0.05, format: (v) => v.toFixed(2), onChange: (v) => setModSetting(this.id, "sfxFlat", v) },
      { type: "toggle", label: "피치 곡선", value: this.showCurve, onChange: (v) => setModSetting(this.id, "curve", v) },
      { type: "action", label: "기록 지우기", onClick: () => { this.hist.fill(NaN); this.note.fill(NaN); this.conf.fill(0); this.len = 0; } },
    ];
  }

  headReadout(f: Frame) {
    const e = this.estimate(f);
    const tag = this.mode === "sfx" ? "SFX · " : "";
    if (!(e.hz > 0)) return `${tag}—`;
    const m = hzToMidi(e.hz);
    const cents = Math.round((m - Math.round(m)) * 100);
    return `${tag}${noteName(m)}  ${cents >= 0 ? "+" : ""}${cents}¢  ${e.hz.toFixed(1)} Hz`;
  }

  private push(midi: number, conf: number) {
    // Store the exact pitch for the curve, but decide the block note with hysteresis so
    // a pitch wobbling around a semitone boundary doesn't flicker between two blocks.
    if (Number.isNaN(midi)) this.curNote = NaN;
    else if (Number.isNaN(this.curNote) || Math.abs(midi - this.curNote) > 0.6) this.curNote = Math.round(midi);
    this.hist.copyWithin(0, 1); this.hist[this.hist.length - 1] = midi;
    this.note.copyWithin(0, 1); this.note[this.note.length - 1] = this.curNote;
    this.conf.copyWithin(0, 1); this.conf[this.conf.length - 1] = conf;
    this.len = Math.min(this.hist.length, this.len + 1);
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    // ---- sample at RATE
    this.acc += dt;
    const est = this.estimate(f);
    const live = est.hz > 0;
    const midi = live ? hzToMidi(est.hz) : NaN;
    while (this.acc >= 1 / RATE) {
      this.acc -= 1 / RATE;
      this.push(midi, live ? est.conf : 0);
    }
    if (live) {
      this.lastMidi = midi;
      // Window centre follows the voice slowly so blocks stay in view.
      this.center += (midi - this.center) * Math.min(1, dt * 1.5);
    }

    // ---- geometry
    const n = Math.min(this.len, Math.round(this.seconds * RATE));
    const total = Math.round(this.seconds * RATE);
    const span = this.octaves * 12;
    const top = Math.round(this.center + span / 2), bottom = top - span;
    const x0 = KEY_W, x1 = w - 4, y0 = 4, y1 = h - 4;
    const pw = x1 - x0, ph = y1 - y0;
    if (pw < 20 || ph < 20) return;
    const rowH = ph / span;
    const yOf = (m: number) => y0 + (top - m) * rowH;        // midi (continuous) → y (note centre at m)
    const xOf = (i: number) => x1 - ((n - 1 - i) / (total - 1)) * pw; // i = index in the last n samples

    // ---- piano keys + rows
    ctx.font = font(10);
    ctx.textBaseline = "middle";
    for (let m = bottom; m < top; m++) {
      const y = yOf(m + 1), hh = rowH;
      const pc = ((m % 12) + 12) % 12;
      const black = BLACK.has(pc);
      ctx.fillStyle = black ? withAlpha(theme("bg-0"), 0.6) : "transparent";
      if (black) ctx.fillRect(x0, y, pw, hh);
      ctx.fillStyle = black ? theme("bg-0") : theme("fg-2");
      ctx.fillRect(0, y, KEY_W - 4, hh - 1);
      if (pc === 0 && rowH >= 9) {
        ctx.fillStyle = theme("fg-0");
        ctx.textAlign = "right";
        ctx.fillText(noteName(m), KEY_W - 8, y + hh / 2);
      }
      if (pc === 0) {
        ctx.strokeStyle = theme("line");
        ctx.beginPath(); ctx.moveTo(x0, Math.round(y + hh) + 0.5); ctx.lineTo(x1, Math.round(y + hh) + 0.5); ctx.stroke();
      }
    }

    // ---- note blocks
    const start = this.hist.length - n;
    const sig = theme("sig");
    let i = 0;
    const MIN_LEN = 3; // blocks shorter than 60 ms are blips — curve only, no block
    while (i < n) {
      const note = this.note[start + i];
      if (Number.isNaN(note)) { i++; continue; }
      let j = i, csum = 0;
      while (j < n && this.note[start + j] === note) { csum += this.conf[start + j]; j++; }
      if (j - i < MIN_LEN) { i = j; continue; }
      const c = csum / (j - i);
      const bx0 = xOf(i), bx1 = xOf(j - 1) + pw / (total - 1);
      const by = yOf(note + 0.5);
      if (note >= bottom - 1 && note <= top + 1) {
        ctx.fillStyle = withAlpha(sig, 0.25 + 0.55 * c);
        ctx.fillRect(bx0, by + 1, Math.max(1.5, bx1 - bx0), Math.max(1, rowH - 2));
        if (j - i >= RATE * 0.25 && rowH >= 9 && bx1 - bx0 > 22) {
          ctx.fillStyle = theme("bg-0");
          ctx.font = font(10, 600);
          ctx.textAlign = "left";
          ctx.fillText(noteName(note), bx0 + 3, by + rowH / 2);
        }
      }
      i = j;
    }

    // ---- exact pitch curve
    if (this.showCurve) {
      ctx.strokeStyle = theme("peak");
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k < n; k++) {
        const m = this.hist[start + k];
        if (Number.isNaN(m)) { pen = false; continue; }
        const x = xOf(k), y = yOf(m);
        if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // ---- now line + current note marker
    ctx.strokeStyle = withAlpha(theme("fg-1"), 0.5);
    ctx.beginPath(); ctx.moveTo(x1 + 0.5, y0); ctx.lineTo(x1 + 0.5, y1); ctx.stroke();
    if (live) {
      const y = yOf(midi);
      ctx.fillStyle = theme("peak");
      ctx.beginPath(); ctx.arc(x1, y, 3, 0, Math.PI * 2); ctx.fill();
    } else if (!Number.isNaN(this.lastMidi)) {
      ctx.fillStyle = theme("fg-2");
      ctx.font = font(10);
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText(this.mode === "sfx" ? "no tone" : "unvoiced", x1 - 2, y0 + 2);
    }
  }
}
