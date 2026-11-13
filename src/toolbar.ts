// Main-window toolbar + status bar: modules, layout edit, dock, presets, the 창 menu
// (pin / opacity / pop-outs / find), recording, device select, plugin install.
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import type { Frame } from "./engine/frame";
import { inTauri, type Source } from "./engine/source";
import type { Grid } from "./layout/grid";
import { applyDock } from "./dock";
import { buildModulesPanel, closeAllMenus, wireMenu } from "./modulespanel";
import { applyPresetState, capturePreset, deletePreset, loadPresets, presetFromJson, presetToJson, storePreset, type Preset } from "./presets";
import { layoutKindFor, onSettingsSynced, resetLayout, saveSettings, settings, type DockMode } from "./state";
import { notice, noticeHeld } from "./status";
import { applyOpacity, closePop, createPop, flashAll, loadPops, popTitle, restorePops, setAlwaysOnTop } from "./windows";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface Toolbar { onFrame(f: Frame, now: number): void }

export function initToolbar(grid: Grid, source: Source): Toolbar {
  // ---- modules -----------------------------------------------------------------
  const modulesPanel = $("modules-panel");
  wireMenu($("modules-btn"), modulesPanel, () => buildModulesPanel(grid, modulesPanel));
  grid.onChange = () => { if (!modulesPanel.classList.contains("hidden")) buildModulesPanel(grid, modulesPanel); };

  const editBtn = $<HTMLButtonElement>("edit-btn");
  function setEditing(on: boolean) {
    grid.setEditing(on);
    editBtn.classList.toggle("on", on);
    editBtn.textContent = on ? "편집 끝내기" : "레이아웃 편집";
  }
  editBtn.addEventListener("click", () => setEditing(!grid.isEditing));
  grid.onToggleEdit = () => setEditing(!grid.isEditing);
  $("reset-layout-btn").addEventListener("click", () => { resetLayout(grid.layoutKind); grid.sync(); });

  // ---- dock mode -----------------------------------------------------------------
  const dockBtn = $<HTMLButtonElement>("dock-btn");
  const dockPanel = $("dock-panel");
  const DOCKS: { mode: DockMode; label: string }[] = [
    { mode: "none", label: "도킹 해제 (일반 창)" },
    { mode: "top", label: "화면 위에 붙이기" },
    { mode: "bottom", label: "화면 아래에 붙이기" },
    { mode: "left", label: "화면 왼쪽에 붙이기" },
    { mode: "right", label: "화면 오른쪽에 붙이기" },
  ];
  async function setDock(mode: DockMode) {
    await applyDock(mode).catch((e) => console.error(e));
    grid.setKind(layoutKindFor(mode));
    buildDockPanel();
    dockBtn.classList.toggle("on", mode !== "none");
    dockBtn.textContent = mode === "none" ? "도킹 ▾" : `도킹: ${({ top: "위", bottom: "아래", left: "왼쪽", right: "오른쪽" } as Record<string, string>)[mode]} ▾`;
  }
  function buildDockPanel() {
    dockPanel.innerHTML = "";
    for (const d of DOCKS) {
      const row = document.createElement("label");
      const rb = document.createElement("input");
      rb.type = "radio"; rb.name = "dock"; rb.checked = settings.dock === d.mode;
      rb.addEventListener("change", () => { if (rb.checked) setDock(d.mode); });
      row.append(rb, document.createTextNode(d.label));
      dockPanel.appendChild(row);
    }
    const sizeRow = document.createElement("label");
    sizeRow.className = "row";
    const sel = document.createElement("select");
    sel.className = "mini";
    for (const px of [120, 160, 200, 260, 320, 400]) {
      const o = document.createElement("option");
      o.value = String(px); o.textContent = `${px}px`; o.selected = settings.dockSize === px;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => { settings.dockSize = Number(sel.value); saveSettings(); if (settings.dock !== "none") setDock(settings.dock); });
    sizeRow.append(document.createTextNode("띠 두께 "), sel);
    dockPanel.appendChild(sizeRow);
  }
  buildDockPanel();
  wireMenu(dockBtn, dockPanel);
  if (settings.dock !== "none") setDock(settings.dock);

  // ---- 창 menu: always on top, opacity, pop-out windows, find ---------------------
  const winBtn = $<HTMLButtonElement>("win-btn");
  const winPanel = $("win-panel");
  function buildWinPanel() {
    winPanel.innerHTML = "";
    const pinRow = document.createElement("label");
    const pin = document.createElement("input");
    pin.type = "checkbox"; pin.checked = settings.alwaysOnTop;
    pin.addEventListener("change", () => { settings.alwaysOnTop = pin.checked; saveSettings(); if (settings.dock === "none") setAlwaysOnTop(pin.checked); });
    pinRow.append(pin, document.createTextNode("📌 메인 창 항상 위에"));
    winPanel.appendChild(pinRow);
    const opRow = document.createElement("label");
    opRow.className = "row";
    const op = document.createElement("input");
    op.type = "range"; op.min = "0"; op.max = "100"; op.step = "5"; op.value = String(settings.opacity);
    const opVal = document.createElement("span"); opVal.className = "ctx-val"; opVal.textContent = `${settings.opacity}%`;
    op.addEventListener("input", () => { settings.opacity = Number(op.value); saveSettings(); opVal.textContent = `${op.value}%`; applyOpacity(settings.opacity); });
    opRow.append(document.createTextNode("투명도 "), op, opVal);
    winPanel.appendChild(opRow);
    const modeRow = document.createElement("label");
    modeRow.className = "row";
    const modeSel = document.createElement("select");
    for (const [v, l] of [["bg", "배경만 흐리게 (글자·그래프 선명)"], ["window", "창 전체 흐리게"]] as const) { const o = document.createElement("option"); o.value = v; o.textContent = l; modeSel.appendChild(o); }
    modeSel.value = settings.opacityMode;
    modeSel.addEventListener("change", () => { settings.opacityMode = modeSel.value as "bg" | "window"; saveSettings(); applyOpacity(settings.opacity); });
    modeRow.append(document.createTextNode("투명 방식 "), modeSel);
    winPanel.appendChild(modeRow);
    const sep = document.createElement("div"); sep.className = "ctx-sep"; winPanel.appendChild(sep);
    const row = document.createElement("div"); row.className = "preset-row";
    const newBtn = document.createElement("button"); newBtn.className = "btn"; newBtn.textContent = "새 별도 창";
    newBtn.title = "빈 별도 창을 연다 — 타일을 편집 모드에서 그 창으로 끌어다 놓거나, 타일 우클릭 → 별도 창으로 보내기";
    newBtn.addEventListener("click", () => { closeAllMenus(); createPop({ modules: [] }).catch((e) => notice(`창 열기 실패: ${String(e)}`, "err")); });
    const findBtn = document.createElement("button"); findBtn.className = "btn"; findBtn.textContent = "◎ 창 찾기";
    findBtn.title = "메인 창과 열린 별도 창의 테두리를 두 번 반짝인다";
    findBtn.addEventListener("click", () => flashAll());
    row.append(newBtn, findBtn);
    winPanel.appendChild(row);
    const pops = loadPops();
    if (pops.length) { const sep2 = document.createElement("div"); sep2.className = "ctx-sep"; winPanel.appendChild(sep2); }
    pops.forEach((p, i) => {
      const r = document.createElement("div"); r.className = "preset-row";
      const name = document.createElement("span"); name.className = "win-name"; name.textContent = popTitle(p.label, i);
      const focus = document.createElement("button"); focus.className = "btn icon"; focus.title = "앞으로"; focus.textContent = "↗";
      focus.addEventListener("click", async () => {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const w = await WebviewWindow.getByLabel(p.label);
        if (w) await w.setFocus().catch(() => {}); else await restorePops();
      });
      const x = document.createElement("button"); x.className = "btn icon"; x.title = "닫기 (모듈은 메인으로)"; x.textContent = "×";
      x.addEventListener("click", () => closePop(p.label, grid).then(buildWinPanel));
      r.append(name, focus, x);
      winPanel.appendChild(r);
    });
  }
  wireMenu(winBtn, winPanel, buildWinPanel);
  if (inTauri) {
    listen<{ label: string }>("rm://pop-close-request", (e) => closePop(e.payload.label, grid).then(buildWinPanel)).catch(() => {});
    listen("rm://pop-closed", () => buildWinPanel()).catch(() => {});
    restorePops().catch((e) => console.error(e));
  }
  onSettingsSynced(() => { /* per-module settings changed in a pop-out: modules read them live */ });

  // ---- presets (layout + settings + dock) -----------------------------------------
  const presetPanel = $("preset-panel");
  async function applyPreset(name: string, p: Preset) {
    applyPresetState(p);
    await setDock(p.dock);          // switches layout kind if needed
    grid.sync();                    // same kind: re-place tiles with the new rects
    await populateDevices().catch(() => {});
    notice(`프리셋 적용: ${name}`, "ok", 3000);
    buildPresetPanel();
  }
  function buildPresetPanel() {
    presetPanel.innerHTML = "";
    const all = loadPresets();
    const names = Object.keys(all).sort();
    if (!names.length) {
      const e = document.createElement("div"); e.className = "preset-empty"; e.textContent = "저장된 프리셋 없음";
      presetPanel.appendChild(e);
    }
    names.forEach((name, i) => {
      const row = document.createElement("div");
      row.className = "preset-row";
      const apply = document.createElement("button");
      apply.className = "btn preset-apply";
      const p = all[name];
      const dockLabel = p.dock === "none" ? "일반" : ({ top: "위", bottom: "아래", left: "왼쪽", right: "오른쪽" } as Record<string, string>)[p.dock];
      apply.innerHTML = `<span class="k">${i < 9 ? `Ctrl+${i + 1}` : ""}</span>${name}<span class="d">${dockLabel}</span>`;
      apply.addEventListener("click", () => { closeAllMenus(); applyPreset(name, p); });
      const over = document.createElement("button");
      over.className = "btn icon"; over.title = "현재 상태로 덮어쓰기"; over.textContent = "↻";
      over.addEventListener("click", () => { storePreset(name); buildPresetPanel(); });
      const del = document.createElement("button");
      del.className = "btn icon"; del.title = "삭제"; del.textContent = "×";
      del.addEventListener("click", () => { deletePreset(name); buildPresetPanel(); });
      row.append(apply, over, del);
      presetPanel.appendChild(row);
    });
    const sep = document.createElement("div"); sep.className = "ctx-sep"; presetPanel.appendChild(sep);
    const saveRow = document.createElement("div");
    saveRow.className = "preset-row";
    const input = document.createElement("input");
    input.type = "text"; input.placeholder = "이름 입력 후 저장"; input.className = "preset-name";
    input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") saveBtn.click(); });
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn on"; saveBtn.textContent = "현재 상태 저장";
    saveBtn.addEventListener("click", () => { const n = input.value.trim(); if (!n) { input.focus(); return; } storePreset(n); buildPresetPanel(); });
    saveRow.append(input, saveBtn);
    presetPanel.appendChild(saveRow);
    if (inTauri) {
      const io = document.createElement("div");
      io.className = "preset-row";
      const exp = document.createElement("button"); exp.className = "btn"; exp.textContent = "내보내기 (JSON)";
      exp.addEventListener("click", async () => {
        const n = input.value.trim() || "preset";
        const dst = await saveDialog({ title: "프리셋 내보내기", defaultPath: `${n}.rmpreset.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
        if (dst) await source.writeText(dst, presetToJson(n, capturePreset()));
      });
      const imp = document.createElement("button"); imp.className = "btn"; imp.textContent = "가져오기…";
      imp.addEventListener("click", async () => {
        const r = await openDialog({ title: "프리셋 가져오기", multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
        const path = typeof r === "string" ? r : null;
        if (!path) return;
        try { const { name, preset } = presetFromJson(await source.readText(path)); storePreset(name, preset); buildPresetPanel(); }
        catch (err) { notice(`가져오기 실패: ${String(err)}`, "err"); }
      });
      io.append(exp, imp);
      presetPanel.appendChild(io);
    }
  }
  buildPresetPanel();
  wireMenu($("preset-btn"), presetPanel, buildPresetPanel);
  document.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.key < "1" || e.key > "9") return;
    const all = loadPresets(); const names = Object.keys(all).sort();
    const name = names[Number(e.key) - 1];
    if (name) { e.preventDefault(); applyPreset(name, all[name]); }
  });
  $("reset-loudness-btn").addEventListener("click", () => source.resetLoudness());

  // ---- recording ---------------------------------------------------------------
  const recBtn = $<HTMLButtonElement>("rec-btn");
  const recTime = $("rec-time");
  let recording = false;
  let recBusy = false;
  function fmtTime(s: number) {
    const m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }
  async function toggleRecording() {
    if (recBusy) return;
    recBusy = true;
    try {
      if (!recording) {
        await source.recStart();
        recording = true;
        recBtn.classList.add("on");
        recBtn.textContent = "■ 중지·저장";
        recTime.classList.remove("hidden");
        recTime.textContent = "00:00";
      } else {
        const tmp = await source.recStop();
        recording = false;
        recBtn.classList.remove("on");
        recBtn.textContent = "● 녹음";
        recTime.classList.add("hidden");
        if (!inTauri) return;
        const name = await source.recDefaultName();
        const dst = await saveDialog({ title: "녹음 저장", defaultPath: name, filters: [{ name: "WAV", extensions: ["wav"] }] });
        if (dst) {
          await source.recSave(tmp, dst);
          notice(`저장됨: ${dst}`, "ok", 8000);
        } else {
          await source.recDiscard(tmp);
          notice("녹음 취소(파일 삭제)");
        }
      }
    } catch (e) {
      notice(`녹음 오류: ${String(e)}`, "err");
      recording = false;
      recBtn.classList.remove("on");
      recBtn.textContent = "● 녹음";
      recTime.classList.add("hidden");
    } finally {
      recBusy = false;
    }
  }
  recBtn.addEventListener("click", toggleRecording);
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
    if (e.key === "r" || e.key === "R") source.resetLoudness();
    if (e.key === " ") { e.preventDefault(); toggleRecording(); }
  });

  // ---- device select ---------------------------------------------------------
  const deviceSel = $<HTMLSelectElement>("device-select");
  // Option value = "<mode>|<name>". "auto|" = default output loopback + DAW plugins.
  const srcKey = (mode: string, name: string) => `${mode}|${name}`;
  async function populateDevices() {
    const devs = await source.listDevices();
    deviceSel.innerHTML = "";
    const outs = devs.filter((d) => d.kind === "output"), ins = devs.filter((d) => d.kind === "input");
    const group = (label: string) => { const g = document.createElement("optgroup"); g.label = label; deviceSel.appendChild(g); return g; };
    const opt = (g: HTMLOptGroupElement, value: string, text: string) => { const o = document.createElement("option"); o.value = value; o.textContent = text; g.appendChild(o); };
    const gAuto = group("자동 (권장)");
    opt(gAuto, srcKey("auto", ""), `자동: 기본 출력 루프백 + DAW 플러그인${outs.length ? ` (${outs[0].name})` : ""}`);
    for (const d of outs.filter((d) => !d.default)) opt(gAuto, srcKey("auto", d.name), `자동: ${d.name} 루프백 + DAW 플러그인`);
    const gOut = group("출력 장치만 (루프백)");
    opt(gOut, srcKey("output", ""), outs.length ? `기본 출력: ${outs[0].name}` : "출력 장치 없음");
    for (const d of outs.filter((d) => !d.default)) opt(gOut, srcKey("output", d.name), d.name);
    if (ins.length) {
      const gIn = group("입력 장치만 (인터페이스 루프백 · 가상 케이블)");
      for (const d of ins) opt(gIn, srcKey("input", d.name), (d.default ? "기본 입력: " : "") + d.name);
    }
    const gPlug = group("DAW 플러그인");
    opt(gPlug, srcKey("plugin", ""), "DAW 플러그인만 (re-minimeter Send)");
    const wanted = srcKey(settings.sourceMode, settings.device ?? "");
    const exists = [...deviceSel.options].some((o) => o.value === wanted);
    deviceSel.value = exists ? wanted : srcKey("auto", "");
    if (deviceSel.value !== srcKey("auto", "")) await source.setSource(settings.sourceMode, settings.device);
  }
  deviceSel.addEventListener("change", async () => {
    const [mode, ...rest] = deviceSel.value.split("|");
    settings.sourceMode = (["auto", "output", "input", "plugin"].includes(mode) ? mode : "auto") as typeof settings.sourceMode;
    settings.device = rest.join("|") || null;
    saveSettings();
    await source.setSource(settings.sourceMode, settings.device);
  });
  populateDevices().catch((e) => console.error(e));

  // ---- DAW plugin install --------------------------------------------------------
  // First run on this PC: copy the bundled CLAP/VST3 into the user plugin folders once,
  // so a teammate has nothing to click after installing (the button stays for re-installs).
  if (inTauri) {
    try {
      if (!localStorage.getItem("rm.plugins.installed.v1")) {
        source.installPlugins().then((paths) => {
          try { localStorage.setItem("rm.plugins.installed.v1", new Date().toISOString()); } catch { /* ignore */ }
          notice(`첫 실행: DAW 플러그인을 설치했습니다 → ${paths.join(" , ")} (DAW에서 플러그인 재스캔)`, "ok", 15000);
        }).catch((e) => notice(`플러그인 자동 설치 실패: ${String(e)} — 메뉴에서 다시 시도`, "err", 10000));
      }
    } catch { /* ignore */ }
  }
  $("install-plugin-btn").addEventListener("click", async () => {
    try {
      const paths = await source.installPlugins();
      notice(`플러그인 설치됨 → ${paths.join(" , ")} — DAW에서 플러그인 재스캔`, "ok", 15000);
    } catch (e) {
      notice(`플러그인 설치 실패: ${String(e)}`, "err");
    }
  });

  // ---- status bar ------------------------------------------------------------
  const stDevice = $("st-device"), stRate = $("st-rate"), stFps = $("st-fps"), stState = $("st-state");
  let frames = 0, fpsAt = performance.now();
  async function pollStatus() {
    try {
      const s = await source.status();
      const src = s.mode === "plugin" ? "플러그인" : s.kind === "input" ? "입력" : s.mode === "auto" ? "자동" : "루프백";
      stDevice.textContent = `${src} ${s.device || "—"}${s.mode === "auto" || s.mode === "plugin" ? ` · 플러그인 ${s.plugins}` : ""}`;
      stRate.textContent = s.sample_rate ? `${s.sample_rate} Hz · ${s.channels}ch` : "— Hz";
      if (noticeHeld()) return;
      if (s.error && !s.running) { stState.textContent = `오류: ${s.error}`; stState.className = "err"; }
      else if (recording) { stState.textContent = "녹음 중"; stState.className = "err"; }
      else if (s.running) { stState.textContent = inTauri ? "캡처 중" : "브라우저 미리보기"; stState.className = "ok"; }
      else { stState.textContent = "대기"; stState.className = ""; }
    } catch (e) {
      stState.textContent = `오류: ${String(e)}`; stState.className = "err";
    }
  }
  pollStatus();
  setInterval(pollStatus, 1000);

  return {
    onFrame(f, now) {
      if (recording && f.recSeconds >= 0) recTime.textContent = fmtTime(f.recSeconds);
      frames++;
      if (now - fpsAt >= 1000) { stFps.textContent = `${frames} fps`; frames = 0; fpsAt = now; }
    },
  };
}
