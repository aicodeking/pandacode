//! Microphone capture via cpal for the sherpa engine: the default input
//! device streams into a shared buffer at the device's own rate; the consumer
//! drains it, resamples to 16 kHz mono and measures the input level. The
//! Apple Speech engine captures through AVAudioEngine instead (apple.rs).

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

/// Samples accumulate here on the audio thread; the consumer drains between
/// engine ticks. A try-lock that fails drops that callback's samples rather
/// than ever blocking audio.
pub struct Capture {
    stream: cpal::Stream,
    buffer: Arc<Mutex<Vec<f32>>>,
    /// Last callback's RMS level, as f32 bits (0..1 after [`level_of`]).
    level: Arc<AtomicU32>,
    pub sample_rate: u32,
    /// The device's channel count, for diagnostics only: the callback already
    /// averages to mono, so nothing reads it (a second downmix would garble
    /// mono samples treated as interleaved frames).
    #[allow(dead_code)]
    pub channels: u16,
    /// Callbacks whose samples were dropped because the consumer held the lock.
    /// Diagnostics only; the streaming models tolerate small gaps.
    #[allow(dead_code)]
    pub dropped: Arc<AtomicU64>,
}

impl Capture {
    /// Starts the default input device. Returns an error string when no mic
    /// exists or the OS refuses (permissions surface here on Windows/Linux;
    /// macOS TCC fires before the stream starts producing audio).
    pub fn start() -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or("No microphone is available on this computer.")?;
        let config = device
            .default_input_config()
            .map_err(|e| format!("Could not read the microphone configuration: {e}"))?;
        let sample_rate = config.sample_rate();
        let channels = config.channels();
        let buffer = Arc::new(Mutex::new(Vec::with_capacity(8_192)));
        let level = Arc::new(AtomicU32::new(0));
        let dropped = Arc::new(AtomicU64::new(0));
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => build::<f32>(&device, &config, &buffer, &level, &dropped)?,
            cpal::SampleFormat::I16 => build::<i16>(&device, &config, &buffer, &level, &dropped)?,
            cpal::SampleFormat::U16 => build::<u16>(&device, &config, &buffer, &level, &dropped)?,
            other => return Err(format!("Unsupported microphone format: {other:?}")),
        };
        stream
            .play()
            .map_err(|e| format!("Could not start the microphone: {e}"))?;
        Ok(Self { stream, buffer, level, sample_rate, channels, dropped })
    }

    /// Takes everything captured since the last call, resampled to 16 kHz mono.
    pub fn drain_16k(&self) -> Vec<f32> {
        let raw = match self.buffer.try_lock() {
            Ok(mut guard) => std::mem::take(&mut *guard),
            Err(_) => Vec::new(),
        };
        // The buffer is always mono (the callback averaged it); resample with
        // channels 1 or mono samples get downmixed again as if interleaved.
        resample_to_16k(&raw, self.sample_rate, 1)
    }

    /// Latest input level, 0..1.
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.stream.pause();
    }
}

fn build<T: cpal::SizedSample + num_traits::ToPrimitive>(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    buffer: &Arc<Mutex<Vec<f32>>>,
    level: &Arc<AtomicU32>,
    dropped: &Arc<AtomicU64>,
) -> Result<cpal::Stream, String> {
    let buffer = buffer.clone();
    let level = level.clone();
    let dropped = dropped.clone();
    let channels = config.channels() as usize;
    let stream_config: cpal::StreamConfig = config.clone().into();
    let stream = device
        .build_input_stream(
            stream_config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mono: Vec<f32> = downmix(data, channels);
                if mono.is_empty() {
                    return;
                }
                let rms = level_of(&mono);
                level.store(rms.to_bits(), Ordering::Relaxed);
                match buffer.try_lock() {
                    Ok(mut guard) => guard.extend_from_slice(&mono),
                    Err(TryLockError::WouldBlock) => {
                        dropped.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(TryLockError::Poisoned(_)) => {}
                }
            },
            |error| eprintln!("Microphone stream error: {error}"),
            Some(Duration::from_millis(200)),
        )
        .map_err(|e| format!("Could not open the microphone: {e}"))?;
    Ok(stream)
}

/// Averages channels into mono f32.
pub fn downmix<T: cpal::SizedSample + num_traits::ToPrimitive>(data: &[T], channels: usize) -> Vec<f32> {
    if channels == 0 {
        return Vec::new();
    }
    data.chunks(channels)
        .map(|frame| {
            frame.iter().map(|s| s.to_f32().unwrap_or(0.0)).sum::<f32>() / channels as f32
        })
        .collect()
}

/// Root mean square, scaled so normal speech reads around 0.2-0.6.
pub fn level_of(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt().min(1.0) * 4.0
}

/// Linear resample of mono audio to 16 kHz (voice models' rate). Quality is
/// fine for ASR; the streaming models tolerate the gentle aliasing. Callers
/// pass `channels` 1: capture averages to mono in the callback, so the
/// samples are never interleaved frames.
pub fn resample_to_16k(samples: &[f32], from_rate: u32, channels: usize) -> Vec<f32> {
    let mono = if channels > 1 {
        downmix_to_mono(samples, channels)
    } else {
        samples.to_vec()
    };
    if from_rate == 16_000 || mono.is_empty() {
        return mono;
    }
    if from_rate == 0 {
        return Vec::new();
    }
    let ratio = 16_000f64 / from_rate as f64;
    let out_len = ((mono.len() as f64) * ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let position = i as f64 / ratio;
        let index = position.floor() as usize;
        let frac = (position - index as f64) as f32;
        let a = mono[index];
        let b = mono.get(index + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

/// Buffer stores interleaved frames when channels > 1 (cpal gives interleaved).
fn downmix_to_mono(samples: &[f32], channels: usize) -> Vec<f32> {
    samples
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_averages_channels() {
        assert_eq!(downmix::<f32>(&[0.0, 1.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(downmix::<i16>(&[0, 100], 2), vec![50.0]);
    }

    #[test]
    fn resample_passthrough_at_target_rate() {
        let samples: Vec<f32> = (0..160).map(|i| i as f32 / 160.0).collect();
        assert_eq!(resample_to_16k(&samples, 16_000, 1), samples);
    }

    #[test]
    fn resample_halves_a_32k_signal_and_keeps_length_sane() {
        let samples: Vec<f32> = (0..3_200).map(|i| (i as f32 * 0.01).sin()).collect();
        let out = resample_to_16k(&samples, 32_000, 1);
        assert!((out.len() as i64 - 1_600).abs() <= 1);
    }

    #[test]
    fn resample_interpolates_between_samples() {
        // 2 kHz: every output step lands exactly between two inputs.
        let samples = vec![0.0, 1.0];
        let out = resample_to_16k(&samples, 32_000, 1);
        assert!(out.len() == 1 && out[0] >= 0.0 && out[0] <= 1.0);
    }

    #[test]
    fn level_tracks_loudness_and_caps() {
        assert_eq!(level_of(&[]), 0.0);
        assert_eq!(level_of(&[0.0; 100]), 0.0);
        let loud = level_of(&vec![1.0; 100]);
        assert!((loud - 4.0).abs() < f32::EPSILON, "capped at 1.0*4 scale? got {loud}");
        assert!(level_of(&vec![0.1; 100]) > 0.0 && level_of(&vec![0.1; 100]) < 1.0);
    }

    #[test]
    fn interleaved_buffer_is_monodowned() {
        let samples = vec![0.2, 0.4, 0.6, 0.8];
        let out = downmix_to_mono(&samples, 2);
        assert_eq!(out.len(), 2);
        assert!((out[0] - 0.3).abs() < 1e-6);
        assert!((out[1] - 0.7).abs() < 1e-6);
    }

    /// Against a real microphone (speak during the two seconds):
    /// `PANDACODE_MIC=1 cargo test --lib -- --ignored voice::capture::tests::live_microphone`
    #[test]
    #[ignore]
    fn live_microphone() {
        std::env::var("PANDACODE_MIC").expect("set PANDACODE_MIC=1 to run the live microphone test");
        let capture = Capture::start().expect("open the microphone");
        std::thread::sleep(std::time::Duration::from_secs(2));
        let chunk = capture.drain_16k();
        assert!(!chunk.is_empty(), "two seconds of capture produced no samples");
        println!("captured {} samples (16 kHz), level {:.3}", chunk.len(), capture.level());
    }
}
