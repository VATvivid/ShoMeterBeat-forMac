import type { Frame } from "../engine/frame";

export interface DrawCtx {
  ctx: CanvasRenderingContext2D;
  w: number; // CSS pixels
  h: number;
  dt: number; // seconds since previous draw
}

export interface Module {
  readonly id: string;
  readonly title: string;
  /** Optional short text shown in the tile header (e.g. "L -12.3  R -11.9"). */
  headReadout?(f: Frame): string;
  /** Optional control element mounted in the tile header. */
  headControl?(): HTMLElement | null;
  draw(d: DrawCtx, f: Frame): void;
  resize?(w: number, h: number): void;
}

export type ModuleFactory = () => Module;

/** Exponential release in dB/s with instant attack. */
export function ballistic(prev: number, target: number, dt: number, releaseDbPerSec: number): number {
  if (target >= prev) return target;
  return Math.max(target, prev - releaseDbPerSec * dt);
}

export function fmtDb(v: number, digits = 1): string {
  return v <= -119 ? "−∞" : (v > 0 ? "+" : "") + v.toFixed(digits).replace("-", "−");
}
