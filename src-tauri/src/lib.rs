mod audio;

use audio::{Ctl, Shared, Status};
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
fn list_devices() -> Vec<String> {
    audio::capture::list_devices()
}

#[tauri::command]
fn set_device(engine: State<Engine>, name: Option<String>) {
    engine.0.send(Ctl::SetDevice(name.filter(|n| !n.is_empty())));
}

#[tauri::command]
fn reset_loudness(engine: State<Engine>) {
    engine.0.reset_loudness.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn status(engine: State<Engine>) -> Status {
    engine.0.status.lock().clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).try_init();
    let shared = Shared::new();
    audio::start(shared.clone());

    tauri::Builder::default()
        .manage(Engine(shared))
        .invoke_handler(tauri::generate_handler![frame, list_devices, set_device, reset_loudness, status])
        .run(tauri::generate_context!())
        .expect("error while running re-minimeter");
}
