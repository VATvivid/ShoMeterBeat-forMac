mod audio;

use audio::{Ctl, RecCtl, Shared, Status};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::State;

pub struct Engine(pub Arc<Shared>);

/// Latest analysis frame as a packed little-endian f32 buffer (see `audio/frame.rs`).
#[tauri::command]
fn frame(engine: State<Engine>) -> tauri::ipc::Response {
    tauri::ipc::Response::new(engine.0.frame.lock().pack())
}

#[tauri::command]
fn list_devices() -> Vec<audio::capture::DeviceEntry> {
    audio::capture::list_devices()
}

#[tauri::command]
fn set_device(engine: State<Engine>, name: Option<String>, kind: Option<audio::capture::Kind>) {
    engine.0.send(Ctl::SetDevice(name.filter(|n| !n.is_empty()), kind.unwrap_or_default()));
}

#[tauri::command]
fn reset_loudness(engine: State<Engine>) {
    engine.0.reset_loudness.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn status(engine: State<Engine>) -> Status {
    engine.0.status.lock().clone()
}

// ---- recording ---------------------------------------------------------------

#[tauri::command]
fn rec_start(engine: State<Engine>) -> Result<(), String> {
    if !engine.0.status.lock().running {
        return Err("캡처 중이 아닙니다".into());
    }
    let mut s = engine.0.rec.lock();
    if s.info.recording {
        return Err("이미 녹음 중입니다".into());
    }
    s.finished = None;
    s.error = None;
    s.pending = Some(RecCtl::Start);
    Ok(())
}

/// Stops the recording and returns the finished temp file path (waits briefly for the
/// analysis thread to finalize the WAV).
#[tauri::command]
fn rec_stop(engine: State<Engine>) -> Result<String, String> {
    engine.0.rec.lock().pending = Some(RecCtl::Stop);
    for _ in 0..200 {
        std::thread::sleep(std::time::Duration::from_millis(10));
        let mut s = engine.0.rec.lock();
        if let Some(e) = s.error.take() {
            return Err(e);
        }
        if let Some(p) = s.finished.take() {
            return Ok(p.display().to_string());
        }
    }
    Err("녹음 파일을 닫지 못했습니다".into())
}

#[tauri::command]
fn rec_save(src: String, dst: String) -> Result<(), String> {
    audio::recorder::save_to(std::path::Path::new(&src), std::path::Path::new(&dst))
}

#[tauri::command]
fn rec_discard(src: String) {
    let _ = std::fs::remove_file(src);
}

#[tauri::command]
fn rec_default_name() -> String {
    audio::recorder::default_name()
}

#[tauri::command]
fn rec_info(engine: State<Engine>) -> audio::recorder::RecInfo {
    engine.0.rec.lock().info.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).try_init();
    let shared = Shared::new();
    audio::start(shared.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Engine(shared))
        .invoke_handler(tauri::generate_handler![
            frame, list_devices, set_device, reset_loudness, status,
            rec_start, rec_stop, rec_save, rec_discard, rec_default_name, rec_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running re-minimeter");
}
