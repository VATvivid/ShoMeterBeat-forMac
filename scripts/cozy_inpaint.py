# Exemplar-based in-painting (Criminisi-style): fills a hole by copying real texture patches from
# the surrounding picture instead of blurring, filling the most "structured" border pixels first so
# lines (window frame, sill, rug edge) carry into the hole. Pure numpy.
import numpy as np


def inpaint(rgb, hole, patch=7, search=(48, 90), seed=0, exclude=None):
    """rgb: (H, W, 3) float; hole: (H, W) bool → filled copy of rgb.
    search = (dy, dx) half-size of the window the source patches are taken from.
    exclude: optional (H, W) bool of pixels that must never be used as a source."""
    H, W, _ = rgb.shape
    img = rgb.astype(np.float32).copy()
    mask = hole.copy()
    conf = (~mask).astype(np.float32)
    h = patch // 2
    bad = mask.copy() if exclude is None else (mask | exclude)
    # valid source centres: whole patch inside the image and away from hole/excluded pixels
    from numpy.lib.stride_tricks import sliding_window_view as swv
    badp = np.pad(bad, h, constant_values=True)
    src_ok = ~swv(badp, (patch, patch)).any(axis=(2, 3))
    gy, gx = np.gradient(img.mean(2))
    it = 0
    while mask.any():
        it += 1
        # border of the hole
        m = mask
        border = m & (np.roll(~m, 1, 0) | np.roll(~m, -1, 0) | np.roll(~m, 1, 1) | np.roll(~m, -1, 1))
        ys, xs = np.nonzero(border)
        # priority = confidence (mean over patch) × data term (strength of the isophote at the edge)
        cp = np.pad(conf, h)
        C = np.array([cp[y:y + patch, x:x + patch].mean() for y, x in zip(ys, xs)])
        gyp, gxp = np.pad(gy * ~m, h), np.pad(gx * ~m, h)
        D = np.array([np.hypot(gyp[y:y + patch, x:x + patch], gxp[y:y + patch, x:x + patch]).max() for y, x in zip(ys, xs)]) / 255.0 + 0.001
        k = int(np.argmax(C * D))
        y, x = ys[k], xs[k]
        y0, y1, x0, x1 = max(0, y - h), min(H, y + h + 1), max(0, x - h), min(W, x + h + 1)
        tgt = img[y0:y1, x0:x1]; known = ~mask[y0:y1, x0:x1]
        # candidate source patches within the search window
        sy0, sy1 = max(h, y - search[0]), min(H - h, y + search[0] + 1)
        sx0, sx1 = max(h, x - search[1]), min(W - h, x + search[1] + 1)
        cy, cx = np.nonzero(src_ok[sy0:sy1, sx0:sx1]); cy += sy0; cx += sx0
        if len(cy) == 0:
            sy0, sy1, sx0, sx1 = h, H - h, h, W - h
            cy, cx = np.nonzero(src_ok[sy0:sy1, sx0:sx1]); cy += sy0; cx += sx0
        oy, ox = y0 - y, x0 - x
        ph, pw = y1 - y0, x1 - x0
        best, bi = None, 0
        # vectorised SSD over known pixels, in chunks
        kn = known[..., None].astype(np.float32)
        for s in range(0, len(cy), 4000):
            yy, xx = cy[s:s + 4000], cx[s:s + 4000]
            P = np.stack([img[yy + oy + i, :][:, None, :, :][np.arange(len(yy)), 0, xx + ox, :][:, None, :] if False else None for i in range(0)]) if False else None
            pat = np.empty((len(yy), ph, pw, 3), np.float32)
            for i in range(ph):
                for j in range(pw):
                    pat[:, i, j] = img[yy + oy + i, xx + ox + j]
            d = (((pat - tgt[None]) ** 2) * kn[None]).sum(axis=(1, 2, 3))
            d += 0.02 * ((yy - y) ** 2 + (xx - x) ** 2)          # slight preference for nearby texture
            j = int(np.argmin(d))
            if best is None or d[j] < best:
                best, bi = d[j], s + j
        sy, sx = cy[bi], cx[bi]
        src = img[sy + oy:sy + oy + ph, sx + ox:sx + ox + pw]
        fill = mask[y0:y1, x0:x1]
        img[y0:y1, x0:x1][fill] = src[fill]
        conf[y0:y1, x0:x1][fill] = C[k]
        mask[y0:y1, x0:x1][fill] = False
    return img
