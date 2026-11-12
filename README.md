# re-minimeter

Windows에서 나는 모든 소리(브라우저, 게임, REAPER 같은 DAW, 언리얼 같은 게임 엔진)를
시스템 루프백으로 받아 실시간으로 보여 주는 오디오 비주얼 아날라이저 + EBU R128 라우드니스 미터.

## 모듈
- **Spectrum** — 20 Hz~20 kHz 로그 스펙트럼(피크 홀드, 4.5 dB/oct 틸트)
- **Spectrogram** — 스크롤 스펙트로그램
- **Oscilloscope** — 트리거 오실로스코프(L/R)
- **Stereo** — 리사주(벡터스코프) + 상관 미터
- **Levels** — 헤더에서 Peak / True Peak / RMS / LUFS(M·S) 선택, 피크 홀드, 클립 표시
- **Loudness** — Momentary / Short-term / Integrated / LRA / True Peak + 60초 히스토리, 타깃 프리셋(YouTube/Spotify −14, 팟캐스트 −16, −18, EBU −23, ATSC −24)
- **Vocal Tract** — 들어오는 소리에서 LPC로 추정한 F1/F2/F3·피치로 움직이는 발성 기관 측면도(혀·턱·입술·성대 진동·기류)
- **Vowel Map** — F1–F2 모음 포먼트 지도(IPA 기준 모음 10개, 실시간 마커와 1.5초 궤적, 가장 가까운 모음 표시)

모듈은 켜고 끌 수 있고, "레이아웃 편집"(E)에서 드래그로 옮기고 모서리로 크기를 바꾼다. 배치는 저장된다.

## 녹음
상단 **● 녹음**(또는 스페이스)으로 시스템 소리를 그대로 WAV(32-bit float, 스테레오)로 받고, **■ 중지·저장**을 누르면 저장 위치를 묻는다. 취소하면 임시 파일은 지워진다.

## 빌드
- 요구: Node 20+, Rust(rustup), Visual Studio Build Tools(C++ 워크로드), WebView2(Windows 11 기본 포함)
- `npm install` → `npm run tauri dev`
- 설치본: `npm run tauri build`

## 구조
`AGENTS.md`(코드 구조·규칙), `DESIGN.md`(디자인 시스템) 참고.
