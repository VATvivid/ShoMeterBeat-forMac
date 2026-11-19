import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { Frame } from "../engine/frame";
import { getSource } from "../engine/instance";
import { inTauri, type SubStatus, type Subtitle } from "../engine/source";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";

// Live subtitles: the engine gates speech into utterances and transcribes them with
// whisper.cpp (local). Lines scroll up; export as TXT or SRT.

export class SubtitlesModule implements Module {
  readonly id = "subtitles";
  readonly title = "Subtitles";
  private subs: Subtitle[] = [];
  private seq = 0;
  private status: SubStatus | null = null;
  private lastPoll = 0;
  private sent = "";
  private note = "";
  private noteUntil = 0;

  private get on() { return modSetting(this.id, "on", false); }
  private get lang() { return modSetting(this.id, "lang", "auto"); }
  // base·small 만 사용 (2026-11-19 사용자). 예전에 저장된 medium 등은 base 로 되돌린다.
  private get model() { return (modSetting(this.id, "model", "base") as string) === "small" ? "small" : "base"; }
  private get fontPx() { return modSetting(this.id, "font", 14); }
  private get showTime() { return modSetting(this.id, "time", true); }

  settings(): SettingItem[] {
    return [
      { type: "toggle", label: "자막 (whisper)", value: this.on, onChange: (v) => setModSetting(this.id, "on", v) },
      { type: "select", label: "언어", value: this.lang, options: [["auto", "자동 감지"], ["ko", "한국어"], ["en", "English"], ["ja", "日本語"], ["zh", "中文"]].map(([v, l]) => ({ value: v, label: l })), onChange: (v) => setModSetting(this.id, "lang", v) },
      { type: "select", label: "모델", value: this.model, options: [["base", "base (빠름, 148 MB)"], ["small", "small (정확, 488 MB)"]].map(([v, l]) => ({ value: v, label: l })), onChange: (v) => setModSetting(this.id, "model", v) },
      { type: "range", label: "글자 크기", value: this.fontPx, min: 11, max: 28, step: 1, format: (v) => `${v}px`, onChange: (v) => setModSetting(this.id, "font", v) },
      { type: "toggle", label: "시간 표시", value: this.showTime, onChange: (v) => setModSetting(this.id, "time", v) },
      { type: "action", label: "TXT로 저장…", onClick: () => this.export("txt") },
      { type: "action", label: "SRT로 저장…", onClick: () => this.export("srt") },
      { type: "action", label: "지우기", onClick: () => { this.subs = []; } },
    ];
  }

  headReadout() {
    const s = this.status;
    if (!this.on) return "꺼짐";
    if (!s) return "…";
    if (s.error) return "오류";
    if (s.loading) return `모델 로딩 (${s.model})`;
    return `${s.loaded ? s.model : "대기"} · ${s.lang === "auto" ? "auto" : s.lang} · ${s.last_ms > 0 ? `${(s.last_ms / 1000).toFixed(1)} s` : "—"}${s.queue ? ` · 대기 ${s.queue}` : ""}`;
  }

  private setNote(t: string) { this.note = t; this.noteUntil = performance.now() + 6000; }

  private poll() {
    const src = getSource();
    if (!src) return;
    const key = `${this.on}:${this.lang}:${this.model}`;
    if (key !== this.sent) { this.sent = key; src.setSubtitles(this.on, this.lang, this.model).catch(() => {}); }
    const now = performance.now();
    if (now - this.lastPoll < 400) return;
    this.lastPoll = now;
    src.subtitleStatus().then((s) => { this.status = s; }).catch(() => {});
    if (!this.on) return;
    src.subtitlesSince(this.seq).then((ss) => {
      for (const s of ss) { if (s.seq > this.seq) { this.seq = s.seq; this.subs.push(s); } }
      if (this.subs.length > 500) this.subs.splice(0, this.subs.length - 500);
    }).catch(() => {});
  }

  private async export(kind: "txt" | "srt") {
    if (!this.subs.length) { this.setNote("저장할 자막이 없습니다"); return; }
    const fmt = (t: number) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), ms = Math.round((t - Math.floor(t)) * 1000); return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`; };
    const text = kind === "srt"
      ? this.subs.map((s, i) => `${i + 1}\n${fmt(s.t0)} --> ${fmt(s.t1)}\n${s.text}\n`).join("\n")
      : this.subs.map((s) => `[${fmt(s.t0).slice(0, 8)}] ${s.text}`).join("\n") + "\n";
    if (!inTauri) { this.setNote("브라우저 미리보기에선 저장 불가"); return; }
    try {
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      const dst = await saveDialog({ title: "자막 저장", defaultPath: `subtitles_${stamp}.${kind}`, filters: [{ name: kind.toUpperCase(), extensions: [kind] }] });
      if (!dst) return;
      await getSource()!.writeText(dst, text);
      this.setNote(`저장됨: ${dst}`);
    } catch (e) { this.setNote(`저장 실패: ${String(e)}`); }
  }

  draw(d: DrawCtx, _f: Frame) {
    const { ctx, w, h } = d;
    this.poll();
    const pad = 10, fs = this.fontPx, lh = Math.round(fs * 1.45);
    const s = this.status;
    if (!this.on) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(11); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("우클릭 → '자막 (whisper)' 켜기", w / 2, h / 2);
      return;
    }
    if (s?.error) {
      ctx.fillStyle = theme("clip"); ctx.font = font(11); ctx.textAlign = "left"; ctx.textBaseline = "top";
      wrap(ctx, s.error, pad, pad, w - pad * 2, 15);
      return;
    }
    // lines from the bottom up (newest at the bottom)
    ctx.font = font(fs); ctx.textBaseline = "alphabetic";
    let y = h - pad;
    const maxW = w - pad * 2;
    for (let i = this.subs.length - 1; i >= 0 && y > pad; i--) {
      const sub = this.subs[i];
      const prefix = this.showTime ? `${fmtClock(sub.t0)}  ` : "";
      const lines = wrapLines(ctx, prefix + sub.text, maxW);
      y -= lh * (lines.length - 1);
      const age = i === this.subs.length - 1 ? 0 : 1;
      ctx.fillStyle = age ? withAlpha(theme("fg-0"), 0.7) : theme("fg-0");
      lines.forEach((ln, k) => { ctx.textAlign = "left"; ctx.fillText(ln, pad, y + k * lh); });
      if (this.showTime) { ctx.fillStyle = theme("fg-2"); ctx.fillText(prefix.trim(), pad, y); }
      y -= lh + 4;
    }
    if (!this.subs.length) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(11); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(s?.loading ? `모델 로딩 중 (${s.model})…` : s?.loaded ? "말소리를 기다리는 중…" : "준비 중…", w / 2, h / 2);
    }
    if (this.note && performance.now() < this.noteUntil) { ctx.fillStyle = theme("fg-1"); ctx.font = font(10); ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(this.note, pad, pad); }
  }
}

function fmtClock(t: number) { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`; }

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxW && line) { out.push(line); line = ch === " " ? "" : ch; }
    else line = test;
  }
  if (line) out.push(line);
  return out;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number) {
  wrapLines(ctx, text, maxW).forEach((ln, i) => ctx.fillText(ln, x, y + i * lh));
}
