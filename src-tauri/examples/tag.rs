//! Diagnostic: run YAMNet on a file through the same tagger state the app uses.
//! Usage: `cargo run --example tag -- <file>` (models from src-tauri/models).

use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Duration;

fn main() {
    let path = std::env::args().nth(1).expect("usage: tag <file>");
    let d = re_minimeter_lib::audio::decode::decode(&path, 30.0).expect("decode");
    let dir = re_minimeter_lib::audio::tagger::model_dir(None).expect("models dir (run scripts/fetch_models.py)");
    println!("models: {}", dir.display());
    let state = Arc::new(Mutex::new(re_minimeter_lib::audio::tagger::TaggerState::new()));
    {
        let mut s = state.lock();
        s.enabled = true;
        s.interval = Duration::from_millis(100);
    }
    re_minimeter_lib::audio::tagger::start(state.clone(), Some(dir));
    // wait for the model
    for _ in 0..200 {
        std::thread::sleep(Duration::from_millis(50));
        let s = state.lock();
        if s.status.available || s.status.error.is_some() {
            break;
        }
    }
    if let Some(e) = &state.lock().status.error {
        println!("ERROR: {e}");
        return;
    }
    // feed in 1 s chunks as stereo interleaved, let the thread tag each second
    let ch = d.channels;
    let frames = d.frames();
    let per = d.sample_rate as usize;
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
        std::thread::sleep(Duration::from_millis(180));
        pos = end;
    }
    std::thread::sleep(Duration::from_millis(300));
    let s = state.lock();
    println!("inference {:.1} ms/patch, {} tags", s.status.last_ms, s.tags.len());
    for t in s.tags_since(0) {
        let top: Vec<String> = t.top.iter().map(|(_, n, sc)| format!("{n} {:.0}%", sc * 100.0)).collect();
        println!("t={:5.1}s  {}", t.t, top.join(" | "));
    }
}
