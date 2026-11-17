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
import { VariationMapModule } from "./variationmap";
import { SubtitlesModule } from "./subtitles";
import { EmojiModule } from "./emoji";
import { PunchModule } from "./punch";
import { PianoModule } from "./piano";
import { CozyModule } from "./cozy";
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
  variation: () => new VariationMapModule(),
  subtitles: () => new SubtitlesModule(),
  emoji: () => new EmojiModule(),
  punch: () => new PunchModule(),
  piano: () => new PianoModule(),
  cozy: () => new CozyModule(),
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
  transient: "BPM Checker (온셋 · 템포)",
  stereobands: "Stereo Bands (대역별 폭)",
  player: "Player (파일 재생 · 분석)",
  variation: "Variation Map (베리에이션 · 반복 감지)",
  subtitles: "Subtitles (자막 · whisper)",
  emoji: "Emoji (도트 · 재미용)",
  punch: "Punch Machine (타격감 점수)",
  piano: "Piano (건반 · 멜로디)",
  cozy: "Cozy (코지 룸 · 재미용)",
};

/** A layout key is a module id, or `<module>#<n>` for an extra instance of the same module. */
export function baseOf(key: string): string { return key.split("#")[0]; }
export function isInstance(key: string): boolean { return key.includes("#"); }
/** Title for a layout key: the module title, numbered for extra instances ("Pitch (2)"). */
export function titleOf(key: string): string {
  const base = baseOf(key);
  const t = MODULE_TITLES[base] ?? base;
  return isInstance(key) ? `${t.replace(/\s*\(.*$/, "")} (${key.split("#")[1]})` : t;
}
/** Next instance key for a module — the counter is shared by every window (localStorage). */
export function newInstanceKey(base: string): string {
  let n = 2;
  try { n = Math.max(2, (Number(localStorage.getItem("rm.instance.seq")) || 1) + 1); localStorage.setItem("rm.instance.seq", String(n)); } catch { /* ignore */ }
  return `${base}#${n}`;
}

/** Minimum tile size in grid cells per layout kind. */
export function minSize(key: string, kind: LayoutKind): { w: number; h: number } {
  const id = baseOf(key);
  if (kind === "dockh") return { w: id === "levels" ? 1 : 2, h: 1 };
  if (kind === "dockv") return { w: 1, h: 2 };
  if (id === "levels" || id === "dynamics" || id === "emoji" || id === "cozy") return { w: 2, h: 3 };
  return { w: 3, h: 3 };
}
