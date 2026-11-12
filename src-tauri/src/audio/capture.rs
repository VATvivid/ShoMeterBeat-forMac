//! WASAPI loopback capture through cpal: opening an *input* stream on an *output*
//! device captures everything Windows mixes to that device (browser, games, DAWs,
//! game engines) without a virtual cable.

use super::Shared;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::Arc;

pub struct Capture {
    _stream: cpal::Stream,
    pub name: String,
    pub sample_rate: u32,
    pub channels: u16,
}

/// Names of all output (render) devices; the first entry is the default device.
pub fn list_devices() -> Vec<String> {
    let host = cpal::default_host();
    let mut out = Vec::new();
    if let Some(d) = host.default_output_device() {
        if let Ok(n) = d.name() {
            out.push(n);
        }
    }
    if let Ok(devs) = host.output_devices() {
        for d in devs {
            if let Ok(n) = d.name() {
                if !out.contains(&n) {
                    out.push(n);
                }
            }
        }
    }
    out
}

fn find_device(host: &cpal::Host, name: Option<&str>) -> Result<cpal::Device, String> {
    match name {
        None | Some("") => host.default_output_device().ok_or_else(|| "기본 출력 장치가 없습니다".to_string()),
        Some(n) => host
            .output_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|dn| dn == n).unwrap_or(false))
            .ok_or_else(|| format!("출력 장치를 찾을 수 없습니다: {n}")),
    }
}

pub fn start(name: Option<&str>, shared: Arc<Shared>) -> Result<Capture, String> {
    let host = cpal::default_host();
    let device = find_device(&host, name)?;
    let dev_name = device.name().unwrap_or_else(|_| "?".into());
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels();
    let config: cpal::StreamConfig = supported.config();

    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => build::<f32>(&device, &config, channels, shared)?,
        cpal::SampleFormat::I16 => build::<i16>(&device, &config, channels, shared)?,
        cpal::SampleFormat::I32 => build::<i32>(&device, &config, channels, shared)?,
        cpal::SampleFormat::U16 => build::<u16>(&device, &config, channels, shared)?,
        other => return Err(format!("지원하지 않는 샘플 형식: {other:?}")),
    };
    stream.play().map_err(|e| e.to_string())?;

    Ok(Capture { _stream: stream, name: dev_name, sample_rate, channels })
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: u16,
    shared: Arc<Shared>,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let ch = channels.max(1) as usize;
    let err_shared = shared.clone();
    let mut stereo: Vec<f32> = Vec::with_capacity(4096);
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                stereo.clear();
                // Down-mix any channel count to stereo: L = ch0, R = ch1 (or ch0 if mono).
                for fr in data.chunks_exact(ch) {
                    let l = <f32 as cpal::Sample>::from_sample(fr[0]);
                    let r = if ch > 1 { <f32 as cpal::Sample>::from_sample(fr[1]) } else { l };
                    stereo.push(l);
                    stereo.push(r);
                }
                shared.ring.lock().push(&stereo);
            },
            move |err| {
                log::error!("stream error: {err}");
                let mut st = err_shared.status.lock();
                st.running = false;
                st.error = Some(err.to_string());
            },
            None,
        )
        .map_err(|e| e.to_string())
}
