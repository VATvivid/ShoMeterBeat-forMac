import { freqToIndex, N_SPEC, type Frame } from "../engine/frame";
import { colorMap, font, theme } from "../theme";
import type { DrawCtx, Module } from "./types";

const DB_TOP = 0, DB_BOTTOM = -96;
const PAD_L = 34;
const FREQ_TICKS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

/** Scrolling spectrogram. Time runs left→right (newest at the right edge),
 *  frequency bottom→top on the same log scale as the spectrum module. */
export class SpectrogramModule implements Module {
  readonly id = "spectrogram";
  readonly title = "Spectrogram";
  private buf = document.createElement("canvas");
  private bctx = this.buf.getContext("2d")!;
  private col = new ImageData(1, N_SPEC);
  private map = colorMap();
  private lastSeq = -1;

  constructor() {
    this.buf.width = 1;
    this.buf.height = N_SPEC;
  }

  resize(w: number) {
    const pw = Math.max(1, Math.floor(w - PAD_L));
    if (pw !== this.buf.width) {
      const old = this.buf;
      const nb = document.createElement("canvas");
      nb.width = pw; nb.height = N_SPEC;
      const c = nb.getContext("2d")!;
      c.fillStyle = theme("map-0");
      c.fillRect(0, 0, pw, N_SPEC);
      c.drawImage(old, pw - old.width, 0);
      this.buf = nb;
      this.bctx = c;
    }
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h } = d;
    this.resize(w);
    const pw = this.buf.width;

    if (f.seq !== this.lastSeq) {
      this.lastSeq = f.seq;
      // Shift left by one column, then paint the newest column at the right.
      this.bctx.drawImage(this.buf, 1, 0, pw - 1, N_SPEC, 0, 0, pw - 1, N_SPEC);
      const px = this.col.data;
      for (let i = 0; i < N_SPEC; i++) {
        const v = Math.max(f.specL[i], f.specR[i]);
        const t = Math.min(1, Math.max(0, (v - DB_BOTTOM) / (DB_TOP - DB_BOTTOM)));
        const k = Math.round(t * 255) * 3;
        const row = N_SPEC - 1 - i; // low freq at the bottom
        px[row * 4] = this.map[k]; px[row * 4 + 1] = this.map[k + 1]; px[row * 4 + 2] = this.map[k + 2]; px[row * 4 + 3] = 255;
      }
      this.bctx.putImageData(this.col, pw - 1, 0);
    }

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.buf, PAD_L, 0, pw, h);

    // Frequency labels (left gutter)
    ctx.fillStyle = theme("fg-1");
    ctx.font = font(10);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = theme("line");
    for (const hz of FREQ_TICKS) {
      const y = h - (freqToIndex(hz) / (N_SPEC - 1)) * h;
      if (y < 7 || y > h - 7) continue;
      ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, PAD_L - 5, y);
      ctx.beginPath(); ctx.moveTo(PAD_L - 2, Math.round(y) + 0.5); ctx.lineTo(PAD_L, Math.round(y) + 0.5); ctx.stroke();
    }
  }
}
