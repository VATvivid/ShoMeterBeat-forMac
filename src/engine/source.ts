// Frame source: Tauri backend when available, otherwise a synthetic signal so the
// UI can be developed and screenshotted in a plain browser (`npm run dev`).
import { invoke } from "@tauri-apps/api/core";
import { emptyFrame, ENV_MAX_HZ, N_BANDS, N_ENV, N_LISSA, N_SCOPE, N_SPEC, parseFrame, pointFreq, SILENCE_DB, type Frame } from "./frame";

export type DeviceKind = "output" | "input";
export interface DeviceEntry { name: string; kind: DeviceKind; default: boolean }
export type SourceMode = "auto" | "output" | "input" | "plugin";
export interface Status { device: string; kind: DeviceKind; mode: SourceMode; plugins: number; sample_rate: number; channels: number; running: boolean; error: string | null }
export interface RecInfo { recording: boolean; seconds: number; path: string | null }

export const inTauri = typeof (window as any).__TAURI_INTERNALS__ !== "undefined";

export interface Source {
  tick(): Promise<Frame>;
  listDevices(): Promise<DeviceEntry[]>;
  setSource(mode: SourceMode, name: string | null): Promise<void>;
  /** Copies the bundled DAW plugin into the user plugin folders; returns destinations. */
  installPlugins(): Promise<string[]>;
  resetLoudness(): Promise<void>;
  status(): Promise<Status>;
  recStart(): Promise<void>;
  /** Stops and returns the finished temp WAV path. */
  recStop(): Promise<string>;
  recSave(src: string, dst: string): Promise<void>;
  recDiscard(src: string): Promise<void>;
  recDefaultName(): Promise<string>;
  /** Waveform envelope of the last `seconds`; null when no capture yet. */
  waveOverview(seconds: number): Promise<WaveOverview | null>;
  /** Exports absolute frames [start, end) of the history to a WAV; resolves to frames written. */
  waveExport(start: number, end: number, dst: string): Promise<number>;
  /** Average spectrum (dB, N_SPEC points) of an audio file. */
  analyzeReference(path: string): Promise<number[]>;
  /** Decoded PCM (≤ 10 min) for the Player. */
  loadAudio(path: string): Promise<LoadedAudio | null>;
  /** Whole-file loudness / dynamics / tempo. */
  analyzeFile(path: string, priorBpm?: number): Promise<FileAnalysis>;
  writeText(path: string, text: string): Promise<void>;
  readText(path: string): Promise<string>;
  /** Sound events (onset clips → feature vectors) with seq > after. */
  eventsSince(after: number): Promise<SoundEvent[]>;
  setOnsetK(k: number): Promise<void>;
}

export interface SoundEvent { seq: number; t: number; peak_db: number; features: number[] }

export interface LoadedAudio { sr: number; channels: number; frames: number; samples: Float32Array /* interleaved */ }
export interface FileAnalysis {
  duration: number; sample_rate: number; channels: number; lufs_i: number; lra: number; true_peak: number;
  sample_peak: number; rms: number; crest: number; bpm: number; bpm_confidence: number; bpm_agreement: number;
}

export function parseLoadedAudio(buf: ArrayBuffer): LoadedAudio | null {
  const v = new Float32Array(buf);
  if (v.length < 4 || v[0] !== 4242) return null;
  const channels = v[2] | 0, frames = v[3] | 0;
  return { sr: v[1], channels, frames, samples: v.subarray(4, 4 + frames * channels) };
}

export interface WaveOverview { sr: number; head: number; cols: Float32Array /* (min,max,rms,flux) per column, oldest first */ }
export const OV_STRIDE = 4;

export function parseOverview(buf: ArrayBuffer): WaveOverview | null {
  const v = new Float32Array(buf);
  if (v.length < 4) return null;
  const n = v[1] | 0;
  return { sr: v[0], head: v[2] * 65536 + v[3], cols: v.subarray(4, 4 + n * OV_STRIDE) };
}

class TauriSource implements Source {
  private last = emptyFrame();
  async tick() {
    const buf = await invoke<ArrayBuffer>("frame");
    const f = parseFrame(buf);
    if (f) this.last = f;
    return this.last;
  }
  listDevices() { return invoke<DeviceEntry[]>("list_devices"); }
  setSource(mode: SourceMode, name: string | null) { return invoke<void>("set_source", { mode, name }); }
  installPlugins() { return invoke<string[]>("install_plugins"); }
  resetLoudness() { return invoke<void>("reset_loudness"); }
  status() { return invoke<Status>("status"); }
  recStart() { return invoke<void>("rec_start"); }
  recStop() { return invoke<string>("rec_stop"); }
  recSave(src: string, dst: string) { return invoke<void>("rec_save", { src, dst }); }
  recDiscard(src: string) { return invoke<void>("rec_discard", { src }); }
  recDefaultName() { return invoke<string>("rec_default_name"); }
  async waveOverview(seconds: number) { return parseOverview(await invoke<ArrayBuffer>("wave_overview", { seconds })); }
  waveExport(start: number, end: number, dst: string) { return invoke<number>("wave_export", { start, end, dst }); }
  analyzeReference(path: string) { return invoke<number[]>("analyze_reference", { path }); }
  async loadAudio(path: string) { return parseLoadedAudio(await invoke<ArrayBuffer>("load_audio", { path })); }
  analyzeFile(path: string, priorBpm?: number) { return invoke<FileAnalysis>("analyze_file", { path, priorBpm }); }
  writeText(path: string, text: string) { return invoke<void>("write_text", { path, text }); }
  readText(path: string) { return invoke<string>("read_text", { path }); }
  eventsSince(after: number) { return invoke<SoundEvent[]>("events_since", { after }); }
  setOnsetK(k: number) { return invoke<void>("set_onset_k", { k }); }
}

/** Deterministic-ish synthetic music-like signal for browser-only development. */
class MockSource implements Source {
  private t = 0;
  private phase = 0;
  private seq = 0;
  private integ = -16;
  private recAt: number | null = null;
  async tick(): Promise<Frame> {
    const f = emptyFrame();
    const sr = 48000;
    const dt = 1 / 60;
    this.t += dt;
    const beat = Math.pow(Math.max(0, Math.sin(this.t * Math.PI * 2 * 2)), 8); // 120 bpm pulses
    const level = -14 + 6 * beat + 2 * Math.sin(this.t * 0.7);
    for (let i = 0; i < N_SPEC; i++) {
      const hz = pointFreq(i);
      const tilt = -4.5 * Math.log2(hz / 1000); // pink-ish
      const kick = 18 * beat * Math.exp(-Math.pow((hz - 60) / 40, 2));
      const vox = 8 * Math.exp(-Math.pow((Math.log2(hz / 1800)) / 0.6, 2)) * (0.6 + 0.4 * Math.sin(this.t * 3.1));
      const noise = (Math.random() - 0.5) * 3;
      const v = level - 10 + tilt + kick + vox + noise;
      f.specL[i] = Math.max(SILENCE_DB, v);
      f.specR[i] = Math.max(SILENCE_DB, v - 1.5 + 2 * Math.sin(this.t * 1.3 + i * 0.1));
    }
    const amp = Math.pow(10, level / 20);
    for (let i = 0; i < N_SCOPE; i++) {
      this.phase += (2 * Math.PI * 110) / sr;
      const base = Math.sin(this.phase) + 0.3 * Math.sin(this.phase * 3.01) + 0.08 * (Math.random() - 0.5);
      f.scopeL[i] = amp * base;
      f.scopeR[i] = amp * (0.85 * base + 0.25 * Math.sin(this.phase * 1.5));
    }
    for (let i = 0; i < N_LISSA; i++) {
      f.lissa[2 * i] = f.scopeL[N_SCOPE - N_LISSA + i];
      f.lissa[2 * i + 1] = f.scopeR[N_SCOPE - N_LISSA + i];
    }
    const pk = level + 6 + 4 * beat;
    f.peak = [pk, pk - 0.8];
    f.rms = [level, level - 1];
    f.truePeak = [pk + 0.4, pk - 0.3];
    f.correlation = 0.6 + 0.3 * Math.sin(this.t * 0.9);
    f.lufsM = level - 2 + 3 * beat;
    f.lufsS = level - 2.5 + Math.sin(this.t * 0.4);
    this.integ += (f.lufsS - this.integ) * 0.01;
    f.lufsI = this.integ;
    f.lra = 6.3;
    f.maxTP = -0.4;
    f.maxM = -6.2;
    f.maxS = -9.8;
    // Voice: glide around the vowel space i → a → u every ~6 s.
    const u = (this.t / 6) % 1;
    const vow = [[270, 2290], [660, 1720], [730, 1090], [300, 870], [270, 2290]];
    const k = Math.min(3, Math.floor(u * 4)), tt = u * 4 - k;
    const ease = tt * tt * (3 - 2 * tt);
    f.f1 = vow[k][0] + (vow[k + 1][0] - vow[k][0]) * ease + 10 * Math.sin(this.t * 9);
    f.f2 = vow[k][1] + (vow[k + 1][1] - vow[k][1]) * ease + 25 * Math.sin(this.t * 7);
    f.f3 = 2600 + 150 * Math.sin(this.t * 0.5);
    { // melody: C4 E4 G4 A4 G4 E4 (0.5 s each) with vibrato, pauses every 3 s
      const seq = [60, 64, 67, 69, 67, 64];
      const step = Math.floor(this.t / 0.5) % 6;
      const vib = 0.25 * Math.sin(this.t * 2 * Math.PI * 5.5);
      f.f0 = 440 * Math.pow(2, (seq[step] + vib - 69) / 12);
      if (this.t % 4 > 3.4) f.voiced = 0.1;
    }
    // Breath in the gaps: noisy, bright, a short burst.
    const gapT = this.t % 4;
    const breathing = gapT > 3.45 && gapT < 3.85;
    f.flatness = breathing ? 0.55 : 0.08;
    f.centroid = breathing ? 2800 : 900;
    if (breathing) { f.rms = [-30, -30]; f.lufsM = -28; }
    f.voiced = 0.6 + 0.4 * Math.sin(this.t * 2.3) > 0.5 ? 0.9 : 0.2;
    for (let i = 0; i < N_ENV; i++) {
      const hz = (ENV_MAX_HZ * i) / (N_ENV - 1);
      const g = (fc: number, bw: number, a: number) => a * Math.exp(-Math.pow((hz - fc) / bw, 2));
      f.envelope[i] = -30 + g(f.f1, 90, 24) + g(f.f2, 140, 18) + g(f.f3, 200, 12) - hz / 400;
    }
    f.recSeconds = this.recAt === null ? -1 : (performance.now() - this.recAt) / 1000;
    for (let b = 0; b < N_BANDS; b++) { f.bands[2 * b] = [0.95, 0.8, 0.5 + 0.3 * Math.sin(this.t), 0.2][b]; f.bands[2 * b + 1] = [0.03, 0.12, 0.3, 0.45][b]; }
    f.running = true;
    f.sampleRate = sr;
    f.channels = 2;
    f.seq = ++this.seq;
    return f;
  }
  async listDevices(): Promise<DeviceEntry[]> {
    return [
      { name: "(브라우저 미리보기: 합성 신호)", kind: "output", default: true },
      { name: "(예시 입력) Loopback 1+2", kind: "input", default: true },
    ];
  }
  async setSource() {}
  async installPlugins() { return ["(mock) %LOCALAPPDATA%\Programs\Common\CLAP\re-minimeter Send.clap"]; }
  async resetLoudness() { this.integ = -16; }
  async status(): Promise<Status> { return { device: "합성 신호", kind: "output", mode: "auto", plugins: 1, sample_rate: 48000, channels: 2, running: true, error: null }; }
  async recStart() { this.recAt = performance.now(); }
  async recStop() { this.recAt = null; return "(mock).wav"; }
  async recSave() {}
  async recDiscard() {}
  async recDefaultName() { return "re-minimeter_mock.wav"; }
  private wcols: number[] = [];
  private whead = 0;
  async waveOverview(seconds: number): Promise<WaveOverview | null> {
    // Synthesize envelope columns at 100/s from the mock level.
    const now = performance.now() / 1000;
    const target = Math.floor(now * 100);
    while (this.whead < target) {
      const t = this.whead / 100;
      const beat = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2 * 2)), 8);
      const a = 0.08 + 0.5 * beat + 0.05 * Math.random();
      // flux: a sharp pulse on each beat (120 BPM) with a weaker offbeat
      const beatPos = (t * 2) % 1;
      const fl = (beatPos < 0.03 ? 8 : 0) + (((t * 2 + 0.5) % 1) < 0.03 ? 3 : 0) + Math.random() * 0.4;
      this.wcols.push(-a * (0.7 + 0.3 * Math.random()), a, a * 0.6, fl);
      this.whead++;
    }
    if (this.wcols.length > 4 * 120 * 100) this.wcols.splice(0, this.wcols.length - 4 * 120 * 100);
    const n = Math.min(this.wcols.length / 4, Math.round(seconds * 100));
    return { sr: 48000, head: this.whead * 480, cols: new Float32Array(this.wcols.slice(this.wcols.length - n * 4)) };
  }
  async waveExport() { return 0; }
  async analyzeReference() { return Array.from({ length: N_SPEC }, (_, i) => -30 - 4.5 * Math.log2(pointFreq(i) / 1000) + 3 * Math.sin(i / 9)); }
  async loadAudio(): Promise<LoadedAudio | null> {
    const sr = 48000, frames = sr * 8, samples = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i++) { const t = i / sr; const env = 0.6 * Math.pow(Math.max(0, Math.sin(t * Math.PI * 2 * 2)), 6) + 0.1; const s = env * Math.sin(2 * Math.PI * 110 * t); samples[2 * i] = s; samples[2 * i + 1] = s * 0.9; }
    return { sr, channels: 2, frames, samples };
  }
  async writeText() {}
  async readText() { return "{}"; }
  private evSeq = 0;
  private evLast = 0;
  async setOnsetK() {}
  async eventsSince(after: number): Promise<SoundEvent[]> {
    // Three "sample pools" fired on beats; every so often the same sample repeats exactly.
    const now = this.t;
    const out: SoundEvent[] = [];
    while (this.evLast + 0.5 <= now) {
      this.evLast += 0.5;
      const pool = Math.floor(this.evLast / 0.5) % 7 < 4 ? 0 : Math.floor(this.evLast / 0.5) % 7 < 6 ? 1 : 2;
      const base = [[-30, 9.5, 1.2, 10, 60], [-26, 11.5, 1.6, 4, 25], [-34, 8.0, 2.0, 25, 120]][pool];
      const repeat = Math.floor(this.evLast / 0.5) % 11 === 0;
      const j = (k: number) => (repeat ? 0 : (Math.random() - 0.5) * k);
      const f = new Array(58).fill(0).map((_, i) => i < 24 ? base[0] - i * 0.8 + pool * 3 * Math.sin(i / 3) + j(3) : i < 48 ? j(2) : 0);
      f[48] = base[1] + j(0.4); f[49] = base[2] + j(0.3); f[50] = base[1] + 1 + j(0.4); f[51] = 0.2 + j(0.1);
      f[52] = base[3] + j(3); f[53] = base[4] + j(10); f[54] = base[4] * 2 + j(20); f[55] = 12 + j(2); f[56] = -8 + j(2); f[57] = 2 + pool + j(0.5);
      this.evSeq++;
      out.push({ seq: this.evSeq, t: this.evLast, peak_db: f[56], features: f });
    }
    return out.filter((e) => e.seq > after);
  }
  async analyzeFile(): Promise<FileAnalysis> { return { duration: 8, sample_rate: 48000, channels: 2, lufs_i: -16.2, lra: 5.1, true_peak: -1.0, sample_peak: -1.3, rms: -14.8, crest: 13.5, bpm: 120, bpm_confidence: 0.8, bpm_agreement: 0.9 }; }
}

export function createSource(): Source {
  return inTauri ? new TauriSource() : new MockSource();
}
