//! Diagnostic: run the Piano's polyphonic transcription (transcribe.rs, Basic Pitch) over a file the
//! way the live thread does (22 050 Hz resampler, 2 s window every 8 frames, 8-frame latency) and
//! write the note / onset posteriorgrams as CSV rows (time, 88 notes, 88 onsets).
//! Usage: `cargo run --release --example transcribe -- <file> <out.csv> [max_secs] [mode 0|1|2]`
//! (CSV time column = frame index × the mode's frame period, from the first emitted frame)

use showmeterbeat_lib::audio::transcribe::{infer, load_session, TranscriberState};
use std::io::Write;

fn main() {
    let path = std::env::args().nth(1).expect("usage: transcribe <file> <out.csv> [max_secs]");
    let out = std::env::args().nth(2).expect("out.csv");
    let max_secs: f32 = std::env::args().nth(3).and_then(|s| s.parse().ok()).unwrap_or(60.0);
    let d = showmeterbeat_lib::audio::decode::decode(&path, max_secs).expect("decode");
    let sr = d.sample_rate;
    let dir = std::path::PathBuf::from("models");
    let mode: usize = std::env::args().nth(4).and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut sess = load_session(&dir, mode).expect("model");
    let sp = showmeterbeat_lib::audio::transcribe::spec(mode);
    let mut st = TranscriberState::new();
    let mut f = std::io::BufWriter::new(std::fs::File::create(&out).unwrap());
    let hop = (sr as usize / 100) * d.channels.max(1); // 10 ms chunks
    let mut n_frames = 0usize;
    let t0 = std::time::Instant::now();
    let mut runs = 0usize;
    for chunk in d.samples.chunks(hop) {
        let stereo: Vec<f32> = if d.channels >= 2 { chunk.chunks_exact(d.channels).flat_map(|f| [f[0], f[1]]).collect() } else { chunk.iter().flat_map(|&s| [s, s]).collect() };
        st.want(true, mode);
        st.feed(&stereo, sr);
        while let Some((win, n_emit, m)) = st.next_window() {
            runs += 1;
            for fr in infer(&mut sess, m, win, n_emit).expect("infer") {
                write!(f, "{:.4}", n_frames as f64 * sp.frame as f64 / sp.sr as f64).unwrap();
                for v in fr.iter() {
                    write!(f, ",{:.3}", v).unwrap();
                }
                writeln!(f).unwrap();
                n_frames += 1;
            }
        }
    }
    eprintln!("{} frames, {} inferences, {:.1} ms each", n_frames, runs, t0.elapsed().as_secs_f64() * 1000.0 / runs.max(1) as f64);
}
