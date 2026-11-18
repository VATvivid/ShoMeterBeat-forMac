// Frameless main window (창 ▾ "테두리 없는 창"): no OS title bar, frame or shadow, so with
// 빈 영역 0 % only the tiles and the toolbar remain on the desktop. The toolbar becomes the
// drag area (double-click = maximize), window buttons (– □ ✕) appear at its right end and
// thin invisible strips along the other edges resize the window. Docked mode is frameless
// anyway and handles its own geometry (dock.ts); this only applies while undocked.
import { inTauri } from "./engine/source";
import { saveSettings, settings } from "./state";

type Dir = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

async function win() {
  const m = await import("@tauri-apps/api/window");
  return m.getCurrentWindow();
}

/** Applies the frame setting to the window (no-op while docked). */
export async function applyFrame() {
  const on = settings.frameless && settings.dock === "none";
  document.body.classList.toggle("frameless", on);
  if (!inTauri || settings.dock !== "none") return;
  const w = await win();
  await w.setDecorations(!on).catch(() => {});
  await w.setShadow(!on).catch(() => {});
}

export async function setFrameless(on: boolean) {
  settings.frameless = on;
  saveSettings();
  await applyFrame();
}

/**
 * The toolbar is the window's drag handle only while undocked. A docked window is pinned to a screen
 * edge, so dragging the toolbar used to pull the whole strip off the dock (2026-11-18 사용자: 도킹
 * 모드에서 상단 드래그하면 떨어진다). Called from applyDock whenever the dock mode changes.
 */
export function updateToolbarDrag() {
  const toolbar = document.getElementById("toolbar");
  if (!toolbar) return;
  if (settings.dock === "none") toolbar.setAttribute("data-tauri-drag-region", "");
  else toolbar.removeAttribute("data-tauri-drag-region");
}

/** Builds the window buttons and edge grips once (shown only with body.frameless). */
export function installFrameless() {
  if (document.getElementById("win-ctl")) return;
  const toolbar = document.getElementById("toolbar")!;
  updateToolbarDrag();
  const ctl = document.createElement("div");
  ctl.id = "win-ctl";
  const mk = (txt: string, title: string, fn: () => void, cls = "") => {
    const b = document.createElement("button");
    b.className = `btn icon win-ctl-btn ${cls}`; b.textContent = txt; b.title = title;
    b.addEventListener("click", fn);
    ctl.appendChild(b);
  };
  mk("–", "최소화", () => { win().then((w) => w.minimize()).catch(() => {}); });
  mk("□", "최대화 / 이전 크기", () => { win().then((w) => w.toggleMaximize()).catch(() => {}); });
  mk("✕", "닫기", () => { win().then((w) => w.close()).catch(() => {}); }, "close");
  toolbar.appendChild(ctl);
  const edges: [string, Dir][] = [["w", "West"], ["e", "East"], ["s", "South"], ["sw", "SouthWest"], ["se", "SouthEast"], ["n", "North"], ["nw", "NorthWest"], ["ne", "NorthEast"]];
  for (const [cls, dir] of edges) {
    const g = document.createElement("div");
    g.className = `edge-grip ${cls}`;
    g.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      win().then((w) => w.startResizeDragging(dir)).catch(() => {});
    });
    document.body.appendChild(g);
  }
  // the window starts undecorated (tauri.conf.json); put the frame back if the user turned frameless off
  applyFrame().catch(() => {});
}
