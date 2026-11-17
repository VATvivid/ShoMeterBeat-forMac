import type { Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";
import { playNote } from "./keysynth";

// Piano (건반 · 멜로디): the engine's predominant-f0 salience (melody.rs, strongest
// candidate only — mono) drives a keyboard. The key being played lights up, and since
// this is a monitor and the future is unknown, every detected note is printed after it
// sounds: a block grows out of its key and drifts upward as time passes (the mirror
// image of a falling-notes player, where the notes arrive before the sound).
//
// Tracking (all here, the engine only sends per-frame candidates): the strongest
// candidate is accepted when its salience clears the threshold; the note has ±0.6 st
// hysteresis so vibrato does not flicker between two keys; a note shorter than 60 ms is
// a blip and leaves no block. A new note (or the same note after a gap) is a key press —
// the press animation and velocity come from the salience at that moment. The keyboard
// window (3–5 octaves) follows the melody by whole octaves, with a cooldown, so it does
// not slide around under the blocks; 전체 shows all 88 keys.

const RATE = 50;                     // history samples per second
const MIN_LEN = 3;                   // samples (60 ms) before a note counts
const MAX_FLATNESS = 0.35;           // spectral flatness above this = noise, no note
const RAW_N = 5;                     // frames in the median window (≈ 80 ms at 60 fps)
const GATE_OFF = 0.7;                // the gate releases at this fraction of the threshold (hysteresis)
const HARMONIC_OWN = 0.8;            // a 2×/3× candidate below this fraction of the lower one's salience is a harmonic (benchmark: 0.75–0.85 same accuracy, 1.0 worse)
const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);
const A0 = 21, C8 = 108;

const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);
const noteName = (m: number) => `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

interface NoteBlock { note: number; t0: number; t1: number; conf: number; open: boolean }

export class PianoModule implements Module {
  readonly id = "piano";
  readonly title = "Piano";
  private acc = 0;
  private tick = 0;                  // samples pushed so far (time axis of the blocks)
  private curNote = NaN;             // note with hysteresis
  private curLen = 0;                // samples the current note has lasted
  private blocks: NoteBlock[] = [];
  private press = new Float32Array(128);   // 1 → 0 key-press animation per note
  private velocity = new Float32Array(128);
  private lastHz = 0;
  private lastSal = 0;
  private recent: number[] = [];       // last RAW_N frame estimates (midi or NaN) → median kills one-frame flips
  private gateOn = false;              // salience / flatness gate with hysteresis
  private hzShown = 0;                 // smoothed Hz for the readout
  private lowC = 48;                 // lowest key shown (a C) in auto mode
  private shiftCooldown = 0;
  private centre = 60;
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
  /** Salience gate. Measured with examples/melody.rs: piano pieces 0.2–0.5, dense orchestral 0.1–0.3. */
  private get minSal() { return modSetting(this.id, "minSal", 0.2); }
  private get showNames() { return modSetting(this.id, "names", true); }
  /**
   * Which of the engine's candidates to follow. 멜로디 = bell around 800 Hz (1 octave wide);
   * 보컬 = bell around 300 Hz; 중립 = strongest as is. Measured on synthetic piano pieces with a
   * known upper-voice melody (scratchpad mk_piano.py / score_melody.py, 2026-11-17): 600 Hz
   * centre read 79–85 % of melody frames right with 7–15 % octave errors; 800 Hz 92–94 % with
   * 1–3 % octave errors.
   */
  private get prefer() { return modSetting(this.id, "prefer", "melody") as "melody" | "vocal" | "neutral"; }

  settings(): SettingItem[] {
    return [
      { type: "select", label: "건반 범위", value: String(this.octaves), options: [[3, "3옥타브 (자동 추적)"], [4, "4옥타브 (자동 추적)"], [5, "5옥타브 (자동 추적)"], [0, "전체 88건반"]].map(([v, l]) => ({ value: String(v), label: String(l) })), onChange: (v) => setModSetting(this.id, "octaves", Number(v)) },
      { type: "select", label: "음 선택", value: this.prefer, options: [{ value: "melody", label: "멜로디 우선 (높은 음역 선호)" }, { value: "vocal", label: "보컬·중음역 우선" }, { value: "neutral", label: "가장 센 음 (베이스 포함)" }], onChange: (v) => setModSetting(this.id, "prefer", v) },
      { type: "select", label: "노트 기록", value: String(this.rollSeconds), options: [3, 5, 8, 12].map((v) => ({ value: String(v), label: `${v}초` })), onChange: (v) => setModSetting(this.id, "roll", Number(v)) },
      { type: "range", label: "감도 (살리언스 문턱)", value: this.minSal, min: 0.05, max: 0.6, step: 0.05, format: (v) => v.toFixed(2), onChange: (v) => setModSetting(this.id, "minSal", v) },
      { type: "toggle", label: "건반 이름", value: this.showNames, onChange: (v) => setModSetting(this.id, "names", v) },
      { type: "action", label: "기록 지우기", onClick: () => { this.blocks = []; this.curNote = NaN; this.curLen = 0; this.press.fill(0); } },
    ];
  }

  /**
   * Melody candidate of the frame: Hz (0 = none) and salience. Among the engine's candidates
   * (strongest first) the pick is salience × range preference, with a continuity bonus for the
   * candidate on the note already sounding (so chord tones do not flicker).
   */
  private estimate(f: Frame): { hz: number; sal: number } {
    const m = f.melody;
    // noise-like frames (flatness high) score ~0.27 on random peak alignments — not notes.
    // Both gates have hysteresis: once a note is on it stays on down to GATE_OFF × threshold,
    // so a decaying tone does not flicker on/off at the edge (2026-11-17 "떨림").
    const flatLimit = this.gateOn ? MAX_FLATNESS * 1.25 : MAX_FLATNESS;
    if (f.flatness > flatLimit) return { hz: 0, sal: 0 };
    let best = { hz: 0, sal: 0 }, bestScore = 0;
    const cur = this.curLen >= MIN_LEN ? this.curNote : NaN;
    const centre = this.prefer === "melody" ? 800 : this.prefer === "vocal" ? 300 : 0;
    const rangePrior = (hz: number) => (centre > 0 ? 0.3 + 0.7 * Math.exp(-0.5 * (Math.log2(hz / centre) / 1.0) ** 2) : 1);
    for (let i = 0; i + 1 < m.length; i += 2) {
      const hz = m[i], sal = m[i + 1];
      if (!(hz > 0) || !(sal > 0)) continue;
      let prior = rangePrior(hz);
      // A candidate at 2× / 3× of another candidate with less than HARMONIC_OWN of its salience
      // is that note's harmonic, not a note of its own: it gets the lower note's range prior,
      // so the melody preference chooses between different notes, never between a note and
      // its own octave (a single C4 read 0.58 vs its C5 harmonic 0.36 — the 800 Hz bell alone
      // flipped that to C5, 2026-11-17).
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

  headReadout(_f: Frame) {
    // the readout follows the smoothed track (median + Hz easing), not the raw frame
    const live = this.curLen >= MIN_LEN && !Number.isNaN(this.curNote) && this.hzShown > 0;
    if (!live) return "—";
    const m = hzToMidi(this.hzShown);
    const cents = Math.round((m - Math.round(m)) * 100);
    return `${noteName(m)}  ${cents >= 0 ? "+" : ""}${cents}¢  ${this.hzShown.toFixed(1)} Hz  ·  ${Math.round(this.lastSal * 100)}%`;
  }

  private push(midi: number, sal: number) {
    this.tick++;
    let note = NaN;
    if (!Number.isNaN(midi)) {
      note = Number.isNaN(this.curNote) || Math.abs(midi - this.curNote) > 0.6 ? Math.round(midi) : this.curNote;
    }
    if (note !== this.curNote || Number.isNaN(note) !== Number.isNaN(this.curNote)) {
      // close the running block
      const last = this.blocks[this.blocks.length - 1];
      if (last && last.open) { last.open = false; last.t1 = this.tick; }
      this.curNote = note;
      this.curLen = 0;
    }
    if (!Number.isNaN(note)) {
      this.curLen++;
      const last = this.blocks[this.blocks.length - 1];
      if (this.curLen === MIN_LEN) {
        // the note has lasted long enough: it is a key press
        this.blocks.push({ note, t0: this.tick - MIN_LEN + 1, t1: this.tick, conf: sal, open: true });
        if (note >= 0 && note < 128) { this.press[note] = 1; this.velocity[note] = sal; }
        this.centre += (note - this.centre) * 0.3;
      } else if (this.curLen > MIN_LEN && last && last.open) {
        last.t1 = this.tick;
        last.conf = Math.max(last.conf, sal);
      }
    }
    const keep = 30 * RATE;
    while (this.blocks.length && this.tick - this.blocks[0].t1 > keep) this.blocks.shift();
  }

  /** Lowest key shown and the number of white keys, following the melody by whole octaves. */
  private window(dt: number): { low: number; high: number } {
    if (this.octaves === 0) return { low: A0, high: C8 };
    const span = this.octaves * 12;
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);
    const live = this.curLen >= MIN_LEN ? this.curNote : NaN;
    if (!Number.isNaN(live) && this.shiftCooldown === 0) {
      if (live < this.lowC + 1 || live > this.lowC + span - 2) {
        // re-centre on the melody's recent centre, snapped to a C
        this.lowC = Math.round((this.centre - span / 2) / 12) * 12;
        this.shiftCooldown = 1.5;
      }
    }
    this.lowC = Math.max(A0 + 3, Math.min(C8 - span, this.lowC)); // keep inside the 88 keys (A0 … C8)
    return { low: this.lowC, high: this.lowC + span };
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    // ---- sample at RATE
    this.acc += dt;
    const est = this.estimate(f);
    this.gateOn = est.hz > 0;
    const midi = this.stable(est.hz > 0 ? hzToMidi(est.hz) : NaN);
    const live = !Number.isNaN(midi);
    if (live) {
      const hz = 440 * Math.pow(2, (midi - 69) / 12);
      this.hzShown = this.hzShown > 0 && Math.abs(hzToMidi(this.hzShown) - midi) < 0.6 ? this.hzShown + (hz - this.hzShown) * Math.min(1, dt * 8) : hz;
      this.lastHz = this.hzShown; this.lastSal = est.sal;
    }
    while (this.acc >= 1 / RATE) {
      this.acc -= 1 / RATE;
      this.push(midi, live ? est.sal : 0);
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
    // white keys between low and high (inclusive of high when it is a white key)
    let nWhite = 0;
    for (let m = low; m <= high; m++) if (!BLACK.has(((m % 12) + 12) % 12)) nWhite++;
    const kw = pw / nWhite;
    // white-key column of every note in the window (a black key takes the column of the
    // white key below it and sits on that key's right edge)
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

    // ---- piano roll: printed notes rising from the keys
    const rollH = rollY1 - rollY0;
    const pxPerSample = rollH / (this.rollSeconds * RATE);
    const sig = theme("sig");
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, rollY0, pw, rollH); ctx.clip();
    // octave guides
    ctx.strokeStyle = theme("grid"); ctx.lineWidth = 1;
    for (let m = low; m <= high; m++) {
      if (((m % 12) + 12) % 12 !== 0) continue;
      const k = keyRect(m);
      const x = Math.round(k.x) + 0.5;
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
      const alpha = 0.3 + 0.6 * Math.min(1, b.conf);
      ctx.fillStyle = withAlpha(k.black ? theme("sig-2") : sig, alpha);
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
    const liveNote = this.curLen >= MIN_LEN ? this.curNote : NaN;
    // white keys
    for (let m = low; m <= high; m++) {
      const pc = ((m % 12) + 12) % 12;
      if (BLACK.has(pc)) continue;
      const k = keyRect(m);
      const down = m === liveNote;
      const p = this.press[m] ?? 0;
      const sink = down ? 2 : Math.round(p * 2);
      ctx.fillStyle = down ? withAlpha(sig, 0.5 + 0.5 * Math.min(1, this.velocity[m])) : theme("fg-0");
      ctx.fillRect(k.x + 1, kbY0 + sink, k.w - 2, kh - sink - 1);
      if (!down && p > 0) { // release glow fading out
        ctx.fillStyle = withAlpha(sig, 0.5 * p);
        ctx.fillRect(k.x + 1, kbY0 + sink, k.w - 2, kh - sink - 1);
      }
      if (this.showNames && kw >= 14 && (pc === 0 || kw >= 24)) {
        ctx.fillStyle = down ? theme("bg-0") : theme("fg-2");
        ctx.font = font(Math.min(10, Math.max(8, kw * 0.45)));
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(pc === 0 ? noteName(m) : NAMES[pc], k.x + k.w / 2, kbY1 - 3);
      }
    }
    // black keys
    const bh = kh * 0.62;
    this.geom = { low, high, x0, kw, kbY0, kbY1, bh, col };
    for (let m = low; m <= high; m++) {
      const pc = ((m % 12) + 12) % 12;
      if (!BLACK.has(pc)) continue;
      const k = keyRect(m);
      if (k.x < x0 - 1 || k.x + k.w > x1 + 1) continue;
      const down = m === liveNote;
      const p = this.press[m] ?? 0;
      const sink = down ? 2 : Math.round(p * 2);
      ctx.fillStyle = theme("bg-3");
      ctx.fillRect(k.x, kbY0, k.w, bh + sink);
      if (down || p > 0) {
        ctx.fillStyle = withAlpha(theme("sig-2"), down ? 0.6 + 0.4 * Math.min(1, this.velocity[m]) : 0.6 * p);
        ctx.fillRect(k.x + 1, kbY0, k.w - 2, bh + sink - 1);
      }
    }
    // keyboard top edge / felt
    ctx.fillStyle = theme("clip");
    ctx.fillRect(x0, kbY0, pw, 1);

    // ---- current note label (top-left of the roll)
    ctx.font = font(12, 600); ctx.textAlign = "left"; ctx.textBaseline = "top";
    if (live) {
      ctx.fillStyle = theme("fg-0");
      ctx.fillText(noteName(midi), x0 + 4, rollY0 + 3);
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10);
      ctx.fillText(`${this.hzShown.toFixed(1)} Hz · ${Math.round(est.sal * 100)}%`, x0 + 4, rollY0 + 19);
    } else if (this.lastHz > 0) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10);
      ctx.fillText(`마지막 ${noteName(hzToMidi(this.lastHz))} · ${Math.round(this.lastSal * 100)}%`, x0 + 4, rollY0 + 3);
    }
    if (this.octaves !== 0) {
      ctx.fillStyle = theme("fg-2"); ctx.font = font(10); ctx.textAlign = "right";
      ctx.fillText(`${noteName(low)} – ${noteName(high)}`, x1 - 4, rollY0 + 3);
    }
  }
}
