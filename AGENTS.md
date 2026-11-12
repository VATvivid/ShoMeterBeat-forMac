# AGENTS.md — re-minimeter

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
crates/rm-send-plugin/          nih-plug CLAP+VST3 "re-minimeter Send" (통과 + 브리지에 사본 쓰기). 빌드: npm run plugin
src-tauri/plugins/              bundle_plugin.py가 만든 .clap / .vst3 (git 제외, NSIS 리소스로 포함)
                                소스 모드(audio/mod.rs Mode): Auto=루프백+플러그인 합산(기본) / Output / Input / Plugin
src/engine/source.ts            Tauri면 invoke('frame'), 아니면 합성 신호(브라우저 개발용)
src/modules/*.ts                모듈 1개 = 클래스 1개(draw(ctx, frame)), index.ts에 등록
src/modules/vowels.ts           모음 기준 포먼트(Peterson & Barney 1952 남성 평균)와 거리·혀 위치 변환
src/layout/grid.ts              24×16 그리드 타일, 편집 모드 드래그/리사이즈, localStorage 저장
src/state.ts                    설정·레이아웃 저장, 기본 배치(DESIGN.md §5)
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
- 커밋 전 `npm run build`(tsc 포함)와 `cargo test`가 통과해야 한다.
