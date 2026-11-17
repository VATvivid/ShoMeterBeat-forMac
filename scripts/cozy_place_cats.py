# Cuts the three cats out of the user's sprite sheet, cleans the coloured fringe, scales them with a
# premultiplied box filter, repaints them in the corner cat's style (cozy_restyle.py), and composites each on the
# cat-less corner background (on the cushion) with a soft contact shadow → corner_play1..3.png.
import sys, os, subprocess, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cozy_restyle import restyle
FF = r"D:/MakeNew/진우컴퍼니NEW/output/Project/audio-converter/bin/ffmpeg.exe"
sheet, bg_path, outdir = sys.argv[1:4]
# one scale for all three cats (they are drawn at one scale on the sheet), chosen so they match the
# corner's own cat (2026-11-17 사용자: 고양이들 사이즈 맞춰, 기지개가 작아 보이고 그림체가 달라 보여)
K = float(sys.argv[4]) if len(sys.argv) > 4 else 0.215
def load(p):
    info = subprocess.run([FF, "-i", p], capture_output=True, text=True, encoding="utf-8", errors="replace").stderr
    import re
    w, h = map(int, re.search(r"(\d{2,5})x(\d{2,5})", info.split("Stream")[1]).groups())
    a = np.frombuffer(subprocess.run([FF, "-v", "error", "-i", p, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], capture_output=True, check=True).stdout, np.uint8)
    return a.reshape(h, w, 4).astype(np.float32)
def save(a, p):
    h, w = a.shape[:2]
    subprocess.run([FF, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-i", "-", "-frames:v", "1", "-update", "1", p], input=a.clip(0, 255).astype(np.uint8).tobytes(), check=True)
S = load(sheet); H0, W0 = S.shape[:2]
r, g, b, al = S[..., 0], S[..., 1], S[..., 2], S[..., 3]
opaque = al > 8
# fringe: strongly saturated red / yellow pixels within 4 px of transparency
near = np.zeros_like(opaque)
t = ~opaque
for k in range(1, 5):
    for dy, dx in ((k, 0), (-k, 0), (0, k), (0, -k)): near |= np.roll(t, (dy, dx), (0, 1))
fringe = near & opaque & (((r > 170) & (g < 110) & (b < 110)) | ((r > 180) & (g > 150) & (b < 100)))
S[fringe, 3] = 0
opaque = S[..., 3] > 8
# split into the three cats by empty columns
cols = opaque.any(0)
runs, inrun = [], False
for x, c in enumerate(cols):
    if c and not inrun: start, inrun = x, True
    if not c and inrun: runs.append((start, x)); inrun = False
if inrun: runs.append((start, W0))
runs = [rr for rr in runs if rr[1] - rr[0] > 60]
# merge small gaps (whisker tufts etc.)
merged = []
for rr in runs:
    if merged and rr[0] - merged[-1][1] < 40: merged[-1] = (merged[-1][0], rr[1])
    else: merged.append(rr)
print("cats at columns", merged)
bg = load(bg_path)
H, W = bg.shape[:2]
def box_down(spr, tw):
    """premultiplied area downscale to width tw"""
    h, w = spr.shape[:2]
    th = max(1, round(h * tw / w))
    pm = spr.copy(); pm[..., :3] *= pm[..., 3:4] / 255.0
    ys = np.linspace(0, h, th + 1).astype(int); xs = np.linspace(0, w, tw + 1).astype(int)
    out = np.zeros((th, tw, 4), np.float32)
    cs = pm.cumsum(0).cumsum(1); cs = np.pad(cs, ((1, 0), (1, 0), (0, 0)))
    for i in range(th):
        for j in range(tw):
            y0, y1, x0, x1 = ys[i], ys[i + 1], xs[j], xs[j + 1]
            s = cs[y1, x1] - cs[y0, x1] - cs[y1, x0] + cs[y0, x0]
            out[i, j] = s / max(1, (y1 - y0) * (x1 - x0))
    a = out[..., 3:4]
    out[..., :3] = np.where(a > 0, out[..., :3] / (a / 255.0 + 1e-6), 0)
    return out
# per cat: (centre x, bottom y) on the rug
spec = [(298, 248), (292, 248), (300, 248)]
for n, ((x0, x1), (cx, by)) in enumerate(zip(merged, spec), start=1):
    tw = round((x1 - x0) * K)
    crop = S[:, x0:x1]
    rows = np.nonzero((crop[..., 3] > 8).any(1))[0]
    crop = crop[rows[0]:rows[-1] + 1]
    spr = box_down(crop, tw)
    hh, ww = spr.shape[:2]
    # repaint in the corner cat's style (cozy_restyle.py), then the room's warm evening light
    spr = restyle(spr, keep_red=(n == 1))
    spr[..., :3] = spr[..., :3] * np.array([1.0, 0.96, 0.92], np.float32) * np.linspace(0.94, 1.0, ww)[None, :, None]
    out = bg.copy()
    X0, Y0 = int(cx - ww / 2), int(by - hh)
    # contact shadow on the cushion
    yy, xx = np.mgrid[0:H, 0:W]
    d = ((xx - cx) / (ww * 0.48)) ** 2 + ((yy - (by - 1)) / 3.2) ** 2
    sh = 0.35 * np.clip(1 - d, 0, 1) ** 1.3
    out[..., :3] = out[..., :3] * (1 - sh[..., None]) + np.array([60, 35, 30]) * sh[..., None]
    reg = out[Y0:Y0 + hh, X0:X0 + ww]
    a = spr[..., 3:4] / 255.0
    reg[..., :3] = reg[..., :3] * (1 - a) + spr[..., :3] * a
    reg[..., 3:4] = np.maximum(reg[..., 3:4], spr[..., 3:4])
    save(out, f"{outdir}/corner_play{n}.png")
    pv = out[120:257, 190:424]
    save(np.kron(pv, np.ones((2, 2, 1))), f"{outdir}/play{n}_prev.png")
    print("cat", n, "size", ww, hh, "at", X0, Y0)
