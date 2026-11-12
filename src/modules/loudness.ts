import type { Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import { fmtDb, type DrawCtx, type Module, type SettingItem } from "./types";
import { settings, saveSettings } from "../state";

const HISTORY_S = 60;
const HIST_HZ = 10;
const GRAPH_TOP = 0, GRAPH_BOTTOM = -40;

export const TARGETS: { label: string; lufs: number }[] = [
  { label: "−14 LUFS (YouTube / Spotify)", lufs: -14 },
  { label: "−16 LUFS (팟캐스트/애플)", lufs: -16 },
  { label: "−18 LUFS", lufs: -18 },
  { label: "−23 LUFS (EBU R128 방송)", lufs: -23 },
  { label: "−24 LUFS (ATSC A/85)", lufs: -24 },
];

/** EBU R128 readouts (M / S / I / LRA / True Peak) plus a short-term & momentary history. */
export class LoudnessModule implements Module {
  readonly id = "loudness";
  readonly title = "Loudness";
  private histM = new Float32Array(HISTORY_S * HIST_HZ).fill(-120);
  private histS = new Float32Array(HISTORY_S * HIST_HZ).fill(-120);
  private acc = 0;

  settings(): SettingItem[] {
    return [
      {
        type: "select", label: "타깃", value: String(settings.loudnessTarget),
        options: TARGETS.map((t) => ({ value: String(t.lufs), label: t.label })),
        onChange: (v) => { settings.loudnessTarget = Number(v); saveSettings(); },
      },
    ];
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    this.acc += dt;
    while (this.acc >= 1 / HIST_HZ) {
      this.acc -= 1 / HIST_HZ;
      this.histM.copyWithin(0, 1); this.histM[this.histM.length - 1] = f.lufsM;
      this.histS.copyWithin(0, 1); this.histS[this.histS.length - 1] = f.lufsS;
    }
    const target = settings.loudnessTarget;
    const compact = w < 300 || h < 200;
    const heroSize = compact ? 24 : 40;
    const subSize = compact ? 15 : 24;
    const colW = w / 2;

    const label = (text: string, x: number, y: number, align: CanvasTextAlign = "left") => {
      ctx.fillStyle = theme("fg-1"); ctx.font = font(11, 600); ctx.textAlign = align; ctx.textBaseline = "top";
      ctx.fillText(text.toUpperCase(), x, y);
    };
    const value = (v: string, unit: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "left") => {
      ctx.fillStyle = color; ctx.font = font(size, 600); ctx.textAlign = align; ctx.textBaseline = "top";
      ctx.fillText(v, x, y);
      const tw = ctx.measureText(v).width;
      ctx.fillStyle = theme("fg-1"); ctx.font = font(11);
      ctx.textBaseline = "alphabetic";
      const ux = align === "left" ? x + tw + 4 : x + 4;
      ctx.fillText(unit, ux, y + size * 0.95);
    };

    // Left column: Integrated hero + LRA
    const px = 12, py = 8;
    label("Integrated", px, py);
    const over = f.lufsI > target + 1;
    value(fmtDb(f.lufsI), "LUFS", px, py + 14, heroSize, over ? theme("clip") : theme("peak"));
    const row2 = py + 14 + heroSize + 12;
    label("Range", px, row2);
    value(f.lra.toFixed(1), "LU", px, row2 + 14, subSize, theme("fg-0"));

    // Right column: Momentary / Short-term / True peak max
    const rx = colW + 8;
    label("Momentary", rx, py);
    value(fmtDb(f.lufsM), "LUFS", rx, py + 14, subSize, theme("sig"));
    const r2 = py + 14 + subSize + 8;
    label("Short-term", rx, r2);
    value(fmtDb(f.lufsS), "LUFS", rx, r2 + 14, subSize, theme("sig-2"));
    const r3 = r2 + 14 + subSize + 8;
    label("True peak max", rx, r3);
    value(fmtDb(f.maxTP), "dBTP", rx, r3 + 14, subSize, f.maxTP > -1 ? theme("clip") : theme("fg-0"));

    // Target + max readouts (small)
    const topBlockH = Math.max(row2 + 14 + subSize + 10, r3 + 14 + subSize + 10);
    ctx.fillStyle = theme("fg-2"); ctx.font = font(10); ctx.textAlign = "left"; ctx.textBaseline = "top";
    const tname = TARGETS.find((t) => t.lufs === target)?.label ?? `${target} LUFS`;
    ctx.fillText(`target ${tname} · max M ${fmtDb(f.maxM)} · max S ${fmtDb(f.maxS)}`, px, topBlockH);

    // History graph
    const gy0 = topBlockH + 16, gy1 = h - 8, gx0 = 30, gx1 = w - 8;
    if (gy1 - gy0 < 40 || gx1 - gx0 < 40) return;
    const gh = gy1 - gy0, gw = gx1 - gx0;
    const yOf = (v: number) => gy0 + ((GRAPH_TOP - Math.min(GRAPH_TOP, Math.max(GRAPH_BOTTOM, v))) / (GRAPH_TOP - GRAPH_BOTTOM)) * gh;
    ctx.strokeStyle = theme("grid"); ctx.lineWidth = 1;
    ctx.fillStyle = theme("fg-1"); ctx.font = font(10); ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let v = GRAPH_TOP; v >= GRAPH_BOTTOM; v -= 10) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(gx0, y); ctx.lineTo(gx1, y); ctx.stroke();
      ctx.fillText(`${v}`, gx0 - 4, y);
    }
    // Target line
    const ty = Math.round(yOf(target)) + 0.5;
    ctx.strokeStyle = theme("target"); ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(gx0, ty); ctx.lineTo(gx1, ty); ctx.stroke();
    ctx.setLineDash([]);
    // Traces
    const trace = (buf: Float32Array, color: string, fill: boolean) => {
      ctx.beginPath();
      for (let i = 0; i < buf.length; i++) {
        const x = gx0 + (i / (buf.length - 1)) * gw, y = yOf(buf[i]);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      if (fill) {
        ctx.lineTo(gx1, gy1); ctx.lineTo(gx0, gy1); ctx.closePath();
        ctx.fillStyle = withAlpha(color, 0.18); ctx.fill();
      } else {
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
      }
    };
    trace(this.histM, theme("sig"), true);
    trace(this.histS, theme("sig-2"), false);
    ctx.fillStyle = theme("fg-2"); ctx.font = font(10); ctx.textAlign = "right"; ctx.textBaseline = "top";
    ctx.fillText(`${HISTORY_S}s`, gx1, gy0 + 2);
  }
}
