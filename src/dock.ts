// Dock mode: pin the window to a screen edge as one strip (MiniMeters-style).
// Uses the Tauri window API when available; in the browser preview only the layout
// kind changes.
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
    await w.setAlwaysOnTop(false);
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
  await w.setDecorations(false);
  await w.setAlwaysOnTop(true);
  await w.setSize(new api.PhysicalSize(width, height));
  await w.setPosition(new api.PhysicalPosition(x, y));
}

export function dockLayoutKind() {
  return layoutKindFor(settings.dock);
}
