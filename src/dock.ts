// Dock mode: pin the window to a screen edge as one strip (MiniMeters-style).
// Uses the Tauri window API when available; in the browser preview only the layout
// kind changes.
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./engine/source";
import { layoutKindFor, saveSettings, settings, type DockMode } from "./state";

interface Saved { x: number; y: number; w: number; h: number }
const SAVED_KEY = "rm.undock.v1";

async function win() {
  const m = await import("@tauri-apps/api/window");
  return { api: m, w: m.getCurrentWindow() };
}

export async function applyDock(mode: DockMode) {
  settings.dock = mode;
  saveSettings();
  document.body.classList.toggle("docked", mode !== "none");
  document.body.dataset.dock = mode;
  if (!inTauri) return;
  const { api, w } = await win();
  if (mode === "none") {
    await invoke("set_appbar", { edge: null, thickness: 0 }).catch(() => {});
    await w.setMinSize(new api.LogicalSize(640, 400)).catch(() => {});
    await w.setAlwaysOnTop(settings.alwaysOnTop);
    await w.setDecorations(true);
    try {
      const s = JSON.parse(localStorage.getItem(SAVED_KEY) || "null") as Saved | null;
      if (s) {
        await w.setPosition(new api.PhysicalPosition(s.x, s.y));
        await w.setSize(new api.PhysicalSize(s.w, s.h));
      }
    } catch { /* ignore */ }
    return;
  }
  // Remember the free-window geometry once, before the first dock.
  if (!document.body.dataset.wasDocked) {
    try {
      const p = await w.outerPosition(), s = await w.outerSize();
      localStorage.setItem(SAVED_KEY, JSON.stringify({ x: p.x, y: p.y, w: s.width, h: s.height }));
    } catch { /* ignore */ }
    document.body.dataset.wasDocked = "1";
  }
  const mon = await api.currentMonitor();
  if (!mon) return;
  const scale = mon.scaleFactor || 1;
  const wa = (mon as unknown as { workArea?: { position: { x: number; y: number }; size: { width: number; height: number } } }).workArea
    ?? { position: mon.position, size: mon.size };
  const thick = Math.round(settings.dockSize * scale);
  let x = wa.position.x, y = wa.position.y, width = wa.size.width, height = wa.size.height;
  if (mode === "top") height = thick;
  else if (mode === "bottom") { y = wa.position.y + wa.size.height - thick; height = thick; }
  else if (mode === "left") width = thick;
  else { x = wa.position.x + wa.size.width - thick; width = thick; }
  // Reserve the edge as an AppBar (Windows): other windows then keep clear of the strip,
  // and the shell hands back the exact rect to use (already clear of the taskbar).
  const edge = { left: 0, top: 1, right: 2, bottom: 3 }[mode];
  const rc = await invoke<[number, number, number, number] | null>("set_appbar", { edge, thickness: thick }).catch(() => null);
  if (rc) { x = rc[0]; y = rc[1]; width = rc[2] - rc[0]; height = rc[3] - rc[1]; }
  await w.setMinSize(null).catch(() => {}); // the strip may be thinner than the normal minimum
  await w.setDecorations(false);
  await w.setAlwaysOnTop(true);
  await w.setSize(new api.PhysicalSize(width, height));
  await w.setPosition(new api.PhysicalPosition(x, y));
  // Undecorated windows can land a few px off (frame compensation): measure and nudge once.
  try {
    const p = await w.outerPosition(), s = await w.outerSize();
    const dx = x - p.x, dy = y - p.y, dw = width - s.width, dh = height - s.height;
    if (dx || dy) await w.setPosition(new api.PhysicalPosition(x + dx, y + dy));
    if (dw || dh) await w.setSize(new api.PhysicalSize(width + dw, height + dh));
  } catch { /* ignore */ }
}

/** Startup while undocked: make sure no AppBar reservation lingers from an earlier session of this process. */
export async function releaseDockReservation() {
  if (!inTauri) return;
  await invoke("set_appbar", { edge: null, thickness: 0 }).catch(() => {});
}

export function dockLayoutKind() {
  return layoutKindFor(settings.dock);
}
