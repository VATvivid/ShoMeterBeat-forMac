import type { Frame } from "../engine/frame";
import { getSource } from "../engine/instance";
import { inTauri, OV_STRIDE, type WaveOverview } from "../engine/source";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

// Transient / onset detector with tempo estimate.
// Onset detection function: the engine's 10 ms spectral flux (sum of positive
// log-magnitude increases), minus its centred 1 s mean (±0.5 s → 0.5 s latency),
// half-wave rectified. A trailing mean biases the tempogram toward fast tempos.
// Tempo: autocorrelation of 6 s segments accumulated over time (decay 0.85 every 2 s)
// → harmonic summation (lag, 2·lag, 3·lag, 4·lag) → tempo prior centred at 110 BPM →
// parabolic interpolation → continuity (a new tempo must repeat before it is adopted).

const PAD_L = 8, PAD_B = 18, PAD_T = 22, PAD_R = 8;
const POLL_MS = 33;
const RATE = 100;
const SEG_S = 6, STEP_S = 2, DECAY = 0.85;
const LAG_MIN = Math.round(RATE * 60 / 200), LAG_MAX = Math.round(RATE * 60 / 60), ACF_LEN = RATE * 60 / 40 * 4 | 0;

export class TransientModule implements Module {
  readonly id = "transient";
  readonly title = "Transient";
  private lastPoll = 0;
  private polling = false;
  private bpm = 0;
  private bpmConf = 0;
  private candidate = { bpm: 0, count: 0 };
  private onsets: number[] = [];
  private od: number[] = [];      // onset detection function, absolute index = odStart + i
  private odStart = 0;
  private acc = new Float32Array(ACF_LEN);
  private lastAccAt = 0;           // absolute column index of the last accumulation
  private lastAbs = 0;
  private beatPhase = 0;
  private lastOnsetAbs = -1e9;

  private get seconds() { return modSetting(this.id, "seconds", 8); }
  private get sens() { return modSetting(this.id, "sens", 2.5); }
  private get priorBpm() { return modSetting(this.id, "prior", 110); }

  settings(): SettingItem[] {
    return [
      { type: "select", label: "시간 범위", value: String(this.seconds), options: [4, 8, 16].map((v) => ({ value: String(v), label: `${v}초` })), onChange: (v) => setModSetting(this.id, "seconds", Number(v)) },
      { type: "range", label: "온셋 감도", value: this.sens, min: 1, max: 6, step: 0.25, format: (v) => `${v.toFixed(2)}σ`, onChange: (v) => setModSetting(this.id, "sens", v) },
      { type: "select", label: "템포 사전 (장르)", value: String(this.priorBpm), options: [[85, "느림 (85)"], [110, "보통 (110)"], [130, "빠름 (130)"], [150, "매우 빠름 (150)"]].map(([v, l]) => ({ value: String(v), label: String(l) })), onChange: (v) => setModSetting(this.id, "prior", Number(v)) },
      { type: "action", label: "템포 초기화", onClick: () => { this.acc.fill(0); this.bpm = 0; this.bpmConf = 0; this.candidate = { bpm: 0, count: 0 }; } },
    ];
  }

  headReadout() {
    const n2 = this.onsets.filter((c) => this.lastAbs - c < RATE * 2).length / 2;
    return `${this.bpm > 0 ? `${this.bpm.toFixed(1)} BPM (${Math.round(this.bpmConf * 100)}%)` : "BPM —"}  ·  ${n2.toFixed(1)}/s`;
  }

  private poll() {
    const src = getSource();
    if (!src || this.polling) return;
    const now = performance.now();
    if (now - this.lastPoll < POLL_MS) return;
    this.lastPoll = now;
    this.polling = true;
    src.waveOverview(Math.max(this.seconds, SEG_S + 1)).then((o) => { if (o) this.ingest(o); }).catch(() => {}).finally(() => { this.polling = false; });
  }

  private ingest(o: WaveOverview) {
    const n = o.cols.length / OV_STRIDE;
    const colFrames = o.sr / RATE;
    const absLast = Math.floor(o.head / colFrames);
    const absFirst = absLast - n + 1;
    if (this.od.length === 0 || absFirst > this.odStart + this.od.length) {
      this.od = []; this.odStart = absFirst; this.onsets = []; this.lastAccAt = absFirst;
    }
    const HALF = RATE / 2;
    let abs = this.odStart + this.od.length;
    while (abs <= absLast - HALF) {
      const c = abs - absFirst;
      if (c < 0) { abs++; continue; }
      const lo = Math.max(0, c - HALF), hi = Math.min(n, c + HALF + 1);
      let sum = 0;
      for (let j = lo; j < hi; j++) sum += o.cols[OV_STRIDE * j + 3];
      this.od.push(Math.max(0, o.cols[OV_STRIDE * c + 3] - sum / (hi - lo)));
      abs++;
    }
    const keep = Math.max(this.seconds, SEG_S) * RATE + RATE;
    if (this.od.length > keep) { const drop = this.od.length - keep; this.od.splice(0, drop); this.odStart += drop; }

    // ---- onsets: local maxima above mean + sens·std of the window, ≥ 60 ms apart
    const total = this.od.length;
    if (total > 20) {
      const m = this.od.reduce((p, q) => p + q, 0) / total;
      const sd = Math.sqrt(this.od.reduce((p, q) => p + (q - m) ** 2, 0) / total) || 1e-6;
      const thr = m + this.sens * sd;
      for (let i = Math.max(2, total - 8); i < total - 1; i++) {
        const a = this.odStart + i;
        if (a <= this.lastAbs) continue;
        const s = this.od[i];
        if (s >= thr && s >= this.od[i - 1] && s >= this.od[i + 1] && a - this.lastOnsetAbs >= 6) {
          this.onsets.push(a); this.lastOnsetAbs = a;
        }
      }
      this.lastAbs = Math.max(this.lastAbs, absLast - 2);
      this.onsets = this.onsets.filter((c) => absLast - c < this.seconds * RATE);
    }

    // ---- tempo: accumulate a 6 s ACF every 2 s
    if (total >= SEG_S * RATE && absLast - this.lastAccAt >= STEP_S * RATE) {
      this.lastAccAt = absLast;
      const seg = this.od.slice(total - SEG_S * RATE);
      const mean = seg.reduce((p, q) => p + q, 0) / seg.length;
      const x = seg.map((v) => v - mean);
      let e0 = 0; for (const v of x) e0 += v * v;
      if (e0 > 1e-9) {
        for (let lag = 1; lag <= ACF_LEN; lag++) {
          let s = 0; for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag];
          this.acc[lag - 1] = this.acc[lag - 1] * DECAY + s / e0;
        }
        this.estimateTempo();
      }
    }
  }

  private estimateTempo() {
    const a = this.acc;
    const harm = (l: number) => {
      let v = a[l - 1];
      for (const [k, w] of [[2, 0.5], [3, 0.33], [4, 0.25]] as const) if (k * l - 1 < a.length) v += w * a[k * l - 1];
      return v;
    };
    const prior = (l: number) => Math.exp(-0.5 * (Math.log2((60 * RATE / l) / this.priorBpm) / 0.8) ** 2) + 0.25;
    const scores: number[] = [];
    let best = -Infinity, bestL = 0;
    for (let l = LAG_MIN; l <= LAG_MAX; l++) {
      const s = harm(l) * prior(l);
      scores.push(s);
      if (s > best) { best = s; bestL = l; }
    }
    if (bestL === 0 || best <= 0) { this.bpmConf *= 0.8; if (this.bpmConf < 0.05) this.bpm = 0; return; }
    // confidence: winner vs the strongest competing local maximum (> 8 % away in lag)
    let second = 0;
    for (let i = 1; i < scores.length - 1; i++) {
      const l = LAG_MIN + i;
      if (scores[i] > scores[i - 1] && scores[i] >= scores[i + 1] && Math.abs(l / bestL - 1) > 0.08) second = Math.max(second, scores[i]);
    }
    // parabolic refinement of the lag on the harmonic-summed curve
    const y0 = harm(bestL - 1), y1 = harm(bestL), y2 = harm(bestL + 1);
    const den = y0 - 2 * y1 + y2;
    const delta = Math.abs(den) > 1e-9 ? 0.5 * (y0 - y2) / den : 0;
    const bpm = 60 * RATE / (bestL + Math.max(-0.5, Math.min(0.5, delta)));
    const conf = Math.max(0, Math.min(1, 1 - Math.max(0, second) / best));
    // continuity: adopt a tempo that differs by > 6 % only after it repeats
    if (this.bpm === 0 || Math.abs(bpm / this.bpm - 1) < 0.06) {
      this.bpm = this.bpm === 0 ? bpm : this.bpm + (bpm - this.bpm) * 0.5;
      this.candidate = { bpm: 0, count: 0 };
    } else if (this.candidate.bpm > 0 && Math.abs(bpm / this.candidate.bpm - 1) < 0.06) {
      this.candidate.count++;
      if (this.candidate.count >= 2) { this.bpm = bpm; this.candidate = { bpm: 0, count: 0 }; }
    } else {
      this.candidate = { bpm, count: 1 };
    }
    this.bpmConf = this.bpmConf * 0.5 + conf * 0.5;
  }

  draw(d: DrawCtx, _f: Frame) {
    const { ctx, w, h, dt } = d;
    this.poll();
    const x0 = PAD_L, x1 = w - PAD_R, y0 = PAD_T, y1 = h - PAD_B;
    const pw = x1 - x0, ph = y1 - y0;
    if (pw < 20 || ph < 10) return;
    const n = this.od.length, span = this.seconds * RATE;
    const lastAbs = this.odStart + n - 1;
    const xOfAbs = (a: number) => x1 - ((lastAbs - a) / span) * pw;
    const scale = (() => { let m = 1e-6; for (let i = Math.max(0, n - span); i < n; i++) m = Math.max(m, this.od[i]); return m; })();

    ctx.strokeStyle = theme("grid"); ctx.lineWidth = 1;
    for (const k of [0.25, 0.5, 0.75]) { const y = Math.round(y1 - k * ph) + 0.5; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); }

    // onset detection function
    if (n > 1) {
      ctx.beginPath();
      let started = false;
      for (let i = Math.max(0, n - span); i < n; i++) {
        const x = xOfAbs(this.odStart + i), y = y1 - Math.min(1, this.od[i] / scale) * ph;
        started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
      }
      ctx.lineTo(x1, y1); ctx.lineTo(xOfAbs(this.odStart + Math.max(0, n - span)), y1); ctx.closePath();
      ctx.fillStyle = withAlpha(theme("sig"), 0.28); ctx.fill();
    }
    // onset ticks
    ctx.strokeStyle = theme("peak"); ctx.lineWidth = 1.5;
    for (const a of this.onsets) {
      const x = Math.round(xOfAbs(a)) + 0.5;
      if (x < x0) continue;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    }
    ctx.lineWidth = 1;
    // beat pulse + grid of predicted beats from the last onset
    if (this.bpm > 0) {
      this.beatPhase = (this.beatPhase + dt * this.bpm / 60) % 1;
      const r = 5 + 5 * Math.pow(1 - this.beatPhase, 3);
      ctx.fillStyle = withAlpha(theme("sig"), 0.4 + 0.6 * Math.pow(1 - this.beatPhase, 3));
      ctx.beginPath(); ctx.arc(x1 - 10, y0 - 10, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = theme("fg-0"); ctx.font = font(13, 600); ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(this.bpm > 0 ? `${this.bpm.toFixed(1)} BPM` : "BPM —", x0, 3);
    ctx.fillStyle = theme("fg-2"); ctx.font = font(10);
    if (this.bpm > 0) ctx.fillText(`신뢰도 ${Math.round(this.bpmConf * 100)}%${this.candidate.bpm > 0 ? `  · 후보 ${this.candidate.bpm.toFixed(0)}` : ""}`, x0 + 84, 6);
    ctx.textAlign = "center";
    for (let s = 0; s <= this.seconds; s += this.seconds <= 8 ? 1 : 2) {
      const x = x1 - (s / this.seconds) * pw;
      ctx.fillStyle = theme("fg-1"); ctx.fillText(s === 0 ? "now" : `−${s}s`, x, y1 + 4);
    }
    if (!inTauri && n === 0) { ctx.fillStyle = theme("fg-2"); ctx.fillText("브라우저 미리보기", x0 + pw / 2, y0 + ph / 2); }
  }
}
