//! Diagnostic: open every capture path (output loopback + input devices) for ~1.5 s
//! and print the measured peak/RMS so we can see which device actually carries signal.
//! Run: `cargo run --example probe` (play something first).

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn measure(device: &cpal::Device, cfg: &cpal::SupportedStreamConfig) -> Result<(f32, f32, usize), String> {
    let acc = Arc::new(Mutex::new((0.0f32, 0.0f64, 0usize)));
    let a = acc.clone();
    let config: cpal::StreamConfig = cfg.config();
    let stream = match cfg.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |d: &[f32], _: &_| {
                let mut g = a.lock().unwrap();
                for &s in d {
                    g.0 = g.0.max(s.abs());
                    g.1 += (s * s) as f64;
                    g.2 += 1;
                }
            },
            |e| eprintln!("  stream error: {e}"),
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |d: &[i16], _: &_| {
                let mut g = a.lock().unwrap();
                for &s in d {
                    let f = s as f32 / 32768.0;
                    g.0 = g.0.max(f.abs());
                    g.1 += (f * f) as f64;
                    g.2 += 1;
                }
            },
            |e| eprintln!("  stream error: {e}"),
            None,
        ),
        f => return Err(format!("unsupported format {f:?}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(1500));
    drop(stream);
    let g = acc.lock().unwrap();
    let rms = if g.2 > 0 { (g.1 / g.2 as f64).sqrt() as f32 } else { 0.0 };
    Ok((g.0, rms, g.2))
}

fn db(v: f32) -> String {
    if v <= 1e-6 { "-inf".into() } else { format!("{:.1}", 20.0 * v.log10()) }
}

fn main() {
    let host = cpal::default_host();
    println!("host: {:?}", host.id());
    println!("\n== OUTPUT devices (loopback) ==");
    if let Ok(devs) = host.output_devices() {
        for d in devs {
            let name = d.name().unwrap_or_default();
            match d.default_output_config() {
                Ok(cfg) => {
                    print!("{name} [{} Hz x{} {:?}] ... ", cfg.sample_rate().0, cfg.channels(), cfg.sample_format());
                    match measure(&d, &cfg) {
                        Ok((pk, rms, n)) => println!("peak {} dB, rms {} dB, {} samples", db(pk), db(rms), n),
                        Err(e) => println!("ERROR {e}"),
                    }
                }
                Err(e) => println!("{name}: no output config ({e})"),
            }
        }
    }
    println!("\n== INPUT devices ==");
    if let Ok(devs) = host.input_devices() {
        for d in devs {
            let name = d.name().unwrap_or_default();
            match d.default_input_config() {
                Ok(cfg) => {
                    print!("{name} [{} Hz x{} {:?}] ... ", cfg.sample_rate().0, cfg.channels(), cfg.sample_format());
                    match measure(&d, &cfg) {
                        Ok((pk, rms, n)) => println!("peak {} dB, rms {} dB, {} samples", db(pk), db(rms), n),
                        Err(e) => println!("ERROR {e}"),
                    }
                }
                Err(e) => println!("{name}: no input config ({e})"),
            }
        }
    }
}
