import { N_SCOPE, type Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module } from "./types";

const SHOW = 512; // samples drawn after the trigger point

/** Oscilloscope with a rising-zero-crossing trigger on the left channel so a
 *  periodic signal stays still. */
export class ScopeModule implements Module {
  readonly id = "scope";
  readonly title = "Oscilloscope";

  private trigger(x: Float32Array): number {
    const limit = N_SCOPE - SHOW;
    for (let i = 1; i < limit; i++) if (x[i - 1] < 0 && x[i] >= 0) return i;
    return 0;
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h } = d;
    const mid = h / 2;
    ctx.strokeStyle = theme("grid");
    ctx.lineWidth = 1;
    for (const k of [0.25, 0.5, 0.75]) {
      const y = Math.round(h * k) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    const start = this.trigger(f.scopeL);
    const amp = h * 0.46;
    const trace = (buf: Float32Array, color: string, width: number) => {
      ctx.beginPath();
      for (let i = 0; i < SHOW; i++) {
        const x = (i / (SHOW - 1)) * w;
        const y = mid - Math.max(-1, Math.min(1, buf[start + i])) * amp;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.stroke();
    };
    trace(f.scopeR, withAlpha(theme("sig-2"), 0.9), 1);
    trace(f.scopeL, theme("sig"), 1.25);

    ctx.fillStyle = theme("fg-2");
    ctx.font = font(10);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const ms = ((SHOW / (f.sampleRate || 48000)) * 1000).toFixed(1);
    ctx.fillText(`${ms} ms`, 4, 3);
  }
}
