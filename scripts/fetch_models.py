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
CURL = ["curl", "-L", "--ssl-no-revoke", "--retry", "3", "-A", "ShowMeterBeat"]

FILES = {
    "yamnet.onnx": "https://huggingface.co/zeropointnine/yamnet-onnx/resolve/main/yamnet.onnx",
    "yamnet_class_map.csv": "https://huggingface.co/zeropointnine/yamnet-onnx/resolve/main/yamnet_class_map.csv",
    # Basic Pitch (Spotify, Apache-2.0) — polyphonic piano transcription for the Piano module
    "nmp.onnx": "https://raw.githubusercontent.com/spotify/basic-pitch/main/basic_pitch/saved_models/icassp_2022/nmp.onnx",
    "BASIC_PITCH_LICENSE": "https://raw.githubusercontent.com/spotify/basic-pitch/main/LICENSE",
}
ORT_VER = "1.31.1"
ORT_WIN = f"https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VER}/onnxruntime-win-x64-{ORT_VER}.zip"
# macOS Apple Silicon build; its lib/ holds libonnxruntime.<ver>.dylib (what ort load-dynamic needs).
ORT_MAC = f"https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VER}/onnxruntime-osx-arm64-{ORT_VER}.tgz"


def fetch(url, out):
    r = subprocess.run(CURL + ["-o", out, url])
    if r.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) < 1000:
        sys.exit(f"download failed: {url}")


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
        print("downloading ONNX Runtime (macOS arm64)")
        tmp = os.path.join(tempfile.gettempdir(), "onnxruntime-osx-arm64.tgz")
        fetch(ORT_MAC, tmp)
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
