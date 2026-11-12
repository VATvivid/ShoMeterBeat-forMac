import { N_LISSA, type Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module } from "./types";

const BAR_H = 26;

/** Lissajous (vectorscope, rotated 45° so mono is vertical) + correlation bar. */
export class StereoModule implements Module {
  readonly id = "stereo";
  readonly title = "Stereo";
  private trail = document.createElement("canvas");
  private tctx = this.trail.getContext("2d")!;
  private corr = 0;

  headReadout(f: Frame) {
    return `corr ${f.correlation >= 0 ? "+" : "−"}${Math.abs(f.correlation).toFixed(2)}`;
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    const areaH = h - BAR_H;
    const size = Math.max(10, Math.min(w, areaH) - 12);
    const cx = w / 2, cy = areaH / 2;
    const dpr = window.devicePixelRatio || 1;
    const tw = Math.round(w * dpr), th = Math.round(areaH * dpr);
    if (this.trail.width !== tw || this.trail.height !== th) {
      this.trail.width = tw; this.trail.height = th;
    }
    const t = this.tctx;
    t.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Fade the previous trail.
    t.globalCompositeOperation = "destination-out";
    t.fillStyle = `rgba(0,0,0,${Math.min(1, dt * 8)})`;
    t.fillRect(0, 0, w, areaH);
    t.globalCompositeOperation = "source-over";
    // Plot new points: x = (L−R)/√2, y = (L+R)/√2.
    t.fillStyle = withAlpha(theme("sig"), 0.55);
    const r = size / 2;
    for (let i = 0; i < N_LISSA; i++) {
      const l = f.lissa[2 * i], rr = f.lissa[2 * i + 1];
      const x = cx + ((l - rr) / Math.SQRT2) * r;
      const y = cy - ((l + rr) / Math.SQRT2) * r;
      t.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }

    // Guides
    ctx.strokeStyle = theme("grid");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);
    ctx.moveTo(cx + r, cy + r); ctx.lineTo(cx - r, cy - r);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.stroke();
    ctx.fillStyle = theme("fg-2");
    ctx.font = font(10);
    ctx.textBaseline = "top";
    ctx.textAlign = "left"; ctx.fillText("L", cx - r + 2, cy - r + 2);
    ctx.textAlign = "right"; ctx.fillText("R", cx + r - 2, cy - r + 2);

    ctx.drawImage(this.trail, 0, 0, w, areaH);

    // Correlation bar
    this.corr += (f.correlation - this.corr) * Math.min(1, dt * 10);
    const by = h - BAR_H + 8, bh = 8, bx0 = 24, bx1 = w - 24, bw = bx1 - bx0, mid = bx0 + bw / 2;
    ctx.fillStyle = theme("bg-3");
    ctx.fillRect(bx0, by, bw, bh);
    const px = (this.corr * bw) / 2;
    ctx.fillStyle = this.corr >= 0 ? theme("sig") : theme("clip");
    if (px >= 0) ctx.fillRect(mid, by, px, bh); else ctx.fillRect(mid + px, by, -px, bh);
    ctx.fillStyle = theme("fg-1");
    ctx.font = font(10);
    ctx.textBaseline = "middle";
    ctx.textAlign = "right"; ctx.fillText("−1", bx0 - 4, by + bh / 2);
    ctx.textAlign = "left"; ctx.fillText("+1", bx1 + 4, by + bh / 2);
    ctx.strokeStyle = theme("fg-2");
    ctx.beginPath(); ctx.moveTo(Math.round(mid) + 0.5, by - 2); ctx.lineTo(Math.round(mid) + 0.5, by + bh + 2); ctx.stroke();
  }
}
