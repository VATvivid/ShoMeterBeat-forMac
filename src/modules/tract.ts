import type { Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module } from "./types";
import { nearestVowel, tongueFromFormants } from "./vowels";

// Midsagittal vocal-tract profile (face looks left) driven by the live formant
// estimate: F1 → jaw/tongue height, F2 → tongue frontness, back vowels → lip
// rounding, f0 → glottal pulse, level → airflow particles. Pure parametric
// curves in a unit box; nothing anatomical is measured.

interface P { x: number; y: number }
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class TractModule implements Module {
  readonly id = "tract";
  readonly title = "Vocal Tract";
  private height = 0.5;   // 0 open … 1 close
  private front = 0.5;    // 0 back … 1 front
  private round = 0;      // lip rounding 0..1
  private open = 0;       // jaw opening 0..1 (voiced + low vowel)
  private voice = 0;      // smoothed voicing
  private level = 0;      // 0..1 from momentary loudness
  private phase = 0;      // glottal cycle
  private particles: { t: number; off: number; speed: number }[] = [];

  headReadout(f: Frame) {
    const n = f.voiced > 0.4 ? nearestVowel(f.f1, f.f2) : null;
    return `${n ? "[" + n.v.ipa + "] " : ""}f0 ${f.f0 > 0 && f.voiced > 0.4 ? f.f0.toFixed(0) : "—"} Hz`;
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    // ---- state update
    const live = f.voiced > 0.4 && f.f1 > 0 && f.f2 > 0;
    const k = Math.min(1, dt * 10);
    const lvl = Math.min(1, Math.max(0, (f.lufsM + 50) / 40));
    this.level += (lvl - this.level) * k;
    this.voice += ((live ? f.voiced : 0) - this.voice) * k;
    if (live) {
      const t = tongueFromFormants(f.f1, f.f2);
      this.height += (t.height - this.height) * k;
      this.front += (t.front - this.front) * k;
      this.round += ((1 - t.front) * 0.8 * (t.height > 0.4 ? 1 : 0.5) - this.round) * k;
      this.open += ((1 - t.height) * 0.9 + 0.1 - this.open) * k;
    } else {
      // relax to rest
      const r = Math.min(1, dt * 3);
      this.height += (0.5 - this.height) * r;
      this.front += (0.5 - this.front) * r;
      this.round += (0 - this.round) * r;
      this.open += (0 - this.open) * r;
    }
    if (this.voice > 0.2 && f.f0 > 0) this.phase = (this.phase + f.f0 * dt) % 1;

    // ---- geometry (unit box → px)
    const s = Math.min(w, h * 0.95);
    const ox = (w - s) / 2, oy = (h - s) / 2;
    const P = (x: number, y: number): P => ({ x: ox + x * s, y: oy + y * s });
    const jaw = this.open * 0.09;
    const prot = this.round * 0.035;
    const lipGap = 0.012 + this.open * 0.05 * (1 - this.round * 0.5);

    const line = (pts: P[], color: string, width = 1.5, close = false) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (close) ctx.closePath();
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.stroke();
    };
    const curve = (pts: P[], color: string, width = 1.5) => {
      // Catmull-Rom → bezier for a smooth stroke.
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
        ctx.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
      }
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.stroke();
    };

    const outline = theme("fg-2");
    const palateC = theme("fg-1");
    const tongueC = theme("sig");
    const jawC = theme("peak");
    const lipC = theme("sig-2");

    // Head / skull outline (static)
    curve([P(0.62, 0.04), P(0.40, 0.08), P(0.26, 0.20), P(0.20, 0.36), P(0.15, 0.44), P(0.22, 0.49), P(0.19, 0.54)], outline);
    curve([P(0.62, 0.04), P(0.80, 0.10), P(0.88, 0.30), P(0.86, 0.55), P(0.84, 0.80), P(0.86, 1.0)], outline);
    // Nasal cavity + hard/soft palate (velum lowers slightly with back vowels — nasal hint off)
    curve([P(0.24, 0.50), P(0.34, 0.47), P(0.46, 0.45), P(0.56, 0.45), P(0.64, 0.48)], palateC, 2);
    curve([P(0.30, 0.36), P(0.44, 0.33), P(0.58, 0.35), P(0.66, 0.42)], withAlpha(palateC, 0.5), 1);
    // Upper teeth
    line([P(0.235, 0.50), P(0.245, 0.545), P(0.265, 0.505)], outline, 1);
    // Pharynx back wall down to the larynx
    curve([P(0.66, 0.44), P(0.70, 0.56), P(0.72, 0.70), P(0.72, 0.86), P(0.74, 1.0)], outline);

    // Jaw (rotates down with opening): chin + jaw line + lower teeth + lower lip
    const chin = P(0.30, 0.76 + jaw);
    curve([P(0.20, 0.60 + jaw * 0.6), P(0.22, 0.70 + jaw), chin, P(0.42, 0.80 + jaw), P(0.58, 0.82 + jaw * 0.6), P(0.66, 0.84)], jawC, 1.5);
    line([P(0.25, 0.60 + jaw * 0.9), P(0.26, 0.57 + jaw * 0.9), P(0.28, 0.60 + jaw * 0.9)], outline, 1);

    // Lips
    const lipX = 0.19 - prot;
    curve([P(0.26, 0.515), P(lipX, 0.53), P(lipX - 0.01, 0.55 - lipGap / 2), P(0.22, 0.555 - lipGap / 2)], lipC, 2);
    curve([P(0.26, 0.60 + jaw * 0.9), P(lipX, 0.58 + jaw * 0.9), P(lipX - 0.01, 0.555 + lipGap / 2 + jaw * 0.9), P(0.22, 0.555 + lipGap / 2 + jaw * 0.9)], lipC, 2);

    // Tongue: root fixed near the pharynx, apex moves with height/frontness, tip near lower teeth
    const apex = P(lerp(0.60, 0.36, this.front), lerp(0.66, 0.475, this.height) + jaw * 0.5);
    const tip = P(lerp(0.40, 0.30, this.front), 0.60 + jaw * 0.9 - this.height * 0.04);
    const root = P(0.68, 0.72 + jaw * 0.3);
    const tongue = [P(0.30, 0.64 + jaw * 0.9), tip, apex, P(lerp(0.70, 0.56, this.front * 0.5), lerp(0.70, 0.58, this.height) + jaw * 0.4), root];
    ctx.beginPath();
    ctx.moveTo(tongue[0].x, tongue[0].y);
    for (let i = 0; i < tongue.length - 1; i++) {
      const p0 = tongue[Math.max(0, i - 1)], p1 = tongue[i], p2 = tongue[i + 1], p3 = tongue[Math.min(tongue.length - 1, i + 2)];
      ctx.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
    }
    ctx.lineTo(P(0.62, 0.84).x, P(0.62, 0.84).y);
    ctx.lineTo(P(0.34, 0.80 + jaw * 0.9).x, P(0.34, 0.80 + jaw * 0.9).y);
    ctx.closePath();
    ctx.fillStyle = withAlpha(tongueC, 0.12 + this.voice * 0.1);
    ctx.fill();
    curve(tongue, tongueC, 2);

    // Larynx + vocal folds (pulse when voiced)
    const gap = 0.004 + (this.voice > 0.2 ? 0.012 * Math.abs(Math.sin(this.phase * Math.PI)) : 0.0);
    line([P(0.70, 0.86), P(0.70, 0.95)], outline, 1);
    const foldC = this.voice > 0.2 ? theme("clip") : outline;
    line([P(0.72 - gap, 0.87), P(0.72 - gap * 2, 0.90), P(0.72 - gap, 0.93)], foldC, 1.5);
    line([P(0.72 + gap, 0.87), P(0.72 + gap * 2, 0.90), P(0.72 + gap, 0.93)], foldC, 1.5);

    // Airflow particles from glottis to lips when there is level
    const path = [P(0.72, 0.86), P(0.70, 0.74), P(0.66, 0.60), P(0.56, 0.52), P(0.42, 0.51), P(0.30, 0.53), P(lipX - 0.02, 0.555)];
    const want = Math.round(this.level * 18 * (0.3 + this.voice));
    while (this.particles.length < want) this.particles.push({ t: Math.random(), off: (Math.random() - 0.5) * 0.02, speed: 0.6 + Math.random() * 0.6 });
    if (this.particles.length > want) this.particles.length = want;
    ctx.fillStyle = withAlpha(theme("peak"), 0.8);
    for (const p of this.particles) {
      p.t += dt * p.speed * (0.5 + this.level);
      if (p.t > 1) p.t -= 1;
      const u = p.t * (path.length - 1), i = Math.min(path.length - 2, Math.floor(u)), tt = u - i;
      const x = lerp(path[i].x, path[i + 1].x, tt), y = lerp(path[i].y, path[i + 1].y, tt) + p.off * s;
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }

    // Readouts
    ctx.font = font(10);
    ctx.fillStyle = theme("fg-1");
    ctx.textAlign = "right"; ctx.textBaseline = "top";
    const fx = w - 6;
    const rows = [["F1", f.f1], ["F2", f.f2], ["F3", f.f3]] as const;
    rows.forEach(([n, v], i) => ctx.fillText(`${n} ${live && v > 0 ? v.toFixed(0) + " Hz" : "—"}`, fx, 4 + i * 13));
    ctx.textAlign = "left";
    ctx.fillStyle = theme("fg-2");
    ctx.fillText(live ? "voiced" : "unvoiced", 6, 4);
  }
}
