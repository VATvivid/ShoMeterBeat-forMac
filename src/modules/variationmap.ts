import type { Frame } from "../engine/frame";
import { getSource } from "../engine/instance";
import { inTauri, type SoundEvent } from "../engine/source";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

// Live Variation Map: every detected sound event (onset clip → 58-d feature vector
// from the engine) becomes a dot on a 2-D map (PCA of the standardised features over
// the recent window). Similar sounds cluster; clusters are formed online by a
// distance radius. When the same cluster fires several times in a row with nearly
// identical features, a repetition warning is raised — the question game audio
// randomisation is meant to answer ("do my footsteps / hits / shots really vary?").

const N_DIM = 58;
const POLL_MS = 200;
const PALETTE = ["sig", "peak", "sig-2", "target", "clip", "fg-1", "sig", "peak"];

interface Ev extends SoundEvent { z: Float32Array; x: number; y: number; cluster: number }
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
  private axes: Float32Array[] = [new Float32Array(N_DIM), new Float32Array(N_DIM)];
  private axesReady = false;
  private warn = { text: "", until: 0, ids: [] as number[] };
  private clock = 0;
  private lastEventClock = 0;
  private sentK = -1;

  private get windowN() { return modSetting(this.id, "window", 200); }
  private get radius() { return modSetting(this.id, "radius", 4.5); }
  private get repeatN() { return modSetting(this.id, "repeat", 3); }
  private get similar() { return modSetting(this.id, "similar", 2.0); }
  private get onsetK() { return modSetting(this.id, "onsetK", 2.5); }

  settings(): SettingItem[] {
    return [
      { type: "select", label: "이벤트 창", value: String(this.windowN), options: [50, 100, 200, 500].map((v) => ({ value: String(v), label: `최근 ${v}개` })), onChange: (v) => setModSetting(this.id, "window", Number(v)) },
      { type: "range", label: "군집 반경", value: this.radius, min: 2, max: 9, step: 0.5, format: (v) => v.toFixed(1), onChange: (v) => setModSetting(this.id, "radius", v) },
      { type: "range", label: "반복 판정 (연속 횟수)", value: this.repeatN, min: 2, max: 8, step: 1, format: (v) => `${v}회`, onChange: (v) => setModSetting(this.id, "repeat", v) },
      { type: "range", label: "동일 판정 거리", value: this.similar, min: 0.5, max: 5, step: 0.25, format: (v) => v.toFixed(2), onChange: (v) => setModSetting(this.id, "similar", v) },
      { type: "range", label: "온셋 감도 (σ)", value: this.onsetK, min: 1, max: 6, step: 0.25, format: (v) => v.toFixed(2), onChange: (v) => setModSetting(this.id, "onsetK", v) },
      { type: "action", label: "지도 초기화", onClick: () => { this.events = []; this.clusters = []; this.nextCluster = 1; this.axesReady = false; this.warn = { text: "", until: 0, ids: [] }; } },
    ];
  }

  headReadout() {
    const live = this.events.filter((e) => this.clock - e.t < 10).length;
    return `${this.events.length}개 · 군집 ${this.clusters.length} · 최근10s ${live}${this.warn.until > this.clock ? "  ⚠ 반복" : ""}`;
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
    const ev: Ev = { ...e, z: new Float32Array(N_DIM), x: 0, y: 0, cluster: 0 };
    this.events.push(ev);
    while (this.events.length > this.windowN) this.events.shift();
    this.restandardize();
    this.updateAxes();
    this.assignCluster(ev);
    this.project();
    this.checkRepetition();
    this.lastEventClock = this.clock;
  }

  /** Standardise features over the window (robust to scale differences between dims). */
  private restandardize() {
    const n = this.events.length;
    const mean = new Float32Array(N_DIM), std = new Float32Array(N_DIM);
    for (const e of this.events) for (let i = 0; i < N_DIM; i++) mean[i] += e.features[i] / n;
    for (const e of this.events) for (let i = 0; i < N_DIM; i++) std[i] += (e.features[i] - mean[i]) ** 2 / n;
    for (let i = 0; i < N_DIM; i++) std[i] = Math.sqrt(std[i]) || 1;
    for (const e of this.events) for (let i = 0; i < N_DIM; i++) e.z[i] = (e.features[i] - mean[i]) / std[i];
  }

  /** Top-2 principal axes of the standardised window (power iteration with deflation). */
  private updateAxes() {
    const n = this.events.length;
    if (n < 3) return;
    const cov = new Float32Array(N_DIM * N_DIM);
    for (const e of this.events) for (let i = 0; i < N_DIM; i++) { const zi = e.z[i]; for (let j = i; j < N_DIM; j++) cov[i * N_DIM + j] += zi * e.z[j] / n; }
    for (let i = 0; i < N_DIM; i++) for (let j = 0; j < i; j++) cov[i * N_DIM + j] = cov[j * N_DIM + i];
    const mul = (v: Float32Array) => { const o = new Float32Array(N_DIM); for (let i = 0; i < N_DIM; i++) { let s = 0; for (let j = 0; j < N_DIM; j++) s += cov[i * N_DIM + j] * v[j]; o[i] = s; } return o; };
    const norm = (v: Float32Array) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; for (let i = 0; i < N_DIM; i++) v[i] /= s; return v; };
    const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < N_DIM; i++) s += a[i] * b[i]; return s; };
    const prev = this.axes;
    const axes: Float32Array[] = [];
    for (let k = 0; k < 2; k++) {
      let v: Float32Array = this.axesReady ? Float32Array.from(prev[k]) : new Float32Array(N_DIM).map((_, i) => Math.sin(i * (k + 1) + 0.3));
      norm(v);
      for (let it = 0; it < 25; it++) {
        let w = mul(v);
        for (const a of axes) { const d = dot(w, a); for (let i = 0; i < N_DIM; i++) w[i] -= d * a[i]; }
        v = norm(w);
      }
      if (this.axesReady && dot(v, prev[k]) < 0) for (let i = 0; i < N_DIM; i++) v[i] = -v[i]; // keep orientation stable
      axes.push(v);
    }
    this.axes = axes;
    this.axesReady = true;
  }

  private project() {
    if (!this.axesReady) return;
    for (const e of this.events) {
      let x = 0, y = 0;
      for (let i = 0; i < N_DIM; i++) { x += e.z[i] * this.axes[0][i]; y += e.z[i] * this.axes[1][i]; }
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

  private dist(a: Float32Array, b: Float32Array) { let s = 0; for (let i = 0; i < N_DIM; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s); }

  private assignCluster(ev: Ev) {
    let best: Cluster | null = null, bd = Infinity;
    for (const c of this.clusters) { const d = this.dist(ev.z, c.center); if (d < bd) { bd = d; best = c; } }
    if (best && bd <= this.radius) {
      best.n++; best.lastT = ev.t;
      const a = Math.min(0.3, 1 / best.n);
      for (let i = 0; i < N_DIM; i++) best.center[i] += (ev.z[i] - best.center[i]) * a;
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

  private checkRepetition() {
    const k = this.repeatN;
    if (this.events.length < k) return;
    const last = this.events.slice(-k);
    const cid = last[0].cluster;
    if (!last.every((e) => e.cluster === cid)) return;
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
    const listW = w > 320 ? 118 : 0;
    const x0 = 10, x1 = w - listW - 8, y0 = 10, y1 = h - 10;
    const pw = x1 - x0, ph = y1 - y0;
    if (pw < 40 || ph < 40) return;

    // map frame + axes
    ctx.strokeStyle = theme("grid"); ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, pw - 1, ph - 1);
    const cx = x0 + pw / 2, cy = y0 + ph / 2;
    ctx.beginPath(); ctx.moveTo(x0, Math.round(cy) + 0.5); ctx.lineTo(x1, Math.round(cy) + 0.5); ctx.moveTo(Math.round(cx) + 0.5, y0); ctx.lineTo(Math.round(cx) + 0.5, y1); ctx.stroke();

    const evs = this.events;
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
      ctx.fillStyle = withAlpha(colorOf(c.id), 0.9); ctx.font = font(10, 600); ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText(`C${c.id}`, p.x, p.y - r - 2);
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
      const alpha = Math.max(0.15, 1 - age / 60);
      ctx.fillStyle = withAlpha(colorOf(e.cluster), alpha);
      const r = warnSet.has(e.seq) ? 5 : 3.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      if (warnSet.has(e.seq)) { ctx.strokeStyle = theme("clip"); ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1; }
    }
    // newest event highlight
    const last = evs[evs.length - 1];
    { const p = px(last); const t = Math.max(0, 1 - (this.clock - this.lastEventClock) / 0.6); if (t > 0) { ctx.strokeStyle = withAlpha(theme("fg-0"), t); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, 6 + 10 * (1 - t), 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1; } }

    // warning banner
    if (this.warn.until > this.clock) {
      ctx.fillStyle = withAlpha(theme("clip"), 0.18); ctx.fillRect(x0 + 1, y0 + 1, pw - 2, 20);
      ctx.fillStyle = theme("clip"); ctx.font = font(11, 600); ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(`⚠ ${this.warn.text}`, x0 + 8, y0 + 11);
    }
    ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "right"; ctx.textBaseline = "bottom";
    ctx.fillText("PCA-1 →   ↑ PCA-2", x1 - 4, y1 - 3);

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
}
