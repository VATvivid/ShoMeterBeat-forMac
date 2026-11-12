import type { Frame } from "../engine/frame";

export interface DrawCtx {
  ctx: CanvasRenderingContext2D;
  w: number; // CSS pixels
  h: number;
  dt: number; // seconds since previous draw
}

/** One row in a module's right-click settings menu. */
export type SettingItem =
  | { type: "select"; label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }
  | { type: "toggle"; label: string; value: boolean; onChange: (v: boolean) => void }
  | { type: "range"; label: string; value: number; min: number; max: number; step: number; format?: (v: number) => string; onChange: (v: number) => void }
  | { type: "action"; label: string; onClick: () => void };

export interface Module {
  readonly id: string;
  readonly title: string;
  /** Optional short text shown in the tile header (e.g. "L -12.3  R -11.9"). */
  headReadout?(f: Frame): string;
  /** Items for the tile's right-click menu. */
  settings?(): SettingItem[];
  draw(d: DrawCtx, f: Frame): void;
  resize?(w: number, h: number): void;
  /** Called once with the tile body element (for pointer interaction / overlays). */
  mount?(body: HTMLElement, isEditing: () => boolean): void;
  /** Files dropped onto this tile (absolute paths). */
  onDrop?(paths: string[]): void;
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
