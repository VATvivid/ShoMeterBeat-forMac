// "모듈 ▾" checklist: switches modules on (appended after everything else) and off.
import type { Grid } from "./layout/grid";
import { MODULE_TITLES } from "./modules";

export function buildModulesPanel(grid: Grid, panel: HTMLElement) {
  panel.innerHTML = "";
  for (const [id, title] of Object.entries(MODULE_TITLES)) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!grid.layout[id]?.on;
    cb.addEventListener("change", () => {
      if (!cb.checked) { grid.remove(id); return; }
      const prev = grid.layout[id];
      const kind = grid.layoutKind;
      const def = kind === "dockh" ? { w: 4, h: 1 } : kind === "dockv" ? { w: 1, h: 4 } : { w: 8, h: 6 };
      grid.add(id, prev?.w ?? def.w, prev?.h ?? def.h);
    });
    label.append(cb, document.createTextNode(title));
    panel.appendChild(label);
  }
}

/** Toggle a popover from its button; closes on outside click. */
export function wireMenu(btn: HTMLElement, panel: HTMLElement, onOpen?: () => void) {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = panel.classList.contains("hidden");
    closeAllMenus();
    if (open) { onOpen?.(); panel.classList.remove("hidden"); }
  });
  panel.addEventListener("click", (e) => e.stopPropagation());
  menus.push(panel);
}
const menus: HTMLElement[] = [];
export function closeAllMenus() { for (const m of menus) m.classList.add("hidden"); }
document.addEventListener("click", () => closeAllMenus());
