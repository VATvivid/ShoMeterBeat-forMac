import type { Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import { ballistic, fmtDb, type DrawCtx, type Module, type SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

// Dynamics meter in the Levels style: vertical bars with, beside each bar, a
// distribution profile of the value over the last N seconds (1 dB bins) and a
// median marker — so you can see where the material usually sits, not just now.
//  Crest = sample peak − RMS (short window)           → transient density / punch
//  PSR   = max true peak (last 3 s) − short-term LUFS → short-term dynamics
//  PLR   = session max true peak − integrated LUFS    → overall dynamics
// Zones: < 6 dB squashed (red), 6–10 tight (amber), > 10 open (signal colour).

const SCALE_TOP = 30, SCALE_BOTTOM = 0;
const HOLD_S = 2.0;
const TP_WINDOW_S = 3;
const BINS = 30;

export class DynamicsModule implements Module {
  readonly id = "dynamics";
  readonly title = "Dynamics";
  private vals = [0, 0, 0];
  private hold = [0, 0, 0];
  private holdAge = [0, 0, 0];
  private tpHist: { t: number; v: number }[] = [];
  private clock = 0;
  private crestSmooth = 0;
  /** Per bar: samples (value, time) for the distribution window. */
  private samples: { t: number; v: number }[][] = [[], [], []];
  private sampleAcc = 0;

  private get showPLR() { return modSetting(this.id, "plr", true); }
  private get histSeconds() { return modSetting(this.id, "hist", 60); }

  settings(): SettingItem[] {
    return [
      { type: "select", label: "분포 구간", value: String(this.histSeconds), options: [15, 30, 60, 120, 300].map((v) => ({ value: String(v), label: v >= 60 ? `${v / 60}분` : `${v}초` })), onChange: (v) => setModSetting(this.id, "hist", Number(v)) },
      { type: "toggle", label: "PLR (세션 누적) 표시", value: this.showPLR, onChange: (v) => setModSetting(this.id, "plr", v) },
      { type: "action", label: "홀드·분포 지우기", onClick: () => { this.hold = [0, 0, 0]; this.samples = [[], [], []]; } },
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
    const active = rms > -70;
    const crestNow = peak > -90 && active ? Math.max(0, peak - rms) : 0;
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
    // --- distribution samples at 10 Hz while there is signal
    this.sampleAcc += dt;
    if (this.sampleAcc >= 0.1) {
      this.sampleAcc = 0;
      if (active) for (let i = 0; i < 3; i++) this.samples[i].push({ t: this.clock, v: targets[i] });
      const limit = this.histSeconds;
      for (const s of this.samples) while (s.length && this.clock - s[0].t > limit) s.shift();
    }

    // --- layout (fluid): [bar][profile] groups
    const bars = this.showPLR ? 3 : 2;
    const narrow = w < 90, short = h < 90;
    const padL = narrow ? 4 : 26, padT = short ? 8 : 14, padB = short ? 6 : 34;
    const y0 = padT, y1 = h - padB, ph = y1 - y0;
    if (ph < 10) return;
    const yOf = (v: number) => y0 + ((SCALE_TOP - Math.min(SCALE_TOP, Math.max(SCALE_BOTTOM, v))) / (SCALE_TOP - SCALE_BOTTOM)) * ph;
    const avail = w - padL - 4;
    const gap = Math.max(4, Math.min(10, avail * 0.08));
    const groupW = (avail - gap * (bars - 1)) / bars;
    const barW = Math.max(4, Math.min(12, groupW * 0.35));
    const profW = Math.max(0, Math.min(40, groupW - barW - 3));
    const totalW = bars * (barW + 3 + profW) + gap * (bars - 1);
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
      const gx = x0 + i * (barW + 3 + profW + gap);
      const v = this.vals[i];
      // bar
      ctx.fillStyle = theme("bg-3");
      ctx.fillRect(gx, y0, barW, ph);
      const col = v < 6 ? theme("clip") : v < 10 ? theme("peak") : theme("sig");
      const yv = yOf(v);
      ctx.fillStyle = col;
      ctx.fillRect(gx, yv, barW, y1 - yv);
      const yh = Math.round(yOf(this.hold[i])) + 0.5;
      ctx.strokeStyle = theme("fg-0"); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(gx, yh); ctx.lineTo(gx + barW, yh); ctx.stroke(); ctx.lineWidth = 1;
      // distribution profile (histogram, 1 dB bins) to the right of the bar
      if (profW >= 8) {
        const px = gx + barW + 3;
        const s = this.samples[i];
        if (s.length >= 5) {
          const hist = new Float32Array(BINS);
          for (const e of s) hist[Math.min(BINS - 1, Math.max(0, Math.floor(e.v)))]++;
          let mx = 1; for (const c of hist) mx = Math.max(mx, c);
          ctx.fillStyle = withAlpha(col, 0.35);
          ctx.strokeStyle = withAlpha(theme("fg-1"), 0.6);
          ctx.beginPath();
          ctx.moveTo(px, yOf(0));
          for (let b = 0; b < BINS; b++) {
            const yTop = yOf(b + 1), yBot = yOf(b);
            const wdt = (hist[b] / mx) * profW;
            ctx.lineTo(px + wdt, yBot); ctx.lineTo(px + wdt, yTop);
          }
          ctx.lineTo(px, yOf(BINS)); ctx.closePath();
          ctx.fill(); ctx.stroke();
          // median marker
          const sorted = s.map((e) => e.v).sort((a, b) => a - b);
          const med = sorted[sorted.length >> 1];
          const ym = Math.round(yOf(med)) + 0.5;
          ctx.strokeStyle = theme("target"); ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(px, ym); ctx.lineTo(px + profW, ym); ctx.stroke(); ctx.lineWidth = 1;
          if (!short && profW >= 22) {
            ctx.fillStyle = theme("target"); ctx.font = font(9); ctx.textAlign = "left"; ctx.textBaseline = "bottom";
            ctx.fillText(`~${med.toFixed(0)}`, px + 1, ym - 1);
          }
        } else {
          ctx.strokeStyle = withAlpha(theme("fg-2"), 0.4);
          ctx.strokeRect(px + 0.5, y0 + 0.5, profW - 1, ph - 1);
        }
      }
      // labels
      if (!short) {
        ctx.fillStyle = theme("fg-1"); ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.font = font(9, 600);
        ctx.fillText(names[i], gx, y1 + 4);
        if (!narrow) { ctx.fillStyle = theme("fg-0"); ctx.font = font(11, 500); ctx.fillText(fmtDb(v, 1).replace("+", ""), gx, y1 + 15); }
      }
    }
    if (!narrow && !short) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10); ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(`dB · 분포 ${this.histSeconds >= 60 ? `${this.histSeconds / 60}분` : `${this.histSeconds}초`}`, 4, 2);
    }
  }
}
