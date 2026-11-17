# Cleans the window area behind the removed cat (2026-11-17 사용자: 창문 쪽 편집 흔적을 자연스럽게).
# The exemplar fill (cozy_remove_cat.py) left a blocky patch there: stair-stepped edges, stray ivy
# twigs, the mullion stopping in mid-air and the right pane cut on a diagonal. This refills every
# pixel that differs from the original corner art (= the old cat's place), row by row and band by
# band (left pane | mullion | right pane):
#   base   = a straight blend between the clean pixels just left and right of the hole on that row
#            (the window's sky haze, frame bars and wall are horizontal bands → seamless edges)
#   detail = the texture of the nearest clean rows above in the same band, minus their own mean
#            (keeps the painterly grain instead of a flat smear)
# The mullion is continued down from its clean part.
#
#   python -I -X utf8 scripts/cozy_window_fill.py <corner.png> <catless_in.png> <catless_out.png>
import sys, numpy as np
from PIL import Image

corner = np.array(Image.open(sys.argv[1]).convert("RGBA")).astype(np.float32)
img = np.array(Image.open(sys.argv[2]).convert("RGBA")).astype(np.float32)
H, W = img.shape[:2]
hole = np.abs(img[..., :3] - corner[..., :3]).sum(2) > 6
# grow by 1 px (anti-aliased rim of the old fill) and keep to the window / wall area
g = hole.copy()
for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
    g |= np.roll(hole, (dy, dx), (0, 1))
# close small gaps: the exemplar fill copied a few ear-outline pixels verbatim (identical to the
# original → not in the diff), which showed as thin "twigs" — a 3 px closing swallows them
for _ in range(3):
    d = g.copy()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        d |= np.roll(g, (dy, dx), (0, 1))
    g = d
for _ in range(3):
    e = g.copy()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        e &= np.roll(g, (dy, dx), (0, 1))
    g = e
yy, xx = np.mgrid[0:H, 0:W]
hole = g & (xx >= 219) & (xx <= 336) & (yy >= 140) & (yy <= 229)
# bands: left pane, mullion, right pane (x ranges, art px)
BANDS = [(219, 281), (281, 289), (289, 337)]
MULL_REF_Y = 172                                     # a clean row of the mullion in the original (right of the ear)
out = img.copy()
known = ~hole
for y in range(140, 230):
    for a, b in BANDS:
        row = hole[y, a:b]
        if not row.any():
            continue
        if (a, b) == (289, 337):
            continue                                 # right pane: copied from the left pane below
        if (a, b) == (281, 289) and y < 201:
            # mullion: carry its clean profile straight down to the bottom frame
            out[y, a:b, :3] = np.where(row[:, None], corner[MULL_REF_Y, a:b, :3], out[y, a:b, :3])
            continue
        if (a, b) == (281, 289):
            # below the window (frame bar, wall, floor) there is no mullion: same as the left pane's row
            out[y, a:b, :3] = np.where(row[:, None], out[y, a - 10:b - 10, :3], out[y, a:b, :3])
            continue
        xs = np.arange(a, b)
        kn = known[y, a:b]
        # anchors: nearest clean pixels on this row (inside the band, else just outside it)
        L = xs[kn & (xs < xs[row].min())]
        R = xs[kn & (xs > xs[row].max())]
        lx = L.max() if len(L) else a - 1
        rx = R.min() if len(R) else b
        lc = img[y, max(0, lx - 1):lx + 1, :3].mean(0) if known[y, lx] else None
        rc = img[y, rx:rx + 2, :3].mean(0) if rx < W and known[y, rx] else None
        if lc is None and rc is None:
            # no clean pixel on this row in reach: take the row above (already filled)
            lc = rc = out[y - 1, a:b, :3].mean(0)
        lc = rc if lc is None else lc
        rc = lc if rc is None else rc
        # detail: nearest clean rows above in this band
        det = np.zeros((b - a, 3), np.float32)
        # (only from a fully clean row a few px up, and faint — copied further it reads as vertical streaks)
        for k in range(1, 6):
            src = y - k
            if src < 0:
                break
            if known[src, a:b].all():
                seg = img[src, a:b, :3]
                det = (seg - seg.mean(0)) * 0.3
                break
        for x in xs[row]:
            t = (x - lx) / max(1, rx - lx)
            out[y, x, :3] = lc * (1 - t) + rc * t + det[x - a]
# right pane: the same horizontal bands as the left pane at the same height (haze, frame bar, wall);
# where the pane's own clean pixels sit on that row, blend towards them over 6 px so it stays seamless
for y in range(140, 230):
    row = hole[y, 289:337]
    if not row.any():
        continue
    for x in np.arange(289, 337)[row]:
        out[y, x, :3] = out[y, x - 58, :3]            # 289 → 231: inside the left pane, clear of its frame
    R = np.nonzero(~hole[y, 289:337] & (np.arange(289, 337) > np.arange(289, 337)[row].max()))[0]
    if len(R):
        rx = 289 + R.min()
        for d in range(1, 7):
            x = rx - d
            if hole[y, x]:
                t = d / 7
                out[y, x, :3] = out[y, x, :3] * t + img[y, rx, :3] * (1 - t)
# the right pane's top edge of the fill (below the plant) follows the old cat's back on a diagonal:
# fade the first 5 filled rows of each column into the clean pixel above
for x in range(289, 337):
    col = np.nonzero(hole[140:230, x])[0]
    if not len(col):
        continue
    ty = 140 + col.min()
    above = img[ty - 1, x, :3]
    for d in range(5):
        if hole[ty + d, x]:
            t = (d + 1) / 6
            out[ty + d, x, :3] = out[ty + d, x, :3] * t + above * (1 - t)
# soften the seam of the filled area by one pass of a 3×3 blur restricted to the hole
blur = out.copy()
for y in range(141, 229):
    for x in range(220, 336):
        if hole[y, x]:
            blur[y, x, :3] = out[y - 1:y + 2, x - 1:x + 2, :3].mean((0, 1)) * 0.4 + out[y, x, :3] * 0.6
Image.fromarray(blur.clip(0, 255).astype(np.uint8), "RGBA").save(sys.argv[3])
print("refilled", int(hole.sum()), "px")
