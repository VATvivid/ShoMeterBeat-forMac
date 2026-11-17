// Helpers for AI (AudioSet) tags: coarse groups for filtering and colours, a shared on/off so
// several modules can request tagging without fighting, and the shared model choice.
import { getSource } from "../engine/instance";
import type { SettingItem } from "./types";

const owners = new Map<string, number>();
let sent = "";
/** Request (or release) AI tagging for `owner`; the engine runs at the shortest interval anyone asked for. */
export function requestTagging(owner: string, on: boolean, intervalMs = 1000) {
  if (on) owners.set(owner, intervalMs); else owners.delete(owner);
  const src = getSource();
  if (!src) return;
  syncModel();
  const enabled = owners.size > 0;
  const interval = enabled ? Math.min(...owners.values()) : 1000;
  const key = `${enabled}:${interval}`;
  if (key === sent) return;
  sent = key;
  src.setTagging(enabled, interval).catch(() => {});
  if (enabled) refreshModels();
}

// ---- model choice (one engine-wide tagger; every window shares localStorage) --------------
/** Selectable models, newest first. `id` matches src-tauri/src/audio/tagger.rs MODELS. */
export const TAG_MODELS: { id: string; label: string }[] = [
  { id: "efficientat", label: "EfficientAT mn10 (2023 · MIT · 더 정확)" },
  { id: "yamnet", label: "YAMNet (2019 · Apache-2.0)" },
];
const MODEL_KEY = "rm.tagModel.v1";
let available: string[] | null = null;
let sentModel = "";
export function tagModel(): string {
  try { return localStorage.getItem(MODEL_KEY) || "yamnet"; } catch { return "yamnet"; }
}
export function tagModelLabel(id = tagModel()): string {
  return (TAG_MODELS.find((m) => m.id === id)?.label ?? id).replace(/\s*\(.*$/, "");
}
function syncModel() {
  const m = tagModel();
  if (m === sentModel) return;
  sentModel = m;
  getSource()?.setTagModel(m).catch(() => {});
}
function refreshModels() {
  getSource()?.tagStatus().then((s) => { if (s.models) available = s.models; }).catch(() => {});
}
/** Right-click menu row "AI 모델" — the same choice from every module that uses AI tags. */
export function tagModelSetting(): SettingItem {
  refreshModels();
  return {
    type: "select", label: "AI 모델", value: tagModel(),
    options: TAG_MODELS.map((m) => ({ value: m.id, label: available && !available.includes(m.id) ? `${m.label} — 파일 없음` : m.label })),
    onChange: (v) => { try { localStorage.setItem(MODEL_KEY, v); } catch { /* ignore */ } syncModel(); },
  };
}
// another window changed the model: follow it
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e) => { if (e.key === MODEL_KEY) syncModel(); });
}
export type TagGroup = "voice" | "music" | "sfx" | "other";

const VOICE = ["speech", "conversation", "narration", "babbling", "singing", "choir", "yodel", "chant", "humming", "whisper", "laughter", "crying", "sobbing", "shout", "yell", "scream", "whoop", "whimper", "groan", "grunt", "sigh", "breathing", "cough", "sneeze", "snore", "gasp", "pant", "throat", "child speech", "male speech", "female speech", "synthetic singing", "rapping"];
const MUSIC = ["music", "guitar", "piano", "drum", "bass", "synthesizer", "violin", "cello", "trumpet", "saxophone", "flute", "organ", "orchestra", "song", "melody", "beat", "techno", "house", "hip hop", "rock", "pop", "jazz", "electronic", "ambient", "chord", "harmonica", "accordion", "banjo", "ukulele", "harp", "bell", "chime", "marimba", "xylophone", "vibraphone", "steelpan", "cymbal", "snare", "tabla", "bagpipes", "didgeridoo", "theremin", "sitar", "mandolin", "zither", "harpsichord", "keyboard", "plucked", "strum", "bowed", "brass", "wind instrument", "percussion", "mallet", "tuning", "scratching", "dubstep", "drum and bass", "ska", "reggae", "funk", "disco", "soul", "blues", "folk", "country", "opera", "carnatic", "flamenco", "salsa", "gospel", "christmas", "lullaby", "video game music", "theme music", "jingle", "soundtrack", "new-age", "a capella", "vocal music", "background music", "wedding music", "happy music", "sad music", "tender music", "exciting music", "angry music", "scary music"];
const OTHER = ["silence", "noise", "static", "mains hum", "distortion", "echo", "reverberation", "inside, small room", "inside, large room", "outside", "sound effect", "environmental noise", "hum", "white noise", "pink noise", "sidetone", "field recording"];

export function tagGroup(name: string): TagGroup {
  const n = name.toLowerCase();
  if (VOICE.some((k) => n.includes(k))) return "voice";
  if (MUSIC.some((k) => n.includes(k))) return "music";
  if (OTHER.some((k) => n.includes(k))) return "other";
  return "sfx";
}

export const GROUP_LABEL: Record<TagGroup, string> = { voice: "음성", music: "음악", sfx: "효과음", other: "기타" };
