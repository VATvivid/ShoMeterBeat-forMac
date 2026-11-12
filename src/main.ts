import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { createSource, inTauri } from "./engine/source";
import { Grid } from "./layout/grid";
import { MODULE_TITLES } from "./modules";
import { layout, resetLayout, saveLayout, saveSettings, settings } from "./state";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const source = createSource();
const grid = new Grid($("grid"));

// ---- toolbar ---------------------------------------------------------------
const modulesBtn = $<HTMLButtonElement>("modules-btn");
const modulesPanel = $("modules-panel");
function buildModulesPanel() {
  modulesPanel.innerHTML = "";
  for (const [id, title] of Object.entries(MODULE_TITLES)) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!layout[id]?.on;
    cb.addEventListener("change", () => {
      if (!layout[id]) layout[id] = { x: 0, y: 0, w: 8, h: 6, on: true };
      layout[id].on = cb.checked;
      saveLayout();
      grid.sync();
    });
    label.append(cb, document.createTextNode(title));
    modulesPanel.appendChild(label);
  }
}
buildModulesPanel();
grid.onChange = buildModulesPanel;
modulesBtn.addEventListener("click", (e) => { e.stopPropagation(); modulesPanel.classList.toggle("hidden"); });
document.addEventListener("click", (e) => { if (!modulesPanel.contains(e.target as Node)) modulesPanel.classList.add("hidden"); });

const editBtn = $<HTMLButtonElement>("edit-btn");
function setEditing(on: boolean) {
  grid.setEditing(on);
  editBtn.classList.toggle("on", on);
  editBtn.textContent = on ? "편집 끝내기" : "레이아웃 편집";
}
editBtn.addEventListener("click", () => setEditing(!grid.isEditing));
$("reset-layout-btn").addEventListener("click", () => { resetLayout(); grid.sync(); buildModulesPanel(); });
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
      const dst = await saveDialog({
        title: "녹음 저장",
        defaultPath: name,
        filters: [{ name: "WAV", extensions: ["wav"] }],
      });
      if (dst) {
        await source.recSave(tmp, dst);
        stState.textContent = `저장됨: ${dst}`;
        stState.className = "ok";
        stateHoldUntil = performance.now() + 8000;
      } else {
        await source.recDiscard(tmp);
        stState.textContent = "녹음 취소(파일 삭제)";
        stState.className = "";
      }
    }
  } catch (e) {
    stState.textContent = `녹음 오류: ${String(e)}`;
    stState.className = "err";
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
  if (e.key === "e" || e.key === "E") setEditing(!grid.isEditing);
  if (e.key === " ") { e.preventDefault(); toggleRecording(); }
  if (e.key === "Escape") setEditing(false);
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
$("install-plugin-btn").addEventListener("click", async () => {
  try {
    const paths = await source.installPlugins();
    stState.textContent = `플러그인 설치됨 → ${paths.join(" , ")} — DAW에서 플러그인 재스캔`;
    stState.className = "ok";
    stateHoldUntil = performance.now() + 15000;
  } catch (e) {
    stState.textContent = `플러그인 설치 실패: ${String(e)}`;
    stState.className = "err";
  }
});

// ---- status bar ------------------------------------------------------------
const stDevice = $("st-device"), stRate = $("st-rate"), stFps = $("st-fps"), stState = $("st-state");
let frames = 0, fpsAt = performance.now();
let stateHoldUntil = 0; // keep "저장됨: …" visible for a while
async function pollStatus() {
  try {
    const s = await source.status();
    const src = s.mode === "plugin" ? "플러그인" : s.kind === "input" ? "입력" : s.mode === "auto" ? "자동" : "루프백";
    stDevice.textContent = `${src} ${s.device || "—"}${s.mode === "auto" || s.mode === "plugin" ? ` · 플러그인 ${s.plugins}` : ""}`;
    stRate.textContent = s.sample_rate ? `${s.sample_rate} Hz · ${s.channels}ch` : "— Hz";
    if (performance.now() < stateHoldUntil) return;
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

// ---- render loop -----------------------------------------------------------
let busy = false;
async function loop(now: number) {
  requestAnimationFrame(loop);
  if (busy) return;
  busy = true;
  try {
    const f = await source.tick();
    grid.draw(f, now);
    if (recording && f.recSeconds >= 0) recTime.textContent = fmtTime(f.recSeconds);
    frames++;
    if (now - fpsAt >= 1000) { stFps.textContent = `${frames} fps`; frames = 0; fpsAt = now; }
  } catch (e) {
    console.error(e);
  } finally {
    busy = false;
  }
}
requestAnimationFrame(loop);
