// Persisted settings and layout (localStorage inside the Tauri webview).
export interface TileRect { x: number; y: number; w: number; h: number; on: boolean }
export type Layout = Record<string, TileRect>;

export const COLS = 24;
export const ROWS = 16;
export const MIN_W = 4;
export const MIN_H = 3;

export interface Settings {
  device: string | null;
  loudnessTarget: number;
}

const SETTINGS_KEY = "rm.settings.v1";
const LAYOUT_KEY = "rm.layout.v1";

/** DESIGN.md §5 default arrangement on a 24×16 grid. */
export function defaultLayout(): Layout {
  return {
    spectrum: { x: 0, y: 0, w: 16, h: 8, on: true },
    loudness: { x: 16, y: 0, w: 8, h: 8, on: true },
    spectrogram: { x: 0, y: 8, w: 12, h: 8, on: true },
    stereo: { x: 12, y: 8, w: 6, h: 8, on: true },
    levels: { x: 18, y: 8, w: 3, h: 8, on: true },
    scope: { x: 21, y: 8, w: 3, h: 8, on: true },
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

export const settings: Settings = load(SETTINGS_KEY, { device: null, loudnessTarget: -14 });
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
