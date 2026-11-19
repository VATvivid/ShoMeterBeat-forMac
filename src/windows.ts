// Multi-window: pop-out windows (frameless, modules only), always-on-top, opacity,
// "find my windows" flash, and moving tiles between windows by drag.
//
// Every window runs the same bundle (`index.html?win=<label>`); localStorage is shared,
// so the window that opens a pop-out writes the pop-out's layout first and the new
// window simply loads it. The list of pop-outs (geometry, pin, opacity) lives in
// `rm.popwins.v1` and is re-read before every change (other windows may have written it).
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { inTauri } from "./engine/source";
import type { Grid, Rect } from "./layout/grid";
import { titleOf } from "./modules";
import { IS_POP, onSettingsSynced, popLayoutKey, saveSettings, settings, WIN_LABEL, type Layout } from "./state";

export interface PopWin { label: string; x: number; y: number; w: number; h: number; pinned: boolean; opacity: number }
const KEY = "rm.popwins.v1";
/** Pointer this far outside the window (CSS px) counts as "dropped on nothing" → new pop-out. */
export const OUTSIDE_MARGIN = 16;

export function loadPops(): PopWin[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function savePops(list: PopWin[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
export function popEntry(label: string): PopWin | undefined { return loadPops().find((p) => p.label === label); }
/** Drops a pop-out from the list and deletes its layout key (the window itself is closed by the caller). */
export function forgetPop(label: string) {
  try { localStorage.removeItem(popLayoutKey(label)); } catch { /* ignore */ }
  savePops(loadPops().filter((p) => p.label !== label));
}
export function updatePop(label: string, patch: Partial<PopWin>) {
  const list = loadPops();
  const e = list.find((p) => p.label === label);
  if (e) { Object.assign(e, patch); savePops(list); }
}
/** Module ids + rects a pop-out shows (from its layout key). */
export function popModules(label: string): { id: string; w: number; h: number }[] {
  try {
    const l = JSON.parse(localStorage.getItem(popLayoutKey(label)) || "{}") as Layout;
    return Object.entries(l).filter(([, r]) => r.on).map(([id, r]) => ({ id, w: r.w, h: r.h }));
  } catch { return []; }
}
export function popTitle(label: string, index: number): string {
  const mods = popModules(label).map((m) => titleOf(m.id).replace(/\s*\((?!\d)[^)]*\)$/, ""));
  return `창 ${index + 1}${mods.length ? ` — ${mods.join(", ")}` : " (비어 있음)"}`;
}

async function tauriWindow() {
  const m = await import("@tauri-apps/api/window");
  return { api: m, w: m.getCurrentWindow() };
}

/** Opens a pop-out window showing `modules` (stacked). Geometry in CSS/logical px. */
export async function createPop(opts: { modules: { id: string; w: number; h: number }[]; x?: number; y?: number; width?: number; height?: number; pinned?: boolean; opacity?: number }): Promise<string> {
  const label = `pop-${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`;
  const layout: Layout = {};
  let y = 0;
  for (const m of opts.modules) { layout[m.id] = { x: 0, y, w: Math.max(3, m.w), h: Math.max(3, m.h), on: true }; y += Math.max(3, m.h); }
  try { localStorage.setItem(popLayoutKey(label), JSON.stringify(layout)); } catch { /* ignore */ }
  const { api } = await tauriWindow();
  const scale = (await api.getCurrentWindow().scaleFactor().catch(() => 1)) || 1;
  const width = Math.max(220, Math.round(opts.width ?? 520)), height = Math.max(140, Math.round(opts.height ?? 340));
  let x = opts.x, yy = opts.y;
  if (x === undefined || yy === undefined) {
    // Next to the current window, offset per open pop-out so they don't stack exactly.
    const p = await api.getCurrentWindow().outerPosition().catch(() => new api.PhysicalPosition(80, 80));
    const n = loadPops().length;
    x = p.x / scale + 60 + n * 28; yy = p.y / scale + 60 + n * 28;
  }
  const entry: PopWin = { label, x: Math.round(x * scale), y: Math.round(yy * scale), w: Math.round(width * scale), h: Math.round(height * scale), pinned: opts.pinned ?? false, opacity: opts.opacity ?? 100 };
  savePops([...loadPops(), entry]);
  await openPopWindow(entry);
  return label;
}

async function openPopWindow(e: PopWin) {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const { api } = await tauriWindow();
  const scale = (await api.getCurrentWindow().scaleFactor().catch(() => 1)) || 1;
  const win = new WebviewWindow(e.label, {
    url: `index.html?win=${encodeURIComponent(e.label)}`,
    title: "ShowMeterBeat 창",
    x: e.x / scale, y: e.y / scale, width: e.w / scale, height: e.h / scale,
    minWidth: 160, minHeight: 100,
    decorations: false, alwaysOnTop: e.pinned, theme: "dark", focus: true, transparent: true,
    // Test hook: a verification build may set this so pop-outs share the main window's WebView2 flags (remote debugging).
    ...(localStorage.getItem("rm.debug.browserArgs") ? { additionalBrowserArgs: localStorage.getItem("rm.debug.browserArgs")! } : {}),
  });
  await new Promise<void>((resolve) => {
    win.once("tauri://created", () => resolve());
    win.once("tauri://error", (err) => { console.error("pop-out window error", err); resolve(); });
  });
}

/** Re-opens the pop-outs saved from the last session (main window start-up). */
export async function restorePops() {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  for (const e of loadPops()) {
    if (await WebviewWindow.getByLabel(e.label)) continue;
    await openPopWindow(e).catch((err) => console.error(err));
  }
}

// ---- preset support: capture / restore the whole pop-out set + the main window's rect ----------
export interface PopSnapshot { entry: PopWin; layout: Layout }
export interface WinBounds { x: number; y: number; w: number; h: number }

/** Every open pop-out as (geometry + the module layout it shows), for saving into a preset. */
export function capturePops(): PopSnapshot[] {
  return loadPops().map((e) => {
    let layout: Layout = {};
    try { layout = JSON.parse(localStorage.getItem(popLayoutKey(e.label)) || "{}") as Layout; } catch { /* ignore */ }
    return { entry: { ...e }, layout };
  });
}

/** Destroys every pop-out window and clears the list + their layout keys (no merge into a grid). */
export async function closeAllPops() {
  if (!inTauri) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  for (const e of loadPops()) {
    const w = await WebviewWindow.getByLabel(e.label);
    await w?.destroy().catch(() => {});
    try { localStorage.removeItem(popLayoutKey(e.label)); } catch { /* ignore */ }
  }
  savePops([]);
}

/** Replaces the current pop-outs with a preset's set (fresh labels, same geometry + modules). */
export async function applyPops(snaps: PopSnapshot[]) {
  if (!inTauri) return;
  await closeAllPops();
  const list: PopWin[] = [];
  snaps.forEach((s, i) => {
    const label = `pop-${Date.now().toString(36)}${i}${Math.floor(Math.random() * 1e3)}`;
    try { localStorage.setItem(popLayoutKey(label), JSON.stringify(s.layout)); } catch { /* ignore */ }
    list.push({ ...s.entry, label });
  });
  savePops(list);
  for (const e of list) await openPopWindow(e).catch((err) => console.error(err));
}

/** This (main) window's outer rect in physical px, for saving into a preset. */
export async function captureWindowBounds(): Promise<WinBounds | null> {
  if (!inTauri || IS_POP) return null;
  try {
    const { w } = await tauriWindow();
    const p = await w.outerPosition();
    const s = await w.outerSize();
    return { x: p.x, y: p.y, w: s.width, h: s.height };
  } catch { return null; }
}

/** Moves/sizes the main window to a saved rect (physical px). Caller gates this on dock === "none". */
export async function applyWindowBounds(b: WinBounds | null | undefined) {
  if (!inTauri || IS_POP || !b) return;
  await invoke("set_window_rect", { x: b.x, y: b.y, w: b.w, h: b.h }).catch((e) => console.error(e));
}

/** Closes a pop-out and brings its modules back into this (main) grid, appended. */
export async function closePop(label: string, grid: Grid) {
  for (const m of popModules(label)) grid.add(m.id, m.w, m.h);
  forgetPop(label);
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const w = await WebviewWindow.getByLabel(label);
  // destroy(): skips the close-requested round trip (the pop-out would ask us again).
  await w?.destroy().catch(() => w?.close());
}

/** Blink the outline of every window twice (main toolbar "창 찾기"). */
export async function flashAll() {
  if (inTauri) await emit("rm://flash", {}).catch(() => flashHere());
  else flashHere();
}
export function flashHere() {
  let ring = document.getElementById("flash-ring");
  if (!ring) { ring = document.createElement("div"); ring.id = "flash-ring"; document.body.appendChild(ring); }
  ring.classList.remove("on");
  void ring.offsetWidth; // restart the animation
  ring.classList.add("on");
  ring.addEventListener("animationend", () => ring!.classList.remove("on"), { once: true });
}

export async function setAlwaysOnTop(on: boolean) {
  if (!inTauri) return;
  const { w } = await tauriWindow();
  await w.setAlwaysOnTop(on);
}

/** 투명도 in percent (100 = opaque). "bg" mode fades only the backgrounds (CSS --bg-alpha on a
 *  transparent window; text and plots stay sharp); "window" mode fades the whole window
 *  (WS_EX_LAYERED). 0 is applied as a faint 3 % in window mode so the window stays clickable. */
export async function applyOpacity(pct: number) {
  const p = Math.max(0, Math.min(100, pct));
  // the empty area (html/body behind the tiles) has its own alpha — `settings.gridOpacity`,
  // null = same as the tiles — so the unused grid can vanish while the tiles stay readable
  const g = settings.gridOpacity === null ? p : Math.max(0, Math.min(100, settings.gridOpacity));
  if (settings.opacityMode === "window") {
    document.documentElement.style.setProperty("--bg-alpha", "1");
    document.documentElement.style.setProperty("--grid-alpha", "1");
    if (!inTauri) return;
    await invoke("set_opacity", { alpha: Math.max(0.03, p / 100) }).catch((e) => console.error(e));
  } else {
    document.documentElement.style.setProperty("--bg-alpha", String(p / 100));
    document.documentElement.style.setProperty("--grid-alpha", String(g / 100));
    if (!inTauri) return;
    await invoke("set_opacity", { alpha: 1 }).catch((e) => console.error(e));
  }
}

/** This window's saved pin/opacity (main: settings; pop-out: its list entry). */
export function windowPrefs(): { pinned: boolean; opacity: number } {
  if (IS_POP) { const e = popEntry(WIN_LABEL); return { pinned: e?.pinned ?? false, opacity: e?.opacity ?? 100 }; }
  return { pinned: settings.alwaysOnTop, opacity: settings.opacity };
}
export function saveWindowPrefs(p: Partial<{ pinned: boolean; opacity: number }>) {
  if (IS_POP) updatePop(WIN_LABEL, p);
  else { if (p.pinned !== undefined) settings.alwaysOnTop = p.pinned; if (p.opacity !== undefined) settings.opacity = p.opacity; saveSettings(); }
}

/** Common per-window wiring: flash listener, cross-window tile drag, saved pin/opacity. */
export function initWindowing(grid: Grid) {
  if (!inTauri) return;
  listen("rm://flash", () => flashHere()).catch(() => {});
  const prefs = windowPrefs();
  if (prefs.opacity < 100) applyOpacity(prefs.opacity);
  onSettingsSynced(() => { const p = windowPrefs(); applyOpacity(p.opacity); });
  if (!IS_POP && prefs.pinned && settings.dock === "none") setAlwaysOnTop(true);

  // Tiles dragged in from another window (events from the Rust side, see lib.rs).
  // The Rust side targets the window under the pointer (emit_to); the `to` label is checked
  // again here so a broadcast can never make another window (e.g. main) add the module too.
  type XDragEv = { module: string; x: number; y: number; w: number; h: number; from: string; to?: string };
  const mine = (p: XDragEv) => !p.to || p.to === WIN_LABEL;
  listen<XDragEv>("rm://xdrag-over", (e) => {
    if (!mine(e.payload)) return;
    grid.setExternalGhost({ w: e.payload.w, h: e.payload.h, clientX: e.payload.x, clientY: e.payload.y });
  }).catch(() => {});
  listen("rm://xdrag-leave", () => grid.setExternalGhost(null)).catch(() => {});
  listen<XDragEv>("rm://xdrag-drop", (e) => {
    if (!mine(e.payload)) return;
    grid.setExternalGhost(null);
    grid.add(e.payload.module, e.payload.w, e.payload.h, e.payload.x, e.payload.y);
  }).catch(() => {});

  // Modules sent by menu from another window.
  listen<{ to: string; id: string; w: number; h: number }>("rm://add-module", (e) => {
    if (e.payload.to === WIN_LABEL) grid.add(e.payload.id, e.payload.w, e.payload.h);
  }).catch(() => {});
  if (!IS_POP) listen<{ id: string; w: number; h: number }>("rm://to-main", (e) => grid.add(e.payload.id, e.payload.w, e.payload.h)).catch(() => {});

  grid.onXDrag = {
    hover(id, rect, x, y) { invoke("drag_hover", { module: id, x, y, w: rect.w, h: rect.h }).catch(() => {}); },
    leave() { invoke("drag_leave").catch(() => {}); },
    async drop(id: string, rect: Rect, px, x, y) {
      const target = await invoke<string | null>("drag_drop", { module: id, x, y, w: rect.w, h: rect.h });
      if (target) return true;
      // Over none of our windows: only clearly outside counts — open a new pop-out there.
      const far = x < -OUTSIDE_MARGIN || y < -OUTSIDE_MARGIN || x > window.innerWidth + OUTSIDE_MARGIN || y > window.innerHeight + OUTSIDE_MARGIN;
      if (!far) return false;
      const [sx, sy] = await invoke<[number, number]>("to_screen", { x, y });
      const { w } = await tauriWindow();
      const scale = (await w.scaleFactor().catch(() => 1)) || 1;
      await createPop({ modules: [{ id, w: rect.w, h: rect.h }], x: sx / scale - px.w / 2, y: sy / scale - 12, width: px.w, height: px.h + 10 });
      return true;
    },
  };

  // "별도 창으로 보내기" in every tile menu.
  grid.extraMenu = (id) => {
    const r = grid.layout[id];
    const rows = [{ label: "새 별도 창으로 보내기", onClick: () => { createPop({ modules: [{ id, w: r.w, h: r.h }] }).then(() => grid.remove(id)).catch((e) => console.error(e)); } }];
    loadPops().forEach((p, i) => {
      if (p.label === WIN_LABEL) return;
      rows.push({ label: `${popTitle(p.label, i)} 으로 보내기`, onClick: () => { sendToPop(p.label, id, r.w, r.h); grid.remove(id); } });
    });
    if (IS_POP) rows.push({ label: "메인 창으로 보내기", onClick: () => { emit("rm://to-main", { id, w: r.w, h: r.h }).catch(() => {}); grid.remove(id); } });
    return rows;
  };
}

/** Appends a module to an open pop-out (it adds the tile itself). */
export function sendToPop(label: string, id: string, w: number, h: number) {
  emit("rm://add-module", { to: label, id, w, h }).catch(() => {});
}
