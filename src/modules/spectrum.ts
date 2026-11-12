import { freqToIndex, N_SPEC, pointFreq, SILENCE_DB, type Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import { ballistic, type DrawCtx, type Module } from "./types";

const DB_TOP = 0, DB_BOTTOM = -96;
const PAD_L = 34, PAD_B = 22, PAD_T = 8, PAD_R = 8;
const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const SLOPE_DB_PER_OCT = 4.5; // pink-noise tilt so music reads roughly flat

export class SpectrumModule implements Module {
  readonly id = "spectrum";
  readonly title = "Spectrum";
  private smooth = new Float32Array(N_SPEC).fill(SILENCE_DB);
  private hold = new Float32Array(N_SPEC).fill(SILENCE_DB);
  private holdAge = new Float32Array(N_SPEC);

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    const x0 = PAD_L, x1 = w - PAD_R, y0 = PAD_T, y1 = h - PAD_B;
    const pw = x1 - x0, ph = y1 - y0;
    if (pw < 20 || ph < 20) return;

    // Update ballistics (max of L/R, with slope).
    for (let i = 0; i < N_SPEC; i++) {
      const tilt = SLOPE_DB_PER_OCT * Math.log2(pointFreq(i) / 1000);
      const v = Math.max(f.specL[i], f.specR[i]) + tilt;
      this.smooth[i] = ballistic(this.smooth[i], v, dt, 60);
      if (v >= this.hold[i]) { this.hold[i] = v; this.holdAge[i] = 0; }
      else { this.holdAge[i] += dt; if (this.holdAge[i] > 1.0) this.hold[i] = ballistic(this.hold[i], v, dt, 24); }
    }

    const yOf = (db: number) => y0 + ((DB_TOP - Math.min(DB_TOP, Math.max(DB_BOTTOM, db))) / (DB_TOP - DB_BOTTOM)) * ph;
    const xOf = (i: number) => x0 + (i / (N_SPEC - 1)) * pw;

    // Grid
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme("grid");
    ctx.fillStyle = theme("fg-1");
    ctx.font = font(10);
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (let db = DB_TOP; db >= DB_BOTTOM; db -= 12) {
      const y = Math.round(yOf(db)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillText(db.toString(), x0 - 4, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const hz of FREQ_TICKS) {
      const x = Math.round(xOf(freqToIndex(hz))) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, x, y1 + 5);
    }

    // Fill + line
    const sig = theme("sig");
    const grad = ctx.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, withAlpha(sig, 0.45));
    grad.addColorStop(1, withAlpha(sig, 0));
    ctx.beginPath();
    ctx.moveTo(xOf(0), y1);
    for (let i = 0; i < N_SPEC; i++) ctx.lineTo(xOf(i), yOf(this.smooth[i]));
    ctx.lineTo(xOf(N_SPEC - 1), y1);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < N_SPEC; i++) { const x = xOf(i), y = yOf(this.smooth[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.strokeStyle = sig;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();

    // Peak hold
    ctx.beginPath();
    for (let i = 0; i < N_SPEC; i++) { const x = xOf(i), y = yOf(this.hold[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.strokeStyle = withAlpha(theme("peak"), 0.8);
    ctx.lineWidth = 1;
    ctx.stroke();

    // Units
    ctx.fillStyle = theme("fg-2");
    ctx.font = font(10);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("dB", 4, y0);
    ctx.textAlign = "right";
    ctx.fillText("Hz", x1, y1 + 5);
  }
}
