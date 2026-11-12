import type { Frame } from "../engine/frame";
import { getSource } from "../engine/instance";
import { inTauri, type FileAnalysis, type LoadedAudio } from "../engine/source";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

// Player: drop an audio file on the tile → whole-file waveform, transport (play /
// pause / stop / loop, click to seek) through Web Audio (system default output, so
// the loopback analyzers react), plus the engine's offline analysis of the file:
// duration, LUFS-I, LRA, true peak, sample peak, RMS, crest, BPM (+ confidence).

const PAD_L = 8, PAD_R = 8, PAD_T = 36, PAD_B = 18;
const COLS = 2400;

export class PlayerModule implements Module {
  readonly id = "player";
  readonly title = "Player";
  private bar: HTMLElement | null = null;
  private nameEl: HTMLElement | null = null;
  private playBtn: HTMLButtonElement | null = null;
  private loopBtn: HTMLButtonElement | null = null;
  private path = "";
  private audio: LoadedAudio | null = null;
  private peaks: Float32Array | null = null; // min,max pairs over COLS columns
  private analysis: FileAnalysis | null = null;
  private buffer: AudioBuffer | null = null;
  private actx: AudioContext | null = null;
  private node: AudioBufferSourceNode | null = null;
  private playing = false;
  private offset = 0;      // seconds into the file when (re)started
  private startedAt = 0;   // actx.currentTime at start
  private loop = false;
  private note = "";
  private noteUntil = 0;
  private loading = false;

  private get priorBpm() { return modSetting(this.id, "prior", 110); }

  settings(): SettingItem[] {
    return [
      { type: "select", label: "템포 사전 (장르)", value: String(this.priorBpm), options: [[85, "느림 (85)"], [110, "보통 (110)"], [130, "빠름 (130)"], [150, "매우 빠름 (150)"]].map(([v, l]) => ({ value: String(v), label: String(l) })), onChange: (v) => { setModSetting(this.id, "prior", Number(v)); if (this.path) this.reanalyze(); } },
      { type: "action", label: "다시 분석", onClick: () => this.reanalyze() },
      { type: "action", label: "파일 닫기", onClick: () => this.unload() },
    ];
  }

  headReadout() {
    if (!this.audio) return "파일을 끌어다 놓으세요";
    const pos = this.position();
    return `${fmtTime(pos)} / ${fmtTime(this.audio.frames / this.audio.sr)}${this.playing ? "  ▶" : ""}`;
  }

  mount(body: HTMLElement, isEditing: () => boolean) {
    const bar = document.createElement("div");
    bar.className = "player-bar";
    const mk = (label: string, title: string, on: () => void) => {
      const b = document.createElement("button");
      b.className = "btn"; b.textContent = label; b.title = title;
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      b.addEventListener("click", (e) => { e.stopPropagation(); on(); });
      bar.appendChild(b);
      return b;
    };
    this.playBtn = mk("▶", "재생/일시정지 (클릭: 탐색)", () => this.toggle());
    mk("■", "정지", () => this.stop());
    this.loopBtn = mk("↻", "반복", () => { this.loop = !this.loop; this.loopBtn!.classList.toggle("on", this.loop); if (this.node) this.node.loop = this.loop; });
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = "파일 없음";
    bar.appendChild(name);
    this.nameEl = name;
    body.appendChild(bar);
    this.bar = bar;
    body.addEventListener("pointerdown", (e) => {
      if (isEditing() || e.button !== 0 || !this.audio) return;
      const r = body.getBoundingClientRect();
      const x = e.clientX - r.left;
      const w = r.width;
      if (x < PAD_L || x > w - PAD_R) return;
      const t = ((x - PAD_L) / (w - PAD_L - PAD_R)) * (this.audio.frames / this.audio.sr);
      this.seek(t);
    });
  }

  onDrop(paths: string[]) {
    const p = paths.find((x) => /\.(wav|aif|aiff|flac|mp3|ogg|m4a|aac)$/i.test(x)) ?? paths[0];
    if (p) this.load(p);
  }

  private setNote(s: string) { this.note = s; this.noteUntil = performance.now() + 6000; }

  private async load(path: string) {
    if (this.loading) return;
    this.loading = true;
    this.stop();
    this.setNote("불러오는 중…");
    try {
      const src = getSource()!;
      const [audio, analysis] = await Promise.all([src.loadAudio(path), src.analyzeFile(path, this.priorBpm).catch((e) => { this.setNote(`분석 실패: ${String(e)}`); return null; })]);
      if (!audio) throw new Error("디코드 실패");
      this.path = path;
      this.audio = audio;
      this.analysis = analysis;
      this.offset = 0;
      this.buildPeaks();
      this.buildBuffer();
      if (this.nameEl) this.nameEl.textContent = path.replace(/\\/g, "/").split("/").pop() ?? path;
      this.setNote("");
    } catch (e) {
      this.setNote(`불러오기 실패: ${String(e)}`);
    } finally {
      this.loading = false;
    }
  }

  private async reanalyze() {
    if (!this.path) return;
    try { this.analysis = await getSource()!.analyzeFile(this.path, this.priorBpm); } catch (e) { this.setNote(`분석 실패: ${String(e)}`); }
  }

  private unload() {
    this.stop();
    this.path = ""; this.audio = null; this.peaks = null; this.analysis = null; this.buffer = null;
    if (this.nameEl) this.nameEl.textContent = "파일 없음";
  }

  private buildPeaks() {
    const a = this.audio!;
    const peaks = new Float32Array(COLS * 2);
    const per = a.frames / COLS;
    for (let c = 0; c < COLS; c++) {
      const s0 = Math.floor(c * per), s1 = Math.max(s0 + 1, Math.floor((c + 1) * per));
      let mn = Infinity, mx = -Infinity;
      for (let i = s0; i < s1 && i < a.frames; i++) {
        const v = a.channels === 2 ? 0.5 * (a.samples[2 * i] + a.samples[2 * i + 1]) : a.samples[i];
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
      peaks[2 * c] = mn === Infinity ? 0 : mn; peaks[2 * c + 1] = mx === -Infinity ? 0 : mx;
    }
    this.peaks = peaks;
  }

  private buildBuffer() {
    const a = this.audio!;
    if (typeof AudioContext === "undefined") return;
    this.actx ??= new AudioContext();
    const buf = this.actx.createBuffer(a.channels, a.frames, a.sr);
    for (let ch = 0; ch < a.channels; ch++) {
      const data = new Float32Array(a.frames);
      for (let i = 0; i < a.frames; i++) data[i] = a.samples[i * a.channels + ch];
      buf.copyToChannel(data, ch);
    }
    this.buffer = buf;
  }

  private position(): number {
    if (!this.audio) return 0;
    const dur = this.audio.frames / this.audio.sr;
    if (!this.playing || !this.actx) return Math.min(dur, this.offset);
    let p = this.offset + (this.actx.currentTime - this.startedAt);
    if (this.loop && dur > 0) p = p % dur;
    if (p >= dur && !this.loop) { this.playing = false; this.offset = 0; this.node = null; this.playBtn && (this.playBtn.textContent = "▶"); return 0; }
    return p;
  }

  private toggle() {
    if (!this.buffer || !this.actx) return;
    if (this.playing) { this.offset = this.position(); this.node?.stop(); this.node = null; this.playing = false; this.playBtn!.textContent = "▶"; return; }
    this.startAt(this.offset);
  }

  private startAt(t: number) {
    if (!this.buffer || !this.actx) return;
    this.node?.stop();
    const node = this.actx.createBufferSource();
    node.buffer = this.buffer; node.loop = this.loop;
    node.connect(this.actx.destination);
    node.start(0, t);
    this.node = node; this.offset = t; this.startedAt = this.actx.currentTime; this.playing = true;
    this.playBtn!.textContent = "⏸";
    void this.actx.resume();
  }

  private seek(t: number) {
    if (this.playing) this.startAt(t); else this.offset = t;
  }

  private stop() {
    this.node?.stop(); this.node = null; this.playing = false; this.offset = 0;
    if (this.playBtn) this.playBtn.textContent = "▶";
  }

  draw(d: DrawCtx, _f: Frame) {
    const { ctx, w, h } = d;
    const x0 = PAD_L, x1 = w - PAD_R, y0 = PAD_T, y1 = h - PAD_B;
    const pw = x1 - x0, ph = y1 - y0;
    if (pw < 20 || ph < 10) return;
    if (this.bar) this.bar.style.display = h < 60 ? "none" : "flex";
    const mid = y0 + ph / 2;
    ctx.strokeStyle = theme("grid"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, Math.round(mid) + 0.5); ctx.lineTo(x1, Math.round(mid) + 0.5); ctx.stroke();

    if (!this.audio || !this.peaks) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(11); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(this.loading ? "불러오는 중…" : inTauri ? "오디오 파일을 여기에 끌어다 놓으세요 (WAV · AIFF · FLAC · MP3 · OGG)" : "브라우저 미리보기: 아무 파일이나 드롭하면 합성 신호를 불러옵니다", x0 + pw / 2, mid);
      if (this.note && performance.now() < this.noteUntil) { ctx.fillStyle = theme("clip"); ctx.fillText(this.note, x0 + pw / 2, mid + 16); }
      return;
    }
    const dur = this.audio.frames / this.audio.sr;
    // waveform
    ctx.strokeStyle = withAlpha(theme("sig"), 0.9); ctx.lineWidth = 1;
    ctx.beginPath();
    for (let px = 0; px < pw; px++) {
      const c0 = Math.floor((px / pw) * COLS), c1 = Math.max(c0 + 1, Math.floor(((px + 1) / pw) * COLS));
      let mn = Infinity, mx = -Infinity;
      for (let c = c0; c < c1 && c < COLS; c++) { mn = Math.min(mn, this.peaks[2 * c]); mx = Math.max(mx, this.peaks[2 * c + 1]); }
      if (mn === Infinity) continue;
      const yt = mid - Math.max(-1, Math.min(1, mx)) * ph / 2, yb = mid - Math.max(-1, Math.min(1, mn)) * ph / 2;
      const x = x0 + px + 0.5;
      ctx.moveTo(x, Math.min(yt, yb - 1)); ctx.lineTo(x, Math.max(yb, yt + 1));
    }
    ctx.stroke();
    // played region tint + playhead
    const pos = this.position();
    const xp = x0 + (pos / dur) * pw;
    ctx.fillStyle = withAlpha(theme("sig"), 0.08); ctx.fillRect(x0, y0, xp - x0, ph);
    ctx.strokeStyle = theme("peak"); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(Math.round(xp) + 0.5, y0); ctx.lineTo(Math.round(xp) + 0.5, y1); ctx.stroke(); ctx.lineWidth = 1;
    // time axis
    ctx.fillStyle = theme("fg-1"); ctx.font = font(10); ctx.textAlign = "center"; ctx.textBaseline = "top";
    const step = dur <= 20 ? 2 : dur <= 60 ? 5 : dur <= 180 ? 15 : dur <= 600 ? 60 : 120;
    for (let s = 0; s <= dur; s += step) {
      const x = x0 + (s / dur) * pw;
      ctx.strokeStyle = theme("grid"); ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y0); ctx.lineTo(Math.round(x) + 0.5, y1); ctx.stroke();
      ctx.fillText(fmtTime(s), x, y1 + 4);
    }
    // analysis readouts (top-right)
    const a = this.analysis;
    ctx.textAlign = "right"; ctx.textBaseline = "top";
    ctx.font = font(10); ctx.fillStyle = theme("fg-1");
    const rx = x1 - 2;
    if (a) {
      const line1 = `${fmtTime(a.duration)} · ${a.sample_rate} Hz · ${a.channels}ch · LUFS-I ${a.lufs_i.toFixed(1)} · LRA ${a.lra.toFixed(1)} LU · TP ${a.true_peak.toFixed(1)} dBTP`;
      const line2 = `Peak ${a.sample_peak.toFixed(1)} · RMS ${a.rms.toFixed(1)} · Crest ${a.crest.toFixed(1)} dB · BPM ${a.bpm > 0 ? a.bpm.toFixed(1) : "—"} (${Math.round(a.bpm_confidence * 100)}% · 일치 ${Math.round(a.bpm_agreement * 100)}%)`;
      if (w > 520) { ctx.fillText(line1, rx, 8); ctx.fillText(line2, rx, 21); }
      else { ctx.fillText(`LUFS ${a.lufs_i.toFixed(1)} · TP ${a.true_peak.toFixed(1)} · BPM ${a.bpm > 0 ? a.bpm.toFixed(0) : "—"}`, rx, 8); ctx.fillText(`LRA ${a.lra.toFixed(1)} · Crest ${a.crest.toFixed(1)}`, rx, 21); }
    } else {
      ctx.fillText("분석 중…", rx, 8);
    }
    if (this.note && performance.now() < this.noteUntil) { ctx.fillStyle = theme("clip"); ctx.textAlign = "left"; ctx.fillText(this.note, x0 + 4, y0 + 2); }
  }
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60), ss = s - m * 60;
  return `${m}:${ss < 10 ? "0" : ""}${ss.toFixed(1)}`;
}
