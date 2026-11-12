import type { Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import { ballistic, fmtDb, type DrawCtx, type Module, type SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

// Dynamics meter in the Levels style: three vertical bars.
//  Crest = sample peak − RMS (short window)        → transient density / punch
//  PSR   = max true peak (last 3 s) − short-term LUFS → short-term dynamics (mastering)
//  PLR   = session max true peak − integrated LUFS → overall dynamics
// Zones: < 6 dB squashed (red), 6–10 tight (amber), > 10 open (signal colour).

const SCALE_TOP = 30, SCALE_BOTTOM = 0;
const HOLD_S = 2.0;
const TP_WINDOW_S = 3;

export class DynamicsModule implements Module {
  readonly id = "dynamics";
  readonly title = "Dynamics";
  private vals = [0, 0, 0];
  private hold = [0, 0, 0];
  private holdAge = [0, 0, 0];
  private tpHist: { t: number; v: number }[] = [];
  private clock = 0;
  private crestSmooth = 0;

  private get showPLR() { return modSetting(this.id, "plr", true); }

  settings(): SettingItem[] {
    return [
      { type: "toggle", label: "PLR (세션 누적) 표시", value: this.showPLR, onChange: (v) => setModSetting(this.id, "plr", v) },
      { type: "action", label: "홀드 지우기", onClick: () => { this.hold = [0, 0, 0]; } },
    ];
  }

  headReadout() {
    return `Crest ${this.vals[0].toFixed(1)}  PSR ${this.vals[1].toFixed(1)}${this.showPLR ? `  PLR ${this.vals[2].toFixed(1)}` : ""}`;
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    this.clock += dt;
    // --- measurements
    const peak = Math.max(f.peak[0], f.peak[1]);
    const rms = 10 * Math.log10((Math.pow(10, f.rms[0] / 10) + Math.pow(10, f.rms[1] / 10)) / 2 + 1e-12);
    const crestNow = peak > -90 && rms > -90 ? Math.max(0, peak - rms) : 0;
    this.crestSmooth += (crestNow - this.crestSmooth) * Math.min(1, dt * 6);
    const tpNow = Math.max(f.truePeak[0], f.truePeak[1]);
    if (tpNow > -90) this.tpHist.push({ t: this.clock, v: tpNow });
    while (this.tpHist.length && this.clock - this.tpHist[0].t > TP_WINDOW_S) this.tpHist.shift();
    const tp3 = this.tpHist.reduce((m, e) => Math.max(m, e.v), -120);
    const psr = f.lufsS > -90 && tp3 > -90 ? Math.max(0, tp3 - f.lufsS) : 0;
    const plr = f.lufsI > -90 && f.maxTP > -90 ? Math.max(0, f.maxTP - f.lufsI) : 0;
    const targets = [this.crestSmooth, psr, plr];
    for (let i = 0; i < 3; i++) {
      this.vals[i] = ballistic(this.vals[i], targets[i], dt, 12);
      if (targets[i] >= this.hold[i]) { this.hold[i] = targets[i]; this.holdAge[i] = 0; }
      else { this.holdAge[i] += dt; if (this.holdAge[i] > HOLD_S) this.hold[i] = ballistic(this.hold[i], targets[i], dt, 6); }
    }

    // --- layout (fluid, Levels-like)
    const bars = this.showPLR ? 3 : 2;
    const narrow = w < 70, short = h < 90;
    const padL = narrow ? 4 : 26, padT = short ? 8 : 14, padB = short ? 6 : 34;
    const y0 = padT, y1 = h - padB, ph = y1 - y0;
    if (ph < 10) return;
    const yOf = (v: number) => y0 + ((SCALE_TOP - Math.min(SCALE_TOP, Math.max(SCALE_BOTTOM, v))) / (SCALE_TOP - SCALE_BOTTOM)) * ph;
    const avail = w - padL - 4;
    const gap = Math.max(3, Math.min(8, avail * 0.12));
    const barW = Math.max(4, Math.min(14, (avail - gap * (bars - 1)) / bars));
    const totalW = barW * bars + gap * (bars - 1);
    const x0 = padL + Math.max(0, (w - padL - totalW) / 2);

    // scale + zones
    ctx.font = font(10); ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let v = SCALE_BOTTOM; v <= SCALE_TOP; v += 6) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = theme("grid"); ctx.beginPath(); ctx.moveTo(x0 - 3, y); ctx.lineTo(x0 + totalW + 3, y); ctx.stroke();
      if (!narrow && ph > 60) { ctx.fillStyle = theme("fg-1"); ctx.fillText(`${v}`, x0 - 6, y); }
    }
    for (const [lo, hi, c, a] of [[0, 6, theme("clip"), 0.12], [6, 10, theme("peak"), 0.08]] as [number, number, string, number][]) {
      ctx.fillStyle = withAlpha(c, a);
      ctx.fillRect(x0 - 3, yOf(hi), totalW + 6, yOf(lo) - yOf(hi));
    }

    const names = ["CREST", "PSR", "PLR"];
    for (let i = 0; i < bars; i++) {
      const x = x0 + i * (barW + gap);
      const v = this.vals[i];
      ctx.fillStyle = theme("bg-3");
      ctx.fillRect(x, y0, barW, ph);
      const col = v < 6 ? theme("clip") : v < 10 ? theme("peak") : theme("sig");
      const yv = yOf(v);
      ctx.fillStyle = col;
      ctx.fillRect(x, yv, barW, y1 - yv);
      const yh = Math.round(yOf(this.hold[i])) + 0.5;
      ctx.strokeStyle = theme("fg-0"); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, yh); ctx.lineTo(x + barW, yh); ctx.stroke(); ctx.lineWidth = 1;
      if (!short) {
        ctx.fillStyle = theme("fg-1"); ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.font = font(9, 600);
        ctx.fillText(names[i], x + barW / 2, y1 + 4);
        if (!narrow) { ctx.fillStyle = theme("fg-0"); ctx.font = font(11, 500); ctx.fillText(fmtDb(v, 1).replace("+", ""), x + barW / 2, y1 + 15); }
      }
    }
    if (!narrow && !short) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10); ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText("dB", 4, 2);
    }
  }
}
