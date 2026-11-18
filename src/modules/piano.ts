import { invoke } from "@tauri-apps/api/core";
import { N_KEYS, type Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";
import { playNote } from "./keysynth";

// Piano (건반 · 멜로디 · 양손): drives a keyboard from what is sounding. The keys being played light
// up, and since this is a monitor and the future is unknown, every detected note is printed after it
// sounds: a block grows out of its key and drifts upward as time passes (the mirror image of a
// falling-notes player, where the notes arrive before the sound).
//
// Two engines:
//  • 다성 AI (default, 2026-11-18 사용자: 양손 피아노까지 잘 찍혀 나오게) — the engine's Basic Pitch
//    transcription (transcribe.rs): per-key note activity + onset for all 88 keys, ≈ 0.1–0.2 s behind
//    the sound. Tracked here per key: a note starts when its activity clears the threshold (or an
//    onset fires with some activity), ends when the activity drops below half of it, and a fresh
//    onset on a held key re-strikes it. Measured on synthetic two-hand pieces with known notes
//    (scratchpad bp/, 2026-11-18): note-onset F1 0.92–0.94 at the default 0.6 (0.83–0.87 at 0.5,
//    more extra notes); on real covers against a piano-specific reference model 0.87 (normal
//    arrangement) and 0.73 (dense extreme arrangement) with register thresholds — see thresholds(). Notes are split into hands by a running two-cluster split (left = blue).
//    딜레이 모드 (2026-11-18 사용자: 우클릭에 즉시 / 1s / 3s): 1 s and 3 s switch the engine to a
//    piano-specific model (Kong et al. 2021, transcribe.rs) with more right context — the roll and
//    keys then show the music that long after it sounded, in exchange for accuracy (DELAY_NOTE).
//  • 멜로디 1음 — the old predominant-f0 candidates (melody.rs), one note at a time; also the
//    fallback while the AI model is missing.
//
// The keyboard window (3–5 octaves) follows the notes by whole octaves, with a cooldown, and widens
// to hold both hands; 전체 shows all 88 keys.

const RATE = 50;                     // history samples per second
const MIN_LEN = 3;                   // samples (60 ms) before a note counts
const MAX_FLATNESS = 0.35;           // spectral flatness above this = noise, no note (melody engine)
const RAW_N = 5;                     // frames in the median window (≈ 80 ms at 60 fps)
const GATE_OFF = 0.7;                // the gate releases at this fraction of the threshold (hysteresis)
const HARMONIC_OWN = 0.8;            // a 2×/3× candidate below this fraction of the lower one's salience is a harmonic
const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);
const A0 = 21, C8 = 108;
/** Note threshold of the delay modes (Kong frame activity) at the default sensitivity 0.6. */
const DELAY_NOTE = 0.3;

const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);
const noteName = (m: number) => `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

interface NoteBlock { note: number; t0: number; t1: number; conf: number; open: boolean; left: boolean }

export class PianoModule implements Module {
  readonly id = "piano";
  readonly title = "Piano";
  private acc = 0;
  private tick = 0;                  // samples pushed so far (time axis of the blocks)
  private blocks: NoteBlock[] = [];
  private press = new Float32Array(128);   // 1 → 0 key-press animation per note
  private velocity = new Float32Array(128);
  /** Keys down now (both engines). */
  private live = new Set<number>();
  // ---- melody engine
  private curNote = NaN;             // note with hysteresis
  private curLen = 0;                // samples the current note has lasted
  private lastHz = 0;
  private lastSal = 0;
  private recent: number[] = [];       // last RAW_N frame estimates (midi or NaN) → median kills one-frame flips
  private gateOn = false;
  private hzShown = 0;
  // ---- poly engine
  private held = new Map<number, { start: number; block: NoteBlock }>();
  private meanL = 48;                // running pitch centres of the two hands
  private meanR = 72;
  private polyOk = true;             // the AI model is there (status poll)
  private polyErr = "";
  private beatAt = -10;              // last heartbeat (performance.now() / 1000)
  private statusAt = -10;
  // ---- keyboard window
  private lowC = 48;
  private span = 48;
  private shiftCooldown = 0;
  /** Keyboard geometry of the last draw, for click-to-play hit tests. */
  private geom: { low: number; high: number; x0: number; kw: number; kbY0: number; kbY1: number; bh: number; col: Int16Array } | null = null;

  /** Clicking a key plays it (keysynth) and presses it on screen. */
  mount(body: HTMLElement, isEditing: () => boolean) {
    body.addEventListener("pointermove", (e) => {
      const r = body.getBoundingClientRect();
      body.style.cursor = this.keyAt(e.clientX - r.left, e.clientY - r.top) >= 0 ? "pointer" : "";
    });
    body.addEventListener("pointerdown", (e) => {
      if (isEditing() || e.button !== 0) return;
      const r = body.getBoundingClientRect();
      const m = this.keyAt(e.clientX - r.left, e.clientY - r.top);
      if (m < 0) return;
      const g = this.geom!;
      const vel = 0.5 + 0.5 * Math.min(1, (e.clientY - r.top - g.kbY0) / Math.max(1, g.kbY1 - g.kbY0)); // lower on the key = harder
      playNote(m, vel);
      this.press[m] = 1; this.velocity[m] = vel;
    });
  }

  /** MIDI note under tile point (x, y), or −1. Black keys win in their upper part. */
  private keyAt(x: number, y: number): number {
    const g = this.geom;
    if (!g || y < g.kbY0 || y > g.kbY1 || x < g.x0) return -1;
    const rect = (m: number) => {
      const pc = ((m % 12) + 12) % 12, c = g.col[m - g.low];
      return BLACK.has(pc) ? { x: g.x0 + (c + 1) * g.kw - g.kw * 0.3, w: g.kw * 0.6, black: true } : { x: g.x0 + c * g.kw, w: g.kw, black: false };
    };
    if (y - g.kbY0 <= g.bh) {
      for (let m = g.low; m <= g.high; m++) { const k = rect(m); if (k.black && x >= k.x && x < k.x + k.w) return m; }
    }
    for (let m = g.low; m <= g.high; m++) { const k = rect(m); if (!k.black && x >= k.x && x < k.x + k.w) return m; }
    return -1;
  }

  private get octaves() { return modSetting(this.id, "octaves", 4); }      // 3 / 4 / 5 / 0 = all 88
  private get rollSeconds() { return modSetting(this.id, "roll", 5); }
  /** Salience gate of the melody engine. Measured with examples/melody.rs: piano pieces 0.2–0.5, dense orchestral 0.1–0.3. */
  private get minSal() { return modSetting(this.id, "minSal", 0.2); }
  /** Note threshold of the AI engine (activity 0..1). */
  private get polyOn() { return modSetting(this.id, "polyOn", 0.6); }
  private get showNames() { return modSetting(this.id, "names", true); }
  private get handColours() { return modSetting(this.id, "hands", true); }
  /**
   * Engine / note choice. poly = AI two-hand transcription; melody = bell around 800 Hz (1 octave
   * wide); vocal = bell around 300 Hz; neutral = strongest as is (the last three: one note at a time).
   */
  private get prefer() { return modSetting(this.id, "prefer", "poly") as "poly" | "melody" | "vocal" | "neutral"; }
  private get usePoly() { return this.prefer === "poly" && this.polyOk; }
  /** 0 즉시 (Basic Pitch) / 1 = 1 s / 2 = 3 s (Kong) — engine mode of transcribe.rs. */
  private get delayMode() { return Math.max(0, Math.min(2, modSetting(this.id, "delay", 0))); }

  settings(): SettingItem[] {
    const items: SettingItem[] = [
      { type: "select", label: "인식 방식", value: this.prefer, options: [
        { value: "poly", label: "다성 AI — 양손·화음 (기본)" },
        { value: "melody", label: "멜로디 1음 (높은 음역 선호)" },
        { value: "vocal", label: "1음 — 보컬·중음역 우선" },
        { value: "neutral", label: "1음 — 가장 센 음 (베이스 포함)" },
      ], onChange: (v) => { setModSetting(this.id, "prefer", v); this.reset(); } },
      { type: "select", label: "건반 범위", value: String(this.octaves), options: [[3, "3옥타브 이상 (자동 추적)"], [4, "4옥타브 이상 (자동 추적)"], [5, "5옥타브 이상 (자동 추적)"], [0, "전체 88건반"]].map(([v, l]) => ({ value: String(v), label: String(l) })), onChange: (v) => setModSetting(this.id, "octaves", Number(v)) },
      { type: "select", label: "노트 기록", value: String(this.rollSeconds), options: [3, 5, 8, 12].map((v) => ({ value: String(v), label: `${v}초` })), onChange: (v) => setModSetting(this.id, "roll", Number(v)) },
    ];
    if (this.prefer === "poly") {
      items.push({ type: "select", label: "딜레이 모드 (늦을수록 정확)", value: String(this.delayMode), options: [
        { value: "0", label: "즉시 (≈0.2초 · 가벼움)" },
        { value: "1", label: "1초 늦게 (피아노 전용 모델)" },
        { value: "2", label: "3초 늦게 (가장 정확)" },
      ], onChange: (v) => { setModSetting(this.id, "delay", Number(v)); this.reset(); this.beatAt = -10; } });
      items.push({ type: "range", label: "감도 (중음역 노트 문턱 — 낮을수록 많이)", value: this.polyOn, min: 0.3, max: 0.9, step: 0.05, format: (v) => v.toFixed(2), onChange: (v) => setModSetting(this.id, "polyOn", v) });
      items.push({ type: "toggle", label: "양손 색 구분 (왼손 파랑)", value: this.handColours, onChange: (v) => setModSetting(this.id, "hands", v) });
    } else {
      items.push({ type: "range", label: "감도 (살리언스 문턱)", value: this.minSal, min: 0.05, max: 0.6, step: 0.05, format: (v) => v.toFixed(2), onChange: (v) => setModSetting(this.id, "minSal", v) });
    }
    items.push({ type: "toggle", label: "건반 이름", value: this.showNames, onChange: (v) => setModSetting(this.id, "names", v) });
    items.push({ type: "action", label: "기록 지우기", onClick: () => this.reset() });
    return items;
  }

  private reset() {
    this.blocks = []; this.curNote = NaN; this.curLen = 0; this.press.fill(0); this.held.clear(); this.live.clear(); this.recent = [];
  }

  // ---- AI engine ------------------------------------------------------------------

  /** Heartbeat (keeps the engine's transcription on while this tile draws) + model status. */
  private keepAlive() {
    const now = performance.now() / 1000;
    if (this.prefer !== "poly") return;
    if (now - this.beatAt > 1) {
      this.beatAt = now;
      invoke("set_transcribe", { enabled: true, mode: this.delayMode }).catch(() => {});
    }
    if (now - this.statusAt > 3) {
      this.statusAt = now;
      invoke<{ available: boolean; error: string | null; modes?: boolean[] }>("transcribe_status").then((s) => {
        // "unavailable" only on a hard error (model / runtime missing); before the first window it is just not loaded yet
        this.polyErr = s.error ?? "";
        this.polyOk = !(s.error && !s.available);
      }).catch(() => {});
    }
  }

  /**
   * Per-key note threshold: the setting is the middle register's; the high register (above C5) gets
   * 0.2 less and the bass (below C3) 0.05 less, blended over an octave. Basic Pitch reads those
   * registers weaker — against a piano-specific reference transcription (Kong et al. 2021) of two real
   * covers this raised note-onset F1 0.858 → 0.870 and 0.641 → 0.725 (dense "extreme" arrangement),
   * synthetic pieces 0.91–0.92 → 0.86–0.88 (2026-11-18, scratchpad bp/).
   */
  private thresholds(on: number): Float32Array {
    if (this.delayMode > 0) {
      // the piano model reads every register alike: one threshold, shifted to its own scale
      const v = DELAY_NOTE + (on - 0.6);
      if (this.thrFor === -v) return this.thr;
      this.thr.fill(Math.max(0.1, v)); this.thrFor = -v;
      return this.thr;
    }
    if (this.thrFor === on) return this.thr;
    const step = new Float32Array(N_KEYS);
    for (let k = 0; k < N_KEYS; k++) { const m = k + A0; step[k] = m < 48 ? on - 0.05 : m < 72 ? on : on - 0.2; }
    for (let k = 0; k < N_KEYS; k++) {
      let acc = 0;
      for (let j = -6; j <= 6; j++) acc += step[Math.max(0, Math.min(N_KEYS - 1, k + j))];
      this.thr[k] = Math.max(0.15, acc / 13);
    }
    this.thrFor = on;
    return this.thr;
  }
  private thr = new Float32Array(N_KEYS);
  private thrFor = -1;

  /** One history sample of the AI engine: per-key note on / off / re-strike. */
  private pushPoly(f: Frame) {
    this.tick++;
    const thr = this.thresholds(this.polyOn);
    const p = f.poly;
    for (let k = 0; k < N_KEYS; k++) {
      const on = thr[k], off = on * 0.5, ons = Math.min(0.95, on + 0.1);
      const n = p[k], o = p[N_KEYS + k], m = k + A0;
      const h = this.held.get(m);
      if (h) {
        if (n < off) { this.release(m, h); continue; }
        if (o > ons + 0.15 && this.tick - h.start > 4) { this.release(m, h); this.strike(m, Math.max(n, o)); continue; }
        h.block.t1 = this.tick; h.block.conf = Math.max(h.block.conf, n);
      } else if (n > on || (o > ons && n > off)) {
        this.strike(m, Math.max(n, o));
      }
    }
    this.trim();
  }

  private strike(m: number, v: number) {
    // which hand: nearer of the two running centres (they follow the notes slowly)
    const left = Math.abs(m - this.meanL) < Math.abs(m - this.meanR);
    if (left) this.meanL += (m - this.meanL) * 0.08; else this.meanR += (m - this.meanR) * 0.08;
    if (this.meanR - this.meanL < 7) { const c = (this.meanL + this.meanR) / 2; this.meanL = c - 3.5; this.meanR = c + 3.5; }
    const block: NoteBlock = { note: m, t0: this.tick, t1: this.tick, conf: v, open: true, left };
    this.blocks.push(block);
    this.held.set(m, { start: this.tick, block });
    this.live.add(m);
    this.press[m] = 1; this.velocity[m] = v;
  }

  private release(m: number, h: { start: number; block: NoteBlock }) {
    h.block.open = false; h.block.t1 = this.tick;
    if (this.tick - h.start < 2) this.blocks.splice(this.blocks.indexOf(h.block), 1); // a blip
    this.held.delete(m);
    this.live.delete(m);
  }

  private trim() {
    const keep = 30 * RATE;
    while (this.blocks.length && !this.blocks[0].open && this.tick - this.blocks[0].t1 > keep) this.blocks.shift();
  }

  // ---- melody engine (one note) ------------------------------------------------------

  /**
   * Melody candidate of the frame: Hz (0 = none) and salience. Among the engine's candidates
   * (strongest first) the pick is salience × range preference, with a continuity bonus for the
   * candidate on the note already sounding (so chord tones do not flicker).
   */
  private estimate(f: Frame): { hz: number; sal: number } {
    const m = f.melody;
    const flatLimit = this.gateOn ? MAX_FLATNESS * 1.25 : MAX_FLATNESS;
    if (f.flatness > flatLimit) return { hz: 0, sal: 0 };
    let best = { hz: 0, sal: 0 }, bestScore = 0;
    const cur = this.curLen >= MIN_LEN ? this.curNote : NaN;
    const centre = this.prefer === "vocal" ? 300 : this.prefer === "neutral" ? 0 : 800;
    const rangePrior = (hz: number) => (centre > 0 ? 0.3 + 0.7 * Math.exp(-0.5 * (Math.log2(hz / centre) / 1.0) ** 2) : 1);
    for (let i = 0; i + 1 < m.length; i += 2) {
      const hz = m[i], sal = m[i + 1];
      if (!(hz > 0) || !(sal > 0)) continue;
      let prior = rangePrior(hz);
      // a 2× / 3× candidate weaker than HARMONIC_OWN of another is that note's harmonic: same prior
      for (let j = 0; j + 1 < m.length; j += 2) {
        const hz2 = m[j], sal2 = m[j + 1];
        if (!(hz2 > 0) || j === i) continue;
        const r = hz / hz2;
        if ((Math.abs(r - 2) < 0.06 || Math.abs(r - 3) < 0.09) && sal < HARMONIC_OWN * sal2) prior = Math.min(prior, rangePrior(hz2));
      }
      let score = sal * prior;
      if (!Number.isNaN(cur) && Math.abs(hzToMidi(hz) - cur) < 0.6) score *= 1.4;
      if (score > bestScore) { bestScore = score; best = { hz, sal }; }
    }
    if (!(best.sal >= (this.gateOn ? this.minSal * GATE_OFF : this.minSal))) return { hz: 0, sal: 0 };
    return best;
  }

  /** Median of the last RAW_N raw estimates (NaN unless at least 3 of them are notes). */
  private stable(midi: number): number {
    this.recent.push(midi);
    if (this.recent.length > RAW_N) this.recent.shift();
    const v = this.recent.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    return v.length >= 3 ? v[v.length >> 1] : NaN;
  }

  private pushMelody(midi: number, sal: number) {
    this.tick++;
    let note = NaN;
    if (!Number.isNaN(midi)) {
      note = Number.isNaN(this.curNote) || Math.abs(midi - this.curNote) > 0.6 ? Math.round(midi) : this.curNote;
    }
    if (note !== this.curNote || Number.isNaN(note) !== Number.isNaN(this.curNote)) {
      const last = this.blocks[this.blocks.length - 1];
      if (last && last.open) { last.open = false; last.t1 = this.tick; }
      this.curNote = note;
      this.curLen = 0;
    }
    if (!Number.isNaN(note)) {
      this.curLen++;
      const last = this.blocks[this.blocks.length - 1];
      if (this.curLen === MIN_LEN) {
        this.blocks.push({ note, t0: this.tick - MIN_LEN + 1, t1: this.tick, conf: sal, open: true, left: false });
        if (note >= 0 && note < 128) { this.press[note] = 1; this.velocity[note] = sal; }
      } else if (this.curLen > MIN_LEN && last && last.open) {
        last.t1 = this.tick;
        last.conf = Math.max(last.conf, sal);
      }
    }
    this.live.clear();
    if (this.curLen >= MIN_LEN && !Number.isNaN(this.curNote)) this.live.add(this.curNote);
    this.trim();
  }

  headReadout(_f: Frame) {
    if (this.usePoly) {
      if (!this.live.size) return "—";
      const ns = [...this.live].sort((a, b) => a - b);
      return ns.slice(0, 8).map(noteName).join(" ") + (ns.length > 8 ? " …" : "");
    }
    const live = this.curLen >= MIN_LEN && !Number.isNaN(this.curNote) && this.hzShown > 0;
    if (!live) return "—";
    const m = hzToMidi(this.hzShown);
    const cents = Math.round((m - Math.round(m)) * 100);
    return `${noteName(m)}  ${cents >= 0 ? "+" : ""}${cents}¢  ${this.hzShown.toFixed(1)} Hz  ·  ${Math.round(this.lastSal * 100)}%`;
  }

  /** Keyboard window: whole octaves, at least the chosen span, wide enough for the recent notes. */
  private window(dt: number): { low: number; high: number } {
    if (this.octaves === 0) return { low: A0, high: C8 };
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);
    // notes of the last 4 s
    let lo = Infinity, hi = -Infinity;
    const since = this.tick - 4 * RATE;
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (!b.open && b.t1 < since) { if (b.t1 < since - 30 * RATE) break; continue; }
      lo = Math.min(lo, b.note); hi = Math.max(hi, b.note);
    }
    const minSpan = this.octaves * 12;
    if (lo <= hi) {
      const outside = lo < this.lowC || hi > this.lowC + this.span;
      if (outside || this.shiftCooldown === 0) {
        const need = Math.ceil((hi - lo + 3) / 12) * 12;
        const span = Math.min(C8 - A0 - 3, Math.max(minSpan, need));
        let low = Math.floor((lo - 1) / 12) * 12;
        if (low + span < hi + 1) low = Math.ceil((hi + 1 - span) / 12) * 12;
        // centre the notes when there is room to spare
        const spare = span - (hi - lo);
        if (spare > 12 && !outside) low = Math.round(((lo + hi) / 2 - span / 2) / 12) * 12;
        if (low !== this.lowC || span !== this.span) {
          if (outside || span !== this.span || Math.abs(low - this.lowC) >= 12) { this.lowC = low; this.span = span; this.shiftCooldown = 2; }
        }
      }
    } else if (this.span < minSpan) this.span = minSpan;
    this.span = Math.max(this.span, minSpan);
    this.lowC = Math.max(A0 + 3, Math.min(C8 - this.span, this.lowC)); // inside the 88 keys
    return { low: this.lowC, high: this.lowC + this.span };
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    this.keepAlive();
    // ---- sample at RATE
    this.acc += dt;
    const poly = this.usePoly;
    let midi = NaN, est = { hz: 0, sal: 0 };
    if (!poly) {
      est = this.estimate(f);
      this.gateOn = est.hz > 0;
      midi = this.stable(est.hz > 0 ? hzToMidi(est.hz) : NaN);
      if (!Number.isNaN(midi)) {
        const hz = 440 * Math.pow(2, (midi - 69) / 12);
        this.hzShown = this.hzShown > 0 && Math.abs(hzToMidi(this.hzShown) - midi) < 0.6 ? this.hzShown + (hz - this.hzShown) * Math.min(1, dt * 8) : hz;
        this.lastHz = this.hzShown; this.lastSal = est.sal;
      }
    }
    if (this.acc > 1) this.acc = 1; // after a pause, do not replay a backlog
    while (this.acc >= 1 / RATE) {
      this.acc -= 1 / RATE;
      if (poly) this.pushPoly(f); else this.pushMelody(midi, Number.isNaN(midi) ? 0 : est.sal);
    }
    for (let i = 0; i < 128; i++) if (this.press[i] > 0) this.press[i] = Math.max(0, this.press[i] - dt * 2.5);

    // ---- geometry
    const { low, high } = this.window(dt);
    const PAD = 4;
    const x0 = PAD, x1 = w - PAD;
    const pw = x1 - x0;
    const kbH = Math.max(34, Math.min(96, Math.round(h * 0.3)));
    const rollY0 = PAD, rollY1 = h - PAD - kbH;
    const kbY0 = rollY1, kbY1 = h - PAD;
    if (pw < 40 || rollY1 - rollY0 < 10) return;
    let nWhite = 0;
    for (let m = low; m <= high; m++) if (!BLACK.has(((m % 12) + 12) % 12)) nWhite++;
    const kw = pw / nWhite;
    // white-key column of every note (a black key takes the column of the white key below it)
    const col = new Int16Array(high - low + 1);
    for (let m = low, c = 0; m <= high; m++) {
      const black = BLACK.has(((m % 12) + 12) % 12);
      col[m - low] = black ? c - 1 : c;
      if (!black) c++;
    }
    const keyRect = (m: number): { x: number; w: number; black: boolean } => {
      const pc = ((m % 12) + 12) % 12;
      const c = col[m - low];
      if (BLACK.has(pc)) {
        const bw = kw * 0.6;
        return { x: x0 + (c + 1) * kw - bw / 2, w: bw, black: true };
      }
      return { x: x0 + c * kw, w: kw, black: false };
    };
    const hands = poly && this.handColours;
    const right = theme("sig"), leftC = theme("sig-2");
    const blockColour = (b: NoteBlock, black: boolean) => (hands ? (b.left ? leftC : right) : black ? leftC : right);

    // ---- piano roll: printed notes rising from the keys
    const rollH = rollY1 - rollY0;
    const pxPerSample = rollH / (this.rollSeconds * RATE);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, rollY0, pw, rollH); ctx.clip();
    ctx.strokeStyle = theme("grid"); ctx.lineWidth = 1;
    for (let m = low; m <= high; m++) {
      if (((m % 12) + 12) % 12 !== 0) continue;
      const x = Math.round(keyRect(m).x) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, rollY0); ctx.lineTo(x, rollY1); ctx.stroke();
    }
    ctx.font = font(10, 600); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const b of this.blocks) {
      if (b.note < low || b.note > high) continue;
      const t1 = b.open ? this.tick : b.t1;
      const yBottom = rollY1 - (this.tick - t1) * pxPerSample;
      const yTop = rollY1 - (this.tick - b.t0 + 1) * pxPerSample;
      if (yBottom < rollY0) continue;
      const k = keyRect(b.note);
      const bx = k.black ? k.x : k.x + kw * 0.12, bw = k.black ? k.w : kw * 0.76;
      ctx.fillStyle = withAlpha(blockColour(b, k.black), 0.3 + 0.6 * Math.min(1, b.conf));
      const yT = Math.max(rollY0 - 2, yTop), yB = Math.min(rollY1, yBottom);
      const rh = Math.max(2, yB - yT);
      ctx.fillRect(bx, yT, bw, rh);
      if (b.open) { // the key is still down: a bright edge where the block meets the key
        ctx.fillStyle = withAlpha(theme("fg-0"), 0.6);
        ctx.fillRect(bx, rollY1 - 2, bw, 2);
      }
      if (this.showNames && rh >= 14 && bw >= 18) {
        ctx.fillStyle = theme("bg-0");
        ctx.fillText(noteName(b.note), bx + bw / 2, yB - 8);
      }
    }
    ctx.restore();

    // ---- keyboard
    ctx.fillStyle = theme("bg-0");
    ctx.fillRect(x0, kbY0, pw, kbY1 - kbY0);
    const kh = kbY1 - kbY0;
    const downColour = (m: number) => {
      if (!hands) return BLACK.has(((m % 12) + 12) % 12) ? leftC : right;
      return this.held.get(m)?.block.left ? leftC : right;
    };
    for (let m = low; m <= high; m++) {
      const pc = ((m % 12) + 12) % 12;
      if (BLACK.has(pc)) continue;
      const k = keyRect(m);
      const down = this.live.has(m);
      const p = this.press[m] ?? 0;
      const sink = down ? 2 : Math.round(p * 2);
      ctx.fillStyle = down ? withAlpha(downColour(m), 0.5 + 0.5 * Math.min(1, this.velocity[m])) : theme("fg-0");
      ctx.fillRect(k.x + 1, kbY0 + sink, k.w - 2, kh - sink - 1);
      if (!down && p > 0) { // release glow fading out
        ctx.fillStyle = withAlpha(right, 0.5 * p);
        ctx.fillRect(k.x + 1, kbY0 + sink, k.w - 2, kh - sink - 1);
      }
      if (this.showNames && kw >= 14 && (pc === 0 || kw >= 24)) {
        ctx.fillStyle = down ? theme("bg-0") : theme("fg-2");
        ctx.font = font(Math.min(10, Math.max(8, kw * 0.45)));
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(pc === 0 ? noteName(m) : NAMES[pc], k.x + k.w / 2, kbY1 - 3);
      }
    }
    const bh = kh * 0.62;
    this.geom = { low, high, x0, kw, kbY0, kbY1, bh, col };
    for (let m = low; m <= high; m++) {
      const pc = ((m % 12) + 12) % 12;
      if (!BLACK.has(pc)) continue;
      const k = keyRect(m);
      if (k.x < x0 - 1 || k.x + k.w > x1 + 1) continue;
      const down = this.live.has(m);
      const p = this.press[m] ?? 0;
      const sink = down ? 2 : Math.round(p * 2);
      ctx.fillStyle = theme("bg-3");
      ctx.fillRect(k.x, kbY0, k.w, bh + sink);
      if (down || p > 0) {
        ctx.fillStyle = withAlpha(down ? downColour(m) : leftC, down ? 0.6 + 0.4 * Math.min(1, this.velocity[m]) : 0.6 * p);
        ctx.fillRect(k.x + 1, kbY0, k.w - 2, bh + sink - 1);
      }
    }
    ctx.fillStyle = theme("clip");
    ctx.fillRect(x0, kbY0, pw, 1);

    // ---- current notes (top-left of the roll)
    ctx.font = font(12, 600); ctx.textAlign = "left"; ctx.textBaseline = "top";
    if (poly) {
      if (this.live.size) {
        const ns = [...this.live].sort((a, b) => a - b);
        ctx.fillStyle = theme("fg-0");
        ctx.fillText(ns.slice(0, 10).map(noteName).join(" "), x0 + 4, rollY0 + 3);
      }
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10);
      const lag = ["", " · 1초 늦게", " · 3초 늦게"][this.delayMode];
      ctx.fillText((hands ? "다성 AI · 왼손 파랑 / 오른손 청록" : "다성 AI") + lag, x0 + 4, rollY0 + 19);
    } else if (!Number.isNaN(midi)) {
      ctx.fillStyle = theme("fg-0");
      ctx.fillText(noteName(midi), x0 + 4, rollY0 + 3);
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10);
      ctx.fillText(`${this.hzShown.toFixed(1)} Hz · ${Math.round(est.sal * 100)}%`, x0 + 4, rollY0 + 19);
    } else if (this.lastHz > 0) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10);
      ctx.fillText(`마지막 ${noteName(hzToMidi(this.lastHz))} · ${Math.round(this.lastSal * 100)}%`, x0 + 4, rollY0 + 3);
    }
    if (this.prefer === "poly" && !this.polyOk) {
      ctx.fillStyle = theme("peak"); ctx.font = font(10);
      ctx.fillText(`다성 AI 사용 불가 — 1음 모드로 표시 (${this.polyErr})`, x0 + 4, rollY0 + 35);
    }
    if (this.octaves !== 0) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10); ctx.textAlign = "right";
      ctx.fillText(`${noteName(low)} – ${noteName(high)}`, x1 - 4, rollY0 + 3);
    }
  }
}
