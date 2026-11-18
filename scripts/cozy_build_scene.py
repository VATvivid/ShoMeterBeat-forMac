# Builds every Cozy corner picture from the new cat-less room (cozy_new_bg.py, 800×480 = 160×96 scene
# units × 5) and the user's cats (2026-11-18: 누운·잠·그루밍·기지개; 실타래·앉아 조는 포즈는 뺌):
#   corner.png        room + lying cat (awake base)       corner_sleep.png  room + sleeping cat
#   corner_play1.png  room + grooming cat                 corner_play2.png  room + stretching cat
#   corner_plant.png  the big left plant's leaves that hang over empty space (swayed by cozy.ts; removed
#                     from every other picture so nothing doubles)
#   corner_sky.png, corner_play1_sky.png, corner_play2_sky.png
#                     the window glass (sky + city) minus that picture's cat (white on transparent)
# All cats share one scale; they lie on the rug, bottom-aligned, with a soft contact shadow.
#
#   python -I -X utf8 scripts/cozy_build_scene.py <catless800.png> <cats dir> public/cozy
import sys, os, numpy as np
from PIL import Image, ImageFilter

room_p, src, d = sys.argv[1], sys.argv[2], sys.argv[3]
room = np.array(Image.open(room_p).convert("RGBA")).astype(np.float32)
H, W = room.shape[:2]
yy, xx = np.mgrid[0:H, 0:W]
r, g, b, a = room[..., 0], room[..., 1], room[..., 2], room[..., 3]

# ---- plant layer: the big left plant's crown (yellow-green leaves above its pot rim, and the leaves
#      over the empty space right of it down to the book stack) — feathered over ~12 px into the static
#      part (the hanging vine, leaves in front of the pot / books) so the sway never shows a seam
RIM_Y = 347
region = (xx < 219) & (yy > 241) & ((yy < 326) | ((xx < 170) & (yy < RIM_Y)))
# above the rim there is only the plant against empty space: every visible pixel there is plant, except
# the pot's own rim / soil (brownish, just above the rim line)
pot = (yy > RIM_Y - 14) & (r - g > 45)
leaf = (a > 0) & ~pot
wr = np.array(Image.fromarray((region * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6))).astype(np.float32) / 255
w = np.clip((wr - 0.2) / 0.6, 0, 1) * leaf
plant = room.copy(); plant[..., 3] = a * w
base = room.copy(); base[..., 3] = a * (1 - w)
leaf = w > 0.5
# ---- sky: the glass of the window (sky, clouds, city), not its frame / the ivy / the potted plant
WX0, WY0, WX1, WY1 = 409, 97, 629, 379
inwin = (xx >= WX0) & (xx < WX1) & (yy >= WY0) & (yy < WY1)
wood = (r - b > 28) & (r > g) & (g < 170)
green = (g > b + 12) & (g > r - 30)
sky = inwin & ~wood & ~green & (a > 0)
m = Image.fromarray((sky * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
sky = np.array(m) > 0


def load(name):
    im = Image.open(os.path.join(src, name + ".png")).convert("RGBA")
    al = np.array(im)[..., 3]
    ys, xs = np.nonzero(al > 40)
    return im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))


cats = {n: load(n) for n in ("loaf", "sleep", "groom", "stretch")}
LOAF_W = 234                                        # ≈ 47 scene units
K = LOAF_W / cats["loaf"].width
FIT = {"groom": 0.92}                               # the groom picture is drawn a little bigger
FLOOR, CX = 457, 551                                # rug: bottom line and centre
REAR = CX + LOAF_W // 2


def scaled(im, f):
    w, h = round(im.width * K * f), round(im.height * K * f)
    x = np.array(im).astype(np.float32)
    x[..., :3] *= x[..., 3:4] / 255
    rr = np.array(Image.fromarray(x.clip(0, 255).astype(np.uint8), "RGBA").resize((w, h), Image.LANCZOS)).astype(np.float32)
    al = rr[..., 3:4] / 255
    rr[..., :3] = np.where(al > 0.01, rr[..., :3] / np.maximum(al, 0.01), 0)
    return rr


def compose(name, out):
    c = scaled(cats[name], FIT.get(name, 1.0))
    h, w = c.shape[:2]
    x = round(CX - w / 2) if name == "stretch" else REAR - w
    y = FLOOR - h
    img = base.copy()
    al = np.zeros((H, W), np.float32); al[y:y + h, x:x + w] = c[..., 3] / 255
    sh = np.array(Image.fromarray((np.roll(al, 3, 0) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(4))).astype(np.float32) / 255
    sh *= yy > y + h * 0.6
    img[..., :3] *= 1 - (sh * 0.35)[..., None]
    full = np.zeros((H, W, 3), np.float32); full[y:y + h, x:x + w] = c[..., :3]
    img[..., :3] = img[..., :3] * (1 - al[..., None]) + full * al[..., None]
    img[..., 3] = np.maximum(img[..., 3], al * 255)
    Image.fromarray(img.clip(0, 255).astype(np.uint8), "RGBA").save(os.path.join(d, out), optimize=True)
    print(out, "<-", name, "at", x, y, "size", w, h, "(scene", round(x / 5, 1), round(y / 5, 1), round(w / 5, 1), round(h / 5, 1), ")")
    return al


def save_sky(mask, out):
    o = np.zeros((H, W, 4), np.uint8); o[..., :3] = 255; o[..., 3] = np.where(mask, 255, 0)
    Image.fromarray(o, "RGBA").save(os.path.join(d, out), optimize=True)
    print(out, "sky px", int(mask.sum()))


def minus_cat(al):
    cm = Image.fromarray(((al > 0.05) * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3))
    return sky & ~(np.array(cm) > 0)


save_sky(minus_cat(compose("loaf", "corner.png")), "corner_sky.png")
compose("sleep", "corner_sleep.png")
save_sky(minus_cat(compose("groom", "corner_play1.png")), "corner_play1_sky.png")
save_sky(minus_cat(compose("stretch", "corner_play2.png")), "corner_play2_sky.png")
Image.fromarray(plant.clip(0, 255).astype(np.uint8), "RGBA").save(os.path.join(d, "corner_plant.png"), optimize=True)
print("plant px", int(leaf.sum()), "pivot (scene)", round(np.nonzero(leaf)[1].mean() / 5, 1), RIM_Y / 5)
