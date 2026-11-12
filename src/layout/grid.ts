// Tile grid: absolute-positioned tiles snapped to a cols×rows grid (dimensions depend
// on the layout kind: free grid, horizontal strip, vertical strip). In edit mode the
// header drags (move) and the bottom-right handle resizes. Overlapping tiles are
// pushed out of the way (down in the free grid / vertical strip, right in the
// horizontal strip); the grid grows when needed. While dragging nothing moves —
// dashed guides show where pushed tiles will land; they glide there on drop.
// Right-click opens the module's settings menu.
import type { Frame } from "../engine/frame";
import { minSize, MODULES } from "../modules";
import type { Module } from "../modules/types";
import { effectiveDims, GRID_DIMS, layouts, saveLayout, type Layout, type LayoutKind } from "../state";
import { showContextMenu } from "./contextmenu";

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

type Rect = { x: number; y: number; w: number; h: number };
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Places `movingId` at `target` and pushes every colliding tile out of the way.
 * Direction is decided by which side the mover comes from: a tile whose centre is to
 * the right of the mover is pushed right, one to the left is pushed left — when that
 * fits in the grid. Otherwise it goes down (free grid / vertical strip) or right
 * (horizontal strip), growing the grid. Cascades until stable.
 */
export function resolvePush(layout: Layout, movingId: string, target: Rect, kind: LayoutKind): Record<string, Rect> {
  const { cols } = GRID_DIMS[kind];
  const out: Record<string, Rect> = {};
  for (const [id, r] of Object.entries(layout)) if (r.on) out[id] = { x: r.x, y: r.y, w: r.w, h: r.h };
  out[movingId] = { ...target };
  const order = Object.keys(out).filter((id) => id !== movingId).sort((p, q) => (out[p].y - out[q].y) || (out[p].x - out[q].x));
  const queue = [movingId];
  let iter = 0;
  while (queue.length && iter++ < 400) {
    const id = queue.shift()!;
    const a = out[id];
    for (const oid of order) {
      if (oid === id) continue;
      const b = out[oid];
      if (!overlap(a, b)) continue;
      const aCx = a.x + a.w / 2, bCx = b.x + b.w / 2;
      const right = a.x + a.w, left = a.x - b.w;
      if (kind === "dockv") { b.y = a.y + a.h; }
      else if (kind === "dockh") { if (bCx < aCx && left >= 0) b.x = left; else b.x = right; }
      else if (bCx >= aCx && right + b.w <= cols) b.x = right;
      else if (bCx < aCx && left >= 0) b.x = left;
      else b.y = a.y + a.h;
      queue.push(oid);
    }
  }
  return out;
}

export class Grid {
  private tiles = new Map<string, Tile>();
  private editing = false;
  private ghost: HTMLElement;
  private z = 1;
  private kind: LayoutKind = "normal";
  /** Resolved rects during a drag (null when idle) — shown as guides, applied on drop. */
  private preview: Record<string, Rect> | null = null;
  private guides: HTMLElement[] = [];

  constructor(private root: HTMLElement) {
    this.ghost = document.createElement("div");
    this.ghost.className = "drop-ghost";
    this.ghost.style.display = "none";
    root.appendChild(this.ghost);
    new ResizeObserver(() => this.relayout()).observe(root);
    root.addEventListener("contextmenu", (e) => e.preventDefault());
    this.sync();
  }

  get isEditing() { return this.editing; }
  get layoutKind() { return this.kind; }
  get layout(): Layout { return layouts[this.kind]; }

  setEditing(on: boolean) {
    this.editing = on;
    this.root.classList.toggle("editing", on);
  }

  /** Switch layout family (normal / dockh / dockv) and rebuild tiles. */
  setKind(kind: LayoutKind) {
    if (kind === this.kind) return;
    for (const id of [...this.tiles.keys()]) this.unmount(id);
    this.kind = kind;
    this.sync();
  }

  /** Create/remove tiles so they match `layout[*].on`. */
  sync() {
    for (const [id, r] of Object.entries(this.layout)) {
      if (r.on && !this.tiles.has(id) && MODULES[id]) this.mount(id);
      if (!r.on && this.tiles.has(id)) this.unmount(id);
    }
    this.relayout();
  }

  /** Grid size in cells: base dims grown to contain every tile (and the drag preview). */
  dims() {
    const rects = this.preview ? Object.values(this.preview) : Object.values(this.layout).filter((r) => r.on);
    return effectiveDims(this.kind, rects);
  }

  private cell() {
    const { cols, rows } = this.dims();
    const W = this.root.clientWidth, H = this.root.clientHeight;
    return { cw: (W - GUTTER * (cols - 1)) / cols, ch: (H - GUTTER * (rows - 1)) / rows, cols, rows };
  }

  private rectPx(r: Rect) {
    const { cw, ch } = this.cell();
    return { left: r.x * (cw + GUTTER), top: r.y * (ch + GUTTER), width: r.w * cw + (r.w - 1) * GUTTER, height: r.h * ch + (r.h - 1) * GUTTER };
  }

  relayout() {
    const { cw, ch } = this.cell();
    this.root.style.setProperty("--cell-w", `${cw + GUTTER}px`);
    this.root.style.setProperty("--cell-h", `${ch + GUTTER}px`);
    for (const t of this.tiles.values()) this.place(t);
  }

  private rectOf(id: string): Rect {
    return this.layout[id];
  }

  private showGuides(resolved: Record<string, Rect>, movingId: string) {
    let k = 0;
    for (const [id, r] of Object.entries(resolved)) {
      const cur = this.layout[id];
      if (id === movingId || (cur.x === r.x && cur.y === r.y && cur.w === r.w && cur.h === r.h)) continue;
      let g = this.guides[k];
      if (!g) { g = document.createElement("div"); g.className = "push-guide"; this.root.appendChild(g); this.guides[k] = g; }
      const p = this.rectPx(r);
      Object.assign(g.style, { display: "block", left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, height: `${p.height}px` });
      g.textContent = this.tiles.get(id)?.module.title ?? id;
      k++;
    }
    for (; k < this.guides.length; k++) this.guides[k].style.display = "none";
  }

  private hideGuides() {
    for (const g of this.guides) g.style.display = "none";
  }

  private place(t: Tile, rect?: Rect) {
    const p = this.rectPx(rect ?? this.rectOf(t.id));
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
    title.className = "tile-title";
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
    const menuBtn = document.createElement("button");
    menuBtn.className = "btn icon";
    menuBtn.title = "설정 (우클릭)";
    menuBtn.textContent = "⋯";
    menuBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    menuBtn.addEventListener("click", (e) => { e.stopPropagation(); this.openMenu(id, module, e.clientX, e.clientY); });
    head.appendChild(menuBtn);

    const body = document.createElement("div");
    body.className = "tile-body";
    const canvas = document.createElement("canvas");
    body.appendChild(canvas);
    const handle = document.createElement("div");
    handle.className = "resize-handle";
    el.append(head, body, handle);
    this.root.appendChild(el);
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); this.openMenu(id, module, e.clientX, e.clientY); });

    const t: Tile = { id, module, el, canvas, ctx: canvas.getContext("2d")!, readout, lastDraw: performance.now() };
    this.tiles.set(id, t);
    module.mount?.(body, () => this.editing);
    this.bindDrag(t, head, "move");
    this.bindDrag(t, handle, "resize");
    this.place(t);
  }

  private openMenu(id: string, module: Module, x: number, y: number) {
    const items = module.settings?.() ?? [];
    showContextMenu(x, y, module.title, items, [
      { label: this.editing ? "레이아웃 편집 끝내기" : "레이아웃 편집", onClick: () => this.onToggleEdit?.() },
      { label: "모듈 끄기", danger: true, onClick: () => { this.layout[id].on = false; saveLayout(this.kind); this.sync(); this.onChange?.(); } },
    ]);
  }

  private unmount(id: string) {
    const t = this.tiles.get(id);
    if (!t) return;
    t.el.remove();
    this.tiles.delete(id);
  }

  onChange: (() => void) | null = null;
  onToggleEdit: (() => void) | null = null;

  /** Tile element under a point (CSS px, viewport coords), if any. */
  tileAt(x: number, y: number): { id: string; el: HTMLElement } | null {
    const el = document.elementFromPoint(x, y)?.closest(".tile") as HTMLElement | null;
    if (!el?.dataset.id) return null;
    return { id: el.dataset.id, el };
  }

  /** Deliver dropped files to the module under the point. Returns whether it was handled. */
  dropAt(x: number, y: number, paths: string[]): boolean {
    const t = this.tileAt(x, y);
    const tile = t && this.tiles.get(t.id);
    if (!tile?.module.onDrop) return false;
    tile.module.onDrop(paths);
    return true;
  }

  setDropHover(x: number | null, y: number | null) {
    for (const t of this.tiles.values()) t.el.classList.remove("drop-hover");
    if (x === null || y === null) return;
    const t = this.tileAt(x, y);
    const tile = t && this.tiles.get(t.id);
    if (tile?.module.onDrop) tile.el.classList.add("drop-hover");
  }

  private bindDrag(t: Tile, target: HTMLElement, mode: "move" | "resize") {
    target.addEventListener("pointerdown", (e) => {
      if (!this.editing || e.button !== 0) return;
      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      const start = { ...this.layout[t.id] };
      const { cw, ch } = this.cell();
      const base = GRID_DIMS[this.kind];
      // Movement bounds: fixed along the non-growing axis, open along the growing one.
      const maxX = this.kind === "dockh" ? Infinity : base.cols;
      const maxY = this.kind === "dockh" ? base.rows : Infinity;
      const min = minSize(t.id, this.kind);
      const sx = e.clientX, sy = e.clientY;
      let next: Rect = { ...start };
      t.el.classList.add("dragging");
      t.el.style.zIndex = String(++this.z);
      this.ghost.style.display = "block";
      const update = (ev: PointerEvent) => {
        const dx = Math.round((ev.clientX - sx) / (cw + GUTTER));
        const dy = Math.round((ev.clientY - sy) / (ch + GUTTER));
        if (mode === "move") {
          next = { ...start, x: Math.max(0, Math.min(maxX - start.w, start.x + dx)), y: Math.max(0, Math.min(maxY - start.h, start.y + dy)) };
          // The dragged tile follows the pointer freely; everything else stays put.
          const p = this.rectPx(start);
          Object.assign(t.el.style, { left: `${p.left + (ev.clientX - sx)}px`, top: `${p.top + (ev.clientY - sy)}px` });
        } else {
          next = { ...start, w: Math.max(min.w, Math.min(maxX - start.x, start.w + dx)), h: Math.max(min.h, Math.min(maxY - start.y, start.h + dy)) };
        }
        const resolved = resolvePush(this.layout, t.id, next, this.kind);
        const g = this.rectPx(next);
        Object.assign(this.ghost.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px` });
        this.showGuides(resolved, t.id);
        this.preview = resolved;
        if (mode === "resize") this.place(t, next);
      };
      const finish = (ev: PointerEvent) => {
        target.removeEventListener("pointermove", update);
        target.removeEventListener("pointerup", finish);
        target.removeEventListener("pointercancel", finish);
        try { target.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
        t.el.classList.remove("dragging");
        this.ghost.style.display = "none";
        this.hideGuides();
        const resolved = this.preview ?? resolvePush(this.layout, t.id, next, this.kind);
        this.preview = null;
        for (const [id, r] of Object.entries(resolved)) Object.assign(this.layout[id], r);
        saveLayout(this.kind);
        // Glide everything (including the grid rescale) to the new arrangement.
        this.root.classList.add("settling");
        this.relayout();
        setTimeout(() => this.root.classList.remove("settling"), 220);
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
