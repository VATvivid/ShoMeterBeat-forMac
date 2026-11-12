# re-minimeter

Windows에서 나는 모든 소리(브라우저, 게임, REAPER 같은 DAW, 언리얼 같은 게임 엔진)를
시스템 루프백으로 받아 실시간으로 보여 주는 오디오 비주얼 아날라이저 + EBU R128 라우드니스 미터.

## 모듈
- **Spectrum** — 20 Hz~20 kHz 로그 스펙트럼(피크 홀드, 4.5 dB/oct 틸트)
- **Spectrogram** — 스크롤 스펙트로그램
- **Oscilloscope** — 트리거 오실로스코프(L/R)
- **Stereo** — 리사주(벡터스코프) + 상관 미터
- **Levels** — 피크/RMS 레벨 미터, 피크 홀드, 클립 표시
- **Loudness** — Momentary / Short-term / Integrated / LRA / True Peak + 60초 히스토리, 타깃 선택

모듈은 켜고 끌 수 있고, "레이아웃 편집"(E)에서 드래그로 옮기고 모서리로 크기를 바꾼다. 배치는 저장된다.

## 빌드
- 요구: Node 20+, Rust(rustup), Visual Studio Build Tools(C++ 워크로드), WebView2(Windows 11 기본 포함)
- `npm install` → `npm run tauri dev`
- 설치본: `npm run tauri build`

## 구조
`AGENTS.md`(코드 구조·규칙), `DESIGN.md`(디자인 시스템) 참고.
