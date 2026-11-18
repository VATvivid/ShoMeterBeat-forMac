//! The one ONNX Runtime environment of the process (ort allows only one): the AI tagger and the
//! piano transcriber share it. ONNX Runtime is loaded at run time from models/onnxruntime.dll.

use ort::environment::Environment;
use parking_lot::Mutex;
use std::path::Path;

static ENV: Mutex<Option<Environment>> = Mutex::new(None);

/// The shared environment, created on first use from `dir/onnxruntime.dll`.
pub fn get(dir: &Path) -> Result<Environment, String> {
    let mut g = ENV.lock();
    if let Some(e) = g.as_ref() {
        return Ok(e.clone());
    }
    let dll = dir.join("onnxruntime.dll");
    let env = ort::init_from(&dll)
        .map_err(|e| format!("onnxruntime.dll 로드 실패 ({}): {e}", dll.display()))?
        .with_name("ShowMeterBeat")
        .build()
        .map_err(|e| format!("ONNX Runtime 초기화 실패: {e}"))?;
    *g = Some(env.clone());
    Ok(env)
}
