// The live Source, set once by main.ts so modules (e.g. Waveform) can call commands.
import type { Source } from "./source";

let current: Source | null = null;
export function setSource(s: Source) { current = s; }
export function getSource(): Source | null { return current; }
