# Sky mask for the Cozy corner art: pixels of the window sky / city (not ivy, mullions, cat) as a
# white-on-transparent PNG, used to tint the sky and light the glass.
#   python -I -X utf8 scripts/cozy_sky_mask.py  (paths below)
import subprocess, numpy as np
FF = r"D:/MakeNew/진우컴퍼니NEW/output/Project/audio-converter/bin/ffmpeg.exe"
W, H = 424, 257
img = np.frombuffer(subprocess.run([FF, "-v", "error", "-i", r"D:/MakeNew/진우컴퍼니NEW/output/Project/ShowMeterBeat/public/cozy/corner.png", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], capture_output=True, check=True).stdout, np.uint8).reshape(H, W, 4).astype(int)
r, g, b, a = img[..., 0], img[..., 1], img[..., 2], img[..., 3]
yy, xx = np.mgrid[0:H, 0:W]
inwin = (xx >= 218) & (xx <= 336) & (yy >= 22) & (yy <= 200) & (a > 200)
# sky / city: cool or pink-lavender, not green (ivy, plant), not warm brown/orange (frame, cat patches)
bright = (r + g + b) / 3
sky = inwin & (((b >= g - 6) & (b > 95) & (r - b < 45)) | ((bright > 175) & (r - b < 60) & (b >= g - 22))) & ~((g > b + 4) & (g > r - 12))
sky &= ~((xx >= 280) & (xx <= 289)) & ~((yy >= 103) & (yy <= 112))   # mullions
# cat (white fur is neutral) — keep its silhouette out: everything below the cat's ear line in its box
catbox = (xx >= 238) & (xx <= 300) & (yy >= 152)
sky &= ~catbox | (b > r + 8)   # around the cat only clearly blue sky/city, never the white or brown fur
out = img.copy().astype(np.uint8)
out[sky] = [255, 0, 255, 255]
crop = out[10:210, 205:345]
h, w = crop.shape[:2]
subprocess.run([FF, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-i", "-", "-vf", "scale=iw*3:ih*3:flags=neighbor", "-frames:v", "1", "-update", "1", "sky_mask_prev.png"], input=crop.tobytes(), check=True)
print("sky px", int(sky.sum()))

m = np.zeros((H, W, 4), np.uint8); m[sky] = [255, 255, 255, 255]
subprocess.run([FF, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{W}x{H}", "-i", "-", "-frames:v", "1", "-update", "1", r"D:/MakeNew/진우컴퍼니NEW/output/Project/ShowMeterBeat/public/cozy/corner_sky.png"], input=m.tobytes(), check=True)
print("wrote corner_sky.png")
