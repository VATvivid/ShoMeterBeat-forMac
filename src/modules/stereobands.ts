import { BAND_LABELS, N_BANDS, type Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

// Per-band stereo image: correlation (−1…+1) and width (side energy share, 0 mono …
// 0.5 uncorrelated … 1 anti-phase) for low / low-mid / mid / high. The low band is
// flagged when its correlation drops below the mono-compatibility threshold.

export class StereoBandsModule implements Module {
  readonly id = "stereobands";
  readonly title = "Stereo Bands";
  private corr = new Float32Array(N_BANDS);
  private width = new Float32Array(N_BANDS);
  private warn = 0;

  private get lowWarn() { return modSetting(this.id, "lowWarn", 0.3); }

  settings(): SettingItem[] {
    return [
      { type: "range", label: "저역 경고 상관 문턱", value: this.lowWarn, min: -0.5, max: 0.8, step: 0.05, format: (v) => v.toFixed(2), onChange: (v) => setModSetting(this.id, "lowWarn", v) },
    ];
  }

  headReadout(f: Frame) {
    return `low ${f.bands[0] >= 0 ? "+" : "−"}${Math.abs(f.bands[0]).toFixed(2)}  high ${f.bands[6] >= 0 ? "+" : "−"}${Math.abs(f.bands[6]).toFixed(2)}`;
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    const k = Math.min(1, dt * 8);
    for (let b = 0; b < N_BANDS; b++) {
      this.corr[b] += (f.bands[2 * b] - this.corr[b]) * k;
      this.width[b] += (f.bands[2 * b + 1] - this.width[b]) * k;
    }
    const lowBad = this.corr[0] < this.lowWarn && f.rms[0] > -60;
    this.warn += ((lowBad ? 1 : 0) - this.warn) * Math.min(1, dt * 4);

    const padL = 8, padR = 8, padT = 6, padB = 6;
    const rowH = (h - padT - padB) / N_BANDS;
    const labelW = w < 220 ? 0 : 92;
    const x0 = padL + labelW, x1 = w - padR, bw = x1 - x0;
    if (bw < 40 || rowH < 14) return;
    const mid = x0 + bw / 2;
    for (let b = 0; b < N_BANDS; b++) {
      const y = padT + b * rowH;
      const barY = y + rowH * 0.22, barH = Math.max(4, rowH * 0.3);
      const widY = barY + barH + 3, widH = Math.max(2, rowH * 0.14);
      // label
      if (labelW) {
        ctx.fillStyle = theme("fg-1"); ctx.font = font(10, 600); ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(BAND_LABELS[b].toUpperCase(), padL, barY + barH / 2);
      }
      // correlation bar from centre
      ctx.fillStyle = theme("bg-3"); ctx.fillRect(x0, barY, bw, barH);
      const c = this.corr[b];
      const px = (c * bw) / 2;
      const bad = b === 0 && lowBad;
      ctx.fillStyle = bad ? theme("clip") : c >= 0 ? theme("sig") : theme("clip");
      if (px >= 0) ctx.fillRect(mid, barY, px, barH); else ctx.fillRect(mid + px, barY, -px, barH);
      ctx.strokeStyle = theme("fg-2"); ctx.beginPath(); ctx.moveTo(Math.round(mid) + 0.5, barY - 2); ctx.lineTo(Math.round(mid) + 0.5, barY + barH + 2); ctx.stroke();
      // width bar (left→right)
      ctx.fillStyle = theme("bg-3"); ctx.fillRect(x0, widY, bw, widH);
      ctx.fillStyle = withAlpha(theme("sig-2"), 0.9); ctx.fillRect(x0, widY, bw * Math.min(1, this.width[b]), widH);
      // numbers
      ctx.fillStyle = theme("fg-0"); ctx.font = font(10); ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(`${c >= 0 ? "+" : "−"}${Math.abs(c).toFixed(2)}`, x1 - 2, barY + barH / 2);
      ctx.fillStyle = theme("fg-2"); ctx.textAlign = "left";
      ctx.fillText(`w ${Math.round(this.width[b] * 100)}%`, x0 + 2, widY + widH + 7);
    }
    ctx.fillStyle = theme("fg-2"); ctx.font = font(10); ctx.textAlign = "right"; ctx.textBaseline = "top";
    ctx.fillText("−1 … +1  ·  w = side share", x1, padT - 4 < 0 ? 0 : padT - 4);
    if (this.warn > 0.3) {
      ctx.fillStyle = withAlpha(theme("clip"), this.warn); ctx.font = font(10, 600); ctx.textAlign = "left";
      ctx.fillText("LOW BAND NOT MONO-SAFE", padL, h - padB - 10);
    }
  }
}
