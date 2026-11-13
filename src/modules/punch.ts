import type { Frame } from "../engine/frame";
import { getSource } from "../engine/instance";
import { inTauri, type PunchHit, type PunchStats } from "../engine/source";
import { font, theme, withAlpha } from "../theme";
import { ballistic, type DrawCtx, type Module, type SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

// Punch — an absolute "how hard does this hit" scale for SFX / UI sounds.
// The engine (src-tauri/src/audio/punch.rs) implements the Fenton & Lee perceptual punch
// model: transient separation → modified loudness weighting → octave-band regression
// weights → 280 ms block → dB re full-scale sine. Every onset becomes a *hit* with its
// punch (dB), weight/body (dB — the whole 500 ms hit, transient + body + tail), attack
// time, octave profile and a "flash" index (this app's own showiness heuristic).
//
// 강도 (strength) is what the score, the history bars and the glove follow. It is a
// blend of punch and body (default 35 % punch + 65 % body, in dB) mapped to a 0–100
// index that is dense at the top (γ = 2 over −45 … −10 dB), because game hits are
// mastered to the same peak and differ by only a few dB — those few dB must spread.
// Calibrated on a set of 36 game hit sounds (normal / double / critical tiers): punch
// alone was flat across tiers (±2 dB) while body stepped 2–3 dB per tier.
//
// Two views. "펀칭 머신" (default): an arcade punching-machine — a tower of lamps that
// shoots up to the hit, a three-digit score (index × 9.99), a rank word, the session
// best, and the glove. "분석": live bar, octave profile, hit history, session PM95.
// Differentiation: the score is absolute, but the glove size and the bar / number
// colours are *relative to the hits on screen* (range of the recent hits, ≥ 20 index
// points) so variants that differ by a few points still look clearly different.

const PAD = 8;
const IDX_LO = -45, IDX_HI = -10, IDX_GAMMA = 2;   // 강도 dB → 0…100
const DB_TOP = -8, DB_BOT = -42;                    // history bar scale in dB mode
const BAND_TOP = 0, BAND_BOT = -60;
const OCT_LABELS = ["63", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
/** 화려함 tiers → colours, cut to where real hits land (2026-11-13 loopback: game hits 40–51,
 *  a dull 70 Hz thump 38, a bright wide noise burst 68). < 40: nothing (plain glove).
 *  40–50: one warm colour. 50–60: four theme colours. ≥ 60: a rainbow that rotates with the clock. */
function hslHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return "#" + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}
function flashPalette(g: number, clock: number): string[] {
  if (g < 0.4) return [];
  if (g < 0.5) return [theme("target")];
  if (g < 0.6) return [theme("target"), theme("peak"), theme("sig"), theme("sig-2")];
  const h0 = (clock * 90) % 360;
  return [0, 1, 2, 3, 4, 5].map((i) => hslHex((h0 + i * 60) % 360, 0.9, 0.6));
}
const JAB_WIND = 0.06, JAB_HIT = 0.16, JAB_HOLD = 0.36; // punch motion phases (share of the jab): contact ~50–100 ms after the trigger, then the fist stays on the target until JAB_HOLD
const PRE_EDGE_DB = 8;                 // punchM rise over its slow average that fires the glove early
const POLL_MS = 100;
const HOLD_S = 2.5;
const SEGMENTS = 32;
const RANKS: [number, string, string][] = [[30, "WEAK", "약함"], [55, "GOOD", "보통"], [75, "STRONG", "강함"], [90, "POWERFUL", "아주 강함"], [101, "KO!", "최강"]];

interface Rect { x: number; y: number; w: number; h: number }

// Boxing-glove emoji (16×16, letters are theme tokens like the Emoji module): the glove
// grows with the last hit's 강도 and the glow / rays around it grow with its flash index.
const GLOVE_PAL: Record<string, string> = { k: "bg-3", r: "clip", w: "fg-0" };
const GLOVE: string[] = [
  "................",
  "......kkkkk.....",
  ".....krrrrrkk...",
  "....krrwrrrrrk..",
  "...krrwwrrrrrrk.",
  "..kkrrrrrrrrrrk.",
  ".kwwkrrrrrrrrrrk",
  ".kwwkrrrrrrrrrrk",
  ".kwwkrrrrrrrrrrk",
  ".kwwkkrrrrrrrrk.",
  ".kwwk.krrrrrrrk.",
  "..kk..kkrrrrrkk.",
  "......krrrrrrk..",
  ".......kkkkkk...",
  "................",
  "................",
];

type Basis = "blend" | "punch" | "body";
type View = "machine" | "analysis";

export class PunchModule implements Module {
  readonly id = "punch";
  readonly title = "Punch Machine";
  private hits: PunchHit[] = [];
  private lastSeq = 0;
  private stats: PunchStats = { momentary: -120, tsr: 0, pm95: -120, mean: -120, frames: 0 };
  private lastPoll = 0;
  private polling = false;
  private live = -120;
  private liveHold = -120;
  private holdAge = 0;
  private flashAnim = 0;
  private histRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private histBarW = 0;
  private histShown: PunchHit[] = [];
  private hover = -1;
  private clock = 0;
  private gloveScale = 0;
  private gloveGlow = 0;
  private jab = 0;              // 1 at a new hit → 0 (punch motion phase; slower for strong hits)
  private hitPow = 0;           // 강도 index / 100 of the last hit — every motion amplitude follows it
  private shakeT = 0;           // tile shake time left (s)
  private shakeDur = 0;
  private scorePop = 0;         // 1 → 0 digit pop after a hit
  private liveSlow = -120;      // slow punchM average for the early-trigger edge
  private fist = { x: 0, y: 0, size: 0 }; // contact point of the current punch (burst + sparks are anchored here)
  private contactSet = false;             // fist frozen at the moment of contact (later 강도 updates must not move it)
  private sparks: { x: number; y: number; vx: number; vy: number; life: number; max: number; col: string; w: number; h: number; rot: number; vr: number }[] = [];
  private preAt = -10;          // clock of the last early trigger (refractory + match window)
  private lastHitAt = -10;      // clock of the last engine hit (sub-onsets of one sound arrive < 0.3 s apart)
  // punching machine
  private tower = 0;            // lit fraction 0…1 (rises fast, holds, falls)
  private towerTarget = 0;
  private towerHold = 0;
  private towerPeak = 0;        // peak lamp hold
  private towerPeakAge = 0;
  private scoreShown = 0;       // counts up to the score
  private scoreTarget = 0;
  private best = 0;
  private bestFlash = 0;        // "NEW RECORD" flash timer
  private lastHitSeq = 0;

  private get histN() { return modSetting(this.id, "hist", 30); }
  private get scale() { return modSetting(this.id, "scale", "index") as "db" | "index"; }
  private get basis() { return modSetting(this.id, "basis", "blend") as Basis; }
  private get view() { return modSetting(this.id, "view", "machine") as View; }
  private get showFlash() { return modSetting(this.id, "flash", true); }
  private get showGlove() { return modSetting(this.id, "glove", true); }
  private get relative() { return modSetting(this.id, "relative", true); }
  private get ref(): PunchHit | null { return modSetting<PunchHit | null>(this.id, "ref", null); }

  settings(): SettingItem[] {
    return [
      { type: "select", label: "표시", value: this.view, options: [{ value: "machine", label: "펀칭 머신 (점수)" }, { value: "analysis", label: "분석 (프로파일 · 이력 · PM95)" }], onChange: (v) => setModSetting(this.id, "view", v) },
      { type: "select", label: "강도 기준", value: this.basis, options: [{ value: "blend", label: "합성 (타격 35 % + 무게 65 %)" }, { value: "punch", label: "타격(punch)만" }, { value: "body", label: "무게(body)만" }], onChange: (v) => setModSetting(this.id, "basis", v) },
      { type: "select", label: "강도 척도 (분석 보기)", value: this.scale, options: [{ value: "index", label: "0–100 지수 (−45 dB → 0, −10 dB → 100, 고점 조밀)" }, { value: "db", label: "dB (풀스케일 정현파 기준)" }], onChange: (v) => setModSetting(this.id, "scale", v) },
      { type: "select", label: "히트 이력", value: String(this.histN), options: [15, 30, 60].map((v) => ({ value: String(v), label: `최근 ${v}개` })), onChange: (v) => setModSetting(this.id, "hist", Number(v)) },
      { type: "toggle", label: "화려함 지수 표시", value: this.showFlash, onChange: (v) => setModSetting(this.id, "flash", v) },
      { type: "toggle", label: "글러브 이모지", value: this.showGlove, onChange: (v) => setModSetting(this.id, "glove", v) },
      { type: "toggle", label: "크기·색을 최근 히트 범위에 맞춤 (상대 표시)", value: this.relative, onChange: (v) => setModSetting(this.id, "relative", v) },
      { type: "action", label: "마지막 히트를 기준으로", onClick: () => { const h = this.hits[this.hits.length - 1]; if (h) setModSetting(this.id, "ref", h); } },
      { type: "action", label: "기준 해제", onClick: () => setModSetting(this.id, "ref", null) },
      { type: "action", label: "최고 점수 초기화", onClick: () => { this.best = 0; } },
      { type: "action", label: "이력·세션 통계 초기화", onClick: () => { this.hits = []; this.best = 0; getSource()?.punchReset().catch(() => {}); } },
    ];
  }

  /** 강도 in dB for a hit according to the basis setting. */
  private strengthDb(h: PunchHit) {
    const body = h.body_db ?? h.punch_db;
    return this.basis === "punch" ? h.punch_db : this.basis === "body" ? body : 0.35 * h.punch_db + 0.65 * body;
  }
  /** 0…1 position of a strength index among the recent hits (span padded to ≥ 20 points); absolute index/100 when off. */
  private rel(idx: number): number {
    if (!this.relative) return idx / 100;
    const shown = this.hits.slice(-this.histN);
    if (shown.length < 2) return idx / 100;
    let lo = Infinity, hi = -Infinity;
    for (const h of shown) { const v = this.index(this.strengthDb(h)); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const mid = (lo + hi) / 2, span = Math.max(20, hi - lo);
    return Math.max(0, Math.min(1, (idx - (mid - span / 2)) / span));
  }
  private tierColor(r: number): string { return r < 0.34 ? theme("fg-1") : r < 0.67 ? theme("sig") : theme("peak"); }
  private index(db: number) { return 100 * Math.pow(Math.max(0, Math.min(1, (db - IDX_LO) / (IDX_HI - IDX_LO))), IDX_GAMMA); }
  private score(h: PunchHit) { return Math.round(this.index(this.strengthDb(h)) * 9.99); }
  private rank(idx: number) { return RANKS.find(([lim]) => idx < lim) ?? RANKS[RANKS.length - 1]; }
  private fmtDb(db: number) { return `${db.toFixed(1).replace("-", "−")} dB`; }
  private fmt(db: number) { return this.scale === "index" ? `${this.index(db).toFixed(0)}` : this.fmtDb(db); }
  private delta(db: number) {
    const r = this.ref; if (!r) return "";
    const rd = this.strengthDb(r);
    const d = this.scale === "index" ? this.index(db) - this.index(rd) : db - rd;
    return `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(this.scale === "index" ? 0 : 1)}${this.scale === "index" ? "" : " dB"}`;
  }

  headReadout() {
    const h = this.hits[this.hits.length - 1];
    if (!h) return "히트 대기";
    if (this.view === "machine") return `SCORE ${String(this.score(h)).padStart(3, "0")} · BEST ${String(this.best).padStart(3, "0")}${this.showFlash ? ` · 화려함 ${Math.round(h.flash)}` : ""}`;
    const s = this.strengthDb(h);
    return `강도 ${this.fmt(s)}${this.showFlash ? ` · 화려함 ${Math.round(h.flash)}` : ""}${this.ref ? ` · 기준 ${this.delta(s)}` : ""}`;
  }

  mount(body: HTMLElement, isEditing: () => boolean) {
    body.addEventListener("pointermove", (e) => {
      const r = body.getBoundingClientRect();
      this.hover = this.barAt(e.clientX - r.left, e.clientY - r.top);
      body.style.cursor = this.hover >= 0 ? "pointer" : "";
    });
    body.addEventListener("pointerleave", () => { this.hover = -1; });
    body.addEventListener("pointerdown", (e) => {
      if (isEditing() || e.button !== 0) return;
      const r = body.getBoundingClientRect();
      const i = this.barAt(e.clientX - r.left, e.clientY - r.top);
      if (i < 0) return;
      const h = this.histShown[i];
      const cur = this.ref;
      setModSetting(this.id, "ref", cur && cur.seq === h.seq && cur.t === h.t ? null : h);
    });
  }

  private barAt(x: number, y: number): number {
    const r = this.histRect;
    if (this.histBarW <= 0 || x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) return -1;
    const i = Math.floor((x - r.x) / this.histBarW);
    return i >= 0 && i < this.histShown.length ? i : -1;
  }

  private poll() {
    const src = getSource();
    if (!src || this.polling) return;
    const now = performance.now();
    if (now - this.lastPoll < POLL_MS) return;
    this.lastPoll = now;
    this.polling = true;
    Promise.all([src.punchHitsSince(this.lastSeq), src.punchStatus()]).then(([hs, st]) => {
      for (const h of hs) {
        if (h.seq <= this.lastSeq) continue;
        this.lastSeq = h.seq;
        this.hits.push(h);
        this.flashAnim = 1;
      }
      while (this.hits.length > 200) this.hits.shift();
      this.stats = st;
    }).catch(() => {}).finally(() => { this.polling = false; });
  }

  /** Per-frame animation state shared by both views. */
  private animate(dt: number, f: Frame) {
    const target = f.punchM;
    this.live = ballistic(this.live, target, dt, 40);
    // Early trigger: the hit event comes through polling (≤ 100 ms) after the engine has
    // measured the attack, which reads as a beat late. The per-frame punchM jumps the moment
    // the transient starts, so a rise of PRE_EDGE_DB over its slow average fires the punch
    // right away with a provisional 강도; the real hit (below) only re-scales it.
    // One sound = one punch: no re-fire while a punch is in flight, and not within 0.3 s of the
    // last trigger (punchM steps up several times inside one hit; 2026-11-13 "여러 번 움직임")
    const edge = target > this.liveSlow + PRE_EDGE_DB && target > IDX_LO && this.jab <= 0 && this.clock - this.preAt > 0.3 && this.clock - this.lastHitAt > 0.3;
    this.liveSlow += (target - this.liveSlow) * Math.min(1, dt * 3);
    if (edge) {
      this.preAt = this.clock;
      this.hitPow = Math.max(0.15, this.index(target) / 100, this.hitPow * 0.85); // punchM is still filling its block: lean on the last hit's 강도
      this.jab = 1;
      this.contactSet = false;
    }
    if (target >= this.liveHold) { this.liveHold = target; this.holdAge = 0; }
    else { this.holdAge += dt; if (this.holdAge > HOLD_S) this.liveHold = ballistic(this.liveHold, target, dt, 20); }
    this.flashAnim = Math.max(0, this.flashAnim - dt * 2);
    this.clock += dt;
    this.jab = Math.max(0, this.jab - dt * (3.2 - 1.6 * this.hitPow)); // weak ~0.3 s, strong ~0.6 s
    // an early-fired punch waits on the target (end of the hold phase) for its engine hit, up to 0.7 s,
    // so the real 강도 lands where the fist already is instead of after the glove has come back
    if (this.preAt > this.lastHitAt && this.clock - this.preAt < 0.7 && this.jab > 0 && 1 - this.jab > JAB_HOLD - 0.02) this.jab = 1 - (JAB_HOLD - 0.02);
    this.shakeT = Math.max(0, this.shakeT - dt);
    this.scorePop = Math.max(0, this.scorePop - dt * 4);
    for (const q of this.sparks) { q.life += dt; q.x += q.vx * dt; q.y += q.vy * dt; q.vy += 240 * dt; q.vx *= 1 - 1.5 * dt; q.rot += q.vr * dt; }
    this.sparks = this.sparks.filter((q) => q.life < q.max);
    const last = this.hits[this.hits.length - 1] ?? null;
    {
      const ts = last ? this.rel(this.index(this.strengthDb(last))) : 0, tg = last ? last.flash / 100 : 0;
      const k = Math.min(1, dt * 8);
      this.gloveScale += (ts - this.gloveScale) * k;
      this.gloveGlow += (tg - this.gloveGlow) * k;
    }
    // punching machine: new hit → tower shoots up, score counts up, best updates
    if (last && last.seq !== this.lastHitSeq) {
      this.lastHitSeq = last.seq;
      const idx = this.index(this.strengthDb(last));
      // punch motion + impact: wind-up, thrust, contact burst, tile shake and digit pop,
      // all scaled by the hit's 강도 (a weak tap barely nudges, a KO hit rocks the tile)
      this.hitPow = idx / 100;
      // engine hits closer than 0.3 s are sub-onsets of the same sound: re-scale only, no new
      // swing and no second spark burst. A hit within 0.8 s of an early trigger belongs to it.
      const newSound = this.clock - this.lastHitAt > 0.3;
      const ownsSwing = this.clock - this.preAt < 0.8 || this.jab > 0;
      this.lastHitAt = this.clock;
      // 화려함 → sparks (from 48) and confetti (from 58) flying out of the fist
      const fl = last.flash / 100;
      const pal = flashPalette(fl, this.clock);
      const n = fl < 0.48 ? 0 : Math.round(8 + 40 * (fl - 0.48)), nc = fl >= 0.58 ? Math.round(8 + 30 * (fl - 0.58)) : 0;
      const sp = Math.max(30, this.fist.size) / 60;
      for (let i = 0; i < (newSound ? n + nc : 0); i++) {
        const a = Math.random() * Math.PI * 2, v = (40 + 140 * Math.random()) * (0.5 + sp) * (0.6 + 0.6 * fl);
        const confetti = i >= n;
        this.sparks.push({ x: this.fist.x, y: this.fist.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40 * sp, life: 0, max: confetti ? 0.9 + Math.random() * 0.5 : 0.45 + Math.random() * 0.4, col: pal[Math.floor(Math.random() * pal.length)] ?? theme("target"), w: confetti ? 3 + 3 * sp : 1.5 + sp, h: confetti ? 5 + 4 * sp : 1.5 + sp, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12 });
      }
      while (this.sparks.length > 160) this.sparks.shift();
      // swing only when nothing already represents this sound (no early trigger, no punch in flight)
      if (newSound && !ownsSwing) { this.jab = 1; this.contactSet = false; }
      else if (newSound && this.jab > 0 && 1 - this.jab >= JAB_HIT && 1 - this.jab < JAB_HOLD) { this.jab = 1 - JAB_HIT; this.contactSet = false; } // fist already on the target: land the real hit there (burst restarts at the real 강도)
      this.scorePop = 1;
      if (newSound) { this.shakeDur = 0.15 + 0.35 * this.hitPow; this.shakeT = this.shakeDur; }
      this.towerTarget = idx / 100;
      this.towerHold = 1.4;
      this.scoreTarget = this.score(last);
      if (this.scoreTarget > this.best) { this.best = this.scoreTarget; this.bestFlash = 2.5; }
    }
    if (this.tower < this.towerTarget) this.tower = Math.min(this.towerTarget, this.tower + dt * 3.2); // ~0.3 s to the top
    else if (this.towerHold > 0) this.towerHold -= dt;
    else { this.tower = Math.max(0, this.tower - dt * 0.55); if (this.tower <= 0.001) this.towerTarget = 0; }
    if (this.tower >= this.towerPeak) { this.towerPeak = this.tower; this.towerPeakAge = 0; }
    else { this.towerPeakAge += dt; if (this.towerPeakAge > 3) this.towerPeak = Math.max(this.tower, this.towerPeak - dt * 0.3); }
    if (this.scoreShown < this.scoreTarget) this.scoreShown = Math.min(this.scoreTarget, this.scoreShown + dt * Math.max(600, (this.scoreTarget - this.scoreShown) * 6));
    else if (this.scoreShown > this.scoreTarget) this.scoreShown = this.scoreTarget;
    this.bestFlash = Math.max(0, this.bestFlash - dt);
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    this.poll();
    this.animate(dt, f);
    if (this.view === "machine") {
      // tile shake after contact (amplitude ∝ 강도², decaying), then a white-out flash on KO-class hits
      const sh = this.shakeT > 0 ? (1.5 + 9 * this.hitPow * this.hitPow) * (this.shakeT / this.shakeDur) : 0;
      ctx.save();
      if (sh > 0) ctx.translate((Math.random() - 0.5) * 2 * sh, (Math.random() - 0.5) * 2 * sh);
      this.drawMachine(ctx, w, h);
      ctx.restore();
      const k = this.impactK();
      if (k > 0 && this.hitPow > 0.85) { ctx.fillStyle = withAlpha(theme("fg-0"), 0.3 * k * k * (this.hitPow - 0.85) / 0.15); ctx.fillRect(0, 0, w, h); }
    } else this.drawAnalysis(ctx, w, h, f);
  }

  // ---------------------------------------------------------------- punching machine
  private drawMachine(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const last = this.hits[this.hits.length - 1] ?? null;
    const tiny = w < 120 || h < 70, narrow = w < 260, short = h < 150;
    const towerW = tiny ? Math.max(14, w * 0.2) : Math.max(28, Math.min(64, w * 0.16));
    const x0 = PAD, y0 = PAD, y1 = h - PAD;
    // ---- lamp tower (bottom → top), coloured zones: weak / good / strong / powerful / KO
    const segH = (y1 - y0) / SEGMENTS;
    const zoneOf = (i: number) => { const p = (i + 0.5) / SEGMENTS * 100; return p < 30 ? theme("fg-1") : p < 55 ? theme("sig") : p < 75 ? theme("sig") : p < 90 ? theme("peak") : theme("clip"); };
    ctx.fillStyle = withAlpha(theme("bg-3"), 0.9);
    ctx.fillRect(x0, y0, towerW, y1 - y0);
    const litN = Math.round(this.tower * SEGMENTS);
    const peakN = Math.round(this.towerPeak * SEGMENTS);
    for (let i = 0; i < SEGMENTS; i++) {
      const sy = y1 - (i + 1) * segH + 1;
      const on = i < litN;
      const col = zoneOf(i);
      ctx.fillStyle = on ? col : withAlpha(col, 0.14);
      ctx.fillRect(x0 + 3, sy, towerW - 6, Math.max(1, segH - 2));
      if (on && i >= litN - 2) { ctx.fillStyle = withAlpha(theme("fg-0"), 0.35); ctx.fillRect(x0 + 3, sy, towerW - 6, Math.max(1, segH - 2)); }
    }
    if (peakN > 0 && peakN > litN) {
      const sy = y1 - peakN * segH + 1;
      ctx.fillStyle = theme("fg-0"); ctx.fillRect(x0 + 3, sy, towerW - 6, Math.max(1, segH - 2));
    }
    // zone ticks
    if (!tiny) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "left"; ctx.textBaseline = "middle";
      for (const [lim, word] of RANKS) if (lim <= 100) { const yy = y1 - (lim / 100) * (y1 - y0); ctx.fillRect(x0 + towerW, Math.round(yy), 4, 1); if (!narrow) ctx.fillText(word, x0 + towerW + 6, yy + 6); }
    }
    if (tiny) return;

    // ---- score panel
    // glove sits between the tower (+ rank words) and the score panel and punches to the right
    const gloveW = this.showGlove && !narrow ? Math.max(40, Math.min(120, Math.min(y1 - y0, w * 0.22))) : 0;
    const px0 = x0 + towerW + (narrow ? 10 : 58) + (gloveW ? Math.round(gloveW * 1.45) + 8 : 0); // room for the thrust so the fist lands in the gap, not on the digits
    const px1 = w - PAD;
    const pw = px1 - px0;
    if (pw < 40) return;
    let y = y0;
    ctx.textBaseline = "top"; ctx.textAlign = "left";
    ctx.fillStyle = theme("fg-1"); ctx.font = font(10, 600);
    ctx.fillText("SCORE", px0, y);
    const idx = last ? this.index(this.strengthDb(last)) : 0;
    const relPos = last ? this.rel(idx) : 0;
    const digits = String(Math.round(this.scoreShown)).padStart(3, "0");
    const bigPx = Math.max(22, Math.min(short ? 34 : 56, pw / 3.2)) * (1 + 0.3 * this.scorePop * this.hitPow); // pops on a hit
    ctx.font = font(bigPx, 700);
    ctx.fillStyle = last ? this.tierColor(relPos) : theme("fg-2");
    ctx.fillText(last ? digits : "000", px0, y + 10);
    const digitsW = ctx.measureText(digits).width;
    // rank word next to the score
    if (last) {
      const [, word, ko] = this.rank(idx);
      ctx.fillStyle = idx >= 90 ? theme("clip") : theme("fg-0"); ctx.font = font(Math.max(11, bigPx * 0.36), 700);
      ctx.fillText(word, px0 + digitsW + 12, y + 14);
      ctx.fillStyle = theme("fg-1"); ctx.font = font(10);
      ctx.fillText(ko, px0 + digitsW + 12, y + 14 + bigPx * 0.4);
    }
    y += 10 + bigPx + 6;
    // best + delta vs previous
    const prev = this.hits.length > 1 ? this.hits[this.hits.length - 2] : null;
    ctx.font = font(11, 600);
    const bestTxt = `BEST ${String(this.best).padStart(3, "0")}`;
    ctx.fillStyle = this.bestFlash > 0 && Math.floor(this.bestFlash * 4) % 2 === 0 ? theme("target") : theme("fg-1");
    ctx.fillText(bestTxt, px0, y);
    let x = px0 + ctx.measureText(bestTxt).width + 10;
    if (this.bestFlash > 0) { ctx.fillStyle = theme("target"); ctx.fillText("NEW RECORD!", x, y); x += ctx.measureText("NEW RECORD!").width + 10; }
    if (last && prev) {
      const dv = this.score(last) - this.score(prev);
      ctx.fillStyle = dv >= 0 ? theme("peak") : theme("fg-2");
      ctx.fillText(`${dv >= 0 ? "▲" : "▼"}${Math.abs(dv)}`, x, y);
    }
    y += 18;
    // stats line
    if (last && !short) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10);
      const parts = [`타격 ${this.fmtDb(last.punch_db)}`, `무게 ${this.fmtDb(last.body_db ?? last.punch_db)}`, `어택 ${last.attack_ms.toFixed(0)} ms`];
      if (this.showFlash) parts.push(`화려함 ${Math.round(last.flash)}`);
      if (this.ref) parts.push(`기준 대비 ${this.delta(this.strengthDb(last))}`);
      ctx.fillText(parts.join("  ·  ").slice(0, Math.floor(pw / 5.2)), px0, y);
      y += 16;
    }
    // compact history under the score
    const histH = y1 - y - 2;
    if (histH >= 36) {
      this.drawHistory(ctx, { x: px0, y: y + 4, w: pw, h: histH - 4 }, this.ref, true);
      this.histRect = { x: px0, y: y + 4, w: pw, h: histH - 4 };
    } else { this.histRect = { x: 0, y: 0, w: 0, h: 0 }; this.histBarW = 0; }
    if (gloveW) this.drawGlove(ctx, px0 - 8 - Math.round(gloveW * 1.45) + gloveW / 2, y0 + Math.min(y1 - y0, gloveW) / 2 + 8, Math.min(gloveW, y1 - y0), !!last);
    if (!inTauri && this.hits.length === 0) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10); ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.fillText("브라우저 미리보기", px0, y1);
    }
  }

  // ---------------------------------------------------------------- analysis view
  private drawAnalysis(ctx: CanvasRenderingContext2D, w: number, h: number, f: Frame) {
    const last = this.hits[this.hits.length - 1] ?? null;
    const ref = this.ref;
    const narrow = w < 240, short = h < 120, tiny = w < 120 || h < 70;
    const yOfDb = (v: number, y0: number, hh: number) => y0 + ((DB_TOP - Math.min(DB_TOP, Math.max(DB_BOT, v))) / (DB_TOP - DB_BOT)) * hh;

    let y = PAD;
    if (!tiny) {
      ctx.textBaseline = "top"; ctx.textAlign = "left";
      ctx.fillStyle = theme("fg-1"); ctx.font = font(10, 600);
      ctx.fillText("강도", PAD, y + 2);
      const lastRel = last ? this.rel(this.index(this.strengthDb(last))) : 0;
      ctx.fillStyle = last ? this.tierColor(lastRel) : theme("fg-2"); ctx.font = font(short ? 18 : 24, 600);
      const big = last ? this.fmt(this.strengthDb(last)) : "—";
      ctx.fillText(big, PAD + 32, y - 4);
      let x = PAD + 32 + ctx.measureText(big).width + 6;
      const prev = this.hits.length > 1 ? this.hits[this.hits.length - 2] : null;
      if (last && prev) {
        const a = this.strengthDb(last), b = this.strengthDb(prev);
        const dv = this.scale === "index" ? this.index(a) - this.index(b) : a - b;
        const txt = `${dv >= 0 ? "▲" : "▼"}${Math.abs(dv).toFixed(this.scale === "index" ? 0 : 1)}`;
        ctx.fillStyle = dv >= 0 ? theme("peak") : theme("fg-2"); ctx.font = font(12, 600);
        ctx.fillText(txt, x, y + 2);
        x += ctx.measureText(txt).width + 12;
      } else x += 8;
      if (last && !narrow) {
        const parts: [string, string][] = [["타격", this.fmtDb(last.punch_db)], ["무게", this.fmtDb(last.body_db ?? last.punch_db)], ["어택", `${last.attack_ms.toFixed(0)} ms`]];
        if (this.showFlash) parts.push(["화려함", `${Math.round(last.flash)}`]);
        if (ref) parts.push(["기준 대비", this.delta(this.strengthDb(last))]);
        for (const [k, v] of parts) {
          if (x + 70 > w - PAD) break;
          ctx.fillStyle = theme("fg-1"); ctx.font = font(10); ctx.fillText(k, x, y + 2);
          x += ctx.measureText(k).width + 4;
          ctx.fillStyle = k === "기준 대비" ? theme("peak") : theme("fg-0"); ctx.font = font(13, 500); ctx.fillText(v, x, y);
          x += ctx.measureText(v).width + 12;
        }
      }
      y += short ? 24 : 32;
    }
    const capH = tiny ? 0 : 14;
    const y1 = h - PAD - capH;
    if (!tiny) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10); ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      const s = this.stats;
      const txt = s.frames > 0
        ? `punch PM95 ${this.fmtDb(s.pm95)}  ·  평균 ${this.fmtDb(s.mean)}  ·  PM95M ${(s.pm95 - s.mean).toFixed(1)} dB  ·  TSR ${f.tsr.toFixed(0)} dB`
        : inTauri ? "소리를 기다리는 중 — 히트 막대를 클릭하면 기준이 됩니다" : "브라우저 미리보기";
      ctx.fillText(narrow ? txt.split("  ·  ").slice(0, 2).join(" · ") : txt, PAD, h - 2);
    }
    const ph = y1 - y;
    if (ph < 16) return;
    const liveW = narrow ? 0 : 14;
    const gloveW = this.showGlove && !tiny ? Math.max(40, Math.min(110, Math.min(ph, w * 0.22))) : 0;
    const profW = narrow ? 0 : Math.min(170, Math.max(80, (w - 2 * PAD - liveW - gloveW) * 0.34));
    const gap = 10;
    let x = PAD + (gloveW ? Math.round(gloveW * 1.45) + gap : 0); // glove first (left) with room for the thrust, punching right towards the meters
    if (liveW) {
      ctx.fillStyle = theme("bg-3"); ctx.fillRect(x, y, liveW, ph);
      const yv = yOfDb(this.live, y, ph);
      ctx.fillStyle = theme("sig"); ctx.fillRect(x, yv, liveW, y1 - yv);
      const yh = Math.round(yOfDb(this.liveHold, y, ph)) + 0.5;
      ctx.strokeStyle = theme("peak"); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, yh); ctx.lineTo(x + liveW, yh); ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "center"; ctx.textBaseline = "top";
      if (ph > 60) ctx.fillText("live", x + liveW / 2, y1 + 2);
      x += liveW + gap;
    }
    if (profW) {
      this.drawProfile(ctx, { x, y, w: profW, h: ph }, last, ref);
      x += profW + gap;
    }
    const histW = w - PAD - x;
    if (histW > 20) this.drawHistory(ctx, { x, y, w: histW, h: ph }, ref, false);
    this.histRect = { x, y, w: Math.max(0, histW), h: ph };
    if (gloveW) this.drawGlove(ctx, PAD + gloveW / 2, y + ph / 2, Math.min(gloveW, ph), !!last);
    if (!inTauri && this.hits.length === 0 && !tiny) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("브라우저 미리보기", x + histW / 2, y + ph / 2);
    }
  }

  /** Impact phase of the current punch: 1 at contact → 0 about half a jab later (0 while idle). */
  private impactK() {
    if (this.jab <= 0) return 0;
    const t = 1 - this.jab;
    return t < JAB_HIT ? 0 : Math.max(0, 1 - (t - JAB_HIT) / (1 - JAB_HIT));
  }

  /** Glove centred at (cx, cy); `side` is the column — a weak hit uses ~1/3 of it, a strong one all of it.
   *  Punch motion (phase = 1 − jab): wind-up (pull back to the left, squash), thrust to the right
   *  (stretched, speed lines), contact (flash, shockwave rings, impact lines at the fist) and a
   *  damped spring back with a wobble. Every amplitude follows the hit's 강도 (`hitPow`). */
  private drawGlove(ctx: CanvasRenderingContext2D, cx: number, cy: number, side: number, hasHit: boolean) {
    const s = this.gloveScale, g = this.gloveGlow, pw = this.hitPow;
    const size = side * (0.32 + 0.68 * s);
    const reach = side * (0.2 + 0.5 * pw);
    let dx = 0, sx = 1, sy = 1;
    if (this.jab > 0) {
      const t = 1 - this.jab;
      if (t < JAB_WIND) { const u = t / JAB_WIND; dx = side * 0.12 * pw * Math.sin(u * Math.PI / 2); sx = 1 - 0.1 * pw * u; sy = 1 + 0.06 * pw * u; }
      else if (t < JAB_HIT) { const u = (t - JAB_WIND) / (JAB_HIT - JAB_WIND); const e = 1 - Math.pow(1 - u, 3); dx = side * 0.12 * pw - e * (reach + side * 0.12 * pw); sx = 1 + 0.35 * pw * Math.sin(u * Math.PI); sy = 1 - 0.15 * pw * Math.sin(u * Math.PI); }
      else if (t < JAB_HOLD) { const u = (t - JAB_HIT) / (JAB_HOLD - JAB_HIT); dx = -reach; const sq = (1 - u) * 0.18 * pw; sx = 1 - sq; sy = 1 + sq * 0.7; } // fist stays on the target, impact squash easing out
      else { const u = (t - JAB_HOLD) / (1 - JAB_HOLD); dx = -reach * Math.exp(-3.5 * u) * Math.cos(u * Math.PI * 1.2); const wob = 0.12 * pw * Math.exp(-5 * u) * Math.sin(u * Math.PI * 3); sx = 1 - wob; sy = 1 + wob * 0.7; }
    }
    dx = -dx; // the motion above is written "forward = negative"; the glove punches to the right (2026-11-13 사용자)
    const k = this.impactK();
    const pal = flashPalette(g, this.clock);
    // anchor: predicted contact point until the fist lands, then frozen there for the rest of the punch
    if (!this.contactSet) {
      this.fist = { x: cx + reach + size * 0.5, y: cy, size };
      if (this.jab > 0 && 1 - this.jab >= JAB_HIT) this.contactSet = true;
    }
    ctx.save();
    ctx.globalAlpha = hasHit ? 1 : 0.35;
    // sparks / confetti from the last hit (tile coordinates, drawn under the glove)
    for (const q of this.sparks) {
      const u = q.life / q.max, a = u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85;
      ctx.fillStyle = withAlpha(q.col, a);
      ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.rot); ctx.fillRect(-q.w / 2, -q.h / 2, q.w, q.h); ctx.restore();
    }
    if (k > 0) {
      // contact burst at the fist: flash, shockwave ring (a second red one past 70), impact lines
      // — coloured from the 화려함 palette when there is one
      const q = 1 - k;
      const fx = this.fist.x, fy = cy;
      ctx.fillStyle = withAlpha(theme("target"), (0.15 + 0.5 * pw) * k);
      ctx.beginPath(); ctx.arc(fx, fy, size * (0.25 + 0.55 * pw) * (0.6 + 0.4 * q), 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = withAlpha(theme("peak"), (0.5 + 0.5 * pw) * k); ctx.lineWidth = Math.max(1, size * (0.03 + 0.1 * pw) * k);
      ctx.beginPath(); ctx.arc(fx, fy, size * (0.3 + q * (0.8 + 2.2 * pw)), 0, Math.PI * 2); ctx.stroke();
      if (pw > 0.7) {
        ctx.strokeStyle = withAlpha(theme("clip"), (pw - 0.7) * 2.5 * k); ctx.lineWidth = Math.max(1, size * 0.05 * k);
        ctx.beginPath(); ctx.arc(fx, fy, size * (0.2 + q * (1.5 + 3 * pw)), 0, Math.PI * 2); ctx.stroke();
      }
      const n = pw < 0.3 ? 6 : pw < 0.7 ? 10 : 14, r0 = size * (0.3 + 0.5 * q * pw), len = size * (0.15 + 1.3 * pw) * (0.4 + 0.6 * k);
      ctx.lineWidth = Math.max(1, size * (0.015 + 0.035 * pw));
      for (let i = 0; i < n; i++) {
        ctx.strokeStyle = withAlpha(pal.length >= 4 ? pal[i % pal.length] : theme("fg-0"), (0.4 + 0.6 * pw) * k);
        const a = (i / n) * Math.PI * 2 + (i % 2 ? 0.11 : 0);
        const l = len * (i % 3 === 0 ? 1 : 0.6);
        ctx.beginPath(); ctx.moveTo(fx + Math.cos(a) * r0, fy + Math.sin(a) * r0); ctx.lineTo(fx + Math.cos(a) * (r0 + l), fy + Math.sin(a) * (r0 + l)); ctx.stroke();
      }
    }
    if (this.jab > 0) {
      // speed lines behind (left of) the glove while it thrusts
      const t = 1 - this.jab;
      if (t > JAB_WIND && t < JAB_HIT + 0.12) {
        const u = Math.min(1, (t - JAB_WIND) / (JAB_HIT - JAB_WIND));
        const a = t < JAB_HIT ? 0.35 + 0.45 * pw : 0.8 * (1 - (t - JAB_HIT) / 0.12);
        ctx.strokeStyle = withAlpha(theme("fg-1"), a); ctx.lineWidth = Math.max(1, size / 28);
        const L = size * (0.25 + 0.9 * pw) * (0.4 + 0.6 * u);
        for (let i = 0; i < 4; i++) {
          const yy = cy + (i - 1.5) * size * 0.2, xr = cx + dx - size * 0.45;
          ctx.beginPath(); ctx.moveTo(xr, yy); ctx.lineTo(xr - L * (i % 2 ? 0.7 : 1), yy); ctx.stroke();
        }
      }
    }
    ctx.translate(cx + dx, cy);
    ctx.scale(-sx, sy); // sprite mirrored: the fist faces right
    if (pal.length) {
      // 화려함 glow: one colour (40–50), four colours (50–60), rotating rainbow (60+); rays from 42,
      // more of them and faster the higher the index
      const rad = size * (0.55 + 0.6 * g);
      const c0 = pal[0], c1 = pal[1 % pal.length];
      const grad = ctx.createRadialGradient(0, 0, size * 0.2, 0, 0, rad);
      grad.addColorStop(0, withAlpha(c0, 0.1 + 0.55 * g));
      grad.addColorStop(0.6, withAlpha(c1, 0.15 * g));
      grad.addColorStop(1, withAlpha(c0, 0));
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(0, 0, rad, 0, Math.PI * 2); ctx.fill();
      if (g > 0.42) {
        const n = g < 0.5 ? 6 : g < 0.6 ? 10 : 16, len = size * (0.3 + 0.6 * g), a0 = this.clock * (0.6 + 6 * (g - 0.42));
        ctx.lineWidth = Math.max(1, size / 32);
        for (let i = 0; i < n; i++) {
          const a = a0 + (i / n) * Math.PI * 2;
          const tw = 0.7 + 0.3 * Math.sin(this.clock * (3 + 4 * g) + i * 1.7);
          const r0 = size * 0.5, r1 = r0 + len * tw * (i % 2 ? 0.7 : 1);
          ctx.strokeStyle = withAlpha(pal[i % pal.length], Math.min(1, (g - 0.38) * 2.5) * tw);
          ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.stroke();
        }
      }
    }
    const ps = size / 16, x0 = -size / 2, y0 = -size / 2;
    for (let r = 0; r < 16; r++) {
      const row = GLOVE[r];
      for (let c = 0; c < 16; c++) {
        const t = GLOVE_PAL[row[c]];
        if (!t) continue;
        ctx.fillStyle = theme(t);
        ctx.fillRect(Math.round(x0 + c * ps), Math.round(y0 + r * ps), Math.ceil(ps), Math.ceil(ps));
      }
    }
    ctx.restore();
  }

  private drawProfile(ctx: CanvasRenderingContext2D, r: Rect, last: PunchHit | null, ref: PunchHit | null) {
    const n = OCT_LABELS.length;
    const labelH = r.h > 60 ? 12 : 0;
    const ph = r.h - labelH;
    const yOf = (v: number) => r.y + ((BAND_TOP - Math.min(BAND_TOP, Math.max(BAND_BOT, v))) / (BAND_TOP - BAND_BOT)) * ph;
    ctx.strokeStyle = theme("grid"); ctx.lineWidth = 1;
    for (let v = BAND_BOT; v <= BAND_TOP; v += 20) {
      const yy = Math.round(yOf(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(r.x, yy); ctx.lineTo(r.x + r.w, yy); ctx.stroke();
    }
    const bw = r.w / n;
    for (let b = 0; b < n; b++) {
      const bx = r.x + b * bw + 1;
      if (last) {
        const yv = yOf(last.bands[b]);
        ctx.fillStyle = withAlpha(theme("sig"), b < 5 ? 0.9 : 0.5);
        ctx.fillRect(bx, yv, bw - 2, r.y + ph - yv);
      }
      if (ref) {
        const yr = Math.round(yOf(ref.bands[b])) + 0.5;
        ctx.strokeStyle = theme("peak"); ctx.beginPath(); ctx.moveTo(bx, yr); ctx.lineTo(bx + bw - 2, yr); ctx.stroke();
      }
      if (labelH && bw >= 14) {
        ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(OCT_LABELS[b], bx + (bw - 2) / 2, r.y + ph + 2);
      }
    }
    ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText("옥타브 · 트랜지언트 dB", r.x + 2, r.y + 2);
  }

  /** Hit history bars; `compact` (machine view) hides the scale labels and uses the score for the hover text. */
  private drawHistory(ctx: CanvasRenderingContext2D, r: Rect, ref: PunchHit | null, compact: boolean) {
    const shown = this.hits.slice(-this.histN);
    this.histShown = shown;
    const labelH = r.h > 60 ? 12 : 0;
    const ph = r.h - labelH;
    const idxMode = this.scale === "index" || compact;
    const yOf = (db: number) => idxMode ? r.y + ph - (this.index(db) / 100) * ph : r.y + ((DB_TOP - Math.min(DB_TOP, Math.max(DB_BOT, db))) / (DB_TOP - DB_BOT)) * ph;
    ctx.strokeStyle = theme("grid"); ctx.lineWidth = 1;
    ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "right"; ctx.textBaseline = "middle";
    const ticks = idxMode ? [25, 50, 75, 100].map((i) => ({ y: r.y + ph - (i / 100) * ph, t: `${i}` })) : [-36, -24, -12].map((v) => ({ y: yOf(v), t: `${v}` }));
    for (const tk of ticks) {
      const yy = Math.round(tk.y) + 0.5;
      ctx.beginPath(); ctx.moveTo(r.x, yy); ctx.lineTo(r.x + r.w, yy); ctx.stroke();
      if (r.w > 50 && !compact) ctx.fillText(tk.t, r.x + r.w - 2, yy - 5);
    }
    if (ref) {
      const yr = Math.round(yOf(this.strengthDb(ref))) + 0.5;
      ctx.strokeStyle = theme("peak"); ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(r.x, yr); ctx.lineTo(r.x + r.w, yr); ctx.stroke(); ctx.setLineDash([]);
    }
    const n = this.histN;
    const bw = r.w / n;
    this.histBarW = bw;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let i = 0; i < shown.length; i++) {
      const hit = shown[i];
      const bx = r.x + i * bw;
      const isRef = !!ref && ref.seq === hit.seq && ref.t === hit.t;
      const isLast = i === shown.length - 1;
      const sdb = this.strengthDb(hit);
      const yv = yOf(sdb);
      const a = isLast ? 0.95 : 0.55 + (isRef ? 0.4 : 0);
      const tier = this.tierColor(this.rel(this.index(sdb)));
      ctx.fillStyle = withAlpha(isRef ? theme("peak") : tier, a);
      ctx.fillRect(bx + 1, yv, Math.max(1, bw - 2), r.y + ph - yv);
      if (isLast && this.flashAnim > 0) {
        ctx.fillStyle = withAlpha(theme("fg-0"), this.flashAnim * 0.6);
        ctx.fillRect(bx + 1, yv, Math.max(1, bw - 2), r.y + ph - yv);
      }
      if (this.showFlash && bw >= 4) {
        const yf = r.y + ph - (hit.flash / 100) * ph;
        ctx.fillStyle = theme("sig-2");
        ctx.fillRect(bx + 1, Math.round(yf) - 1, Math.max(1, bw - 2), 2);
      }
      if (i === this.hover && labelH) {
        ctx.fillStyle = theme("fg-0"); ctx.font = font(9);
        const txt = compact ? `${String(this.score(hit)).padStart(3, "0")} · 타격 ${this.fmtDb(hit.punch_db)} · 무게 ${this.fmtDb(hit.body_db ?? hit.punch_db)} · 화려함 ${Math.round(hit.flash)}` : `강도 ${this.fmt(sdb)} · 타격 ${this.fmtDb(hit.punch_db)} · 무게 ${this.fmtDb(hit.body_db ?? hit.punch_db)} · 화려함 ${Math.round(hit.flash)}`;
        ctx.fillText(txt, Math.min(Math.max(bx, r.x + 90), r.x + r.w - 90), r.y + 2);
      }
    }
    if (labelH) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(`히트 ${shown.length}/${n}${this.relative ? " · 색 = 최근 범위 내 약/중/강" : ""}${this.showFlash ? " · ▬ 화려함" : ""}${ref ? " · ▬ 기준" : ""}`, r.x + 2, r.y + ph + 2);
    }
  }
}
