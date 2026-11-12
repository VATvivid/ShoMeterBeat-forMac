import type { Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module } from "./types";
import { nearestVowel, VOWELS } from "./vowels";

// Phonetician orientation: F2 on x decreasing to the right (front vowels left),
// F1 on y increasing downward (close vowels top). Both axes log.
const F2_HI = 2600, F2_LO = 700;
const F1_LO = 220, F1_HI = 1000;
const F2_TICKS = [2500, 2000, 1500, 1000, 800];
const F1_TICKS = [300, 400, 500, 600, 800, 1000];
const TRAIL_S = 1.5;
const PAD = { l: 34, r: 10, t: 10, b: 22 };

/** F1–F2 vowel chart with reference vowels, the live formant marker and a fading trail. */
export class VowelMapModule implements Module {
  readonly id = "vowelmap";
  readonly title = "Vowel Map";
  private trail: { x: number; y: number; t: number }[] = [];
  private sx = 0; private sy = 0; private has = false;
  private age = 0;
  private time = 0;

  headReadout(f: Frame) {
    const n = f.voiced > 0.4 ? nearestVowel(f.f1, f.f2) : null;
    return n ? `[${n.v.ipa}]  F1 ${f.f1.toFixed(0)}  F2 ${f.f2.toFixed(0)}` : "—";
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    this.time += dt;
    const x0 = PAD.l, x1 = w - PAD.r, y0 = PAD.t, y1 = h - PAD.b;
    const pw = x1 - x0, ph = y1 - y0;
    if (pw < 40 || ph < 40) return;
    const lx = (v: number, lo: number, hi: number) => (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
    const xOf = (f2: number) => x0 + (1 - lx(Math.min(F2_HI, Math.max(F2_LO, f2)), F2_LO, F2_HI)) * pw;
    const yOf = (f1: number) => y0 + lx(Math.min(F1_HI, Math.max(F1_LO, f1)), F1_LO, F1_HI) * ph;

    // Grid + labels
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme("grid");
    ctx.fillStyle = theme("fg-1");
    ctx.font = font(10);
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    for (const t of F2_TICKS) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      ctx.fillText(t >= 1000 ? `${t / 1000}k` : `${t}`, x, y1 + 5);
    }
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (const t of F1_TICKS) {
      const y = Math.round(yOf(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillText(`${t}`, x0 - 4, y);
    }
    ctx.fillStyle = theme("fg-2");
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText("F1", 4, y0);
    ctx.textAlign = "right"; ctx.fillText("F2 Hz", x1, y1 + 5);

    // Vowel quadrilateral (i – æ – ɑ – u)
    const quad = ["i", "æ", "ɑ", "u"].map((p) => VOWELS.find((v) => v.ipa === p)!);
    ctx.strokeStyle = withAlpha(theme("sig-2"), 0.5);
    ctx.beginPath();
    quad.forEach((v, i) => { const x = xOf(v.f2), y = yOf(v.f1); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath(); ctx.stroke();

    // Live marker state
    const live = f.voiced > 0.4 && f.f1 > 0 && f.f2 > 0;
    const near = live ? nearestVowel(f.f1, f.f2) : null;
    if (live) {
      const tx = xOf(f.f2), ty = yOf(f.f1);
      if (!this.has) { this.sx = tx; this.sy = ty; this.has = true; }
      const k = Math.min(1, dt * 14);
      this.sx += (tx - this.sx) * k; this.sy += (ty - this.sy) * k;
      this.trail.push({ x: this.sx, y: this.sy, t: this.time });
      this.age = 0;
    } else {
      this.age += dt;
    }
    while (this.trail.length && this.time - this.trail[0].t > TRAIL_S) this.trail.shift();

    // Reference vowels
    ctx.font = font(13, 500);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const v of VOWELS) {
      const x = xOf(v.f2), y = yOf(v.f1);
      const hot = near?.v === v;
      ctx.fillStyle = hot ? theme("sig") : theme("fg-1");
      ctx.fillText(v.ipa, x, y);
      if (hot) {
        ctx.font = font(10);
        ctx.fillStyle = theme("fg-2");
        ctx.fillText(v.hint, x, y + 12);
        ctx.font = font(13, 500);
      }
    }

    // Trail
    if (this.trail.length > 1) {
      ctx.lineWidth = 1.5;
      for (let i = 1; i < this.trail.length; i++) {
        const a = this.trail[i - 1], b = this.trail[i];
        const alpha = Math.max(0, 1 - (this.time - b.t) / TRAIL_S) * 0.7;
        ctx.strokeStyle = withAlpha(theme("sig"), alpha);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.lineWidth = 1;
    }
    // Marker ring (fades out when unvoiced)
    if (this.has) {
      const alpha = live ? 1 : Math.max(0, 1 - this.age / 0.8);
      if (alpha > 0) {
        ctx.strokeStyle = withAlpha(theme("sig"), alpha);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(this.sx, this.sy, 8, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = withAlpha(theme("sig"), alpha * 0.25);
        ctx.beginPath(); ctx.arc(this.sx, this.sy, 8, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
}
