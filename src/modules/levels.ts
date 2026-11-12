import type { Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import { ballistic, fmtDb, type DrawCtx, type Module, type SettingItem } from "./types";
import { settings, saveSettings } from "../state";
import { TARGETS } from "./loudness";

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
 *  Fluid: bar width, labels and scale adapt to the tile size. Mode via right-click. */
export class LevelsModule implements Module {
  readonly id = "levels";
  readonly title = "Levels";
  private main = [-120, -120];
  private under = [-120, -120];
  private hold = [-120, -120];
  private holdAge = [0, 0];
  private clip = [false, false];

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

  settings(): SettingItem[] {
    return [
      {
        type: "select", label: "표시 값", value: this.mode,
        options: MODES.map((m) => ({ value: m.id, label: m.label })),
        onChange: (v) => { settings.levelMode = v as LevelMode; saveSettings(); this.hold = [-120, -120]; this.clip = [false, false]; },
      },
      {
        type: "select", label: "LUFS 타깃", value: String(settings.loudnessTarget),
        options: TARGETS.map((t) => ({ value: String(t.lufs), label: t.label })),
        onChange: (v) => { settings.loudnessTarget = Number(v); saveSettings(); },
      },
      { type: "action", label: "클립 표시 지우기", onClick: () => { this.clip = [false, false]; } },
    ];
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

    // Fluid geometry: scale labels only when there is room for them.
    const narrow = w < 64, tiny = w < 40, short = h < 90;
    const padL = narrow ? 4 : 28;
    const padT = short ? 8 : 14;
    const padB = short ? 6 : tiny ? 16 : 34;
    const y0 = padT, y1 = h - padB, ph = y1 - y0;
    if (ph < 10) return;
    const yOf = (db: number) => y0 + ((DB_TOP - Math.min(DB_TOP, Math.max(DB_BOTTOM, db))) / (DB_TOP - DB_BOTTOM)) * ph;
    const avail = w - padL - 4;
    const gap = Math.max(3, Math.min(8, avail * 0.15));
    const barW = Math.max(4, Math.min(14, (avail - gap) / 2));
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
      ctx.beginPath(); ctx.moveTo(x0 - 3, y); ctx.lineTo(x0 + totalW + 3, y); ctx.stroke();
      if (!narrow && db % 12 === 0 && ph > 60) ctx.fillText(`${db}`, x0 - 6, y);
    }
    if (isLufs) {
      const ty = Math.round(yOf(settings.loudnessTarget)) + 0.5;
      ctx.strokeStyle = theme("target"); ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x0 - 5, ty); ctx.lineTo(x0 + totalW + 5, ty); ctx.stroke();
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
      const inner = v.under ? Math.min(3, barW * 0.25) : 0;
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
      ctx.fillRect(x, y0 - (short ? 6 : 10), barW, short ? 4 : 6);
      if (!tiny) {
        ctx.fillStyle = theme("fg-1");
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        if (!short) ctx.fillText(mode.names[c], x + barW / 2, y1 + 4);
        if (!short && !narrow) {
          ctx.fillStyle = theme("fg-0");
          ctx.font = font(11, 500);
          ctx.fillText(fmtDb(this.hold[c]), x + barW / 2, y1 + 16);
          ctx.font = font(10);
        }
      }
    }
    if (!narrow && !short) {
      ctx.fillStyle = theme("fg-2");
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(mode.unit, 4, 2);
    }
  }
}
