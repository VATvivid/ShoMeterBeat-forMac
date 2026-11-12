//! File decoding through symphonia (WAV, AIFF, FLAC, MP3, OGG/Vorbis, AAC/MP4).

use std::fs::File;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub struct Decoded {
    pub sample_rate: u32,
    pub channels: usize,
    /// Interleaved, `channels` per frame (down-mixed to at most 2 channels).
    pub samples: Vec<f32>,
}

impl Decoded {
    pub fn frames(&self) -> usize {
        self.samples.len() / self.channels.max(1)
    }
    pub fn mono(&self) -> Vec<f32> {
        let ch = self.channels.max(1);
        self.samples.chunks_exact(ch).map(|f| f.iter().sum::<f32>() / ch as f32).collect()
    }
}

/// Decodes up to `max_secs` of audio. Multichannel sources keep the first two channels.
pub fn decode(path: &str, max_secs: f32) -> Result<Decoded, String> {
    let file = File::open(path).map_err(|e| format!("파일 열기 실패: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("지원하지 않는 형식: {e}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("오디오 트랙이 없습니다")?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("디코더 없음: {e}"))?;
    let mut sample_rate = 0u32;
    let mut src_ch = 0usize;
    let mut out: Vec<f32> = Vec::new();
    let mut sbuf: Option<SampleBuffer<f32>> = None;
    let mut max_frames = usize::MAX;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(_)) | Err(Error::ResetRequired) => break,
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                if sbuf.is_none() {
                    let spec = *decoded.spec();
                    sample_rate = spec.rate;
                    src_ch = spec.channels.count();
                    max_frames = (max_secs * sample_rate as f32) as usize;
                    sbuf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
                }
                let b = sbuf.as_mut().unwrap();
                b.copy_interleaved_ref(decoded);
                let s = b.samples();
                let keep = src_ch.min(2);
                for fr in s.chunks_exact(src_ch.max(1)) {
                    out.extend_from_slice(&fr[..keep]);
                }
                if out.len() / keep.max(1) >= max_frames {
                    break;
                }
            }
            Err(Error::DecodeError(_)) => continue,
            Err(_) => break,
        }
    }
    if sample_rate == 0 || out.is_empty() {
        return Err("디코드된 오디오가 없습니다".into());
    }
    let channels = src_ch.min(2).max(1);
    out.truncate(max_frames.saturating_mul(channels).min(out.len()));
    Ok(Decoded { sample_rate, channels, samples: out })
}
