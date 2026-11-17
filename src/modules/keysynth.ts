// Click-to-play piano voice shared by the Piano and Pitch keyboards (WebAudio, per window).
// A small additive piano: a periodic wave with falling harmonics, two slightly detuned
// oscillators, a low-pass that closes as the note decays, percussive envelope. The sound goes
// to the system output, so the app hears its own notes through the loopback — handy for
// checking what the Piano / Pitch modules read for a known key.

let actx: AudioContext | null = null;
let wave: PeriodicWave | null = null;
let master: GainNode | null = null;

function ctx(): AudioContext | null {
  if (actx) return actx;
  try {
    actx = new AudioContext();
    const n = 12;
    const real = new Float32Array(n + 1), imag = new Float32Array(n + 1);
    for (let h = 1; h <= n; h++) imag[h] = Math.pow(h, -1.3) * (h % 2 === 0 ? 0.85 : 1); // odd harmonics a touch stronger (hammer at 1/7)
    wave = actx.createPeriodicWave(real, imag, { disableNormalization: false });
    master = actx.createGain();
    master.gain.value = 0.5;
    master.connect(actx.destination);
  } catch { actx = null; }
  return actx;
}

/** Plays MIDI note `midi` (A4 = 69) once; velocity 0…1. */
export function playNote(midi: number, velocity = 0.8) {
  const ac = ctx();
  if (!ac || !wave || !master) return;
  if (ac.state === "suspended") void ac.resume();
  const hz = 440 * Math.pow(2, (midi - 69) / 12);
  const vel = Math.max(0.05, Math.min(1, velocity));
  const t0 = ac.currentTime;
  // decay shortens with pitch like a real string (≈ 2.2 s at C3, 0.7 s at C6)
  const decay = Math.max(0.35, Math.min(3, 2.2 * Math.pow(130.8 / hz, 0.45)));
  const env = ac.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(vel, t0 + 0.004);
  env.gain.exponentialRampToValueAtTime(vel * 0.25, t0 + decay * 0.35);
  env.gain.exponentialRampToValueAtTime(0.001, t0 + decay);
  const lp = ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(Math.min(16000, hz * (6 + 10 * vel)), t0);
  lp.frequency.exponentialRampToValueAtTime(Math.max(hz * 1.5, 400), t0 + decay);
  lp.Q.value = 0.5;
  for (const cents of [0, 3.5]) {
    const o = ac.createOscillator();
    o.setPeriodicWave(wave);
    o.frequency.value = hz;
    o.detune.value = cents;
    o.connect(lp);
    o.start(t0);
    o.stop(t0 + decay + 0.05);
  }
  lp.connect(env);
  env.connect(master);
}
