"""Download the AI models used by ShowMeterBeat into src-tauri/models/ (gitignored).

  python -I -X utf8 scripts/fetch_models.py                 # YAMNet ONNX + class map + ONNX Runtime
  python -I -X utf8 scripts/fetch_models.py --whisper small # + whisper ggml model (base|small|medium)

Licences: YAMNet Apache-2.0 (Google), ONNX Runtime MIT (Microsoft), whisper.cpp ggml models MIT
(ggerganov / OpenAI). See THIRD_PARTY_NOTICES.md. `--ssl-no-revoke` works around corporate
TLS inspection breaking schannel revocation checks on CDN hosts.
"""
import os, subprocess, sys, tempfile, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DST = os.path.join(ROOT, "src-tauri", "models")
CURL = ["curl", "-L", "--ssl-no-revoke", "--retry", "3", "-A", "ShowMeterBeat"]

FILES = {
    "yamnet.onnx": "https://huggingface.co/zeropointnine/yamnet-onnx/resolve/main/yamnet.onnx",
    "yamnet_class_map.csv": "https://huggingface.co/zeropointnine/yamnet-onnx/resolve/main/yamnet_class_map.csv",
}
ORT_URL = "https://github.com/microsoft/onnxruntime/releases/download/v1.31.1/onnxruntime-win-x64-1.31.1.zip"


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

if not os.path.exists(os.path.join(DST, "onnxruntime.dll")):
    print("downloading ONNX Runtime")
    tmp = os.path.join(tempfile.gettempdir(), "onnxruntime-win-x64.zip")
    fetch(ORT_URL, tmp)
    with zipfile.ZipFile(tmp) as z:
        for n in z.namelist():
            base = os.path.basename(n)
            if base in ("onnxruntime.dll", "onnxruntime_providers_shared.dll"):
                open(os.path.join(DST, base), "wb").write(z.read(n))
            elif base == "LICENSE":
                open(os.path.join(DST, "ORT_LICENSE"), "wb").write(z.read(n))
    os.remove(tmp)

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
