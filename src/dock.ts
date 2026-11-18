// Dock mode: pin the window to a screen edge as one strip (MiniMeters-style).
// Uses the Tauri window API when available; in the browser preview only the layout
// kind changes.
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./engine/source";
import { updateToolbarDrag } from "./frameless";
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
  updateToolbarDrag(); // docked windows are pinned — the toolbar must not drag the window off the edge
  if (!inTauri) return;
  const { api, w } = await win();
  if (mode === "none") {
    await invoke("dock_unpin").catch(() => {}); // release the pin so the window can return to its free spot
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
  // Pin the window to the reserved rect: dock_pin positions it atomically AND installs a guard that
  // holds it there against the shell's work-area reposition when the reservation changes (2026-11-18
  // 사용자: 늘린 만큼 여백 할당·붕 뜸).
  await invoke("dock_pin", { x, y, w: width, h: height }).catch(() => {});
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
  grip.addEventListener("pointerdown", async (e) => {
    if (settings.dock === "none" || e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const mode = settings.dock;
    const start = settings.dockSize;
    // Screen coordinates, not clientX/Y: the window resizes and moves under the pointer while the
    // strip grows, so clientX/Y (relative to the moving window) barely changed and the strip grew far
    // less than the pointer travelled (2026-11-18 사용자: 드래그해서 키운 만큼 안 커져).
    const sx = e.screenX, sy = e.screenY;
    // Anchor to the CURRENT window rect, not the monitor work area: once docked, the AppBar
    // reservation has already shrunk the work area by this strip's own thickness, so the work area's
    // far edge is the top of the strip, not the screen edge — anchoring to it left a gap below the
    // strip and the strip drifted / popped out of the dock while resizing (2026-11-18 사용자: 아래
    // 여백·독에서 떨어져 나옴). The live resize is a plain setSize/setPosition; the AppBar is
    // re-registered once at the end (applyDock), which snaps to the exact reserved rect.
    let geo: { x: number; y: number; w: number; h: number; scale: number } | null = null;
    let handle: Awaited<ReturnType<typeof win>> | null = null;
    if (inTauri) {
      try {
        handle = await win();
        const [p0, s0, scale] = await Promise.all([handle.w.outerPosition(), handle.w.outerSize(), handle.w.scaleFactor()]);
        geo = { x: p0.x, y: p0.y, w: s0.width, h: s0.height, scale: scale || 1 };
      } catch { /* fall back to the end-of-drag applyDock */ }
    }
    // The strip's physical rect for a thickness, anchored to the current window's far / near edge.
    const rectFor = (thick: number) => {
      let x = geo!.x, y = geo!.y, width = geo!.w, height = geo!.h;
      if (mode === "top") height = thick;
      else if (mode === "bottom") { y = geo!.y + geo!.h - thick; height = thick; }
      else if (mode === "left") width = thick;
      else { x = geo!.x + geo!.w - thick; width = thick; }
      return { x, y, w: width, h: height };
    };
    let busy = false, dirty = false, released = false;
    const liveResize = async () => {
      if (!geo || !handle || released) return;
      if (busy) { dirty = true; return; }
      busy = true;
      // dock_pin positions the window atomically and updates the guard rect, so the shell can never
      // pull it off the pinned spot while resizing (2026-11-18).
      await invoke("dock_pin", rectFor(Math.round(settings.dockSize * geo.scale))).catch(() => {});
      busy = false;
      if (dirty && !released) { dirty = false; void liveResize(); }
    };
    const move = (ev: PointerEvent) => {
      // the inner edge follows the pointer: a top strip grows downward, a bottom strip upward, etc.
      const d = mode === "top" ? ev.screenY - sy : mode === "bottom" ? sy - ev.screenY : mode === "left" ? ev.screenX - sx : sx - ev.screenX;
      const next = Math.max(48, Math.min(900, Math.round(start + d)));
      if (next !== settings.dockSize) { settings.dockSize = next; void liveResize(); }
    };
    const up = async (ev: PointerEvent) => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      try { grip.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      released = true; // stop any queued live-resize frame from firing after this
      saveSettings();
      // Now update the AppBar reservation to the new thickness so other windows reflow to the resized
      // strip (2026-11-18 사용자: 늘린 만큼 여백 할당이 바뀌어야). Changing the reservation makes the
      // shell try to pull our window into the shrunk work area, but the dock_pin guard (lib.rs) holds
      // it on the pinned rect, so there is no float — measured via CDP.
      if (!inTauri || !geo || !handle) { applyDock(mode).catch(() => {}); return; }
      const thick = Math.round(settings.dockSize * geo.scale);
      const edge = { left: 0, top: 1, right: 2, bottom: 3 }[mode];
      await invoke("dock_pin", rectFor(thick)).catch(() => {});
      await invoke("set_appbar", { edge, thickness: thick }).catch(() => {});
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
}

/** Startup while undocked: make sure no AppBar reservation lingers from an earlier session of this process. */
export async function releaseDockReservation() {
  if (!inTauri) return;
  await invoke("dock_unpin").catch(() => {});
  await invoke("set_appbar", { edge: null, thickness: 0 }).catch(() => {});
}

export function dockLayoutKind() {
  return layoutKindFor(settings.dock);
}
