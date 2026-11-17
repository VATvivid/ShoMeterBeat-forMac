# One extra Cozy play pose from a single cat picture (2026-11-17: the user's 앉아 조는 고양이).
# Scales the cat (premultiplied box filter), warms it to the sunset light, sets it on the cat-less
# corner background on the rug with a soft contact shadow → corner_play<N>.png, and its sky mask
# corner_play<N>_sky.png = the other poses' sky masks combined, minus this cat's pixels.
#
#   python -I -X utf8 scripts/cozy_place_pose.py <cat.png> <catless.png> public/cozy <N> <width> <centre x> <bottom y>
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
m = spr[..., 3:4] > 0
spr[..., :3] = np.where(m, spr[..., :3] * np.array([1.0, 0.93, 0.85]) * np.linspace(0.92, 1.0, tw)[None, :, None] + np.array([10, 4, 0]), 0)
bg = np.array(Image.open(bg_p).convert("RGBA")).astype(np.float32)
H, W = bg.shape[:2]
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
