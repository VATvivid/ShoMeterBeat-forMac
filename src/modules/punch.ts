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
// punch (dB), attack time, octave profile and a "flash" index (this app's own showiness
// heuristic: high-band share, octave coverage, stereo width, tail). Session PM95 / mean
// come from the live momentary punch. Click a hit bar to make it the reference; later
// hits show their difference to it.

const PAD = 8;
const DB_TOP = 6, DB_BOT = -54;        // punch scale (dB)
const BAND_TOP = 0, BAND_BOT = -60;    // octave profile scale
const OCT_LABELS = ["63", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
const POLL_MS = 150;
const HOLD_S = 2.5;

interface Rect { x: number; y: number; w: number; h: number }

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
  private flashAnim = 0;          // 1 right after a new hit → fades
  private histRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private histBarW = 0;
  private histShown: PunchHit[] = [];
  private hover = -1;

  private get histN() { return modSetting(this.id, "hist", 40); }
  private get scale() { return modSetting(this.id, "scale", "db") as "db" | "index"; }
  private get showFlash() { return modSetting(this.id, "flash", true); }
  private get ref(): PunchHit | null { return modSetting<PunchHit | null>(this.id, "ref", null); }

  settings(): SettingItem[] {
    return [
      { type: "select", label: "강도 척도", value: this.scale, options: [{ value: "db", label: "dB (풀스케일 기준)" }, { value: "index", label: "0–100 지수 (−50 dB → 0, +6 dB → 100)" }], onChange: (v) => setModSetting(this.id, "scale", v) },
      { type: "select", label: "히트 이력", value: String(this.histN), options: [20, 40, 80].map((v) => ({ value: String(v), label: `최근 ${v}개` })), onChange: (v) => setModSetting(this.id, "hist", Number(v)) },
      { type: "toggle", label: "화려함 지수 표시", value: this.showFlash, onChange: (v) => setModSetting(this.id, "flash", v) },
      { type: "action", label: "마지막 히트를 기준으로", onClick: () => { const h = this.hits[this.hits.length - 1]; if (h) setModSetting(this.id, "ref", h); } },
      { type: "action", label: "기준 해제", onClick: () => setModSetting(this.id, "ref", null) },
      { type: "action", label: "이력·세션 통계 초기화", onClick: () => { this.hits = []; getSource()?.punchReset().catch(() => {}); } },
    ];
  }

  headReadout() {
    const h = this.hits[this.hits.length - 1];
    if (!h) return "히트 대기";
    return `${this.fmt(h.punch_db)}${this.showFlash ? ` · 화려함 ${Math.round(h.flash)}` : ""}${this.ref ? ` · 기준 ${this.delta(h.punch_db)}` : ""}`;
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

  private index(db: number) { return Math.max(0, Math.min(100, ((db + 50) / 56) * 100)); }
  private fmt(db: number) { return this.scale === "index" ? `${this.index(db).toFixed(0)}` : `${db.toFixed(1).replace("-", "−")} dB`; }
  private delta(db: number) {
    const r = this.ref; if (!r) return "";
    const d = this.scale === "index" ? this.index(db) - this.index(r.punch_db) : db - r.punch_db;
    return `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}${this.scale === "index" ? "" : " dB"}`;
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

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    this.poll();
    // live momentary meter from the frame (60 fps) with a hold line
    const target = f.punchM;
    this.live = ballistic(this.live, target, dt, 40);
    if (target >= this.liveHold) { this.liveHold = target; this.holdAge = 0; }
    else { this.holdAge += dt; if (this.holdAge > HOLD_S) this.liveHold = ballistic(this.liveHold, target, dt, 20); }
    this.flashAnim = Math.max(0, this.flashAnim - dt * 2);

    const last = this.hits[this.hits.length - 1] ?? null;
    const ref = this.ref;
    const narrow = w < 220, short = h < 120, tiny = w < 120 || h < 70;
    const yOfDb = (v: number, y0: number, hh: number) => y0 + ((DB_TOP - Math.min(DB_TOP, Math.max(DB_BOT, v))) / (DB_TOP - DB_BOT)) * hh;

    // ---- readout row
    let y = PAD;
    if (!tiny) {
      ctx.textBaseline = "top"; ctx.textAlign = "left";
      ctx.fillStyle = theme("fg-1"); ctx.font = font(10, 600);
      ctx.fillText("PUNCH", PAD, y);
      ctx.fillStyle = last ? theme("fg-0") : theme("fg-2"); ctx.font = font(short ? 18 : 24, 600);
      const big = last ? this.fmt(last.punch_db) : "—";
      ctx.fillText(big, PAD + 50, y - 4);
      let x = PAD + 50 + ctx.measureText(big).width + 14;
      ctx.font = font(10);
      if (last && !narrow) {
        const parts: [string, string][] = [];
        if (this.showFlash) parts.push(["화려함", `${Math.round(last.flash)}`]);
        parts.push(["어택", `${last.attack_ms.toFixed(0)} ms`]);
        parts.push(["피크", `${last.peak_db.toFixed(1).replace("-", "−")} dBFS`]);
        if (ref) parts.push(["기준 대비", this.delta(last.punch_db)]);
        for (const [k, v] of parts) {
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
        ? `PM95 ${this.fmt(s.pm95)}  ·  평균 ${this.fmt(s.mean)}  ·  PM95M ${(s.pm95 - s.mean).toFixed(1)} dB  ·  TSR ${f.tsr.toFixed(0)} dB`
        : inTauri ? "소리를 기다리는 중 — 히트 막대를 클릭하면 기준이 됩니다" : "브라우저 미리보기";
      ctx.fillText(narrow ? txt.split("  ·  ").slice(0, 2).join(" · ") : txt, PAD, h - 2);
    }
    const ph = y1 - y;
    if (ph < 16) return;

    // ---- columns: [live bar] [octave profile] [hit history]
    const liveW = narrow ? 0 : 14;
    const profW = narrow ? 0 : Math.min(180, Math.max(90, (w - 2 * PAD - liveW) * 0.33));
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
    const histW = w - PAD - x;
    if (histW > 20) this.drawHistory(ctx, { x, y, w: histW, h: ph }, ref);
    this.histRect = { x, y, w: Math.max(0, histW), h: ph };
    if (!inTauri && this.hits.length === 0 && !tiny) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("브라우저 미리보기", x + histW / 2, y + ph / 2);
    }
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
        // bands the regression favours (63 Hz … 1 kHz) in the signal colour, the neutral ones dimmer
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
    const yOf = (v: number) => r.y + ((DB_TOP - Math.min(DB_TOP, Math.max(DB_BOT, v))) / (DB_TOP - DB_BOT)) * ph;
    // scale lines + labels
    ctx.strokeStyle = theme("grid"); ctx.lineWidth = 1;
    ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let v = -48; v <= DB_TOP; v += 12) {
      const yy = Math.round(yOf(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(r.x, yy); ctx.lineTo(r.x + r.w, yy); ctx.stroke();
      if (r.w > 60) ctx.fillText(this.scale === "index" ? `${this.index(v).toFixed(0)}` : `${v}`, r.x + r.w - 2, yy - 5);
    }
    // reference level line
    if (ref) {
      const yr = Math.round(yOf(ref.punch_db)) + 0.5;
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
      const yv = yOf(hit.punch_db);
      const a = isLast ? 0.95 : 0.55 + (isRef ? 0.4 : 0);
      ctx.fillStyle = withAlpha(isRef ? theme("peak") : theme("sig"), a);
      ctx.fillRect(bx + 1, yv, Math.max(1, bw - 2), r.y + ph - yv);
      if (isLast && this.flashAnim > 0) {
        ctx.fillStyle = withAlpha(theme("fg-0"), this.flashAnim * 0.6);
        ctx.fillRect(bx + 1, yv, Math.max(1, bw - 2), r.y + ph - yv);
      }
      if (this.showFlash && bw >= 4) {
        // flash index as a marker on the bar column (0 at the bottom, 100 at the top)
        const yf = r.y + ph - (hit.flash / 100) * ph;
        ctx.fillStyle = theme("sig-2");
        ctx.fillRect(bx + 1, Math.round(yf) - 1, Math.max(1, bw - 2), 2);
      }
      if (i === this.hover && labelH) {
        ctx.fillStyle = theme("fg-0"); ctx.font = font(9);
        ctx.fillText(`${this.fmt(hit.punch_db)} · ${hit.attack_ms.toFixed(0)}ms · 화려함 ${Math.round(hit.flash)}`, Math.min(Math.max(bx, r.x + 60), r.x + r.w - 60), r.y + 2);
      }
    }
    if (labelH) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(`히트 ${shown.length}/${n}${this.showFlash ? " · ▬ 화려함" : ""}${ref ? " · ▬ 기준" : ""}`, r.x + 2, r.y + ph + 2);
    }
  }
}
