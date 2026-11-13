// Persisted settings and layouts (localStorage inside the Tauri webview).
// Every window (main + pop-outs) runs its own copy of this module; settings are shared
// through localStorage and kept in sync with the `storage` event, layouts are per window.
import type { LevelMode } from "./modules/levels";

export interface TileRect { x: number; y: number; w: number; h: number; on: boolean }
export type Layout = Record<string, TileRect>;

/** Window label: "main" or "pop-<id>" for a pop-out window (from the page URL). */
export const WIN_LABEL = (() => { try { return new URLSearchParams(location.search).get("win") || "main"; } catch { return "main"; } })();
export const IS_POP = WIN_LABEL !== "main";

/** Window arrangement: free grid, or docked to a screen edge as one strip. */
export type DockMode = "none" | "top" | "bottom" | "left" | "right";
/** Layout family: normal grid, horizontal strip (top/bottom), vertical strip (left/right). */
export type LayoutKind = "normal" | "dockh" | "dockv";

/** Base grid size per layout kind. The grid grows beyond this when tiles need the room
 *  (columns and rows in the free grid, columns in the horizontal strip, rows in the
 *  vertical strip) and shrinks back when they fit again. A pop-out window has no base
 *  size: its grid is exactly the tiles' extent, so modules fill the window. */
export const GRID_DIMS: Record<LayoutKind, { cols: number; rows: number }> = {
  normal: IS_POP ? { cols: 1, rows: 1 } : { cols: 24, rows: 16 },
  dockh: { cols: 24, rows: 1 },
  dockv: { cols: 1, rows: 24 },
};

/** Effective grid size: base dims, extended to contain every visible tile. */
export function effectiveDims(kind: LayoutKind, rects: Iterable<{ x: number; y: number; w: number; h: number }>, extra = { cols: 0, rows: 0 }): { cols: number; rows: number } {
  const base = GRID_DIMS[kind];
  let cols = base.cols + (kind === "dockv" ? 0 : extra.cols), rows = base.rows + (kind === "dockh" ? 0 : extra.rows);
  for (const r of rects) {
    if (kind !== "dockv") cols = Math.max(cols, r.x + r.w);
    if (kind !== "dockh") rows = Math.max(rows, r.y + r.h);
  }
  return { cols, rows };
}

export type SourceMode = "auto" | "output" | "input" | "plugin";

export interface Settings {
  sourceMode: SourceMode;
  device: string | null;
  loudnessTarget: number;
  levelMode: LevelMode;
  dock: DockMode;
  /** Strip thickness in px when docked (height for top/bottom, width for left/right). */
  dockSize: number;
  /** Main window opacity 0–100 (pop-outs keep their own in the pop-out list). */
  opacity: number;
  /** Main window always-on-top (independent of dock mode, which forces it). */
  alwaysOnTop: boolean;
  /** Edit-mode drop behaviour: "free" (default) lets tiles overlap, "swap" exchanges with the one tile under the drop.
   *  (Renamed from layoutMode so values saved by earlier builds, whose default was swap, no longer apply.) */
  placeMode: "free" | "swap";
  /** 투명도 slider target: only the backgrounds (window stays sharp) or the whole window (WS_EX_LAYERED alpha). */
  opacityMode: "bg" | "window";
  /** Per-module free-form settings, keyed by module id. */
  modules: Record<string, Record<string, unknown>>;
}

const SETTINGS_KEY = "rm.settings.v3";
export const popLayoutKey = (label: string) => `rm.layout.pop.${label}.v1`;
const LAYOUT_KEYS: Record<LayoutKind, string> = {
  normal: IS_POP ? popLayoutKey(WIN_LABEL) : "rm.layout.v2",
  dockh: "rm.layout.dockh.v1",
  dockv: "rm.layout.dockv.v1",
};

export function layoutKindFor(dock: DockMode): LayoutKind {
  return dock === "none" ? "normal" : dock === "top" || dock === "bottom" ? "dockh" : "dockv";
}

/** DESIGN.md §5 default arrangements. A pop-out starts empty (its modules are written by the window that opens it). */
export function defaultLayout(kind: LayoutKind): Layout {
  if (kind === "normal" && IS_POP) return {};
  if (kind === "dockh") {
    const row = (x: number, w: number) => ({ x, y: 0, w, h: 1, on: true });
    return {
      spectrum: row(0, 8), loudness: row(8, 5), levels: row(13, 2), stereo: row(15, 3), scope: row(18, 3), spectrogram: row(21, 3),
      tract: { x: 0, y: 0, w: 3, h: 1, on: false }, vowelmap: { x: 0, y: 0, w: 3, h: 1, on: false }, pitch: { x: 0, y: 0, w: 4, h: 1, on: false }, waveform: { x: 0, y: 0, w: 6, h: 1, on: false }, dynamics: { x: 0, y: 0, w: 2, h: 1, on: false }, transient: { x: 0, y: 0, w: 4, h: 1, on: false }, stereobands: { x: 0, y: 0, w: 3, h: 1, on: false }, player: { x: 0, y: 0, w: 6, h: 1, on: false }, variation: { x: 0, y: 0, w: 5, h: 1, on: false }, subtitles: { x: 0, y: 0, w: 6, h: 1, on: false }, emoji: { x: 0, y: 0, w: 2, h: 1, on: false }, punch: { x: 0, y: 0, w: 5, h: 1, on: false },
    };
  }
  if (kind === "dockv") {
    const col = (y: number, h: number) => ({ x: 0, y, w: 1, h, on: true });
    return {
      spectrum: col(0, 6), loudness: col(6, 6), levels: col(12, 4), stereo: col(16, 4), scope: col(20, 4),
      spectrogram: { x: 0, y: 0, w: 1, h: 4, on: false }, tract: { x: 0, y: 0, w: 1, h: 4, on: false }, vowelmap: { x: 0, y: 0, w: 1, h: 4, on: false }, pitch: { x: 0, y: 0, w: 1, h: 4, on: false }, waveform: { x: 0, y: 0, w: 1, h: 4, on: false }, dynamics: { x: 0, y: 0, w: 1, h: 4, on: false }, transient: { x: 0, y: 0, w: 1, h: 4, on: false }, stereobands: { x: 0, y: 0, w: 1, h: 4, on: false }, player: { x: 0, y: 0, w: 1, h: 4, on: false }, variation: { x: 0, y: 0, w: 1, h: 5, on: false }, subtitles: { x: 0, y: 0, w: 1, h: 4, on: false }, emoji: { x: 0, y: 0, w: 1, h: 3, on: false }, punch: { x: 0, y: 0, w: 1, h: 5, on: false },
    };
  }
  // Default arrangement = the author's own layout, baked 2026-11-13 from the running app
  // (사용자: "지금 내가 배치해둔 레이아웃을 기본 레이아웃으로"). Modules the user had off stay off.
  return {
    spectrum: { x: 0, y: 0, w: 10, h: 7, on: true },
    loudness: { x: 10, y: 0, w: 11, h: 7, on: true },
    levels: { x: 21, y: 0, w: 3, h: 7, on: true },
    scope: { x: 12, y: 16, w: 3, h: 7, on: true },
    spectrogram: { x: 0, y: 7, w: 7, h: 9, on: true },
    stereo: { x: 7, y: 7, w: 4, h: 9, on: true },
    tract: { x: 11, y: 7, w: 4, h: 9, on: true },
    vowelmap: { x: 15, y: 7, w: 4, h: 9, on: true },
    pitch: { x: 19, y: 7, w: 5, h: 9, on: true },
    waveform: { x: 0, y: 16, w: 12, h: 7, on: true },
    dynamics: { x: 12, y: 23, w: 3, h: 7, on: true },
    stereobands: { x: 15, y: 16, w: 4, h: 7, on: true },
    transient: { x: 19, y: 16, w: 5, h: 7, on: true },
    player: { x: 0, y: 23, w: 12, h: 7, on: true },
    variation: { x: 15, y: 23, w: 9, h: 7, on: true },
    subtitles: { x: 0, y: 30, w: 12, h: 7, on: true },
    emoji: { x: 20, y: 30, w: 4, h: 7, on: true },
    punch: { x: 12, y: 30, w: 8, h: 7, on: true },
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
  sourceMode: "auto", device: null, loudnessTarget: -14, levelMode: "peak", dock: "none", dockSize: 200, opacity: 100, alwaysOnTop: false, placeMode: "free", opacityMode: "bg", modules: {},
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

/** Columns / rows added by the edit-mode "+" buttons (per layout key, persisted). */
export function gridExtra(kind: LayoutKind): { cols: number; rows: number } {
  const v = load<{ cols: number; rows: number }>(`${LAYOUT_KEYS[kind]}.extra`, { cols: 0, rows: 0 });
  return { cols: Math.max(0, v.cols | 0), rows: Math.max(0, v.rows | 0) };
}
export function setGridExtra(kind: LayoutKind, v: { cols: number; rows: number }) {
  try { localStorage.setItem(`${LAYOUT_KEYS[kind]}.extra`, JSON.stringify({ cols: Math.max(0, v.cols | 0), rows: Math.max(0, v.rows | 0) })); } catch { /* ignore */ }
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

/** Listeners for settings changed by another window (see the `storage` sync below). */
const settingsListeners: (() => void)[] = [];
export function onSettingsSynced(fn: () => void) { settingsListeners.push(fn); }

// Another window of this app wrote the shared settings: take them over in place so the
// modules (which read `settings` live) and the toolbar see the change, and this window's
// next save doesn't clobber it with a stale copy.
try {
  window.addEventListener("storage", (e) => {
    if (e.key !== SETTINGS_KEY || !e.newValue) return;
    try {
      const s = JSON.parse(e.newValue) as Partial<Settings>;
      Object.assign(settings, s);
      if (!settings.modules || typeof settings.modules !== "object") settings.modules = {};
      for (const fn of settingsListeners) fn();
    } catch { /* ignore */ }
  });
} catch { /* no window (tests) */ }
