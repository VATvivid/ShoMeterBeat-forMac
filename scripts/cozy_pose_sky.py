# Recomputes the sky masks of the Cozy play poses (corner_play<N>_sky.png) after the cats were
# resized or moved: "sky without any cat" = the union of the base mask (corner_sky.png) and every
# existing pose mask (each lacks only its own cat), then each pose's own cat pixels (where the pose
# differs from the cat-less background) are cut out of it.
#
#   python -I -X utf8 scripts/cozy_pose_sky.py <catless.png> public/cozy <count>
import sys, os, numpy as np
from PIL import Image

bgp, d, count = sys.argv[1], sys.argv[2], int(sys.argv[3])
bg = np.array(Image.open(bgp).convert("RGBA")).astype(np.float32)
H, W = bg.shape[:2]
sky = np.array(Image.open(os.path.join(d, "corner_sky.png")).convert("RGBA"))[..., 3].astype(np.float32)
for k in range(1, count + 1):
    p = os.path.join(d, f"corner_play{k}_sky.png")
    if os.path.exists(p):
        sky = np.maximum(sky, np.array(Image.open(p).convert("RGBA"))[..., 3].astype(np.float32))
for k in range(1, count + 1):
    pose = np.array(Image.open(os.path.join(d, f"corner_play{k}.png")).convert("RGBA")).astype(np.float32)
    cat = np.abs(pose[..., :3] - bg[..., :3]).sum(2) > 18
    g = cat.copy()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        g |= np.roll(cat, (dy, dx), (0, 1))
    m = sky.copy()
    m[g] = 0
    out = np.zeros((H, W, 4), np.uint8)
    out[..., :3] = 255
    out[..., 3] = m.astype(np.uint8)
    Image.fromarray(out, "RGBA").save(os.path.join(d, f"corner_play{k}_sky.png"))
    print("pose", k, "sky px", int((m > 0).sum()))
