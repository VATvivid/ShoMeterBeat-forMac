# Sleeping pose from the awake corner art: lift the cat's head out (ellipse + ear boxes, fur-coloured
# pixels only for the ears), fill the hole by harmonic in-painting (Jacobi), then paste the head
# lowered by D px and rotated by T rad around the neck. Writes RGBA PNG + a side-by-side preview.
import sys, subprocess, numpy as np
FF = r"D:/MakeNew/진우컴퍼니NEW/output/Project/audio-converter/bin/ffmpeg.exe"
src, out, prev = sys.argv[1], sys.argv[2], sys.argv[3]
D, T = float(sys.argv[4]), float(sys.argv[5])
W, H = 424, 257
img = np.frombuffer(subprocess.run([FF, "-v", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], capture_output=True, check=True).stdout, np.uint8).reshape(H, W, 4).astype(np.float32)
yy, xx = np.mgrid[0:H, 0:W]
r, g, b = img[..., 0], img[..., 1], img[..., 2]
fur = ~((b > r + 4) & (b > g))              # window/sky is bluish; fur is white / brown / orange
ell = ((xx - 263) / 27) ** 2 + ((yy - 183) / 27) ** 2 <= 1
ears = ((xx >= 238) & (xx <= 290) & (yy >= 150) & (yy <= 172)) & fur
warm = (r > b + 10)                          # ear fur / rim light is warm; the pale window mullion is not
ears = ((xx >= 238) & (xx <= 292) & (yy >= 150) & (yy <= 182)) & warm
M = (ell | ears) & (yy < 206)                # hole to fill (incl. the mullion strip behind the right ear)
# grow mask by 1 px to swallow anti-aliased fringes
Mg = M.copy()
for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)): Mg |= np.roll(M, (dy, dx), (0, 1))
M = Mg & (yy < 206)
# harmonic fill of the hole (background behind the head)
plate = img.copy()
plate[M] = 0
ys, xs = np.where(M)
y0, y1, x0, x1 = ys.min() - 1, ys.max() + 2, xs.min() - 1, xs.max() + 2
sub = plate[y0:y1, x0:x1, :3].copy(); m = M[y0:y1, x0:x1]
sub[m] = sub[~m].mean(0)
for _ in range(1500):
    avg = (np.roll(sub, 1, 0) + np.roll(sub, -1, 0) + np.roll(sub, 1, 1) + np.roll(sub, -1, 1)) / 4
    sub[m] = avg[m]
# a little grain so the fill does not read as a smooth blob
rng = np.random.default_rng(1)
sub[m] += rng.normal(0, 2.0, (m.sum(), 3))
plate[y0:y1, x0:x1, :3] = sub
plate[M, 3] = 255
# lowered + tilted head
px, py = 263 + 14, 183 + 27      # neck pivot (lower right of the head)
c, s = np.cos(T), np.sin(T)
ox, oy = xx - px, yy - D - py
sx = c * ox + s * oy + px; sy = -s * ox + c * oy + py
sxi, syi = np.rint(sx).astype(int).clip(0, W - 1), np.rint(sy).astype(int).clip(0, H - 1)
P = M & ~((xx > 277) & (yy < 182))          # what moves with the head (not the mullion strip)
take = P[syi, sxi] & (sx >= 0) & (sx < W) & (sy >= 0) & (sy < H)
res = plate.copy()
res[take] = img[syi[take], sxi[take]]
o = res.clip(0, 255).astype(np.uint8)
subprocess.run([FF, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{W}x{H}", "-i", "-", "-frames:v", "1", "-update", "1", out], input=o.tobytes(), check=True)
both = np.concatenate([img[130:240, 200:330], res[130:240, 200:330]], 1).clip(0, 255).astype(np.uint8)
h, w = both.shape[:2]
subprocess.run([FF, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-i", "-", "-vf", "scale=iw*4:ih*4:flags=neighbor", "-frames:v", "1", "-update", "1", prev], input=both.tobytes(), check=True)
print("ok", int(M.sum()), "px masked")
