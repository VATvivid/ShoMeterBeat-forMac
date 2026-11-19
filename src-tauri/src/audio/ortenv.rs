//! The one ONNX Runtime environment of the process (ort allows only one): the AI tagger and the
//! piano transcriber share it. ONNX Runtime is loaded at run time from the shared library in
//! models/ — `onnxruntime.dll` on Windows, `libonnxruntime.dylib` on macOS, `libonnxruntime.so`
//! elsewhere.

use ort::environment::Environment;
use parking_lot::Mutex;
use std::path::Path;

static ENV: Mutex<Option<Environment>> = Mutex::new(None);

/// Platform file name of the ONNX Runtime shared library bundled under models/.
pub fn ort_lib_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") {
        "libonnxruntime.dylib"
    } else {
        "libonnxruntime.so"
    }
}

/// The shared environment, created on first use from the platform ONNX Runtime library in `dir`.
pub fn get(dir: &Path) -> Result<Environment, String> {
    let mut g = ENV.lock();
    if let Some(e) = g.as_ref() {
        return Ok(e.clone());
    }
    let dll = dir.join(ort_lib_name());
    let env = ort::init_from(&dll)
        .map_err(|e| format!("ONNX Runtime 로드 실패 ({}): {e}", dll.display()))?
        .with_name("ShowMeterBeat")
        .build()
        .map_err(|e| format!("ONNX Runtime 초기화 실패: {e}"))?;
    *g = Some(env.clone());
    Ok(env)
}
