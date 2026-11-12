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
src/engine/source.ts            Tauri면 invoke('frame'), 아니면 합성 신호(브라우저 개발용)
src/modules/*.ts                모듈 1개 = 클래스 1개(draw(ctx, frame)), index.ts에 등록
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

## 규칙
- 레퍼런스 프로그램의 이름·로고·리소스·코드를 넣지 않는다.
- 커밋 전 `npm run build`(tsc 포함)와 `cargo test`가 통과해야 한다.
