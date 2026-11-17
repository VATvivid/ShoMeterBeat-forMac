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
    await w.setDecorations(!settings.frameless); // frameless.ts: the user may want no OS frame undocked too
    await w.setResizable(true).catch(() => {});
    await w.setShadow(!settings.frameless).catch(() => {});
    document.body.classList.toggle("frameless", settings.frameless);
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
  // An undecorated window with a shadow keeps an invisible 8 px frame on every side (the
  // shadow needs WS_THICKFRAME): the web content was 2544×191 inside a 2560×200 strip and
  // the desktop showed through that frame (2026-11-17 CDP 실측 — "좌우·아래 여백").
  // `setResizable(false)` alone did not remove it; the shadow has to go too. The strip's
  // thickness is changed with the grip, so neither is missed.
  await w.setResizable(false).catch(() => {});
  await w.setShadow(false).catch(() => {});
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

/**
 * Drag grip on the strip's inner edge: dragging it changes the strip thickness
 * (`settings.dockSize`, CSS px) live — the AppBar reservation and window follow
 * (2026-11-17 사용자: 도킹 모드에서 높이/너비 조절). Installed once by the toolbar.
 */
export function installDockGrip() {
  if (document.getElementById("dock-grip")) return;
  const grip = document.createElement("div");
  grip.id = "dock-grip";
  grip.title = "끌어서 띠 두께 조절";
  document.body.appendChild(grip);
  let timer: number | undefined;
  grip.addEventListener("pointerdown", (e) => {
    if (settings.dock === "none" || e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const mode = settings.dock;
    const start = settings.dockSize;
    const sx = e.clientX, sy = e.clientY;
    const apply = () => { clearTimeout(timer); timer = window.setTimeout(() => applyDock(mode).catch(() => {}), 60); };
    const move = (ev: PointerEvent) => {
      // the inner edge follows the pointer: a top strip grows downward, a bottom strip upward, etc.
      const d = mode === "top" ? ev.clientY - sy : mode === "bottom" ? sy - ev.clientY : mode === "left" ? ev.clientX - sx : sx - ev.clientX;
      const next = Math.max(48, Math.min(900, Math.round(start + d)));
      if (next !== settings.dockSize) { settings.dockSize = next; saveSettings(); apply(); }
    };
    const up = (ev: PointerEvent) => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      try { grip.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      clearTimeout(timer);
      applyDock(mode).catch(() => {});
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
}

/** Startup while undocked: make sure no AppBar reservation lingers from an earlier session of this process. */
export async function releaseDockReservation() {
  if (!inTauri) return;
  await invoke("set_appbar", { edge: null, thickness: 0 }).catch(() => {});
}

export function dockLayoutKind() {
  return layoutKindFor(settings.dock);
}
