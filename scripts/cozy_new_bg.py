# Cozy corner, new background (2026-11-18 사용자: 새 배경에 맞게 새로 맞춘다). The user's cat-less
# room picture (1672×941, RGB on black) becomes the corner art:
#   1) padded to the scene's 5:3 (160×96 units) with black above (1672×941 → 1672×1003) — cropping the
#      left strip cut the big plant's leaves (2026-11-18 사용자: 좌측 식물 잎이 잘려 있어)
#   2) scaled to 800×480 (5 art px per scene unit)
#   3) keyed: the black surround (flood-filled from the border, near-black, plus enclosed black gaps) becomes transparent; its
#      anti-aliased rim gets a soft alpha from brightness with the black unmixed (F = I / alpha)
#
#   python -I -X utf8 scripts/cozy_new_bg.py <room.png> <out catless.png>
import sys, collections, numpy as np
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
W0, H0 = im.size
ph = round(W0 * 3 / 5)
pad = Image.new("RGB", (W0, ph), (0, 0, 0)); pad.paste(im, (0, ph - H0))
im = pad.resize((800, 480), Image.LANCZOS)
I = np.array(im).astype(np.float32)
H, W = I.shape[:2]
mx = I.max(2)
dark = mx < 14
bg = np.zeros((H, W), bool)
q = collections.deque()
for y in range(H):
    for x in (0, W - 1):
        if dark[y, x] and not bg[y, x]:
            bg[y, x] = True; q.append((y, x))
for x in range(W):
    for y in (0, H - 1):
        if dark[y, x] and not bg[y, x]:
            bg[y, x] = True; q.append((y, x))
while q:
    y, x = q.popleft()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        v, u = y + dy, x + dx
        if 0 <= v < H and 0 <= u < W and dark[v, u] and not bg[v, u]:
            bg[v, u] = True; q.append((v, u))
# gaps of the black surround enclosed by leaves / the lamp arm / the radio handle (not reached from the
# border): every near-black patch of ≥ 15 px is surround too — the painting has no pure black areas
dark2 = (mx < 20) & ~bg
seen = np.zeros_like(dark2)
for y0, x0 in zip(*np.nonzero(dark2)):
    if seen[y0, x0]:
        continue
    st, comp = [(y0, x0)], []
    seen[y0, x0] = True
    while st:
        y, x = st.pop(); comp.append((y, x))
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            v, u = y + dy, x + dx
            if 0 <= v < H and 0 <= u < W and dark2[v, u] and not seen[v, u]:
                seen[v, u] = True; st.append((v, u))
    if len(comp) >= 15:
        for y, x in comp:
            bg[y, x] = True
zone = bg.copy()
for _ in range(3):
    z = zone.copy()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        z |= np.roll(zone, (dy, dx), (0, 1))
    zone = z
t = np.clip((mx - 10) / 70, 0, 1)
A = np.where(zone, t * t * (3 - 2 * t), 1.0)
A[bg] = 0
F = np.clip(I / np.maximum(A[..., None], 0.2), 0, 255)
F = np.where(zone[..., None], F, I)
Image.fromarray(np.concatenate([F, A[..., None] * 255], 2).astype(np.uint8), "RGBA").save(out, optimize=True)
print("keyed", out, (W, H), "transparent %", round(float((A == 0).mean()) * 100, 1))
