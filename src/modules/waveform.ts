import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { Frame } from "../engine/frame";
import { getSource } from "../engine/instance";
import { inTauri, OV_STRIDE, type AiTag, type TagStatus, type WaveOverview } from "../engine/source";
import { GROUP_LABEL, requestTagging, tagGroup, type TagGroup } from "./aitags";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

// Scrolling waveform of the captured audio (newest at the right). Drag inside the
// tile to select a time range: scrolling pauses while you drag and while a
// selection is pending; "WAV 저장" renders exactly that range from the engine's
// 2-minute history to a 32-bit float stereo WAV.

const PAD_L = 34, PAD_B = 18, PAD_T = 6, PAD_R = 6;
const POLL_MS = 33;

export class WaveformModule implements Module {
  readonly id = "waveform";
  readonly title = "Waveform";
  private ov: WaveOverview | null = null;
  private lastPoll = 0;
  private polling = false;
  private frozen = false;           // true while dragging or while a selection is pending
  private dragging = false;
  private selA = 0; private selB = 0; // x positions (CSS px) within the canvas
  private hasSel = false;
  private body: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private busy = false;
  private note = "";
  private noteUntil = 0;

  private get seconds() { return modSetting(this.id, "seconds", 10); }
  private get dbScale() { return modSetting(this.id, "db", false); }
  private get aiOn() { return modSetting(this.id, "ai", false); }
  private get aiInterval() { return modSetting(this.id, "aiInterval", 1000); }
  private get aiFilter() { return modSetting<"all" | TagGroup>(this.id, "aiFilter", "all"); }
  private get aiMin() { return modSetting(this.id, "aiMin", 0.25); }
  private tags: AiTag[] = [];
  private tagSeq = 0;
  private tagStatus: TagStatus | null = null;
  private lastTagPoll = 0;
  private clipDir = "";

  settings(): SettingItem[] {
    return [
      { type: "select", label: "시간 범위", value: String(this.seconds), options: [2, 5, 10, 20, 30, 60, 120].map((v) => ({ value: String(v), label: `${v}초` })), onChange: (v) => setModSetting(this.id, "seconds", Number(v)) },
      { type: "toggle", label: "dB 스케일", value: this.dbScale, onChange: (v) => setModSetting(this.id, "db", v) },
      { type: "action", label: "선택 해제 / 재개", onClick: () => this.clearSelection() },
      { type: "toggle", label: "AI 태그 (YAMNet)", value: this.aiOn, onChange: (v) => setModSetting(this.id, "ai", v) },
      { type: "select", label: "AI 간격", value: String(this.aiInterval), options: [500, 1000, 2000].map((v) => ({ value: String(v), label: `${v / 1000} s` })), onChange: (v) => setModSetting(this.id, "aiInterval", Number(v)) },
      { type: "select", label: "AI 필터", value: this.aiFilter, options: [{ value: "all", label: "전체" }, ...(Object.keys(GROUP_LABEL) as TagGroup[]).map((g) => ({ value: g, label: GROUP_LABEL[g] }))], onChange: (v) => setModSetting(this.id, "aiFilter", v) },
      { type: "range", label: "AI 최소 점수", value: this.aiMin, min: 0.05, max: 0.7, step: 0.05, format: (v) => v.toFixed(2), onChange: (v) => setModSetting(this.id, "aiMin", v) },
      { type: "action", label: `DAW 끌어놓기 클립 폴더 변경… (${modSetting(this.id, "clipDir", "") || "문서/re-minimeter/clips"})`, onClick: () => this.chooseClipDir() },
    ];
  }

  /** Keep the engine's tagging state in sync with the settings; pull new tags. */
  private pollTags() {
    const src = getSource();
    if (!src) return;
    requestTagging(this.id, this.aiOn, this.aiInterval);
    if (!this.aiOn) return;
    const now = performance.now();
    if (now - this.lastTagPoll < 300) return;
    this.lastTagPoll = now;
    src.tagsSince(this.tagSeq).then((ts) => {
      for (const t of ts) { if (t.seq > this.tagSeq) { this.tagSeq = t.seq; this.tags.push(t); } }
      if (this.tags.length > 400) this.tags.splice(0, this.tags.length - 400);
    }).catch(() => {});
    src.tagStatus().then((s) => { this.tagStatus = s; }).catch(() => {});
  }

  headReadout() {
    if (this.frozen && this.hasSel && this.ov) {
      const [t0, t1] = this.selSeconds();
      return `선택 ${(t1 - t0).toFixed(2)} s  (일시정지)`;
    }
    return this.frozen ? "일시정지" : `${this.seconds} s`;
  }

  mount(body: HTMLElement, isEditing: () => boolean) {
    this.body = body;
    body.style.cursor = "text";
    body.addEventListener("pointerdown", (e) => {
      if (isEditing() || e.button !== 0) return;
      e.preventDefault();
      body.setPointerCapture(e.pointerId);
      const r = body.getBoundingClientRect();
      this.selA = this.selB = e.clientX - r.left;
      this.dragging = true; this.frozen = true; this.hasSel = false;
      this.hideOverlay();
    });
    body.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      const r = body.getBoundingClientRect();
      this.selB = Math.max(0, Math.min(r.width, e.clientX - r.left));
    });
    const finish = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      try { body.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (Math.abs(this.selB - this.selA) < 3) { this.clearSelection(); return; }
      this.hasSel = true;
      this.showOverlay();
    };
    body.addEventListener("pointerup", finish);
    body.addEventListener("pointercancel", finish);
    body.addEventListener("keydown", (e) => { if (e.key === "Escape") this.clearSelection(); });
  }

  private clearSelection() {
    this.hasSel = false; this.frozen = false; this.dragging = false;
    this.hideOverlay();
  }

  private showOverlay() {
    if (!this.body) return;
    this.hideOverlay();
    const el = document.createElement("div");
    el.className = "wave-overlay";
    const [t0, t1] = this.selSeconds();
    const btn = document.createElement("button");
    btn.className = "btn on";
    btn.textContent = `WAV 저장 (${(t1 - t0).toFixed(2)} s)`;
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => { e.stopPropagation(); this.exportSelection(); });
    const dragBtn = document.createElement("button");
    dragBtn.className = "btn";
    dragBtn.textContent = "↗ DAW로 끌기";
    dragBtn.title = "누른 채로 REAPER 등 DAW 트랙에 끌어다 놓으면 선택 구간이 WAV로 배치됩니다";
    dragBtn.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); this.dragOut(); });
    const cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.textContent = "취소";
    cancel.addEventListener("pointerdown", (e) => e.stopPropagation());
    cancel.addEventListener("click", (e) => { e.stopPropagation(); this.clearSelection(); });
    el.append(btn, dragBtn, cancel);
    const lo = Math.min(this.selA, this.selB), hi = Math.max(this.selA, this.selB);
    el.style.left = `${Math.max(4, Math.min(this.body.clientWidth - 300, (lo + hi) / 2 - 140))}px`;
    this.body.appendChild(el);
    this.overlay = el;
  }

  private hideOverlay() { this.overlay?.remove(); this.overlay = null; }

  /** Selection as [seconds-ago-start, seconds-ago-end] → returned as [t0, t1] seconds from the left edge. */
  private selSeconds(): [number, number] {
    const w = this.body?.clientWidth ?? 1;
    const pw = Math.max(1, w - PAD_L - PAD_R);
    const toT = (x: number) => Math.max(0, Math.min(this.seconds, ((x - PAD_L) / pw) * this.seconds));
    const a = toT(this.selA), b = toT(this.selB);
    return [Math.min(a, b), Math.max(a, b)];
  }

  private async exportSelection() {
    if (this.busy || !this.ov) return;
    this.busy = true;
    try {
      const [t0, t1] = this.selSeconds();
      const { sr, head } = this.ov;
      const end = Math.round(head - (this.seconds - t1) * sr);
      const start = Math.round(head - (this.seconds - t0) * sr);
      if (!inTauri) { this.setNote("브라우저 미리보기에서는 저장할 수 없습니다"); return; }
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      const dst = await saveDialog({ title: "선택 구간 WAV 저장", defaultPath: `re-minimeter_clip_${stamp}.wav`, filters: [{ name: "WAV", extensions: ["wav"] }] });
      if (!dst) return;
      const n = await getSource()!.waveExport(Math.max(0, start), Math.max(0, end), dst);
      this.setNote(`저장됨: ${(n / sr).toFixed(2)} s → ${dst}`);
      this.clearSelection();
    } catch (e) {
      this.setNote(`저장 실패: ${String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  private setNote(s: string) { this.note = s; this.noteUntil = performance.now() + 6000; }

  /** Folder the drag-out clips are written to (they must stay on disk: the DAW references them). */
  private async clipFolder(): Promise<string> {
    let dir = modSetting(this.id, "clipDir", "");
    if (!dir) dir = this.clipDir ||= await invoke<string>("default_clip_dir");
    await invoke("ensure_dir", { path: dir });
    return dir;
  }

  private async chooseClipDir() {
    if (!inTauri) return;
    const r = await openDialog({ title: "클립 폴더 선택", directory: true, multiple: false });
    if (typeof r === "string" && r) { setModSetting(this.id, "clipDir", r); this.setNote(`클립 폴더: ${r}`); }
  }

  /**
   * "↗ DAW로 끌기": renders the selection to the clip folder, then starts a native file
   * drag (OLE) while the button is still held, so the DAW receives a normal file drop.
   * A cancelled drag deletes the clip again.
   */
  private async dragOut() {
    if (this.busy || !this.ov) return;
    if (!inTauri) { this.setNote("브라우저 미리보기에서는 끌어놓기를 할 수 없습니다"); return; }
    this.busy = true;
    try {
      const [t0, t1] = this.selSeconds();
      const { sr, head } = this.ov;
      const end = Math.round(head - (this.seconds - t1) * sr);
      const start = Math.round(head - (this.seconds - t0) * sr);
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      const dir = await this.clipFolder();
      const dst = `${dir}\\re-minimeter_clip_${stamp}.wav`;
      await getSource()!.waveExport(Math.max(0, start), Math.max(0, end), dst);
      const icon = await invoke<string>("clip_drag_icon");
      const { startDrag } = await import("@crabnebula/tauri-plugin-drag");
      this.setNote("DAW 트랙 위에 놓으세요…");
      await startDrag({ item: [dst], icon, mode: "copy" }, (ev) => {
        if (ev.result === "Dropped") { this.setNote(`DAW에 배치됨: ${dst}`); this.clearSelection(); }
        else { this.setNote("끌어놓기 취소 (클립 삭제)"); getSource()!.recDiscard(dst).catch(() => {}); }
      });
    } catch (e) {
      this.setNote(`끌어놓기 실패: ${String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  private poll() {
    const src = getSource();
    if (!src || this.polling) return;
    const now = performance.now();
    if (now - this.lastPoll < POLL_MS) return;
    this.lastPoll = now;
    this.polling = true;
    src.waveOverview(this.seconds).then((o) => { if (o) this.ov = o; }).catch(() => {}).finally(() => { this.polling = false; });
  }

  draw(d: DrawCtx, _f: Frame) {
    const { ctx, w, h } = d;
    if (!this.frozen) this.poll();
    this.pollTags();
    const x0 = PAD_L, x1 = w - PAD_R, y0 = PAD_T, y1 = h - PAD_B;
    const pw = x1 - x0, ph = y1 - y0;
    if (pw < 20 || ph < 10) return;
    const mid = y0 + ph / 2;
    const db = this.dbScale;
    const amp = (v: number) => Math.max(-1, Math.min(1, v));
    // dB mode: one-sided level (0 … −60 dBFS) drawn upwards from the bottom.
    const dbY = (a: number) => { const d = a < 1e-5 ? -100 : 20 * Math.log10(a); return y1 - Math.max(0, Math.min(1, (d + 60) / 60)) * ph; };

    // Grid: centre line ±0.5, or dB lines every 10 dB; time ticks
    ctx.strokeStyle = theme("grid"); ctx.lineWidth = 1;
    ctx.fillStyle = theme("fg-1"); ctx.font = font(10); ctx.textAlign = "right"; ctx.textBaseline = "middle";
    if (db) {
      for (let d = 0; d >= -60; d -= 10) {
        const y = Math.round(y1 - ((d + 60) / 60) * ph) + 0.5;
        ctx.strokeStyle = theme("grid"); ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        if (d % 20 === 0) { ctx.fillStyle = theme("fg-1"); ctx.fillText(d === 0 ? "0" : `−${-d}`, x0 - 4, y); }
      }
    } else {
      for (const k of [-0.5, 0, 0.5]) {
        const y = Math.round(mid - k * ph / 2) + 0.5;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      }
      for (const [t, k] of [["1", 1], ["0.5", 0.5], ["0", 0], ["−0.5", -0.5], ["−1", -1]] as [string, number][]) ctx.fillText(t, x0 - 4, mid - k * ph / 2);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const step = this.seconds <= 5 ? 1 : this.seconds <= 20 ? 2 : this.seconds <= 60 ? 10 : 20;
    for (let s = 0; s <= this.seconds; s += step) {
      const x = Math.round(x0 + (s / this.seconds) * pw) + 0.5;
      ctx.strokeStyle = theme("grid"); ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      ctx.fillStyle = theme("fg-1"); ctx.fillText(s === this.seconds ? "now" : `−${this.seconds - s}s`, x, y1 + 4);
    }

    // Envelope
    const ov = this.ov;
    if (ov && ov.cols.length >= OV_STRIDE) {
      const n = ov.cols.length / OV_STRIDE;
      const colsWanted = this.seconds * 100;
      const sig = theme("sig");
      ctx.fillStyle = withAlpha(sig, 0.85);
      ctx.strokeStyle = sig; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let px = 0; px < pw; px++) {
        // columns covering this pixel (right-aligned: last column at x1)
        const c0 = Math.floor(((px) / pw) * colsWanted) - (colsWanted - n), c1 = Math.max(c0 + 1, Math.floor(((px + 1) / pw) * colsWanted) - (colsWanted - n));
        let mn = Infinity, mx = -Infinity;
        for (let c = Math.max(0, c0); c < Math.min(n, c1); c++) { mn = Math.min(mn, ov.cols[OV_STRIDE * c]); mx = Math.max(mx, ov.cols[OV_STRIDE * c + 1]); }
        if (mn === Infinity) continue;
        const x = x0 + px + 0.5;
        if (db) { const yt = dbY(Math.max(Math.abs(mn), Math.abs(mx))); ctx.moveTo(x, Math.min(yt, y1 - 1)); ctx.lineTo(x, y1); continue; }
        const yt = mid - amp(mx) * ph / 2, yb = mid - amp(mn) * ph / 2;
        ctx.moveTo(x, Math.min(yt, yb - 1)); ctx.lineTo(x, Math.max(yb, yt + 1));
      }
      ctx.stroke();
    } else {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(11); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(inTauri ? "캡처 대기 중…" : "브라우저 미리보기", x0 + pw / 2, mid);
    }

    // AI tag markers (YAMNet): tick at the window end time + top label, 3 staggered rows
    if (this.aiOn && this.ov) {
      const nowT = this.ov.head / this.ov.sr;
      const filter = this.aiFilter, minS = this.aiMin;
      let row = 0;
      ctx.font = font(9, 600); ctx.textBaseline = "top";
      for (const t of this.tags) {
        const age = nowT - t.t;
        if (age < 0 || age > this.seconds) continue;
        const pick = t.top.find(([, name, score]) => score >= minS && (filter === "all" || tagGroup(name) === filter));
        if (!pick) continue;
        const x = x1 - (age / this.seconds) * pw;
        const g = tagGroup(pick[1]);
        const col = g === "voice" ? theme("sig") : g === "music" ? theme("sig-2") : g === "sfx" ? theme("peak") : theme("fg-2");
        ctx.strokeStyle = withAlpha(col, 0.8); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y0); ctx.lineTo(Math.round(x) + 0.5, y0 + 6 + row * 11); ctx.stroke();
        ctx.fillStyle = col; ctx.textAlign = "left";
        const label = `${pick[1]} ${Math.round(pick[2] * 100)}%`;
        const tw = ctx.measureText(label).width;
        const lx = Math.min(x + 3, x1 - tw);
        ctx.fillStyle = withAlpha(theme("bg-1"), 0.75); ctx.fillRect(lx - 2, y0 + row * 11, tw + 4, 10);
        ctx.fillStyle = col; ctx.fillText(label, lx, y0 + row * 11 + 1);
        row = (row + 1) % 3;
      }
      ctx.fillStyle = theme("fg-2"); ctx.font = font(9); ctx.textAlign = "right"; ctx.textBaseline = "bottom";
      const st = this.tagStatus;
      ctx.fillText(st?.error ? `AI: ${st.error}` : st?.available ? `AI ${st.last_ms.toFixed(0)} ms` : "AI 모델 로딩…", x1 - 2, y1 - 2);
    }

    // Selection
    if (this.frozen && (this.dragging || this.hasSel)) {
      const lo = Math.max(x0, Math.min(this.selA, this.selB)), hi = Math.min(x1, Math.max(this.selA, this.selB));
      ctx.fillStyle = withAlpha(theme("peak"), 0.18);
      ctx.fillRect(lo, y0, hi - lo, ph);
      ctx.strokeStyle = theme("peak"); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(lo) + 0.5, y0); ctx.lineTo(Math.round(lo) + 0.5, y1); ctx.moveTo(Math.round(hi) + 0.5, y0); ctx.lineTo(Math.round(hi) + 0.5, y1); ctx.stroke();
      const [t0, t1] = this.selSeconds();
      ctx.fillStyle = theme("peak"); ctx.font = font(10, 600); ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText(`${(t1 - t0).toFixed(2)} s`, (lo + hi) / 2, y0 + 2);
    }
    if (this.frozen) {
      ctx.fillStyle = withAlpha(theme("clip"), 0.9); ctx.font = font(10, 600); ctx.textAlign = "right"; ctx.textBaseline = "top";
      ctx.fillText("⏸ 일시정지", x1 - 2, y0 + 2);
    }
    if (this.note && performance.now() < this.noteUntil) {
      ctx.fillStyle = theme("fg-0"); ctx.font = font(10); ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(this.note, x0 + 4, y0 + 2);
    }
  }
}
