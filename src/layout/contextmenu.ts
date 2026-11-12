// Right-click settings menu for a tile (DESIGN.md §4 popover style).
import type { SettingItem } from "../modules/types";

export interface MenuAction { label: string; onClick: () => void; danger?: boolean }

let open: HTMLElement | null = null;

export function closeContextMenu() {
  open?.remove();
  open = null;
}

export function showContextMenu(x: number, y: number, title: string, items: SettingItem[], actions: MenuAction[]) {
  closeContextMenu();
  const el = document.createElement("div");
  el.className = "ctxmenu";
  const head = document.createElement("div");
  head.className = "ctx-title";
  head.textContent = title;
  el.appendChild(head);

  for (const it of items) {
    const row = document.createElement("div");
    row.className = "ctx-row";
    const label = document.createElement("span");
    label.className = "ctx-label";
    label.textContent = it.label;
    row.appendChild(label);
    if (it.type === "select") {
      const sel = document.createElement("select");
      sel.className = "mini";
      for (const o of it.options) {
        const opt = document.createElement("option");
        opt.value = o.value; opt.textContent = o.label;
        if (o.value === it.value) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener("change", () => it.onChange(sel.value));
      row.appendChild(sel);
    } else if (it.type === "toggle") {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = it.value;
      cb.addEventListener("change", () => it.onChange(cb.checked));
      row.appendChild(cb);
      row.classList.add("clickable");
      row.addEventListener("click", (e) => { if (e.target !== cb) { cb.checked = !cb.checked; it.onChange(cb.checked); } });
    } else if (it.type === "range") {
      const wrap = document.createElement("span");
      wrap.className = "ctx-range";
      const val = document.createElement("span");
      val.className = "ctx-val";
      const fmt = it.format ?? ((v: number) => String(v));
      val.textContent = fmt(it.value);
      const r = document.createElement("input");
      r.type = "range"; r.min = String(it.min); r.max = String(it.max); r.step = String(it.step); r.value = String(it.value);
      r.addEventListener("input", () => { it.onChange(Number(r.value)); val.textContent = fmt(Number(r.value)); });
      wrap.append(r, val);
      row.appendChild(wrap);
    } else {
      row.classList.add("clickable");
      row.addEventListener("click", () => { it.onClick(); closeContextMenu(); });
    }
    el.appendChild(row);
  }
  if (items.length && actions.length) {
    const sep = document.createElement("div");
    sep.className = "ctx-sep";
    el.appendChild(sep);
  }
  for (const a of actions) {
    const row = document.createElement("div");
    row.className = "ctx-row clickable" + (a.danger ? " danger" : "");
    row.textContent = a.label;
    row.addEventListener("click", () => { a.onClick(); closeContextMenu(); });
    el.appendChild(row);
  }
  document.body.appendChild(el);
  // Keep inside the viewport.
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  open = el;
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

document.addEventListener("pointerdown", () => closeContextMenu());
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeContextMenu(); });
window.addEventListener("resize", () => closeContextMenu());
window.addEventListener("blur", () => closeContextMenu());
