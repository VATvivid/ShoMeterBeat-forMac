// "모듈 ▾" checklist: switches modules on (appended after everything else) and off.
import type { Grid } from "./layout/grid";
import { baseOf, isInstance, MODULE_TITLES, newInstanceKey, titleOf } from "./modules";

export function buildModulesPanel(grid: Grid, panel: HTMLElement) {
  panel.innerHTML = "";
  const kind = grid.layoutKind;
  const def = kind === "dockh" ? { w: 4, h: 1 } : kind === "dockv" ? { w: 1, h: 4 } : { w: 8, h: 6 };
  for (const [id, title] of Object.entries(MODULE_TITLES)) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!grid.layout[id]?.on;
    cb.addEventListener("change", () => {
      if (!cb.checked) { grid.remove(id); return; }
      const prev = grid.layout[id];
      grid.add(id, prev?.w ?? def.w, prev?.h ?? def.h);
    });
    const name = document.createElement("span");
    name.textContent = title;
    name.style.flex = "1";
    // "＋": another instance of the same module (its own settings — e.g. a second Pitch in 효과음 mode)
    const plus = document.createElement("button");
    plus.className = "btn icon";
    plus.textContent = "＋";
    plus.title = "같은 모듈 하나 더 추가 (설정은 따로)";
    plus.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const prev = grid.layout[id];
      grid.add(newInstanceKey(id), prev?.w ?? def.w, prev?.h ?? def.h);
      buildModulesPanel(grid, panel);
    });
    label.append(cb, name, plus);
    panel.appendChild(label);
    // existing extra instances of this module, each with its own ×
    for (const key of Object.keys(grid.layout).filter((k) => isInstance(k) && baseOf(k) === id && grid.layout[k].on)) {
      const row = document.createElement("label");
      row.style.paddingLeft = "26px";
      const x = document.createElement("button");
      x.className = "btn icon"; x.textContent = "×"; x.title = "이 모듈 지우기";
      x.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); grid.remove(key); buildModulesPanel(grid, panel); });
      const n = document.createElement("span"); n.textContent = titleOf(key); n.style.flex = "1";
      row.append(n, x);
      panel.appendChild(row);
    }
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
