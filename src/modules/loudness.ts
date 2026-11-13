import type { Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import { ballistic, fmtDb, type DrawCtx, type Module, type SettingItem } from "./types";
import { settings, saveSettings, modSetting, setModSetting } from "../state";

// Loudness (EBU R128) — one wide tile with four parts, left to right:
//   readouts  — Integrated hero, Range, Momentary, Short-term, True-peak max, target
//   meters    — M / S LUFS bars like the Levels module (target line, peak hold, over-target red)
//   trace     — the last 60 s of loudness drawn like the Waveform's level history: short-term
//               as a filled band from the bottom, momentary as a line, the target dashed
//   profile   — distribution of short-term loudness over the trace window in 1 LU bins
//               with a median marker (like the Dynamics module), so you see where the
//               material usually sits, not just now
// Parts drop out as the tile gets narrower (profile → meters → readouts shrink).

const HISTORY_S = 60;
const HIST_HZ = 10;
const GRAPH_TOP = 0, GRAPH_BOTTOM = -40;
const HOLD_S = 1.5;
const BINS = 40; // 1 LU bins over GRAPH_BOTTOM … GRAPH_TOP

export const TARGETS: { label: string; lufs: number }[] = [
  { label: "−14 LUFS (YouTube / Spotify)", lufs: -14 },
  { label: "−16 LUFS (팟캐스트/애플)", lufs: -16 },
  { label: "−18 LUFS", lufs: -18 },
  { label: "−23 LUFS (EBU R128 방송)", lufs: -23 },
  { label: "−24 LUFS (ATSC A/85)", lufs: -24 },
];

export class LoudnessModule implements Module {
  readonly id = "loudness";
  readonly title = "Loudness";
  private histM = new Float32Array(HISTORY_S * HIST_HZ).fill(-120);
  private histS = new Float32Array(HISTORY_S * HIST_HZ).fill(-120);
  private acc = 0;
  private bar = [-120, -120];
  private hold = [-120, -120];
  private holdAge = [0, 0];

  private get showMeters() { return modSetting(this.id, "meters", true); }
  private get showProfile() { return modSetting(this.id, "profile", true); }

  settings(): SettingItem[] {
    return [
      {
        type: "select", label: "타깃", value: String(settings.loudnessTarget),
        options: TARGETS.map((t) => ({ value: String(t.lufs), label: t.label })),
        onChange: (v) => { settings.loudnessTarget = Number(v); saveSettings(); },
      },
      { type: "toggle", label: "LUFS 미터 (M/S 막대)", value: this.showMeters, onChange: (v) => setModSetting(this.id, "meters", v) },
      { type: "toggle", label: "분포 (최근 60초)", value: this.showProfile, onChange: (v) => setModSetting(this.id, "profile", v) },
      { type: "action", label: "흔적·분포 지우기", onClick: () => { this.histM.fill(-120); this.histS.fill(-120); this.hold = [-120, -120]; } },
    ];
  }

  headReadout(f: Frame) {
    return `I ${fmtDb(f.lufsI)}  S ${fmtDb(f.lufsS)}  M ${fmtDb(f.lufsM)}`;
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    this.acc += dt;
    while (this.acc >= 1 / HIST_HZ) {
      this.acc -= 1 / HIST_HZ;
      this.histM.copyWithin(0, 1); this.histM[this.histM.length - 1] = f.lufsM;
      this.histS.copyWithin(0, 1); this.histS[this.histS.length - 1] = f.lufsS;
    }
    const vals = [f.lufsM, f.lufsS];
    for (let c = 0; c < 2; c++) {
      this.bar[c] = vals[c] >= this.bar[c] ? vals[c] : ballistic(this.bar[c], vals[c], dt, 20);
      if (vals[c] >= this.hold[c]) { this.hold[c] = vals[c]; this.holdAge[c] = 0; }
      else { this.holdAge[c] += dt; if (this.holdAge[c] > HOLD_S) this.hold[c] = ballistic(this.hold[c], vals[c], dt, 30); }
    }
    const target = settings.loudnessTarget;
    const narrow = w < 420, compact = w < 300 || h < 160;
    const heroSize = compact ? 22 : 36;
    const subSize = compact ? 14 : 20;
    const yOf = (v: number, y0: number, hh: number) => y0 + ((GRAPH_TOP - Math.min(GRAPH_TOP, Math.max(GRAPH_BOTTOM, v))) / (GRAPH_TOP - GRAPH_BOTTOM)) * hh;

    const label = (text: string, x: number, y: number) => {
      ctx.fillStyle = theme("fg-1"); ctx.font = font(10, 600); ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(text.toUpperCase(), x, y);
    };
    const value = (v: string, unit: string, x: number, y: number, size: number, color: string) => {
      ctx.fillStyle = color; ctx.font = font(size, 600); ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(v, x, y);
      const tw = ctx.measureText(v).width;
      ctx.fillStyle = theme("fg-1"); ctx.font = font(10); ctx.textBaseline = "alphabetic";
      ctx.fillText(unit, x + tw + 4, y + size * 0.95);
    };

    // ---- readouts column
    const px = 10, py = 8;
    const readW = compact ? Math.min(w - 20, 150) : narrow ? 150 : 190;
    label("Integrated", px, py);
    const over = f.lufsI > target + 1;
    value(fmtDb(f.lufsI), "LUFS", px, py + 13, heroSize, over ? theme("clip") : theme("peak"));
    let y = py + 13 + heroSize + 8;
    const two = readW >= 170;
    label("Range", px, y); value(f.lra.toFixed(1), "LU", px, y + 13, subSize, theme("fg-0"));
    if (two) { label("True peak max", px + 90, y); value(fmtDb(f.maxTP), "dBTP", px + 90, y + 13, subSize, f.maxTP > -1 ? theme("clip") : theme("fg-0")); }
    y += 13 + subSize + 8;
    label("Momentary", px, y); value(fmtDb(f.lufsM), "LUFS", px, y + 13, subSize, theme("sig"));
    if (two) { label("Short-term", px + 90, y); value(fmtDb(f.lufsS), "LUFS", px + 90, y + 13, subSize, theme("sig-2")); }
    else { y += 13 + subSize + 8; label("Short-term", px, y); value(fmtDb(f.lufsS), "LUFS", px, y + 13, subSize, theme("sig-2")); }
    y += 13 + subSize + 10;
    ctx.fillStyle = theme("fg-2"); ctx.font = font(10); ctx.textAlign = "left"; ctx.textBaseline = "top";
    const tname = TARGETS.find((t) => t.lufs === target)?.label ?? `${target} LUFS`;
    if (y + 12 < h - 8) ctx.fillText(`target ${tname.replace(/ \(.*$/, "")} · max M ${fmtDb(f.maxM)} · max S ${fmtDb(f.maxS)}`, px, y);
    if (compact && w < 300) return; // readouts only
    let x = px + readW + 6;

    // ---- plot area shared by meters / trace / profile
    const gy0 = 14, gy1 = h - 18, gh = gy1 - gy0;
    if (gh < 30) return;
    const metersW = this.showMeters && !narrow ? 44 : 0;
    const profW = this.showProfile && w - x - metersW > 200 ? 56 : 0;
    const gap = 10;

    // meters: M / S bars with target line + hold (Levels style)
    if (metersW) {
      const barW = 14, mx = x + 4;
      ctx.font = font(9); ctx.textAlign = "right"; ctx.textBaseline = "middle";
      for (let v = GRAPH_TOP; v >= GRAPH_BOTTOM; v -= 10) {
        const yy = Math.round(yOf(v, gy0, gh)) + 0.5;
        ctx.strokeStyle = theme("grid"); ctx.beginPath(); ctx.moveTo(mx - 2, yy); ctx.lineTo(mx + 2 * barW + 6, yy); ctx.stroke();
      }
      const ty = Math.round(yOf(target, gy0, gh)) + 0.5;
      ctx.strokeStyle = theme("target"); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(mx - 3, ty); ctx.lineTo(mx + 2 * barW + 7, ty); ctx.stroke(); ctx.setLineDash([]);
      for (let c = 0; c < 2; c++) {
        const bx = mx + c * (barW + 4);
        ctx.fillStyle = theme("bg-3"); ctx.fillRect(bx, gy0, barW, gh);
        const yv = yOf(this.bar[c], gy0, gh);
        ctx.fillStyle = c ? theme("sig-2") : theme("sig");
        ctx.fillRect(bx, yv, barW, gy1 - yv);
        if (this.bar[c] > target + 1) { ctx.fillStyle = theme("clip"); ctx.fillRect(bx, yv, barW, yOf(target + 1, gy0, gh) - yv); }
        const yh = Math.round(yOf(this.hold[c], gy0, gh)) + 0.5;
        ctx.strokeStyle = theme("peak"); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(bx, yh); ctx.lineTo(bx + barW, yh); ctx.stroke(); ctx.lineWidth = 1;
        ctx.fillStyle = theme("fg-1"); ctx.font = font(9); ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(c ? "S" : "M", bx + barW / 2, gy1 + 3);
      }
      x += metersW + gap;
    }

    // trace: Waveform-style level history (S filled from the bottom, M as a line)
    const tx0 = x, tx1 = w - 8 - (profW ? profW + gap : 0);
    const tw = tx1 - tx0;
    if (tw < 40) return;
    ctx.strokeStyle = theme("grid"); ctx.lineWidth = 1;
    ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (let v = GRAPH_TOP; v >= GRAPH_BOTTOM; v -= 10) {
      const yy = Math.round(yOf(v, gy0, gh)) + 0.5;
      ctx.beginPath(); ctx.moveTo(tx0, yy); ctx.lineTo(tx1, yy); ctx.stroke();
      ctx.fillText(`${v}`, tx0 + 2, yy - 5);
    }
    const ty = Math.round(yOf(target, gy0, gh)) + 0.5;
    ctx.strokeStyle = theme("target"); ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(tx0, ty); ctx.lineTo(tx1, ty); ctx.stroke(); ctx.setLineDash([]);
    const n = this.histS.length;
    ctx.beginPath();
    ctx.moveTo(tx0, gy1);
    for (let i = 0; i < n; i++) ctx.lineTo(tx0 + (i / (n - 1)) * tw, yOf(this.histS[i], gy0, gh));
    ctx.lineTo(tx1, gy1); ctx.closePath();
    ctx.fillStyle = withAlpha(theme("sig-2"), 0.3); ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const xx = tx0 + (i / (n - 1)) * tw, yy = yOf(this.histM[i], gy0, gh); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
    ctx.strokeStyle = theme("sig"); ctx.lineWidth = 1.2; ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "right"; ctx.textBaseline = "top";
    ctx.fillText(`${HISTORY_S}s · ▬ S · — M`, tx1 - 2, gy0 + 2);
    ctx.textAlign = "center";
    for (const s of [0, 15, 30, 45]) { const xx = tx1 - (s / HISTORY_S) * tw; ctx.fillText(s === 0 ? "now" : `−${s}s`, xx, gy1 + 3); }

    // profile: distribution of short-term loudness over the trace window (1 LU bins) + median
    if (profW) {
      const pxl = tx1 + gap;
      const hist = new Float32Array(BINS);
      const vals2: number[] = [];
      for (let i = 0; i < n; i++) { const v = this.histS[i]; if (v > -90) { vals2.push(v); hist[Math.min(BINS - 1, Math.max(0, Math.floor(v - GRAPH_BOTTOM)))]++; } }
      let mx = 1; for (const c of hist) mx = Math.max(mx, c);
      ctx.strokeStyle = theme("grid"); ctx.strokeRect(pxl + 0.5, gy0 + 0.5, profW - 1, gh - 1);
      if (vals2.length >= 5) {
        ctx.fillStyle = withAlpha(theme("sig-2"), 0.4); ctx.strokeStyle = withAlpha(theme("fg-1"), 0.6);
        ctx.beginPath(); ctx.moveTo(pxl, gy1);
        for (let b = 0; b < BINS; b++) {
          const yTop = yOf(GRAPH_BOTTOM + b + 1, gy0, gh), yBot = yOf(GRAPH_BOTTOM + b, gy0, gh);
          const wd = (hist[b] / mx) * (profW - 2);
          ctx.lineTo(pxl + wd, yBot); ctx.lineTo(pxl + wd, yTop);
        }
        ctx.lineTo(pxl, gy0); ctx.closePath(); ctx.fill(); ctx.stroke();
        const sorted = vals2.slice().sort((a, b) => a - b);
        const med = sorted[sorted.length >> 1];
        const ym = Math.round(yOf(med, gy0, gh)) + 0.5;
        ctx.strokeStyle = theme("target"); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(pxl, ym); ctx.lineTo(pxl + profW, ym); ctx.stroke(); ctx.lineWidth = 1;
        ctx.fillStyle = theme("target"); ctx.font = font(9); ctx.textAlign = "left"; ctx.textBaseline = "bottom";
        ctx.fillText(`~${med.toFixed(0)}`, pxl + 2, ym - 1);
      }
      ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText("분포 S", pxl + profW / 2, gy1 + 3);
    }
  }
}
