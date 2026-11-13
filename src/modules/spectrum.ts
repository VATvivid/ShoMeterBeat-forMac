import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { freqToIndex, N_SPEC, pointFreq, SILENCE_DB, type Frame } from "../engine/frame";
import { getSource } from "../engine/instance";
import { inTauri } from "../engine/source";
import { font, theme, withAlpha } from "../theme";
import { ballistic, type DrawCtx, type Module, type SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

const DB_TOP = 0;
const PAD_L = 34, PAD_B = 22, PAD_T = 8, PAD_R = 8;
const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

/** Saved reference spectra (average dB per log point), keyed by preset name. */
type RefPresets = Record<string, number[]>;

/** Colour presets: line + fill (vertical or along frequency) + peak hold, all from theme tokens. */
interface ColorPreset { label: string; line: string; hold: string; fill: { dir: "v" | "h"; stops: [number, string, number][] }; glow?: boolean }
const COLOR_PRESETS: Record<string, ColorPreset> = {
  default: { label: "기본 (틸)", line: "sig", hold: "peak", fill: { dir: "v", stops: [[0, "sig", 0.45], [1, "sig", 0]] } },
  fire: { label: "불꽃", line: "target", hold: "fg-0", fill: { dir: "v", stops: [[0, "target", 0.8], [0.45, "peak", 0.6], [1, "clip", 0.1]] } },
  aurora: { label: "오로라", line: "sig", hold: "fg-0", fill: { dir: "h", stops: [[0, "sig", 0.55], [0.5, "sig-2", 0.5], [1, "map-1", 0.6]] } },
  rainbow: { label: "무지개", line: "fg-0", hold: "fg-1", fill: { dir: "h", stops: [[0, "clip", 0.6], [0.2, "peak", 0.6], [0.4, "target", 0.6], [0.6, "sig", 0.6], [0.8, "sig-2", 0.6], [1, "map-1", 0.7]] } },
  ice: { label: "아이스", line: "fg-0", hold: "sig-2", fill: { dir: "v", stops: [[0, "fg-0", 0.55], [0.5, "sig-2", 0.4], [1, "sig-2", 0]] } },
  neon: { label: "네온", line: "clip", hold: "target", fill: { dir: "v", stops: [[0, "clip", 0.35], [1, "map-1", 0.05]] }, glow: true },
};

export class SpectrumModule implements Module {
  readonly id = "spectrum";
  readonly title = "Spectrum";
  private smooth = new Float32Array(N_SPEC).fill(SILENCE_DB);
  private smooth2 = new Float32Array(N_SPEC).fill(SILENCE_DB); // second curve (R in LR, Side in MS)
  private hold = new Float32Array(N_SPEC).fill(SILENCE_DB);
  private holdAge = new Float32Array(N_SPEC);
  private note = "";
  private noteUntil = 0;
  private busy = false;

  private get slope() { return modSetting(this.id, "slope", 4.5); }
  private get range() { return modSetting(this.id, "range", 96); }
  private get showHold() { return modSetting(this.id, "hold", true); }
  private get presets(): RefPresets { return modSetting<RefPresets>(this.id, "refs", {}); }
  private get refName(): string { return modSetting(this.id, "ref", ""); }
  private get autoLevel() { return modSetting(this.id, "refAuto", true); }
  private get chan() { return modSetting(this.id, "chan", "max") as "max" | "lr" | "ms"; }
  private get colors(): ColorPreset { return COLOR_PRESETS[modSetting(this.id, "colors", "default")] ?? COLOR_PRESETS.default; }

  settings(): SettingItem[] {
    const names = Object.keys(this.presets);
    return [
      { type: "select", label: "채널", value: this.chan, options: [{ value: "max", label: "L/R 최대 (한 곡선)" }, { value: "lr", label: "LR 모드 (L · R 두 곡선)" }, { value: "ms", label: "MS 모드 (Mid · Side)" }], onChange: (v) => setModSetting(this.id, "chan", v) },
      { type: "select", label: "기울기", value: String(this.slope), options: [0, 3, 4.5, 6].map((v) => ({ value: String(v), label: v === 0 ? "0 dB/oct (평탄)" : `+${v} dB/oct` })), onChange: (v) => setModSetting(this.id, "slope", Number(v)) },
      { type: "select", label: "dB 범위", value: String(this.range), options: [60, 72, 96, 120].map((v) => ({ value: String(v), label: `${v} dB` })), onChange: (v) => setModSetting(this.id, "range", Number(v)) },
      { type: "toggle", label: "피크 홀드", value: this.showHold, onChange: (v) => setModSetting(this.id, "hold", v) },
      { type: "select", label: "색상", value: modSetting(this.id, "colors", "default"), options: Object.entries(COLOR_PRESETS).map(([k, p]) => ({ value: k, label: p.label })), onChange: (v) => setModSetting(this.id, "colors", v) },
      { type: "select", label: "레퍼런스", value: names.includes(this.refName) ? this.refName : "", options: [{ value: "", label: "없음" }, ...names.map((n) => ({ value: n, label: n }))], onChange: (v) => setModSetting(this.id, "ref", v) },
      { type: "toggle", label: "레퍼런스 레벨 자동 맞춤", value: this.autoLevel, onChange: (v) => setModSetting(this.id, "refAuto", v) },
      { type: "action", label: "레퍼런스 추가… (파일 선택 또는 타일에 드롭)", onClick: () => this.addReference() },
      ...(names.includes(this.refName) ? [{ type: "action", label: `레퍼런스 삭제: ${this.refName}`, onClick: () => this.deleteReference(this.refName) } as SettingItem] : []),
    ];
  }

  private setNote(s: string) { this.note = s; this.noteUntil = performance.now() + 6000; }

  onDrop(paths: string[]) {
    if (paths[0]) this.addReference(paths[0]);
  }

  private async addReference(dropped?: string) {
    if (this.busy) return;
    this.busy = true;
    try {
      let path: string | null = dropped ?? null;
      if (!path) {
        if (inTauri) {
          const r = await openDialog({ title: "레퍼런스 오디오 선택", multiple: false, filters: [{ name: "Audio", extensions: ["wav", "aif", "aiff", "flac", "mp3", "ogg", "m4a", "aac"] }] });
          path = typeof r === "string" ? r : null;
          if (!path) return;
        } else path = "mock.wav";
      }
      const spec = await getSource()!.analyzeReference(path);
      const name = path.replace(/\\/g, "/").split("/").pop()!.replace(/\.[^.]+$/, "");
      const refs = { ...this.presets, [name]: spec.map((v) => Math.round(v * 10) / 10) };
      setModSetting(this.id, "refs", refs);
      setModSetting(this.id, "ref", name);
      this.setNote(`레퍼런스 추가됨: ${name}`);
    } catch (e) {
      this.setNote(`레퍼런스 실패: ${String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  private deleteReference(name: string) {
    const refs = { ...this.presets };
    delete refs[name];
    setModSetting(this.id, "refs", refs);
    setModSetting(this.id, "ref", "");
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    const DB_BOTTOM = -this.range;
    const SLOPE_DB_PER_OCT = this.slope;
    const x0 = PAD_L, x1 = w - PAD_R, y0 = PAD_T, y1 = h - PAD_B;
    const pw = x1 - x0, ph = y1 - y0;
    if (pw < 20 || ph < 20) return;

    // Update ballistics with the slope. Channel mode: one curve (max of L/R), two curves
    // L / R, or two curves Mid / Side (the engine sends M/S spectra next to L/R).
    const chan = this.chan;
    const two = chan !== "max";
    for (let i = 0; i < N_SPEC; i++) {
      const tilt = SLOPE_DB_PER_OCT * Math.log2(pointFreq(i) / 1000);
      const v = (chan === "max" ? Math.max(f.specL[i], f.specR[i]) : chan === "lr" ? f.specL[i] : f.specM[i]) + tilt;
      if (two) this.smooth2[i] = ballistic(this.smooth2[i], (chan === "lr" ? f.specR[i] : f.specS[i]) + tilt, dt, 60);
      this.smooth[i] = ballistic(this.smooth[i], v, dt, 60);
      if (v >= this.hold[i]) { this.hold[i] = v; this.holdAge[i] = 0; }
      else { this.holdAge[i] += dt; if (this.holdAge[i] > 1.0) this.hold[i] = ballistic(this.hold[i], v, dt, 24); }
    }

    const yOf = (db: number) => y0 + ((DB_TOP - Math.min(DB_TOP, Math.max(DB_BOTTOM, db))) / (DB_TOP - DB_BOTTOM)) * ph;
    const xOf = (i: number) => x0 + (i / (N_SPEC - 1)) * pw;

    // Grid
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme("grid");
    ctx.fillStyle = theme("fg-1");
    ctx.font = font(10);
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (let db = DB_TOP; db >= DB_BOTTOM; db -= 12) {
      const y = Math.round(yOf(db)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillText(db.toString(), x0 - 4, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const hz of FREQ_TICKS) {
      const x = Math.round(xOf(freqToIndex(hz))) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, x, y1 + 5);
    }

    // Reference overlay (dashed), level-aligned to the live spectrum when enabled.
    const ref = this.presets[this.refName];
    if (ref && ref.length === N_SPEC) {
      let offset = 0;
      if (this.autoLevel) {
        // Align medians over 100 Hz … 10 kHz (only when the live signal is present).
        const lo = Math.round(freqToIndex(100)), hi = Math.round(freqToIndex(10000));
        const live: number[] = [], rf: number[] = [];
        for (let i = lo; i < hi; i++) {
          const tilt = SLOPE_DB_PER_OCT * Math.log2(pointFreq(i) / 1000);
          if (this.smooth[i] > DB_BOTTOM + 6) { live.push(this.smooth[i]); rf.push(ref[i] + tilt); }
        }
        if (live.length > 20) {
          live.sort((a, b) => a - b); rf.sort((a, b) => a - b);
          offset = live[live.length >> 1] - rf[rf.length >> 1];
        }
      }
      ctx.beginPath();
      for (let i = 0; i < N_SPEC; i++) {
        const tilt = SLOPE_DB_PER_OCT * Math.log2(pointFreq(i) / 1000);
        const x = xOf(i), y = yOf(ref[i] + tilt + offset);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = withAlpha(theme("target"), 0.9);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = theme("target"); ctx.font = font(10); ctx.textAlign = "right"; ctx.textBaseline = "top";
      ctx.fillText(`ref: ${this.refName}${this.autoLevel ? ` (${offset >= 0 ? "+" : ""}${offset.toFixed(1)} dB)` : ""}`, x1 - 2, y0 + 2);
    }

    // Fill + line (colour preset)
    const cp = this.colors;
    const sig = theme(cp.line);
    const grad = cp.fill.dir === "v" ? ctx.createLinearGradient(0, y0, 0, y1) : ctx.createLinearGradient(x0, 0, x1, 0);
    for (const [pos, tok, a] of cp.fill.stops) grad.addColorStop(pos, withAlpha(theme(tok), a));
    ctx.beginPath();
    ctx.moveTo(xOf(0), y1);
    for (let i = 0; i < N_SPEC; i++) ctx.lineTo(xOf(i), yOf(this.smooth[i]));
    ctx.lineTo(xOf(N_SPEC - 1), y1);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < N_SPEC; i++) { const x = xOf(i), y = yOf(this.smooth[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.strokeStyle = sig;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    if (cp.glow) { ctx.shadowColor = sig; ctx.shadowBlur = 10; }
    ctx.stroke();
    ctx.shadowBlur = 0;
    if (two) {
      // second curve: R or Side in the secondary signal colour (Side is usually far below Mid)
      ctx.beginPath();
      for (let i = 0; i < N_SPEC; i++) { const x = xOf(i), y = yOf(this.smooth2[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.strokeStyle = withAlpha(theme("sig-2"), 0.95);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = theme("fg-1"); ctx.font = font(10, 600); ctx.textAlign = "left"; ctx.textBaseline = "top";
      const a = chan === "lr" ? "L" : "M", b = chan === "lr" ? "R" : "S";
      ctx.fillStyle = sig; ctx.fillText(`— ${a}`, x0 + 4, y0 + 2);
      ctx.fillStyle = theme("sig-2"); ctx.fillText(`— ${b}`, x0 + 30, y0 + 2);
    }

    // Peak hold
    if (this.showHold) {
      ctx.beginPath();
      for (let i = 0; i < N_SPEC; i++) { const x = xOf(i), y = yOf(this.hold[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.strokeStyle = withAlpha(theme(cp.hold), 0.8);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Units + notes
    ctx.fillStyle = theme("fg-2");
    ctx.font = font(10);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("dB", 4, y0);
    ctx.textAlign = "right";
    ctx.fillText("Hz", x1, y1 + 5);
    if (this.note && performance.now() < this.noteUntil) {
      ctx.fillStyle = theme("fg-0"); ctx.textAlign = "left";
      ctx.fillText(this.note, x0 + 4, y0 + 2);
    }
  }
}
