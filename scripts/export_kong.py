"""Export the note model of Kong et al.'s high-resolution piano transcription to ONNX for the Piano
module's delay modes (src-tauri/src/audio/transcribe.rs): src-tauri/models/kong_note.onnx (≈ 99 MB).

Needs a Python with torch (CPU) and piano_transcription_inference:
  python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
  python -m pip install piano_transcription_inference onnx
  python -I -X utf8 scripts/export_kong.py [checkpoint.pth]

The checkpoint (CRNN_note_F1=0.9677_pedal_F1=0.9186.pth, zenodo record 4034264, CC BY 4.0) is
downloaded when not given. Only the note model is exported (no pedal model — half the cost); the
log-mel front end (torchlibrosa STFT as convolutions) is inside the graph. Input `waveform` [1, N] at
16 kHz; outputs `frame`, `onset`, `offset`, `velocity` [1, N/160 + 1, 88] at 100 fps.
"""
import os, subprocess, sys
import torch
from piano_transcription_inference import PianoTranscription

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src-tauri", "models", "kong_note.onnx")
URL = "https://zenodo.org/record/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1"

ckpt = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "src-tauri", "models", "kong_ckpt.pth")
if not os.path.exists(ckpt):
    print("downloading checkpoint (≈ 165 MB)")
    if subprocess.run(["curl", "-L", "--ssl-no-revoke", "--retry", "3", "-o", ckpt, URL]).returncode != 0:
        sys.exit("checkpoint download failed")
t = PianoTranscription(device="cpu", checkpoint_path=ckpt)


class Note(torch.nn.Module):
    def __init__(self, m):
        super().__init__(); self.m = m

    def forward(self, x):
        o = self.m(x)
        return o["frame_output"], o["reg_onset_output"], o["reg_offset_output"], o["velocity_output"]


m = Note(t.model.note_model.eval()).eval()
with torch.no_grad():
    torch.onnx.export(m, torch.randn(1, 32000) * 0.05, OUT, input_names=["waveform"], output_names=["frame", "onset", "offset", "velocity"],
                      dynamic_axes={"waveform": {1: "n"}, "frame": {1: "t"}, "onset": {1: "t"}, "offset": {1: "t"}, "velocity": {1: "t"}},
                      opset_version=17, dynamo=False)
print("wrote", OUT)
