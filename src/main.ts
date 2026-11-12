// Entry point for every window. The main window gets the toolbar + status bar
// (toolbar.ts); a pop-out window (`?win=pop-…`) gets the slim pop bar (pop.ts). Both
// share the grid, the render loop, file drag-drop and the cross-window wiring.
import { setSource } from "./engine/instance";
import { createSource, inTauri } from "./engine/source";
import { Grid } from "./layout/grid";
import { initPop } from "./pop";
import { IS_POP } from "./state";
import { notice } from "./status";
import { initToolbar, type Toolbar } from "./toolbar";
import { initWindowing } from "./windows";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const source = createSource();
setSource(source);
const grid = new Grid($("grid"));
document.body.classList.toggle("pop", IS_POP);

let toolbar: Toolbar | null = null;
if (IS_POP) initPop(grid);
else toolbar = initToolbar(grid, source);
initWindowing(grid);

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  if (e.key === "e" || e.key === "E") grid.onToggleEdit?.();
  if (e.key === "Escape" && grid.isEditing) grid.onToggleEdit?.();
});

// ---- file drag & drop (Tauri window events; HTML5 fallback in the browser) --
if (inTauri) {
  import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
    getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      const scale = window.devicePixelRatio || 1;
      if (p.type === "over" || p.type === "enter") grid.setDropHover(p.position.x / scale, p.position.y / scale);
      else if (p.type === "leave") grid.setDropHover(null, null);
      else if (p.type === "drop") {
        grid.setDropHover(null, null);
        const ok = grid.dropAt(p.position.x / scale, p.position.y / scale, p.paths);
        if (!ok) notice("여기엔 놓을 수 없습니다 — Player 또는 Spectrum 타일에 놓으세요");
      }
    }).catch((err) => console.error(err));
  }).catch((err) => console.error(err));
} else {
  document.addEventListener("dragover", (e) => { e.preventDefault(); grid.setDropHover(e.clientX, e.clientY); });
  document.addEventListener("dragleave", () => grid.setDropHover(null, null));
  document.addEventListener("drop", (e) => { e.preventDefault(); grid.setDropHover(null, null); grid.dropAt(e.clientX, e.clientY, ["(browser-preview).wav"]); });
}

// ---- render loop -----------------------------------------------------------
let busy = false;
async function loop(now: number) {
  requestAnimationFrame(loop);
  if (busy) return;
  busy = true;
  try {
    const f = await source.tick();
    grid.draw(f, now);
    toolbar?.onFrame(f, now);
  } catch (e) {
    console.error(e);
  } finally {
    busy = false;
  }
}
requestAnimationFrame(loop);
