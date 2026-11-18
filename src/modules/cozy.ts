import type { Frame } from "../engine/frame";
import { freqToIndex, SILENCE_DB } from "../engine/frame";
import { theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";
import { IS_MINI } from "../mini";

// Cozy (코지 룸 · 재미용): a warm little study room that lives on what is playing.
//
// Tone (2026-11-17, from the Healimals thumbnail the user pointed at): cream walls, honey
// wood, a sage banker's lamp, rust curtains, a round white cat with a thick soft outline,
// flat pastel colours, daylight — nothing dark or neon. The palette is its own set of CSS
// tokens (`--cozy-*`, style.css) so the module keeps the "colours from tokens" rule while
// looking nothing like the meters around it. Shapes are rasterised on a 192×108 grid with
// chunky pixels (so the same drawing runs in the smoke / PNG harness), outlined by drawing
// the line colour one unit larger first.
//
// How the sound drives it (frame values only):
//   level (RMS)        → lamp glow, radio on/off, cat asleep after 2 s of quiet / awake
//   transients (punchM rising edge) → cat ear flick + head bob, mug wobble on big hits
//   low band energy    → plant leaves sway
//   spectrum bands     → the radio's 5 little bars (60 Hz, 200, 600, 2 k, 6 k)
//   melody candidate   → the piano's key lights up on the note being played
//   noise-like sound   → rain on the window; clipping → the lamp flickers
// Mini mode (미니): only the cat, the mug and the plant on a transparent background, for
// the dedicated always-on-top mini window at the bottom of the screen.

const SCENE_W = 192, SCENE_H = 108;
/** Mini = a corner diorama hugging the bottom-right of the screen (user mock-up 2026-11-17). */
const MINI_W = 160, MINI_H = 96;

type Px = (x: number, y: number, w: number, h: number, col: string) => void;
type Tok = (k: string) => string;
const T: Record<string, string> = {
  cream: "cozy-cream", cream2: "cozy-cream-2", wood: "cozy-wood", wood2: "cozy-wood-2", line: "cozy-line", sage: "cozy-sage", brass: "cozy-brass",
  rust: "cozy-rust", dusk1: "cozy-dusk-1", dusk2: "cozy-dusk-2", dusk3: "cozy-dusk-3", bush: "cozy-bush", cat: "cozy-cat", cat2: "cozy-cat-2", pink: "cozy-pink",
  ba: "cozy-book-a", bb: "cozy-book-b", bc: "cozy-book-c", bd: "cozy-book-d",
  w: "fg-0", k: "bg-0", c: "sig", y: "target", o: "peak",
};

/**
 * Linear mix of two hex colours (t = 0 → a, 1 → b) as a #rrggbb string — hex, so the result can go
 * through `withAlpha` (an rgb() string there became rgba(NaN…), addColorStop threw, and the mini
 * window — transparent — went blank whenever music played: 2026-11-17).
 */
function mix(a: string, b: string, t: number): string {
  const p = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  const A = a.replace("#", ""), B = b.replace("#", "");
  const u = Math.max(0, Math.min(1, t));
  const ch = (i: number) => Math.round(p(A, i) + (p(B, i) - p(A, i)) * u).toString(16).padStart(2, "0");
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

export class CozyModule implements Module {
  readonly id = "cozy";
  readonly title = "Cozy";
  private t = 0;
  private level = SILENCE_DB;
  private lamp = 0.5;
  private quietFor = 0;
  private awake = 1;
  private lastPunch = SILENCE_DB;
  private earFlick = 0;
  private bob = 0;                     // head bob impulse 1 → 0
  private cupWobble = 0;
  private rain = 0;
  private sway = 0;
  private swayPos = 0;
  private bands = new Float32Array(5);
  private steam: { x: number; y: number; life: number; max: number; drift: number }[] = [];
  private drops: { x: number; y: number; v: number }[] = [];
  private blink = 0;
  private blinkAt = 3;
  private zz = 0;
  private key = -1;
  private keyHold = 0;
  private flicker = 0;

  /** One module, two views: the room in a tile, the corner diorama in the dedicated mini window (mini.ts). */
  private get mini() { return IS_MINI; }
  private get showFx() { return modSetting(this.id, "fx", true); }
  private get sleepDb() { return modSetting(this.id, "sleepDb", -55); }

  /** Painted base art for the corner view (public/cozy/corner.png); procedural fallback when it is missing. */
  private art: HTMLImageElement | null = null;
  private artOk = false;

  /** Optional sleeping pose of the same picture (public/cozy/corner_sleep.png): cross-faded by `awake`. */
  private sleepArt: HTMLImageElement | null = null;
  private sleepOk = false;
  /** The left plant's leaves cut out of the art (public/cozy/corner_plant.png), swayed around the pot. */
  private plantArt: HTMLImageElement | null = null;
  private plantOk = false;
  private plantSway = 0;                 // 0 → 1 while sound plays (eased), scales the calm sway
  private swayPh = [Math.random() * 6.28, Math.random() * 6.28];
  /** Window light per band (0..1, slow attack / slower release so beams breathe rather than flicker). */
  private light = new Float32Array(5);
  private bandMean = new Float32Array(5);
  /** Sky pixels of the corner art (public/cozy/corner_sky.png, white on transparent). */
  private skyMask: HTMLImageElement | null = null;
  private skyOk = false;
  private tintCanvas: HTMLCanvasElement | null = null;
  /** Sky-cycle offset in cycle steps: drifts warm (+) with bright sound, cool (−) with dark sound. */
  private skyBias = 0;

  /**
   * Play poses (2026-11-17 사용자: 소리가 나는 동안 가끔 랜덤 포즈; 2026-11-18 새 배경·새 고양이 그림으로
   * 그루밍·기지개 2개만 — 실타래·앉아 조는 포즈는 뺌). Optional pictures public/cozy/corner_play1.png (groom),
   * corner_play2.png (stretch), same composition as corner.png
   * (only the cat differs). While sound plays, every 12–25 s the cat switches to a random pose
   * (or back to the base picture) with a 0.8 s cross-fade; when the sound stops it settles back
   * on the base picture before dozing off. Missing files are simply never picked.
   */
  private poses: (HTMLImageElement | null)[] = [null, null];
  private poseSky: (HTMLImageElement | null)[] = [null, null];
  private poseSkyOk = [false, false];
  /** Sky mask for what is on screen: the play pose's own mask once its cross-fade is past halfway. */
  private currentSky(): HTMLImageElement {
    const i = this.poseFade < 0.5 ? this.poseFrom : this.poseTo;
    return i >= 0 && this.poseSkyOk[i] && this.poseSky[i] ? this.poseSky[i]! : this.skyMask!;
  }
  private posesOk = [false, false];
  private poseFrom = -1;               // −1 = base picture
  private poseTo = -1;
  private poseFade = 1;                // 0 → 1 while cross-fading from → to
  private nextPoseAt = 15;
  private poseImg(i: number): HTMLImageElement {
    return i >= 0 && this.posesOk[i] && this.poses[i] ? this.poses[i]! : this.art!;
  }
  private updatePose(dt: number, playing: boolean) {
    if (this.poseFade < 1) {
      this.poseFade = Math.min(1, this.poseFade + dt / 0.8);
      if (this.poseFade >= 1) this.poseFrom = this.poseTo;
      return;
    }
    const avail = this.posesOk.map((ok, i) => (ok ? i : -2)).filter((i) => i >= 0);
    const want = (target: number) => { if (target !== this.poseFrom) { this.poseTo = target; this.poseFade = 0; } };
    if (!playing || this.awake < 0.6) { if (this.poseFrom !== -1) want(-1); this.nextPoseAt = this.t + 8 + Math.random() * 10; return; }
    if (!avail.length || this.t < this.nextPoseAt) return;
    const choices = [-1, ...avail].filter((i) => i !== this.poseFrom);
    want(choices[Math.floor(Math.random() * choices.length)]);
    this.nextPoseAt = this.t + 12 + Math.random() * 13;
  }

  /** Paints `color` over the sky pixels only, with the given composite and alpha. */
  private tintSky(ctx: CanvasRenderingContext2D, color: string, op: GlobalCompositeOperation, alpha: number, ox: number, oy: number, s: number) {
    const m = this.currentSky();
    let c = this.tintCanvas;
    if (!c) { c = document.createElement("canvas"); c.width = m.naturalWidth || 800; c.height = m.naturalHeight || 480; this.tintCanvas = c; }
    const t = c.getContext("2d");
    if (!t) return;
    t.globalCompositeOperation = "source-over";
    t.clearRect(0, 0, c.width, c.height);
    t.fillStyle = color; t.fillRect(0, 0, c.width, c.height);
    t.globalCompositeOperation = "destination-in";
    t.drawImage(m, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = op;
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(c, ox, oy, MINI_W * s, MINI_H * s);
    ctx.restore();
  }

  constructor() {
    if (typeof Image !== "undefined") {
      const img = new Image();
      img.onload = () => { this.artOk = img.naturalWidth > 0; };
      img.onerror = () => { this.artOk = false; };
      img.src = "/cozy/corner.png";
      this.art = img;
      const sl = new Image();
      sl.onload = () => { this.sleepOk = sl.naturalWidth > 0; };
      sl.onerror = () => { this.sleepOk = false; };
      sl.src = "/cozy/corner_sleep.png";
      this.sleepArt = sl;
      const pl = new Image();
      pl.onload = () => { this.plantOk = pl.naturalWidth > 0; };
      pl.onerror = () => { this.plantOk = false; };
      pl.src = "/cozy/corner_plant.png";
      this.plantArt = pl;
      const sk = new Image();
      sk.onload = () => { this.skyOk = sk.naturalWidth > 0; };
      sk.onerror = () => { this.skyOk = false; };
      sk.src = "/cozy/corner_sky.png";
      this.skyMask = sk;
      for (let i = 0; i < this.poses.length; i++) {
        const p = new Image();
        p.onload = () => { this.posesOk[i] = p.naturalWidth > 0; };
        p.onerror = () => { this.posesOk[i] = false; };
        p.src = `/cozy/corner_play${i + 1}.png`;
        this.poses[i] = p;
        // each play pose has its own sky mask (the old cat's place is sky there, the new cat is not)
        const m = new Image();
        m.onload = () => { this.poseSkyOk[i] = m.naturalWidth > 0; };
        m.onerror = () => { this.poseSkyOk[i] = false; };
        m.src = `/cozy/corner_play${i + 1}_sky.png`;
        this.poseSky[i] = m;
      }
    }
  }

  settings(): SettingItem[] {
    return [
      { type: "toggle", label: "비 효과", value: this.showFx, onChange: (v) => setModSetting(this.id, "fx", v) },
      { type: "range", label: "잠드는 조용함 (dB)", value: this.sleepDb, min: -80, max: -30, step: 5, format: (v) => `${v} dB`, onChange: (v) => setModSetting(this.id, "sleepDb", v) },
    ];
  }

  headReadout() {
    const state = this.awake < 0.3 ? "😴 자는 중" : this.rain > 0.5 ? "🌧 비" : this.level > -30 ? "🎵 듣는 중" : "☕";
    return `${state}  · 램프 ${Math.round(this.lamp * 100)}%`;
  }

  // ---- sound → state ---------------------------------------------------------------
  private update(f: Frame, dt: number) {
    this.t += dt;
    this.frameDt = dt;
    for (const n of this.notes) n.life += dt;
    this.notes = this.notes.filter((n) => n.life < n.max);
    const lvl = Math.max(f.rms[0], f.rms[1]);
    this.level += (lvl - this.level) * Math.min(1, dt * (lvl > this.level ? 8 : 1.5));
    const playing = this.level > this.sleepDb;
    this.quietFor = playing ? 0 : this.quietFor + dt;
    const wantAwake = this.quietFor < 2 ? 1 : 0;
    this.awake += (wantAwake - this.awake) * Math.min(1, dt * (wantAwake ? 3 : 0.8));
    // lamp: on with the music (brightness follows the level), off in silence (2026-11-17 사용자:
    // 음악이 없을 때 스탠드가 꺼져 보이게) — switches on quickly, fades off over ~1.5 s
    const target = playing ? 0.55 + 0.45 * Math.max(0, Math.min(1, (this.level + 45) / 35)) : 0;
    this.lamp += (target - this.lamp) * Math.min(1, dt * (target > this.lamp ? 4 : 0.7));
    if (Math.max(f.peak[0], f.peak[1]) > -0.2) this.flicker = 0.25;
    this.flicker = Math.max(0, this.flicker - dt);
    const rise = f.punchM - this.lastPunch;
    this.lastPunch = f.punchM;
    if (rise > 6 && f.punchM > -35 && this.awake > 0.5) {
      this.earFlick = 0.35;
      this.bob = 1;
      if (f.punchM > -14) this.cupWobble = 1;
    }
    this.earFlick = Math.max(0, this.earFlick - dt);
    this.bob = Math.max(0, this.bob - dt * 3.5);
    this.cupWobble = Math.max(0, this.cupWobble - dt * 3);
    const rainy = this.showFx && playing && f.flatness > 0.38 && f.centroid > 1500;
    this.rain += ((rainy ? 1 : 0) - this.rain) * Math.min(1, dt * (rainy ? 1.2 : 0.5));
    const lo = this.bandDb(f, 40, 140);
    const push = Math.max(0, (lo + 50) / 30) * 0.9;
    this.sway += (push * (Math.sin(this.t * 1.3) + 0.3 * Math.sin(this.t * 3.1)) - this.swayPos * 6 - this.sway * 2) * dt * 5;
    this.swayPos += this.sway * dt;
    const edges = [[40, 100], [140, 300], [400, 900], [1400, 3000], [4000, 9000]];
    for (let i = 0; i < 5; i++) {
      const v = Math.max(0, Math.min(1, (this.bandDb(f, edges[i][0], edges[i][1]) + 60) / 45));
      this.bands[i] += (v - this.bands[i]) * Math.min(1, dt * (v > this.bands[i] ? 14 : 4));
      // window light: the slow average of each band (~4 s), drifting on its own ~19 s swell, eased
      // in over ~3 s and out over ~5 s — it follows the music's overall colour, never its hits, so
      // it does not pulse in step with the lamp (which follows the level within ~0.5 s).
      // (2026-11-17 사용자: 번개 같다 → 약하게, 이어서 스탠드와 타이밍이 맞으면 안 되고 더 느리고 서서히)
      this.bandMean[i] += (v - this.bandMean[i]) * Math.min(1, dt * 0.25);
      const drift = 0.6 + 0.4 * Math.sin(this.t * (2 * Math.PI / 19) + i * 1.3);
      const tgt = playing ? Math.max(0, Math.min(1, 0.6 * this.bandMean[i] * drift)) : 0;
      this.light[i] += (tgt - this.light[i]) * Math.min(1, dt * (tgt > this.light[i] ? 0.35 : 0.2));
    }
    {
      // plant: the sway fades in while sound plays and settles when it stops (no strength dependence)
      this.plantSway += ((playing ? 1 : 0) - this.plantSway) * Math.min(1, dt * 0.8);
      this.updatePose(dt, playing);
      // sky: bright sound (high centroid) leans the cycle toward warm, dark sound toward night
      if (playing && f.centroid > 0) {
        const lean = Math.max(-1, Math.min(1, Math.log2(f.centroid / 1500)));
        this.skyBias += -lean * dt * 0.05;
      }
    }
    const hz = f.melody[0], sal = f.melody[1];
    if (hz > 0 && sal > 0.2 && f.flatness < 0.35) {
      const midi = Math.round(69 + 12 * Math.log2(hz / 440));
      const pc = ((midi % 12) + 12) % 12;
      const white = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6][pc];
      this.key = (Math.floor(midi / 12) % 2) * 7 + white;
      this.keyHold = 0.25;
    } else {
      this.keyHold -= dt;
      if (this.keyHold <= 0) this.key = -1;
    }
    if (this.t > this.blinkAt) { this.blink = 0.12; this.blinkAt = this.t + 2.5 + Math.random() * 4; }
    this.blink = Math.max(0, this.blink - dt);
    this.zz += dt;
    if (Math.random() < dt * (playing ? 2.5 : 1.2)) this.steam.push({ x: Math.random() * 4 - 2, y: 0, life: 0, max: 2 + Math.random(), drift: Math.random() * 2 - 1 });
    for (const s of this.steam) { s.life += dt; s.y -= dt * 7; s.x += s.drift * dt * 1.5; }
    this.steam = this.steam.filter((s) => s.life < s.max);
    if (this.rain > 0.05 && Math.random() < dt * 40 * this.rain) this.drops.push({ x: Math.random(), y: 0, v: 40 + Math.random() * 25 });
    for (const d of this.drops) d.y += d.v * dt;
    this.drops = this.drops.filter((d) => d.y < 44);
  }

  private bandDb(f: Frame, lo: number, hi: number): number {
    const a = Math.max(0, Math.ceil(freqToIndex(lo))), b = Math.min(f.specL.length - 1, Math.floor(freqToIndex(hi)));
    let m = SILENCE_DB;
    for (let i = a; i <= b; i++) m = Math.max(m, f.specL[i]);
    return m;
  }

  // ---- raster helpers (scene units; px draws one scene pixel) --------------------
  private shapes(px: Px) {
    const rect = (x: number, y: number, w: number, h: number, col: string) => px(x, y, w, h, col);
    const ellipse = (cx: number, cy: number, rx: number, ry: number, col: string) => {
      for (let yy = Math.ceil(cy - ry); yy <= Math.floor(cy + ry); yy++) {
        const dy = (yy + 0.5 - cy) / ry, k = 1 - dy * dy;
        if (k <= 0) continue;
        const half = rx * Math.sqrt(k);
        px(Math.round(cx - half), yy, Math.max(1, Math.round(2 * half)), 1, col);
      }
    };
    const circle = (cx: number, cy: number, r: number, col: string) => ellipse(cx, cy, r, r, col);
    const rrect = (x: number, y: number, w: number, h: number, r: number, col: string) => {
      r = Math.min(r, w / 2, h / 2);
      for (let yy = 0; yy < h; yy++) {
        const d = yy < r ? r - yy - 0.5 : yy >= h - r ? yy + 0.5 - (h - r) : -1;
        const inset = d > 0 ? r - Math.sqrt(Math.max(0, r * r - d * d)) : 0;
        px(x + Math.round(inset), y + yy, Math.max(1, w - 2 * Math.round(inset)), 1, col);
      }
    };
    // outlined versions: line colour one unit larger, fill inside
    const oCircle = (cx: number, cy: number, r: number, fill: string, line: string) => { circle(cx, cy, r + 1, line); circle(cx, cy, r, fill); };
    const oEllipse = (cx: number, cy: number, rx: number, ry: number, fill: string, line: string) => { ellipse(cx, cy, rx + 1, ry + 1, line); ellipse(cx, cy, rx, ry, fill); };
    const oRrect = (x: number, y: number, w: number, h: number, r: number, fill: string, line: string) => { rrect(x - 1, y - 1, w + 2, h + 2, r + 1, line); rrect(x, y, w, h, r, fill); };
    return { rect, ellipse, circle, rrect, oCircle, oEllipse, oRrect };
  }

  // ---- drawing ---------------------------------------------------------------------
  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    this.update(f, dt);
    const mini = this.mini;
    const tok: Tok = (k) => theme(T[k] ?? "fg-1");
    if (this.artOk && this.art) {
      // The painted scene is the module, in a tile and in the mini window alike (2026-11-17
      // 사용자: 하나로 통합). Mini: bottom-right, scaled to the window the user sized, nothing
      // behind. Tile: fitted, bottom-anchored, on a dusk-sky backdrop so the keyed-out
      // surround does not read as a hole.
      const fit = Math.min(w / MINI_W, h / MINI_H);
      const s = fit;
      const ox = mini ? w - MINI_W * s : (w - MINI_W * s) / 2, oy = h - MINI_H * s;
      if (!mini) {
        const bg = ctx.createLinearGradient(0, 0, 0, h);
        bg.addColorStop(0, tok("dusk3")); bg.addColorStop(0.6, tok("dusk2")); bg.addColorStop(1, tok("dusk1"));
        ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
      }
      const px: Px = (x, y, pw, ph, col) => { ctx.fillStyle = col; ctx.fillRect(ox + x * s, oy + y * s, pw * s, ph * s); };
      this.drawArt(ctx, this.shapes(px), s, ox, oy, tok);
      return;
    }
    // ---- procedural fallback (no art file): the drawn room in a tile, the drawn corner in the mini
    const SW = mini ? MINI_W : SCENE_W, SH = mini ? MINI_H : SCENE_H;
    const s = Math.max(1, Math.floor(Math.min(w / SW, h / SH)));
    const ox = mini ? w - SW * s : Math.floor((w - SW * s) / 2), oy = mini ? h - SH * s : Math.floor((h - SH * s) / 2);
    const px: Px = (x, y, pw, ph, col) => { ctx.fillStyle = col; ctx.fillRect(ox + x * s, oy + y * s, pw * s, ph * s); };
    const S = this.shapes(px);
    if (mini) { this.drawCorner(ctx, S, s, ox, oy, tok); return; }

    // ---- room: cream wall, honey floor, baseboard
    S.rect(0, 0, SW, 72, tok("cream"));
    S.rect(0, 72, SW, SH - 72, tok("wood"));
    S.rect(0, 70, SW, 2, tok("wood2"));
    for (let x = 8; x < SW; x += 24) S.rect(x, 74, 1, SH - 74, withAlpha(tok("wood2"), 0.35)); // floorboards
    // ---- arched window: dusk sky (peach → lavender → blue), stars, trees with flowers
    const wx = 24, wy = 6, ww = 56, wh = 48;
    const arch = (x: number, y: number, w2: number, h2: number, col: string | ((row: number) => string)) => {
      const r = w2 / 2;
      for (let yy = 0; yy < h2; yy++) {
        const c = typeof col === "string" ? col : col(yy / h2);
        if (yy < r) { const dy = r - yy - 0.5; const half = Math.sqrt(Math.max(0, r * r - dy * dy)); S.rect(x + Math.round(r - half), y + yy, Math.max(1, Math.round(2 * half)), 1, c); }
        else S.rect(x, y + yy, w2, 1, c);
      }
    };
    arch(wx - 2, wy - 2, ww + 4, wh + 2, tok("line"));
    arch(wx, wy, ww, wh, (t) => (t < 0.55 ? mix(tok("dusk3"), tok("dusk2"), t / 0.55) : mix(tok("dusk2"), tok("dusk1"), (t - 0.55) / 0.45)));
    for (let i = 0; i < 9; i++) { // stars, twinkling, high in the arch
      const sx = wx + 8 + ((i * 37) % (ww - 16)), sy = wy + 6 + ((i * 23) % 14);
      S.rect(sx, sy, 1, 1, withAlpha(tok("w"), 0.4 + 0.6 * Math.abs(Math.sin(this.t * 0.9 + i * 1.7))));
    }
    S.ellipse(wx + 16, wy + 20, 9, 2, withAlpha(tok("dusk1"), 0.7)); S.ellipse(wx + 40, wy + 15, 7, 2, withAlpha(tok("dusk1"), 0.6)); // thin clouds
    for (const [bx, by, br] of [[wx + 8, wy + wh - 4, 12], [wx + 24, wy + wh - 2, 14], [wx + 42, wy + wh - 5, 12], [wx + 54, wy + wh - 1, 10]] as const) S.ellipse(bx, by, br, br * 0.7, tok("bush"));
    for (let i = 0; i < 6; i++) S.rect(wx + 6 + ((i * 19) % (ww - 10)), wy + wh - 12 + ((i * 7) % 8), 2, 2, i % 2 ? tok("pink") : tok("brass")); // flowers
    if (this.rain > 0.05) for (const r of this.drops) S.rect(wx + 2 + Math.floor(r.x * (ww - 4)), wy + Math.floor(r.y), 1, 3, withAlpha(tok("w"), 0.5 * this.rain));
    S.rect(wx + ww / 2 - 1, wy + 4, 2, wh - 4, tok("line")); S.rect(wx, wy + wh - 16, ww, 2, tok("line")); // mullions
    S.oRrect(wx - 8, wy + wh - 1, ww + 16, 4, 1, tok("wood2"), tok("line"));                     // sill
    // ---- wall sconces either side of the window: warm glow follows the level
    this.drawSconce(ctx, S, wx - 14, wy + 14, s, ox, oy, tok);
    this.drawSconce(ctx, S, wx + ww + 14, wy + 14, s, ox, oy, tok);
    // ---- plant on the sill (leaves sway with the bass)
    this.drawPlant(S, 30, wy + wh - 12, this.swayPos, tok);
    // ---- bookshelf (right) with the radio on top
    S.oRrect(130, 6, 56, 64, 2, tok("wood2"), tok("line"));
    for (let shelf = 0; shelf < 3; shelf++) {
      const sy = 26 + shelf * 16;
      S.rect(132, sy, 52, 2, tok("line"));
      let bx = 134;
      const cols = ["ba", "bb", "bc", "bd", "ba", "bc", "bb", "bd"];
      for (let i = 0; i < 8 && bx < 182; i++) { const bw = 4 + ((i * 7 + shelf * 3) % 3); const bh = 9 + ((i + shelf) % 3) * 2; S.oRrect(bx, sy - bh, bw, bh, 1, tok(cols[(i + shelf) % cols.length]), tok("line")); bx += bw + 2; }
    }
    this.drawRadio(S, 136, 10, this.level > this.sleepDb && this.awake > 0.3, tok);
    // ---- piano against the back wall between window and shelf
    this.drawPiano(S, 82, 42, tok);
    // ---- carpet
    S.oRrect(36, 76, 120, 14, 5, tok("rust"), tok("line"));
    S.rrect(42, 80, 108, 6, 3, withAlpha(tok("cream"), 0.35));
    // ---- cat behind the desk (drawn before the desk so the desk covers its lap)
    this.drawCat(S, 96, 62, 1, tok);
    // ---- desk (foreground) with lamp, book, mug
    S.oRrect(-2, 88, SW + 4, 24, 3, tok("wood"), tok("line"));
    S.rect(0, 92, SW, 1, withAlpha(tok("wood2"), 0.5));
    this.drawLamp(ctx, S, 18, 58, s, ox, oy, tok);
    S.oRrect(78, 90, 36, 11, 2, tok("w"), tok("line")); S.rect(95, 91, 2, 9, tok("line")); // open book
    for (let i = 0; i < 3; i++) { S.rect(82, 93 + i * 3, 10, 1, withAlpha(tok("line"), 0.35)); S.rect(100, 93 + i * 3, 10, 1, withAlpha(tok("line"), 0.35)); }
    this.drawMug(S, 134, 80, this.cupWobble, tok);
    this.drawCandle(S, 158, 82, 0, tok); this.drawCandle(S, 170, 84, 1, tok);
    // paws on the desk
    S.oEllipse(84, 92, 5, 3, tok("cat"), tok("line")); S.oEllipse(110, 92, 5, 3, tok("cat"), tok("line"));
  }

  private drawSconce(ctx: CanvasRenderingContext2D, S: ReturnType<CozyModule["shapes"]>, x: number, y: number, s: number, ox: number, oy: number, tok: Tok) {
    const a = this.lamp * (this.flicker > 0 && Math.sin(this.t * 60) > 0 ? 0.4 : 1);
    const g = ctx.createRadialGradient(ox + x * s, oy + y * s, s, ox + x * s, oy + y * s, 22 * s);
    g.addColorStop(0, withAlpha(tok("brass"), 0.5 * a)); g.addColorStop(1, withAlpha(tok("brass"), 0));
    ctx.fillStyle = g; ctx.fillRect(ox + (x - 22) * s, oy + (y - 22) * s, 44 * s, 44 * s);
    S.oRrect(x - 5, y - 6, 10, 7, 2, mix(tok("cream2"), tok("brass"), 0.5 * a), tok("line")); // shade
    S.rect(x - 1, y + 1, 2, 7, tok("line")); S.oCircle(x, y + 9, 2, tok("wood2"), tok("line"));
  }

  private drawCandle(S: ReturnType<CozyModule["shapes"]>, x: number, y: number, seed: number, tok: Tok) {
    const fl = 0.7 + 0.3 * Math.sin(this.t * (9 + seed * 2) + seed) + 0.6 * this.bob;
    S.oRrect(x, y + 4, 7, 9, 2, tok("cat2"), tok("line"));
    S.rect(x + 3, y + 2, 1, 2, tok("line"));
    S.ellipse(x + 3.5, y + 1 - fl, 1.5, 2 + fl, tok("brass"));
    S.ellipse(x + 3.5, y + 1.5 - fl * 0.5, 0.8, 1, tok("w"));
  }

  /**
   * Corner diorama (미니): no walls — a patch of floor that fades out to the left, a window
   * with a sunset and a city skyline, ivy on its frame, a hanging lamp and an upright piano
   * on the right (the heavy side sits in the screen corner), a radio on a shelf, a calico
   * cat lying on a cushion, a cat mug, two plants. Effects stay small: notes drift up from
   * the radio while music plays, steam from the mug, leaves sway, ears/tail twitch.
   */
  private drawCorner(ctx: CanvasRenderingContext2D, S: ReturnType<CozyModule["shapes"]>, s: number, ox: number, oy: number, tok: Tok) {
    const playing = this.level > this.sleepDb && this.awake > 0.3;
    // ---- floor: planks fading out towards the left edge so the scene melts into the desktop
    for (let x = 0; x < MINI_W; x++) {
      const a = Math.min(1, x / 44);
      S.rect(x, 84, 1, 12, withAlpha(tok("wood"), a));
      if (x % 20 === 0) S.rect(x, 85, 1, 11, withAlpha(tok("wood2"), 0.35 * a));
    }
    S.rect(44, 84, MINI_W - 44, 1, withAlpha(tok("line"), 0.5));
    // ---- window with a sunset and the city, ivy round the frame
    const wx = 58, wy = 10, ww = 54, wh = 54;
    S.oRrect(wx, wy, ww, wh, 2, tok("dusk2"), tok("line"));
    for (let yy = 1; yy < wh - 1; yy++) { const t = yy / wh; S.rect(wx + 1, wy + yy, ww - 2, 1, t < 0.5 ? mix(tok("dusk3"), tok("dusk2"), t / 0.5) : mix(tok("dusk2"), tok("dusk1"), (t - 0.5) / 0.5)); }
    S.ellipse(wx + 40, wy + 22, 6, 6, withAlpha(tok("brass"), 0.9)); // low sun
    for (let i = 0; i < 7; i++) { const sx = wx + 6 + ((i * 29) % (ww - 12)); S.rect(sx, wy + 4 + ((i * 13) % 10), 1, 1, withAlpha(tok("w"), 0.5 + 0.5 * Math.abs(Math.sin(this.t + i)))); }
    const sky = [[2, 14], [8, 9], [13, 18], [20, 12], [26, 22], [34, 15], [40, 11], [46, 19]];
    for (const [bx, bh] of sky) S.rect(wx + bx, wy + wh - bh - 1, 5, bh, withAlpha(tok("line"), 0.55)); // skyline
    for (const [bx, bh] of sky) for (let k = 0; k < 2; k++) S.rect(wx + bx + 1 + k * 2, wy + wh - bh + 2, 1, 1, withAlpha(tok("brass"), 0.7)); // lit windows
    S.rect(wx + ww / 2 - 1, wy + 2, 2, wh - 4, tok("line")); S.rect(wx + 2, wy + wh / 2 - 1, ww - 4, 2, tok("line"));
    if (this.rain > 0.05) for (const r of this.drops) S.rect(wx + 2 + Math.floor(r.x * (ww - 4)), wy + 2 + Math.floor(r.y), 1, 3, withAlpha(tok("w"), 0.5 * this.rain));
    S.oRrect(wx - 4, wy + wh, ww + 8, 3, 1, tok("wood2"), tok("line")); // sill
    for (let i = 0; i < 9; i++) { // ivy along the top and left of the frame
      const lx = i < 5 ? wx - 3 + Math.round(Math.sin(i * 1.3) * 2) : wx - 2 + (i - 4) * 9, ly = i < 5 ? wy + 2 + i * 10 : wy - 3 + Math.round(Math.cos(i) * 2);
      S.oEllipse(lx, ly, 3, 2, i % 2 ? tok("sage") : mix(tok("sage"), tok("bush"), 0.5), tok("line"));
    }
    // ---- hanging lamp (top-right) with its warm pool of light over the piano
    const lx = 140, ly = 12;
    S.rect(lx, 0, 1, ly - 6, tok("line"));
    const a = this.lamp * (this.flicker > 0 && Math.sin(this.t * 60) > 0 ? 0.4 : 1);
    const g = ctx.createRadialGradient(ox + lx * s, oy + (ly + 4) * s, s, ox + lx * s, oy + (ly + 4) * s, 46 * s);
    g.addColorStop(0, withAlpha(tok("brass"), 0.45 * a)); g.addColorStop(1, withAlpha(tok("brass"), 0));
    ctx.fillStyle = g; ctx.fillRect(ox + (lx - 46) * s, oy + (ly - 10) * s, 92 * s, 80 * s);
    S.oEllipse(lx, ly - 2, 9, 4, tok("wood2"), tok("line")); S.rect(lx - 9, ly - 2, 18, 4, tok("wood2")); // shade
    S.ellipse(lx, ly + 2, 3, 2, mix(tok("brass"), tok("w"), 0.5 * a));                                // bulb
    // ---- upright piano on the right, sheet music, keys lit by the melody
    S.oRrect(118, 42, 42, 44, 2, tok("wood2"), tok("line"));
    S.oRrect(126, 46, 24, 14, 1, tok("w"), tok("line"));
    for (let i = 0; i < 4; i++) S.rect(129, 49 + i * 3, 18, 1, withAlpha(tok("line"), 0.4));
    S.rect(120, 66, 38, 8, tok("line"));
    for (let i = 0; i < 12; i++) { const lit = this.key === i; S.rect(121 + i * 3, 67, 2, lit ? 5 : 6, lit ? tok("brass") : tok("w")); }
    for (let i = 0; i < 12; i++) { const pc = i % 7; if (pc === 2 || pc === 6) continue; S.rect(123 + i * 3, 67, 1, 3, tok("line")); }
    S.rect(119, 60, 40, 1, withAlpha(tok("w"), 0.25));
    // ---- shelf with the radio (left of the window)
    S.oRrect(18, 66, 38, 3, 1, tok("wood2"), tok("line"));
    this.drawRadio(S, 24, 52, playing, tok);
    // notes drifting up from the radio while music plays
    if (playing && Math.random() < this.frameDt * 1.2) this.notes.push({ x: 38 + Math.random() * 8, y: 50, life: 0, max: 2.2 + Math.random(), drift: Math.random() * 2 - 1 });
    for (const n of this.notes) {
      const u = n.life / n.max, al = u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85;
      const nx = Math.round(n.x + Math.sin(n.life * 2.5) * 2 + n.drift * n.life * 2), ny = Math.round(n.y - n.life * 9);
      const col = withAlpha(tok(Math.round(n.x) % 2 ? "pink" : "brass"), 0.9 * al);
      S.rect(nx + 2, ny - 4, 1, 5, col); S.ellipse(nx + 1, ny, 1.5, 1.2, col); S.rect(nx + 3, ny - 4, 2, 1, col);
    }
    // ---- big potted plant at the left edge, cat mug on the floor
    this.drawPlant(S, 2, 60, this.swayPos, tok);
    this.drawPlant(S, 100, 50, -this.swayPos * 0.6, tok); // small one on the sill
    this.drawCatMug(S, 26, 72, this.cupWobble, tok);
    // ---- cushion and the calico cat lying on it, in front of the window
    S.oRrect(60, 76, 52, 10, 4, tok("pink"), tok("line"));
    S.rrect(64, 78, 44, 4, 2, withAlpha(tok("w"), 0.25));
    this.drawLyingCat(S, 86, 70, tok);
  }

  private frameDt = 1 / 60;
  private notes: { x: number; y: number; life: number; max: number; drift: number }[] = [];

  /**
   * Painted corner: the base art (public/cozy/corner.png — cut from the user's mock-up, keyed,
   * flipped for the right corner; replace the file to re-skin) is drawn to the scene grid and
   * only the moving parts are drawn over it, in scene coordinates calibrated to that picture:
   * lamp glow, radio bars, notes, mug steam, rain on the window, the piano key, and the cat's
   * eyes closing when asleep. Everything else is the painting itself.
   */
  private drawArt(ctx: CanvasRenderingContext2D, S: ReturnType<CozyModule["shapes"]>, s: number, ox: number, oy: number, tok: Tok) {
    const playing = this.level > this.sleepDb && this.awake > 0.3;
    ctx.save();
    ctx.imageSmoothingEnabled = true; // a painting at a free scale: bilinear, not nearest
    const aw = Math.max(0, Math.min(1, this.awake));
    if (this.sleepOk && this.sleepArt && aw < 0.999) {
      // asleep ↔ awake: the sleeping pose underneath, the awake picture fading in as the cat
      // wakes (sound starts) and out as it dozes off (quiet for 2 s)
      ctx.drawImage(this.sleepArt, ox, oy, MINI_W * s, MINI_H * s);
    }
    // awake: the base picture, or one of the play poses (corner_play1–2.png) cross-fading in/out
    const from = this.poseImg(this.poseFrom), to = this.poseImg(this.poseTo);
    const pf = this.poseFade;
    ctx.globalAlpha = aw;
    ctx.drawImage(from, ox, oy, MINI_W * s, MINI_H * s);
    if (to !== from && pf > 0) {
      ctx.globalAlpha = aw * pf;
      ctx.drawImage(to, ox, oy, MINI_W * s, MINI_H * s);
    }
    ctx.restore();
    // calibration (scene units, 160×96 over the 800×480 picture = ×0.2; 2026-11-18 새 배경)
    const lamp = { x: 140.7, y: 29.9 }, radio = { x: 56.8, y: 62.2, w: 15, h: 7 }, mug = { x: 49.3, y: 72.5 }, win = { x: 81.8, y: 19.4, w: 44.1, h: 56.3 }, keys = { x: 129, y: 72.5, w: 29 };
    // ---- the sky outside and the light it lets in (2026-11-17: beams felt stencilled — replaced)
    let lightSum = 0;
    for (let i = 0; i < 5; i++) lightSum += this.light[i];
    const glow = Math.min(1, lightSum / 3);
    if (this.skyOk && this.skyMask) {
      // 1) sky colour: a slow time-of-day drift (sunset → violet dusk → night → golden hour, ~2 min a
      //    turn), nudged warm by bright sounds and cool by dark ones; applied with "color" through
      //    the sky mask so the city silhouettes and clouds keep their shading
      const cyc = [tok("dusk1"), tok("pink"), tok("dusk2"), tok("dusk3"), tok("brass")];
      const ph = ((this.t / 24 + this.skyBias) % cyc.length + cyc.length) % cyc.length;
      const k = Math.floor(ph), fr = ph - k;
      const sky = mix(cyc[k], cyc[(k + 1) % cyc.length], fr * fr * (3 - 2 * fr));
      this.tintSky(ctx, sky, "color", 0.5, ox, oy, s);
      // 2) the glass brightens softly where the music swells
      if (glow > 0.01) this.tintSky(ctx, tok("dusk1"), "lighter", 0.14 * glow, ox, oy, s);
    }
    // 3) a soft pool of window light on the floor and the cat, breathing with the bands — no hard
    //    edges; painted only over the picture ("source-atop"), never onto the desktop
    if (glow > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = "source-atop";
      const px = ox + (win.x + win.w * 0.35) * s, py = oy + (win.y + win.h + 4) * s;
      const gr = ctx.createRadialGradient(px, py, 2 * s, px, py, 46 * s);
      gr.addColorStop(0, withAlpha(tok("brass"), 0.18 * glow)); gr.addColorStop(0.55, withAlpha(tok("pink"), 0.07 * glow)); gr.addColorStop(1, withAlpha(tok("pink"), 0));
      ctx.fillStyle = gr;
      ctx.fillRect(ox + (win.x - 50) * s, oy + (win.y + 20) * s, (win.w + 70) * s, (win.h + 10) * s);
      ctx.restore();
    }
    // ---- the big plant on the left sways gently while sound plays (calm, no strength), around the pot rim
    if (this.plantOk && this.plantArt) {
      const pv = { x: 27.2, y: 69.3 };   // the big plant's pot rim
      // three incommensurate slow waves → never repeats, never jerks; ±~4.5° at the leaf tips
      const ang = this.plantSway * (0.55 * Math.sin(this.t * 0.75 + this.swayPh[0]) + 0.3 * Math.sin(this.t * 1.31 + this.swayPh[1]) + 0.15 * Math.sin(this.t * 2.17)) * (Math.PI / 180) * 4.5;
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.translate(ox + pv.x * s, oy + pv.y * s);
      ctx.rotate(ang);
      ctx.drawImage(this.plantArt, -pv.x * s, -pv.y * s, MINI_W * s, MINI_H * s);
      ctx.restore();
    }
    // lamp: the new picture (2026-11-18) paints the lamp unlit (grey bulb), so silence needs nothing —
    // with music the bulb itself lights up (warm-white core), then the wide glow around it
    const a = this.lamp * (this.flicker > 0 && Math.sin(this.t * 60) > 0 ? 0.4 : 1);
    if (a > 0.01) {
      const bx = ox + lamp.x * s, by = oy + lamp.y * s;
      const bg = ctx.createRadialGradient(bx, by, 0, bx, by, 6 * s);
      bg.addColorStop(0, `rgba(255,246,224,${0.95 * a})`); bg.addColorStop(0.45, withAlpha(tok("brass"), 0.7 * a)); bg.addColorStop(1, withAlpha(tok("brass"), 0));
      ctx.fillStyle = bg; ctx.fillRect(bx - 6 * s, by - 6 * s, 12 * s, 12 * s);
    }
    // lamp glow
    // (2026-11-17 사용자: 조금 더 강하게 — 중심 0.35 → 0.5, 반경 40 → 46, 중간 단계로 넓게 퍼짐)
    const g = ctx.createRadialGradient(ox + lamp.x * s, oy + lamp.y * s, s, ox + lamp.x * s, oy + lamp.y * s, 46 * s);
    g.addColorStop(0, withAlpha(tok("brass"), 0.5 * a)); g.addColorStop(0.4, withAlpha(tok("brass"), 0.2 * a)); g.addColorStop(1, withAlpha(tok("brass"), 0));
    ctx.fillStyle = g; ctx.fillRect(ox + (lamp.x - 46) * s, oy + (lamp.y - 24) * s, 92 * s, 78 * s);
    // rain on the window
    if (this.rain > 0.05) for (const r of this.drops) S.rect(win.x + 2 + Math.floor(r.x * (win.w - 4)), win.y + Math.floor(r.y * win.h / 44), 1, 3, withAlpha(tok("w"), 0.45 * this.rain));
    // radio: no drawn bars over the painting (2026-11-17 사용자: 라디오에 걸친 이펙트가 어색) — the
    // painting's own amber display glows: five soft vertical light columns, one per band, added
    // ("lighter") inside the display only, so the painted equaliser itself seems to light up
    {
      const disp = { x: 55.3, y: 71.2, w: 24, h: 7.3 };
      ctx.save();
      ctx.beginPath(); ctx.rect(ox + disp.x * s, oy + disp.y * s, disp.w * s, disp.h * s); ctx.clip();
      ctx.globalCompositeOperation = "lighter";
      const cw = disp.w / 5;
      for (let i = 0; i < 5; i++) {
        const v = playing ? this.bands[i] : 0;
        if (v < 0.03) continue;
        const cx = ox + (disp.x + cw * (i + 0.5)) * s, cy = oy + (disp.y + disp.h * (1 - 0.55 * v)) * s;
        const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, cw * 1.3 * s);
        gr.addColorStop(0, withAlpha(tok("brass"), 0.45 * v)); gr.addColorStop(1, withAlpha(tok("brass"), 0));
        ctx.fillStyle = gr;
        ctx.fillRect(ox + disp.x * s, oy + disp.y * s, disp.w * s, disp.h * s);
      }
      ctx.restore();
    }
    // notes: soft glowing ♪ / ♫ glyphs (not pixel rects) drifting up from the radio while music plays
    if (playing && Math.random() < this.frameDt * 0.8) this.notes.push({ x: radio.x + 2 + Math.random() * 10, y: radio.y - 6, life: 0, max: 2.4 + Math.random(), drift: Math.random() * 2 - 1 });
    if (this.notes.length) {
      ctx.save();
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = `${Math.max(9, Math.round(5 * s))}px "Segoe UI Symbol", "Segoe UI", sans-serif`;
      ctx.shadowBlur = 3 * s;
      for (const n of this.notes) {
        const u = n.life / n.max, al = u < 0.2 ? u / 0.2 : 1 - (u - 0.2) / 0.8;
        const nx = n.x + Math.sin(n.life * 2.2 + n.drift * 3) * 1.6 + n.drift * n.life * 2.2, ny = n.y - n.life * 8;
        const col = tok(n.drift > 0 ? "brass" : "pink");
        ctx.shadowColor = withAlpha(col, 0.6 * al);
        ctx.fillStyle = withAlpha(mix(col, tok("w"), 0.35), 0.85 * al);
        ctx.fillText(n.drift > 0.4 ? "♫" : "♪", ox + nx * s, oy + ny * s);
      }
      ctx.restore();
    }
    // steam from the mug
    for (const st of this.steam) {
      const al = (1 - st.life / st.max) * 0.45;
      S.rect(mug.x + Math.round(st.x + Math.sin(st.life * 3) * 1.5), mug.y + Math.round(st.y), 2, 1, withAlpha(tok("w"), al));
    }
    // piano: while music plays, little notes pop out of random keys and float up (2026-11-17 사용자:
    // 랜덤 위치에서 음표) — a transient adds one at once, otherwise ~1 per second
    if (playing && (this.bob > 0.95 || Math.random() < this.frameDt * 0.9)) {
      this.notes.push({ x: keys.x + Math.random() * (keys.w - 4), y: keys.y - 2, life: 0, max: 1.8 + Math.random() * 0.8, drift: Math.random() * 2 - 1 });
    }
    // sleeping: soft "z"s rising from the lowered head (scene ≈ 94, 70). They were 2×1 dark dashes over
    // the window, which read as stray marks above the plant (2026-11-17 사용자: 식물 위쪽 이상한 자국)
    if (this.awake < 0.3) {
      const ph = this.zz % 2.4;
      ctx.save();
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (let i = 0; i < 3; i++) {
        const t = ph - i * 0.6;
        if (t < 0 || t > 1.8) continue;
        const al = Math.min(1, t / 0.3) * (1 - t / 1.8);
        ctx.font = `${Math.max(8, Math.round((2.6 + i * 0.7) * s))}px "Segoe UI", sans-serif`;
        ctx.fillStyle = withAlpha(mix(tok("w"), tok("dusk2"), 0.25), 0.8 * al);
        ctx.fillText("z", ox + (94.3 - i * 2.5 - t * 1.5) * s, oy + (67.8 - i * 2.5 - t * 4) * s);
      }
      ctx.restore();
    }
  }

  /** Calico cat lying on its side, head to the left, tail curling right. */
  private drawLyingCat(S: ReturnType<CozyModule["shapes"]>, cx: number, cy: number, tok: Tok) {
    const asleep = this.awake < 0.3, alert = this.earFlick > 0 && !asleep;
    const bob = Math.round(Math.sin(this.bob * Math.PI) * 1.5);
    // tail (behind), swishing
    const ang = Math.sin(this.t * 1.6 + this.bob * 5) * (asleep ? 0.6 : 2.5);
    for (let i = 0; i < 10; i++) S.rect(cx + 18 + i * 2, cy + 6 - Math.round(Math.sin(i / 9 * Math.PI) * 5 + ang * i / 9), 2, 2, i % 3 === 0 ? tok("rust") : tok("cat2"));
    // body
    S.oEllipse(cx + 4, cy + 6, 20, 8, tok("cat2"), tok("line"));
    S.ellipse(cx + 8, cy + 2, 7, 4, tok("rust")); S.ellipse(cx + 18, cy + 7, 5, 3, withAlpha(tok("line"), 0.8)); S.ellipse(cx - 4, cy + 8, 4, 2.5, tok("rust")); // calico patches
    S.oEllipse(cx + 12, cy + 12, 4, 2, tok("cat2"), tok("line")); S.oEllipse(cx + 2, cy + 13, 4, 2, tok("cat2"), tok("line")); // paws
    // head
    const hx = cx - 14, hy = cy + 2 - bob;
    const earY = hy - 7 + (alert ? 3 : 0);
    S.oEllipse(hx - 6, earY, 3, alert ? 2.5 : 4, tok("cat2"), tok("line")); S.oEllipse(hx + 6, earY, 3, alert ? 2.5 : 4, tok("rust"), tok("line"));
    S.oCircle(hx, hy, 9, tok("cat2"), tok("line"));
    S.ellipse(hx + 5, hy - 4, 5, 4, tok("rust")); // patch over one eye
    if (asleep || this.blink > 0) { S.rect(hx - 5, hy, 3, 1, tok("line")); S.rect(hx + 2, hy, 3, 1, tok("line")); }
    else { S.circle(hx - 3.5, hy, alert ? 2 : 1.5, tok("line")); S.circle(hx + 3.5, hy, alert ? 2 : 1.5, tok("line")); }
    S.ellipse(hx, hy + 3, 1.5, 1, tok("pink"));
    S.rect(hx - 2, hy + 4, 2, 1, tok("line")); S.rect(hx + 1, hy + 4, 2, 1, tok("line"));
    if (asleep) {
      const ph = this.zz % 2.4;
      for (let i = 0; i < 3; i++) { const t = ph - i * 0.6; if (t < 0 || t > 1.8) continue; S.rect(hx + 11 + i * 3, hy - 10 - Math.round(t * 4), 2, 1, withAlpha(tok("line"), 0.8 * (1 - t / 1.8))); }
    }
  }

  /** Mug with a cat face on it. */
  private drawCatMug(S: ReturnType<CozyModule["shapes"]>, x: number, y: number, wobble: number, tok: Tok) {
    const dx = Math.round(Math.sin(this.t * 40) * wobble * 1.5);
    S.oRrect(x + dx, y + 2, 12, 11, 2, tok("w"), tok("line"));
    S.oRrect(x + dx + 11, y + 4, 4, 6, 2, tok("w"), tok("line")); S.rect(x + dx + 12, y + 5, 2, 4, tok("cream"));
    S.rect(x + dx + 2, y + 4, 8, 1, tok("wood2"));
    S.rect(x + dx + 3, y + 7, 1, 1, tok("line")); S.rect(x + dx + 7, y + 7, 1, 1, tok("line")); S.rect(x + dx + 4, y + 9, 1, 1, tok("line")); S.rect(x + dx + 6, y + 9, 1, 1, tok("line")); S.rect(x + dx + 5, y + 8, 1, 1, tok("pink")); // face
    for (const st of this.steam) {
      const a = (1 - st.life / st.max) * 0.5;
      S.rect(x + 6 + Math.round(st.x + Math.sin(st.life * 3) * 1.5), y - 1 + Math.round(st.y), 2, 1, withAlpha(tok("line"), a * 0.5));
    }
  }

  private drawPlant(S: ReturnType<CozyModule["shapes"]>, x: number, y: number, sway: number, tok: Tok) {
    const dx = Math.round(sway * 3);
    S.oRrect(x, y + 8, 12, 9, 2, tok("rust"), tok("line"));
    S.rect(x + 5, y, 2, 9, tok("line"));
    S.oEllipse(x + 2 + dx, y + 3, 5, 3, tok("sage"), tok("line"));
    S.oEllipse(x + 10 + dx, y + 1, 5, 3, tok("sage"), tok("line"));
    S.oEllipse(x + 6 + Math.round(dx * 1.4), y - 4, 4, 3, tok("sage"), tok("line"));
  }

  private drawRadio(S: ReturnType<CozyModule["shapes"]>, x: number, y: number, on: boolean, tok: Tok) {
    S.oRrect(x, y, 26, 13, 3, tok("cream2"), tok("line"));
    S.rrect(x + 3, y + 3, 11, 7, 1, tok("line"));
    for (let i = 0; i < 5; i++) {
      const hgt = on ? Math.max(1, Math.round(this.bands[i] * 6)) : 1;
      S.rect(x + 4 + i * 2, y + 9 - hgt, 1, hgt, on ? tok("sage") : tok("cream2"));
    }
    S.oCircle(x + 19, y + 6, 3, on ? tok("brass") : tok("cream2"), tok("line"));
    S.rect(x + 22, y - 5, 1, 5, tok("line"));
    if (on) S.rect(x + 17, y + 11, 2, 1, tok("rust"));
  }

  private drawLamp(ctx: CanvasRenderingContext2D, S: ReturnType<CozyModule["shapes"]>, x: number, y: number, s: number, ox: number, oy: number, tok: Tok) {
    const a = this.lamp * (this.flicker > 0 && Math.sin(this.t * 60) > 0 ? 0.4 : 1);
    // warm glow (radial), then the banker's lamp: brass stem + base, sage shade
    const g = ctx.createRadialGradient(ox + (x + 10) * s, oy + (y + 8) * s, s, ox + (x + 10) * s, oy + (y + 8) * s, 40 * s);
    g.addColorStop(0, withAlpha(tok("brass"), 0.45 * a)); g.addColorStop(1, withAlpha(tok("brass"), 0));
    ctx.fillStyle = g; ctx.fillRect(ox + (x - 30) * s, oy + (y - 32) * s, 80 * s, 70 * s);
    S.rect(x + 9, y + 10, 2, 20, tok("line")); S.rect(x + 8, y + 10, 4, 20, tok("brass"));
    S.oEllipse(x + 10, y + 30, 9, 3, tok("brass"), tok("line"));
    S.oRrect(x - 2, y + 2, 24, 9, 4, tok("sage"), tok("line"));
    S.rect(x + 1, y + 11, 18, 1, withAlpha(tok("y"), 0.9 * a));
  }

  private drawMug(S: ReturnType<CozyModule["shapes"]>, x: number, y: number, wobble: number, tok: Tok) {
    const dx = Math.round(Math.sin(this.t * 40) * wobble * 1.5);
    S.oRrect(x + dx, y + 2, 12, 11, 2, tok("w"), tok("line"));
    S.oRrect(x + dx + 11, y + 4, 4, 6, 2, tok("w"), tok("line")); S.rect(x + dx + 12, y + 5, 2, 4, tok("cream"));
    S.rect(x + dx + 2, y + 4, 8, 1, tok("wood2"));
    S.rect(x + dx + 3, y + 7, 6, 2, tok("sage")); // a leaf mark
    for (const st of this.steam) {
      const a = (1 - st.life / st.max) * 0.55;
      S.rect(x + 6 + Math.round(st.x + Math.sin(st.life * 3) * 1.5), y - 1 + Math.round(st.y), 2, 1, withAlpha(tok("line"), a * 0.5));
    }
  }

  private drawPiano(S: ReturnType<CozyModule["shapes"]>, x: number, y: number, tok: Tok) {
    S.oRrect(x, y, 44, 28, 2, tok("wood2"), tok("line"));
    S.rrect(x + 3, y + 3, 38, 8, 1, withAlpha(tok("line"), 0.35));
    S.rect(x + 2, y + 17, 40, 8, tok("line"));
    const keyW = 3;
    for (let i = 0; i < 12; i++) {
      const lit = this.key === i;
      S.rect(x + 3 + i * keyW + Math.floor(i / 7) * 2, y + 18, keyW - 1, lit ? 5 : 6, lit ? tok("brass") : tok("w"));
    }
    for (let i = 0; i < 12; i++) { const pc = i % 7; if (pc === 2 || pc === 6) continue; S.rect(x + 5 + i * keyW + Math.floor(i / 7) * 2, y + 18, 1, 3, tok("line")); }
    S.rect(x + 12, y + 5, 20, 1, withAlpha(tok("w"), 0.5));
  }

  /** Round white cat: head, ears, eyes (blink / closed when asleep / wide when startled), nose, body. */
  private drawCat(S: ReturnType<CozyModule["shapes"]>, cx: number, cy: number, k: number, tok: Tok, full = false) {
    const asleep = this.awake < 0.3, alert = this.earFlick > 0 && !asleep;
    const bob = Math.round(Math.sin(this.bob * Math.PI) * 2 * k);
    const hy = cy + (asleep ? 3 : 0) - bob;
    const r = 15 * k;
    // body
    if (full) S.oEllipse(cx, cy + 16 * k, 16 * k, 10 * k, tok("cat"), tok("line"));
    else S.oEllipse(cx, cy + 22 * k, 19 * k, 14 * k, tok("cat"), tok("line"));
    // ears (flattened when startled)
    const earY = hy - r + (alert ? 6 : 0) * k;
    S.oEllipse(cx - 10 * k, earY, 5 * k, (alert ? 4 : 7) * k, tok("cat"), tok("line"));
    S.oEllipse(cx + 10 * k, earY, 5 * k, (alert ? 4 : 7) * k, tok("cat"), tok("line"));
    S.ellipse(cx - 10 * k, earY + 1, 2.5 * k, (alert ? 2 : 4) * k, tok("pink"));
    S.ellipse(cx + 10 * k, earY + 1, 2.5 * k, (alert ? 2 : 4) * k, tok("pink"));
    // head
    S.oCircle(cx, hy, r, tok("cat"), tok("line"));
    S.ellipse(cx, hy + 2 * k, r - 2, r * 0.6, withAlpha(tok("cat2"), 0.5)); // cheek shade
    // eyes
    const ey = hy - 1 * k;
    if (asleep || this.blink > 0) {
      S.rect(cx - 8 * k, ey, 5 * k, 1, tok("line")); S.rect(cx + 4 * k, ey, 5 * k, 1, tok("line"));
    } else {
      const er = (alert ? 3 : 2) * k;
      S.circle(cx - 6 * k, ey, er, tok("line")); S.circle(cx + 6 * k, ey, er, tok("line"));
      S.rect(cx - 6 * k - 1, ey - er + 1, 1, 1, tok("w")); S.rect(cx + 6 * k - 1, ey - er + 1, 1, 1, tok("w"));
    }
    // nose + mouth + cheeks
    S.ellipse(cx, hy + 3 * k, 2 * k, 1.5 * k, tok("pink"));
    S.rect(cx - 2 * k, hy + 5 * k, 2 * k, 1, tok("line")); S.rect(cx + 1 * k, hy + 5 * k, 2 * k, 1, tok("line"));
    S.ellipse(cx - 10 * k, hy + 4 * k, 3 * k, 1.5 * k, withAlpha(tok("pink"), 0.55)); S.ellipse(cx + 10 * k, hy + 4 * k, 3 * k, 1.5 * k, withAlpha(tok("pink"), 0.55));
    if (asleep) {
      const ph = this.zz % 2.4;
      for (let i = 0; i < 3; i++) {
        const t = ph - i * 0.6;
        if (t < 0 || t > 1.8) continue;
        S.rect(cx + r + 2 * k + i * 3, hy - r + 4 - Math.round(t * 4), 2, 1, withAlpha(tok("line"), 0.8 * (1 - t / 1.8)));
      }
    }
    if (full) { // paws for the free-standing mini cat
      S.oEllipse(cx - 8 * k, cy + 25 * k, 5 * k, 2.5 * k, tok("cat"), tok("line")); S.oEllipse(cx + 8 * k, cy + 25 * k, 5 * k, 2.5 * k, tok("cat"), tok("line"));
      // tail curling out to the right, swishing with the beat
      const ang = Math.sin(this.t * 2 + this.bob * 6) * 3;
      for (let i = 0; i < 8; i++) S.rect(cx + 16 * k + i * 2, cy + 20 * k - Math.round(Math.sin(i / 7 * Math.PI) * 4 + ang * i / 7), 2, 2, i % 3 === 0 ? tok("line") : tok("cat"));
    }
  }
}
