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
    if not os.path.exists(os.path.join(DST, "libonnxruntime.dylib")):
        print(f"downloading ONNX Runtime (macOS {_ORT_MAC_ARCH})")
        tmp = os.path.join(tempfile.gettempdir(), "onnxruntime-osx.tgz")
        # arch-specific first; the universal2 build is the fallback if that asset name is absent
        ort_u2 = f"https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VER}/onnxruntime-osx-universal2-{ORT_VER}.tgz"
        print("  using", fetch_first([ORT_MAC, ort_u2], tmp))
        with tarfile.open(tmp) as t:
            for m in t.getmembers():
                base = os.path.basename(m.name)
                # the real versioned dylib (not the symlink) → models/libonnxruntime.dylib
                if m.isfile() and base.startswith("libonnxruntime.") and base.endswith(".dylib"):
                    with t.extractfile(m) as f:
                        open(os.path.join(DST, "libonnxruntime.dylib"), "wb").write(f.read())
                elif base == "LICENSE" and not os.path.exists(os.path.join(DST, "ORT_LICENSE")):
                    with t.extractfile(m) as f:
                        open(os.path.join(DST, "ORT_LICENSE"), "wb").write(f.read())
        os.remove(tmp)
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
