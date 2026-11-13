import type { Frame } from "../engine/frame";
import { getSource } from "../engine/instance";
import { inTauri, type SoundEvent } from "../engine/source";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

// Live Variation Map: every detected sound event (onset clip → 58-d feature vector
// from the engine, see src-tauri/src/audio/events.rs) becomes a dot on a 2-D map (PCA
// of the standardised, group-weighted features over the recent window). Similar sounds
// cluster; clusters are formed online by a distance radius. When the same cluster fires
// several times in a row with nearly identical features, a repetition warning is raised
// — the question game audio randomisation is meant to answer ("do my footsteps / hits /
// shots really vary?").
//
// Feature groups (so brightness alone cannot dominate the map):
//   음색 timbre  — 12 band means of the spectro-temporal patch + centroid / bandwidth /
//                 roll-off / flatness / zero-crossing rate
//   시간 envelope — 48 patch deviations from the band mean (how each band's energy moves
//                 across attack / early / body / tail) + attack / decay / length
//   세기 level   — crest, peak
// Each group gets the same total weight by default (sliders 0…2 in the menu). The
// novelty strip under the map shows, per hit, how far it is from the previous hit of
// the same cluster (as a share of the cluster radius) and which group changed most.
//
// Combo: one chain, the way a fighting game counts — consecutive hits of the *same*
// cluster that each differ from every earlier hit (beyond the 동일 distance) count up,
// with a burst at the new dot and a counter that grows and changes colour. The chain
// ends when a hit repeats (red REPEAT flash), when the sound switches to another cluster
// (fresh ×1), or when no hit arrives within 콤보 유지 시간 (default 3 s; the counter shows
// the remaining time as a shrinking bar and fades out). Chains are not kept per cluster,
// so coming back to an old sound never resumes an old count. Several onsets inside one
// sound (within COMBO_MIN_GAP) count once, so one hit is one step.

const N_DIM = 58;
const N_VIEW = 70; // 12 band means + 48 shape + 4 spectral + zcr + 3 envelope + 2 level
const GROUP_NAMES = ["음색", "시간", "세기"] as const;
const GROUP_SHORT = ["음", "시", "세"];
const POLL_MS = 200;
const COMBO_MIN_GAP = 0.25; // onsets closer than this to the last counted hit are the same sound (swing + impact + ring) → one combo step
const PALETTE = ["sig", "peak", "sig-2", "target", "clip", "fg-1", "sig", "peak"];

/** Group of every view dimension: 0 timbre, 1 envelope, 2 level. */
const GROUP = new Uint8Array(N_VIEW);
for (let i = 0; i < 12; i++) GROUP[i] = 0;
for (let i = 12; i < 60; i++) GROUP[i] = 1;
for (let i = 60; i < 64; i++) GROUP[i] = 0;
GROUP[64] = 1; GROUP[65] = 1; GROUP[66] = 1;
GROUP[67] = 2; GROUP[68] = 2;
GROUP[69] = 0; // zcr
const GROUP_N = [0, 0, 0];
for (const g of GROUP) GROUP_N[g]++;

/** Floor for each dimension's standard deviation, in the dimension's own unit. Standardising
 *  over the window alone would stretch a set of near-identical sounds to unit variance in
 *  every dimension (so nothing could ever cluster); with the floors, two takes of the same
 *  sound stay within a few units while different sounds sit ten or more apart. */
const STD_FLOOR = new Float32Array(N_VIEW);
for (let i = 0; i < 60; i++) STD_FLOOR[i] = 3;          // band means / shape: 3 dB
STD_FLOOR[60] = 0.25; STD_FLOOR[61] = 0.25; STD_FLOOR[62] = 0.25; // centroid / bandwidth / roll-off (log2 Hz, oct)
STD_FLOOR[63] = 0.05;                                   // flatness
STD_FLOOR[64] = 8; STD_FLOOR[65] = 20; STD_FLOOR[66] = 40; // attack / decay / length (ms)
STD_FLOOR[67] = 3; STD_FLOOR[68] = 3;                   // crest / peak (dB)
STD_FLOOR[69] = 0.5;                                    // zero-crossing rate (/ms)

/** 58-d engine features → 70-d view (band means, shape deviations, descriptors). */
function toView(f: number[]): Float32Array {
  const v = new Float32Array(N_VIEW);
  for (let b = 0; b < 12; b++) {
    let m = 0;
    for (let s = 0; s < 4; s++) m += f[s * 12 + b];
    m /= 4;
    v[b] = m;
    for (let s = 0; s < 4; s++) v[12 + s * 12 + b] = f[s * 12 + b] - m;
  }
  v[60] = f[48]; v[61] = f[49]; v[62] = f[50]; v[63] = f[51];
  v[64] = f[52]; v[65] = f[53]; v[66] = f[54];
  v[67] = f[55]; v[68] = f[56];
  v[69] = f[57];
  return v;
}

interface Ev extends SoundEvent { v: Float32Array; z: Float32Array; x: number; y: number; cluster: number; nov: number; novG: number; novNew: boolean; novD: number; nearD: number }
interface Cluster { id: number; center: Float32Array; n: number; lastT: number; x: number; y: number; spread: number }

export class VariationMapModule implements Module {
  readonly id = "variation";
  readonly title = "Variation Map";
  private events: Ev[] = [];
  private clusters: Cluster[] = [];
  private nextCluster = 1;
  private lastSeq = 0;
  private lastPoll = 0;
  private polling = false;
  private axes: Float32Array[] = [new Float32Array(N_VIEW), new Float32Array(N_VIEW)];
  private axesReady = false;
  private warn = { text: "", until: 0, ids: [] as number[] };
  private clock = 0;
  private sentK = -1;
  private dimW = new Float32Array(N_VIEW);
  private combo = 0;              // combo of the newest event's cluster (shown)
  private comboBest = 0;
  private comboCluster = 0;
  private comboLastAt = -1e9;     // clock of the hit that last extended the chain
  private comboEnd = 0;           // 1 → 0 fade of the "combo over" note
  private comboEndN = 0;
  private lastRepeatAt = -1e9;   // clock of the last exact repeat (header flag for 3 s)
  private comboBump = 0;      // 1 right after an increment → 0
  private comboBreak = 0;     // 1 right after a repeat → 0
  private burst = 0;          // burst ring at the newest dot

  private get windowN() { return modSetting(this.id, "window", 200); }
  private get radius() { return modSetting(this.id, "radius", 6); }
  private get repeatN() { return modSetting(this.id, "repeat", 3); }
  private get comboHold() { return modSetting(this.id, "comboHold", 3); }
  /** 동일 distance: an asset replayed through loopback lands 2–4 units from its first play (frame
   *  jitter, room noise), different takes of one sound 2–9 — so 3.0 flags replays and only the
   *  most alike takes. Measured 2026-11-13 on game hit sounds. */
  private get similar() { return modSetting(this.id, "similar", 3.0); }
  private get onsetK() { return modSetting(this.id, "onsetK", 2.5); }
  private get showNovelty() { return modSetting(this.id, "novelty", true); }
  /** Default weights: 음색 1, 시간 1, 세기 0.5 — level has only two dimensions, and at full weight a
   *  3 dB peak difference between takes outweighed every timbre difference (measured 2026-11-13). */
  private groupW(g: number) { return modSetting(this.id, `w${g}`, g === 2 ? 0.5 : 1); }

  settings(): SettingItem[] {
    return [
      { type: "select", label: "이벤트 창", value: String(this.windowN), options: [50, 100, 200, 500].map((v) => ({ value: String(v), label: `최근 ${v}개` })), onChange: (v) => setModSetting(this.id, "window", Number(v)) },
      ...[0, 1, 2].map((g): SettingItem => ({ type: "range", label: `가중치 · ${GROUP_NAMES[g]}${g === 1 ? " (포락선)" : ""}`, value: this.groupW(g), min: 0, max: 2, step: 0.25, format: (v) => `×${v.toFixed(2)}`, onChange: (v) => { setModSetting(this.id, `w${g}`, v); this.rebuild(); } })),
      { type: "toggle", label: "신규성 띠 표시", value: this.showNovelty, onChange: (v) => setModSetting(this.id, "novelty", v) },
      { type: "range", label: "군집 반경", value: this.radius, min: 2, max: 12, step: 0.5, format: (v) => v.toFixed(1), onChange: (v) => setModSetting(this.id, "radius", v) },
      { type: "range", label: "콤보 유지 시간", value: this.comboHold, min: 1, max: 8, step: 0.5, format: (v) => `${v} s`, onChange: (v) => setModSetting(this.id, "comboHold", v) },
      { type: "range", label: "반복 판정 (연속 횟수)", value: this.repeatN, min: 2, max: 8, step: 1, format: (v) => `${v}회`, onChange: (v) => setModSetting(this.id, "repeat", v) },
      { type: "range", label: "동일 판정 거리", value: this.similar, min: 0.5, max: 8, step: 0.25, format: (v) => v.toFixed(2), onChange: (v) => setModSetting(this.id, "similar", v) },
      { type: "range", label: "온셋 감도 (σ)", value: this.onsetK, min: 1, max: 6, step: 0.25, format: (v) => v.toFixed(2), onChange: (v) => setModSetting(this.id, "onsetK", v) },
      { type: "action", label: "지도 초기화", onClick: () => { this.events = []; this.clusters = []; this.nextCluster = 1; this.axesReady = false; this.warn = { text: "", until: 0, ids: [] }; this.combo = 0; this.comboBest = 0; this.comboLastAt = -1e9; this.comboEnd = 0; } },
    ];
  }

  headReadout() {
    const live = this.events.filter((e) => this.clock - e.t < 10).length;
    const last = this.events[this.events.length - 1];
    const nov = last && this.events.length > 1 ? `  ·  Δ${Math.round(last.nov * 100)}% ${GROUP_NAMES[last.novG]}` : "";
    const combo = this.combo >= 2 ? `  ·  콤보 ×${this.combo}` : "";
    const rep = this.warn.until > this.clock || this.clock - this.lastRepeatAt < 3 ? "  ⚠ 반복" : "";
    return `${this.events.length}개 · 군집 ${this.clusters.length} · 최근10s ${live}${nov}${combo}${rep}`;
  }

  private poll() {
    const src = getSource();
    if (!src || this.polling) return;
    const now = performance.now();
    if (now - this.lastPoll < POLL_MS) return;
    this.lastPoll = now;
    this.polling = true;
    if (this.sentK !== this.onsetK) { this.sentK = this.onsetK; src.setOnsetK(this.onsetK).catch(() => {}); }
    src.eventsSince(this.lastSeq).then((evs) => { for (const e of evs) this.ingest(e); }).catch(() => {}).finally(() => { this.polling = false; });
  }

  private ingest(e: SoundEvent) {
    if (e.seq <= this.lastSeq || e.features.length !== N_DIM) return;
    this.lastSeq = e.seq;
    const ev: Ev = { ...e, v: toView(e.features), z: new Float32Array(N_VIEW), x: 0, y: 0, cluster: 0, nov: 0, novG: 0, novNew: true, novD: 0, nearD: Infinity };
    this.events.push(ev);
    while (this.events.length > this.windowN) this.events.shift();
    this.restandardize();
    this.updateAxes();
    this.assignCluster(ev);
    this.novelty(ev);
    this.updateCombo(ev);
    this.project();
    this.checkRepetition();
  }

  /** Re-weights and re-clusters the window after a weight change. */
  private rebuild() {
    if (!this.events.length) return;
    this.restandardize();
    this.axesReady = false;
    this.updateAxes();
    this.clusters = []; this.nextCluster = 1;
    for (const ev of this.events) { this.assignCluster(ev); }
    for (let i = 0; i < this.events.length; i++) this.novelty(this.events[i], i);
    this.project();
  }

  /** Standardise over the window, then scale each dim so every group's total variance is
   *  weight × (N_VIEW / 3) — with all weights 1 the overall scale matches plain z-scores,
   *  so the radius / 동일 distances keep their meaning. */
  private restandardize() {
    const n = this.events.length;
    const mean = new Float32Array(N_VIEW), std = new Float32Array(N_VIEW);
    for (const e of this.events) for (let i = 0; i < N_VIEW; i++) mean[i] += e.v[i] / n;
    for (const e of this.events) for (let i = 0; i < N_VIEW; i++) std[i] += (e.v[i] - mean[i]) ** 2 / n;
    for (let i = 0; i < N_VIEW; i++) std[i] = Math.max(STD_FLOOR[i], Math.sqrt(std[i]) || 0);
    for (let i = 0; i < N_VIEW; i++) this.dimW[i] = Math.sqrt(this.groupW(GROUP[i]) * (N_VIEW / 3) / GROUP_N[GROUP[i]]);
    for (const e of this.events) for (let i = 0; i < N_VIEW; i++) e.z[i] = ((e.v[i] - mean[i]) / std[i]) * this.dimW[i];
  }

  /** Top-2 principal axes of the weighted window (power iteration with deflation). */
  private updateAxes() {
    const n = this.events.length;
    if (n < 3) return;
    const cov = new Float32Array(N_VIEW * N_VIEW);
    for (const e of this.events) for (let i = 0; i < N_VIEW; i++) { const zi = e.z[i]; for (let j = i; j < N_VIEW; j++) cov[i * N_VIEW + j] += zi * e.z[j] / n; }
    for (let i = 0; i < N_VIEW; i++) for (let j = 0; j < i; j++) cov[i * N_VIEW + j] = cov[j * N_VIEW + i];
    const mul = (v: Float32Array) => { const o = new Float32Array(N_VIEW); for (let i = 0; i < N_VIEW; i++) { let s = 0; for (let j = 0; j < N_VIEW; j++) s += cov[i * N_VIEW + j] * v[j]; o[i] = s; } return o; };
    const norm = (v: Float32Array) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; for (let i = 0; i < N_VIEW; i++) v[i] /= s; return v; };
    const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < N_VIEW; i++) s += a[i] * b[i]; return s; };
    const prev = this.axes;
    const axes: Float32Array[] = [];
    for (let k = 0; k < 2; k++) {
      let v: Float32Array = this.axesReady ? Float32Array.from(prev[k]) : new Float32Array(N_VIEW).map((_, i) => Math.sin(i * (k + 1) + 0.3));
      norm(v);
      for (let it = 0; it < 25; it++) {
        let w = mul(v);
        for (const a of axes) { const d = dot(w, a); for (let i = 0; i < N_VIEW; i++) w[i] -= d * a[i]; }
        v = norm(w);
      }
      if (this.axesReady && dot(v, prev[k]) < 0) for (let i = 0; i < N_VIEW; i++) v[i] = -v[i]; // keep orientation stable
      axes.push(v);
    }
    this.axes = axes;
    this.axesReady = true;
  }

  private project() {
    if (!this.axesReady) return;
    for (const e of this.events) {
      let x = 0, y = 0;
      for (let i = 0; i < N_VIEW; i++) { x += e.z[i] * this.axes[0][i]; y += e.z[i] * this.axes[1][i]; }
      e.x = x; e.y = y;
    }
    for (const c of this.clusters) {
      const members = this.events.filter((e) => e.cluster === c.id);
      if (!members.length) continue;
      c.x = members.reduce((s, e) => s + e.x, 0) / members.length;
      c.y = members.reduce((s, e) => s + e.y, 0) / members.length;
      c.spread = Math.sqrt(members.reduce((s, e) => s + (e.x - c.x) ** 2 + (e.y - c.y) ** 2, 0) / members.length);
    }
  }

  private dist(a: Float32Array, b: Float32Array) { let s = 0; for (let i = 0; i < N_VIEW; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s); }

  /** Per-group distances (weighted z space). */
  private groupDist(a: Float32Array, b: Float32Array): number[] {
    const s = [0, 0, 0];
    for (let i = 0; i < N_VIEW; i++) s[GROUP[i]] += (a[i] - b[i]) ** 2;
    return s.map(Math.sqrt);
  }

  private assignCluster(ev: Ev) {
    let best: Cluster | null = null, bd = Infinity;
    for (const c of this.clusters) { const d = this.dist(ev.z, c.center); if (d < bd) { bd = d; best = c; } }
    if (best && bd <= this.radius) {
      best.n++; best.lastT = ev.t;
      const a = Math.min(0.3, 1 / best.n);
      for (let i = 0; i < N_VIEW; i++) best.center[i] += (ev.z[i] - best.center[i]) * a;
      ev.cluster = best.id;
    } else {
      const c: Cluster = { id: this.nextCluster++, center: Float32Array.from(ev.z), n: 1, lastT: ev.t, x: 0, y: 0, spread: 0 };
      this.clusters.push(c);
      ev.cluster = c.id;
    }
    // drop clusters with no members in the window
    const alive = new Set(this.events.map((e) => e.cluster));
    this.clusters = this.clusters.filter((c) => alive.has(c.id));
  }

  /** How different is this hit from the previous hit of the same cluster (or, for a new
   *  cluster, from the previous hit of any kind)? Share of the cluster radius, 0…1+. */
  private novelty(ev: Ev, idx = this.events.length - 1) {
    let prev: Ev | null = null;
    for (let i = idx - 1; i >= 0; i--) if (this.events[i].cluster === ev.cluster) { prev = this.events[i]; break; }
    ev.novNew = !prev;
    if (!prev) prev = idx > 0 ? this.events[idx - 1] : null;
    ev.nearD = Infinity;
    for (let i = idx - 1; i >= 0; i--) ev.nearD = Math.min(ev.nearD, this.dist(ev.z, this.events[i].z));
    if (!prev) { ev.nov = 0; ev.novG = 0; ev.novD = 0; return; }
    const gd = this.groupDist(ev.z, prev.z);
    ev.novD = Math.sqrt(gd[0] ** 2 + gd[1] ** 2 + gd[2] ** 2);
    ev.nov = Math.min(1.5, ev.novD / this.radius);
    ev.novG = gd.indexOf(Math.max(...gd));
  }

  /** Combo bookkeeping for the newest event (see the module comment). */
  private updateCombo(ev: Ev) {
    const repeat = ev.nearD <= this.similar;
    const since = this.clock - this.comboLastAt;
    if (since < COMBO_MIN_GAP) { this.burst = 1; return; } // sub-onset of the hit just counted
    const expired = since > this.comboHold;
    let n: number;
    if (repeat) { n = 0; this.comboBreak = 1; this.lastRepeatAt = this.clock; }
    else if (ev.novNew || ev.cluster !== this.comboCluster || expired || this.combo === 0) { n = 1; this.comboBump = 0.5; }
    else { n = this.combo + 1; this.comboBump = 1; }
    this.combo = n;
    this.comboCluster = ev.cluster;
    this.comboLastAt = this.clock;
    this.comboEnd = 0;
    this.comboBest = Math.max(this.comboBest, n);
    this.burst = 1;
  }

  private checkRepetition() {
    const k = this.repeatN;
    const newest = this.events[this.events.length - 1];
    if (!newest) return;
    const cid = newest.cluster;
    const last = this.events.filter((e) => e.cluster === cid).slice(-k);
    if (last.length < k) return;
    let maxD = 0;
    for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) maxD = Math.max(maxD, this.dist(last[i].z, last[j].z));
    if (maxD <= this.similar) {
      const sim = Math.max(0, Math.min(100, Math.round(100 * (1 - maxD / (this.similar * 2)))));
      this.warn = { text: `반복 감지: C${cid} 연속 ${k}회 (유사도 ${sim}%)`, until: this.clock + 6, ids: last.map((e) => e.seq) };
    }
  }

  draw(d: DrawCtx, _f: Frame) {
    const { ctx, w, h, dt } = d;
    this.clock += dt;
    this.poll();
    this.comboBump = Math.max(0, this.comboBump - dt * 3);
    this.comboBreak = Math.max(0, this.comboBreak - dt * 0.6);
    this.burst = Math.max(0, this.burst - dt * 1.8);
    // the chain expires when no hit arrives within 콤보 유지 시간
    if (this.combo > 0 && this.clock - this.comboLastAt > this.comboHold) { if (this.combo >= 2) { this.comboEnd = 1; this.comboEndN = this.combo; } this.combo = 0; }
    this.comboEnd = Math.max(0, this.comboEnd - dt * 0.8);
    const listW = w > 320 ? 118 : 0;
    const stripH = this.showNovelty && h > 170 ? 46 : 0;
    const x0 = 10, x1 = w - listW - 8, y0 = 10, y1 = h - 10 - stripH;
    const pw = x1 - x0, ph = y1 - y0;
    if (pw < 40 || ph < 40) return;

    // map frame + axes
    ctx.strokeStyle = theme("grid"); ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, pw - 1, ph - 1);
    const cx = x0 + pw / 2, cy = y0 + ph / 2;
    ctx.beginPath(); ctx.moveTo(x0, Math.round(cy) + 0.5); ctx.lineTo(x1, Math.round(cy) + 0.5); ctx.moveTo(Math.round(cx) + 0.5, y0); ctx.lineTo(Math.round(cx) + 0.5, y1); ctx.stroke();

    const evs = this.events;
    if (stripH) this.drawNovelty(ctx, x0, y1 + 6, pw, stripH - 6);
    if (evs.length < 3 || !this.axesReady) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(11); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(inTauri ? `이벤트 대기 중 (${evs.length}/3) — 효과음을 재생하세요` : "브라우저 미리보기", cx, cy);
      return;
    }
    // scale: fit 95 % of points
    const xs = evs.map((e) => Math.abs(e.x)).sort((a, b) => a - b), ys = evs.map((e) => Math.abs(e.y)).sort((a, b) => a - b);
    const sx = Math.max(1e-3, xs[Math.floor(xs.length * 0.95)] || 1), sy = Math.max(1e-3, ys[Math.floor(ys.length * 0.95)] || 1);
    const scale = Math.min(pw / 2 / sx, ph / 2 / sy) * 0.9;
    const px = (e: { x: number; y: number }) => ({ x: cx + e.x * scale, y: cy - e.y * scale });
    const colorOf = (cid: number) => theme(PALETTE[(cid - 1) % PALETTE.length]);

    // cluster rings
    for (const c of this.clusters) {
      const p = px(c);
      const r = Math.max(8, c.spread * scale * 1.4);
      ctx.strokeStyle = withAlpha(colorOf(c.id), 0.35); ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      if (c.n >= 2 || this.clock - c.lastT < 10) {
        ctx.fillStyle = withAlpha(colorOf(c.id), 0.9); ctx.font = font(10, 600); ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(`C${c.id}`, p.x, p.y - r - 2);
      }
    }
    // trail through the last 6 events
    const tail = evs.slice(-6);
    if (tail.length > 1) {
      ctx.strokeStyle = withAlpha(theme("fg-0"), 0.25); ctx.beginPath();
      tail.forEach((e, i) => { const p = px(e); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
      ctx.stroke();
    }
    // points (age fades)
    const warnSet = new Set(this.warn.until > this.clock ? this.warn.ids : []);
    for (const e of evs) {
      const p = px(e);
      const age = Math.max(0, this.clock - e.t);
      const alpha = age > 30 ? 0.18 : Math.max(0.3, 1 - age / 40);
      ctx.fillStyle = withAlpha(colorOf(e.cluster), alpha);
      const r = warnSet.has(e.seq) ? 5 : age > 30 ? 2 : 3.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      if (warnSet.has(e.seq)) { ctx.strokeStyle = theme("clip"); ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1; }
    }
    // newest event highlight
    const last = evs[evs.length - 1];
    {
      const p = px(last);
      if (this.burst > 0) {
        const k = this.burst, prog = 1 - k;
        const col = this.combo >= 10 ? theme("target") : this.combo >= 5 ? theme("peak") : this.combo >= 2 ? theme("sig") : theme("fg-0");
        const grow = 8 + 18 * prog + Math.min(30, this.combo * 2);
        ctx.strokeStyle = withAlpha(col, k); ctx.lineWidth = 1.5 + Math.min(3, this.combo * 0.3);
        ctx.beginPath(); ctx.arc(p.x, p.y, grow, 0, Math.PI * 2); ctx.stroke();
        if (this.combo >= 2) {
          const n = 8;
          for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + prog; const r0 = grow + 2, r1 = grow + 4 + 10 * k; ctx.beginPath(); ctx.moveTo(p.x + Math.cos(a) * r0, p.y + Math.sin(a) * r0); ctx.lineTo(p.x + Math.cos(a) * r1, p.y + Math.sin(a) * r1); ctx.stroke(); }
        }
        ctx.lineWidth = 1;
      }
    }
    // combo counter (top-right of the map)
    if (this.combo >= 2 || this.comboBreak > 0 || this.comboEnd > 0) {
      const tier = this.combo >= 10 ? theme("target") : this.combo >= 5 ? theme("peak") : theme("sig");
      const size = Math.min(34, 14 + this.combo * 1.6) * (1 + 0.25 * this.comboBump);
      const sx = this.comboBreak > 0 ? (Math.random() - 0.5) * 6 * this.comboBreak : 0;
      ctx.textAlign = "right"; ctx.textBaseline = "top";
      if (this.comboBreak > 0 && this.clock - this.lastRepeatAt < 1.7) {
        ctx.fillStyle = withAlpha(theme("clip"), Math.min(1, this.comboBreak * 1.5)); ctx.font = font(18, 700);
        ctx.fillText("REPEAT ✕", x1 - 8 + sx, y0 + 6);
        ctx.fillStyle = withAlpha(theme("fg-2"), this.comboBreak); ctx.font = font(10);
        ctx.fillText(`콤보 끊김 · 최고 ×${this.comboBest}`, x1 - 8, y0 + 28);
      } else if (this.combo >= 2) {
        ctx.fillStyle = withAlpha(tier, 0.95); ctx.font = font(size, 800);
        ctx.fillText(`×${this.combo}`, x1 - 8 + sx, y0 + 4);
        ctx.fillStyle = theme("fg-1"); ctx.font = font(10, 600);
        ctx.fillText(`VARIATION COMBO · C${this.comboCluster}${this.comboBest > this.combo ? ` · 최고 ×${this.comboBest}` : ""}`, x1 - 8, y0 + 6 + size);
        // remaining hold time as a shrinking bar under the label
        const rem = Math.max(0, 1 - (this.clock - this.comboLastAt) / this.comboHold);
        ctx.fillStyle = withAlpha(tier, 0.7); ctx.fillRect(x1 - 8 - 64 * rem, y0 + 6 + size + 14, 64 * rem, 2);
      } else if (this.comboEnd > 0) {
        ctx.fillStyle = withAlpha(theme("fg-2"), this.comboEnd); ctx.font = font(12, 600);
        ctx.fillText(`콤보 ×${this.comboEndN} 종료 · 최고 ×${this.comboBest}`, x1 - 8, y0 + 6);
      }
    }

    // warning banner
    if (this.warn.until > this.clock) {
      ctx.fillStyle = withAlpha(theme("clip"), 0.18); ctx.fillRect(x0 + 1, y0 + 1, pw - 2, 20);
      ctx.fillStyle = theme("clip"); ctx.font = font(11, 600); ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(`⚠ ${this.warn.text}`, x0 + 8, y0 + 11);
    }
    ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "right"; ctx.textBaseline = "bottom";
    const ws = [0, 1, 2].map((g) => this.groupW(g));
    const wTxt = ws.every((v) => v === 1) ? "" : `가중 ${ws.map((v, g) => `${GROUP_SHORT[g]}${v.toFixed(2).replace(/\.?0+$/, "")}`).join("·")}   `;
    ctx.fillText(`${wTxt}PCA-1 →   ↑ PCA-2`, x1 - 4, y1 - 3);

    // cluster list
    if (listW) {
      const lx = x1 + 8;
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillStyle = theme("fg-1"); ctx.font = font(10, 600);
      ctx.fillText("CLUSTERS", lx, y0);
      const sorted = [...this.clusters].sort((a, b) => b.lastT - a.lastT).slice(0, Math.floor((ph - 16) / 15));
      sorted.forEach((c, i) => {
        const y = y0 + 16 + i * 15;
        ctx.fillStyle = colorOf(c.id); ctx.beginPath(); ctx.arc(lx + 4, y + 6, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = theme("fg-0"); ctx.font = font(10);
        const ago = Math.max(0, this.clock - c.lastT);
        ctx.fillText(`C${c.id}  ×${c.n}`, lx + 12, y);
        ctx.fillStyle = theme("fg-2"); ctx.textAlign = "right";
        ctx.fillText(ago < 60 ? `${ago.toFixed(0)}s` : `${(ago / 60).toFixed(0)}m`, lx + listW - 10, y);
        ctx.textAlign = "left";
      });
    }
  }

  /** Novelty strip: one bar per recent hit — height = distance to the previous hit of the
   *  same cluster as a share of the cluster radius; red when within the 동일 distance
   *  (a repeat), hollow when the hit opened a new cluster; letter = group that changed most. */
  private drawNovelty(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
    const labelH = 11;
    const bh = h - labelH;
    const n = Math.max(8, Math.min(60, Math.floor(w / 7)));
    const shown = this.events.slice(-n);
    const bw = w / n;
    const colorOf = (cid: number) => theme(PALETTE[(cid - 1) % PALETTE.length]);
    ctx.strokeStyle = theme("grid"); ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, bh - 1);
    // 100 % line (= one cluster radius) and the 동일 line
    const yOf = (v: number) => y + bh - Math.min(1, v / 1.2) * (bh - 2) - 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x, Math.round(yOf(1)) + 0.5); ctx.lineTo(x + w, Math.round(yOf(1)) + 0.5); ctx.stroke();
    ctx.strokeStyle = withAlpha(theme("clip"), 0.5);
    const ySim = Math.round(yOf(this.similar / this.radius)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, ySim); ctx.lineTo(x + w, ySim); ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.font = font(9);
    for (let i = 0; i < shown.length; i++) {
      const e = shown[i];
      const bx = x + (n - shown.length + i) * bw + 1;
      const top = yOf(e.nov);
      const repeat = e.nearD <= this.similar;
      const col = repeat ? theme("clip") : colorOf(e.cluster);
      if (e.novNew) {
        ctx.strokeStyle = withAlpha(col, 0.8); ctx.strokeRect(Math.round(bx) + 0.5, Math.round(top) + 0.5, Math.max(1, bw - 2), y + bh - 1 - top);
      } else {
        ctx.fillStyle = withAlpha(col, i === shown.length - 1 ? 0.95 : 0.6);
        ctx.fillRect(bx, top, Math.max(1, bw - 2), y + bh - 1 - top);
      }
      if (bw >= 9 && !e.novNew) { ctx.fillStyle = repeat ? theme("clip") : theme("fg-2"); ctx.fillText(GROUP_SHORT[e.novG], bx + (bw - 2) / 2, y + bh + 1); }
    }
    ctx.textAlign = "left"; ctx.fillStyle = theme("fg-2"); ctx.font = font(9);
    const last = shown[shown.length - 1];
    const lastTxt = last && this.events.length > 1 ? (last.novNew ? "새 군집" : `직전 같은 군집 대비 ${Math.round(last.nov * 100)}% 다름 · 가장 달라진 것: ${GROUP_NAMES[last.novG]}${last.novD <= this.similar ? " · 동일 수준" : ""}`) : "신규성: 히트마다 직전 같은 군집 히트와의 거리(군집 반경 = 100 %)";
    ctx.fillText(lastTxt, x + 3, y + 2);
    ctx.textAlign = "right";
    ctx.fillText("음=음색 시=시간 세=세기", x + w - 3, y + bh + 1);
  }
}
