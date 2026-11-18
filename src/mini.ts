// Cozy mini: a dedicated tiny window — the Cozy module in 미니 mode on a transparent,
// frameless, always-on-top, taskbar-less window parked at the bottom of the screen
// (Bongo-Cat style: nothing behind the pet, it sits straight on the desktop). It is not a
// pop-out: no bar, no layout editing, no module hand-back. Position and open/closed state persist
// (`rm.mini.v1`) so it comes back with the app.
//
// Clicks pass through (2026-11-18 사용자: 미니가 있는 영역에서 클릭을 방해): a transparent WebView2
// window takes the mouse over its whole rectangle, so the window ignores the cursor by default and the
// desktop below gets every click. Since it then never sees the mouse, the cursor position is polled
// (30 Hz while the mini is open) — near the window the ✎ (edit) and ✕ buttons fade in, and while the
// cursor is on them the window takes the mouse again so they can be clicked. ✎ turns on edit mode
// (outline; drag to move, right-click for settings, the corner grip resizes); ✎ again, Esc or 15 s
// without touching it ends it. Over the picture a dithered hole opens around the cursor so what is
// underneath shows through (`miniPointer`, drawn by the Cozy module).
import type { Grid } from "./layout/grid";
import { inTauri } from "./engine/source";
import { modSetting, popLayoutKey, WIN_LABEL, type Layout } from "./state";

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
/**
 * Transparency of the mini picture, 0–90 % (2026-11-18 사용자: 미니 모드 투명도 슬라이더) — the Cozy
 * setting `miniFade`; the ✎ ✕ buttons and the edit outline stay fully visible.
 */
export function applyMiniFade(pct = modSetting("cozy", "miniFade", 0)) {
  const g = document.getElementById("grid");
  // while the cursor is over the window (not editing) the picture goes at least 30 % see-through
  // (2026-11-18 사용자: 마우스가 올라가면 투명도 30 %, 벗어나면 복구, 보간·페이드) — the change itself
  // eases through the CSS transition on #grid (style.css)
  const p = hovering ? Math.max(pct, HOVER_FADE) : pct;
  if (g) g.style.opacity = String(1 - Math.max(0, Math.min(90, p)) / 100);
}
const HOVER_FADE = 30;
let hovering = false;

/** Cursor in mini-window CSS px and the dither-hole strength (0..1), read by the Cozy module. */
export const miniPointer = { x: -1, y: -1, hole: 0 };

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
  applyMiniFade();
  const bar = document.createElement("div");
  bar.className = "mini-ctl";
  const edit = document.createElement("button");
  edit.className = "btn icon mini-edit";
  edit.title = "편집 (이동 · 우클릭 설정 · 크기 조절)";
  edit.textContent = "✎";
  const close = document.createElement("button");
  close.className = "btn icon mini-close";
  close.title = "코지 미니 닫기";
  close.textContent = "✕";
  for (const b of [edit, close]) b.addEventListener("pointerdown", (e) => e.stopPropagation());
  close.addEventListener("click", () => closeMini());
  bar.append(edit, close);
  document.body.appendChild(bar);
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
  // edit mode: only then the tile is the drag region (Tauri starts a window drag on mousedown there)
  let editing = false;
  let lastTouch = 0;
  const markDrag = () => document.querySelectorAll<HTMLElement>(".tile-body canvas, .tile-body").forEach((el) => {
    if (editing) el.setAttribute("data-tauri-drag-region", ""); else el.removeAttribute("data-tauri-drag-region");
  });
  const setEditing = (on: boolean) => {
    editing = on; lastTouch = performance.now();
    document.body.classList.toggle("mini-editing", on);
    edit.classList.toggle("on", on);
    markDrag();
  };
  edit.addEventListener("click", () => setEditing(!editing));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && editing) setEditing(false); });
  for (const ev of ["pointerdown", "pointermove", "contextmenu", "wheel"]) document.addEventListener(ev, () => { lastTouch = performance.now(); }, true);
  markDrag();
  grid.onChange = markDrag;
  setTimeout(markDrag, 50);
  if (!inTauri) return;
  // click-through + cursor polling (see the header)
  import("@tauri-apps/api/window").then(({ getCurrentWindow, cursorPosition }) => {
    const w = getCurrentWindow();
    let ignoring: boolean | null = null;
    let geom = { x: 0, y: 0, w: 1, h: 1, scale: 1 };
    let geomAt = 0;
    let busy = false;
    const setIgnore = (v: boolean) => {
      if (ignoring === v) return;
      ignoring = v;
      w.setIgnoreCursorEvents(v).catch(() => { ignoring = null; });
    };
    let t0 = performance.now();
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const now = performance.now();
        const dt = Math.min(0.1, (now - t0) / 1000); t0 = now;
        if (now - geomAt > 1000) {
          const [p, sz, sc] = await Promise.all([w.outerPosition(), w.outerSize(), w.scaleFactor()]);
          geom = { x: p.x, y: p.y, w: sz.width, h: sz.height, scale: sc || 1 };
          geomAt = now;
        }
        const c = await cursorPosition();
        const lx = (c.x - geom.x) / geom.scale, ly = (c.y - geom.y) / geom.scale;
        const W = geom.w / geom.scale, H = geom.h / geom.scale;
        const inside = lx >= 0 && ly >= 0 && lx < W && ly < H;
        const onCtl = inside && lx > W - 64 && ly < 30;           // the ✎ ✕ strip (top-right)
        if (editing && now - lastTouch > 15000) setEditing(false);
        document.body.classList.toggle("mini-near", inside || editing);
        const hov = inside && !editing;
        if (hov !== hovering) { hovering = hov; applyMiniFade(); }
        setIgnore(!(editing || onCtl));
        miniPointer.x = lx; miniPointer.y = ly;
        const want = inside && !editing && !onCtl ? 1 : 0;
        miniPointer.hole += (want - miniPointer.hole) * Math.min(1, dt / 0.2);
        if (miniPointer.hole < 0.01 && want === 0) miniPointer.hole = 0;
      } catch { /* window closing */ }
      busy = false;
    };
    window.setInterval(() => { void tick(); }, 33);
    w.onResized(() => { geomAt = 0; }).catch(() => {});
    w.onMoved(() => { geomAt = 0; }).catch(() => {});
  }).catch((e) => console.error(e));
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
