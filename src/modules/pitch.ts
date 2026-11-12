import type { Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

// Melodyne-style note blocks: time runs left→right (newest at the right edge),
// pitch on a semitone grid with piano keys. Consecutive frames on the same
// semitone merge into one block; the exact pitch is drawn as a curve through it.

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
  private conf: Float32Array;          // 0..1
  private len = 0;                     // valid samples (≤ capacity)
  private acc = 0;
  private center = 60;                 // smoothed window centre (midi)
  private lastMidi = NaN;

  constructor() {
    const cap = 30 * RATE;
    this.hist = new Float32Array(cap).fill(NaN);
    this.conf = new Float32Array(cap);
  }

  private get seconds() { return modSetting(this.id, "seconds", 10); }
  private get octaves() { return modSetting(this.id, "octaves", 2); }
  private get showCurve() { return modSetting(this.id, "curve", true); }
  private get minConf() { return modSetting(this.id, "minConf", 0.35); }

  settings(): SettingItem[] {
    return [
      { type: "select", label: "시간 범위", value: String(this.seconds), options: [5, 10, 20, 30].map((v) => ({ value: String(v), label: `${v}초` })), onChange: (v) => setModSetting(this.id, "seconds", Number(v)) },
      { type: "select", label: "음역 폭", value: String(this.octaves), options: [1, 2, 3].map((v) => ({ value: String(v), label: `${v}옥타브` })), onChange: (v) => setModSetting(this.id, "octaves", Number(v)) },
      { type: "range", label: "감도 (유성음 문턱)", value: this.minConf, min: 0.1, max: 0.8, step: 0.05, format: (v) => v.toFixed(2), onChange: (v) => setModSetting(this.id, "minConf", v) },
      { type: "toggle", label: "피치 곡선", value: this.showCurve, onChange: (v) => setModSetting(this.id, "curve", v) },
      { type: "action", label: "기록 지우기", onClick: () => { this.hist.fill(NaN); this.conf.fill(0); this.len = 0; } },
    ];
  }

  headReadout(f: Frame) {
    if (!(f.voiced >= this.minConf) || !(f.f0 > 0)) return "—";
    const m = hzToMidi(f.f0);
    const cents = Math.round((m - Math.round(m)) * 100);
    return `${noteName(m)}  ${cents >= 0 ? "+" : ""}${cents}¢  ${f.f0.toFixed(1)} Hz`;
  }

  private push(midi: number, conf: number) {
    this.hist.copyWithin(0, 1); this.hist[this.hist.length - 1] = midi;
    this.conf.copyWithin(0, 1); this.conf[this.conf.length - 1] = conf;
    this.len = Math.min(this.hist.length, this.len + 1);
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    // ---- sample at RATE
    this.acc += dt;
    const live = f.voiced >= this.minConf && f.f0 > 0;
    const midi = live ? hzToMidi(f.f0) : NaN;
    while (this.acc >= 1 / RATE) {
      this.acc -= 1 / RATE;
      this.push(midi, live ? f.voiced : 0);
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
    while (i < n) {
      const m = this.hist[start + i];
      if (Number.isNaN(m)) { i++; continue; }
      const note = Math.round(m);
      let j = i, csum = 0;
      while (j < n && !Number.isNaN(this.hist[start + j]) && Math.round(this.hist[start + j]) === note) { csum += this.conf[start + j]; j++; }
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
      ctx.fillText("unvoiced", x1 - 2, y0 + 2);
    }
  }
}
