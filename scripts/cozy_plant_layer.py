# Corner art clean-up + plant layer: (1) remove enclosed wallpaper (light bluish pixels) around the left
# plant that the outside flood fill could not reach; (2) cut the plant's leaves into their own layer
# (yellow-green pixels in the plant's box) so the app can sway them; the base keeps everything else.
import sys, subprocess, numpy as np
FF = r"D:/MakeNew/진우컴퍼니NEW/output/Project/audio-converter/bin/ffmpeg.exe"
src, base_out, plant_out, prev = sys.argv[1:5]
W, H = 424, 257
img = np.frombuffer(subprocess.run([FF, "-v", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], capture_output=True, check=True).stdout, np.uint8).reshape(H, W, 4).copy()
r, g, b, a = [img[..., i].astype(int) for i in range(4)]
yy, xx = np.mgrid[0:H, 0:W]
left = (xx < 92) & (yy > 115)
wall = left & (b > r + 6) & ((r + g + b) / 3 > 95)
img[wall, 3] = 0
# fringe: semi-transparent or bluish pixels touching transparency, twice
for _ in range(2):
    t = img[..., 3] == 0
    near = np.zeros_like(t)
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)): near |= np.roll(t, (dy, dx), (0, 1))
    r, g, b = [img[..., i].astype(int) for i in range(3)]
    img[near & left & (b > r - 4) & (img[..., 3] > 0), 3] = 0
r, g, b = [img[..., i].astype(int) for i in range(3)]
# olive / yellow-green leaves (r ≈ g > b); the pot, desk and mug are warmer (r ≫ g). Only leaves that hang in
# front of transparency sway: above the pot rim, or the vine on the far left (not the ones over the desk front).
leaf = (xx < 118) & (yy > 118) & (img[..., 3] > 0) & ((np.abs(r - g) < 24) | ((r - g < 48) & (g > 125))) & (g > b + 8) & ((yy < 192) | (xx < 45))
# grow by 1 px into dark leaf outlines
region = (xx < 118) & (yy > 118) & ((yy < 192) | (xx < 45))
for _ in range(2):   # swallow dark outlines and stray edge pixels next to leaves (not the pot)
    grow = leaf.copy()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)): grow |= np.roll(leaf, (dy, dx), (0, 1))
    leaf |= grow & (img[..., 3] > 0) & region & ~((r - g > 30) & (yy > 185))
plant = np.zeros_like(img); plant[leaf] = img[leaf]
base = img.copy(); base[leaf, 3] = 0
def save(arr, path):
    subprocess.run([FF, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{W}x{H}", "-i", "-", "-frames:v", "1", "-update", "1", path], input=arr.tobytes(), check=True)
save(base, base_out); save(plant, plant_out)
ys, xs = np.where(leaf); print("leaf px", leaf.sum(), "box x", xs.min(), xs.max(), "y", ys.min(), ys.max(), "wall removed", int(wall.sum()))
# preview: cleaned full image over a blue desktop, and the plant layer alone over magenta
full = base.copy(); full[leaf] = img[leaf]
def over(arr, col):
    o = np.empty((H, W, 3), np.float32); o[:] = col; al = arr[..., 3:4] / 255.0
    return (arr[..., :3] * al + o * (1 - al)).astype(np.uint8)
pv = np.concatenate([over(full, (58, 110, 165))[115:257, 0:150], over(plant, (200, 0, 200))[115:257, 0:150], over(base, (58, 110, 165))[115:257, 0:150]], 1)
h, w = pv.shape[:2]
subprocess.run([FF, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-i", "-", "-vf", "scale=iw*3:ih*3:flags=neighbor", "-frames:v", "1", "-update", "1", prev], input=pv.tobytes(), check=True)
