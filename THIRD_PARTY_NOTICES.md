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
