//! The one ONNX Runtime environment of the process (ort allows only one): the AI tagger and the
//! piano transcriber share it.
//! - Windows: ONNX Runtime is loaded at run time from `models/onnxruntime.dll` (ort `load-dynamic`).
//! - macOS/Linux: the ort crate links its own prebuilt ONNX Runtime at build time (`download-binaries`),
//!   so there is no library file to find — `dir` is unused there.

use ort::environment::Environment;
use parking_lot::Mutex;
use std::path::Path;

static ENV: Mutex<Option<Environment>> = Mutex::new(None);

/// The shared environment, created on first use.
pub fn get(dir: &Path) -> Result<Environment, String> {
    let mut g = ENV.lock();
    if let Some(e) = g.as_ref() {
        return Ok(e.clone());
    }
    #[cfg(windows)]
    let builder = {
        let dll = dir.join("onnxruntime.dll");
        ort::init_from(&dll).map_err(|e| format!("ONNX Runtime 로드 실패 ({}): {e}", dll.display()))?
    };
    #[cfg(not(windows))]
    let builder = {
        let _ = dir;
        ort::init()
    };
    let env = builder
        .with_name("ShowMeterBeat")
        .build()
        .map_err(|e| format!("ONNX Runtime 초기화 실패: {e}"))?;
    *g = Some(env.clone());
    Ok(env)
}
