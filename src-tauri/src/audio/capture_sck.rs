//! macOS system-audio capture through ScreenCaptureKit (the counterpart of the Windows WASAPI
//! loopback in capture.rs). macOS has no OS-level output loopback; SCK (macOS 13+) can deliver the
//! system audio mix as Float32 PCM. The first use prompts for Screen Recording permission (TCC) —
//! that permission covers SCK audio too — and the app must then be allowed under
//! System Settings → Privacy & Security → Screen Recording.
//!
//! Audio arrives on SCK's own thread as CMSampleBuffers; each is converted to interleaved stereo f32
//! and pushed into the same `Shared` ring the cpal path uses, so everything downstream is unchanged.

use super::Shared;
use screencapturekit::{
    output::CMSampleBuffer,
    shareable_content::SCShareableContent,
    stream::{
        configuration::SCStreamConfiguration, content_filter::SCContentFilter, output_trait::SCStreamOutputTrait,
        output_type::SCStreamOutputType, SCStream,
    },
};
use std::sync::Arc;

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 2;

/// Keeps the SCK stream alive; dropping it stops the capture.
pub struct SckStream {
    stream: SCStream,
}

impl Drop for SckStream {
    fn drop(&mut self) {
        let _ = self.stream.stop_capture();
    }
}

struct AudioOut {
    shared: Arc<Shared>,
}

impl SCStreamOutputTrait for AudioOut {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
        if of_type != SCStreamOutputType::Audio {
            return;
        }
        let Ok(list) = sample.get_audio_buffer_list() else { return };
        let bufs: Vec<_> = list.iter().collect();
        let as_f32 = |bytes: &[u8]| -> Vec<f32> {
            bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
        };
        let mut stereo: Vec<f32> = Vec::new();
        match bufs.len() {
            0 => return,
            1 => {
                // one buffer: interleaved (number_channels ≥ 2) or mono
                let b = &bufs[0];
                let ch = b.number_channels.max(1) as usize;
                let data = as_f32(b.data());
                stereo.reserve(data.len() / ch * 2);
                for fr in data.chunks_exact(ch) {
                    let l = fr[0];
                    let r = if ch > 1 { fr[1] } else { l };
                    stereo.push(l);
                    stereo.push(r);
                }
            }
            _ => {
                // planar: one buffer per channel (SCK's default layout)
                let l = as_f32(bufs[0].data());
                let r = as_f32(bufs[1].data());
                stereo.reserve(l.len() * 2);
                for i in 0..l.len() {
                    stereo.push(l[i]);
                    stereo.push(*r.get(i).unwrap_or(&l[i]));
                }
            }
        }
        if !stereo.is_empty() {
            self.shared.ring.lock().push(&stereo);
        }
    }
}

/// Starts capturing the whole system audio mix (every display's audio, minus this process).
pub fn start(shared: Arc<Shared>) -> Result<(SckStream, u32, u16), String> {
    let content = SCShareableContent::get().map_err(|e| explain(&e.to_string()))?;
    let display = content.displays().into_iter().next().ok_or("디스플레이를 찾을 수 없습니다 (ScreenCaptureKit)")?;
    let filter = SCContentFilter::new().with_display_excluding_windows(&display, &[]);
    let config = SCStreamConfiguration::new()
        .set_captures_audio(true)
        .map_err(|e| e.to_string())?
        .set_sample_rate(SAMPLE_RATE)
        .map_err(|e| e.to_string())?
        .set_channel_count(CHANNELS as u8)
        .map_err(|e| e.to_string())?
        .set_excludes_current_process_audio(true)
        .map_err(|e| e.to_string())?
        // audio-only use: keep the (unused) video side as small and slow as SCK allows
        .set_width(2)
        .map_err(|e| e.to_string())?
        .set_height(2)
        .map_err(|e| e.to_string())?;
    let mut stream = SCStream::new(&filter, &config);
    stream.add_output_handler(AudioOut { shared }, SCStreamOutputType::Audio);
    stream.start_capture().map_err(|e| explain(&e.to_string()))?;
    log::info!("ScreenCaptureKit system-audio capture started @ {SAMPLE_RATE} Hz x{CHANNELS}");
    Ok((SckStream { stream }, SAMPLE_RATE, CHANNELS))
}

/// Turn SCK / TCC failures into something a user can act on.
fn explain(s: &str) -> String {
    let l = s.to_ascii_lowercase();
    if l.contains("permission") || l.contains("declined") || l.contains("not authorized") || l.contains("tcc") || l.contains("-3801") {
        return "시스템 소리 캡처 권한이 없습니다 — 시스템 설정 → 개인정보 보호 및 보안 → 화면 기록에서 ShowMeterBeat를 허용한 뒤 장치를 다시 선택하세요".into();
    }
    format!("시스템 소리 캡처 시작 실패 (ScreenCaptureKit): {s}")
}
