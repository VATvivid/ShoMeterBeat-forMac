import type { Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { Median, setVoiceType, VOICE_LABELS, voiceType, type VoiceType } from "./vowels";
import { articForFormants, BREATH_OPEN, lerpArtic, REST } from "./articulation";
import type { Artic } from "./vowelTargets";

// Midsagittal vocal tract (face looks right) in body centimetres: origin at the
// glottis, x forward, y up. The articulation (tongue body/tip, jaw, lips, larynx) is
// blended from calibrated vowel targets nearest to the measured F1/F2; everything
// else (skull, spine, trachea, nasal cavity, eye) is a fixed stylised template.
// Dynamic details: jaw rotates about the condyle, afterimages of tongue/jaw/lips,
// pressure heat along the airway, minimum-constriction caliper, glottal pulse at f0,
// larynx rising with pitch, airflow particles, breath turbulence, lung gauge, gaze.

interface P { x: number; y: number }
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const CONDYLE: P = { x: -2.5, y: 10.5 };
const INCISOR_LOWER: P = { x: 6.9, y: 6.3 };
const TONGUE_R = 2.3;
const ECHO_EVERY = 0.028, ECHO_KEEP = 0.12;

interface Echo { t: number; tongue: P[]; mandible: P[]; lips: P[][] }

export class TractModule implements Module {
  readonly id = "tract";
  readonly title = "Vocal Tract";
  private artic: Artic = { ...REST };
  private voice = 0;
  private level = 0;
  private phase = 0;
  private larynxRise = 0;
  private velum = 1;             // 1 raised (nasal port shut) … 0 lowered
  private particles: { t: number; off: number; speed: number; life: number }[] = [];
  private turb: { t: number; off: number; speed: number; life: number }[] = [];
  private breath = 0;
  private breathPeak = 0;
  private breathOnsets: number[] = [];
  private breathRate = 0;
  private lung = 0.5;
  private clock = 0;
  private echoes: Echo[] = [];
  private lastEcho = 0;
  private gaze = { x: 0, y: 0, tx: 0, ty: 0, next: 2, lid: 0, blinkAt: 4 };
  private m1 = new Median(5);
  private m2 = new Median(5);
  private f1 = 0; private f2 = 0;
  private ipa = "";

  settings(): SettingItem[] {
    return [
      { type: "select", label: "음성 유형", value: voiceType(), options: (Object.keys(VOICE_LABELS) as VoiceType[]).map((k) => ({ value: k, label: VOICE_LABELS[k] })), onChange: (v) => setVoiceType(v as VoiceType) },
    ];
  }

  headReadout(f: Frame) {
    const live = f.voiced > 0.4 && this.f1 > 0;
    const br = this.breath > 0.2 ? `  숨 ${Math.round(this.breath * 100)}%` : "";
    const rate = this.breathRate > 0 ? `  ${this.breathRate.toFixed(0)}/min` : "";
    return `${live && this.ipa ? "[" + this.ipa + "] " : ""}f0 ${f.f0 > 0 && f.voiced > 0.4 ? f.f0.toFixed(0) : "—"} Hz${br}${rate}`;
  }

  private breathTarget(f: Frame): number {
    const level = Math.min(1, Math.max(0, (f.rms[0] + 58) / 34));
    const noisy = Math.min(1, Math.max(0, (f.flatness - 0.08) / 0.27));
    const unvoiced = 1 - Math.min(1, Math.max(0, (f.voiced - 0.2) / 0.3));
    return level * noisy * unvoiced;
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    this.clock += dt;
    const body = voiceType();
    const live = f.voiced > 0.4 && f.f1 > 0 && f.f2 > 0;
    if (live) { this.f1 = this.m1.push(f.f1); this.f2 = this.m2.push(f.f2); }
    const k = Math.min(1, dt * 10);
    const lvl = Math.min(1, Math.max(0, (f.lufsM + 50) / 40));
    this.level += (lvl - this.level) * k;
    this.voice += ((live ? f.voiced : 0) - this.voice) * k;

    // ---- articulation target: calibrated vowel blend, or rest when silent
    if (live) {
      const a = articForFormants(this.f1, this.f2, body);
      this.ipa = a.ipa;
      this.artic = lerpArtic(this.artic, a.artic, k);
      this.larynxRise += (Math.max(-0.5, Math.min(1, Math.log2(Math.max(50, f.f0) / 150))) * 0.45 - this.larynxRise) * k;
    } else {
      // Silent → rest; breathing → mouth opens with the breath (more for bright, mouth-borne air).
      const r = Math.min(1, dt * (this.breath > 0.15 ? 6 : 3));
      const mouth = this.breath * (f.centroid > 1500 ? 1 : 0.4);
      this.artic = lerpArtic(this.artic, lerpArtic(REST, BREATH_OPEN, Math.min(1, mouth * 1.3)), r);
      this.larynxRise += (0 - this.larynxRise) * r;
    }
    if (this.voice > 0.2 && f.f0 > 0) this.phase = (this.phase + f.f0 * dt) % 1;

    // ---- breath envelope, rate, lungs
    const bt = this.breathTarget(f);
    this.breath = bt > this.breath ? bt : Math.max(bt, this.breath - dt * 3.3);
    if (this.breath > 0.25 && this.breathPeak <= 0.25) {
      const last = this.breathOnsets[this.breathOnsets.length - 1];
      if (last === undefined || this.clock - last > 0.25) this.breathOnsets.push(this.clock);
      while (this.breathOnsets.length > 6) this.breathOnsets.shift();
    }
    this.breathPeak = this.breath;
    {
      const on = this.breathOnsets.filter((t) => this.clock - t < 8);
      if (on.length >= 3) {
        const iv = on.slice(1).map((t, i) => t - on[i]);
        const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
        this.breathRate = iv.every((v) => v > 0.3 && v < 3 && Math.abs(v - mean) < mean * 0.5) ? 60 / mean : 0;
      } else this.breathRate = 0;
    }
    const inhale = this.breath > 0.3 && f.centroid > 1800;
    this.lung += ((inhale ? 1 : live ? 0.15 : this.lung) - this.lung) * Math.min(1, dt * (inhale ? 2.5 : 0.35));
    // Velum: shut while phonating; drops a little during quiet breathing (nose breathing assumed).
    this.velum += ((this.voice > 0.2 ? 1 : this.breath > 0.2 && f.centroid < 1800 ? 0.35 : 0.8) - this.velum) * Math.min(1, dt * 4);

    // ---- gaze: idle saccades, eyes roll up on high notes, blinks
    const g = this.gaze;
    g.next -= dt;
    if (g.next <= 0) { g.next = 2 + Math.random() * 3; if (Math.random() < 0.35) { g.tx = 0; g.ty = 0; } else { g.tx = (Math.random() - 0.5) * 1.2; g.ty = (Math.random() - 0.5) * 0.8; } }
    const up = live ? Math.max(0, Math.log2(Math.max(50, f.f0) / 220)) * 0.6 : 0;
    g.x += (g.tx - g.x) * Math.min(1, dt * 6); g.y += (g.ty - up - g.y) * Math.min(1, dt * 6);
    g.blinkAt -= dt; if (g.blinkAt <= 0) { g.blinkAt = 3 + Math.random() * 4; g.lid = 1; }
    g.lid = Math.max(0, g.lid - dt * 8);

    // ---- geometry mapping (body cm → px)
    const X0 = -5.4, X1 = 14.2, Y0 = -9.6, Y1 = 16.8;
    const s = Math.min(w / (X1 - X0), h / (Y1 - Y0));
    const ox = (w - (X1 - X0) * s) / 2, oy = (h - (Y1 - Y0) * s) / 2;
    const P = (x: number, y: number): P => ({ x: ox + (x - X0) * s, y: oy + (Y1 - y) * s });
    const A = this.artic;
    const theta = Math.max(-0.2, Math.min(3, A.jaw)) / 9.8;           // rad; the incisors drop ≈ jaw cm
    const rot = (p: P): P => {                                          // rotate about the condyle (jaw down)
      const dx = p.x - CONDYLE.x, dy = p.y - CONDYLE.y, c = Math.cos(-theta), sn = Math.sin(-theta);
      return { x: CONDYLE.x + dx * c - dy * sn, y: CONDYLE.y + dx * sn + dy * c };
    };
    const lar = 0.6 * A.larynx + this.larynxRise;                      // larynx height offset (cm)
    const prot = A.lipProt;
    const lowerIncisor = rot(INCISOR_LOWER);
    const jawDrop = INCISOR_LOWER.y - lowerIncisor.y;

    // ---- colours
    const outline = theme("fg-2"), bone = withAlpha(theme("fg-1"), 0.55), palateC = theme("fg-1");
    const tongueC = theme("sig"), jawC = theme("peak"), lipC = theme("sig-2"), velumC = theme("fg-0");

    const curveTo = (pts: P[], close: boolean) => {
      const n = pts.length;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 0; i < (close ? n : n - 1); i++) {
        const p0 = close ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
        const p1 = pts[i], p2 = pts[(i + 1) % n];
        const p3 = close ? pts[(i + 2) % n] : pts[Math.min(n - 1, i + 2)];
        ctx.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
      }
      if (close) ctx.closePath();
    };
    const stroke = (pts: P[], color: string, width = 1.5, close = false, smooth = true) => {
      if (pts.length < 2) return;
      ctx.beginPath();
      if (smooth) curveTo(pts, close);
      else { pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); if (close) ctx.closePath(); }
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.stroke();
    };
    const fillPath = (pts: P[], color: string) => { ctx.beginPath(); curveTo(pts, true); ctx.fillStyle = color; ctx.fill(); };
    const Ps = (pts: [number, number][]) => pts.map(([x, y]) => P(x, y));

    // ---- static anatomy: spine, skull, brain, nose, eye, nasal cavity, pharynx, trachea
    ctx.fillStyle = withAlpha(theme("fg-2"), 0.35);
    for (let y = -4.4; y < 10.5; y += 1.75) { const a = P(-4.7, y + 1.3), b = P(-3.5, y); ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); }
    stroke(Ps([[-3.2, -9.6], [-3.4, -4.0], [-4.4, 1.5], [-5.1, 7.5], [-4.6, 12.8], [-2.6, 16.0], [1.6, 16.7], [5.0, 15.7], [6.9, 13.6], [7.5, 11.6], [8.5, 10.1], [9.7, 9.3], [8.7, 8.6], [8.3, 8.05]]), outline, 1.5);
    stroke(Ps([[-3.8, 9.5], [-3.2, 13.6], [0.5, 15.4], [4.2, 14.4], [5.8, 12.2]]), withAlpha(theme("fg-2"), 0.4), 1);
    {
      const e = P(5.0, 12.4), r = 0.62 * s;
      ctx.strokeStyle = outline; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(e.x, e.y, r, r * 0.55, 0, 0, Math.PI * 2); ctx.stroke();
      const open = 1 - g.lid;
      if (open > 0.15) {
        ctx.fillStyle = theme("fg-0");
        ctx.beginPath(); ctx.ellipse(e.x + g.x * r * 0.45, e.y - g.y * r * 0.3, r * 0.28, r * 0.28 * open, 0, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.beginPath(); ctx.moveTo(e.x - r, e.y); ctx.lineTo(e.x + r, e.y); ctx.stroke();
      }
    }
    stroke(Ps([[0.9, 9.6], [1.4, 11.9], [3.6, 12.9], [6.6, 12.0], [8.2, 10.1], [7.9, 9.25], [5.0, 9.5], [2.3, 9.5]]), withAlpha(outline, 0.8), 1, true);
    for (const [x, y, rx, ry] of [[3.0, 10.4, 0.9, 0.35], [4.4, 11.1, 1.0, 0.4], [5.9, 10.5, 0.8, 0.3]]) {
      const c = P(x, y); ctx.strokeStyle = withAlpha(outline, 0.7); ctx.beginPath(); ctx.ellipse(c.x, c.y, rx * s, ry * s, -0.2, 0, Math.PI * 2); ctx.stroke();
    }
    stroke(Ps([[-1.25, -0.5], [-1.3, 3.0], [-1.4, 6.0], [-1.45, 9.0], [-1.1, 11.0], [0.2, 11.9]]), outline, 1.5);
    stroke(Ps([[-0.9, -0.6], [-0.95, -5.3]]), outline, 1.2, false, false);
    stroke(Ps([[0.9, -0.6], [0.95, -5.3]]), outline, 1.2, false, false);
    for (let y = -1.3; y > -5; y -= 1.0) stroke(Ps([[-0.85, y], [0.85, y]]), withAlpha(outline, 0.6), 1, false, false);
    const palate: P[] = Ps([[7.3, 7.9], [6.7, 8.65], [5.6, 9.15], [4.3, 9.35], [2.9, 9.3], [1.7, 9.05]]);
    stroke(palate, palateC, 2);
    stroke(Ps([[7.25, 7.95], [7.45, 7.05], [7.65, 7.95]]), bone, 1, false, false);
    const uvula: P = P(lerp(0.55, -0.6, this.velum), lerp(7.2, 8.4, this.velum));
    stroke([P(1.7, 9.05), P(lerp(1.0, 0.4, this.velum), lerp(8.4, 8.9, this.velum)), uvula], velumC, 2);
    stroke(Ps([[0.2, 2.2 + lar], [0.9, 3.6 + lar], [1.4, 4.9 + lar]]), withAlpha(outline, 0.9), 1.2);
    { const hy = P(1.6, 3.0 + lar); ctx.strokeStyle = bone; ctx.beginPath(); ctx.ellipse(hy.x, hy.y, 0.45 * s, 0.18 * s, 0, 0, Math.PI * 2); ctx.stroke(); }
    stroke(Ps([[0.15, 1.9 + lar], [1.35, 2.3 + lar], [1.35, 0.1 + lar], [0.15, -0.5 + lar]]), bone, 1.2, true, false);

    // ---- mandible (rotates about the condyle), lower incisor, chin skin
    const mandible = [{ x: 6.9, y: 6.3 }, { x: 8.1, y: 4.4 }, { x: 7.8, y: 2.6 }, { x: 6.4, y: 1.5 }, { x: 3.8, y: 1.2 }, { x: 1.2, y: 1.8 }, { x: -0.6, y: 3.2 }, { x: -1.6, y: 6.5 }, { x: -2.3, y: 9.6 }].map(rot);
    const mandiblePx = mandible.map((p) => P(p.x, p.y));
    stroke(Ps([[lowerIncisor.x, lowerIncisor.y], [lowerIncisor.x + 0.15, lowerIncisor.y + 0.85], [lowerIncisor.x + 0.4, lowerIncisor.y]]), bone, 1, false, false);
    const chinSkin = [{ x: 8.3, y: 8.05 }, { x: 8.9, y: 6.4 }, { x: 8.7, y: 4.4 }, { x: 7.9, y: 2.3 }, { x: 6.0, y: 1.0 }, { x: 3.6, y: 0.4 }, { x: 2.5, y: -1.5 }, { x: 2.4, y: -5.0 }, { x: 4.2, y: -7.5 }, { x: 5.0, y: -9.6 }].map((p, i) => (i < 6 ? rot(p) : p));
    stroke(chinSkin.map((p) => P(p.x, p.y)), outline, 1.5);

    // ---- lips (protrude with lipProt, open by lipAp, lower lip rides the jaw)
    const lipY = 7.45;
    const upperLip = [P(7.3, 8.05), P(8.3 + prot * 0.6, 8.0), P(8.75 + prot, 7.75), P(8.6 + prot, lipY + A.lipAp / 2), P(7.9 + prot * 0.4, lipY + A.lipAp / 2 + 0.05)];
    const lowerLip = [P(lowerIncisor.x, lowerIncisor.y + 0.1), P(8.2 + prot * 0.6, 6.85 - jawDrop), P(8.7 + prot, 7.1 - jawDrop * 0.7), P(8.55 + prot, lipY - A.lipAp / 2 - jawDrop * 0.6), P(7.9 + prot * 0.4, lipY - A.lipAp / 2 - jawDrop * 0.6 - 0.05)];

    // ---- tongue outline (body circle at tbX/tbY, tip at ttX/ttY, floor rides the jaw)
    const tb: P = { x: A.tbX, y: A.tbY }, tt: P = { x: A.ttX, y: A.ttY + A.ttCurl * 0.5 };
    const floor = [{ x: 5.7, y: 5.0 }, { x: 3.2, y: 4.7 }, { x: 1.4, y: 4.3 }].map(rot);
    const tongue: P[] = [
      { x: 0.5, y: 2.8 + lar * 0.5 },
      { x: tb.x - TONGUE_R, y: tb.y - 0.5 },
      { x: tb.x - TONGUE_R * 0.7, y: tb.y + TONGUE_R * 0.72 },
      { x: tb.x, y: tb.y + TONGUE_R },
      { x: tb.x + TONGUE_R * 0.75, y: tb.y + TONGUE_R * 0.66 },
      { x: (tb.x + TONGUE_R + tt.x) / 2, y: (tb.y + TONGUE_R * 0.4 + tt.y) / 2 + 0.2 },
      tt,
      { x: tt.x - 0.45, y: tt.y - 0.9 },
      ...floor,
      { x: 0.9, y: 3.4 + lar * 0.5 },
    ];
    const tonguePx = tongue.map((p) => P(p.x, p.y));

    // ---- afterimages (tongue, jaw, lips) from 30/60/90 ms ago
    if (this.clock - this.lastEcho >= ECHO_EVERY) {
      this.lastEcho = this.clock;
      this.echoes.push({ t: this.clock, tongue: tonguePx, mandible: mandiblePx, lips: [upperLip, lowerLip] });
      while (this.echoes.length && this.clock - this.echoes[0].t > ECHO_KEEP) this.echoes.shift();
    }
    for (const [ago, alpha] of [[0.09, 0.10], [0.06, 0.17], [0.03, 0.24]] as const) {
      const e = this.echoes.find((q) => this.clock - q.t >= ago);
      if (!e) continue;
      stroke(e.tongue, withAlpha(tongueC, alpha), 1.5, true);
      stroke(e.mandible, withAlpha(jawC, alpha * 0.9), 1.2);
      stroke(e.lips[0], withAlpha(lipC, alpha * 0.9), 1.5); stroke(e.lips[1], withAlpha(lipC, alpha * 0.9), 1.5);
    }

    // ---- airway centreline: pressure heat (by level) + particle path
    const roofY = (x: number) => {
      const pts = [[1.7, 9.05], [2.9, 9.3], [4.3, 9.35], [5.6, 9.15], [6.7, 8.65], [7.3, 7.9], [8.6 + prot, lipY + A.lipAp / 2]];
      for (let i = 0; i < pts.length - 1; i++) if (x >= pts[i][0] && x <= pts[i + 1][0]) return lerp(pts[i][1], pts[i + 1][1], (x - pts[i][0]) / (pts[i + 1][0] - pts[i][0]));
      return x < pts[0][0] ? pts[0][1] : pts[pts.length - 1][1];
    };
    const tongueTopY = (x: number) => {
      const top = tongue.slice(1, 7);
      for (let i = 0; i < top.length - 1; i++) if (x >= top[i].x && x <= top[i + 1].x) return lerp(top[i].y, top[i + 1].y, (x - top[i].x) / (top[i + 1].x - top[i].x));
      return x < top[0].x ? top[0].y : top[top.length - 1].y;
    };
    const airway: P[] = [{ x: 0, y: 0 }, { x: 0.2, y: 2.4 + lar * 0.3 }, { x: 0.4, y: 5.0 }, { x: 0.3, y: 7.4 }, { x: 1.2, y: 8.5 }];
    for (const x of [2.4, 3.6, 4.8, 6.0, 7.0]) airway.push({ x, y: (roofY(x) + tongueTopY(x)) / 2 });
    airway.push({ x: 8.65 + prot, y: lipY - jawDrop * 0.3 });
    const airPx = airway.map((p) => P(p.x, p.y));
    // Plume outside the lips (not part of the heat stroke): the last 3 points of `plume`.
    const plume = [...airPx, P(10.3 + prot, lipY - jawDrop * 0.3 + 0.2), P(12.0 + prot, lipY + 0.7), P(13.8 + prot, lipY + 1.6)];
    const mouthT = (airPx.length - 1) / (plume.length - 1); // parameter where the path leaves the lips
    {
      const lv = this.level;
      const heat = lv < 0.35 ? withAlpha(theme("peak"), 0.35 + lv) : lv < 0.7 ? withAlpha(theme("target"), 0.6 + lv * 0.4) : withAlpha(theme("fg-0"), 0.9);
      stroke(airPx, heat, 1.2 + lv * 1.2);
    }

    // ---- tongue, mandible, lips (current)
    fillPath(tonguePx, withAlpha(tongueC, 0.12 + this.voice * 0.1));
    stroke(tonguePx, tongueC, 2, true);
    {
      const J = rot({ x: 6.0, y: 5.45 });
      ctx.strokeStyle = withAlpha(tongueC, 0.25); ctx.lineWidth = 1;
      for (let i = 0; i < 7; i++) {
        const ang = Math.PI * (0.22 + 0.82 * (i / 6));
        const e = { x: tb.x + Math.cos(ang) * TONGUE_R * 0.85, y: tb.y + Math.sin(ang) * TONGUE_R * 0.85 };
        const a = P(J.x, J.y), b = P(e.x, e.y), c = P((J.x + e.x) / 2 - 0.6, (J.y + e.y) / 2 + 0.3);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); ctx.stroke();
      }
    }
    stroke(mandiblePx, jawC, 1.6);
    stroke(upperLip, lipC, 2); stroke(lowerLip, lipC, 2);

    // ---- caliper: narrowest oral constriction (tongue–palate) or the lips
    if (live) {
      let best = { x: 0, gap: Infinity };
      for (let x = 1.8; x <= 7.2; x += 0.2) { const gap = roofY(x) - tongueTopY(x); if (gap < best.gap) best = { x, gap }; }
      const lipGap = A.lipAp;
      const atLips = lipGap < best.gap;
      const gx = atLips ? 8.6 + prot : best.x, gap = atLips ? lipGap : best.gap;
      const y1 = atLips ? lipY + lipGap / 2 : roofY(gx), y2 = atLips ? lipY - lipGap / 2 - jawDrop * 0.6 : tongueTopY(gx);
      const a = P(gx, y1), b = P(gx, y2);
      ctx.strokeStyle = theme("fg-0"); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.fillStyle = theme("fg-0"); ctx.font = font(9); ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(gap < 0.05 ? "CLOSED" : `${Math.max(0, gap).toFixed(1)} cm`, a.x + 4, (a.y + b.y) / 2);
    }

    // ---- glottis: coloured folds pulse at f0 while voiced, abduct wide while breathing
    {
      const gap = 0.06 + (this.voice > 0.2 ? 0.24 * Math.abs(Math.sin(this.phase * Math.PI)) : 0) + 0.6 * this.breath * (1 - this.voice);
      const foldFill = withAlpha(theme("clip"), 0.35 + 0.45 * this.voice);
      const foldLine = this.voice > 0.2 ? theme("clip") : withAlpha(theme("clip"), 0.75);
      for (const sgn of [-1, 1]) {
        const lens = [P(sgn * gap, 1.0 + lar), P(sgn * (gap + 0.55), 0.2 + lar), P(sgn * gap, -0.7 + lar), P(sgn * (gap + 0.25), 0.2 + lar)];
        fillPath(lens, foldFill);
        stroke(lens, foldLine, 1.2, true);
      }
    }

    // ---- airflow particles (phonation) and turbulence (breath / fricatives)
    const along = (t: number, off: number): P => {
      const u = Math.min(0.999, Math.max(0, t)) * (plume.length - 1), i = Math.min(plume.length - 2, Math.floor(u)), tt2 = u - i;
      const spread = t > mouthT ? 1 + (t - mouthT) / (1 - mouthT) * 2.5 : 1; // the plume widens outside
      return { x: lerp(plume[i].x, plume[i + 1].x, tt2), y: lerp(plume[i].y, plume[i + 1].y, tt2) + off * s * spread };
    };
    const outsideFade = (t: number) => (t <= mouthT ? 1 : Math.max(0, 1 - (t - mouthT) / (1 - mouthT)));
    // Phonation airflow: glottis → lips → out, in a warm colour.
    const want = Math.round(this.level * 24 * (0.3 + this.voice));
    while (this.particles.length < want) this.particles.push({ t: Math.random() * 0.1, off: (Math.random() - 0.5) * 0.5, speed: 0.5 + Math.random() * 0.5, life: 0.6 + Math.random() * 0.8 });
    for (let q = this.particles.length - 1; q >= 0; q--) {
      const p = this.particles[q];
      p.t += dt * p.speed * (0.4 + this.level) * (mouthT); p.life -= dt * 0.25;
      if (p.t >= 1 || p.life <= 0) { if (this.particles.length > want) { this.particles.splice(q, 1); continue; } p.t = Math.random() * 0.06; p.life = 0.6 + Math.random() * 0.8; }
      const pt = along(p.t, p.off);
      ctx.fillStyle = withAlpha(theme("peak"), (0.16 + 0.4 * Math.min(1, p.life)) * outsideFade(p.t));
      ctx.fillRect(pt.x - 1, pt.y - 1, 2, 2);
    }
    // Breath turbulence: white specks. Exhale flows out of the mouth; an inhale (short,
    // bright burst) is drawn flowing in from outside. Fricatives spawn at teeth/lips.
    const want2 = Math.round(this.breath * 55);
    const inward = inhale;
    const spawnT = inward ? 1.0 : f.centroid > 4000 ? mouthT * 0.92 : f.centroid > 2000 ? mouthT * 0.55 : 0.05;
    while (this.turb.length < want2) this.turb.push({ t: spawnT + (inward ? -Math.random() * 0.12 : Math.random() * 0.1), off: (Math.random() - 0.5) * 0.7, speed: (0.9 + Math.random()) * mouthT, life: 0.5 + Math.random() * 0.6 });
    for (let q = this.turb.length - 1; q >= 0; q--) {
      const p = this.turb[q];
      p.t += dt * p.speed * (inward ? -1 : 1); p.life -= dt; p.off += (Math.random() - 0.5) * 0.12;
      if (p.life <= 0 || p.t >= 1 || p.t <= 0) { this.turb.splice(q, 1); continue; }
      const pt = along(p.t, p.off);
      ctx.fillStyle = withAlpha(theme("fg-0"), 0.9 * (inward ? Math.min(1, 0.35 + (1 - p.t)) : outsideFade(p.t) * 0.9 + 0.1));
      ctx.fillRect(pt.x - 1, pt.y - 1, 2, 2);
    }
    if (this.turb.length > want2 + 12) this.turb.length = want2 + 12;

    // ---- lung lobe below the trachea: inflates with the inferred volume, glows while breathing
    {
      const v = 0.8 + 0.35 * this.lung; // size scale
      const c = { x: 0.9, y: -7.3 };
      const lobe: P[] = [[0.0, -5.4], [-1.3, -6.2], [-2.0, -7.6], [-1.5, -9.2], [0.4, -9.5], [2.6, -9.1], [3.4, -7.6], [2.9, -6.1], [1.8, -5.4]]
        .map(([x, y]) => P(c.x + (x - c.x) * v, c.y + (y - c.y) * v));
      fillPath(lobe, withAlpha(theme("sig-2"), 0.08 + 0.22 * this.breath + 0.1 * this.lung));
      stroke(lobe, withAlpha(theme("sig-2"), 0.55 + 0.45 * this.breath), 1.3, true);
      // bronchi
      stroke(Ps([[0.0, -5.4], [0.3, -6.6], [-0.4, -7.6]]), withAlpha(outline, 0.7), 1);
      stroke(Ps([[0.0, -5.4], [1.2, -6.5], [2.0, -7.5]]), withAlpha(outline, 0.7), 1);
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10); ctx.textAlign = "left"; ctx.textBaseline = "middle";
      const lbl = P(3.9, -7.4);
      ctx.fillText(this.breathRate > 0 ? `${this.breathRate.toFixed(0)}/min` : `${Math.round(this.lung * 100)}%`, lbl.x, lbl.y);
    }

    // ---- readouts
    ctx.font = font(10);
    ctx.fillStyle = theme("fg-1");
    ctx.textAlign = "right"; ctx.textBaseline = "top";
    const fx = w - 6;
    ([["F1", this.f1], ["F2", this.f2], ["F3", f.f3]] as const).forEach(([n, v], i) => ctx.fillText(`${n} ${live && v > 0 ? v.toFixed(0) + " Hz" : "—"}`, fx, 4 + i * 13));
    ctx.fillText(`jaw ${A.jaw.toFixed(1)}  lips ${A.lipAp.toFixed(1)} cm`, fx, 4 + 3 * 13);
    ctx.textAlign = "left";
    ctx.fillStyle = theme("fg-2");
    const breathy = live && f.voiced < 0.65;
    ctx.fillText(live ? (breathy ? "voiced · breathy" : "voiced") : this.breath > 0.2 ? (f.centroid > 4000 ? "fricative" : "breath") : "unvoiced", 6, 4);
    ctx.fillText(this.velum < 0.6 ? "velum open" : "velum shut", 6, 17);
  }
}
