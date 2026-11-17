// Cozy mini: a dedicated tiny window — the Cozy module in 미니 mode on a transparent,
// frameless, always-on-top, taskbar-less window parked at the bottom of the screen
// (Bongo-Cat style: nothing behind the pet, it sits straight on the desktop). It is not a
// pop-out: no bar, no layout editing, no module hand-back. Drag anywhere to move it,
// right-click for the Cozy settings and 닫기, a ✕ fades in on hover. Position and
// open/closed state persist (`rm.mini.v1`) so it comes back with the app.
import type { Grid } from "./layout/grid";
import { inTauri } from "./engine/source";
import { popLayoutKey, WIN_LABEL, type Layout } from "./state";

export const MINI_LABEL = "mini";
export const IS_MINI = WIN_LABEL === MINI_LABEL;
/** The ordinary Cozy module — same settings everywhere; it draws the corner view because it is in this window. */
export const MINI_MODULE = "cozy";
const KEY = "rm.mini.v1";
/** Default window size (logical px, 5:3 like the scene); the user resizes it with the corner grip. */
const DEFAULT_SIZE = { w: 640, h: 384 };
const MIN_W = 240, MAX_W = 1600;
function miniSize() { const st = miniState(); return st.w && st.h ? { w: st.w, h: st.h } : DEFAULT_SIZE; }

interface MiniState { open: boolean; x?: number; y?: number; w?: number; h?: number }
export function miniState(): MiniState {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") as MiniState; } catch { return { open: false }; }
}
function saveMini(patch: Partial<MiniState>) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...miniState(), ...patch })); } catch { /* ignore */ }
}

async function existing() {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return WebviewWindow.getByLabel(MINI_LABEL);
}

/** Main window: open the mini if it is closed, close it if it is open. Resolves to the new state. */
export async function toggleMini(): Promise<boolean> {
  if (!inTauri) return false;
  const w = await existing();
  if (w) {
    saveMini({ open: false });
    await w.destroy().catch(() => w.close().catch(() => {}));
    return false;
  }
  await openMini();
  return true;
}

export async function openMini() {
  if (!inTauri || (await existing())) return;
  // the mini window's layout: one tile, the whole window
  const layout: Layout = { [MINI_MODULE]: { x: 0, y: 0, w: 1, h: 1, on: true } };
  try { localStorage.setItem(popLayoutKey(MINI_LABEL), JSON.stringify(layout)); } catch { /* ignore */ }
  const api = await import("@tauri-apps/api/window");
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const scale = (await api.getCurrentWindow().scaleFactor().catch(() => 1)) || 1;
  const SIZE = miniSize();
  const st = miniState();
  let x = st.x, y = st.y;
  if (x === undefined || y === undefined) {
    // bottom-right of the work area, flush with the corner above the taskbar
    try {
      const mon = await api.currentMonitor();
      if (mon) {
        const wa = (mon as unknown as { workArea?: { position: { x: number; y: number }; size: { width: number; height: number } } }).workArea ?? { position: mon.position, size: mon.size };
        x = (wa.position.x + wa.size.width) / scale - SIZE.w;
        y = (wa.position.y + wa.size.height) / scale - SIZE.h;
      }
    } catch { /* default placement */ }
  }
  saveMini({ w: SIZE.w, h: SIZE.h });
  const win = new WebviewWindow(MINI_LABEL, {
    url: `index.html?win=${MINI_LABEL}`,
    title: "ShowMeterBeat 코지 미니",
    x, y, width: SIZE.w, height: SIZE.h,
    decorations: false, transparent: true, shadow: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, focus: false, theme: "dark",
    ...(localStorage.getItem("rm.debug.browserArgs") ? { additionalBrowserArgs: localStorage.getItem("rm.debug.browserArgs")! } : {}),
  });
  await new Promise<void>((resolve) => {
    win.once("tauri://created", () => resolve());
    win.once("tauri://error", (err) => { console.error("mini window error", err); resolve(); });
  });
  saveMini({ open: true });
}

/** Main window start-up: bring the mini back if it was open last time. */
export async function restoreMini() {
  if (inTauri && miniState().open) await openMini().catch((e) => console.error(e));
}

/** Inside the mini window: strip everything, make the pet draggable, ✕ on hover, right-click settings. */
export function initMini(grid: Grid) {
  document.title = "ShowMeterBeat 코지 미니";
  document.body.classList.add("mini");
  document.documentElement.classList.add("mini"); // html paints a background of its own — see style.css
  const close = document.createElement("button");
  close.className = "btn icon mini-close";
  close.title = "코지 미니 닫기";
  close.textContent = "✕";
  close.addEventListener("pointerdown", (e) => e.stopPropagation());
  close.addEventListener("click", () => closeMini());
  document.body.appendChild(close);
  grid.extraMenu = () => [{ label: "코지 미니 닫기", onClick: () => closeMini() }];
  // top-left resize grip (the window has no frame of its own): drag it and the window grows
  // towards the top-left while its bottom-right corner — the screen corner — stays put;
  // the 5:3 aspect of the scene is kept (2026-11-17 사용자: 크기는 직접 조절)
  const grip = document.createElement("div");
  grip.id = "mini-resize";
  grip.title = "끌어서 크기 조절";
  document.body.appendChild(grip);
  grip.addEventListener("pointerdown", async (e) => {
    if (e.button !== 0 || !inTauri) return;
    e.preventDefault(); e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    const api = await import("@tauri-apps/api/window");
    const w = api.getCurrentWindow();
    const scale = (await w.scaleFactor().catch(() => 1)) || 1;
    const p0 = await w.outerPosition(), s0 = await w.outerSize();
    const right = p0.x + s0.width, bottom = p0.y + s0.height; // physical px, anchored
    const sx = e.screenX;
    let last = 0, pending: { nw: number; nh: number } | null = null, busy = false;
    const apply = async () => {
      if (busy || !pending) return;
      busy = true;
      const { nw, nh } = pending; pending = null;
      try {
        await w.setSize(new api.PhysicalSize(nw, nh));
        await w.setPosition(new api.PhysicalPosition(right - nw, bottom - nh));
      } catch { /* ignore */ }
      busy = false;
      if (pending) void apply();
    };
    const move = (ev: PointerEvent) => {
      const dx = (ev.screenX - sx) * scale; // pointer moving left = bigger
      const nw = Math.round(Math.max(MIN_W * scale, Math.min(MAX_W * scale, s0.width - dx)));
      pending = { nw, nh: Math.round(nw * 0.6) };
      const now = performance.now();
      if (now - last > 33) { last = now; void apply(); }
    };
    const up = async (ev: PointerEvent) => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      try { grip.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      await apply();
      try {
        const p = await w.outerPosition(), s = await w.outerSize();
        saveMini({ x: p.x / scale, y: p.y / scale, w: s.width / scale, h: s.height / scale });
      } catch { /* ignore */ }
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  // the tile canvases are the drag region (Tauri starts a window drag on mousedown there)
  const markDrag = () => document.querySelectorAll<HTMLElement>(".tile-body canvas, .tile-body").forEach((el) => el.setAttribute("data-tauri-drag-region", ""));
  markDrag();
  grid.onChange = markDrag;
  setTimeout(markDrag, 50);
  if (!inTauri) return;
  import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    const w = getCurrentWindow();
    let timer: number | undefined;
    w.onMoved(() => {
      clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const p = await w.outerPosition();
          const scale = (await w.scaleFactor().catch(() => 1)) || 1;
          saveMini({ x: p.x / scale, y: p.y / scale });
        } catch { /* ignore */ }
      }, 300);
    }).catch(() => {});
    w.onCloseRequested(() => saveMini({ open: false })).catch(() => {});
  }).catch((e) => console.error(e));
}

async function closeMini() {
  saveMini({ open: false });
  if (!inTauri) return;
  // tell the main window (its 🐱 toolbar button) before this window goes away
  await import("@tauri-apps/api/event").then(({ emit }) => emit("rm://mini-state", { open: false })).catch(() => {});
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  await w.destroy().catch(() => w.close().catch(() => {}));
}
