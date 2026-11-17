# Sleeping pose from the awake corner art (2026-11-17, v3).
# The pose is v1's — head lowered D px and tipped T rad around the neck, resting on the paws
# (사용자: 아까처럼 엎드리는 게 맞고, 어깨랑 목이 자연스러워야 해). v1 cut the head out and pasted it
# lower, which left a hard break at the neck and window showing between head and shoulder. v3:
#   1) the whole cat is bent with the same move, faded out smoothly towards the back and the chest,
#      so neck and shoulders stretch as one piece of fur (no seam, no gap);
#   2) the head itself is then laid on top, moved rigidly (crisp, not stretched), its edge feathered
#      so it melts into that fur — it covers the chest / paws the way a lowered head would.
# The cat is lifted off the picture with the cat-less background (cozy_remove_cat.py +
# cozy_window_fill.py), so whatever the head uncovers is that clean window.
#
#   python -I -X utf8 scripts/cozy_sleep_pose.py <corner.png> <catless.png> <out.png> [D=15] [T=-0.28]
import sys, numpy as np
from PIL import Image

src, bgp, out = sys.argv[1], sys.argv[2], sys.argv[3]
D = float(sys.argv[4]) if len(sys.argv) > 4 else 15.0
T = float(sys.argv[5]) if len(sys.argv) > 5 else -0.28
img = np.array(Image.open(src).convert("RGBA")).astype(np.float32)
bg = np.array(Image.open(bgp).convert("RGBA")).astype(np.float32)
H, W = img.shape[:2]
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
# the cat = where the picture differs from the cat-less background
cat = (np.abs(img[..., :3] - bg[..., :3]).sum(2) > 18).astype(np.float32)
cat[:, :225] = 0
cat[:, 375:] = 0


def grow(m, n=1):
    for _ in range(n):
        g = m.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            g = np.maximum(g, np.roll(m, (dy, dx), (0, 1)))
        m = g
    return m


def blur(m, n=1):
    for _ in range(n):
        m = (m + np.roll(m, 1, 0) + np.roll(m, -1, 0) + np.roll(m, 1, 1) + np.roll(m, -1, 1)) / 5
    return m


alpha = np.clip(blur(cat, 1) * 1.6, 0, 1) * cat
layer = img.copy()
layer[..., 3] = alpha * 255


def smooth(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def sample(a, sx, sy):
    x0 = np.floor(sx).astype(int); y0 = np.floor(sy).astype(int)
    fx = (sx - x0)[..., None]; fy = (sy - y0)[..., None]
    x0c, x1c = x0.clip(0, W - 1), (x0 + 1).clip(0, W - 1)
    y0c, y1c = y0.clip(0, H - 1), (y0 + 1).clip(0, H - 1)
    pm = a.copy(); pm[..., :3] *= pm[..., 3:4] / 255     # premultiplied bilinear
    v = (pm[y0c, x0c] * (1 - fx) * (1 - fy) + pm[y0c, x1c] * fx * (1 - fy) + pm[y1c, x0c] * (1 - fx) * fy + pm[y1c, x1c] * fx * fy)
    v[..., :3] /= np.maximum(v[..., 3:4], 1e-3) / 255
    return v


# the head's move as a backward map (output pixel → source pixel): lowered D, tipped T around the neck
PX, PY = 277.0, 210.0
c, s = np.cos(T), np.sin(T)
ox, oy = xx - PX, yy - D - PY
rsx = c * ox + s * oy + PX
rsy = -s * ox + c * oy + PY
# 1) bend: the same move, faded out towards the back (x 270 → 312) and the chest (y 205 → 242);
#    the ramps are long enough that the map never folds
w = smooth((312 - xx) / 42) * smooth((242 - yy) / 37)
ell = (((xx - 263) / 27) ** 2 + ((yy - 183) / 27) ** 2 <= 1)
r, g, b = img[..., 0], img[..., 1], img[..., 2]
ears = (xx >= 238) & (xx <= 292) & (yy >= 150) & (yy <= 182) & (r > b + 10)
headm = ((ell | ears) & (yy < 206)).astype(np.float32) * cat
# the bent body leaves out the head and its pale ear rims (else they trail behind as a ghost);
# the head laid on top covers that place
earzone = ((xx >= 236) & (xx <= 296) & (yy >= 148) & (yy < 196)).astype(np.float32)
nobody = np.maximum(grow(headm, 3) * (yy < 200), earzone * cat)
blayer = layer.copy()
blayer[..., 3] *= 1 - nobody
body = sample(blayer, xx + w * (rsx - xx), yy + w * (rsy - yy))
# 2) the head, moved rigidly, laid on top with a feathered edge
headm = np.maximum(headm, earzone * cat)              # the whole ears, rims included, go with the head
headm = blur(headm, 3)                                  # ~3 px soft edge into the bent fur
head = img.copy()
head[..., 3] = np.clip(headm * 1.4, 0, 1) * 255
head = sample(head, rsx, rsy)


def over(dst, srcl):
    a = srcl[..., 3:4] / 255
    o = dst.copy()
    o[..., :3] = dst[..., :3] * (1 - a) + srcl[..., :3] * a
    o[..., 3] = np.maximum(dst[..., 3], srcl[..., 3])
    return o


res = over(over(bg, body), head)
Image.fromarray(res.clip(0, 255).astype(np.uint8), "RGBA").save(out)
print("sleep pose: head down", D, "px, tipped", T, "rad")
