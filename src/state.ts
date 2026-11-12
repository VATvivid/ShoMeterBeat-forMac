// Persisted settings and layouts (localStorage inside the Tauri webview).
import type { LevelMode } from "./modules/levels";

export interface TileRect { x: number; y: number; w: number; h: number; on: boolean }
export type Layout = Record<string, TileRect>;

/** Window arrangement: free grid, or docked to a screen edge as one strip. */
export type DockMode = "none" | "top" | "bottom" | "left" | "right";
/** Layout family: normal grid, horizontal strip (top/bottom), vertical strip (left/right). */
export type LayoutKind = "normal" | "dockh" | "dockv";

export const GRID_DIMS: Record<LayoutKind, { cols: number; rows: number }> = {
  normal: { cols: 24, rows: 16 },
  dockh: { cols: 24, rows: 1 },
  dockv: { cols: 1, rows: 24 },
};

export type SourceMode = "auto" | "output" | "input" | "plugin";

export interface Settings {
  sourceMode: SourceMode;
  device: string | null;
  loudnessTarget: number;
  levelMode: LevelMode;
  dock: DockMode;
  /** Strip thickness in px when docked (height for top/bottom, width for left/right). */
  dockSize: number;
  /** Per-module free-form settings, keyed by module id. */
  modules: Record<string, Record<string, unknown>>;
}

const SETTINGS_KEY = "rm.settings.v3";
const LAYOUT_KEYS: Record<LayoutKind, string> = { normal: "rm.layout.v2", dockh: "rm.layout.dockh.v1", dockv: "rm.layout.dockv.v1" };

export function layoutKindFor(dock: DockMode): LayoutKind {
  return dock === "none" ? "normal" : dock === "top" || dock === "bottom" ? "dockh" : "dockv";
}

/** DESIGN.md §5 default arrangements. */
export function defaultLayout(kind: LayoutKind): Layout {
  if (kind === "dockh") {
    const row = (x: number, w: number) => ({ x, y: 0, w, h: 1, on: true });
    return {
      spectrum: row(0, 8), loudness: row(8, 5), levels: row(13, 2), stereo: row(15, 3), scope: row(18, 3), spectrogram: row(21, 3),
      tract: { x: 0, y: 0, w: 3, h: 1, on: false }, vowelmap: { x: 0, y: 0, w: 3, h: 1, on: false },
    };
  }
  if (kind === "dockv") {
    const col = (y: number, h: number) => ({ x: 0, y, w: 1, h, on: true });
    return {
      spectrum: col(0, 6), loudness: col(6, 6), levels: col(12, 4), stereo: col(16, 4), scope: col(20, 4),
      spectrogram: { x: 0, y: 0, w: 1, h: 4, on: false }, tract: { x: 0, y: 0, w: 1, h: 4, on: false }, vowelmap: { x: 0, y: 0, w: 1, h: 4, on: false },
    };
  }
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

export const settings: Settings = load(SETTINGS_KEY, {
  sourceMode: "auto", device: null, loudnessTarget: -14, levelMode: "peak", dock: "none", dockSize: 200, modules: {},
});
if (!settings.modules || typeof settings.modules !== "object") settings.modules = {};

export const layouts: Record<LayoutKind, Layout> = {
  normal: load(LAYOUT_KEYS.normal, defaultLayout("normal")),
  dockh: load(LAYOUT_KEYS.dockh, defaultLayout("dockh")),
  dockv: load(LAYOUT_KEYS.dockv, defaultLayout("dockv")),
};

export function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

export function saveLayout(kind: LayoutKind) {
  try { localStorage.setItem(LAYOUT_KEYS[kind], JSON.stringify(layouts[kind])); } catch { /* ignore */ }
}

export function resetLayout(kind: LayoutKind) {
  const d = defaultLayout(kind);
  const l = layouts[kind];
  for (const k of Object.keys(l)) delete l[k];
  Object.assign(l, d);
  saveLayout(kind);
}

/** Per-module setting accessors (persisted under settings.modules[id]). */
export function modSetting<T>(id: string, key: string, fallback: T): T {
  const m = settings.modules[id];
  return m && key in m ? (m[key] as T) : fallback;
}
export function setModSetting(id: string, key: string, value: unknown) {
  (settings.modules[id] ??= {})[key] = value;
  saveSettings();
}
