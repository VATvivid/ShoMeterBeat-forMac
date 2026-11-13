//! Diagnostic: run the Punch meter offline over files (for calibrating the scale).
//! Usage: `cargo run --release --example punch -- <file-or-dir> [...]`
//! Prints one line per hit: punch dB · attack ms · flash · sparkle/spread/width/tail · peak dBFS.

use showmeterbeat_lib::audio::punch::PunchMeter;
use std::path::{Path, PathBuf};

fn collect(p: &Path, out: &mut Vec<PathBuf>) {
    if p.is_dir() {
        let mut v: Vec<PathBuf> = std::fs::read_dir(p).unwrap().filter_map(|e| e.ok().map(|e| e.path())).collect();
        v.sort();
        for c in v {
            collect(&c, out);
        }
    } else if matches!(p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("wav" | "flac" | "mp3" | "ogg" | "aif" | "aiff")) {
        out.push(p.to_path_buf());
    }
}

fn main() {
    let mut files = Vec::new();
    for a in std::env::args().skip(1) {
        collect(Path::new(&a), &mut files);
    }
    if files.is_empty() {
        eprintln!("usage: punch <file-or-dir> [...]");
        return;
    }
    println!("{:<52} {:>7} {:>6} {:>6} {:>5} {:>5} {:>5} {:>5} {:>5} {:>7}", "file", "punch", "body", "attack", "flash", "spark", "sprd", "width", "tail", "peak");
    for f in &files {
        let d = match showmeterbeat_lib::audio::decode::decode(f.to_str().unwrap(), 30.0) {
            Ok(d) => d,
            Err(e) => {
                println!("{:<52} decode error: {e}", f.file_name().unwrap().to_string_lossy());
                continue;
            }
        };
        let sr = d.sample_rate;
        let stereo: Vec<f32> = if d.channels >= 2 {
            d.samples.chunks_exact(d.channels).flat_map(|fr| [fr[0], fr[1]]).collect()
        } else {
            d.samples.iter().flat_map(|&s| [s, s]).collect()
        };
        let mut m = PunchMeter::new(sr);
        let pad = vec![0.0f32; sr as usize]; // 0.5 s stereo silence
        m.feed(&pad);
        m.feed(&stereo);
        m.feed(&pad);
        m.feed(&pad);
        let name = f.file_name().unwrap().to_string_lossy();
        let hits = m.hits_since(0);
        if hits.is_empty() {
            println!("{:<52} (no hit)  momentary max? pm95 {:.1}", name, m.stats.pm95);
        }
        for (i, h) in hits.iter().enumerate() {
            println!(
                "{:<52} {:>7.1} {:>7.1} {:>6.0} {:>5.0} {:>5.2} {:>5.2} {:>5.2} {:>5.2} {:>7.1}{}",
                if i == 0 { name.to_string() } else { format!("  +hit{} @{:.2}s", i + 1, h.t - 0.5) },
                h.punch_db, h.body_db, h.attack_ms, h.flash, h.sparkle, h.spread, h.width, h.tail, h.peak_db,
                if i == 0 && hits.len() > 1 { format!("  ({} hits)", hits.len()) } else { String::new() }
            );
        }
    }
}
