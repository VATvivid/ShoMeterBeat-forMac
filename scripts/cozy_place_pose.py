# One extra Cozy play pose from a single cat picture (2026-11-17: the user's 앉아 조는 고양이).
# Scales the cat (premultiplied box filter), warms it to the sunset light, sets it on the cat-less
# corner background on the rug with a soft contact shadow → corner_play<N>.png, and its sky mask
# corner_play<N>_sky.png = the other poses' sky masks combined, minus this cat's pixels.
#
#   python -I -X utf8 scripts/cozy_place_pose.py <cat.png> <catless.png> public/cozy <N> <width> <centre x> <bottom y> [corner.png]
# (with corner.png the colours go half-way to the corner's own cat, like cozy_place_cats.py)
import sys, os, numpy as np
from PIL import Image

cat_p, bg_p, outdir, n, tw, cx, by = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), float(sys.argv[6]), float(sys.argv[7])
cat = Image.open(cat_p).convert("RGBA")
a = np.array(cat).astype(np.float32)
a[a[..., 3] < 10] = 0
ys, xs = np.nonzero(a[..., 3] > 0)
cat = Image.fromarray(a[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.uint8), "RGBA")
th = round(cat.height * tw / cat.width)
spr = np.array(cat.resize((tw, th), Image.BOX)).astype(np.float32)
m = spr[..., 3] > 20
bg = np.array(Image.open(bg_p).convert("RGBA")).astype(np.float32)
H, W = bg.shape[:2]
# tone: match the colour statistics (per-channel mean / spread) of the cats already in the poses
# (pastel sprite-sheet cats, 2026-11-17 사용자: 톤앤매너가 달라졌어) — the existing poses differ
# from the cat-less background only where their cat is
ref = []
REF = sys.argv[8] if len(sys.argv) > 8 else None    # corner.png: same colour reference as cozy_place_cats.py
if REF:
    C = np.array(Image.open(REF).convert("RGBA")).astype(np.float32)
    diff = np.abs(C[..., :3] - bg[..., :3]).sum(2) > 18
    diff[:, :225] = False; diff[:, 375:] = False
    ref.append(C[diff][:, :3])
for k in (range(1, n) if not REF else []):
    p = os.path.join(outdir, f"corner_play{k}.png")
    if os.path.exists(p):
        q = np.array(Image.open(p).convert("RGBA")).astype(np.float32)
        ref.append(q[np.abs(q[..., :3] - bg[..., :3]).sum(2) > 30][:, :3])
if ref:
    ref = np.concatenate(ref)
    px = spr[m][:, :3]
    matched = ((px - px.mean(0)) / (px.std(0) + 1e-6)) * ref.std(0) + ref.mean(0)
    spr[..., :3][m] = matched if not REF else px * 0.5 + matched * 0.5
else:
    spr[..., :3][m] = spr[..., :3][m] * np.array([1.0, 0.93, 0.85]) + np.array([10, 4, 0])
spr[~m] = 0
# the sprite-sheet cats have a thin soft brown outline: add one around the silhouette
spr = np.pad(spr, ((1, 1), (1, 1), (0, 0)))
m = np.pad(m, 1)
ring = np.zeros_like(m)
for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
    ring |= np.roll(m, (dy, dx), (0, 1))
ring &= ~m
spr[ring] = [150, 98, 80, 190]
tw, th = tw + 2, th + 2
out = bg.copy()
yy, xx = np.mgrid[0:H, 0:W]
d = ((xx - cx) / (tw * 0.46)) ** 2 + ((yy - (by - 1)) / 3.2) ** 2
sh = 0.35 * np.clip(1 - d, 0, 1) ** 1.3
out[..., :3] = out[..., :3] * (1 - sh[..., None]) + np.array([60, 35, 30]) * sh[..., None]
X0, Y0 = int(round(cx - tw / 2)), int(round(by - th))
reg = out[Y0:Y0 + th, X0:X0 + tw]
al = spr[..., 3:4] / 255.0
reg[..., :3] = reg[..., :3] * (1 - al) + spr[..., :3] * al
reg[..., 3:4] = np.maximum(reg[..., 3:4], spr[..., 3:4])
Image.fromarray(out.clip(0, 255).astype(np.uint8), "RGBA").save(os.path.join(outdir, f"corner_play{n}.png"))
# sky mask: union of the existing poses' masks (each lacks only its own cat), minus this cat
sky = np.zeros((H, W), np.float32)
for k in range(1, n):
    p = os.path.join(outdir, f"corner_play{k}_sky.png")
    if os.path.exists(p):
        sky = np.maximum(sky, np.array(Image.open(p).convert("RGBA"))[..., 3].astype(np.float32))
catpx = np.zeros((H, W), bool)
catpx[Y0:Y0 + th, X0:X0 + tw] = spr[..., 3] > 20
sky[catpx] = 0
mask = np.zeros((H, W, 4), np.uint8)
mask[..., :3] = 255
mask[..., 3] = sky.astype(np.uint8)
Image.fromarray(mask, "RGBA").save(os.path.join(outdir, f"corner_play{n}_sky.png"))
print("pose", n, "size", tw, th, "at", X0, Y0)
