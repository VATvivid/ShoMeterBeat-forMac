// Tile grid: absolute-positioned tiles snapped to a cols×rows grid (dimensions depend
// on the layout kind: free grid, horizontal strip, vertical strip). In edit mode the
// header drags (move) and the bottom-right handle resizes. Overlapping tiles are
// free to overlap (default) or swapped with the one tile under the drop; the grid
// grows to contain every tile and, in edit mode, by the "+" buttons on its right / bottom
// edge (the window stays, cells shrink). While dragging nothing moves — dashed guides
// show where affected tiles will land; they glide there on drop.
// A tile dragged out of the window is handed to `onXDrag` (cross-window move).
// Right-click opens the module's settings menu.
import type { Frame } from "../engine/frame";
import { minSize, MODULES } from "../modules";
import type { Module } from "../modules/types";
import { effectiveDims, GRID_DIMS, gridExtra, layouts, saveLayout, saveSettings, setGridExtra, settings, type Layout, type LayoutKind } from "../state";
import { showContextMenu, type MenuAction } from "./contextmenu";

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

export type Rect = { x: number; y: number; w: number; h: number };
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Hooks for moving a tile to another window (see windows.ts). Points are CSS px of this window's viewport. */
export interface XDragHooks {
  hover(id: string, rect: Rect, clientX: number, clientY: number): void;
  leave(): void;
  /** Resolves true when another window took the module (it is then switched off here). */
  drop(id: string, rect: Rect, tilePx: { w: number; h: number }, clientX: number, clientY: number): Promise<boolean>;
}

/**
 * Places `movingId` at `target` and pushes every colliding tile out of the way.
 * Direction is decided by which side the mover comes from: a tile whose centre is to
 * the right of the mover is pushed right, one to the left is pushed left — when that
 * fits in the grid (the free grid counts as wide as the mover makes it). Otherwise it
 * goes down (free grid / vertical strip) or right (horizontal strip), growing the grid.
 * Cascades until stable.
 */
export function resolvePush(layout: Layout, movingId: string, target: Rect, kind: LayoutKind): Record<string, Rect> {
  const cols = kind === "normal" ? Math.max(GRID_DIMS.normal.cols, target.x + target.w) : GRID_DIMS[kind].cols;
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

/**
 * Swap placement: the mover goes to `target`; if exactly one tile lies under it, that tile
 * takes the mover's old top-left (keeping its own size) when it fits there without
 * touching anything else. Nothing else moves. Returns null when the drop is not allowed
 * (two or more tiles under it, or the swapped tile would not fit).
 */
export function resolveSwap(layout: Layout, movingId: string, target: Rect, origin: Rect, kind: LayoutKind): Record<string, Rect> | null {
  const others = Object.entries(layout).filter(([id, r]) => id !== movingId && r.on);
  const under = others.filter(([, r]) => overlap(target, r));
  const out: Record<string, Rect> = { [movingId]: { ...target } };
  if (under.length === 0) return out;
  if (under.length > 1) return null;
  const [bid, b] = under[0];
  const moved: Rect = { x: origin.x, y: origin.y, w: b.w, h: b.h };
  if (kind === "dockh") moved.y = 0;
  if (kind === "dockv") moved.x = 0;
  const cols = kind === "normal" ? Math.max(GRID_DIMS.normal.cols, target.x + target.w) : GRID_DIMS[kind].cols;
  if (moved.x + moved.w > cols && kind !== "normal") return null;
  if (overlap(moved, target)) return null;
  for (const [oid, r] of others) if (oid !== bid && overlap(moved, r)) return null;
  out[bid] = moved;
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
  private growUi: HTMLElement[] = [];

  constructor(private root: HTMLElement) {
    this.ghost = document.createElement("div");
    this.ghost.className = "drop-ghost";
    this.ghost.style.display = "none";
    root.appendChild(this.ghost);
    new ResizeObserver(() => this.relayout()).observe(root);
    root.addEventListener("contextmenu", (e) => e.preventDefault());
    this.buildGrowUi();
    this.sync();
  }

  /** Edit-mode "+ / −" buttons on the right (columns) and bottom (rows) edges. */
  private buildGrowUi() {
    const mk = (side: "cols" | "rows") => {
      const box = document.createElement("div");
      box.className = `grid-grow ${side}`;
      const label = document.createElement("span");
      const plus = document.createElement("button"); plus.className = "btn icon"; plus.textContent = "+"; plus.title = side === "cols" ? "열 추가" : "행 추가";
      const minus = document.createElement("button"); minus.className = "btn icon"; minus.textContent = "−"; minus.title = side === "cols" ? "열 제거 (빈 열만)" : "행 제거 (빈 행만)";
      const bump = (d: number) => {
        const ex = gridExtra(this.kind);
        ex[side] = Math.max(0, ex[side] + d);
        setGridExtra(this.kind, ex);
        this.root.classList.add("settling");
        this.relayout();
        setTimeout(() => this.root.classList.remove("settling"), 220);
        this.updateGrowUi();
      };
      for (const b of [plus, minus]) b.addEventListener("pointerdown", (e) => e.stopPropagation());
      plus.addEventListener("click", () => bump(1));
      minus.addEventListener("click", () => bump(-1));
      box.append(plus, label, minus);
      this.root.appendChild(box);
      return box;
    };
    this.growUi = [mk("cols"), mk("rows")];
    this.updateGrowUi();
  }

  private updateGrowUi() {
    const d = this.dims();
    const ex = gridExtra(this.kind);
    const [c, r] = this.growUi;
    if (!c || !r) return;
    c.style.display = this.kind === "dockv" ? "none" : "";
    r.style.display = this.kind === "dockh" ? "none" : "";
    (c.children[1] as HTMLElement).textContent = `${d.cols}열`;
    (r.children[1] as HTMLElement).textContent = `${d.rows}행`;
    (c.children[2] as HTMLButtonElement).disabled = ex.cols === 0;
    (r.children[2] as HTMLButtonElement).disabled = ex.rows === 0;
  }

  get isEditing() { return this.editing; }
  get layoutKind() { return this.kind; }
  get layout(): Layout { return layouts[this.kind]; }
  /** Ids of the modules currently shown. */
  get activeIds(): string[] { return [...this.tiles.keys()]; }

  setEditing(on: boolean) {
    this.editing = on;
    this.root.classList.toggle("editing", on);
    document.body.classList.toggle("editing", on);
    this.updateGrowUi();
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
    return effectiveDims(this.kind, rects, gridExtra(this.kind));
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

  /** Grid cell under a viewport point (may be outside the grid: not clamped). */
  cellAt(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.root.getBoundingClientRect();
    const { cw, ch } = this.cell();
    return { x: Math.floor((clientX - r.left) / (cw + GUTTER)), y: Math.floor((clientY - r.top) / (ch + GUTTER)) };
  }

  relayout() {
    const { cw, ch } = this.cell();
    this.root.style.setProperty("--cell-w", `${cw + GUTTER}px`);
    this.root.style.setProperty("--cell-h", `${ch + GUTTER}px`);
    for (const t of this.tiles.values()) this.place(t);
    this.updateGrowUi();
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
    const extra = this.extraMenu?.(id) ?? [];
    showContextMenu(x, y, module.title, items, [
      { label: this.editing ? "레이아웃 편집 끝내기" : "레이아웃 편집", onClick: () => this.onToggleEdit?.() },
      { label: settings.layoutMode === "swap" ? "배치 방식: 자리 바꾸기 ✓ (→ 겹침 허용)" : "배치 방식: 겹침 허용 ✓ (→ 자리 바꾸기)", onClick: () => { settings.layoutMode = settings.layoutMode === "swap" ? "free" : "swap"; saveSettings(); } },
      ...extra,
      { label: "모듈 끄기", danger: true, onClick: () => this.remove(id) },
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
  /** Extra rows for a tile's context menu (e.g. "별도 창으로 보내기"). */
  extraMenu: ((id: string) => MenuAction[]) | null = null;
  onXDrag: XDragHooks | null = null;

  /** Switch a module off in this window. */
  remove(id: string) {
    if (!this.layout[id]) return;
    this.layout[id].on = false;
    saveLayout(this.kind);
    this.sync();
    this.onChange?.();
  }

  /**
   * Switch a module on, `w`×`h` cells, at the cell under a viewport point (centred on
   * it) or appended after everything else when no point is given. Colliding tiles are
   * pushed like in a drag.
   */
  add(id: string, w: number, h: number, clientX?: number, clientY?: number) {
    if (!MODULES[id]) return;
    const min = minSize(id, this.kind);
    const size = this.kind === "dockh" ? { w: Math.max(min.w, w), h: 1 } : this.kind === "dockv" ? { w: 1, h: Math.max(min.h, h) } : { w: Math.max(min.w, w), h: Math.max(min.h, h) };
    let target: Rect;
    if (clientX !== undefined && clientY !== undefined) {
      const c = this.cellAt(clientX, clientY);
      target = { x: Math.max(0, c.x - Math.floor(size.w / 2)), y: Math.max(0, c.y - Math.floor(size.h / 2)), ...size };
      if (this.kind === "dockh") target.y = 0;
      if (this.kind === "dockv") target.x = 0;
    } else {
      const d = this.dims();
      target = this.kind === "dockh" ? { x: d.cols, y: 0, ...size } : { x: 0, y: d.rows, ...size };
    }
    this.layout[id] = { ...target, on: true };
    const resolved = resolvePush(this.layout, id, target, this.kind);
    for (const [oid, r] of Object.entries(resolved)) Object.assign(this.layout[oid], r);
    saveLayout(this.kind);
    this.root.classList.add("settling");
    this.sync();
    setTimeout(() => this.root.classList.remove("settling"), 220);
    this.onChange?.();
  }

  /** Drop ghost for a tile being dragged in from another window (null hides it). */
  setExternalGhost(g: { w: number; h: number; clientX: number; clientY: number } | null) {
    if (!g) { this.ghost.style.display = "none"; return; }
    const c = this.cellAt(g.clientX, g.clientY);
    const r: Rect = { x: Math.max(0, c.x - Math.floor(g.w / 2)), y: Math.max(0, c.y - Math.floor(g.h / 2)), w: g.w, h: g.h };
    if (this.kind === "dockh") { r.y = 0; r.h = 1; }
    if (this.kind === "dockv") { r.x = 0; r.w = 1; }
    const p = this.rectPx(r);
    Object.assign(this.ghost.style, { display: "block", left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, height: `${p.height}px` });
  }

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
      // Movement bounds: fixed along a strip's thin axis, open along every growing one.
      const maxX = this.kind === "dockv" ? 1 : Infinity;
      const maxY = this.kind === "dockh" ? 1 : Infinity;
      const min = minSize(t.id, this.kind);
      const sx = e.clientX, sy = e.clientY;
      let next: Rect = { ...start };
      let outside = false;       // pointer left this window (cross-window move)
      let lastHover = 0;
      const p0 = this.rectPx(start); // pixel origin frozen for the drag: the tile follows the pointer 1:1 even when cells rescale
      let valid = true;
      t.el.classList.add("dragging");
      t.el.style.zIndex = String(++this.z);
      this.ghost.style.display = "block";
      const isOutside = (ev: PointerEvent) => mode === "move" && !!this.onXDrag && (ev.clientX < 0 || ev.clientY < 0 || ev.clientX > window.innerWidth || ev.clientY > window.innerHeight);
      const update = (ev: PointerEvent) => {
        const dx = Math.round((ev.clientX - sx) / (cw + GUTTER));
        const dy = Math.round((ev.clientY - sy) / (ch + GUTTER));
        if (mode === "move") {
          next = { ...start, x: Math.max(0, Math.min(maxX - start.w, start.x + dx)), y: Math.max(0, Math.min(maxY - start.h, start.y + dy)) };
          // The dragged tile follows the pointer freely; everything else stays put.
          Object.assign(t.el.style, { left: `${p0.left + (ev.clientX - sx)}px`, top: `${p0.top + (ev.clientY - sy)}px` });
        } else {
          next = { ...start, w: Math.max(min.w, Math.min(maxX - start.x, start.w + dx)), h: Math.max(min.h, Math.min(maxY - start.y, start.h + dy)) };
        }
        const out = isOutside(ev);
        if (out) {
          // Outside this window: no local preview; tell the window under the pointer (20 Hz).
          if (!outside) { this.ghost.style.display = "none"; this.hideGuides(); this.preview = null; }
          outside = true;
          const now = performance.now();
          if (now - lastHover > 50) { lastHover = now; this.onXDrag!.hover(t.id, start, ev.clientX, ev.clientY); }
          return;
        }
        if (outside) { outside = false; this.ghost.style.display = "block"; this.onXDrag?.leave(); }
        // move: free (default) → the tile goes where it is dropped, overlapping allowed, nothing else moves;
        //       swap → exchange with the one tile under it (null = not allowed → red ghost, snap back).
        // resize always just resizes (overlap allowed). resolvePush is only used when a module is added.
        const lm = settings.layoutMode === "swap" ? "swap" : "free";
        const swap = mode === "move" && lm === "swap" ? resolveSwap(this.layout, t.id, next, start, this.kind) : null;
        valid = !(mode === "move" && lm === "swap" && swap === null);
        this.ghost.classList.toggle("invalid", !valid);
        const resolved = swap ?? { [t.id]: { ...next } };
        const g = this.rectPx(next);
        Object.assign(this.ghost.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px` });
        this.showGuides(resolved, t.id);
        // Preview = every tile at its would-be rect, so the grid size (and cell size) during the
        // drag is computed from the whole layout, not just the few tiles the resolver returned.
        const merged: Record<string, Rect> = {};
        for (const [id, r] of Object.entries(this.layout)) if (r.on) merged[id] = { x: r.x, y: r.y, w: r.w, h: r.h };
        Object.assign(merged, resolved);
        this.preview = merged;
        if (mode === "resize") this.place(t, next);
      };
      const finish = async (ev: PointerEvent) => {
        target.removeEventListener("pointermove", update);
        target.removeEventListener("pointerup", finish);
        target.removeEventListener("pointercancel", finish);
        try { target.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
        t.el.classList.remove("dragging");
        this.ghost.style.display = "none";
        this.ghost.classList.remove("invalid");
        this.hideGuides();
        if (outside && ev.type === "pointerup") {
          // Dropped outside this window: hand the module to the window under the pointer.
          this.preview = null;
          const px = { w: t.el.clientWidth, h: t.el.clientHeight };
          this.place(t);
          let taken = false;
          try { taken = await this.onXDrag!.drop(t.id, start, px, ev.clientX, ev.clientY); } catch (err) { console.error(err); }
          if (taken) this.remove(t.id);
          return;
        }
        if (outside) { this.onXDrag?.leave(); this.preview = null; this.place(t); return; }
        if (!valid) { this.preview = null; this.place(t); return; } // swap mode: nowhere to put the tile under it — snap back
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
