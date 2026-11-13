// Pop-out window chrome: no toolbar or status bar — just the tiles, plus a slim bar that
// slides in when the pointer touches the top edge (drag region, pin, opacity, modules,
// edit, find-windows, close) and a resize grip in the bottom-right corner.
import { emit } from "@tauri-apps/api/event";
import { inTauri } from "./engine/source";
import type { Grid } from "./layout/grid";
import { buildModulesPanel, wireMenu } from "./modulespanel";
import { WIN_LABEL } from "./state";
import { applyOpacity, flashAll, forgetPop, saveWindowPrefs, setAlwaysOnTop, updatePop, windowPrefs } from "./windows";

let closing = false;

export function initPop(grid: Grid) {
  document.title = "re-minimeter 창";
  const zone = document.createElement("div");
  zone.id = "pop-zone";
  const bar = document.createElement("header");
  bar.id = "pop-bar";
  const drag = document.createElement("span");
  drag.className = "pop-drag";
  drag.setAttribute("data-tauri-drag-region", "");
  drag.textContent = "⋮⋮ re-minimeter";
  const prefs = windowPrefs();

  const pin = document.createElement("button");
  pin.className = "btn icon pin" + (prefs.pinned ? " on" : "");
  const pinLabel = (on: boolean) => { pin.textContent = on ? "📌 항상 위 ON" : "📌 항상 위 OFF"; pin.title = on ? "항상 위에: 켜짐 (클릭해 끄기)" : "항상 위에: 꺼짐 (클릭해 켜기)"; };
  pinLabel(prefs.pinned);
  pin.addEventListener("click", async () => {
    const on = !pin.classList.contains("on");
    pin.classList.toggle("on", on);
    pinLabel(on);
    saveWindowPrefs({ pinned: on });
    await setAlwaysOnTop(on);
  });

  const op = document.createElement("input");
  op.type = "range"; op.min = "0"; op.max = "100"; op.step = "5"; op.value = String(prefs.opacity);
  op.title = "투명도";
  op.className = "pop-opacity";
  op.addEventListener("input", () => { saveWindowPrefs({ opacity: Number(op.value) }); applyOpacity(Number(op.value)); });

  const menu = document.createElement("div");
  menu.className = "menu";
  const modBtn = document.createElement("button");
  modBtn.className = "btn"; modBtn.textContent = "모듈 ▾";
  const panel = document.createElement("div");
  panel.className = "popover hidden";
  menu.append(modBtn, panel);
  wireMenu(modBtn, panel, () => buildModulesPanel(grid, panel));
  grid.onChange = () => { if (!panel.classList.contains("hidden")) buildModulesPanel(grid, panel); };

  const edit = document.createElement("button");
  edit.className = "btn"; edit.textContent = "편집";
  const setEditing = (on: boolean) => { grid.setEditing(on); edit.classList.toggle("on", on); edit.textContent = on ? "편집 끝" : "편집"; };
  edit.addEventListener("click", () => setEditing(!grid.isEditing));
  grid.onToggleEdit = () => setEditing(!grid.isEditing);

  const find = document.createElement("button");
  find.className = "btn icon"; find.title = "모든 창 찾기 (테두리 반짝)"; find.textContent = "◎";
  find.addEventListener("click", () => flashAll());

  const close = document.createElement("button");
  close.className = "btn icon"; close.title = "창 닫기 (모듈은 메인 창으로)"; close.textContent = "✕";
  close.addEventListener("click", () => requestClose(grid));

  bar.append(drag, pin, op, menu, edit, find, close);
  const grip = document.createElement("div");
  grip.id = "pop-resize";
  grip.title = "크기 조절";
  document.body.append(zone, bar, grip);

  if (!inTauri) return;
  import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    const w = getCurrentWindow();
    grip.addEventListener("pointerdown", (e) => { e.preventDefault(); w.startResizeDragging("SouthEast").catch(() => {}); });
    // Remember geometry (physical px) for the next session.
    let timer: number | undefined;
    const save = () => {
      clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const p = await w.outerPosition(), s = await w.outerSize();
          updatePop(WIN_LABEL, { x: p.x, y: p.y, w: s.width, h: s.height });
        } catch { /* ignore */ }
      }, 300);
    };
    w.onMoved(save).catch(() => {});
    w.onResized(save).catch(() => {});
    // Alt+F4 etc. go through the main window so the modules come back there.
    w.onCloseRequested((e) => { if (closing) return; e.preventDefault(); requestClose(grid); }).catch(() => {});
  }).catch((e) => console.error(e));
}

/** Hands every module to the main window, forgets this pop-out and closes it. */
async function requestClose(grid: Grid) {
  if (closing) return;
  closing = true;
  for (const id of grid.activeIds) {
    const r = grid.layout[id];
    await emit("rm://to-main", { id, w: r.w, h: r.h }).catch((e) => console.error(e));
  }
  forgetPop(WIN_LABEL);
  await emit("rm://pop-closed", { label: WIN_LABEL }).catch(() => {});
  if (!inTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  await w.destroy().catch(async (e) => { console.error("destroy", e); await w.close().catch((e2) => { console.error("close", e2); closing = false; }); });
}
