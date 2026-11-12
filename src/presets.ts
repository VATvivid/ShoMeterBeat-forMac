// Named presets: dock mode + all three layouts + settings (source, targets, per-module
// settings). Applying a preset switches dock mode, layout and settings in one go.
import { layouts, saveLayout, saveSettings, settings, type DockMode, type Layout, type LayoutKind, type Settings } from "./state";

export interface Preset {
  dock: DockMode;
  dockSize: number;
  layouts: Record<LayoutKind, Layout>;
  settings: Omit<Settings, "dock" | "dockSize">;
  savedAt: string;
}

const KEY = "rm.presets.v1";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export function loadPresets(): Record<string, Preset> {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}

export function savePresets(p: Record<string, Preset>) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

/** Snapshot of the current state. */
export function capturePreset(): Preset {
  const { dock, dockSize, ...rest } = settings;
  return { dock, dockSize, layouts: clone(layouts), settings: clone(rest), savedAt: new Date().toISOString() };
}

export function storePreset(name: string, p: Preset = capturePreset()) {
  const all = loadPresets();
  all[name] = p;
  savePresets(all);
}

export function deletePreset(name: string) {
  const all = loadPresets();
  delete all[name];
  savePresets(all);
}

/** Writes the preset into the live state objects (in place, so modules see it) and
 *  persists. The caller then re-applies dock mode / grid / source. */
export function applyPresetState(p: Preset) {
  for (const kind of Object.keys(layouts) as LayoutKind[]) {
    const l = layouts[kind];
    for (const k of Object.keys(l)) delete l[k];
    Object.assign(l, clone(p.layouts[kind] ?? {}));
    saveLayout(kind);
  }
  const s = clone(p.settings);
  settings.sourceMode = s.sourceMode;
  settings.device = s.device;
  settings.loudnessTarget = s.loudnessTarget;
  settings.levelMode = s.levelMode;
  settings.modules = s.modules ?? {};
  settings.dockSize = p.dockSize;
  settings.dock = p.dock;
  saveSettings();
}

export function presetToJson(name: string, p: Preset): string {
  return JSON.stringify({ app: "re-minimeter", kind: "preset", name, preset: p }, null, 2);
}

export function presetFromJson(text: string): { name: string; preset: Preset } {
  const o = JSON.parse(text);
  if (!o || o.kind !== "preset" || !o.preset?.layouts) throw new Error("프리셋 파일이 아닙니다");
  return { name: String(o.name || "imported"), preset: o.preset as Preset };
}
