import type { Frame } from "../engine/frame";
import { font, theme, withAlpha } from "../theme";
import type { DrawCtx, Module, SettingItem } from "./types";
import { modSetting, setModSetting } from "../state";
import { getSource } from "../engine/instance";
import { requestTagging } from "./aitags";
import { nearestVowel } from "./vowels";
import type { AiTag } from "../engine/source";

// Emoji (for fun): a 16×16 pixel-art sprite that reacts to what is playing.
// 규칙 mode costs nothing extra — it reads the values the engine already sends every
// frame (level, voiced/f0, F1/F2, spectral flatness & centroid): talking face with the
// mouth shaped by the vowel, music note bobbing to the onsets, sword / boom / sparkle
// on transients by brightness, wind for sustained noise, sleeping face for silence.
// AI mode uses the YAMNet tagger (shared with the Waveform's AI tags) and maps the top
// AudioSet label to a sprite (dog, cat, car, water, bell, lightning, fire, bird, …).
// Sprites are strings; letters are theme tokens, so the art follows the colour scheme.

type SpriteName = "face" | "note" | "drum" | "boom" | "sword" | "sparkle" | "wind" | "gun" | "boot" | "dog" | "cat" | "car" | "water" | "bell" | "bolt" | "fire" | "bird";
type Mouth = "closed" | "open" | "spread" | "round" | "mid" | "sleep" | "laugh" | "sing";

const PAL: Record<string, string> = { k: "bg-3", w: "fg-0", g: "fg-1", y: "target", o: "peak", r: "clip", c: "sig", b: "sig-2", p: "map-1" };

const S: Record<SpriteName, string[]> = {
  face: [
    "....kkkkkkkk....", "..kkyyyyyyyykk..", ".kyyyyyyyyyyyyk.", "kyyyyyyyyyyyyyyk", "kyyyyyyyyyyyyyyk", "kyyykkyyyykkyyyk", "kyyykkyyyykkyyyk", "kyyyyyyyyyyyyyyk",
    "kyyyyyyyyyyyyyyk", "kyyyyyyyyyyyyyyk", "kyyyyyyyyyyyyyyk", "kyyyyyyyyyyyyyyk", ".kyyyyyyyyyyyyk.", "..kkyyyyyyyykk..", "....kkkkkkkk....", "................",
  ],
  note: [
    "................", "........kkk.....", "........kwkk....", "........kwkkk...", "........kwk.kk..", "........kwk..kk.", "........kwk...k.", "........kwk.....",
    "........kwk.....", ".....kkkkwk.....", "....kwwwwwk.....", "...kwwwwwwk.....", "...kwwwwwk......", "....kwwwk.......", ".....kkk........", "................",
  ],
  drum: [
    "................", "..kkkkkkkkkkkk..", ".kwwwwwwwwwwwwk.", ".kwwwwwwwwwwwwk.", "..kkkkkkkkkkkk..", ".krrrkrrrrkrrrk.", ".krrrkrrrrkrrrk.", ".krrrkrrrrkrrrk.",
    ".krrrkrrrrkrrrk.", ".krrrkrrrrkrrrk.", ".krrrkrrrrkrrrk.", "..kkkkkkkkkkkk..", ".kwwwwwwwwwwwwk.", "..kkkkkkkkkkkk..", "................", "................",
  ],
  boom: [
    ".......r........", "...r..ror..r....", "....rooooor.....", "..rroyyyyyorr...", ".royyyyyyyyyor..", "..royyywwyyyor..", ".royyywwwwyyyor.", "royyyywwwwyyyyor",
    ".royyywwwwyyyor.", "..royyywwyyyor..", ".royyyyyyyyyor..", "..rroyyyyyorr...", "....rooooor..r..", "...r..ror.......", ".......r........", "................",
  ],
  sword: [
    "...............w", "..............wg", ".............wg.", "............wg..", "...........wg...", "..........wg....", ".........wg.....", "........wg......",
    ".......wg.......", "..yy..wg........", "...yyyyk........", "....yyy.........", "...yykyy........", "..yy...yy.......", ".y.......y......", "................",
  ],
  sparkle: [
    ".......w........", ".......w........", "......cwc.......", ".......w........", "..w....w....w...", "...w..cwc..w....", "....wwwwwww.....", ".ccwwwwwwwwwcc..",
    "....wwwwwww.....", "...w..cwc..w....", "..w....w....w...", ".......w........", "......cwc.......", ".......w........", ".......w........", "................",
  ],
  wind: [
    "................", "....kkkk........", "...kwwwwk.......", "..kw....wk......", ".........wk.....", "kwwwwwwwwwk.....", "................", ".....kkkkkkkk...",
    "....kwwwwwwwwk..", "...kw........wk.", "..............wk", ".kwwwwwwwwwwwwk.", "................", "....kkkkk.......", "...kwwwwwk......", "..kw.....wk.....",
  ],
  gun: [
    "................", "................", "..kkkkkkkkkkkkk.", ".kggggggggggggk.", ".kggggggggggggkk", ".kggggggggggggk.", "..kkkkkggggkkk..", "......kggggk....",
    "......kgggk.....", "......kgggk.....", ".....kgggk......", ".....kgggk......", ".....kggk.......", ".....kkkk.......", "................", "................",
  ],
  boot: [
    "................", "................", ".....kkkkkk.....", ".....kooooook...", ".....kooooook...", ".....kooooook...", ".....kooooook...", ".....kooooook...",
    ".....koooooook..", ".....kooooooook.", "..kkkkoooooooook", ".kooooooooooooook".slice(0, 16), ".kkkkkkkkkkkkkkk", "................", "................", "................",
  ],
  dog: [
    "................", ".kk..........kk.", "koook......koook", "kooook....kooook", ".kooookkkkooook.", "..koooooooooook.", "..kooooooooook..", "..kokkoooookkok.",
    "..kokkoooookkok.", "..kooooooooook..", "..koooookkoook..", "..kooookkkkook..", "...kooookkook...", "....kooooook....", ".....kkkkkk.....", "................",
  ],
  cat: [
    "................", ".k............k.", ".kk..........kk.", ".kgk........kgk.", ".kggk......kggk.", ".kgggkkkkkkgggk.", ".kggggggggggggk.", ".kggggggggggggk.",
    ".kgkkggggggkkgk.", ".kgkkggggggkkgk.", ".kggggggggggggk.", ".kggggkrrgggggk.", "..kggggggggggk..", "...kkggggggkk...", ".....kkkkkk.....", "................",
  ],
  car: [
    "................", "................", "................", "......kkkkkk....", ".....kbbbbbbk...", "....kbbbbbbbbk..", "...kbkkbbbbkkbk.", "..kbbbbbbbbbbbbk",
    ".kbbbbbbbbbbbbbk", ".kbbbbbbbbbbbbbk", ".kbbbbbbbbbbbbbk", "..kkkkkkkkkkkkk.", "...kwk.....kwk..", "...kkk.....kkk..", "................", "................",
  ],
  water: [
    "................", ".......k........", "......kbk.......", "......kbk.......", ".....kbbbk......", ".....kbbbk......", "....kbbbbbk.....", "....kbbbbbk.....",
    "...kbbbbbbbk....", "...kbbwbbbbk....", "...kbbwbbbbk....", "...kbbbbbbbk....", "....kbbbbbk.....", ".....kbbbk......", "......kkk.......", "................",
  ],
  bell: [
    "................", ".......kk.......", "......kyyk......", "......kyyk......", ".....kyyyyk.....", ".....kyyyyk.....", "....kyyyyyyk....", "....kyyyyyyk....",
    "....kyyyyyyk....", "...kyyyyyyyyk...", "...kyyyyyyyyk...", "..kyyyyyyyyyyk..", ".kkkkkkkkkkkkkk.", "......kkkk......", "......kook......", ".......kk.......",
  ],
  bolt: [
    "................", ".........kk.....", "........kyyk....", ".......kyyk.....", "......kyyk......", ".....kyyk.......", "....kyykkkk.....", "...kyyyyyyyk....",
    "....kkkkkyyk....", "........kyk.....", ".......kyk......", "......kyk.......", ".....kyk........", "....kyk.........", "....kk..........", "................",
  ],
  fire: [
    "................", ".......r........", "......rr........", ".....rro........", "....rrooo.......", "...rroooor......", "...rooooyor.....", "..rooooyyoor....",
    "..roooyyyyoor...", "..rooyyyyyoor...", "..rooyywwyyor...", "..rooyywwyyor...", "...royyyyyyor...", "...rroyyyyorr...", "....rroooorr....", ".....rrrrrr.....",
  ],
  bird: [
    "................", "................", "....kkk.........", "...kwwwk........", "..kwkwwwk.......", "..kwwwwwkkkkkk..", ".ykwwwwwwwwwwwk.", "..kwwwwwwwwwwk..",
    "...kwwwwwwwwk...", "....kwwwwwwwwk..", ".....kwwwwkwwwk.", "......kkkk.kkk..", ".......k.k......", "......kk.kk.....", "................", "................",
  ],
};

/** Mouth / eye overlays on the face sprite (row, col, token). */
function faceOverlay(m: Mouth, open01: number): [number, number, string][] {
  const px: [number, number, string][] = [];
  const row = (r: number, c0: number, c1: number, t: string) => { for (let c = c0; c <= c1; c++) px.push([r, c, t]); };
  switch (m) {
    case "sleep": // eyes closed, flat mouth
      row(5, 3, 5, "y"); row(5, 10, 12, "y"); row(6, 3, 5, "y"); row(6, 10, 12, "y"); row(6, 4, 5, "k"); row(6, 10, 11, "k");
      row(10, 6, 9, "k");
      break;
    case "closed": row(10, 5, 10, "k"); break;
    case "open": {
      const h = Math.max(1, Math.round(1 + open01 * 3)); // 1..4 rows tall
      row(9, 5, 10, "k");
      for (let r = 10; r < 10 + h; r++) { px.push([r, 4, "k"]); row(r, 5, 10, "r"); px.push([r, 11, "k"]); }
      row(10 + h, 5, 10, "k");
      break;
    }
    case "spread": row(9, 3, 12, "k"); row(10, 3, 3, "k"); row(10, 4, 11, "w"); row(10, 12, 12, "k"); row(11, 4, 11, "k"); break;
    case "round": row(9, 7, 8, "k"); px.push([10, 6, "k"]); row(10, 7, 8, "r"); px.push([10, 9, "k"]); row(11, 7, 8, "k"); break;
    case "mid": row(9, 5, 10, "k"); px.push([10, 4, "k"]); row(10, 5, 10, "r"); px.push([10, 11, "k"]); row(11, 5, 10, "k"); break;
    case "laugh": // ^ ^ eyes + wide open mouth
      row(5, 4, 5, "y"); row(5, 10, 11, "y"); row(6, 4, 5, "y"); row(6, 10, 11, "y");
      px.push([5, 4, "k"], [5, 11, "k"], [6, 3, "k"], [6, 5, "k"], [6, 10, "k"], [6, 12, "k"]);
      row(9, 4, 11, "k"); row(10, 3, 3, "k"); row(10, 4, 11, "r"); row(10, 12, 12, "k"); row(11, 4, 11, "r"); row(12, 5, 10, "k");
      break;
    case "sing": row(9, 6, 9, "k"); px.push([10, 5, "k"]); row(10, 6, 9, "r"); px.push([10, 10, "k"]); px.push([11, 5, "k"]); row(11, 6, 9, "r"); px.push([11, 10, "k"]); row(12, 6, 9, "k"); break;
  }
  return px;
}

interface Scene { sprite: SpriteName; mouth: Mouth; label: string; anim: "idle" | "bob" | "shake" | "pulse" | "sway" | "float" }

const AI_MAP: [string[], Scene][] = [
  [["laugh", "giggle", "chuckle"], { sprite: "face", mouth: "laugh", label: "웃음", anim: "shake" }],
  [["singing", "choir", "yodel", "chant", "humming", "rapping"], { sprite: "face", mouth: "sing", label: "노래", anim: "sway" }],
  [["speech", "conversation", "narration", "babbling", "whisper", "shout", "yell", "scream"], { sprite: "face", mouth: "open", label: "말소리", anim: "idle" }],
  [["gunshot", "gunfire", "machine gun", "cap gun", "artillery", "fusillade", "fireworks", "firecracker"], { sprite: "gun", mouth: "closed", label: "총성", anim: "shake" }],
  [["explosion", "burst", "eruption", "boom"], { sprite: "boom", mouth: "closed", label: "폭발", anim: "pulse" }],
  [["thunder", "electricity", "static", "zap"], { sprite: "bolt", mouth: "closed", label: "번개", anim: "shake" }],
  [["footsteps", "walk", "running", "stomp", "shuffle"], { sprite: "boot", mouth: "closed", label: "발소리", anim: "bob" }],
  [["dog", "bark", "howl", "growl", "whimper", "bow-wow"], { sprite: "dog", mouth: "closed", label: "개", anim: "bob" }],
  [["cat", "meow", "purr", "caterwaul"], { sprite: "cat", mouth: "closed", label: "고양이", anim: "sway" }],
  [["vehicle", "car", "engine", "motorcycle", "truck", "bus", "race car", "idling", "accelerating", "skidding", "tire"], { sprite: "car", mouth: "closed", label: "차량", anim: "shake" }],
  [["water", "rain", "stream", "splash", "liquid", "drip", "pour", "waves", "gurgling", "fill"], { sprite: "water", mouth: "closed", label: "물", anim: "float" }],
  [["bell", "chime", "jingle", "ding", "church bell", "wind chime"], { sprite: "bell", mouth: "closed", label: "종", anim: "sway" }],
  [["wind", "rustling", "howl", "breeze"], { sprite: "wind", mouth: "closed", label: "바람", anim: "sway" }],
  [["whoosh", "swoosh", "swish", "whip", "slap", "smack", "slash", "sword"], { sprite: "sword", mouth: "closed", label: "휙 · 베기", anim: "shake" }],
  [["fire", "crackle", "flame", "sizzle"], { sprite: "fire", mouth: "closed", label: "불", anim: "pulse" }],
  [["bird", "chirp", "tweet", "squawk", "crow", "owl", "pigeon", "goose", "duck", "chicken", "coo"], { sprite: "bird", mouth: "closed", label: "새", anim: "bob" }],
  [["drum", "percussion", "snare", "cymbal", "tabla", "beat", "hi-hat", "timpani"], { sprite: "drum", mouth: "closed", label: "드럼", anim: "bob" }],
  [["music", "guitar", "piano", "synthesizer", "violin", "orchestra", "song", "melody", "instrument", "organ", "flute", "trumpet", "saxophone", "bass", "harp", "keyboard", "electronic", "ambient", "chord", "strum", "pluck"], { sprite: "note", mouth: "closed", label: "음악", anim: "bob" }],
  [["glass", "shatter", "chink", "clink", "coin", "keys jangling", "metal", "clang"], { sprite: "sparkle", mouth: "closed", label: "금속 · 유리", anim: "shake" }],
  [["silence"], { sprite: "face", mouth: "sleep", label: "조용함", anim: "float" }],
];

export class EmojiModule implements Module {
  readonly id = "emoji";
  readonly title = "Emoji";
  private scene: Scene = { sprite: "face", mouth: "sleep", label: "조용함", anim: "float" };
  private sceneUntil = 0;         // transient scenes hold until this clock
  private clock = 0;
  private level = -120;           // smoothed level dB
  private levelSlow = -120;       // slower level for onset detection
  private lastOnset = -10;
  private onsets: number[] = [];
  private impact = 0;             // 1 right after a transient → 0 (burst behind the sprite)
  private impactPow = 0;          // how hard the transient was (0…1)
  private voiced = 0;             // smoothed voiced ratio
  private open = 0;               // mouth opening 0..1
  private mouthShape: Mouth = "closed";
  private shake = 0;
  private tags: AiTag[] = [];
  private tagSeq = 0;
  private lastTagPoll = 0;
  private aiLabel = "";
  private aiScore = 0;
  private aiAt = -100;

  private get mode() { return modSetting<"rule" | "ai">(this.id, "mode", "rule"); }
  private get showLabel() { return modSetting(this.id, "label", true); }

  settings(): SettingItem[] {
    return [
      { type: "select", label: "판별 방식", value: this.mode, options: [{ value: "rule", label: "규칙 (가벼움, 모델 없음)" }, { value: "ai", label: "AI (YAMNet 태그)" }], onChange: (v) => setModSetting(this.id, "mode", v) },
      { type: "toggle", label: "이름 표시", value: this.showLabel, onChange: (v) => setModSetting(this.id, "label", v) },
    ];
  }

  headReadout() { return this.scene.label + (this.mode === "ai" && this.aiLabel ? ` · ${this.aiLabel} ${Math.round(this.aiScore * 100)}%` : ""); }

  private pollAi() {
    const src = getSource();
    if (!src) return;
    requestTagging(this.id, this.mode === "ai", 1000);
    if (this.mode !== "ai") return;
    const now = performance.now();
    if (now - this.lastTagPoll < 300) return;
    this.lastTagPoll = now;
    src.tagsSince(this.tagSeq).then((ts) => {
      for (const t of ts) if (t.seq > this.tagSeq) { this.tagSeq = t.seq; this.tags.push(t); }
      if (this.tags.length > 20) this.tags.splice(0, this.tags.length - 20);
      const last = this.tags[this.tags.length - 1];
      if (last && last.top[0]) { this.aiLabel = last.top[0][1]; this.aiScore = last.top[0][2]; this.aiAt = this.clock; }
    }).catch(() => {});
  }

  private classify(f: Frame, dt: number) {
    const lvl = Math.max(f.rms[0], f.rms[1]);
    this.level += (lvl - this.level) * Math.min(1, dt * 20);
    this.levelSlow += (lvl - this.levelSlow) * Math.min(1, dt * 3);
    const silent = this.level < -55;
    const v = f.voiced > 0.5 && f.f0 > 60 && f.f0 < 1200 && !silent ? 1 : 0;
    this.voiced += (v - this.voiced) * Math.min(1, dt * 8);
    // onset: level jumps ≥ 9 dB over its slow average
    const onset = !silent && lvl - this.levelSlow > 9 && this.clock - this.lastOnset > 0.12;
    if (onset) {
      this.lastOnset = this.clock;
      this.onsets.push(this.clock);
      if (this.onsets.length > 12) this.onsets.shift();
      this.shake = 1;
      this.impact = 1;
      this.impactPow = Math.max(0.2, Math.min(1, (lvl - this.levelSlow - 9) / 15));
    }
    this.impact = Math.max(0, this.impact - dt * 2.6);
    // rhythmic? intervals of the last 6 onsets agree within 15 %
    let rhythmic = false;
    if (this.onsets.length >= 5) {
      const iv: number[] = [];
      for (let i = this.onsets.length - 5; i < this.onsets.length - 1; i++) iv.push(this.onsets[i + 1] - this.onsets[i]);
      const m = iv.reduce((a, b) => a + b, 0) / iv.length;
      const cv = Math.sqrt(iv.reduce((a, b) => a + (b - m) ** 2, 0) / iv.length) / Math.max(1e-3, m);
      rhythmic = cv < 0.15 && m > 0.2 && m < 1.5 && this.clock - this.onsets[this.onsets.length - 1] < 2 * m;
    }
    // mouth shape from vowel (F1/F2)
    const nv = v && f.f1 > 0 && f.f2 > 0 ? nearestVowel(f.f1, f.f2) : null;
    const ipa = nv?.v.ipa ?? "";
    const target: Mouth = !v ? "closed" : /[aɑæʌɐ]/.test(ipa) ? "open" : /[ieɪɛ]/.test(ipa) ? "spread" : /[uoʊɔ]/.test(ipa) ? "round" : "mid";
    if (target !== "closed") this.mouthShape = target;
    const op = v ? Math.max(0, Math.min(1, (this.level + 40) / 30)) : 0;
    this.open += (op - this.open) * Math.min(1, dt * 15);

    if (this.mode === "ai") {
      if (this.clock - this.aiAt < 3 && this.aiLabel) {
        const n = this.aiLabel.toLowerCase();
        const hit = AI_MAP.find(([keys]) => keys.some((k) => n.includes(k)));
        if (hit) { this.scene = { ...hit[1] }; if (this.scene.mouth === "open") this.scene.mouth = this.mouthShape === "closed" ? "mid" : this.mouthShape; return; }
        this.scene = silent ? { sprite: "face", mouth: "sleep", label: "조용함", anim: "float" } : { sprite: "sparkle", mouth: "closed", label: this.aiLabel, anim: "pulse" };
        return;
      }
      if (silent) { this.scene = { sprite: "face", mouth: "sleep", label: "조용함", anim: "float" }; return; }
      this.scene = { sprite: "face", mouth: "closed", label: "듣는 중…", anim: "idle" };
      return;
    }

    // Rule mode. Transient scenes stick for 0.45 s.
    if (onset && this.voiced < 0.4) {
      const bright = f.centroid > 2500, noisy = f.flatness > 0.25, loud = lvl > -18;
      let sc: Scene;
      if (rhythmic) sc = { sprite: "drum", mouth: "closed", label: "드럼 · 리듬", anim: "bob" };
      else if (f.centroid < 500 && loud) sc = { sprite: "boom", mouth: "closed", label: "쿵 · 임팩트", anim: "pulse" };
      else if (bright && noisy) sc = { sprite: "sword", mouth: "closed", label: "챙 · 휙", anim: "shake" };
      else if (bright) sc = { sprite: "sparkle", mouth: "closed", label: "반짝 · 마법", anim: "pulse" };
      else sc = { sprite: "boot", mouth: "closed", label: "탁 · 타격", anim: "bob" };
      this.scene = sc; this.sceneUntil = this.clock + 0.45;
      return;
    }
    if (this.clock < this.sceneUntil) return;
    if (silent) { this.scene = { sprite: "face", mouth: "sleep", label: "조용함", anim: "float" }; return; }
    if (this.voiced > 0.45) {
      const singing = rhythmic || (f.f0 > 0 && this.onsets.length >= 3 && this.clock - this.onsets[this.onsets.length - 1] < 1.5);
      this.scene = { sprite: "face", mouth: this.mouthShape === "closed" ? "mid" : this.mouthShape, label: singing ? `노래 · ${ipa || "…"}` : `말소리 · ${ipa || "…"}`, anim: singing ? "sway" : "idle" };
      return;
    }
    if (rhythmic) { this.scene = { sprite: "note", mouth: "closed", label: "음악 · 비트", anim: "bob" }; return; }
    if (f.flatness > 0.45) { this.scene = { sprite: "wind", mouth: "closed", label: "바람 · 노이즈", anim: "sway" }; return; }
    if (f.flatness < 0.2 && f.centroid > 2000) { this.scene = { sprite: "sparkle", mouth: "closed", label: "반짝 · 고음", anim: "pulse" }; return; }
    if (f.flatness < 0.25) { this.scene = { sprite: "note", mouth: "closed", label: "음악 · 톤", anim: "float" }; return; }
    this.scene = { sprite: "face", mouth: "closed", label: "소리", anim: "idle" };
  }

  draw(d: DrawCtx, f: Frame) {
    const { ctx, w, h, dt } = d;
    this.clock += dt;
    this.pollAi();
    this.classify(f, dt);
    this.shake = Math.max(0, this.shake - dt * 4);
    const labelH = this.showLabel ? 16 : 0;
    const p = Math.max(1, Math.floor(Math.min(w - 12, h - labelH - 10) / 17));
    const size = p * 16;
    const cx = w / 2, baseY = (h - labelH) / 2;
    const lvl01 = Math.max(0, Math.min(1, (this.level + 60) / 60));
    // animation offsets
    let ox = 0, oy = 0, sc = 1;
    const a = this.scene.anim;
    const t = this.clock;
    if (a === "bob") oy = -Math.abs(Math.sin(t * 7)) * p * 1.2;
    else if (a === "float") oy = Math.sin(t * 2) * p * 0.6;
    else if (a === "sway") ox = Math.sin(t * 3) * p * 0.8;
    else if (a === "pulse") sc = 1 + 0.12 * Math.sin(t * 10) * lvl01;
    else if (a === "idle") sc = 1 + 0.05 * lvl01;
    if (this.shake > 0) { ox += (Math.random() - 0.5) * p * 2 * this.shake; oy += (Math.random() - 0.5) * p * 2 * this.shake; }
    // faint dot grid background
    ctx.fillStyle = withAlpha(theme("fg-2"), 0.18);
    const step = Math.max(6, p);
    for (let y = step / 2; y < h - labelH; y += step) for (let x = step / 2; x < w; x += step) ctx.fillRect(x - 0.5, y - 0.5, 1, 1);

    const sprite = S[this.scene.sprite];
    const overlay = this.scene.sprite === "face" ? faceOverlay(this.scene.mouth, this.open) : [];
    const sz = size * sc;
    // impact burst behind the sprite: a flash, an expanding shockwave ring and manga-style
    // impact lines, all sized by how hard the transient hit and fading over ~0.4 s
    if (this.impact > 0) {
      const k = this.impact, prog = 1 - k, pw = this.impactPow;
      const icx = cx + ox, icy = baseY + oy;
      ctx.save();
      ctx.fillStyle = withAlpha(theme("target"), 0.35 * k * pw);
      ctx.beginPath(); ctx.arc(icx, icy, sz * (0.55 + 0.25 * prog), 0, Math.PI * 2); ctx.fill();
      const rr = sz * (0.5 + 1.1 * prog * (0.6 + 0.4 * pw));
      ctx.strokeStyle = withAlpha(theme("peak"), 0.9 * k); ctx.lineWidth = Math.max(1.5, sz * 0.06 * k);
      ctx.beginPath(); ctx.arc(icx, icy, rr, 0, Math.PI * 2); ctx.stroke();
      const n = 12, r0 = sz * (0.55 + 0.5 * prog), len = sz * (0.25 + 0.55 * pw) * (0.5 + 0.5 * k);
      ctx.strokeStyle = withAlpha(theme("fg-0"), 0.85 * k); ctx.lineWidth = Math.max(1, sz * 0.03);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + (i % 2 ? 0.13 : 0);
        const l = len * (i % 3 === 0 ? 1 : 0.6);
        ctx.beginPath(); ctx.moveTo(icx + Math.cos(a) * r0, icy + Math.sin(a) * r0); ctx.lineTo(icx + Math.cos(a) * (r0 + l), icy + Math.sin(a) * (r0 + l)); ctx.stroke();
      }
      ctx.restore();
    }
    const ps = sz / 16;
    const left = cx - sz / 2 + ox, top = baseY - sz / 2 + oy;
    ctx.imageSmoothingEnabled = false;
    const cell = new Map<string, string>();
    for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) { const ch = sprite[r]?.[c] ?? "."; if (ch !== ".") cell.set(`${r},${c}`, ch); }
    for (const [r, c, tk] of overlay) cell.set(`${r},${c}`, tk);
    for (const [key, tk] of cell) {
      const [r, c] = key.split(",").map(Number);
      ctx.fillStyle = theme(PAL[tk] ?? "fg-0");
      ctx.fillRect(Math.round(left + c * ps), Math.round(top + r * ps), Math.ceil(ps), Math.ceil(ps));
    }
    // sleeping: z z z
    if (this.scene.mouth === "sleep") {
      ctx.fillStyle = theme("fg-1"); ctx.font = font(Math.max(9, p * 2.2), 700); ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      const ph = (t * 0.8) % 1;
      ctx.fillText("z", left + sz + p * 0.5 + ph * p * 2, top + sz * 0.45 - ph * p * 3);
      ctx.fillText("z", left + sz + p * 2.5 + ph * p * 2, top + sz * 0.25 - ph * p * 3);
    }
    // level dots (sound waves) beside the sprite
    const dots = Math.round(lvl01 * 4);
    ctx.fillStyle = withAlpha(theme("sig"), 0.8);
    for (let i = 0; i < dots; i++) {
      const r = sz / 2 + p * (1.5 + i * 1.5);
      ctx.fillRect(Math.round(cx + ox + r), Math.round(baseY + oy - p / 2), p, p);
      ctx.fillRect(Math.round(cx + ox - r - p), Math.round(baseY + oy - p / 2), p, p);
    }
    if (this.showLabel) {
      ctx.fillStyle = theme("fg-1"); ctx.font = font(11, 600); ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText(this.scene.label, cx, h - 4);
    }
  }
}
