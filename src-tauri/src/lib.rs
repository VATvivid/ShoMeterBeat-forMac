pub mod audio;

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
    install_plugins_from(&src, &std::path::Path::new(&local).join("Programs").join("Common"))
}

/// True when `dst` already holds exactly the bytes of `src` (so a locked, identical plugin
/// — a DAW has it loaded — counts as installed and is left alone).
fn same_file(src: &std::path::Path, dst: &std::path::Path) -> bool {
    match (std::fs::metadata(src), std::fs::metadata(dst)) {
        (Ok(a), Ok(b)) if a.len() == b.len() => matches!((std::fs::read(src), std::fs::read(dst)), (Ok(x), Ok(y)) if x == y),
        _ => false,
    }
}

/// Copies `src` over `dst` unless it is already identical. A copy that fails because the
/// destination is in use (another process has it open) is reported as a warning, not an
/// error, when a file already exists there: the DAW keeps its loaded copy, the next
/// install (DAW closed) replaces it.
fn copy_plugin_file(src: &std::path::Path, dst: &std::path::Path, warnings: &mut Vec<String>) -> Result<(), String> {
    if same_file(src, dst) {
        return Ok(());
    }
    if let Some(p) = dst.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    match std::fs::copy(src, dst) {
        Ok(_) => Ok(()),
        Err(e) if dst.exists() && e.raw_os_error() == Some(32) => {
            warnings.push(format!("{} 사용 중 — 기존 파일 유지 (DAW를 닫고 다시 설치하면 갱신)", dst.display()));
            Ok(())
        }
        Err(e) => Err(format!("{} 복사 실패: {e}", dst.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())),
    }
}

fn copy_plugin_dir(src: &std::path::Path, dst: &std::path::Path, warnings: &mut Vec<String>) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let t = dst.join(e.file_name());
        if e.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_plugin_dir(&e.path(), &t, warnings)?;
        } else {
            copy_plugin_file(&e.path(), &t, warnings)?;
        }
    }
    Ok(())
}

/// Installs the bundled CLAP + VST3 under `common` (`%LOCALAPPDATA%\Programs\Common`).
/// Returns the destination paths; entries may carry a trailing note when a file was in use.
fn install_plugins_from(src: &std::path::Path, common: &std::path::Path) -> Result<Vec<String>, String> {
    let mut done = Vec::new();
    let mut warnings = Vec::new();
    let clap_dst = common.join("CLAP").join(format!("{PLUGIN_NAME}.clap"));
    copy_plugin_file(&src.join(format!("{PLUGIN_NAME}.clap")), &clap_dst, &mut warnings)?;
    done.push(clap_dst.display().to_string());
    let vst_src = src.join(format!("{PLUGIN_NAME}.vst3"));
    if vst_src.exists() {
        let vst_dst = common.join("VST3").join(format!("{PLUGIN_NAME}.vst3"));
        copy_plugin_dir(&vst_src, &vst_dst, &mut warnings)?;
        done.push(vst_dst.display().to_string());
    }
    done.extend(warnings.into_iter().map(|w| format!("※ {w}")));
    Ok(done)
}

#[cfg(test)]
mod plugin_install_tests {
    use super::*;

    #[test]
    fn identical_files_are_skipped_and_changed_ones_copied() {
        let base = std::env::temp_dir().join(format!("rm-plugin-test-{}", std::process::id()));
        let src = base.join("src");
        let common = base.join("common");
        std::fs::create_dir_all(src.join(format!("{PLUGIN_NAME}.vst3")).join("Contents")).unwrap();
        std::fs::write(src.join(format!("{PLUGIN_NAME}.clap")), b"clap-v1").unwrap();
        std::fs::write(src.join(format!("{PLUGIN_NAME}.vst3")).join("Contents").join("x.vst3"), b"vst-v1").unwrap();
        let done = install_plugins_from(&src, &common).unwrap();
        assert_eq!(done.len(), 2, "{done:?}");
        assert_eq!(std::fs::read(common.join("CLAP").join(format!("{PLUGIN_NAME}.clap"))).unwrap(), b"clap-v1");
        // second run: identical → still Ok, nothing to report
        let again = install_plugins_from(&src, &common).unwrap();
        assert_eq!(again.len(), 2);
        // changed source → copied
        std::fs::write(src.join(format!("{PLUGIN_NAME}.clap")), b"clap-v2").unwrap();
        install_plugins_from(&src, &common).unwrap();
        assert_eq!(std::fs::read(common.join("CLAP").join(format!("{PLUGIN_NAME}.clap"))).unwrap(), b"clap-v2");
        let _ = std::fs::remove_dir_all(&base);
    }
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

/// Average spectrum (dB, 256 log points) of an audio file (first 120 s), for the
/// Spectrum overlay. WAV/AIFF/FLAC/MP3/OGG/AAC via symphonia.
#[tauri::command]
fn analyze_reference(path: String) -> Result<Vec<f32>, String> {
    let d = audio::decode::decode(&path, 120.0)?;
    let mono = d.mono();
    if mono.len() < 8192 {
        return Err("파일이 너무 짧습니다 (0.2초 이상 필요)".into());
    }
    Ok(audio::analyzer::reference_spectrum(&mono, d.sample_rate))
}

// ---- player: decode + whole-file analysis -------------------------------------

/// Decoded PCM for the Player module (≤ 10 min): f32 header [4242, sr, channels, frames]
/// followed by interleaved samples.
#[tauri::command]
fn load_audio(path: String) -> Result<tauri::ipc::Response, String> {
    let d = audio::decode::decode(&path, 600.0)?;
    let frames = d.frames();
    let mut bytes = Vec::with_capacity((4 + d.samples.len()) * 4);
    for x in [4242.0f32, d.sample_rate as f32, d.channels as f32, frames as f32] {
        bytes.extend_from_slice(&x.to_le_bytes());
    }
    for x in &d.samples {
        bytes.extend_from_slice(&x.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(serde::Serialize)]
struct FileAnalysis {
    duration: f32,
    sample_rate: u32,
    channels: usize,
    lufs_i: f32,
    lra: f32,
    true_peak: f32,
    sample_peak: f32,
    rms: f32,
    crest: f32,
    bpm: f32,
    bpm_confidence: f32,
    bpm_agreement: f32,
    /// Tempo over time (one entry for a steady file, more when the tempo changes).
    tempo_segments: Vec<audio::tempo::TempoSeg>,
}

/// Whole-file loudness / peak / dynamics / tempo (≤ 10 min analysed).
#[tauri::command]
fn analyze_file(path: String, prior_bpm: Option<f32>) -> Result<FileAnalysis, String> {
    use ebur128::{EbuR128, Mode};
    let d = audio::decode::decode(&path, 600.0)?;
    let ch = d.channels as u32;
    let mut e = EbuR128::new(ch, d.sample_rate, Mode::I | Mode::LRA | Mode::TRUE_PEAK).map_err(|e| e.to_string())?;
    for chunk in d.samples.chunks(48_000 * d.channels) {
        e.add_frames_f32(chunk).map_err(|e| e.to_string())?;
    }
    let db = |v: Result<f64, ebur128::Error>| v.ok().filter(|x| x.is_finite()).map(|x| x as f32).unwrap_or(-120.0);
    let lin_db = |v: Result<f64, ebur128::Error>| v.ok().filter(|x| *x > 1e-9).map(|x| 20.0 * (x as f32).log10()).unwrap_or(-120.0);
    let mut tp = -120.0f32;
    for c in 0..ch {
        tp = tp.max(lin_db(e.true_peak(c)));
    }
    let peak = d.samples.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    let rms = (d.samples.iter().map(|v| v * v).sum::<f32>() / d.samples.len().max(1) as f32).sqrt();
    let peak_db = if peak > 1e-9 { 20.0 * peak.log10() } else { -120.0 };
    let rms_db = if rms > 1e-9 { 20.0 * rms.log10() } else { -120.0 };
    let mono = d.mono();
    let flux = audio::tempo::flux_columns(&mono, d.sample_rate);
    let t = audio::tempo::estimate(&flux, prior_bpm.unwrap_or(110.0));
    Ok(FileAnalysis {
        duration: d.frames() as f32 / d.sample_rate as f32,
        sample_rate: d.sample_rate,
        channels: d.channels,
        lufs_i: db(e.loudness_global()),
        lra: e.loudness_range().ok().filter(|x| x.is_finite()).map(|x| x as f32).unwrap_or(0.0),
        true_peak: tp,
        sample_peak: peak_db,
        rms: rms_db,
        crest: peak_db - rms_db,
        bpm: t.bpm,
        bpm_confidence: t.confidence,
        bpm_agreement: t.agreement,
        tempo_segments: audio::tempo::segments(&flux, prior_bpm.unwrap_or(110.0)),
    })
}

// ---- AI tags (YAMNet) ------------------------------------------------------------

#[tauri::command]
fn tags_since(engine: State<Engine>, after: f64) -> Vec<audio::tagger::Tag> {
    engine.0.tagger.lock().tags_since(after.max(0.0) as u64)
}

#[tauri::command]
fn set_tagging(engine: State<Engine>, enabled: bool, interval_ms: Option<u32>) {
    let mut t = engine.0.tagger.lock();
    t.enabled = enabled;
    if let Some(ms) = interval_ms {
        t.interval = std::time::Duration::from_millis(ms.clamp(250, 5000) as u64);
        t.status.interval_ms = ms;
    }
    t.status.enabled = enabled;
}

#[tauri::command]
fn tag_status(engine: State<Engine>) -> audio::tagger::TagStatus {
    engine.0.tagger.lock().status.clone()
}

// ---- subtitles (whisper) ----------------------------------------------------------

#[tauri::command]
fn subtitles_since(engine: State<Engine>, after: f64) -> Vec<audio::subtitle::Subtitle> {
    engine.0.subtitle.lock().subs_since(after.max(0.0) as u64)
}

#[tauri::command]
fn set_subtitles(engine: State<Engine>, enabled: bool, lang: Option<String>, model: Option<String>) {
    let mut s = engine.0.subtitle.lock();
    s.enabled = enabled;
    if let Some(l) = lang { s.lang = l.clone(); s.status.lang = l; }
    if let Some(m) = model { s.model = m.clone(); s.status.model = m; }
    s.status.enabled = enabled;
}

#[tauri::command]
fn subtitle_status(engine: State<Engine>) -> audio::subtitle::SubStatus {
    engine.0.subtitle.lock().status.clone()
}

// ---- sound events (Variation Map) ------------------------------------------------

#[tauri::command]
fn events_since(engine: State<Engine>, after: f64) -> Vec<audio::events::Event> {
    engine.0.wave.lock().as_ref().map(|w| w.events_since(after.max(0.0) as u64)).unwrap_or_default()
}

#[tauri::command]
fn set_onset_k(engine: State<Engine>, k: f32) {
    if let Some(w) = engine.0.wave.lock().as_mut() {
        w.onset_k = k.clamp(1.0, 8.0);
    }
}

// ---- punch meter (Punch module) --------------------------------------------------

#[tauri::command]
fn punch_hits_since(engine: State<Engine>, after: f64) -> Vec<audio::punch::Hit> {
    engine.0.punch.lock().as_ref().map(|p| p.hits_since(after.max(0.0) as u64)).unwrap_or_default()
}

#[tauri::command]
fn punch_status(engine: State<Engine>) -> audio::punch::PunchStats {
    engine.0.punch.lock().as_ref().map(|p| p.stats.clone()).unwrap_or_default()
}

#[tauri::command]
fn punch_reset(engine: State<Engine>) {
    if let Some(p) = engine.0.punch.lock().as_mut() {
        p.reset();
    }
}

// ---- text files (preset export / import) ----------------------------------------

#[tauri::command]
fn write_text(path: String, text: String) -> Result<(), String> {
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

// ---- windows: opacity, cross-window module drag, pop-out lifetime -------------------

#[cfg(windows)]
fn hwnd_of<W: raw_window_handle::HasWindowHandle>(w: &W) -> Option<isize> {
    use raw_window_handle::RawWindowHandle;
    match w.window_handle().ok()?.as_raw() {
        RawWindowHandle::Win32(h) => Some(h.hwnd.get()),
        _ => None,
    }
}

/// Dock as a Windows application desktop toolbar (AppBar): the strip reserves its edge of
/// the work area, so maximised windows and the taskbar's neighbours move out of its way —
/// what MiniMeters does. `edge` 0 left / 1 top / 2 right / 3 bottom, `None` removes the
/// reservation. Returns the rect the shell granted (physical px), which the window should
/// take. The monitor is the one the window is on; ABM_QUERYPOS keeps clear of other appbars.
#[tauri::command]
fn set_appbar(window: tauri::Window, edge: Option<u32>, thickness: u32) -> Result<Option<[i32; 4]>, String> {
    #[cfg(windows)]
    {
        use std::sync::atomic::{AtomicBool, Ordering};
        use windows_sys::Win32::Foundation::{HWND, RECT};
        use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
        use windows_sys::Win32::UI::Shell::{SHAppBarMessage, ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, APPBARDATA};
        static REGISTERED: AtomicBool = AtomicBool::new(false);
        let hwnd = hwnd_of(&window).ok_or("창 핸들 없음")? as HWND;
        let mut abd = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: hwnd, uCallbackMessage: 0, uEdge: 0, rc: RECT { left: 0, top: 0, right: 0, bottom: 0 }, lParam: 0 };
        unsafe {
            let Some(e) = edge else {
                if REGISTERED.swap(false, Ordering::SeqCst) {
                    SHAppBarMessage(ABM_REMOVE, &mut abd);
                }
                return Ok(None);
            };
            if !REGISTERED.swap(true, Ordering::SeqCst) {
                SHAppBarMessage(ABM_NEW, &mut abd);
            }
            let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut mi: MONITORINFO = std::mem::zeroed();
            mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(hmon, &mut mi) == 0 {
                return Err("모니터 정보를 읽지 못했습니다".into());
            }
            let t = thickness.max(1) as i32;
            let fit = |rc: &mut RECT, e: u32| match e {
                x if x == ABE_TOP => rc.bottom = rc.top + t,
                x if x == ABE_BOTTOM => rc.top = rc.bottom - t,
                x if x == ABE_LEFT => rc.right = rc.left + t,
                _ => rc.left = rc.right - t,
            };
            abd.uEdge = match e { 0 => ABE_LEFT, 1 => ABE_TOP, 2 => ABE_RIGHT, _ => ABE_BOTTOM };
            abd.rc = mi.rcMonitor;
            fit(&mut abd.rc, abd.uEdge);
            SHAppBarMessage(ABM_QUERYPOS, &mut abd); // the shell moves the rect clear of other appbars
            fit(&mut abd.rc, abd.uEdge);
            SHAppBarMessage(ABM_SETPOS, &mut abd);
            Ok(Some([abd.rc.left, abd.rc.top, abd.rc.right, abd.rc.bottom]))
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, edge, thickness);
        Ok(None)
    }
}

/// Whole-window opacity 0–1 (WS_EX_LAYERED + LWA_ALPHA). 1.0 removes the layered style
/// again so a fully opaque window pays no composition cost.
#[tauri::command]
fn set_opacity(window: tauri::Window, alpha: f32) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        let hwnd = hwnd_of(&window).ok_or("창 핸들 없음")? as windows_sys::Win32::Foundation::HWND;
        let a = alpha.clamp(0.0, 1.0);
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            if a >= 0.995 {
                SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & !(WS_EX_LAYERED as isize));
            } else {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED as isize);
                SetLayeredWindowAttributes(hwnd, 0, (a * 255.0).round() as u8, LWA_ALPHA);
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, alpha);
        Err("이 OS에서는 지원하지 않습니다".into())
    }
}

/// Payload sent to the window under the pointer while a tile is dragged across windows.
#[derive(serde::Serialize, Clone)]
struct XDrag {
    module: String,
    /// Pointer in the target window's CSS px (relative to its content area).
    x: f64,
    y: f64,
    w: u32,
    h: u32,
    from: String,
    /// Label of the window this payload is for (listeners in other windows ignore it).
    to: String,
}

/// Label of the last window that received an `rm://xdrag-over`.
struct XDragState(parking_lot::Mutex<Option<String>>);

fn screen_point(window: &tauri::Window, x: f64, y: f64) -> Result<(i32, i32), String> {
    let p = window.inner_position().map_err(|e| e.to_string())?;
    let s = window.scale_factor().map_err(|e| e.to_string())?;
    Ok((p.x + (x * s).round() as i32, p.y + (y * s).round() as i32))
}

/// Our top-level window under a screen point (respects z-order), excluding `exclude`.
fn window_at(app: &tauri::AppHandle, px: i32, py: i32, exclude: &str) -> Option<tauri::WebviewWindow> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};
        let root = unsafe { GetAncestor(WindowFromPoint(windows_sys::Win32::Foundation::POINT { x: px, y: py }), GA_ROOT) } as isize;
        if root == 0 {
            return None;
        }
        app.webview_windows().into_values().find(|w| w.label() != exclude && hwnd_of(w) == Some(root))
    }
    #[cfg(not(windows))]
    {
        let _ = (app, px, py, exclude);
        None
    }
}

fn xdrag_payload(target: &tauri::WebviewWindow, px: i32, py: i32, module: &str, w: u32, h: u32, from: &str) -> Option<XDrag> {
    let tp = target.inner_position().ok()?;
    let ts = target.scale_factor().ok()?;
    Some(XDrag { module: module.to_string(), x: (px - tp.x) as f64 / ts, y: (py - tp.y) as f64 / ts, w, h, from: from.to_string(), to: target.label().to_string() })
}

fn xdrag_leave_last(app: &tauri::AppHandle, st: &XDragState, keep: Option<&str>) {
    use tauri::{Emitter, Manager};
    let mut last = st.0.lock();
    if let Some(l) = last.as_ref() {
        if keep != Some(l.as_str()) {
            if let Some(w) = app.webview_windows().get(l) {
                let _ = w.emit_to(w.label(), "rm://xdrag-leave", ());
            }
            *last = None;
        }
    }
}

/// Pointer (CSS px of the calling window, may be outside it) moved while dragging a tile:
/// tells the window under the pointer to show a drop ghost.
#[tauri::command]
fn drag_hover(app: tauri::AppHandle, window: tauri::Window, st: State<XDragState>, module: String, x: f64, y: f64, w: u32, h: u32) -> Result<(), String> {
    use tauri::Emitter;
    let (px, py) = screen_point(&window, x, y)?;
    let target = window_at(&app, px, py, window.label());
    xdrag_leave_last(&app, &st, target.as_ref().map(|t| t.label()));
    if let Some(t) = target {
        if let Some(p) = xdrag_payload(&t, px, py, &module, w, h, window.label()) {
            let _ = t.emit_to(t.label(), "rm://xdrag-over", p);
            *st.0.lock() = Some(t.label().to_string());
        }
    }
    Ok(())
}

#[tauri::command]
fn drag_leave(app: tauri::AppHandle, st: State<XDragState>) {
    xdrag_leave_last(&app, &st, None);
}

/// Tile dropped outside its window: delivers it to the window under the pointer and
/// returns that window's label, or `None` when the pointer is over no re-minimeter window
/// (the caller then opens a new pop-out window there).
#[tauri::command]
fn drag_drop(app: tauri::AppHandle, window: tauri::Window, st: State<XDragState>, module: String, x: f64, y: f64, w: u32, h: u32) -> Result<Option<String>, String> {
    use tauri::Emitter;
    let (px, py) = screen_point(&window, x, y)?;
    let target = window_at(&app, px, py, window.label());
    xdrag_leave_last(&app, &st, None);
    let Some(t) = target else { return Ok(None) };
    let p = xdrag_payload(&t, px, py, &module, w, h, window.label()).ok_or("대상 창 위치를 읽지 못했습니다")?;
    t.emit_to(t.label(), "rm://xdrag-drop", p).map_err(|e| e.to_string())?;
    Ok(Some(t.label().to_string()))
}

/// Screen position (physical px) of a point given in the calling window's CSS px.
#[tauri::command]
fn to_screen(window: tauri::Window, x: f64, y: f64) -> Result<(i32, i32), String> {
    screen_point(&window, x, y)
}

// ---- clip folder (drag-out to DAW) -------------------------------------------------

/// Default folder for clips dragged out of the Waveform: `<Documents>\re-minimeter\clips`.
#[tauri::command]
fn default_clip_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let base = app.path().document_dir().or_else(|_| app.path().home_dir()).map_err(|e| e.to_string())?;
    Ok(base.join("re-minimeter").join("clips").display().to_string())
}

#[tauri::command]
fn ensure_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

/// Writes the drag preview image (app icon) to the temp folder and returns its path.
#[tauri::command]
fn clip_drag_icon() -> Result<String, String> {
    let dir = std::env::temp_dir().join("re-minimeter");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join("drag-icon.png");
    if !p.exists() {
        std::fs::write(&p, include_bytes!("../icons/32x32.png")).map_err(|e| e.to_string())?;
    }
    Ok(p.display().to_string())
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
        .setup({
            let shared = shared.clone();
            move |app| {
                use tauri::Manager;
                let dir = audio::tagger::model_dir(app.path().resource_dir().ok());
                audio::tagger::start(shared.tagger.clone(), dir.clone());
                let models_dir = dir.or_else(|| app.path().resource_dir().ok().map(|r| r.join("models")));
                audio::subtitle::start(shared.subtitle.clone(), models_dir);
                Ok(())
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .manage(Engine(shared))
        .manage(XDragState(parking_lot::Mutex::new(None)))
        // Closing the main window ends the app even when pop-out windows are open.
        .on_window_event(|w, e| {
            if w.label() == "main" && matches!(e, tauri::WindowEvent::Destroyed) {
                use tauri::Manager;
                w.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            frame, list_devices, set_source, reset_loudness, status, install_plugins,
            rec_start, rec_stop, rec_save, rec_discard, rec_default_name, rec_info,
            wave_overview, wave_export, analyze_reference, load_audio, analyze_file, write_text, read_text,
            events_since, set_onset_k, tags_since, set_tagging, tag_status, subtitles_since, set_subtitles, subtitle_status,
            punch_hits_since, punch_status, punch_reset,
            set_opacity, set_appbar, drag_hover, drag_leave, drag_drop, to_screen, default_clip_dir, ensure_dir, clip_drag_icon
        ])
        .run(tauri::generate_context!())
        .expect("error while running re-minimeter");
}
