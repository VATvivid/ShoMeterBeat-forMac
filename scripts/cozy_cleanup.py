# Keying clean-up of the Cozy corner art (2026-11-17 사용자: 라디오 위 연기·음표, 커피잔 위 하얀 선
# 제거, 스탠드 쪽 덤불과 라디오 위 창가·덤불 사이 누끼 확인해서 빼기). The mock-up the art was cut from
# had drawn effects (smoke, a ♪, dotted steam) and washed-out ivy whose keying left pale specks; the
# module draws its own notes and steam, so these go. The mask is computed once on corner.png and
# applied to every picture that shares its composition (sleep / play poses, sky masks, cat-less
# background) — the regions hold no cat, so the same pixels are removed everywhere.
#
#   python -I -X utf8 scripts/cozy_cleanup.py public/cozy/corner.png <file> [<file> …]
import sys, numpy as np
from PIL import Image

ref = np.array(Image.open(sys.argv[1]).convert("RGBA")).astype(np.int32)
H, W = ref.shape[:2]
yy, xx = np.mgrid[0:H, 0:W]
r, g, b = ref[..., 0], ref[..., 1], ref[..., 2]
mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
rope = (r - b > 60) & (r > 120)                          # the lamp's orange-brown rope and hook

rm = np.zeros((H, W), bool)
# 1) the drawn smoke squiggle, the ♪ and the dotted steam above the radio / books
rm |= (xx >= 105) & (xx < 205) & (yy >= 95) & (yy < 153)
rm |= (xx >= 105) & (xx < 140) & (yy >= 95) & (yy < 179)
# 2) the white steam lines above the coffee cup (pale, unsaturated pixels above its rim)
rm |= (xx >= 128) & (xx < 152) & (yy >= 172) & (yy < 197) & (mn > 140) & (mx - mn < 60)
# 3) left of the window, above the radio: washed-out ivy and sky scraps outside the frame
rm |= (xx < 203) & (yy >= 40) & (yy < 153)
rm |= (xx >= 203) & (xx < 209) & (yy >= 40) & (yy < 153) & (b > r - 4)
# 4) above the lamp and down the right edge: only the washed-out ivy (khaki) and the pale keying
#    specks — the wall behind the lamp stays, so no straight cut lines appear
foliage = (r > b + 15) & (g > b + 8) & (mx - mn < 90) & (mx < 215)
speck = (mn > 170) & (b >= r - 10)
top = ((xx >= 300) & (yy < 40)) | ((xx >= 398) & (yy < 88))
rm |= top & (foliage | speck) & ~rope
# the ivy's brown stems away from the lamp (the rope and hook hang between x 355 and 398)
rm |= top & rope & ((xx >= 398) | (xx < 355))
# the last curl of steam left of the cup, between the book stack and the mug
rm |= (xx >= 131) & (xx < 147) & (yy >= 174) & (yy < 196)
# 5) whatever is left floating in the cleaned zones in tiny pieces (< 30 px) goes too
zone = top | ((xx < 209) & (yy >= 40) & (yy < 153)) | ((xx >= 105) & (xx < 205) & (yy >= 95) & (yy < 153))
alive = (ref[..., 3] > 0) & ~rm & zone
seen = np.zeros_like(alive)
for y0, x0 in zip(*np.nonzero(alive)):
    if seen[y0, x0]:
        continue
    stack, comp = [(y0, x0)], []
    seen[y0, x0] = True
    while stack:
        y, x = stack.pop(); comp.append((y, x))
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            v, u = y + dy, x + dx
            if 0 <= v < H and 0 <= u < W and alive[v, u] and not seen[v, u]:
                seen[v, u] = True; stack.append((v, u))
    if len(comp) < 30:
        for y, x in comp:
            rm[y, x] = True

# right of the lamp shade the ivy hung over the room's wall: there the leaves / stems are painted
# over with the wall (per-row mean of the clean wall pixels), not cut out — cutting left holes
wallzone = (xx >= 398) & (yy >= 40) & (yy < 88) & (ref[..., 3] > 0)
paint = rm & wallzone
rm &= ~paint
# …and the thin ivy stems running over that wall: pixels clearly darker than the wall around them
# (local 7×7 median), filled from their non-stem neighbours — keeps the wall's own shading. The
# lamp shade (x < 406 below y 62) is left alone.
stemzone = (((xx >= 385) & (yy >= 40) & (yy < 62)) | ((xx >= 406) & (yy >= 62) & (yy < 88))) & (ref[..., 3] > 0)
Lum = (0.3 * r + 0.55 * g + 0.15 * b).astype(np.float32)
stem = np.zeros((H, W), bool)
for y, x in zip(*np.nonzero(stemzone)):
    win = Lum[max(0, y - 3):y + 4, max(0, x - 3):x + 4]
    if Lum[y, x] < np.median(win) - 14:
        stem[y, x] = True
stem = stem & ~paint
stemfill = {}
for y, x in zip(*np.nonzero(stem)):
    y0, y1, x0, x1 = max(0, y - 3), y + 4, max(0, x - 3), x + 4
    ok = ~stem[y0:y1, x0:x1] & (ref[y0:y1, x0:x1, 3] > 0)
    if ok.any():
        stemfill[(y, x)] = ref[y0:y1, x0:x1, :3][ok].mean(0)
wall = wallzone & ~paint & (b >= r - 12) & (mx > 120) & (mx - mn < 70)
rowcol = np.zeros((H, 3), np.float32)
have = np.zeros(H, bool)
for y in range(40, 88):
    m = wall[y]
    if m.sum() >= 3:
        rowcol[y] = ref[y][m][:, :3].mean(0); have[y] = True
ys = np.nonzero(have)[0]
for y in range(40, 88):
    if not have[y] and len(ys):
        rowcol[y] = rowcol[ys[np.argmin(np.abs(ys - y))]]
rng = np.random.default_rng(3)

for p in sys.argv[2:]:
    im = np.array(Image.open(p).convert("RGBA"))
    if im.shape[:2] != (H, W):
        print("skip (size)", p)
        continue
    is_mask = im[..., :3].min() > 250                     # the white-on-alpha sky masks: nothing to paint
    if not is_mask:
        py, px = np.nonzero(paint)
        im[py, px, :3] = np.clip(rowcol[py] + rng.normal(0, 3, (len(py), 3)), 0, 255).astype(np.uint8)
        for (y, x), c in stemfill.items():
            im[y, x, :3] = c.astype(np.uint8)
    else:
        im[paint, 3] = 0
    im[rm, 3] = 0
    Image.fromarray(im, "RGBA").save(p, optimize=True)
    print("cleaned", p)
print("removed", int(rm.sum()), "px")
