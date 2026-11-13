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
// 강도 (strength) is what the big number, the history bars and the glove follow. It is
// a blend of punch and body (default 35 % punch + 65 % body, in dB) mapped to a 0–100
// index that is dense at the top (γ = 2 over −45 … −10 dB), because game hits are
// mastered to the same peak and differ by only a few dB — those few dB must spread.
// Calibrated on a set of 36 game hit sounds (normal / double / critical tiers): punch
// alone was flat across tiers (±2 dB) while body stepped 2–3 dB per tier.
//
// Differentiation: the number is absolute, but the glove size and the bar colours are
// *relative to the hits on screen* (range of the recent hits, at least 20 index points),
// so two variants that differ by a few points still look clearly different: the weakest
// recent hit is small and dim, the strongest is big and warm. Switchable to absolute.

const PAD = 8;
const IDX_LO = -45, IDX_HI = -10, IDX_GAMMA = 2;   // 강도 dB → 0…100
const DB_TOP = -8, DB_BOT = -42;                    // history bar scale in dB mode
const BAND_TOP = 0, BAND_BOT = -60;
const OCT_LABELS = ["63", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
const POLL_MS = 150;
const HOLD_S = 2.5;

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

export class PunchModule implements Module {
  readonly id = "punch";
  readonly title = "Punch";
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
  private jab = 0;

  private get histN() { return modSetting(this.id, "hist", 30); }
  private get scale() { return modSetting(this.id, "scale", "index") as "db" | "index"; }
  private get basis() { return modSetting(this.id, "basis", "blend") as Basis; }
  private get showFlash() { return modSetting(this.id, "flash", true); }
  private get showGlove() { return modSetting(this.id, "glove", true); }
  private get relative() { return modSetting(this.id, "relative", true); }
  private get ref(): PunchHit | null { return modSetting<PunchHit | null>(this.id, "ref", null); }

  settings(): SettingItem[] {
    return [
      { type: "select", label: "강도 기준", value: this.basis, options: [{ value: "blend", label: "합성 (타격 35 % + 무게 65 %)" }, { value: "punch", label: "타격(punch)만" }, { value: "body", label: "무게(body)만" }], onChange: (v) => setModSetting(this.id, "basis", v) },
      { type: "select", label: "강도 척도", value: this.scale, options: [{ value: "index", label: "0–100 지수 (−45 dB → 0, −10 dB → 100, 고점 조밀)" }, { value: "db", label: "dB (풀스케일 정현파 기준)" }], onChange: (v) => setModSetting(this.id, "scale", v) },
      { type: "select", label: "히트 이력", value: String(this.histN), options: [15, 30, 60].map((v) => ({ value: String(v), label: `최근 ${v}개` })), onChange: (v) => setModSetting(this.id, "hist", Number(v)) },
      { type: "toggle", label: "화려함 지수 표시", value: this.showFlash, onChange: (v) => setModSetting(this.id, "flash", v) },
      { type: "toggle", label: "글러브 이모지", value: this.showGlove, onChange: (v) => setModSetting(this.id, "glove", v) },
      { type: "toggle", label: "크기·색을 최근 히트 범위에 맞춤 (상대 표시)", value: this.relative, onChange: (v) => setModSetting(this.id, "relative", v) },
      { type: "action", label: "마지막 히트를 기준으로", onClick: () => { const h = this.hits[this.hits.length - 1]; if (h) setModSetting(this.id, "ref", h); } },
      { type: "action", label: "기준 해제", onClick: () => setModSetting(this.id, "ref", null) },
      { type: "action", label: "이력·세션 통계 초기화", onClick: () => { this.hits = []; getSource()?.punchReset().catch(() => {}); } },
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
        this.jab = 1;
      }
      while (this.hits.length > 200) this.hits.shift();
      this.stats = st;
    }).catch(() => {}).finally(() => { this.polling = false; });
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    this.poll();
    const target = f.punchM;
    this.live = ballistic(this.live, target, dt, 40);
    if (target >= this.liveHold) { this.liveHold = target; this.holdAge = 0; }
    else { this.holdAge += dt; if (this.holdAge > HOLD_S) this.liveHold = ballistic(this.liveHold, target, dt, 20); }
    this.flashAnim = Math.max(0, this.flashAnim - dt * 2);
    this.clock += dt;
    this.jab = Math.max(0, this.jab - dt * 3);
    const last = this.hits[this.hits.length - 1] ?? null;
    {
      const ts = last ? this.rel(this.index(this.strengthDb(last))) : 0, tg = last ? last.flash / 100 : 0;
      const k = Math.min(1, dt * 8);
      this.gloveScale += (ts - this.gloveScale) * k;
      this.gloveGlow += (tg - this.gloveGlow) * k;
    }

    const ref = this.ref;
    const narrow = w < 240, short = h < 120, tiny = w < 120 || h < 70;
    const yOfDb = (v: number, y0: number, hh: number) => y0 + ((DB_TOP - Math.min(DB_TOP, Math.max(DB_BOT, v))) / (DB_TOP - DB_BOT)) * hh;

    // ---- readout row
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
        // change against the previous hit, in the current scale
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

    // ---- caption (session stats) at the bottom
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

    // ---- columns: [live bar] [octave profile] [hit history] [glove]
    const liveW = narrow ? 0 : 14;
    const gloveW = this.showGlove && !tiny ? Math.max(40, Math.min(110, Math.min(ph, w * 0.22))) : 0;
    const profW = narrow ? 0 : Math.min(170, Math.max(80, (w - 2 * PAD - liveW - gloveW) * 0.34));
    const gap = 10;
    let x = PAD;
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
    const histW = w - PAD - x - (gloveW ? gloveW + gap : 0);
    if (histW > 20) this.drawHistory(ctx, { x, y, w: histW, h: ph }, ref);
    this.histRect = { x, y, w: Math.max(0, histW), h: ph };
    if (gloveW) this.drawGlove(ctx, w - PAD - gloveW / 2, y + ph / 2, Math.min(gloveW, ph), !!last);
    if (!inTauri && this.hits.length === 0 && !tiny) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("브라우저 미리보기", x + histW / 2, y + ph / 2);
    }
  }

  /** Glove centred at (cx, cy); `side` is the column — a weak hit uses ~55 % of it, a strong one ~100 %. */
  private drawGlove(ctx: CanvasRenderingContext2D, cx: number, cy: number, side: number, hasHit: boolean) {
    const s = this.gloveScale, g = this.gloveGlow;
    const scale = (0.32 + 0.68 * s) * (1 + 0.2 * Math.sin(this.jab * Math.PI));
    const size = side * scale;
    const x0 = cx - size / 2 + 4 * Math.sin(this.jab * Math.PI);
    const y0 = cy - size / 2;
    ctx.save();
    ctx.globalAlpha = hasHit ? 1 : 0.35;
    if (g > 0.03) {
      const rad = size * (0.55 + 0.6 * g);
      const grad = ctx.createRadialGradient(cx, cy, size * 0.2, cx, cy, rad);
      grad.addColorStop(0, withAlpha(theme("target"), 0.15 + 0.55 * g));
      grad.addColorStop(0.6, withAlpha(theme("peak"), 0.12 * g));
      grad.addColorStop(1, withAlpha(theme("target"), 0));
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
      if (g > 0.35) {
        const n = 8, len = size * (0.3 + 0.5 * g), a0 = this.clock * 0.6;
        ctx.strokeStyle = withAlpha(theme("target"), (g - 0.35) * 0.9);
        ctx.lineWidth = Math.max(1, size / 32);
        for (let i = 0; i < n; i++) {
          const a = a0 + (i / n) * Math.PI * 2;
          const r0 = size * 0.5, r1 = r0 + len * (0.7 + 0.3 * Math.sin(this.clock * 3 + i));
          ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.stroke();
        }
      }
    }
    const ps = size / 16;
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

  private drawHistory(ctx: CanvasRenderingContext2D, r: Rect, ref: PunchHit | null) {
    const shown = this.hits.slice(-this.histN);
    this.histShown = shown;
    const labelH = r.h > 60 ? 12 : 0;
    const ph = r.h - labelH;
    const idxMode = this.scale === "index";
    // bar height: index (0…100) or dB on the fixed scale
    const yOf = (db: number) => idxMode ? r.y + ph - (this.index(db) / 100) * ph : r.y + ((DB_TOP - Math.min(DB_TOP, Math.max(DB_BOT, db))) / (DB_TOP - DB_BOT)) * ph;
    ctx.strokeStyle = theme("grid"); ctx.lineWidth = 1;
    ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "right"; ctx.textBaseline = "middle";
    const ticks = idxMode ? [25, 50, 75, 100].map((i) => ({ y: r.y + ph - (i / 100) * ph, t: `${i}` })) : [-36, -24, -12].map((v) => ({ y: yOf(v), t: `${v}` }));
    for (const tk of ticks) {
      const yy = Math.round(tk.y) + 0.5;
      ctx.beginPath(); ctx.moveTo(r.x, yy); ctx.lineTo(r.x + r.w, yy); ctx.stroke();
      if (r.w > 50) ctx.fillText(tk.t, r.x + r.w - 2, yy - 5);
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
        ctx.fillText(`강도 ${this.fmt(sdb)} · 타격 ${this.fmtDb(hit.punch_db)} · 무게 ${this.fmtDb(hit.body_db ?? hit.punch_db)} · 화려함 ${Math.round(hit.flash)}`, Math.min(Math.max(bx, r.x + 90), r.x + r.w - 90), r.y + 2);
      }
    }
    if (labelH) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(`히트 ${shown.length}/${n}${this.relative ? " · 색 = 최근 범위 내 약/중/강" : ""}${this.showFlash ? " · ▬ 화려함" : ""}${ref ? " · ▬ 기준" : ""}`, r.x + 2, r.y + ph + 2);
    }
  }
}
