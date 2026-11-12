import type { Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import { ballistic, fmtDb, type DrawCtx, type Module } from "./types";
import { settings, saveSettings } from "../state";

const DB_TOP = 0, DB_BOTTOM = -60;
const CLIP_DB = -0.1;
const HOLD_S = 1.5;

export type LevelMode = "peak" | "truepeak" | "rms" | "lufs";
const MODES: { id: LevelMode; label: string; unit: string; names: [string, string] }[] = [
  { id: "peak", label: "Peak", unit: "dBFS", names: ["L", "R"] },
  { id: "truepeak", label: "True Peak", unit: "dBTP", names: ["L", "R"] },
  { id: "rms", label: "RMS", unit: "dBFS", names: ["L", "R"] },
  { id: "lufs", label: "LUFS", unit: "LUFS", names: ["M", "S"] },
];

/** Two bars (L/R, or Momentary/Short-term for LUFS) with peak hold and clip indicators.
 *  Mode is chosen in the tile header. */
export class LevelsModule implements Module {
  readonly id = "levels";
  readonly title = "Levels";
  private main = [-120, -120];
  private under = [-120, -120];
  private hold = [-120, -120];
  private holdAge = [0, 0];
  private clip = [false, false];
  private sel: HTMLSelectElement | null = null;

  private get mode(): LevelMode { return settings.levelMode; }

  private values(f: Frame): { main: [number, number]; under: [number, number] | null } {
    switch (this.mode) {
      case "truepeak": return { main: f.truePeak, under: f.rms };
      case "rms": return { main: f.rms, under: null };
      case "lufs": return { main: [f.lufsM, f.lufsS], under: null };
      default: return { main: f.peak, under: f.rms };
    }
  }

  headReadout(f: Frame) {
    const m = MODES.find((x) => x.id === this.mode)!;
    const v = this.values(f).main;
    return `${m.names[0]} ${fmtDb(v[0])}  ${m.names[1]} ${fmtDb(v[1])}`;
  }

  headControl() {
    const sel = document.createElement("select");
    sel.className = "mini";
    for (const m of MODES) {
      const o = document.createElement("option");
      o.value = m.id; o.textContent = m.label;
      if (m.id === this.mode) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => {
      settings.levelMode = sel.value as LevelMode; saveSettings();
      this.hold = [-120, -120]; this.clip = [false, false];
    });
    sel.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.sel = sel;
    return sel;
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    const mode = MODES.find((x) => x.id === this.mode)!;
    const v = this.values(f);
    const isLufs = this.mode === "lufs";
    for (let c = 0; c < 2; c++) {
      const target = v.main[c];
      this.main[c] = isLufs ? target : ballistic(this.main[c], target, dt, this.mode === "rms" ? 20 : 30);
      if (v.under) this.under[c] = ballistic(this.under[c], v.under[c], dt, 20);
      if (target >= this.hold[c]) { this.hold[c] = target; this.holdAge[c] = 0; }
      else { this.holdAge[c] += dt; if (this.holdAge[c] > HOLD_S) this.hold[c] = ballistic(this.hold[c], target, dt, 30); }
      if (!isLufs && target >= CLIP_DB) this.clip[c] = true;
    }
    if (this.sel && this.sel.value !== this.mode) this.sel.value = this.mode;

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
    // Target line for LUFS mode
    if (isLufs) {
      const ty = Math.round(yOf(settings.loudnessTarget)) + 0.5;
      ctx.strokeStyle = theme("target"); ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x0 - 6, ty); ctx.lineTo(x0 + totalW + 6, ty); ctx.stroke();
      ctx.setLineDash([]);
    }

    for (let c = 0; c < 2; c++) {
      const x = x0 + c * (barW + gap);
      ctx.fillStyle = theme("bg-3");
      ctx.fillRect(x, y0, barW, ph);
      if (v.under) {
        const yu = yOf(this.under[c]);
        ctx.fillStyle = withAlpha(theme("sig"), 0.55);
        ctx.fillRect(x, yu, barW, y1 - yu);
      }
      const ym = yOf(this.main[c]);
      const inner = v.under ? 3 : 0;
      ctx.fillStyle = isLufs ? (c ? theme("sig-2") : theme("sig")) : theme("sig");
      ctx.fillRect(x + inner, ym, barW - 2 * inner, y1 - ym);
      if (!isLufs && this.main[c] > -3) {
        ctx.fillStyle = theme("clip");
        ctx.fillRect(x + inner, ym, barW - 2 * inner, yOf(-3) - ym);
      }
      if (isLufs && this.main[c] > settings.loudnessTarget + 1) {
        ctx.fillStyle = theme("clip");
        ctx.fillRect(x, ym, barW, yOf(settings.loudnessTarget + 1) - ym);
      }
      const yh = Math.round(yOf(this.hold[c])) + 0.5;
      ctx.strokeStyle = theme("peak");
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, yh); ctx.lineTo(x + barW, yh); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = this.clip[c] ? theme("clip") : theme("bg-3");
      ctx.fillRect(x, y0 - 10, barW, 6);
      ctx.fillStyle = theme("fg-1");
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(mode.names[c], x + barW / 2, y1 + 4);
      ctx.fillStyle = theme("fg-0");
      ctx.font = font(11, 500);
      ctx.fillText(fmtDb(this.hold[c]), x + barW / 2, y1 + 16);
      ctx.font = font(10);
    }
    ctx.fillStyle = theme("fg-2");
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(mode.unit, 4, 2);
  }
}
