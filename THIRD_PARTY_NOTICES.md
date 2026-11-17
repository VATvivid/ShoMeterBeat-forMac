# Third-party notices

## chimera-vocal-synth (data)

`src/modules/vowelTargets.ts` contains the calibrated vowel articulation targets
(`vowelTargets.generated.json`: per-vowel tongue/jaw/lip/larynx values and simulated
formants for male/female/child bodies) and `src/modules/vowels.ts` includes extra vowel
formant references from `vowel_data.rs`, both from
https://github.com/jamesondh/chimera-vocal-synth. The drawing code in this project is
independent; only the data is reused.

```
MIT License

Copyright (c) 2026 Jameson Hodge

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## nih-plug (plugin framework, crates/rm-send-plugin)

ISC license for the framework; the VST3 export (`vst3-sys` wrapper) is GPLv3 — see
the nih-plug repository for the full terms before redistributing the VST3 build.

## Vowel reference formants

Core vowel references (10 vowels, male/female/child) are the published averages of
Peterson & Barney (1952), *Control methods used in a study of the vowels*.

## YAMNet (AI sound-event tagging model)

`models/yamnet.onnx` is the ONNX export of Google's YAMNet (AudioSet, 521 classes) from
https://huggingface.co/zeropointnine/yamnet-onnx (converted with tf2onnx from the official
TensorFlow SavedModel), with `yamnet_class_map.csv` from
https://github.com/tensorflow/models/tree/master/research/audioset/yamnet.
Both are Apache License 2.0 (Copyright Google LLC). The files are downloaded by
`scripts/fetch_models.py` and shipped as app resources. Inference runs locally with
ONNX Runtime (MIT, Microsoft) via the `ort` crate.

## EfficientAT (AI sound-event tagging model, selectable)

`models/efficientat_mn10_as.onnx` is exported by `scripts/export_efficientat.py` from the
EfficientAT checkpoint `mn10_as_mAP_471.pt` (https://github.com/fschmid56/EfficientAT,
MIT License, Copyright (c) 2022 Florian Schmid; F. Schmid, K. Koutini, G. Widmer, "Efficient
Large-scale Audio Tagging via Transformer-to-CNN Knowledge Distillation", ICASSP 2023). The
log-mel front end of the repository's `AugmentMelSTFT` (eval mode) is folded into the graph.
`efficientat_class_map.csv` is the repository's `metadata/class_labels_indices.csv`.

AudioSet class names (both models): Google AudioSet ontology, CC BY-SA 4.0
(https://research.google.com/audioset/). Annotations CC BY 4.0.

## whisper.cpp (live subtitles)

Speech recognition uses whisper.cpp through the `whisper-rs` crate (MIT) with ggml
Whisper models (`ggml-base.bin`, `ggml-small.bin`, …) from
https://huggingface.co/ggerganov/whisper.cpp (MIT; original OpenAI Whisper weights, MIT).
Models are not shipped with the installer; download with
`scripts/fetch_models.py --whisper base` or place them in `%APPDATA%\ShowMeterBeat\models`.
