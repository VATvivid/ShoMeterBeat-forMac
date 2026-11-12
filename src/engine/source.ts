// Frame source: Tauri backend when available, otherwise a synthetic signal so the
// UI can be developed and screenshotted in a plain browser (`npm run dev`).
import { invoke } from "@tauri-apps/api/core";
import { emptyFrame, N_LISSA, N_SCOPE, N_SPEC, parseFrame, pointFreq, SILENCE_DB, type Frame } from "./frame";

export interface Status { device: string; sample_rate: number; channels: number; running: boolean; error: string | null }

export const inTauri = typeof (window as any).__TAURI_INTERNALS__ !== "undefined";

export interface Source {
  tick(): Promise<Frame>;
  listDevices(): Promise<string[]>;
  setDevice(name: string | null): Promise<void>;
  resetLoudness(): Promise<void>;
  status(): Promise<Status>;
}

class TauriSource implements Source {
  private last = emptyFrame();
  async tick() {
    const buf = await invoke<ArrayBuffer>("frame");
    const f = parseFrame(buf);
    if (f) this.last = f;
    return this.last;
  }
  listDevices() { return invoke<string[]>("list_devices"); }
  setDevice(name: string | null) { return invoke<void>("set_device", { name }); }
  resetLoudness() { return invoke<void>("reset_loudness"); }
  status() { return invoke<Status>("status"); }
}

/** Deterministic-ish synthetic music-like signal for browser-only development. */
class MockSource implements Source {
  private t = 0;
  private phase = 0;
  private seq = 0;
  private integ = -16;
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
    f.running = true;
    f.sampleRate = sr;
    f.channels = 2;
    f.seq = ++this.seq;
    return f;
  }
  async listDevices() { return ["(브라우저 미리보기: 합성 신호)"]; }
  async setDevice() {}
  async resetLoudness() { this.integ = -16; }
  async status(): Promise<Status> { return { device: "합성 신호", sample_rate: 48000, channels: 2, running: true, error: null }; }
}

export function createSource(): Source {
  return inTauri ? new TauriSource() : new MockSource();
}
