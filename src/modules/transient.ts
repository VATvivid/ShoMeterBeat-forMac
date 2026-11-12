import type { Frame } from "../engine/frame";
import { getSource } from "../engine/instance";
import { inTauri, type WaveOverview } from "../engine/source";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

// Transient / onset detector with tempo estimate. Uses the engine's 10 ms RMS
// envelope (same stream as the Waveform module): onset strength = dB rise of the
// envelope over its recent mean, peak-picked with a threshold and 60 ms spacing.
// BPM = autocorrelation of the strength signal over the last 8 s (60–200 BPM).

const PAD_L = 8, PAD_B = 18, PAD_T = 22, PAD_R = 8;
const POLL_MS = 33;
const RATE = 100; // envelope columns per second

export class TransientModule implements Module {
  readonly id = "transient";
  readonly title = "Transient";
  private ov: WaveOverview | null = null;
  private lastPoll = 0;
  private polling = false;
  private bpm = 0;
  private bpmConf = 0;
  private onsets: number[] = []; // column indices (absolute: head-based) of detected onsets
  private lastAbs = 0;
  private strength: number[] = []; // per column (absolute index aligned with lastAbs)
  private strengthStart = 0;
  private beatPhase = 0;

  private get seconds() { return modSetting(this.id, "seconds", 8); }
  private get threshold() { return modSetting(this.id, "threshold", 6); }

  settings(): SettingItem[] {
    return [
      { type: "select", label: "시간 범위", value: String(this.seconds), options: [4, 8, 16].map((v) => ({ value: String(v), label: `${v}초` })), onChange: (v) => setModSetting(this.id, "seconds", Number(v)) },
      { type: "range", label: "온셋 문턱 (dB)", value: this.threshold, min: 2, max: 15, step: 0.5, format: (v) => `${v.toFixed(1)} dB`, onChange: (v) => setModSetting(this.id, "threshold", v) },
    ];
  }

  headReadout() {
    const rate = this.onsets.length ? (this.onsets.filter((c) => this.lastAbs - c < RATE * 2).length / 2).toFixed(1) : "0.0";
    return `${this.bpm > 0 ? `${this.bpm.toFixed(0)} BPM (${Math.round(this.bpmConf * 100)}%)` : "BPM —"}  ·  ${rate}/s`;
  }

  private poll() {
    const src = getSource();
    if (!src || this.polling) return;
    const now = performance.now();
    if (now - this.lastPoll < POLL_MS) return;
    this.lastPoll = now;
    this.polling = true;
    src.waveOverview(this.seconds).then((o) => { if (o) this.ingest(o); }).catch(() => {}).finally(() => { this.polling = false; });
  }

  private ingest(o: WaveOverview) {
    this.ov = o;
    const n = o.cols.length / 3;
    const colFrames = o.sr / RATE;
    const absLast = Math.floor(o.head / colFrames); // absolute index of the newest column
    const absFirst = absLast - n + 1;
    // Rebuild strength for columns we haven't processed yet.
    if (this.strength.length === 0 || absFirst > this.strengthStart + this.strength.length) {
      this.strength = []; this.strengthStart = absFirst; this.onsets = [];
    }
    const dB = (c: number) => 20 * Math.log10(o.cols[3 * c + 2] + 1e-6);
    let abs = this.strengthStart + this.strength.length;
    while (abs <= absLast) {
      const c = abs - absFirst;
      if (c < 0) { abs++; continue; }
      // rise over the mean of the previous 8 columns (80 ms)
      let m = 0, k = 0;
      for (let j = Math.max(0, c - 8); j < c; j++) { m += dB(j); k++; }
      const s = k ? Math.max(0, dB(c) - m / k) : 0;
      this.strength.push(s);
      abs++;
    }
    // trim to the window
    const keep = this.seconds * RATE + 50;
    if (this.strength.length > keep) { const drop = this.strength.length - keep; this.strength.splice(0, drop); this.strengthStart += drop; }
    // peak-pick onsets on the newest columns
    const thr = this.threshold;
    const total = this.strength.length;
    for (let i = Math.max(2, total - 6); i < total - 1; i++) {
      const a = this.strengthStart + i;
      if (a <= this.lastAbs) continue;
      const s = this.strength[i];
      if (s >= thr && s >= this.strength[i - 1] && s >= this.strength[i + 1] && (!this.onsets.length || a - this.onsets[this.onsets.length - 1] >= 6)) {
        this.onsets.push(a);
        this.lastAbs = a;
      }
    }
    this.onsets = this.onsets.filter((c) => absLast - c < this.seconds * RATE);
    this.lastAbs = Math.max(this.lastAbs, absLast - 2);
    // tempo: autocorrelation of strength over the window, 60–200 BPM
    if (total > RATE * 3) {
      const minLag = Math.round(RATE * 60 / 200), maxLag = Math.round(RATE * 60 / 60);
      const x = this.strength;
      const mean = x.reduce((p, q) => p + q, 0) / total;
      let e0 = 0; for (let i = 0; i < total; i++) e0 += (x[i] - mean) ** 2;
      let best = 0, bestLag = 0;
      for (let lag = minLag; lag <= maxLag; lag++) {
        let s = 0; for (let i = 0; i + lag < total; i++) s += (x[i] - mean) * (x[i + lag] - mean);
        const r = e0 > 1e-9 ? s / e0 : 0;
        if (r > best) { best = r; bestLag = lag; }
      }
      if (bestLag > 0 && best > 0.15) {
        // prefer the shorter of lag / 2·lag when both are strong (octave guard)
        let lag = bestLag;
        const half = Math.round(lag / 2);
        if (half >= minLag) {
          let s = 0; for (let i = 0; i + half < total; i++) s += (x[i] - mean) * (x[i + half] - mean);
          if (s / e0 > best * 0.8) lag = half;
        }
        const bpm = 60 * RATE / lag;
        this.bpm = this.bpm > 0 ? this.bpm + (bpm - this.bpm) * 0.3 : bpm;
        this.bpmConf = Math.min(1, best);
      } else { this.bpmConf *= 0.9; if (this.bpmConf < 0.05) this.bpm = 0; }
    }
  }

  draw(d: DrawCtx, _f: Frame) {
    const { ctx, w, h, dt } = d;
    this.poll();
    const x0 = PAD_L, x1 = w - PAD_R, y0 = PAD_T, y1 = h - PAD_B;
    const pw = x1 - x0, ph = y1 - y0;
    if (pw < 20 || ph < 10) return;
    const n = this.strength.length, span = this.seconds * RATE;
    const xOfAbs = (a: number) => x1 - ((this.strengthStart + n - 1 - a) / span) * pw;

    // grid + threshold line
    ctx.strokeStyle = theme("grid"); ctx.lineWidth = 1;
    for (const k of [0.25, 0.5, 0.75]) { const y = Math.round(y1 - k * ph) + 0.5; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); }
    const thrY = y1 - Math.min(1, this.threshold / 24) * ph;
    ctx.strokeStyle = withAlpha(theme("target"), 0.7); ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x0, Math.round(thrY) + 0.5); ctx.lineTo(x1, Math.round(thrY) + 0.5); ctx.stroke(); ctx.setLineDash([]);

    // strength curve
    if (n > 1) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = xOfAbs(this.strengthStart + i), y = y1 - Math.min(1, this.strength[i] / 24) * ph;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.lineTo(x1, y1); ctx.lineTo(xOfAbs(this.strengthStart), y1); ctx.closePath();
      ctx.fillStyle = withAlpha(theme("sig"), 0.25); ctx.fill();
    }
    // onset ticks
    ctx.strokeStyle = theme("peak"); ctx.lineWidth = 1.5;
    for (const a of this.onsets) {
      const x = Math.round(xOfAbs(a)) + 0.5;
      if (x < x0) continue;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    }
    ctx.lineWidth = 1;
    // beat pulse
    if (this.bpm > 0) {
      this.beatPhase = (this.beatPhase + dt * this.bpm / 60) % 1;
      const r = 5 + 5 * Math.pow(1 - this.beatPhase, 3);
      ctx.fillStyle = withAlpha(theme("sig"), 0.4 + 0.6 * Math.pow(1 - this.beatPhase, 3));
      ctx.beginPath(); ctx.arc(x1 - 10, y0 - 10, r, 0, Math.PI * 2); ctx.fill();
    }
    // labels
    ctx.fillStyle = theme("fg-0"); ctx.font = font(13, 600); ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(this.bpm > 0 ? `${this.bpm.toFixed(0)} BPM` : "BPM —", x0, 3);
    ctx.fillStyle = theme("fg-2"); ctx.font = font(10);
    ctx.fillText(this.bpm > 0 ? `신뢰도 ${Math.round(this.bpmConf * 100)}%` : "", x0 + 70, 6);
    ctx.textAlign = "center";
    for (let s = 0; s <= this.seconds; s += this.seconds <= 8 ? 1 : 2) {
      const x = x1 - (s / this.seconds) * pw;
      ctx.fillStyle = theme("fg-1"); ctx.fillText(s === 0 ? "now" : `−${s}s`, x, y1 + 4);
    }
    if (!inTauri && n === 0) { ctx.fillStyle = theme("fg-2"); ctx.fillText("브라우저 미리보기", x0 + pw / 2, y0 + ph / 2); }
    void this.ov;
  }
}
