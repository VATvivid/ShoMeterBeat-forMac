"""Export EfficientAT (fschmid56/EfficientAT, MIT) to a waveform-in ONNX model for the AI tagger.

The graph takes a 32 kHz mono waveform [1, N] and returns AudioSet probabilities [1, 527]:
pre-emphasis → centred STFT (n_fft 1024, Hann 800, hop 320; done as a DFT conv1d so it exports
cleanly) → power → Kaldi mel bank (128 bins, 0–15 kHz) → log(x + 1e-5) → (x + 4.5) / 5 →
MobileNetV3 → sigmoid. Same front end as EfficientAT's `AugmentMelSTFT` in eval mode.

Needs: a clone of https://github.com/fschmid56/EfficientAT, the checkpoint from its Releases
(e.g. mn10_as_mAP_471.pt), and torch / torchvision / torchaudio / onnx / onnxruntime.

  python -X utf8 scripts/export_efficientat.py --repo <EfficientAT clone> --ckpt mn10_as_mAP_471.pt \
      --name mn10_as --out src-tauri/models [--test <audio.wav>]

Writes <out>/efficientat_<name>.onnx and <out>/efficientat_class_map.csv, and checks that ONNX
Runtime matches PyTorch (front end vs the repo's AugmentMelSTFT, model vs the original).
"""
import argparse, os, shutil, subprocess, sys
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("--repo", required=True)
ap.add_argument("--ckpt", required=True)
ap.add_argument("--name", default="mn10_as")
ap.add_argument("--out", required=True)
ap.add_argument("--test", default=None, help="audio file for a sanity check (decoded with ffmpeg)")
ap.add_argument("--ffmpeg", default="ffmpeg")
a = ap.parse_args()
# EfficientAT's helpers open metadata/… relative to the working directory: resolve our paths
# first, then run from inside the repo.
a.repo, a.ckpt, a.out = os.path.abspath(a.repo), os.path.abspath(a.ckpt), os.path.abspath(a.out)
if a.test:
    a.test = os.path.abspath(a.test)
os.chdir(a.repo)
sys.path.insert(0, a.repo)

import torch
import torch.nn as nn
import torchaudio
from models.mn.model import get_model
from models.preprocess import AugmentMelSTFT
from helpers.utils import NAME_TO_WIDTH

SR, NFFT, WIN, HOP, NMELS = 32000, 1024, 800, 320, 128


class Frontend(nn.Module):
    """Eval-mode AugmentMelSTFT without randomness, STFT as a DFT convolution."""

    def __init__(self):
        super().__init__()
        win = torch.hann_window(WIN, periodic=False)
        left = (NFFT - WIN) // 2
        w = torch.zeros(NFFT)
        w[left:left + WIN] = win
        k = torch.arange(NFFT // 2 + 1, dtype=torch.float64)[:, None]
        n = torch.arange(NFFT, dtype=torch.float64)[None, :]
        ang = 2 * np.pi * k * n / NFFT
        re = (torch.cos(ang) * w).float()
        im = (-torch.sin(ang) * w).float()
        self.register_buffer("basis", torch.cat([re, im], 0)[:, None, :])  # (1026, 1, 1024)
        fmax = SR // 2 - 2000 // 2
        mel, _ = torchaudio.compliance.kaldi.get_mel_banks(NMELS, NFFT, SR, 0.0, fmax, vtln_low=100.0, vtln_high=-500.0, vtln_warp_factor=1.0)
        self.register_buffer("mel", torch.nn.functional.pad(mel, (0, 1)).float())  # (128, 513)

    def forward(self, x):  # x: (1, N)
        x = x[:, 1:] - 0.97 * x[:, :-1]
        x = torch.nn.functional.pad(x[:, None, :], (NFFT // 2, NFFT // 2), mode="reflect")
        s = torch.nn.functional.conv1d(x, self.basis, stride=HOP)  # (1, 1026, T)
        h = NFFT // 2 + 1
        p = s[:, :h] ** 2 + s[:, h:] ** 2
        m = torch.matmul(self.mel, p)
        m = (m + 1e-5).log()
        return ((m + 4.5) / 5.0)[:, None]  # (1, 1, 128, T)


class Wave2Probs(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.fe = Frontend()
        self.model = model

    def forward(self, wave):
        logits, _ = self.model(self.fe(wave))
        return torch.sigmoid(logits.reshape(1, -1))


model = get_model(width_mult=NAME_TO_WIDTH(a.name), pretrained_name=None, head_type="mlp")
sd = torch.load(a.ckpt, map_location="cpu")
model.load_state_dict(sd)
model.eval()
net = Wave2Probs(model).eval()

# ---- reference check: our front end vs the repo's AugmentMelSTFT (eval)
ref_fe = AugmentMelSTFT(n_mels=NMELS, sr=SR, win_length=WIN, hopsize=HOP).eval()
torch.manual_seed(0)
wave = torch.randn(1, SR * 2) * 0.1
with torch.no_grad():
    m_ref = ref_fe(wave)[None]
    m_our = net.fe(wave)
    p_ref = torch.sigmoid(model(m_ref)[0].reshape(1, -1))
    p_our = net(wave)
print("front end max |diff|", float((m_ref - m_our).abs().max()), " probs max |diff|", float((p_ref - p_our).abs().max()))

os.makedirs(a.out, exist_ok=True)
onnx_path = os.path.join(a.out, f"efficientat_{a.name}.onnx")
try:
    torch.onnx.export(net, (wave,), onnx_path, input_names=["waveform"], output_names=["probs"],
                      dynamic_axes={"waveform": {1: "n"}}, opset_version=17, dynamo=False)
    print("exported (torchscript)", onnx_path)
except Exception as e:  # newer torch: dynamo exporter
    print("torchscript export failed:", str(e).splitlines()[0])
    n = torch.export.Dim("n", min=SR // 2, max=SR * 12)
    torch.onnx.export(net, (wave,), onnx_path, input_names=["waveform"], output_names=["probs"],
                      dynamic_shapes={"wave": {1: n}}, opset_version=18, dynamo=True, external_data=False)
    print("exported (dynamo)", onnx_path)

import onnxruntime as ort
sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
for secs in (1, 2, 3):
    w = (torch.randn(1, SR * secs) * 0.1)
    with torch.no_grad():
        pt = net(w).numpy()
    ox = sess.run(None, {"waveform": w.numpy()})[0]
    print(f"ORT vs torch ({secs} s): max |diff| {np.abs(pt - ox).max():.2e}")

labels_src = os.path.join(a.repo, "metadata", "class_labels_indices.csv")
shutil.copyfile(labels_src, os.path.join(a.out, "efficientat_class_map.csv"))
labels = [l.split(",", 2)[2].strip().strip('"') for l in open(labels_src, encoding="utf-8").read().splitlines()[1:]]
print("labels", len(labels), "→", os.path.join(a.out, "efficientat_class_map.csv"))

if a.test:
    raw = subprocess.run([a.ffmpeg, "-v", "error", "-ss", "30", "-t", "2", "-i", a.test, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32)[None]
    probs = sess.run(None, {"waveform": x})[0][0]
    top = np.argsort(probs)[::-1][:5]
    print("test", os.path.basename(a.test), ":", ", ".join(f"{labels[i]} {probs[i]:.2f}" for i in top))
