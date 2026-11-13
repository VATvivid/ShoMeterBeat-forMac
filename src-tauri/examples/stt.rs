//! Diagnostic: run the subtitle pipeline (gate + whisper) on a file.
//! Usage: `cargo run --release --features subtitles --example stt -- <file> [lang] [model]`

use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Duration;

fn main() {
    let path = std::env::args().nth(1).expect("usage: stt <file> [lang] [model]");
    let lang = std::env::args().nth(2).unwrap_or_else(|| "auto".into());
    let model = std::env::args().nth(3).unwrap_or_else(|| "base".into());
    let d = showmeterbeat_lib::audio::decode::decode(&path, 60.0).expect("decode");
    let state = Arc::new(Mutex::new(showmeterbeat_lib::audio::subtitle::SubtitleState::new()));
    {
        let mut s = state.lock();
        s.enabled = true;
        s.lang = lang;
        s.model = model;
    }
    showmeterbeat_lib::audio::subtitle::start(state.clone(), Some(std::path::PathBuf::from("models")));
    let ch = d.channels;
    let frames = d.frames();
    let per = d.sample_rate as usize / 10; // 100 ms chunks, fed faster than real time
    let mut pos = 0;
    while pos < frames {
        let end = (pos + per).min(frames);
        let mut stereo = Vec::with_capacity((end - pos) * 2);
        for i in pos..end {
            let l = d.samples[i * ch];
            let r = if ch > 1 { d.samples[i * ch + 1] } else { l };
            stereo.push(l);
            stereo.push(r);
        }
        state.lock().feed(&stereo, d.sample_rate);
        pos = end;
    }
    // trailing silence to flush the last utterance
    state.lock().feed(&vec![0.0; d.sample_rate as usize * 2], d.sample_rate);
    // wait for the worker (model load + transcription)
    for _ in 0..600 {
        std::thread::sleep(Duration::from_millis(100));
        let s = state.lock();
        if s.status.error.is_some() {
            println!("ERROR: {}", s.status.error.as_ref().unwrap());
            return;
        }
        if s.status.loaded && s.status.queue == 0 && !s.subs.is_empty() && s.status.last_ms > 0.0 {
            // give one more second for a possible second utterance
            drop(s);
            std::thread::sleep(Duration::from_secs(2));
            break;
        }
    }
    let s = state.lock();
    println!("model {} loaded={} last {:.0} ms, {} subtitles", s.status.model, s.status.loaded, s.status.last_ms, s.subs.len());
    for sub in s.subs_since(0) {
        println!("[{:5.1}–{:5.1}s] ({}) {}", sub.t0, sub.t1, sub.lang, sub.text);
    }
}
