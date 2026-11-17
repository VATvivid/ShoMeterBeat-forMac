# AGENTS.md — ShowMeterBeat

Windows용 시스템 오디오 비주얼 아날라이저 + EBU R128 라우드니스 미터. Tauri 2(Rust 엔진) + Vite/TypeScript(캔버스 UI).

## 먼저 읽을 것
- `DESIGN.md` — UI를 만들거나 고치기 전에 반드시 읽는다. 색은 CSS 토큰(`src/style.css` `:root`)만 쓰고 TypeScript에 hex를 쓰지 않는다(`theme()`).
- `src-tauri/src/audio/frame.rs` ↔ `src/engine/frame.ts` — 바이너리 프레임 계약. 한쪽을 바꾸면 반드시 다른 쪽도 바꾼다.

## 구조
```
src-tauri/src/lib.rs            Tauri 명령(frame, list_devices, set_device, reset_loudness, status)
src-tauri/src/audio/mod.rs      스레드 2개(캡처·분석), 공유 상태, 링 버퍼
src-tauri/src/audio/capture.rs  cpal WASAPI 루프백(출력 장치에 입력 스트림)
src-tauri/src/audio/analyzer.rs FFT 8192·로그 256점 스펙트럼, 피크/RMS, 상관, 스코프/리사주 버퍼
src-tauri/src/audio/loudness.rs ebur128 (M/S/I/LRA/True Peak)
src-tauri/src/audio/voice.rs    LPC(14차, 4× 데시메이션) 포먼트 F1~F3 + 자기상관 피치/유성음 판정, 40 Hz 갱신
src-tauri/src/audio/recorder.rs hound WAV(32-bit float) 녹음 — 임시 폴더에 쓰고 저장 시 이동
crates/rm-shm/                  공유 메모리 브리지(Local\re-minimeter-bridge-v1, 슬롯 8개 링 버퍼, 선형 리샘플) — 앱과 플러그인이 공유
crates/rm-send-plugin/          nih-plug CLAP+VST3 "ShowMeterBeat Send" (통과 + 브리지에 사본 쓰기). 빌드: npm run plugin
src-tauri/plugins/              bundle_plugin.py가 만든 .clap / .vst3 (git 제외, NSIS 리소스로 포함)
                                소스 모드(audio/mod.rs Mode): Auto=루프백+플러그인 합산(기본) / Output / Input / Plugin
src/engine/source.ts            Tauri면 invoke('frame'), 아니면 합성 신호(브라우저 개발용)
src/modules/*.ts                모듈 1개 = 클래스 1개(draw(ctx, frame)), index.ts에 등록
src/modules/vowels.ts           모음 기준 포먼트(Peterson & Barney 1952, 남/여/아동)와 거리, 추가 모음(chimera 표)
src/modules/vowelTargets.ts     모음별 조음 값 표(chimera-vocal-synth MIT 데이터, THIRD_PARTY_NOTICES.md) — 생성 파일, 손으로 고치지 않음
src/modules/articulation.ts     F1/F2 → 조음 값(가까운 모음 4개 역거리 보간), REST 자세
src/modules/tract.ts            측면도 그리기(체 좌표 cm, 원점 성문): 턱 회전·혀·입술·후두·잔상·열색·캘리퍼·호흡
src/layout/grid.ts              그리드 타일(기본 24×16 + 편집 모드 +/− 열·행, 타일이 쓰는 칸은 항상 포함), 편집 모드 드래그/리사이즈. 배치 방식 settings.layoutMode: free(겹침 허용, 기본)/swap(자리 바꾸기, resolveSwap)/push(밀어내기, resolvePush). 드래그 미리보기는 항상 전체 레이아웃으로 dims 계산(칸 크기 불변), 창 밖 드롭은 onXDrag로 위임
src/state.ts                    설정·레이아웃 저장, 기본 배치(DESIGN.md §5). WIN_LABEL/IS_POP(URL ?win=), 별도 창은 자기 레이아웃 키, settings는 storage 이벤트로 창 간 동기화
src/main.ts                     모든 창의 진입점: 그리드·렌더 루프·파일 드롭 공통, 메인이면 toolbar.ts, 별도 창이면 pop.ts
src/toolbar.ts                  메인 툴바·상태 바(모듈/편집/도킹/창 ▾/프리셋/녹음/장치/플러그인)
src/pop.ts                      별도 창 상단 바(드래그 영역·📌·투명도·모듈·편집·찾기·닫기)·리사이즈 그립·위치 저장
src/windows.ts                  별도 창 목록(rm.popwins.v1)·생성/복원/닫기(pop이 스스로 모듈을 rm://to-main으로 돌려보내고 destroy), 창 찾기 반짝임, 항상 위, 투명도(settings.opacityMode: bg = CSS --bg-alpha, 창은 transparent:true / window = set_opacity), 창 간 타일 드래그(rm://xdrag-*). rm.debug.browserArgs(localStorage)는 검증 빌드 전용 훅
src-tauri/src/lib.rs            창 명령: set_opacity(WS_EX_LAYERED), drag_hover/drag_drop(WindowFromPoint로 포인터 아래 창 찾기 → 이벤트), to_screen, 클립 폴더, 메인 창 닫히면 종료
src/modules/emoji.ts            도트 스프라이트(문자열 → 테마 토큰), 규칙 판별(frame 값만) / AI 판별(YAMNet 태그 → 스프라이트 표)
src/modules/aitags.ts           YAMNet 태그 그룹 + requestTagging(여러 모듈이 같이 켜고 끄는 공유 스위치)
src-tauri/src/audio/punch.rs    Fenton-Lee punch 미터: HPSS(미디언) 트랜지언트 → 수정 K-가중 → 옥타브 회귀 가중 → 280 ms 블록 dB; 온셋→히트(어택·프로파일·화려함), PM95 히스토그램. 프레임 헤더 30/31 = momentary punch / TSR
src/modules/punch.ts            Punch 모듈 UI: 라이브 바 · 마지막 히트 옥타브 프로파일 · 히트 이력(클릭 = 기준) · 세션 PM95/평균
src-tauri/src/audio/tempo.rs    파일 템포(Player): 플럭스+컬럼 RMS → 액센트 가중 온셋 함수 → 6 s ACF 누적(5탭 확장) → ½칸 lag 하모닉 합 → 넓은 사전(120 BPM ±1옥타브, 자동) → 옥타브 동률 판정(절반 lag가 90 % 이상이면 채택) → 포물선 보정
src/modules/transient.ts        BPM Checker: tempo.rs와 같은 추정기를 라이브 overview(flux·rms 컬럼)에 적용. 온셋 간격 임시 펄스 BPM(ACF 잠금 전), 비트 점은 온셋에 위상 고정 + 0.5 s 지연 보정. 두 파일은 같이 고친다
src-tauri/src/audio/melody.rs   주 멜로디 f0 살리언스: 미드 FFT 피크 → f/h(h≤10) 투표(20센트 격자 C2–C7, 0.8^(h−1)·√amp) → 멜로디 음역 사전 → 상위 4후보(Hz, 살리언스). 프레임 꼬리 [2*N_MELODY]
src/modules/keysynth.ts         건반 클릭 → 피아노 소리(WebAudio 가산 신디, Piano·Pitch 공용). 시스템 출력으로 나가 루프백에 다시 들어온다
src/modules/cozy.ts             Cozy 모듈: 원화 `public/cozy/corner.png`를 160×96 격자에 깔고 움직이는 부분만 덧그림(`drawArt`: 레벨→램프 글로우, 스펙트럼→라디오 바, 재생 중 음표, 머그 김, 평탄도→창 비, melody→건반, 조용하면 zzz). 타일 = 황혼 배경 위 맞춤, 미니 창 = 투명·모서리 밀착·정수 배율. 원화가 없을 때만 코드로 그린 방/코너(`--cozy-*` 토큰)로 폴백
public/cozy/corner.png          미니 코너 원화(RGBA, 5:3). `scripts/cozy_asset.py`로 목업에서 잘라 바탕화면 키잉·반전해 만든다. 바꾸면 그림이 바뀌고, cozy.ts drawArt의 캘리브레이션 좌표(램프·라디오·머그·창·건반)만 맞추면 된다
src/mini.ts                     코지 미니 전용 창(`?win=mini`, 별도 창 기능과 별개, 툴바 🐱 `#mini-btn` 토글·`rm://mini-state`): 투명·프레임 없음·항상 위·작업표시줄 제외, 왼쪽 위 그립 드래그로 크기(5:3, 오른쪽 아래 고정, 240~1600, `rm.mini.v1`에 저장), 보통 `cozy` 모듈 한 타일(설정 공유, `IS_MINI`로 코너 뷰), 끌어서 이동(캔버스가 드래그 영역), 우클릭 설정·닫기, 호버 ✕, 위치·열림 상태 `rm.mini.v1`로 복원. 창 ▾ → 🐱 코지 미니(토글)
src/dock.ts installDockGrip      도킹 띠 안쪽 가장자리 그립 드래그 = 띠 두께(dockSize) 실시간 조절(두께 선택 UI 없음); grid.ts 도킹 셀은 쓰는 칸 수로 띠를 꽉 채움(최소 28 px, 넘치면 스크롤); 도킹 중 body·타일은 투명도와 무관하게 불투명
src/modules/piano.ts            Piano 모듈: 멜로디 1후보(모노)로 눌린 건반 표시 + 찍힌 노트가 건반에서 위로 올라가는 롤(미래 노트 없음, 모니터링). 건반 창은 옥타브 단위 자동 추적 / 전체 88건
```
밸리스틱(릴리스, 피크 홀드, 스무딩)은 전부 프론트에서 한다. Rust는 순간값만 보낸다.

## 실행
```
npm install
npm run tauri dev        # Rust + MSVC 필요
npm run dev              # 브라우저 미리보기(합성 신호), http://localhost:1420
cd src-tauri && cargo test
npm run tauri build      # NSIS 설치본 → src-tauri/target/release/bundle/nsis
```

## 새 모듈 추가
1. `src/modules/<id>.ts`에 `Module` 구현(`draw`, 필요하면 `headReadout`/`headControl`/`resize`).
2. `src/modules/index.ts`의 `MODULES`·`MODULE_TITLES`에 등록.
3. `src/state.ts` `defaultLayout()`에 기본 위치·크기 추가.

## 녹음 흐름
UI `rec_start` → 분석 스레드가 임시 WAV에 기록 → `rec_stop`이 파일을 닫고 경로 반환 → UI가 `@tauri-apps/plugin-dialog` `save()`로 위치를 받아 `rec_save`(이동) 또는 `rec_discard`. 권한은 `capabilities/default.json`의 `dialog:allow-save`.

## 규칙
- 레퍼런스 프로그램의 이름·로고·리소스·코드를 넣지 않는다. 발성 기관·모음 지도는 `jamesondh/chimera-vocal-synth`(MIT)의 구성(캔버스 측면도, F2↔F1 로그축 모음 지도)을 참고했을 뿐 코드·데이터를 복제하지 않았다.
- 커밋 전 `npm run build`(tsc 포함)와 `cargo test`가 통과해야 한다. 릴리스 exe는 `npm run tauri build -- --features subtitles`(whisper 포함)로 만든다.
- 창 간 상태: localStorage는 모든 창이 공유한다. 레이아웃은 창마다 키가 다르고(메인 `rm.layout.v2`, 별도 창 `rm.layout.pop.<label>.v1`), 별도 창을 여는 쪽이 그 키를 먼저 써 놓는다. 다른 창의 레이아웃은 직접 고치지 말고 이벤트(`rm://add-module`, `rm://to-main`, `rm://pop-close-request`)로 부탁한다.
- 끌어놓기 클립(`↗ DAW로 끌기`)은 DAW가 경로를 참조하므로 자동 삭제하지 않는다(취소 시에만 삭제).
