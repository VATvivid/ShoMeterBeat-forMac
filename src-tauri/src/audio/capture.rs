//! Audio capture through cpal.
//!
//! - **Output (loopback)**: opening an *input* stream on an *output* device captures
//!   everything Windows mixes to that device (browser, games, DAWs in shared mode).
//! - **Input**: a normal recording device — e.g. an interface's hardware loopback
//!   channel (RME TotalMix "Loopback", Focusrite "Loopback") or a virtual cable, which
//!   is how ASIO applications (REAPER on ASIO) can be monitored.

use super::Shared;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[default]
    Output,
    Input,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct DeviceEntry {
    pub name: String,
    pub kind: Kind,
    pub default: bool,
}

pub struct Capture {
    _stream: cpal::Stream,
    pub name: String,
    pub kind: Kind,
    pub sample_rate: u32,
    pub channels: u16,
}

/// All render devices (default first) followed by all capture devices (default first).
pub fn list_devices() -> Vec<DeviceEntry> {
    let host = cpal::default_host();
    let mut out = Vec::new();
    let def_out = host.default_output_device().and_then(|d| d.name().ok());
    let def_in = host.default_input_device().and_then(|d| d.name().ok());
    let push = |name: String, kind: Kind, default: bool, out: &mut Vec<DeviceEntry>| {
        if !out.iter().any(|e: &DeviceEntry| e.name == name && e.kind == kind) {
            out.push(DeviceEntry { name, kind, default });
        }
    };
    if let Some(n) = def_out.clone() {
        push(n, Kind::Output, true, &mut out);
    }
    if let Ok(devs) = host.output_devices() {
        for d in devs {
            if let Ok(n) = d.name() {
                push(n, Kind::Output, false, &mut out);
            }
        }
    }
    if let Some(n) = def_in.clone() {
        push(n, Kind::Input, true, &mut out);
    }
    if let Ok(devs) = host.input_devices() {
        for d in devs {
            if let Ok(n) = d.name() {
                push(n, Kind::Input, false, &mut out);
            }
        }
    }
    out
}

fn find_device(host: &cpal::Host, name: Option<&str>, kind: Kind) -> Result<cpal::Device, String> {
    match (kind, name) {
        (Kind::Output, None | Some("")) => host.default_output_device().ok_or_else(|| "기본 출력 장치가 없습니다".to_string()),
        (Kind::Input, None | Some("")) => host.default_input_device().ok_or_else(|| "기본 입력 장치가 없습니다".to_string()),
        (Kind::Output, Some(n)) => host
            .output_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|dn| dn == n).unwrap_or(false))
            .ok_or_else(|| format!("출력 장치를 찾을 수 없습니다: {n}")),
        (Kind::Input, Some(n)) => host
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|dn| dn == n).unwrap_or(false))
            .ok_or_else(|| format!("입력 장치를 찾을 수 없습니다: {n}")),
    }
}

pub fn start(name: Option<&str>, kind: Kind, shared: Arc<Shared>) -> Result<Capture, String> {
    let host = cpal::default_host();
    let device = find_device(&host, name, kind)?;
    let dev_name = device.name().unwrap_or_else(|_| "?".into());
    let supported = match kind {
        Kind::Output => device.default_output_config(),
        Kind::Input => device.default_input_config(),
    }
    .map_err(|e| e.to_string())?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels();
    let config: cpal::StreamConfig = supported.config();

    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => build::<f32>(&device, &config, channels, shared),
        cpal::SampleFormat::I16 => build::<i16>(&device, &config, channels, shared),
        cpal::SampleFormat::I32 => build::<i32>(&device, &config, channels, shared),
        cpal::SampleFormat::U16 => build::<u16>(&device, &config, channels, shared),
        other => Err(format!("지원하지 않는 샘플 형식: {other:?}")),
    }
    .map_err(|e| explain(e, kind))?;
    stream.play().map_err(|e| explain(e, kind))?;

    Ok(Capture { _stream: stream, name: dev_name, kind, sample_rate, channels })
}

/// Turn backend errors into something a user can act on.
fn explain(e: impl std::fmt::Display, kind: Kind) -> String {
    let s = e.to_string();
    if s.contains("0x80070005") || s.contains("액세스가 거부") || s.contains("Access is denied") {
        return if kind == Kind::Input {
            "입력 장치 접근 거부 — Windows 설정 → 개인 정보 및 보안 → 마이크 → '마이크 액세스'와 '데스크톱 앱 허용'을 켜세요".into()
        } else {
            format!("출력 장치 접근 거부: {s}")
        };
    }
    if s.contains("0x88890008") || s.contains("AUDCLNT_E_DEVICE_IN_USE") {
        return "장치가 다른 앱에서 독점 모드로 사용 중입니다".into();
    }
    s
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
