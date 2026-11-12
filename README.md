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
- **Pitch** — 피아노롤식 노트 블록(반음 단위로 묶음) + 정확한 피치 곡선, 음이름·센트 편차, 자동 음역 추적(1~3옥타브), 시간 범위 5~30초

모듈은 켜고 끌 수 있고, "레이아웃 편집"(E)에서 드래그로 옮기고 모서리로 크기를 바꾼다. 옮길 때 겹치는 모듈은 **밀려난다** — 끌어오는 쪽의 반대 방향(왼쪽에서 오면 오른쪽으로, 오른쪽에서 오면 왼쪽으로), 옆에 자리가 없으면 아래로. 드래그 중에는 점선 가이드로 도착 자리만 보여 주고 놓을 때 이동한다. 자리가 모자라면 그리드가 늘어난다(창 크기는 그대로, 칸이 작아짐). 배치는 저장된다.

- **모듈 설정**: 타일 아무 곳이나 **우클릭**(또는 헤더 ⋯) → 그 모듈의 설정. Spectrogram 2D/3D·속도, Spectrum 기울기·범위·피크 홀드, Levels 표시 값, Loudness 타깃, Stereo 잔상.
- **도킹**: 상단 "도킹 ▾"에서 화면 위/아래/왼쪽/오른쪽에 띠 모양으로 붙인다(항상 위, 테두리 없음). 도킹 상태에서는 모듈이 한 줄로 놓이고 배치가 따로 저장된다. 띠 두께는 같은 메뉴에서.

## 소리 입력 선택
상단 드롭다운 기본값은 **자동**이다: 기본 출력 장치의 루프백(브라우저·게임·일반 앱) **+** DAW에 꽂은 `re-minimeter Send` 플러그인 신호를 **합쳐서** 동시에 보여 준다. 손댈 것이 없다.

- **자동 (권장)** — 루프백 + DAW 플러그인. 다른 출력 장치의 루프백을 쓰고 싶으면 같은 묶음에서 고른다.
- **출력 장치만(루프백)** — 그 장치로 나가는 모든 Windows 소리.
- **입력 장치만** — 오디오 인터페이스의 하드웨어 루프백이나 가상 케이블. 플러그인을 꽂을 수 없는 앱(Pro Tools 등)용. Windows "마이크 액세스"가 켜져 있어야 한다.
  - RME: TotalMix FX에서 모니터링 출력(예: AN 1/2)의 **Loopback**을 켜면 같은 번호의 입력("Analog (1+2)")으로 되돌아온다.
- **DAW 플러그인만** — 루프백 없이 플러그인 신호만.

## DAW 플러그인 (re-minimeter Send)
ASIO로 동작하는 DAW(REAPER, Cubase/Nuendo, Ableton, Studio One, Bitwig…)는 Windows 믹서를 거치지 않아 루프백에 안 잡힌다. 대신 트랙이나 마스터에 **re-minimeter Send**를 꽂으면 소리는 그대로 통과하면서 사본이 앱으로 전달된다(공유 메모리, 지연 없음, 여러 개 꽂으면 합산, 최대 8개).

1. 앱 상단 **플러그인 설치** 클릭 → `%LOCALAPPDATA%\Programs\Common\CLAP\` 와 `...\VST3\` 에 복사된다(관리자 권한 불필요).
2. DAW에서 플러그인 재스캔. DAW가 그 폴더를 안 보면 플러그인 경로에 추가한다(REAPER: Preferences → Plug-ins → VST / CLAP 경로).
3. 마스터(또는 원하는 트랙)에 "re-minimeter Send" 삽입. 앱 상태 바의 "플러그인 N"이 올라가면 연결된 것.

- 형식: **CLAP**(ISC) + **VST3**. VST3 래퍼(nih-plug/vst3-sys)는 **GPLv3**이므로 외부 배포 시 라이선스 확인 필요. 사내·개인 사용은 무관.
- **Pro Tools(AAX)는 지원하지 않는다** — Avid 개발자 계약·서명이 필요해 만들 수 없다. 입력 장치(인터페이스 루프백) 경로를 쓴다.
- 플러그인 빌드: `npm run plugin` (crates/rm-send-plugin → src-tauri/plugins/). 설치본(NSIS)에는 자동 포함된다.

## 녹음
상단 **● 녹음**(또는 스페이스)으로 시스템 소리를 그대로 WAV(32-bit float, 스테레오)로 받고, **■ 중지·저장**을 누르면 저장 위치를 묻는다. 취소하면 임시 파일은 지워진다.

## 빌드
- 요구: Node 20+, Rust(rustup), Visual Studio Build Tools(C++ 워크로드), WebView2(Windows 11 기본 포함)
- `npm install` → `npm run tauri dev`
- 설치본: `npm run tauri build`

## 구조
`AGENTS.md`(코드 구조·규칙), `DESIGN.md`(디자인 시스템) 참고.
