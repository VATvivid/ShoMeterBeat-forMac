//! Diagnostic: run the Player's offline file analysis from the command line.
//! Usage: `cargo run --example analyze -- <file> [prior_bpm]` (no prior = automatic)

fn main() {
    let path = std::env::args().nth(1).expect("usage: analyze <file> [prior_bpm]");
    let prior: Option<f32> = std::env::args().nth(2).and_then(|s| s.parse().ok()).filter(|b: &f32| *b > 0.0);
    let d = showmeterbeat_lib::audio::decode::decode(&path, 600.0).expect("decode");
    println!("{} Hz x{} {:.1}s", d.sample_rate, d.channels, d.frames() as f32 / d.sample_rate as f32);
    let mono = d.mono();
    let on = showmeterbeat_lib::audio::tempo::onset_columns(&mono, d.sample_rate);
    let t = showmeterbeat_lib::audio::tempo::estimate(&on, prior);
    let n = on.flux.len();
    let mean = on.flux.iter().sum::<f32>() / n as f32;
    let max = on.flux.iter().cloned().fold(0.0f32, f32::max);
    println!("flux cols {} mean {:.3} max {:.3} first {:?}", n, mean, max, &on.flux[200.min(n)..210.min(n)]);
    println!("BPM {:.1}  confidence {:.0}%  agreement {:.0}%  (prior {})", t.bpm, t.confidence * 100.0, t.agreement * 100.0, prior.map(|p| p.to_string()).unwrap_or_else(|| "auto".into()));
    println!("trace: {}", t.trace.iter().map(|b| format!("{:.0}", b)).collect::<Vec<_>>().join(" "));
    for s in showmeterbeat_lib::audio::tempo::segments(&on, prior) {
        println!("segment {:.1}–{:.1}s  {:.1} BPM  conf {:.0}%", s.t0, s.t1, s.bpm, s.confidence * 100.0);
    }
}
