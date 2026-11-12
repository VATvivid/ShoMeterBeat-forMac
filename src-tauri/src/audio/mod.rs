//! Audio engine: WASAPI loopback capture → analysis → packed frames for the UI.
//!
//! Thread model (nothing here needs `cpal::Stream` to be `Send`):
//! - **audio thread** owns the `cpal::Stream`, pushes interleaved stereo f32 into `Shared::ring`
//!   and reacts to control messages (device change, stop).
//! - **analysis thread** drains the ring, runs FFT / levels / EBU R128 and publishes the
//!   latest [`frame::Frame`] into `Shared::frame`.
//! - Tauri commands only read `Shared` (see `lib.rs`).

pub mod analyzer;
pub mod capture;
pub mod frame;
pub mod loudness;
pub mod decode;
pub mod recorder;
pub mod tempo;
pub mod voice;
pub mod wave;

use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

/// Interleaved stereo samples waiting for analysis. Bounded to ~2 s so a stalled
/// analysis thread can never grow memory.
pub struct Ring {
    pub data: VecDeque<f32>,
    pub cap: usize,
}

impl Ring {
    pub fn new(cap: usize) -> Self {
        Self { data: VecDeque::with_capacity(cap), cap }
    }
    pub fn push(&mut self, s: &[f32]) {
        if s.len() >= self.cap {
            self.data.clear();
            self.data.extend(&s[s.len() - self.cap..]);
            return;
        }
        let overflow = (self.data.len() + s.len()).saturating_sub(self.cap);
        if overflow > 0 {
            self.data.drain(..overflow);
        }
        self.data.extend(s);
    }
}

/// Where the analyzed signal comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Loopback of an output device **plus** every live DAW plugin slot, summed.
    #[default]
    Auto,
    /// Loopback of one output device only.
    Output,
    /// One input (recording) device only.
    Input,
    /// DAW plugin slots only.
    Plugin,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct Status {
    pub device: String,
    pub kind: capture::Kind,
    pub mode: Mode,
    /// Live DAW plugin instances feeding the bridge.
    pub plugins: usize,
    pub sample_rate: u32,
    pub channels: u16,
    pub running: bool,
    pub error: Option<String>,
}

pub enum Ctl {
    SetSource(Mode, Option<String>),
    Stop,
}

/// Recording control from the UI → analysis thread, and its result back.
pub enum RecCtl {
    Start,
    Stop,
}

#[derive(Default)]
pub struct RecState {
    pub pending: Option<RecCtl>,
    pub info: recorder::RecInfo,
    /// Finished temp file waiting for save/discard.
    pub finished: Option<std::path::PathBuf>,
    pub error: Option<String>,
}

pub struct Shared {
    pub ring: Mutex<Ring>,
    pub frame: Mutex<frame::Frame>,
    pub status: Mutex<Status>,
    pub ctl: Mutex<Option<mpsc::Sender<Ctl>>>,
    pub reset_loudness: AtomicBool,
    pub rec: Mutex<RecState>,
    pub mode: Mutex<Mode>,
    pub wave: Mutex<Option<wave::WaveHistory>>,
}

impl Shared {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            ring: Mutex::new(Ring::new(48_000 * 2 * 2)),
            frame: Mutex::new(frame::Frame::default()),
            status: Mutex::new(Status::default()),
            ctl: Mutex::new(None),
            reset_loudness: AtomicBool::new(false),
            rec: Mutex::new(RecState::default()),
            mode: Mutex::new(Mode::Auto),
            wave: Mutex::new(None),
        })
    }

    pub fn send(&self, c: Ctl) {
        if let Some(tx) = self.ctl.lock().as_ref() {
            let _ = tx.send(c);
        }
    }
}

/// Spawns both engine threads. Returns immediately.
pub fn start(shared: Arc<Shared>) {
    let (tx, rx) = mpsc::channel::<Ctl>();
    *shared.ctl.lock() = Some(tx);

    // ---- audio thread --------------------------------------------------------
    {
        let shared = shared.clone();
        std::thread::Builder::new()
            .name("audio-capture".into())
            .spawn(move || {
                let mut current: Option<capture::Capture> = None;
                let mut wanted: Option<String> = None;
                let mut mode = Mode::Auto;
                let mut retry_at = Instant::now();
                loop {
                    if mode == Mode::Plugin {
                        // No device stream: the analysis thread reads the bridge directly.
                        if current.is_some() {
                            current = None;
                        }
                        let mut st = shared.status.lock();
                        if !st.running || st.device != "DAW 플러그인" {
                            let plugins = st.plugins;
                            *st = Status {
                                device: "DAW 플러그인".into(),
                                kind: capture::Kind::Output,
                                mode,
                                plugins,
                                sample_rate: 48_000,
                                channels: 2,
                                running: true,
                                error: None,
                            };
                        }
                    } else if current.is_none() && Instant::now() >= retry_at {
                        let kind = if mode == Mode::Input { capture::Kind::Input } else { capture::Kind::Output };
                        match capture::start(wanted.as_deref(), kind, shared.clone()) {
                            Ok(c) => {
                                let plugins = shared.status.lock().plugins;
                                *shared.status.lock() = Status {
                                    device: c.name.clone(),
                                    kind: c.kind,
                                    mode,
                                    plugins,
                                    sample_rate: c.sample_rate,
                                    channels: c.channels,
                                    running: true,
                                    error: None,
                                };
                                log::info!("capture started: {} @ {} Hz x{}", c.name, c.sample_rate, c.channels);
                                current = Some(c);
                            }
                            Err(e) => {
                                log::warn!("capture start failed: {e}");
                                let mut st = shared.status.lock();
                                st.running = false;
                                st.error = Some(e);
                                retry_at = Instant::now() + Duration::from_secs(2);
                            }
                        }
                    }
                    match rx.recv_timeout(Duration::from_millis(250)) {
                        Ok(Ctl::SetSource(m, name)) => {
                            wanted = name;
                            mode = m;
                            *shared.mode.lock() = m;
                            current = None; // drops the stream
                            retry_at = Instant::now();
                            let mut st = shared.status.lock();
                            st.mode = m;
                            st.running = false;
                            st.error = None;
                        }
                        Ok(Ctl::Stop) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            // Detect a stream that died (device unplugged): cpal reports via
                            // the error callback which flips `running` to false.
                            if current.is_some() && !shared.status.lock().running {
                                current = None;
                                retry_at = Instant::now() + Duration::from_secs(1);
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .expect("spawn audio thread");
    }

    // ---- analysis thread -----------------------------------------------------
    {
        let shared = shared.clone();
        std::thread::Builder::new()
            .name("audio-analysis".into())
            .spawn(move || analysis_loop(shared))
            .expect("spawn analysis thread");
    }
}

fn analysis_loop(shared: Arc<Shared>) {
    let mut sr: u32 = 0;
    let mut an: Option<analyzer::Analyzer> = None;
    let mut lufs: Option<loudness::Loudness> = None;
    let mut voice: Option<voice::VoiceAnalyzer> = None;
    let mut rec: Option<recorder::Recorder> = None;
    let mut bridge = rm_shm::Reader::open().map_err(|e| log::warn!("bridge: {e}")).ok();
    let mut bridge_buf: Vec<f32> = Vec::new();
    let mut last_plugins_at = Instant::now();
    let mut last_voice = voice::Voice::default();
    let mut last_publish = Instant::now();
    let mut last_voice_at = Instant::now();
    let mut seq: u32 = 0;
    let publish_every = Duration::from_micros(16_000); // ~60 fps
    let voice_every = Duration::from_millis(25); // formants at 40 Hz is plenty

    loop {
        std::thread::sleep(Duration::from_millis(4));

        let st_sr = shared.status.lock().sample_rate;
        if st_sr != 0 && st_sr != sr {
            sr = st_sr;
            an = Some(analyzer::Analyzer::new(sr));
            lufs = Some(loudness::Loudness::new(sr));
            voice = Some(voice::VoiceAnalyzer::new(sr));
            *shared.wave.lock() = Some(wave::WaveHistory::new(sr));
        }
        let (Some(an), Some(lufs), Some(voice)) = (an.as_mut(), lufs.as_mut(), voice.as_mut()) else { continue };

        if shared.reset_loudness.swap(false, Ordering::Relaxed) {
            lufs.reset();
        }

        // ---- recording control
        let pending = shared.rec.lock().pending.take();
        match pending {
            Some(RecCtl::Start) if rec.is_none() => match recorder::Recorder::start(sr) {
                Ok(r) => {
                    let mut s = shared.rec.lock();
                    s.info = recorder::RecInfo { recording: true, seconds: 0.0, path: Some(r.path.display().to_string()) };
                    s.error = None;
                    rec = Some(r);
                }
                Err(e) => shared.rec.lock().error = Some(e),
            },
            Some(RecCtl::Stop) => {
                if let Some(r) = rec.take() {
                    let mut s = shared.rec.lock();
                    match r.finish() {
                        Ok(p) => s.finished = Some(p),
                        Err(e) => s.error = Some(e),
                    }
                    s.info = recorder::RecInfo::default();
                }
            }
            _ => {}
        }

        let mut chunk: Vec<f32> = {
            let mut r = shared.ring.lock();
            r.data.drain(..).collect()
        };
        // DAW plugin bridge: summed into the device chunk (Auto) or used alone (Plugin).
        let mode = *shared.mode.lock();
        if let (Some(b), true) = (bridge.as_mut(), matches!(mode, Mode::Auto | Mode::Plugin)) {
            bridge_buf.clear();
            b.pull(sr, &mut bridge_buf);
            if !bridge_buf.is_empty() {
                if chunk.len() < bridge_buf.len() {
                    chunk.resize(bridge_buf.len(), 0.0);
                }
                for (c, p) in chunk.iter_mut().zip(bridge_buf.iter()) {
                    *c += *p;
                }
            }
            if last_plugins_at.elapsed() >= Duration::from_millis(500) {
                last_plugins_at = Instant::now();
                let n = b.live_count();
                let mut st = shared.status.lock();
                if st.plugins != n {
                    st.plugins = n;
                }
            }
        }
        if !chunk.is_empty() {
            an.feed(&chunk);
            lufs.feed(&chunk);
            if let Some(r) = rec.as_mut() {
                r.write(&chunk);
            }
            if let Some(wh) = shared.wave.lock().as_mut() {
                wh.push(&chunk);
            }
        }

        if last_voice_at.elapsed() >= voice_every {
            last_voice_at = Instant::now();
            let mono = an.mono_tail(voice.needed_samples());
            last_voice = voice.analyze(&mono);
        }

        if last_publish.elapsed() >= publish_every {
            last_publish = Instant::now();
            seq = seq.wrapping_add(1);
            let st = shared.status.lock().clone();
            let mut f = an.snapshot();
            lufs.fill(&mut f);
            f.seq = seq;
            f.sample_rate = sr as f32;
            f.running = st.running;
            f.channels = st.channels;
            f.f0 = last_voice.f0;
            f.f1 = last_voice.f1;
            f.f2 = last_voice.f2;
            f.f3 = last_voice.f3;
            f.voiced = last_voice.voiced;
            f.envelope.copy_from_slice(&voice.envelope);
            f.rec_seconds = match rec.as_ref() {
                Some(r) => {
                    let s = r.seconds();
                    shared.rec.lock().info.seconds = s;
                    s
                }
                None => -1.0,
            };
            *shared.frame.lock() = f;
        }
    }
}
