//! Diagnostic: run the Piano's melody salience (melody.rs via the Analyzer) over a file
//! and print the strongest candidates every 100 ms, plus a salience histogram.
//! Usage: `cargo run --release --example melody -- <file> [max_secs]`

use showmeterbeat_lib::audio::analyzer::{Analyzer, FFT_N};
use showmeterbeat_lib::audio::frame::N_MELODY;

fn note(hz: f32) -> String {
    if hz <= 0.0 {
        return "—".into();
    }
    const N: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    let m = (69.0 + 12.0 * (hz / 440.0).log2()).round() as i32;
    format!("{}{}", N[(m.rem_euclid(12)) as usize], m / 12 - 1)
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: melody <file> [max_secs]");
    let max_secs: f32 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(60.0);
    let d = showmeterbeat_lib::audio::decode::decode(&path, max_secs).expect("decode");
    let sr = d.sample_rate;
    let mut a = Analyzer::new(sr);
    let hop = (sr as usize / 10) * d.channels.max(1); // 100 ms of interleaved samples
    let mut fed = 0usize;
    let mut hist = [0usize; 10];
    let mut n = 0usize;
    println!("{} Hz x{} {:.1}s", sr, d.channels, d.frames() as f32 / sr as f32);
    for chunk in d.samples.chunks(hop) {
        // feed as stereo interleaved (the analyzer expects L,R pairs)
        let stereo: Vec<f32> = if d.channels >= 2 { chunk.chunks_exact(d.channels).flat_map(|f| [f[0], f[1]]).collect() } else { chunk.iter().flat_map(|&s| [s, s]).collect() };
        a.feed(&stereo);
        fed += stereo.len() / 2;
        if fed < FFT_N {
            continue;
        }
        let f = a.snapshot();
        let t = fed as f32 / sr as f32;
        let m = &f.melody;
        let sal = m[1];
        hist[((sal * 10.0) as usize).min(9)] += 1;
        n += 1;
        let cands: Vec<String> = (0..N_MELODY).filter(|i| m[2 * i] > 0.0).map(|i| format!("{:>4} {:6.1}Hz {:.2}", note(m[2 * i]), m[2 * i], m[2 * i + 1])).collect();
        println!("{t:6.1}s rms {:6.1} dB | {}", f.rms[0], cands.join(" | "));
    }
    println!("salience histogram (top candidate, {n} frames):");
    for (i, c) in hist.iter().enumerate() {
        println!("  {:.1}–{:.1}: {}", i as f32 / 10.0, (i + 1) as f32 / 10.0, c);
    }
}
