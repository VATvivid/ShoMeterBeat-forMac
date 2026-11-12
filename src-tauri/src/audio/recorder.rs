//! WAV recording of the captured stereo stream (32-bit float). The analysis
//! thread feeds every drained chunk while a recording is active; the file is
//! written to a temp folder and moved to the user's chosen path on save.

use hound::{SampleFormat, WavSpec, WavWriter};
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

pub struct Recorder {
    writer: WavWriter<BufWriter<File>>,
    pub path: PathBuf,
    pub frames: u64,
    sample_rate: u32,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct RecInfo {
    pub recording: bool,
    pub seconds: f32,
    pub path: Option<String>,
}

pub fn temp_dir() -> PathBuf {
    let d = std::env::temp_dir().join("re-minimeter");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn default_name() -> String {
    // Local-time stamp without pulling in chrono: use the system clock via `std`.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("re-minimeter_{secs}.wav")
}

impl Recorder {
    pub fn start(sample_rate: u32) -> Result<Self, String> {
        let path = temp_dir().join(default_name());
        let spec = WavSpec { channels: 2, sample_rate, bits_per_sample: 32, sample_format: SampleFormat::Float };
        let writer = WavWriter::create(&path, spec).map_err(|e| e.to_string())?;
        Ok(Self { writer, path, frames: 0, sample_rate })
    }

    pub fn write(&mut self, stereo: &[f32]) {
        for s in stereo {
            let _ = self.writer.write_sample(*s);
        }
        self.frames += (stereo.len() / 2) as u64;
    }

    pub fn seconds(&self) -> f32 {
        self.frames as f32 / self.sample_rate.max(1) as f32
    }

    pub fn finish(self) -> Result<PathBuf, String> {
        self.writer.finalize().map_err(|e| e.to_string())?;
        Ok(self.path)
    }
}

/// Move the finished temp file to `dst` (rename, falling back to copy+delete across drives).
pub fn save_to(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(p) = dst.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dst).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(src);
    Ok(())
}
