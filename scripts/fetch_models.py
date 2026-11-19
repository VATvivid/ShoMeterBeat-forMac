"""Download the AI models used by ShowMeterBeat into src-tauri/models/ (gitignored).

  python -I -X utf8 scripts/fetch_models.py                 # YAMNet ONNX + class map + ONNX Runtime
  python -I -X utf8 scripts/fetch_models.py --whisper small # + whisper ggml model (base|small|medium)

Licences: YAMNet Apache-2.0 (Google), Basic Pitch Apache-2.0 (Spotify), ONNX Runtime MIT (Microsoft), whisper.cpp ggml models MIT
(ggerganov / OpenAI). See THIRD_PARTY_NOTICES.md. `--ssl-no-revoke` works around corporate
TLS inspection breaking schannel revocation checks on CDN hosts.
"""
import os, subprocess, sys, tempfile, zipfile, tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DST = os.path.join(ROOT, "src-tauri", "models")
# -f: fail on HTTP errors — without it a 404 page is saved as the "model" and passes the size check.
CURL = ["curl", "-fL", "--retry", "3", "-A", "ShowMeterBeat"]
# `--ssl-no-revoke` exists only in Windows' schannel curl (works around corporate TLS inspection);
# macOS/Linux curl rejects it as an unknown option, which aborted every download in CI.
if sys.platform == "win32":
    CURL.insert(2, "--ssl-no-revoke")

FILES = {
    "yamnet.onnx": "https://huggingface.co/zeropointnine/yamnet-onnx/resolve/main/yamnet.onnx",
    "yamnet_class_map.csv": "https://huggingface.co/zeropointnine/yamnet-onnx/resolve/main/yamnet_class_map.csv",
    # Basic Pitch (Spotify, Apache-2.0) — polyphonic piano transcription for the Piano module
    "nmp.onnx": "https://raw.githubusercontent.com/spotify/basic-pitch/main/basic_pitch/saved_models/icassp_2022/nmp.onnx",
    "BASIC_PITCH_LICENSE": "https://raw.githubusercontent.com/spotify/basic-pitch/main/LICENSE",
}
import platform

ORT_VER = "1.31.1"
ORT_WIN = f"https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VER}/onnxruntime-win-x64-{ORT_VER}.zip"
# macOS build matched to the host arch; its lib/ holds libonnxruntime.<ver>.dylib (ort load-dynamic).
_ORT_MAC_ARCH = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x86_64"
ORT_MAC = f"https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VER}/onnxruntime-osx-{_ORT_MAC_ARCH}-{ORT_VER}.tgz"


def _ok(out):
    return os.path.exists(out) and os.path.getsize(out) > 1000


def fetch(url, out):
    r = subprocess.run(CURL + ["-o", out, url])
    if r.returncode != 0 or not _ok(out):
        # "::error::" lines become GitHub Actions annotations, so the cause is visible without the log.
        print(f"::error::download failed: {url} (curl exit {r.returncode})")
        sys.exit(f"download failed: {url}")


def fetch_first(urls, out):
    """Try each URL in order (release assets differ by version); keep the first that downloads."""
    for u in urls:
        r = subprocess.run(CURL + ["-o", out, u])
        if r.returncode == 0 and _ok(out):
            return u
        if os.path.exists(out):
            os.remove(out)
    print(f"::error::download failed, tried: {' | '.join(urls)}")
    sys.exit("download failed")


def try_fetch(urls, out):
    """Like fetch_first but returns None instead of exiting, so the caller can fall back."""
    for u in urls:
        r = subprocess.run(CURL + ["-o", out, u])
        if r.returncode == 0 and _ok(out):
            return u
        if os.path.exists(out):
            os.remove(out)
    return None


def ort_dylib_from_wheel(ver, dst):
    """macOS fallback: the onnxruntime PyPI wheel always bundles onnxruntime/capi/libonnxruntime.<ver>.dylib
    and pip picks the wheel for this machine's arch — no guessing of GitHub release asset names."""
    wdir = tempfile.mkdtemp(prefix="ort-whl-")
    r = subprocess.run([sys.executable, "-m", "pip", "download", f"onnxruntime=={ver}", "-d", wdir, "--only-binary=:all:", "--no-deps", "-q"])
    whl = next((os.path.join(wdir, f) for f in os.listdir(wdir) if f.endswith(".whl")), None)
    if r.returncode != 0 or not whl:
        print(f"::error::onnxruntime {ver}: GitHub release assets 404 and the PyPI wheel download failed")
        sys.exit("onnxruntime download failed")
    with zipfile.ZipFile(whl) as z:
        libs = [n for n in z.namelist() if os.path.basename(n).startswith("libonnxruntime") and n.endswith(".dylib")]
        if not libs:
            print(f"::error::no libonnxruntime*.dylib inside {os.path.basename(whl)}")
            sys.exit("onnxruntime wheel has no dylib")
        libs.sort(key=len, reverse=True)            # the versioned real file, not a bare symlink name
        open(dst, "wb").write(z.read(libs[0]))
        lic = [n for n in z.namelist() if os.path.basename(n) in ("LICENSE", "LICENSE.txt")]
        if lic and not os.path.exists(os.path.join(DST, "ORT_LICENSE")):
            open(os.path.join(DST, "ORT_LICENSE"), "wb").write(z.read(lic[0]))
    print("  using wheel", os.path.basename(whl), "->", libs[0])


os.makedirs(DST, exist_ok=True)
for name, url in FILES.items():
    out = os.path.join(DST, name)
    if os.path.exists(out) and os.path.getsize(out) > 1000:
        print("exists", name)
        continue
    print("downloading", name)
    fetch(url, out)

# ONNX Runtime shared library — the build downloads the one for the host OS.
if sys.platform == "darwin":
    dylib_dst = os.path.join(DST, "libonnxruntime.dylib")
    if not os.path.exists(dylib_dst):
        print(f"downloading ONNX Runtime (macOS {_ORT_MAC_ARCH})")
        tmp = os.path.join(tempfile.gettempdir(), "onnxruntime-osx.tgz")
        # GitHub release tgz first (arch-specific, then universal2); asset names vary by version and
        # 1.31.1 had neither (both 404 in CI), so the PyPI wheel is the reliable fallback.
        ort_u2 = f"https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VER}/onnxruntime-osx-universal2-{ORT_VER}.tgz"
        got = try_fetch([ORT_MAC, ort_u2], tmp)
        if got:
            print("  using", got)
            with tarfile.open(tmp) as t:
                for m in t.getmembers():
                    base = os.path.basename(m.name)
                    # the real versioned dylib (not the symlink) → models/libonnxruntime.dylib
                    if m.isfile() and base.startswith("libonnxruntime.") and base.endswith(".dylib"):
                        with t.extractfile(m) as f:
                            open(dylib_dst, "wb").write(f.read())
                    elif base == "LICENSE" and not os.path.exists(os.path.join(DST, "ORT_LICENSE")):
                        with t.extractfile(m) as f:
                            open(os.path.join(DST, "ORT_LICENSE"), "wb").write(f.read())
            os.remove(tmp)
        else:
            print("  GitHub release asset not found — falling back to the PyPI wheel")
            ort_dylib_from_wheel(ORT_VER, dylib_dst)
        if not _ok(dylib_dst):
            print("::error::libonnxruntime.dylib was not produced")
            sys.exit("onnxruntime missing")
elif not os.path.exists(os.path.join(DST, "onnxruntime.dll")):
    print("downloading ONNX Runtime (Windows x64)")
    tmp = os.path.join(tempfile.gettempdir(), "onnxruntime-win-x64.zip")
    fetch(ORT_WIN, tmp)
    with zipfile.ZipFile(tmp) as z:
        for n in z.namelist():
            base = os.path.basename(n)
            if base in ("onnxruntime.dll", "onnxruntime_providers_shared.dll"):
                open(os.path.join(DST, base), "wb").write(z.read(n))
            elif base == "LICENSE":
                open(os.path.join(DST, "ORT_LICENSE"), "wb").write(z.read(n))
    os.remove(tmp)

if not os.path.exists(os.path.join(DST, "kong_note.onnx")):
    # the Piano's 1 s / 3 s delay modes: an ONNX export of Kong et al.'s note model (needs torch)
    print("kong_note.onnx missing — Piano 딜레이 모드(1·3초)용: torch가 있는 Python에서 scripts/export_kong.py 실행")
if not os.path.exists(os.path.join(DST, "KONG_LICENSE")):
    fetch("https://raw.githubusercontent.com/qiuqiangkong/piano_transcription_inference/master/LICENSE", os.path.join(DST, "KONG_LICENSE"))

if "--whisper" in sys.argv:
    i = sys.argv.index("--whisper")
    name = sys.argv[i + 1] if len(sys.argv) > i + 1 else "base"
    out = os.path.join(DST, f"ggml-{name}.bin")
    if os.path.exists(out):
        print("exists", os.path.basename(out))
    else:
        print("downloading whisper", name)
        fetch(f"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin", out)

print("done →", DST)
