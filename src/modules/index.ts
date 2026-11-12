import { LevelsModule } from "./levels";
import { LoudnessModule } from "./loudness";
import { ScopeModule } from "./scope";
import { SpectrogramModule } from "./spectrogram";
import { SpectrumModule } from "./spectrum";
import { StereoModule } from "./stereo";
import { TractModule } from "./tract";
import type { ModuleFactory } from "./types";
import { VowelMapModule } from "./vowelmap";

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
};
