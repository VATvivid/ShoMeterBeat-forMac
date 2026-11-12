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

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  if (e.key === "r" || e.key === "R") source.resetLoudness();
  if (e.key === "e" || e.key === "E") setEditing(!grid.isEditing);
  if (e.key === "Escape") setEditing(false);
});

// ---- device select ---------------------------------------------------------
const deviceSel = $<HTMLSelectElement>("device-select");
async function populateDevices() {
  const names = await source.listDevices();
  deviceSel.innerHTML = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = names.length ? `기본 출력: ${names[0]}` : "출력 장치 없음";
  deviceSel.appendChild(def);
  for (const n of names.slice(1)) {
    const o = document.createElement("option");
    o.value = n; o.textContent = n;
    deviceSel.appendChild(o);
  }
  if (settings.device && names.includes(settings.device)) {
    deviceSel.value = settings.device;
    await source.setDevice(settings.device);
  }
}
deviceSel.addEventListener("change", async () => {
  settings.device = deviceSel.value || null;
  saveSettings();
  await source.setDevice(settings.device);
});
populateDevices().catch((e) => console.error(e));

// ---- status bar ------------------------------------------------------------
const stDevice = $("st-device"), stRate = $("st-rate"), stFps = $("st-fps"), stState = $("st-state");
let frames = 0, fpsAt = performance.now();
async function pollStatus() {
  try {
    const s = await source.status();
    stDevice.textContent = `장치 ${s.device || "—"}`;
    stRate.textContent = s.sample_rate ? `${s.sample_rate} Hz · ${s.channels}ch` : "— Hz";
    if (s.error && !s.running) { stState.textContent = `오류: ${s.error}`; stState.className = "err"; }
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
    frames++;
    if (now - fpsAt >= 1000) { stFps.textContent = `${frames} fps`; frames = 0; fpsAt = now; }
  } catch (e) {
    console.error(e);
  } finally {
    busy = false;
  }
}
requestAnimationFrame(loop);
