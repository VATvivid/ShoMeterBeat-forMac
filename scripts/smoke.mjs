// Node smoke test: stub the DOM, run every module's draw() for 120 frames at 3 tile
// sizes against the synthetic source. Usage: npm run smoke
import { fileURLToPath, pathToFileURL } from "node:url";
const calls = new Set();
const ctxProxy = () => new Proxy({}, {
  get: (_, k) => {
    if (k === "measureText") return () => ({ width: 10 });
    if (k === "createLinearGradient") return () => ({ addColorStop() {} });
    return typeof k === "string" ? (() => { calls.add(k); }) : undefined;
  },
  set: () => true,
});
const mkCanvas = () => ({ width: 1, height: 1, style: {}, getContext: () => ctxProxy(), parentElement: null });
const vars = { "--sig": "#2eddc4", "--sig-2": "#5b8cff", "--peak": "#ff9843", "--clip": "#ff4d5e", "--target": "#f2d16b", "--grid": "#23262c", "--line": "#2b2f36", "--fg-0": "#e6e8ec", "--fg-1": "#9aa1ab", "--fg-2": "#5f6671", "--bg-3": "#262a31", "--map-0": "#0e0f12", "--map-1": "#1b2a6b", "--map-2": "#2eddc4", "--map-3": "#f2f5a0", "--font": "Inter" };
globalThis.window = { devicePixelRatio: 1 };
globalThis.document = { documentElement: {}, createElement: (t) => t === "canvas" ? mkCanvas() : { style: {}, className: "", appendChild() {}, addEventListener() {}, value: "-14", textContent: "" } };
globalThis.getComputedStyle = () => ({ getPropertyValue: (k) => vars[k] ?? "" });
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.ImageData = class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
const bundle = pathToFileURL(fileURLToPath(new URL("../node_modules/.smoke/smoke.js", import.meta.url))).href;
const { MODULES, createSource } = await import(bundle);
const src = createSource();
let bad = 0;
for (const [id, mk] of Object.entries(MODULES)) {
  const m = mk();
  m.headControl?.();
  for (const [w, h] of [[640, 300], [260, 180], [120, 90]]) {
    m.resize?.(w, h);
    for (let i = 0; i < 120; i++) {
      const f = await src.tick();
      try { m.draw({ ctx: ctxProxy(), w, h, dt: 1 / 60 }, f); m.headReadout?.(f); }
      catch (e) { bad++; console.log("FAIL", id, w, h, e.stack.split("\n").slice(0, 3).join(" | ")); break; }
    }
  }
  console.log("ok", id);
}
console.log("canvas API used:", [...calls].sort().join(", "));
process.exit(bad ? 1 : 0);
