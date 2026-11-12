// Unit test for the push-layout resolver (DOM-less). Usage: node scripts/push.test.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = { devicePixelRatio: 1, addEventListener() {}, innerWidth: 1280, innerHeight: 800 };
globalThis.document = { documentElement: {}, createElement: () => ({ style: {}, className: "", appendChild() {}, addEventListener() {}, getContext: () => new Proxy({}, { get: () => () => {} }) }), addEventListener() {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "#000000" });
globalThis.ImageData = class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
globalThis.ResizeObserver = class { observe() {} };
const bundle = pathToFileURL(fileURLToPath(new URL("../node_modules/.smoke/push.js", import.meta.url))).href;
const { resolvePush } = await import(bundle);

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const noOverlaps = (r) => { const ids = Object.keys(r); for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (overlap(r[ids[i]], r[ids[j]])) return `${ids[i]}×${ids[j]}`; return null; };
let bad = 0;
const check = (name, cond) => { console.log(cond ? "ok  " : "FAIL", name); if (!cond) bad++; };

// 1) Move A onto B in the free grid → B pushed below A.
let L = { a: { x: 0, y: 0, w: 12, h: 7, on: true }, b: { x: 12, y: 0, w: 12, h: 7, on: true } };
let r = resolvePush(L, "a", { x: 12, y: 0, w: 12, h: 7 }, "normal");
check("push down", noOverlaps(r) === null && r.b.y === 7);

// 2) No room below → B still pushed down; the grid grows (rows > 16).
L = { a: { x: 0, y: 0, w: 12, h: 16, on: true }, b: { x: 12, y: 0, w: 8, h: 16, on: true } };
r = resolvePush(L, "a", { x: 10, y: 0, w: 12, h: 16 }, "normal");
check("push down beyond base grid", noOverlaps(r) === null && r.b.y === 16);

// 3) Horizontal strip → B pushed right; columns grow.
L = { a: { x: 0, y: 0, w: 12, h: 1, on: true }, b: { x: 12, y: 0, w: 12, h: 1, on: true } };
r = resolvePush(L, "a", { x: 6, y: 0, w: 12, h: 1 }, "dockh");
check("push right in strip", noOverlaps(r) === null && r.b.x === 18 && r.b.w === 12);

// 4) Cascade: A pushes B, B pushes C.
L = { a: { x: 0, y: 0, w: 8, h: 4, on: true }, b: { x: 8, y: 0, w: 8, h: 4, on: true }, c: { x: 8, y: 4, w: 8, h: 4, on: true } };
r = resolvePush(L, "a", { x: 8, y: 0, w: 8, h: 4 }, "normal");
check("cascade", noOverlaps(r) === null && r.b.y === 4 && r.c.y === 8);

// 5) Off tiles are ignored.
L = { a: { x: 0, y: 0, w: 8, h: 4, on: true }, z: { x: 8, y: 0, w: 8, h: 4, on: false } };
r = resolvePush(L, "a", { x: 8, y: 0, w: 8, h: 4 }, "normal");
check("off ignored", !("z" in r));
process.exit(bad ? 1 : 0);
