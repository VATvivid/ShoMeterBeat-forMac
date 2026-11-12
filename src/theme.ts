// Colors come from CSS tokens (DESIGN.md §2) — never hard-code hex in modules.
const cache = new Map<string, string>();

export function theme(token: string): string {
  let v = cache.get(token);
  if (!v) {
    v = getComputedStyle(document.documentElement).getPropertyValue(`--${token}`).trim() || "#ff00ff";
    cache.set(token, v);
  }
  return v;
}

export function withAlpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export const FONT = getComputedStyle(document.documentElement).getPropertyValue("--font").trim() || "system-ui";

export function font(px: number, weight = 400): string {
  return `${weight} ${px}px ${FONT}`;
}

/** 4-stop spectrogram ramp sampled into 256 RGB entries. */
export function colorMap(): Uint8ClampedArray {
  const stops = ["map-0", "map-1", "map-2", "map-3"].map((t) => {
    const h = theme(t).replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  });
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(p));
    const t = p - k;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * t;
  }
  return out;
}
