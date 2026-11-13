//! ShowMeterBeat Send: a transparent insert that copies its input to the shared-memory
//! bridge so the standalone ShowMeterBeat app can analyze DAW audio (ASIO or not).

use nih_plug::prelude::*;
use std::sync::Arc;

struct Send {
    params: Arc<SendParams>,
    writer: Option<rm_shm::Writer>,
    buf: Vec<f32>,
}

#[derive(Params)]
struct SendParams {}

impl Default for Send {
    fn default() -> Self {
        Self { params: Arc::new(SendParams {}), writer: None, buf: Vec::with_capacity(8192) }
    }
}

impl Plugin for Send {
    const NAME: &'static str = "ShowMeterBeat Send";
    const VENDOR: &'static str = "VATvivid";
    const URL: &'static str = "https://github.com/VATvivid/re-minimeter";
    const EMAIL: &'static str = "";
    const VERSION: &'static str = env!("CARGO_PKG_VERSION");

    const AUDIO_IO_LAYOUTS: &'static [AudioIOLayout] = &[
        AudioIOLayout {
            main_input_channels: NonZeroU32::new(2),
            main_output_channels: NonZeroU32::new(2),
            ..AudioIOLayout::const_default()
        },
        AudioIOLayout {
            main_input_channels: NonZeroU32::new(1),
            main_output_channels: NonZeroU32::new(1),
            ..AudioIOLayout::const_default()
        },
    ];

    const SAMPLE_ACCURATE_AUTOMATION: bool = false;

    type SysExMessage = ();
    type BackgroundTask = ();

    fn params(&self) -> Arc<dyn Params> {
        self.params.clone()
    }

    fn initialize(
        &mut self,
        _layout: &AudioIOLayout,
        buffer_config: &BufferConfig,
        _context: &mut impl InitContext<Self>,
    ) -> bool {
        let sr = buffer_config.sample_rate.round() as u32;
        match self.writer.as_ref() {
            Some(w) => w.set_sample_rate(sr),
            None => match rm_shm::Writer::claim(sr) {
                Ok(w) => self.writer = Some(w),
                Err(e) => nih_log!("ShowMeterBeat Send: {e}"),
            },
        }
        true
    }

    fn deactivate(&mut self) {
        self.writer = None;
    }

    fn process(
        &mut self,
        buffer: &mut Buffer,
        _aux: &mut AuxiliaryBuffers,
        _context: &mut impl ProcessContext<Self>,
    ) -> ProcessStatus {
        if let Some(w) = self.writer.as_ref() {
            let ch = buffer.channels();
            let frames = buffer.samples();
            let slices = buffer.as_slice();
            self.buf.clear();
            for i in 0..frames {
                let l = slices[0][i];
                let r = if ch > 1 { slices[1][i] } else { l };
                self.buf.push(l);
                self.buf.push(r);
            }
            w.write(&self.buf);
        }
        ProcessStatus::Normal
    }
}

impl ClapPlugin for Send {
    const CLAP_ID: &'static str = "com.vatvivid.re-minimeter.send";
    const CLAP_DESCRIPTION: Option<&'static str> = Some("Streams audio to the ShowMeterBeat analyzer app");
    const CLAP_MANUAL_URL: Option<&'static str> = None;
    const CLAP_SUPPORT_URL: Option<&'static str> = None;
    const CLAP_FEATURES: &'static [ClapFeature] = &[ClapFeature::AudioEffect, ClapFeature::Utility, ClapFeature::Analyzer];
}

impl Vst3Plugin for Send {
    const VST3_CLASS_ID: [u8; 16] = *b"ReMiniMeterSend1";
    const VST3_SUBCATEGORIES: &'static [Vst3SubCategory] = &[Vst3SubCategory::Fx, Vst3SubCategory::Analyzer];
}

nih_export_clap!(Send);
nih_export_vst3!(Send);
