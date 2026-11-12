// Tile grid: absolute-positioned tiles snapped to a COLS×ROWS grid. In edit mode
// the header drags (move) and the bottom-right handle resizes. Overlap is allowed;
// the last-touched tile goes on top. Holes are fine (DESIGN.md §7).
import type { Frame } from "../engine/frame";
import { MODULES } from "../modules";
import type { Module } from "../modules/types";
import { COLS, layout, MIN_H, MIN_W, ROWS, saveLayout, type TileRect } from "../state";

interface Tile {
  id: string;
  module: Module;
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  readout: HTMLElement | null;
  lastDraw: number;
}

const GUTTER = 6;

export class Grid {
  private tiles = new Map<string, Tile>();
  private editing = false;
  private ghost: HTMLElement;
  private z = 1;

  constructor(private root: HTMLElement) {
    this.ghost = document.createElement("div");
    this.ghost.className = "drop-ghost";
    this.ghost.style.display = "none";
    root.appendChild(this.ghost);
    new ResizeObserver(() => this.relayout()).observe(root);
    this.sync();
  }

  get isEditing() { return this.editing; }

  setEditing(on: boolean) {
    this.editing = on;
    this.root.classList.toggle("editing", on);
  }

  /** Create/remove tiles so they match `layout[*].on`. */
  sync() {
    for (const [id, r] of Object.entries(layout)) {
      if (r.on && !this.tiles.has(id) && MODULES[id]) this.mount(id);
      if (!r.on && this.tiles.has(id)) this.unmount(id);
    }
    this.relayout();
  }

  private cell() {
    const W = this.root.clientWidth, H = this.root.clientHeight;
    const cw = (W - GUTTER * (COLS - 1)) / COLS;
    const ch = (H - GUTTER * (ROWS - 1)) / ROWS;
    return { cw, ch };
  }

  private rectPx(r: TileRect) {
    const { cw, ch } = this.cell();
    return {
      left: r.x * (cw + GUTTER),
      top: r.y * (ch + GUTTER),
      width: r.w * cw + (r.w - 1) * GUTTER,
      height: r.h * ch + (r.h - 1) * GUTTER,
    };
  }

  relayout() {
    const { cw, ch } = this.cell();
    this.root.style.setProperty("--cell-w", `${cw + GUTTER}px`);
    this.root.style.setProperty("--cell-h", `${ch + GUTTER}px`);
    for (const t of this.tiles.values()) this.place(t);
  }

  private place(t: Tile) {
    const r = layout[t.id];
    const p = this.rectPx(r);
    Object.assign(t.el.style, { left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, height: `${p.height}px` });
    const body = t.canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(body.clientWidth)), h = Math.max(1, Math.floor(body.clientHeight));
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (t.canvas.width !== pw || t.canvas.height !== ph) {
      t.canvas.width = pw; t.canvas.height = ph;
      t.module.resize?.(w, h);
    }
  }

  private mount(id: string) {
    const module = MODULES[id]();
    const el = document.createElement("div");
    el.className = "tile";
    el.dataset.id = id;
    const head = document.createElement("div");
    head.className = "tile-head";
    const grip = document.createElement("span");
    grip.className = "grip";
    grip.textContent = "⋮⋮";
    const title = document.createElement("span");
    title.textContent = module.title;
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    head.append(grip, title, spacer);
    let readout: HTMLElement | null = null;
    if (module.headReadout) {
      readout = document.createElement("span");
      readout.className = "readout";
      head.appendChild(readout);
    }
    const ctl = module.headControl?.();
    if (ctl) head.appendChild(ctl);
    const close = document.createElement("button");
    close.className = "btn icon";
    close.title = "모듈 끄기";
    close.textContent = "×";
    close.addEventListener("pointerdown", (e) => e.stopPropagation());
    close.addEventListener("click", () => { layout[id].on = false; saveLayout(); this.sync(); this.onChange?.(); });
    head.appendChild(close);

    const body = document.createElement("div");
    body.className = "tile-body";
    const canvas = document.createElement("canvas");
    body.appendChild(canvas);
    const handle = document.createElement("div");
    handle.className = "resize-handle";
    el.append(head, body, handle);
    this.root.appendChild(el);

    const t: Tile = { id, module, el, canvas, ctx: canvas.getContext("2d")!, readout, lastDraw: performance.now() };
    this.tiles.set(id, t);
    this.bindDrag(t, head, "move");
    this.bindDrag(t, handle, "resize");
    this.place(t);
  }

  private unmount(id: string) {
    const t = this.tiles.get(id);
    if (!t) return;
    t.el.remove();
    this.tiles.delete(id);
  }

  onChange: (() => void) | null = null;

  private bindDrag(t: Tile, target: HTMLElement, mode: "move" | "resize") {
    target.addEventListener("pointerdown", (e) => {
      if (!this.editing || e.button !== 0) return;
      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      const start = { ...layout[t.id] };
      const { cw, ch } = this.cell();
      const sx = e.clientX, sy = e.clientY;
      let next: TileRect = { ...start };
      t.el.classList.add("dragging");
      t.el.style.zIndex = String(++this.z);
      this.ghost.style.display = "block";
      const update = (ev: PointerEvent) => {
        const dx = Math.round((ev.clientX - sx) / (cw + GUTTER));
        const dy = Math.round((ev.clientY - sy) / (ch + GUTTER));
        if (mode === "move") {
          next = { ...start, x: Math.max(0, Math.min(COLS - start.w, start.x + dx)), y: Math.max(0, Math.min(ROWS - start.h, start.y + dy)) };
          const p = this.rectPx(next);
          Object.assign(t.el.style, { left: `${p.left + (ev.clientX - sx) - dx * (cw + GUTTER)}px`, top: `${p.top + (ev.clientY - sy) - dy * (ch + GUTTER)}px` });
        } else {
          next = { ...start, w: Math.max(MIN_W, Math.min(COLS - start.x, start.w + dx)), h: Math.max(MIN_H, Math.min(ROWS - start.y, start.h + dy)) };
        }
        const g = this.rectPx(next);
        Object.assign(this.ghost.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px` });
      };
      const finish = (ev: PointerEvent) => {
        target.removeEventListener("pointermove", update);
        target.removeEventListener("pointerup", finish);
        target.removeEventListener("pointercancel", finish);
        try { target.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
        t.el.classList.remove("dragging");
        this.ghost.style.display = "none";
        Object.assign(layout[t.id], next);
        saveLayout();
        this.place(t);
      };
      target.addEventListener("pointermove", update);
      target.addEventListener("pointerup", finish);
      target.addEventListener("pointercancel", finish);
    });
  }

  draw(f: Frame, now: number) {
    const dpr = window.devicePixelRatio || 1;
    for (const t of this.tiles.values()) {
      const w = t.canvas.width / dpr, h = t.canvas.height / dpr;
      const dt = Math.min(0.1, (now - t.lastDraw) / 1000);
      t.lastDraw = now;
      const ctx = t.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      t.module.draw({ ctx, w, h, dt }, f);
      if (t.readout && t.module.headReadout) t.readout.textContent = t.module.headReadout(f);
    }
  }
}
