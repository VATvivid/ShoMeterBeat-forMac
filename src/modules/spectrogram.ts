import { freqToIndex, N_SPEC, type Frame } from "../engine/frame";
import { colorMap, font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

const DB_TOP = 0;

/** Colour themes: 4–6 stops from silence to loud (hex). "theme" follows the app's --map-* tokens. */
const PALETTES: Record<string, { label: string; stops: string[] | null }> = {
  theme: { label: "기본 (앱 테마)", stops: null },
  fire: { label: "불꽃 (검정→빨강→노랑→흰색)", stops: ["#0a0a0a", "#4a0a12", "#b8222a", "#ff8a1f", "#ffe36b", "#ffffff"] },
  viridis: { label: "비리디스 (보라→초록→노랑)", stops: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"] },
  ice: { label: "아이스 (검정→파랑→하늘→흰색)", stops: ["#05070d", "#102a6b", "#1e6fd9", "#5fd0ff", "#ffffff"] },
  mono: { label: "흑백 (대비 높음)", stops: ["#000000", "#3a3a3a", "#8c8c8c", "#d8d8d8", "#ffffff"] },
  magma: { label: "마그마 (자홍→주황)", stops: ["#000004", "#3b0f70", "#8c2981", "#de4968", "#fe9f6d", "#fcfdbf"] },
};
function buildMap(stops: string[]): Uint8ClampedArray {
  const rgb = stops.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * (rgb.length - 1);
    const k = Math.min(rgb.length - 2, Math.floor(p));
    const t = p - k;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = rgb[k][c] + (rgb[k + 1][c] - rgb[k][c]) * t;
  }
  return out;
}
const PAD_L = 34;
const FREQ_TICKS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const ROWS_3D = 72;
const STEP_3D = 2; // draw every 2nd bin in 3D (128 points per row)

/** Spectrogram. 2D: scrolling image (time left→right, log frequency bottom→top).
 *  3D: perspective waterfall — newest row in front, older rows recede upward. */
export class SpectrogramModule implements Module {
  readonly id = "spectrogram";
  readonly title = "Spectrogram";
  private buf = document.createElement("canvas");
  private bctx = this.buf.getContext("2d")!;
  private col = new ImageData(1, N_SPEC);
  private map = colorMap();
  private lastSeq = -1;
  private hist: Float32Array[] = []; // 3D history, newest last, values 0..1
  private speedAcc = 0;

  constructor() {
    this.buf.width = 1;
    this.buf.height = N_SPEC;
  }

  private get view() { return modSetting(this.id, "view", "2d"); }
  private get speed() { return modSetting(this.id, "speed", 1); }
  private get palette() { return modSetting(this.id, "palette", "theme"); }
  /** Lowest level that still gets a colour (dB). Raising it hides the noise floor and spreads the colours over what remains. */
  private get floor() { return modSetting(this.id, "floor", -96); }
  /** Gamma on the 0…1 level: < 1 brightens quiet detail, > 1 keeps only the loud parts bright. */
  private get gamma() { return modSetting(this.id, "gamma", 1); }
  private mapKey = "";
  private ensureMap() {
    const key = this.palette;
    if (key === this.mapKey) return;
    const p = PALETTES[key] ?? PALETTES.theme;
    this.map = p.stops ? buildMap(p.stops) : colorMap();
    this.mapKey = key;
  }

  settings(): SettingItem[] {
    return [
      { type: "select", label: "보기", value: this.view, options: [{ value: "2d", label: "2D (스크롤)" }, { value: "3d", label: "3D (워터폴)" }], onChange: (v) => setModSetting(this.id, "view", v) },
      { type: "select", label: "색상 테마", value: this.palette, options: Object.entries(PALETTES).map(([k, p]) => ({ value: k, label: p.label })), onChange: (v) => setModSetting(this.id, "palette", v) },
      { type: "range", label: "감도 (바닥 dB)", value: this.floor, min: -120, max: -30, step: 3, format: (v) => `${v} dB`, onChange: (v) => setModSetting(this.id, "floor", v) },
      { type: "range", label: "대비 (감마)", value: this.gamma, min: 0.4, max: 2.5, step: 0.1, format: (v) => `γ ${v.toFixed(1)}`, onChange: (v) => setModSetting(this.id, "gamma", v) },
      { type: "select", label: "속도", value: String(this.speed), options: [{ value: "0.5", label: "느리게" }, { value: "1", label: "보통" }, { value: "2", label: "빠르게" }], onChange: (v) => setModSetting(this.id, "speed", Number(v)) },
    ];
  }

  resize(w: number) {
    const pw = Math.max(1, Math.floor(w - PAD_L));
    if (pw !== this.buf.width) {
      const old = this.buf;
      const nb = document.createElement("canvas");
      nb.width = pw; nb.height = N_SPEC;
      const c = nb.getContext("2d")!;
      c.fillStyle = theme("map-0");
      c.fillRect(0, 0, pw, N_SPEC);
      c.drawImage(old, pw - old.width, 0);
      this.buf = nb;
      this.bctx = c;
    }
  }

  private norm(v: number) { const lo = this.floor; const t = Math.min(1, Math.max(0, (v - lo) / (DB_TOP - lo))); const g = this.gamma; return g === 1 ? t : Math.pow(t, g); }

  draw(d: DrawCtx, f: Frame) {
    this.ensureMap();
    // Advance at `speed` rows per frame (fractional speeds skip frames).
    let advance = false;
    if (f.seq !== this.lastSeq) {
      this.lastSeq = f.seq;
      this.speedAcc += this.speed;
      if (this.speedAcc >= 1) { this.speedAcc -= 1; advance = true; }
    }
    if (this.view === "3d") this.draw3d(d, f, advance); else this.draw2d(d, f, advance);
  }

  private draw2d(d: DrawCtx, f: Frame, advance: boolean) {
    const { ctx, w, h } = d;
    this.resize(w);
    const pw = this.buf.width;
    if (advance) {
      this.bctx.drawImage(this.buf, 1, 0, pw - 1, N_SPEC, 0, 0, pw - 1, N_SPEC);
      const px = this.col.data;
      for (let i = 0; i < N_SPEC; i++) {
        const k = Math.round(this.norm(Math.max(f.specL[i], f.specR[i])) * 255) * 3;
        const row = N_SPEC - 1 - i;
        px[row * 4] = this.map[k]; px[row * 4 + 1] = this.map[k + 1]; px[row * 4 + 2] = this.map[k + 2]; px[row * 4 + 3] = 255;
      }
      this.bctx.putImageData(this.col, pw - 1, 0);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.buf, PAD_L, 0, pw, h);
    ctx.fillStyle = theme("fg-1");
    ctx.font = font(10);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = theme("line");
    for (const hz of FREQ_TICKS) {
      const y = h - (freqToIndex(hz) / (N_SPEC - 1)) * h;
      if (y < 7 || y > h - 7) continue;
      ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, PAD_L - 5, y);
      ctx.beginPath(); ctx.moveTo(PAD_L - 2, Math.round(y) + 0.5); ctx.lineTo(PAD_L, Math.round(y) + 0.5); ctx.stroke();
    }
  }

  private draw3d(d: DrawCtx, f: Frame, advance: boolean) {
    const { ctx, w, h } = d;
    if (advance) {
      const row = new Float32Array(N_SPEC);
      for (let i = 0; i < N_SPEC; i++) row[i] = this.norm(Math.max(f.specL[i], f.specR[i]));
      this.hist.push(row);
      if (this.hist.length > ROWS_3D) this.hist.shift();
    }
    const padB = 20, padT = 10;
    const frontY = h - padB;
    const depthH = (h - padB - padT) * 0.62;      // how far the back row recedes
    const ampH = (h - padB - padT) * 0.42;        // amplitude height of the front row
    const cx = w / 2;
    const frontHalf = (w - 12) / 2;
    const backScale = 0.72;                        // width of the back row relative to the front

    const n = this.hist.length;
    const bg = theme("bg-1");
    // Back → front so nearer rows occlude.
    for (let k = 0; k < n; k++) {
      const row = this.hist[k];
      const age = n > 1 ? (n - 1 - k) / (ROWS_3D - 1) : 0; // 0 front … 1 back
      const t = age;
      const baseY = frontY - t * depthH;
      const half = frontHalf * (1 - t * (1 - backScale));
      const amp = ampH * (1 - t * 0.55);
      let peak = 0;
      ctx.beginPath();
      ctx.moveTo(cx - half, baseY);
      for (let i = 0; i < N_SPEC; i += STEP_3D) {
        const v = row[i];
        if (v > peak) peak = v;
        const x = cx - half + (i / (N_SPEC - 1)) * half * 2;
        ctx.lineTo(x, baseY - v * amp);
      }
      ctx.lineTo(cx + half, baseY);
      ctx.closePath();
      ctx.fillStyle = bg;
      ctx.fill();
      const kc = Math.round(peak * 255) * 3;
      const color = `rgb(${this.map[kc]},${this.map[kc + 1]},${this.map[kc + 2]})`;
      ctx.strokeStyle = withAlpha(rgbToHex(this.map[kc], this.map[kc + 1], this.map[kc + 2]), 0.25 + 0.75 * (1 - t));
      ctx.lineWidth = t < 0.05 ? 1.5 : 1;
      ctx.stroke();
      void color;
    }
    // Front baseline labels
    ctx.fillStyle = theme("fg-1");
    ctx.font = font(10);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = cx - frontHalf + (freqToIndex(hz) / (N_SPEC - 1)) * frontHalf * 2;
      ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, x, frontY + 5);
    }
    ctx.fillStyle = theme("fg-2");
    ctx.textAlign = "left";
    ctx.fillText("3D · 과거 ↑", 6, 4);
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
