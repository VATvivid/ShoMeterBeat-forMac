mod audio;

use audio::{Ctl, Mode, RecCtl, Shared, Status};
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
fn set_source(engine: State<Engine>, mode: Option<Mode>, name: Option<String>) {
    engine.0.send(Ctl::SetSource(mode.unwrap_or_default(), name.filter(|n| !n.is_empty())));
}

// ---- DAW plugin install --------------------------------------------------------

const PLUGIN_NAME: &str = "re-minimeter Send";

fn plugin_source_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(r) = app.path().resource_dir() {
        candidates.push(r.join("plugins"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            candidates.push(d.join("plugins"));
            candidates.push(d.join("resources").join("plugins"));
        }
    }
    candidates.push(std::path::PathBuf::from("src-tauri").join("plugins"));
    candidates.push(std::path::PathBuf::from("plugins"));
    candidates.into_iter().find(|p| p.join(format!("{PLUGIN_NAME}.clap")).exists())
}

fn copy_dir(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let t = dst.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &t)?;
        } else {
            std::fs::copy(e.path(), t)?;
        }
    }
    Ok(())
}

/// Copies the bundled CLAP/VST3 plugin into the per-user common plugin folders
/// (no admin needed). Returns the destination paths.
#[tauri::command]
fn install_plugins(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let src = plugin_source_dir(&app).ok_or("번들된 플러그인 파일을 찾을 수 없습니다 (plugins/ 폴더)")?;
    let local = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA 없음")?;
    let common = std::path::Path::new(&local).join("Programs").join("Common");
    let mut done = Vec::new();
    let clap_dst = common.join("CLAP").join(format!("{PLUGIN_NAME}.clap"));
    std::fs::create_dir_all(clap_dst.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::copy(src.join(format!("{PLUGIN_NAME}.clap")), &clap_dst).map_err(|e| format!("CLAP 복사 실패: {e}"))?;
    done.push(clap_dst.display().to_string());
    let vst_src = src.join(format!("{PLUGIN_NAME}.vst3"));
    if vst_src.exists() {
        let vst_dst = common.join("VST3").join(format!("{PLUGIN_NAME}.vst3"));
        copy_dir(&vst_src, &vst_dst).map_err(|e| format!("VST3 복사 실패: {e}"))?;
        done.push(vst_dst.display().to_string());
    }
    Ok(done)
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

// ---- reference spectrum --------------------------------------------------------

/// Average spectrum (dB, 256 log points) of a WAV file, for the Spectrum overlay.
/// Reads up to 120 s. Supports PCM 8/16/24/32-bit and float WAV (hound).
#[tauri::command]
fn analyze_reference(path: String) -> Result<Vec<f32>, String> {
    let mut r = hound::WavReader::open(&path).map_err(|e| format!("WAV 열기 실패: {e}"))?;
    let spec = r.spec();
    let ch = spec.channels.max(1) as usize;
    let max_frames = 120 * spec.sample_rate as usize;
    let mut mono: Vec<f32> = Vec::new();
    let mut acc = 0.0f32;
    let mut k = 0usize;
    let mut push = |s: f32, mono: &mut Vec<f32>| {
        acc += s;
        k += 1;
        if k == ch {
            mono.push(acc / ch as f32);
            acc = 0.0;
            k = 0;
        }
    };
    match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Float, _) => {
            for s in r.samples::<f32>() {
                push(s.map_err(|e| e.to_string())?, &mut mono);
                if mono.len() >= max_frames { break; }
            }
        }
        (hound::SampleFormat::Int, bits) => {
            let scale = 1.0 / ((1u64 << (bits as u64 - 1)) as f32);
            for s in r.samples::<i32>() {
                push(s.map_err(|e| e.to_string())? as f32 * scale, &mut mono);
                if mono.len() >= max_frames { break; }
            }
        }
    }
    if mono.len() < 8192 {
        return Err("파일이 너무 짧습니다 (0.2초 이상 필요)".into());
    }
    Ok(audio::analyzer::reference_spectrum(&mono, spec.sample_rate))
}

// ---- waveform history ----------------------------------------------------------

/// Min/max envelope of the last `seconds` (see `audio/wave.rs` for the layout).
#[tauri::command]
fn wave_overview(engine: State<Engine>, seconds: f32) -> tauri::ipc::Response {
    let g = engine.0.wave.lock();
    tauri::ipc::Response::new(match g.as_ref() {
        Some(w) => w.overview(seconds),
        None => Vec::new(),
    })
}

/// Exports frames [start, end) of the history to a 32-bit float WAV at `dst`.
#[tauri::command]
fn wave_export(engine: State<Engine>, start: f64, end: f64, dst: String) -> Result<f64, String> {
    let g = engine.0.wave.lock();
    let w = g.as_ref().ok_or("아직 캡처 중이 아닙니다")?;
    w.export(start.max(0.0) as u64, end.max(0.0) as u64, std::path::Path::new(&dst)).map(|n| n as f64)
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
            frame, list_devices, set_source, reset_loudness, status, install_plugins,
            rec_start, rec_stop, rec_save, rec_discard, rec_default_name, rec_info,
            wave_overview, wave_export, analyze_reference
        ])
        .run(tauri::generate_context!())
        .expect("error while running re-minimeter");
}
