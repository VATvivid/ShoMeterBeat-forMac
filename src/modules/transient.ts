import type { Frame } from "../engine/frame";
import { getSource } from "../engine/instance";
import { inTauri, OV_STRIDE, type WaveOverview } from "../engine/source";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

// Transient / onset detector with tempo estimate (mirrors src-tauri/src/audio/tempo.rs —
// keep the two in step).
// Onset detection function: the engine's 10 ms spectral flux (sum of positive
// log-magnitude increases), minus its centred 1 s mean (±0.5 s → 0.5 s latency),
// half-wave rectified, times an accent weight (the column's RMS over the loudest column
// within ±0.5 s) — the log flux is almost level-invariant, so without the weight a quiet
// hi-hat on every eighth reads like the kick and slow songs come out doubled.
// Tempo: autocorrelation of 6 s segments (widened by a 5-tap kernel so one-column click
// pulses interpolate between lags) accumulated over time (decay 0.85 every 2 s) →
// harmonic summation (lag, 2·lag, 3·lag, 4·lag) on a ½-column lag grid → wide prior
// (120 BPM ± 1 octave; or the user's genre prior) → octave tie-break: a half lag that is
// ≥ 90 % as strong wins, so a plain 160 BPM click (a tie by construction) is read as 160,
// not 80 → parabolic interpolation → continuity (a new tempo must repeat before it is
// adopted).
// Fast path: while the ACF has not locked yet (first 6 s), evenly spaced onsets give a
// provisional pulse BPM from the median inter-onset interval.
// The beat dot is phase-locked to the onsets (an onset within ±20 % of a predicted beat
// re-anchors the grid) and shifted forward by the 0.5 s analysis latency, so it pulses
// with the sound rather than half a second behind it.

const PAD_L = 8, PAD_B = 18, PAD_T = 22, PAD_R = 8;
const POLL_MS = 33;
const RATE = 100;
const SEG_S = 6, STEP_S = 2, DECAY = 0.85;
const LAG_MIN = RATE * 60 / 200, LAG_MAX = RATE * 60 / 60, ACF_LEN = RATE * 60 / 40 * 4 | 0;
const OCTAVE_TIE = 0.9;
const ACCENT_POW = 1;
const WIDEN = [0.25, 0.5, 1, 0.5, 0.25];
const HALF = RATE / 2;
/** Columns between an onset's audio and its appearance in `od` (centred mean + poll). */
const LATENCY_COLS = HALF + 3;

export class TransientModule implements Module {
  readonly id = "transient";
  readonly title = "BPM Checker";
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
  private lastOnsetAbs = -1e9;
  private ioiBpm = 0;              // provisional pulse BPM from evenly spaced onsets
  private anchorAbs = NaN;         // onset the beat grid is phased to
  private lastIngestMs = 0;        // performance.now() of the last overview ingest
  private absLast = 0;             // newest overview column at that ingest

  private get seconds() { return modSetting(this.id, "seconds", 8); }
  private get sens() { return modSetting(this.id, "sens", 2.5); }
  /** 0 = automatic (wide prior + octave tie-break); otherwise a genre centre in BPM. */
  private get priorBpm() { return modSetting(this.id, "prior", 0); }

  settings(): SettingItem[] {
    return [
      { type: "select", label: "시간 범위", value: String(this.seconds), options: [4, 8, 16].map((v) => ({ value: String(v), label: `${v}초` })), onChange: (v) => setModSetting(this.id, "seconds", Number(v)) },
      { type: "range", label: "온셋 감도", value: this.sens, min: 1, max: 6, step: 0.25, format: (v) => `${v.toFixed(2)}σ`, onChange: (v) => setModSetting(this.id, "sens", v) },
      { type: "select", label: "템포 사전", value: String(this.priorBpm), options: [[0, "자동 (기본)"], [85, "느림 (85)"], [110, "보통 (110)"], [130, "빠름 (130)"], [150, "매우 빠름 (150)"]].map(([v, l]) => ({ value: String(v), label: String(l) })), onChange: (v) => setModSetting(this.id, "prior", Number(v)) },
      { type: "action", label: "템포 초기화", onClick: () => this.resetTempo() },
    ];
  }

  private resetTempo() {
    this.acc.fill(0); this.bpm = 0; this.bpmConf = 0; this.candidate = { bpm: 0, count: 0 }; this.ioiBpm = 0; this.anchorAbs = NaN;
  }

  headReadout() {
    const n2 = this.onsets.filter((c) => this.lastAbs - c < RATE * 2).length / 2;
    const bpm = this.bpm > 0 ? `${this.bpm.toFixed(1)} BPM (${Math.round(this.bpmConf * 100)}%)` : this.ioiBpm > 0 ? `${this.ioiBpm.toFixed(1)} BPM (펄스)` : "BPM —";
    return `${bpm}  ·  ${n2.toFixed(1)}/s`;
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
    this.lastIngestMs = performance.now();
    this.absLast = absLast;
    if (this.od.length === 0 || absFirst > this.odStart + this.od.length) {
      this.od = []; this.odStart = absFirst; this.onsets = []; this.lastAccAt = absFirst; this.anchorAbs = NaN; this.ioiBpm = 0;
    }
    let abs = this.odStart + this.od.length;
    while (abs <= absLast - HALF) {
      const c = abs - absFirst;
      if (c < 0) { abs++; continue; }
      const lo = Math.max(0, c - HALF), hi = Math.min(n, c + HALF + 1);
      let sum = 0, mx = 0;
      for (let j = lo; j < hi; j++) { sum += o.cols[OV_STRIDE * j + 3]; mx = Math.max(mx, o.cols[OV_STRIDE * j + 2]); }
      const flux = Math.max(0, o.cols[OV_STRIDE * c + 3] - sum / (hi - lo));
      // the column's own level = max RMS of c−1…c+1 (a click that starts late in its
      // column has a partial RMS there but its flux peaks there)
      let own = 0;
      for (let j = Math.max(0, c - 1); j <= Math.min(n - 1, c + 1); j++) own = Math.max(own, o.cols[OV_STRIDE * j + 2]);
      const accent = mx > 1e-9 ? Math.pow(Math.min(1, own / mx), ACCENT_POW) : 0;
      this.od.push(flux * accent);
      abs++;
    }
    const keep = Math.max(this.seconds, SEG_S) * RATE + RATE;
    if (this.od.length > keep) { const drop = this.od.length - keep; this.od.splice(0, drop); this.odStart += drop; }

    // ---- onsets: local maxima above mean + sens·std of the window, ≥ 60 ms apart.
    // `lastAbs` = last od column already examined (od runs 0.5 s behind the overview head;
    // comparing against the head here skipped every column after the first poll — fixed 2026-11-17)
    const total = this.od.length;
    if (total > 20) {
      const m = this.od.reduce((p, q) => p + q, 0) / total;
      const sd = Math.sqrt(this.od.reduce((p, q) => p + (q - m) ** 2, 0) / total) || 1e-6;
      const thr = m + this.sens * sd;
      const first = Math.max(2, this.lastAbs + 1 - this.odStart);
      for (let i = first; i < total - 1; i++) {
        const a = this.odStart + i;
        const s = this.od[i];
        if (s >= thr && s >= this.od[i - 1] && s >= this.od[i + 1] && a - this.lastOnsetAbs >= 6) {
          this.onsets.push(a); this.lastOnsetAbs = a;
          this.onOnset(a);
        }
      }
      this.lastAbs = this.odStart + total - 2;
      this.onsets = this.onsets.filter((c) => absLast - c < this.seconds * RATE);
    }

    // ---- tempo: accumulate a 6 s ACF every 2 s
    if (total >= SEG_S * RATE && absLast - this.lastAccAt >= STEP_S * RATE) {
      this.lastAccAt = absLast;
      if (this.accumulate(this.od.slice(total - SEG_S * RATE))) this.estimateTempo();
    }
  }

  /** New onset at absolute column `a`: re-anchor the beat grid when it lands near a beat, and refresh the pulse BPM. */
  private onOnset(a: number) {
    const period = this.bpm > 0 ? 6000 / this.bpm : 0;
    if (period > 0 && Number.isFinite(this.anchorAbs)) {
      const ph = ((a - this.anchorAbs) / period) % 1;
      if (ph < 0.2 || ph > 0.8) this.anchorAbs = a;
    } else {
      this.anchorAbs = a;
    }
    // provisional pulse: the last 5 inter-onset intervals agree within 4 % of their median
    const last = this.onsets.slice(-6);
    if (last.length >= 5) {
      const ioi = last.slice(1).map((v, i) => v - last[i]).sort((x, y) => x - y);
      const med = ioi[ioi.length >> 1];
      if (med >= LAG_MIN && med <= LAG_MAX * 2 && ioi.every((v) => Math.abs(v / med - 1) < 0.04)) this.ioiBpm = 6000 / med;
      else this.ioiBpm = 0;
    }
  }

  /** Widened, mean-removed, energy-normalised ACF of one segment added to `acc`; false when silent. */
  private accumulate(seg: number[]): boolean {
    const n = seg.length;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < WIDEN.length; k++) { const j = i + k - 2; if (j >= 0 && j < n) s += WIDEN[k] * seg[j]; }
      x[i] = s;
    }
    let mean = 0; for (let i = 0; i < n; i++) mean += x[i]; mean /= Math.max(1, n);
    let e0 = 0; for (let i = 0; i < n; i++) { x[i] -= mean; e0 += x[i] * x[i]; }
    if (e0 <= 1e-9) return false;
    for (let lag = 1; lag <= ACF_LEN; lag++) {
      let s = 0; for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
      this.acc[lag - 1] = this.acc[lag - 1] * DECAY + s / e0;
    }
    return true;
  }

  private acfAt(lag: number): number {
    const a = this.acc;
    if (lag < 1 || lag > a.length) return 0;
    const i = Math.floor(lag), t = lag - i;
    const a0 = a[i - 1], a1 = i < a.length ? a[i] : a0;
    return a0 + (a1 - a0) * t;
  }

  private harm(lag: number): number {
    let v = this.acfAt(lag);
    for (const [k, w] of [[2, 0.5], [3, 0.33], [4, 0.25]] as const) if (k * lag <= this.acc.length) v += w * this.acfAt(k * lag);
    return v;
  }

  private prior(lag: number): number {
    const user = this.priorBpm > 0;
    const centre = user ? this.priorBpm : 120, width = user ? 0.8 : 1.0;
    return Math.exp(-0.5 * (Math.log2((60 * RATE / lag) / centre) / width) ** 2) + 0.25;
  }

  private estimateTempo() {
    const nGrid = Math.round((LAG_MAX - LAG_MIN) * 2) + 1;
    const lagOf = (i: number) => LAG_MIN + i * 0.5;
    const scores: number[] = [];
    let best = -Infinity, bestI = 0;
    for (let i = 0; i < nGrid; i++) {
      const s = this.harm(lagOf(i)) * this.prior(lagOf(i));
      scores.push(s);
      if (s > best) { best = s; bestI = i; }
    }
    if (best <= 0) { this.bpmConf *= 0.8; if (this.bpmConf < 0.05) this.bpm = 0; return; }
    let bestL = lagOf(bestI);
    // octave tie-break: a half lag (double tempo) nearly as strong wins
    for (;;) {
      const h = bestL / 2;
      if (h < LAG_MIN) break;
      let hb = h, hv = -Infinity;
      for (let l = h - 1; l <= h + 1 + 1e-6; l += 0.25) { const v = this.harm(l); if (v > hv) { hv = v; hb = l; } }
      if (hb >= LAG_MIN && hv >= OCTAVE_TIE * this.harm(bestL)) bestL = hb; else break;
    }
    // confidence: winner vs the strongest competing local maximum (> 8 % away in lag),
    // excluding metrically related lags (½, 2, ⅓, 3, ⅔, 3/2, ¼, 4) — the octave question is
    // settled by the tie-break, and on a plain click those peaks are as tall as the winner
    // (the old figure sat at ~45 % on a metronome for that reason alone)
    let second = 0;
    for (let i = 1; i < scores.length - 1; i++) {
      const r = lagOf(i) / bestL;
      const metrical = [2, 0.5, 3, 1 / 3, 1.5, 2 / 3, 4, 0.25].some((m) => Math.abs(r / m - 1) < 0.06);
      if (scores[i] > scores[i - 1] && scores[i] >= scores[i + 1] && Math.abs(r - 1) > 0.08 && !metrical) second = Math.max(second, scores[i]);
    }
    // parabolic refinement of the lag on the harmonic-summed curve (½-column grid)
    const y0 = this.harm(bestL - 0.5), y1 = this.harm(bestL), y2 = this.harm(bestL + 0.5);
    const den = y0 - 2 * y1 + y2;
    const delta = Math.abs(den) > 1e-9 ? Math.max(-0.25, Math.min(0.25, 0.25 * (y0 - y2) / den)) : 0;
    const bpm = 60 * RATE / (bestL + delta);
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

  /** Beat phase 0..1 right now (0 = on the beat), latency-compensated; NaN without a grid. */
  private beatPhase(): number {
    const bpm = this.bpm > 0 ? this.bpm : this.ioiBpm;
    if (!(bpm > 0) || !Number.isFinite(this.anchorAbs)) return NaN;
    const nowAbs = this.absLast + (performance.now() - this.lastIngestMs) / (1000 / RATE) + LATENCY_COLS;
    const period = 6000 / bpm;
    return (((nowAbs - this.anchorAbs) / period) % 1 + 1) % 1;
  }

  draw(d: DrawCtx, _f: Frame) {
    const { ctx, w, h } = d;
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
    // predicted beat grid (from the anchored onset) under the ticks
    const gridBpm = this.bpm > 0 ? this.bpm : this.ioiBpm;
    if (gridBpm > 0 && Number.isFinite(this.anchorAbs)) {
      const period = 6000 / gridBpm;
      ctx.strokeStyle = withAlpha(theme("fg-2"), 0.5); ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      for (let a = this.anchorAbs; a > lastAbs - span; a -= period) {
        const x = Math.round(xOfAbs(a)) + 0.5;
        if (x < x0) break;
        ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    // onset ticks
    ctx.strokeStyle = theme("peak"); ctx.lineWidth = 1.5;
    for (const a of this.onsets) {
      const x = Math.round(xOfAbs(a)) + 0.5;
      if (x < x0) continue;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    }
    ctx.lineWidth = 1;
    // beat pulse, phase-locked to the onsets
    const phase = this.beatPhase();
    if (!Number.isNaN(phase)) {
      const r = 5 + 5 * Math.pow(1 - phase, 3);
      ctx.fillStyle = withAlpha(theme("sig"), 0.4 + 0.6 * Math.pow(1 - phase, 3));
      ctx.beginPath(); ctx.arc(x1 - 10, y0 - 10, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = theme("fg-0"); ctx.font = font(13, 600); ctx.textAlign = "left"; ctx.textBaseline = "top";
    if (this.bpm > 0) ctx.fillText(`${this.bpm.toFixed(1)} BPM`, x0, 3);
    else if (this.ioiBpm > 0) { ctx.fillStyle = theme("fg-1"); ctx.fillText(`${this.ioiBpm.toFixed(1)} BPM`, x0, 3); }
    else ctx.fillText("BPM —", x0, 3);
    ctx.fillStyle = theme("fg-2"); ctx.font = font(10);
    // the pulse BPM stays visible next to the ACF estimate: when the two disagree the onsets
    // themselves (what the loopback actually carries) are the first thing to check
    if (this.bpm > 0) ctx.fillText(`신뢰도 ${Math.round(this.bpmConf * 100)}%${this.candidate.bpm > 0 ? `  · 후보 ${this.candidate.bpm.toFixed(0)}` : ""}${this.ioiBpm > 0 ? `  · 펄스 ${this.ioiBpm.toFixed(1)}` : ""}${this.priorBpm > 0 ? `  · 사전 ${this.priorBpm}` : ""}`, x0 + 84, 6);
    else if (this.ioiBpm > 0) ctx.fillText("펄스 간격 (임시) · 템포 분석 중", x0 + 84, 6);
    ctx.textAlign = "center";
    for (let s = 0; s <= this.seconds; s += this.seconds <= 8 ? 1 : 2) {
      const x = x1 - (s / this.seconds) * pw;
      ctx.fillStyle = theme("fg-1"); ctx.fillText(s === 0 ? "now" : `−${s}s`, x, y1 + 4);
    }
    if (!inTauri && n === 0) { ctx.fillStyle = theme("fg-2"); ctx.fillText("브라우저 미리보기", x0 + pw / 2, y0 + ph / 2); }
  }
}
