// Persisted settings and layout (localStorage inside the Tauri webview).
import type { LevelMode } from "./modules/levels";

export interface TileRect { x: number; y: number; w: number; h: number; on: boolean }
export type Layout = Record<string, TileRect>;

export const COLS = 24;
export const ROWS = 16;
export const MIN_W = 4;
export const MIN_H = 3;

export type SourceMode = "auto" | "output" | "input" | "plugin";

export interface Settings {
  /** auto = default/chosen output loopback + DAW plugins (recommended). */
  sourceMode: SourceMode;
  /** Device name for output/input modes; null = default device. */
  device: string | null;
  loudnessTarget: number;
  levelMode: LevelMode;
}

const SETTINGS_KEY = "rm.settings.v2";
const LAYOUT_KEY = "rm.layout.v2";

/** DESIGN.md §5 default arrangement on a 24×16 grid. */
export function defaultLayout(): Layout {
  return {
    spectrum: { x: 0, y: 0, w: 12, h: 7, on: true },
    loudness: { x: 12, y: 0, w: 6, h: 7, on: true },
    levels: { x: 18, y: 0, w: 3, h: 7, on: true },
    scope: { x: 21, y: 0, w: 3, h: 7, on: true },
    spectrogram: { x: 0, y: 7, w: 9, h: 9, on: true },
    stereo: { x: 9, y: 7, w: 5, h: 9, on: true },
    tract: { x: 14, y: 7, w: 5, h: 9, on: true },
    vowelmap: { x: 19, y: 7, w: 5, h: 9, on: true },
  };
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

export const settings: Settings = load(SETTINGS_KEY, { sourceMode: "auto", device: null, loudnessTarget: -14, levelMode: "peak" });
export const layout: Layout = load(LAYOUT_KEY, defaultLayout());

export function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

export function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* ignore */ }
}

export function resetLayout() {
  const d = defaultLayout();
  for (const k of Object.keys(layout)) delete layout[k];
  Object.assign(layout, d);
  saveLayout();
}
