# Removes the lying cat from the corner art and rebuilds what is behind it with exemplar in-painting.
import sys, subprocess, numpy as np, time
sys.path.insert(0, ".")
from inpaint import inpaint
FF = r"D:/MakeNew/진우컴퍼니NEW/output/Project/audio-converter/bin/ffmpeg.exe"
src, out, prev = sys.argv[1:4]
W, H = 424, 257
img = np.frombuffer(subprocess.run([FF, "-v", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], capture_output=True, check=True).stdout, np.uint8).reshape(H, W, 4).copy()
# cat outline traced on the 4× zoom (crop origin 200,120) → art pixels
poly = [(175,160),(230,195),(270,190),(290,150),(310,195),(340,250),(380,262),(470,270),(560,285),(610,320),(640,380),(652,440),(640,482),(560,502),(450,497),(300,492),(160,478),(138,446),(148,420),(182,400),(163,360),(153,300),(163,240),(173,200)]
poly = [(200 + x / 4, 120 + y / 4) for x, y in poly]
yy, xx = np.mgrid[0:H, 0:W]
inside = np.zeros((H, W), bool)
n = len(poly)
for i in range(n):  # even-odd ray casting
    (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % n]
    cond = ((y1 > yy) != (y2 > yy)) & (xx < (x2 - x1) * (yy - y1) / (y2 - y1 + 1e-9) + x1)
    inside ^= cond
hole = inside.copy()
for _ in range(2):  # swallow the warm rim light around the fur
    g = hole.copy()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)): g |= np.roll(hole, (dy, dx), (0, 1))
    hole = g
hole &= img[..., 3] > 0
t0 = time.time()
# band by band, each taking texture only from where that kind of surface is visible
rgb = img[..., :3].astype(np.float32)
opaque = img[..., 3] == 255
PX = 341   # the piano's own left edge (its upper body ends here) — left of it: window, frame, wall
r_, g_, b_ = [img[..., i].astype(int) for i in range(3)]
leafy = ((g_ > b_ + 4) & (g_ > r_ - 14)) | ((r_ + g_ + b_) / 3 < 125)   # ivy leaves and stems — never a source for the sky
pot = (xx >= 300) & (xx < 352) & (yy >= 158) & (yy < 200)   # the potted plant on the sill
bands = [
    # (hole region, source region, search (dy, dx))
    ((yy < 201) & (xx < PX), (yy >= 120) & (yy < 201) & (xx >= 218) & (xx < 283) & ~leafy, (6, 80)),       # left window pane: city / haze
    ((yy < 186) & (xx >= PX), (yy >= 120) & (yy < 186) & (xx >= 289) & (xx < 352) & ~leafy & ~pot, (6, 80)),      # right pane above the piano
    ((yy >= 186) & (yy < 229) & (xx >= PX), (yy >= 180) & (yy < 232) & (xx >= 352), (2, 200)),    # piano: keys and body, carried left
    ((yy >= 201) & (yy < 229) & (xx < PX), (yy >= 199) & (yy < 229) & (xx >= 225) & (xx < 237), (2, 140)),  # (radio excluded)  # frame / dark wood
    ((yy >= 229), (yy >= 229) & (xx >= 190) & ((xx < 236) | (xx >= 364)) & (xx < 420), (3, 200)),  # cushion / rug
]
for hreg, srcreg, srch in bands:
    hb = hole & hreg
    if not hb.any(): continue
    ex = ~(srcreg & opaque) | hole
    rgb = inpaint(rgb, hb, patch=7, search=srch, exclude=ex)
    hole = hole & ~hb
if hole.any():
    rgb = inpaint(rgb, hole, patch=7, search=(20, 60), exclude=~opaque)
print("filled", "px in", round(time.time() - t0, 1), "s")
out_img = img.copy(); out_img[..., :3] = rgb.clip(0, 255).astype(np.uint8)
subprocess.run([FF, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{W}x{H}", "-i", "-", "-frames:v", "1", "-update", "1", out], input=out_img.tobytes(), check=True)
pv = np.concatenate([img[120:257, 200:424], out_img[120:257, 200:424]], 1)
h, w = pv.shape[:2]
subprocess.run([FF, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-i", "-", "-vf", "scale=iw*2:ih*2:flags=neighbor", "-frames:v", "1", "-update", "1", prev], input=pv.tobytes(), check=True)
