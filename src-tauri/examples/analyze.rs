//! Diagnostic: run the Player's offline file analysis from the command line.
//! Usage: `cargo run --example analyze -- <file> [prior_bpm]`

fn main() {
    let path = std::env::args().nth(1).expect("usage: analyze <file> [prior_bpm]");
    let prior: f32 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(110.0);
    let d = showmeterbeat_lib::audio::decode::decode(&path, 600.0).expect("decode");
    println!("{} Hz x{} {:.1}s", d.sample_rate, d.channels, d.frames() as f32 / d.sample_rate as f32);
    let mono = d.mono();
    let flux = showmeterbeat_lib::audio::tempo::flux_columns(&mono, d.sample_rate);
    let t = showmeterbeat_lib::audio::tempo::estimate(&flux, prior);
    let n = flux.len();
    let mean = flux.iter().sum::<f32>() / n as f32;
    let max = flux.iter().cloned().fold(0.0f32, f32::max);
    println!("flux cols {} mean {:.3} max {:.3} first {:?}", n, mean, max, &flux[200..210]);
    println!("BPM {:.1}  confidence {:.0}%  agreement {:.0}%", t.bpm, t.confidence * 100.0, t.agreement * 100.0);
    println!("trace: {}", t.trace.iter().map(|b| format!("{:.0}", b)).collect::<Vec<_>>().join(" "));
}
