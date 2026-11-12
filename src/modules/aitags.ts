// Helpers for AI (YAMNet / AudioSet) tags: coarse groups for filtering and colours.
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
