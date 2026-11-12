// Tile grid: absolute-positioned tiles snapped to a cols×rows grid (dimensions depend
// on the layout kind: free grid, horizontal strip, vertical strip). In edit mode the
// header drags (move) and the bottom-right handle resizes. Overlapping tiles are
// pushed out of the way (down → sideways → shrink), previewed live while dragging.
// Right-click opens the module's settings menu.
import type { Frame } from "../engine/frame";
import { minSize, MODULES } from "../modules";
import type { Module } from "../modules/types";
import { GRID_DIMS, layouts, saveLayout, type Layout, type LayoutKind } from "../state";
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
 * Places `movingId` at `target` and pushes every colliding tile away:
 * 1) below the mover if it still fits in the grid, 2) else beside it (left/right),
 * 3) else shrink the pushed tile's width (or height in vertical strips) to fit beside,
 * 4) last resort: shrink its height. Cascades until stable (bounded).
 */
export function resolvePush(layout: Layout, movingId: string, target: Rect, kind: LayoutKind): Record<string, Rect> {
  const { cols, rows } = GRID_DIMS[kind];
  const out: Record<string, Rect> = {};
  for (const [id, r] of Object.entries(layout)) if (r.on) out[id] = { x: r.x, y: r.y, w: r.w, h: r.h };
  out[movingId] = { ...target };
  const queue = [movingId];
  let iter = 0;
  while (queue.length && iter++ < 300) {
    const id = queue.shift()!;
    const a = out[id];
    for (const [oid, b] of Object.entries(out)) {
      if (oid === id || oid === movingId || !overlap(a, b)) continue;
      const min = minSize(oid, kind);
      // 1) push down
      if (kind !== "dockh" && a.y + a.h + b.h <= rows) { b.y = a.y + a.h; queue.push(oid); continue; }
      // 2) push sideways (whichever is closer)
      const right = a.x + a.w, left = a.x - b.w;
      const cands: number[] = [];
      if (right + b.w <= cols) cands.push(right);
      if (left >= 0) cands.push(left);
      if (cands.length) { b.x = cands.sort((p, q) => Math.abs(p - b.x) - Math.abs(q - b.x))[0]; queue.push(oid); continue; }
      // 3) shrink width to fit beside the mover
      const spaceR = cols - right, spaceL = a.x;
      if (kind !== "dockv" && (spaceR >= min.w || spaceL >= min.w)) {
        if (spaceR >= spaceL) { b.x = right; b.w = spaceR; } else { b.x = 0; b.w = spaceL; }
        queue.push(oid); continue;
      }
      // 4) shrink height below the mover (vertical strips / tall grids)
      const spaceB = rows - (a.y + a.h), spaceT = a.y;
      if (spaceB >= min.h || spaceT >= min.h) {
        if (spaceB >= spaceT) { b.y = a.y + a.h; b.h = spaceB; } else { b.y = 0; b.h = spaceT; }
        queue.push(oid); continue;
      }
      // Give up on this one (stays overlapped).
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
  /** Live preview rects during a drag (null when idle). */
  private preview: Record<string, Rect> | null = null;

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

  private cell() {
    const { cols, rows } = GRID_DIMS[this.kind];
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
    return this.preview?.[id] ?? this.layout[id];
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

  private bindDrag(t: Tile, target: HTMLElement, mode: "move" | "resize") {
    target.addEventListener("pointerdown", (e) => {
      if (!this.editing || e.button !== 0) return;
      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      const start = { ...this.layout[t.id] };
      const { cw, ch, cols, rows } = this.cell();
      const min = minSize(t.id, this.kind);
      const sx = e.clientX, sy = e.clientY;
      let next: Rect = { ...start };
      t.el.classList.add("dragging");
      t.el.style.zIndex = String(++this.z);
      this.ghost.style.display = "block";
      this.root.classList.add("pushing");
      const update = (ev: PointerEvent) => {
        const dx = Math.round((ev.clientX - sx) / (cw + GUTTER));
        const dy = Math.round((ev.clientY - sy) / (ch + GUTTER));
        if (mode === "move") {
          next = { ...start, x: Math.max(0, Math.min(cols - start.w, start.x + dx)), y: Math.max(0, Math.min(rows - start.h, start.y + dy)) };
          const p = this.rectPx(next);
          Object.assign(t.el.style, { left: `${p.left + (ev.clientX - sx) - dx * (cw + GUTTER)}px`, top: `${p.top + (ev.clientY - sy) - dy * (ch + GUTTER)}px` });
        } else {
          next = { ...start, w: Math.max(min.w, Math.min(cols - start.x, start.w + dx)), h: Math.max(min.h, Math.min(rows - start.y, start.h + dy)) };
        }
        const g = this.rectPx(next);
        Object.assign(this.ghost.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px` });
        // Live push preview for the other tiles.
        this.preview = resolvePush(this.layout, t.id, next, this.kind);
        for (const o of this.tiles.values()) if (o.id !== t.id) this.place(o, this.preview[o.id]);
        if (mode === "resize") this.place(t, next);
      };
      const finish = (ev: PointerEvent) => {
        target.removeEventListener("pointermove", update);
        target.removeEventListener("pointerup", finish);
        target.removeEventListener("pointercancel", finish);
        try { target.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
        t.el.classList.remove("dragging");
        this.ghost.style.display = "none";
        this.root.classList.remove("pushing");
        const resolved = this.preview ?? resolvePush(this.layout, t.id, next, this.kind);
        this.preview = null;
        for (const [id, r] of Object.entries(resolved)) Object.assign(this.layout[id], r);
        saveLayout(this.kind);
        this.relayout();
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
