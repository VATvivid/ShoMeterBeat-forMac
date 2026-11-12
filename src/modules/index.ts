import { LevelsModule } from "./levels";
import { LoudnessModule } from "./loudness";
import { PitchModule } from "./pitch";
import { ScopeModule } from "./scope";
import { SpectrogramModule } from "./spectrogram";
import { SpectrumModule } from "./spectrum";
import { StereoModule } from "./stereo";
import { TractModule } from "./tract";
import type { ModuleFactory } from "./types";
import { VowelMapModule } from "./vowelmap";
import { WaveformModule } from "./waveform";
import { DynamicsModule } from "./dynamics";
import { TransientModule } from "./transient";
import { StereoBandsModule } from "./stereobands";
import { PlayerModule } from "./player";
import type { LayoutKind } from "../state";

/** Registry: id → factory. Order here is the order in the "모듈" menu. */
export const MODULES: Record<string, ModuleFactory> = {
  spectrum: () => new SpectrumModule(),
  loudness: () => new LoudnessModule(),
  spectrogram: () => new SpectrogramModule(),
  stereo: () => new StereoModule(),
  levels: () => new LevelsModule(),
  scope: () => new ScopeModule(),
  tract: () => new TractModule(),
  vowelmap: () => new VowelMapModule(),
  pitch: () => new PitchModule(),
  waveform: () => new WaveformModule(),
  dynamics: () => new DynamicsModule(),
  transient: () => new TransientModule(),
  stereobands: () => new StereoBandsModule(),
  player: () => new PlayerModule(),
};

export const MODULE_TITLES: Record<string, string> = {
  spectrum: "Spectrum",
  loudness: "Loudness (LUFS)",
  spectrogram: "Spectrogram",
  stereo: "Stereo",
  levels: "Levels",
  scope: "Oscilloscope",
  tract: "Vocal Tract (발성 기관)",
  vowelmap: "Vowel Map (모음 포먼트)",
  pitch: "Pitch (노트 블록)",
  waveform: "Waveform (파형 · 구간 저장)",
  dynamics: "Dynamics (Crest · PSR · PLR)",
  transient: "Transient (온셋 · BPM)",
  stereobands: "Stereo Bands (대역별 폭)",
  player: "Player (파일 재생 · 분석)",
};

/** Minimum tile size in grid cells per layout kind. */
export function minSize(id: string, kind: LayoutKind): { w: number; h: number } {
  if (kind === "dockh") return { w: id === "levels" ? 1 : 2, h: 1 };
  if (kind === "dockv") return { w: 1, h: 2 };
  if (id === "levels" || id === "dynamics") return { w: 2, h: 3 };
  return { w: 3, h: 3 };
}
