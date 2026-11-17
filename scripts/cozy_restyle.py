# Repaints a pastel sprite-sheet cat in the corner art's own style (2026-11-17 사용자: 기지개·그루밍·실타래
# 고양이가 그림체가 달라 보인다 — 색감 문제가 아니라 리소스를 비슷하게 만들어야 한다). Used by
# cozy_place_cats.py on the already-scaled sprite:
#   • detached marks (motion lines, sparkles) are dropped; the yarn and its string are kept
#   • pixels are sorted into fur / patch / pink (ears, nose, pads) / dark lines / yarn and repainted
#     with the corner cat's palette — warm white fur, grey-brown patches, dark brown lines — keeping
#     each pixel's own light/dark as shading
#   • the sprite's 2 px hard outline becomes the corner cat's thin soft edge
#   • light as in the scene: slightly darker towards the bottom, warm rim light along the top edges
#   • the pixel-art steps are softened a little inside the silhouette
import numpy as np


def neighbors_any(m, r=1):
    g = m.copy()
    for _ in range(r):
        h = g.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            h |= np.roll(g, (dy, dx), (0, 1))
        g = h
    return g


def components(mask):
    H, W = mask.shape
    lab = np.zeros((H, W), int); n = 0; sizes = {}
    for y0, x0 in zip(*np.nonzero(mask)):
        if lab[y0, x0]:
            continue
        n += 1; st = [(y0, x0)]; lab[y0, x0] = n; c = 0
        while st:
            y, x = st.pop(); c += 1
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    v, u = y + dy, x + dx
                    if 0 <= v < H and 0 <= u < W and mask[v, u] and not lab[v, u]:
                        lab[v, u] = n; st.append((v, u))
        sizes[n] = c
    return lab, sizes


def restyle(spr, keep_red=True):
    s = spr.copy()
    H, W = s.shape[:2]
    a = s[..., 3] > 40
    # drop small detached marks (motion lines, sparkles); keep the biggest parts (and yarn bits)
    lab, sizes = components(a)
    big = max(sizes.values())
    r0, g0, b0 = s[..., 0], s[..., 1], s[..., 2]
    for k, c in sizes.items():
        part = lab == k
        red = ((r0 - g0) > 60)[part].mean() > 0.4
        if c < max(25, big * 0.02) and not (keep_red and red and c > 40):
            s[part] = 0
    a = s[..., 3] > 40
    r, g, b = s[..., 0], s[..., 1], s[..., 2]
    L = 0.3 * r + 0.55 * g + 0.15 * b
    edge = a & neighbors_any(~a, 1)
    near = a & neighbors_any(~a, 2)
    yarn = a & (r - g > 60) & (r > 150)
    pink = a & ~yarn & (r - g > 48) & (r > 200) & (g < 185) & (b > g - 12)   # ears, nose, pads (not the orange patches)
    dark = a & (L < 135) & ~yarn
    patch = a & ~dark & ~pink & ~yarn & ((L < 205) | (r - g > 48))
    fur = a & ~dark & ~pink & ~yarn & ~patch
    out = s.copy()
    # palette of the corner cat: cool warm-white fur, grey-brown patches, dark brown lines
    FUR, PATCH, LINE = np.array([252, 245, 241.]), np.array([146, 112, 96.]), np.array([104, 76, 66.])
    def remap(mask, base, ref_mean, gain):
        rel = (L[mask] / max(1, ref_mean)) ** gain
        out[..., :3][mask] = np.clip(base[None, :] * rel[:, None], 0, 255)
    if fur.any():
        remap(fur, FUR, L[fur].mean(), 1.2)
    if patch.any():
        remap(patch, PATCH, L[patch].mean(), 1.6)
    out[..., :3][dark] = LINE * 0.5 + out[..., :3][dark] * 0.5 * np.array([0.8, 0.7, 0.65])
    # the sprite's 2 px hard outline: its inner pixel takes the fur / patch colour next to it
    inner_line = dark & near & ~edge
    if inner_line.any():
        fill = out[..., :3].copy(); cnt = np.zeros(a.shape, np.float32); acc = np.zeros_like(fill)
        ok = a & ~dark
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            m = np.roll(ok, (dy, dx), (0, 1))
            acc += np.roll(fill, (dy, dx), (0, 1)) * m[..., None]; cnt += m
        has = inner_line & (cnt > 0)
        out[..., :3][has] = (acc[has] / cnt[has][:, None])
    out[..., :3][pink] = out[..., :3][pink] * 0.6 + np.array([226, 150, 140.]) * 0.4
    # silhouette line: the corner cat has a thin soft brown edge, not a hard outline
    out[..., :3][edge & ~yarn] = out[..., :3][edge & ~yarn] * 0.6 + LINE * 0.4
    # light: shade towards the bottom (cooler), warm rim light on the top edges facing the window
    yy = np.mgrid[0:H, 0:W][0] / max(1, H - 1)
    shade = 1.0 - 0.1 * yy
    out[..., :3] *= shade[..., None] * np.array([1.0, 0.98, 1.0])[None, None, :]
    up = np.zeros_like(a)
    for k in (1, 2):
        up |= a & ~np.roll(a, k, 0)
    rim = up & ~yarn
    out[..., :3][rim] = out[..., :3][rim] * 0.35 + np.array([255, 190, 120.]) * 0.65
    # soften the pixel-art steps a little (inside the silhouette only)
    pm = out[..., :3] * a[..., None]
    acc = pm.copy(); cnt = a.astype(np.float32).copy()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        acc += np.roll(pm, (dy, dx), (0, 1)); cnt += np.roll(a, (dy, dx), (0, 1))
    soft = acc / np.maximum(cnt, 1)[..., None]
    out[..., :3] = np.where(a[..., None], out[..., :3] * 0.6 + soft * 0.4, 0)
    out[..., 3] = np.where(a, s[..., 3], 0)
    return out
