# Cozy corner art: cuts the corner widget out of a desktop mock-up (a picture of the scene
# sitting on a wallpaper), keys the wallpaper out by a flood fill from the outside (the
# window's sky is enclosed by its frame, so it survives), optionally flips it for the
# right-hand corner and writes an RGBA PNG for public/cozy/corner.png. ffmpeg decodes/encodes.
# The scene grid is 160×96 (5:3): crop to that aspect so the overlays line up (cozy.ts drawArt).
#   python -I -X utf8 scripts/cozy_asset.py <mockup.png> public/cozy/corner.png [x y w h] [--no-flip] [--ffmpeg path]
import sys, subprocess, numpy as np, collections
args = [a for a in sys.argv[1:] if not a.startswith("--")]
flip = "--no-flip" not in sys.argv
FF = sys.argv[sys.argv.index("--ffmpeg") + 1] if "--ffmpeg" in sys.argv else "ffmpeg"
src, out = args[0], args[1]
x, y, w, h = (int(v) for v in args[2:6]) if len(args) >= 6 else (0, 626, 424, 257)
raw = subprocess.run([FF, "-v", "error", "-i", src, "-vf", f"crop={w}:{h}:{x}:{y}" + (",hflip" if flip else ""), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
img = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3).astype(np.int16)
r, g, b = img[..., 0], img[..., 1], img[..., 2]
bright = (r + g + b) / 3
# wallpaper: light, cool/neutral (blue >= red - small margin), low warm saturation
# light cool/neutral wallpaper, plus its dimmer blue shadows (the plant corner kept a blue patch at > 150)
wall = ((bright > 150) & (b >= r - 8) & (np.abs(g - b) < 40)) | ((bright > 95) & (b > r + 12) & (b > g + 2))
# flood from the outside border over wallpaper pixels
mask = np.zeros((h, w), dtype=bool)
q = collections.deque()
for i in range(h):
    for j in (0, w - 1):
        if wall[i, j] and not mask[i, j]: mask[i, j] = True; q.append((i, j))
for j in range(w):
    for i in (0, h - 1):
        if wall[i, j] and not mask[i, j]: mask[i, j] = True; q.append((i, j))
while q:
    i, j = q.popleft()
    for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        a, c = i + di, j + dj
        if 0 <= a < h and 0 <= c < w and wall[a, c] and not mask[a, c]:
            mask[a, c] = True; q.append((a, c))
# soften: pixels adjacent to the background get partial alpha (anti-aliased edge)
alpha = np.where(mask, 0, 255).astype(np.uint8)
edge = mask.copy()
for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
    edge |= np.roll(mask, (di, dj), axis=(0, 1))
alpha[(edge & ~mask)] = 160
rgba = np.dstack([img.astype(np.uint8), alpha])
subprocess.run([FF, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-i", "-", "-frames:v", "1", out], input=rgba.tobytes(), check=True)
print(out, w, h, "transparent %", round(100 * mask.mean(), 1))
