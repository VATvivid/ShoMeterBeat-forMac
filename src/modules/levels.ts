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
      this.main[c] = isLufs ? target : ballistic(this.main[c], target, dt, this.mode === "rms" ? 18 : 24);
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

    // Soft look: rounded tracks, a vertical gradient that warms toward the top (cool
    // signal colour → warm near −12 → red in the clip zone), a translucent RMS core, and a
    // hold line with a faint glow instead of a hard 2 px bar.
    const rr = Math.min(4, barW / 2);
    const roundRect = (x: number, y: number, w: number, hh: number, r: number) => { ctx.beginPath(); ctx.roundRect(x, y, w, Math.max(0, hh), r); };
    for (let c = 0; c < 2; c++) {
      const x = x0 + c * (barW + gap);
      ctx.fillStyle = theme("bg-3");
      roundRect(x, y0, barW, ph, rr); ctx.fill();
      ctx.save();
      roundRect(x, y0, barW, ph, rr); ctx.clip();
      if (v.under) {
        const yu = yOf(this.under[c]);
        ctx.fillStyle = withAlpha(theme("sig"), 0.35);
        ctx.fillRect(x, yu, barW, y1 - yu);
      }
      const ym = yOf(this.main[c]);
      const inner = v.under ? Math.min(3, barW * 0.25) : 0;
      const g = ctx.createLinearGradient(0, y1, 0, y0);
      const base = isLufs ? (c ? theme("sig-2") : theme("sig")) : theme("sig");
      if (isLufs) {
        const t = (settings.loudnessTarget - DB_BOTTOM) / (DB_TOP - DB_BOTTOM);
        g.addColorStop(0, withAlpha(base, 0.75)); g.addColorStop(Math.max(0, t - 0.08), base); g.addColorStop(Math.min(1, t + 0.02), theme("clip")); g.addColorStop(1, theme("clip"));
      } else {
        g.addColorStop(0, withAlpha(base, 0.75)); g.addColorStop(0.7, base); g.addColorStop(0.88, theme("peak")); g.addColorStop(0.95, theme("clip")); g.addColorStop(1, theme("clip"));
      }
      ctx.fillStyle = g;
      ctx.fillRect(x + inner, ym, barW - 2 * inner, y1 - ym);
      // soft highlight at the bar top
      ctx.fillStyle = withAlpha(theme("fg-0"), 0.18);
      ctx.fillRect(x + inner, ym, barW - 2 * inner, 2);
      ctx.restore();
      const yh = Math.round(yOf(this.hold[c])) + 0.5;
      ctx.save();
      ctx.shadowColor = theme("peak"); ctx.shadowBlur = 6;
      ctx.strokeStyle = withAlpha(theme("peak"), 0.95);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x + 1, yh); ctx.lineTo(x + barW - 1, yh); ctx.stroke();
      ctx.restore();
      ctx.lineWidth = 1;
      ctx.fillStyle = this.clip[c] ? theme("clip") : withAlpha(theme("bg-3"), 0.8);
      roundRect(x, y0 - (short ? 6 : 10), barW, short ? 4 : 6, 2); ctx.fill();
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
