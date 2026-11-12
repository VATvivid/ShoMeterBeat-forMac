import type { Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import { ballistic, fmtDb, type DrawCtx, type Module } from "./types";

const DB_TOP = 0, DB_BOTTOM = -60;
const CLIP_DB = -0.1;
const HOLD_S = 1.5;

/** Peak + RMS bars per channel with peak hold and clip indicators. */
export class LevelsModule implements Module {
  readonly id = "levels";
  readonly title = "Levels";
  private peak = [-120, -120];
  private rms = [-120, -120];
  private hold = [-120, -120];
  private holdAge = [0, 0];
  private clip = [false, false];

  headReadout(f: Frame) {
    return `L ${fmtDb(f.peak[0])}  R ${fmtDb(f.peak[1])}`;
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    for (let c = 0; c < 2; c++) {
      this.peak[c] = ballistic(this.peak[c], f.peak[c], dt, 30);
      this.rms[c] = ballistic(this.rms[c], f.rms[c], dt, 20);
      if (f.peak[c] >= this.hold[c]) { this.hold[c] = f.peak[c]; this.holdAge[c] = 0; }
      else { this.holdAge[c] += dt; if (this.holdAge[c] > HOLD_S) this.hold[c] = ballistic(this.hold[c], f.peak[c], dt, 30); }
      if (f.peak[c] >= CLIP_DB) this.clip[c] = true;
    }

    const padT = 14, padB = 34, padL = 28;
    const y0 = padT, y1 = h - padB, ph = y1 - y0;
    if (ph < 20) return;
    const yOf = (db: number) => y0 + ((DB_TOP - Math.min(DB_TOP, Math.max(DB_BOTTOM, db))) / (DB_TOP - DB_BOTTOM)) * ph;
    const barW = 10, gap = 8;
    const totalW = barW * 2 + gap;
    const x0 = padL + Math.max(0, (w - padL - totalW) / 2);

    // Scale
    ctx.font = font(10);
    ctx.fillStyle = theme("fg-1");
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = theme("grid");
    for (let db = DB_TOP; db >= DB_BOTTOM; db -= 6) {
      const y = Math.round(yOf(db)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x0 - 4, y); ctx.lineTo(x0 + totalW + 4, y); ctx.stroke();
      if (db % 12 === 0) ctx.fillText(`${db}`, x0 - 7, y);
    }

    for (let c = 0; c < 2; c++) {
      const x = x0 + c * (barW + gap);
      ctx.fillStyle = theme("bg-3");
      ctx.fillRect(x, y0, barW, ph);
      // RMS
      const yr = yOf(this.rms[c]);
      ctx.fillStyle = withAlpha(theme("sig"), 0.7);
      ctx.fillRect(x, yr, barW, y1 - yr);
      // Peak (thin inner bar)
      const yp = yOf(this.peak[c]);
      ctx.fillStyle = theme("sig");
      ctx.fillRect(x + 3, yp, barW - 6, y1 - yp);
      // Hot zone above -3 dB
      if (this.peak[c] > -3) {
        ctx.fillStyle = theme("clip");
        ctx.fillRect(x + 3, yp, barW - 6, yOf(-3) - yp);
      }
      // Hold line
      const yh = Math.round(yOf(this.hold[c])) + 0.5;
      ctx.strokeStyle = theme("peak");
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, yh); ctx.lineTo(x + barW, yh); ctx.stroke();
      ctx.lineWidth = 1;
      // Clip indicator
      ctx.fillStyle = this.clip[c] ? theme("clip") : theme("bg-3");
      ctx.fillRect(x, y0 - 10, barW, 6);
      // Labels
      ctx.fillStyle = theme("fg-1");
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(c ? "R" : "L", x + barW / 2, y1 + 4);
      ctx.fillStyle = theme("fg-0");
      ctx.font = font(11, 500);
      ctx.fillText(fmtDb(this.hold[c]), x + barW / 2, y1 + 16);
      ctx.font = font(10);
    }
  }
}
