use super::*;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) struct Pcm {
    pub samples: Vec<i16>,
    pub level: f32,
    rate: u32,
    channels: usize,
    max_samples: usize,
    last_input: Instant,
}

impl Pcm {
    pub fn new(rate: u32, channels: u16) -> Result<Self> {
        if rate == 0 || rate > 768_000 || channels == 0 || channels > 64 {
            return Err("The microphone returned an unsupported audio configuration.".into());
        }
        let max_samples = ((rate as u64 * MAX_SECONDS) as usize).min((MAX_AUDIO_BYTES - 44) / 2);
        Ok(Self {
            samples: Vec::with_capacity(max_samples),
            level: 0.0,
            rate,
            channels: channels as usize,
            max_samples,
            last_input: Instant::now(),
        })
    }

    pub fn push<T: Sample>(&mut self, input: &[T])
    where
        f32: FromSample<T>,
    {
        let mut energy = 0.0;
        let mut count = 0;
        for frame in input.chunks_exact(self.channels) {
            if self.full() {
                break;
            }
            let mono = frame
                .iter()
                .map(|&sample| {
                    let value = f32::from_sample(sample);
                    if value.is_finite() {
                        value.clamp(-1.0, 1.0)
                    } else {
                        0.0
                    }
                })
                .sum::<f32>()
                / self.channels as f32;
            self.samples
                .push((mono * 32768.0).clamp(-32768.0, 32767.0).round() as i16);
            energy += mono * mono;
            count += 1;
        }
        self.level = if count == 0 {
            0.0
        } else {
            (energy / count as f32).sqrt().clamp(0.0, 1.0)
        };
        self.last_input = Instant::now();
    }

    /// The meter level: the last callback's RMS, or silence when input stalled (300 ms).
    pub fn live_level(&self) -> f32 {
        if self.last_input.elapsed() < Duration::from_millis(300) {
            self.level
        } else {
            0.0
        }
    }

    /// Rebuilds the capture from the WAV `wav()` wrote (16-bit mono PCM), for Retry and local use.
    pub fn from_wav(wav: &[u8]) -> Result<Self> {
        let bad = || "No valid recorded audio is available. Record again.".to_owned();
        if wav.len() < 44
            || &wav[..4] != b"RIFF"
            || &wav[8..16] != b"WAVEfmt "
            || &wav[36..40] != b"data"
            || u16::from_le_bytes([wav[20], wav[21]]) != 1
            || u16::from_le_bytes([wav[22], wav[23]]) != 1
            || u16::from_le_bytes([wav[34], wav[35]]) != 16
        {
            return Err(bad());
        }
        let rate = u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]);
        let size = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as usize;
        let data = wav.get(44..44 + size).ok_or_else(bad)?;
        let mut pcm = Self::new(rate, 1)?;
        pcm.samples = data
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| i16::from_le_bytes(*b))
            .take(pcm.max_samples)
            .collect();
        Ok(pcm)
    }

    pub fn duration_ms(&self) -> u64 {
        self.samples.len() as u64 * 1000 / self.rate as u64
    }

    /// 16 kHz mono f32 in [-1, 1] for the local engine (sinc resampling with rubato).
    pub fn mono_f32_16k(&self) -> Result<Vec<f32>> {
        let input: Vec<f32> = self.samples.iter().map(|&s| s as f32 / 32768.0).collect();
        resample_16k(input, self.rate)
    }

    pub fn full(&self) -> bool {
        self.samples.len() >= self.max_samples
    }

    pub fn wav(&self) -> Result<Vec<u8>> {
        if self.samples.is_empty() {
            return Err(
                "No microphone audio was captured. Check your input device, then discard and record again.".into(),
            );
        }
        let size = (self.samples.len() * 2) as u32;
        let mut wav = Vec::with_capacity(44 + size as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + size).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&self.rate.to_le_bytes());
        wav.extend_from_slice(&(self.rate * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&size.to_le_bytes());
        for sample in &self.samples {
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        Ok(wav)
    }
}

pub(super) const TARGET_RATE: u32 = 16_000;

pub(super) fn resample_16k(input: Vec<f32>, rate: u32) -> Result<Vec<f32>> {
    use rubato::audioadapter_buffers::direct::SequentialSliceOfVecs;
    use rubato::{Resampler, SincInterpolationParameters, SincInterpolationType, WindowFunction};
    if rate == TARGET_RATE || input.is_empty() {
        return Ok(input);
    }
    let failed = || "Could not prepare the recording for the local speech model.".to_owned();
    let frames = input.len();
    let parameters = SincInterpolationParameters {
        sinc_len: 128,
        f_cutoff: None,
        interpolation: SincInterpolationType::Cubic,
        oversampling_factor: 128,
        window: WindowFunction::BlackmanHarris2,
    };
    let mut resampler = rubato::Async::<f32>::new_sinc(
        TARGET_RATE as f64 / rate as f64,
        1.0,
        &parameters,
        1024,
        1,
        rubato::FixedAsync::Input,
    )
    .map_err(|_| failed())?;
    let channels = [input];
    let adapter = SequentialSliceOfVecs::new(&channels, 1, frames).map_err(|_| failed())?;
    let output = resampler
        .process_all(&adapter, frames, None)
        .map_err(|_| failed())?;
    Ok(output
        .take_data()
        .into_iter()
        .map(|s| if s.is_finite() { s.clamp(-1.0, 1.0) } else { 0.0 })
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Input devices by name; the id is the name (what preferences store).
pub(super) fn devices() -> Vec<MicDevice> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.name().ok());
    let mut seen = std::collections::HashSet::new();
    host.input_devices()
        .map(|list| {
            list.filter_map(|d| d.name().ok())
                .filter(|name| seen.insert(name.clone()))
                .map(|name| MicDevice {
                    id: name.clone(),
                    is_default: default.as_deref() == Some(name.as_str()),
                    name,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The named input device, or the OS default when it is gone or unnamed.
fn input_device(name: Option<&str>) -> Result<cpal::Device> {
    let host = cpal::default_host();
    if let Some(name) = name {
        if let Some(device) = host
            .input_devices()
            .ok()
            .and_then(|mut list| list.find(|d| d.name().ok().as_deref() == Some(name)))
        {
            return Ok(device);
        }
    }
    host.default_input_device()
        .ok_or_else(|| "No microphone is available. Connect an input device and try again.".into())
}

type Opened = (cpal::Stream, Arc<Mutex<Pcm>>, Arc<AtomicBool>);

/// Builds (does not start) an input stream on the chosen device.
fn open(device_name: Option<&str>) -> Result<Opened> {
    let device = input_device(device_name)?;
    let config = device.default_input_config().map_err(|_| {
        "Could not read the microphone format. Check your OS input device and permission."
    })?;
    let pcm = Arc::new(Mutex::new(Pcm::new(
        config.sample_rate().0,
        config.channels(),
    )?));
    let failed = Arc::new(AtomicBool::new(false));
    let params = config.config();
    macro_rules! build {
        ($ty:ty) => {
            stream::<$ty>(&device, &params, pcm.clone(), failed.clone())?
        };
    }
    let stream = match config.sample_format() {
        cpal::SampleFormat::I8 => build!(i8),
        cpal::SampleFormat::I16 => build!(i16),
        cpal::SampleFormat::I24 => build!(cpal::I24),
        cpal::SampleFormat::I32 => build!(i32),
        cpal::SampleFormat::I64 => build!(i64),
        cpal::SampleFormat::U8 => build!(u8),
        cpal::SampleFormat::U16 => build!(u16),
        cpal::SampleFormat::U32 => build!(u32),
        cpal::SampleFormat::U64 => build!(u64),
        cpal::SampleFormat::F32 => build!(f32),
        cpal::SampleFormat::F64 => build!(f64),
        _ => return Err("This microphone's audio format is unsupported. Select another input device in OS settings.".into()),
    };
    Ok((stream, pcm, failed))
}

/// How often a recording reports its input level (10 Hz).
const METER_EVERY: Duration = Duration::from_millis(100);

/// Receives a test recording's live input level (0..1) while it records.
pub(super) type Meter = Box<dyn Fn(f32) + Send>;

/// A test recording's loop: reports the level every `METER_EVERY` until Stop (or the sender
/// dropping), `cap`, or a device failure; nothing is reported after it returns.
pub(super) fn record(pcm: &Mutex<Pcm>, failed: &AtomicBool, stopped: &std::sync::mpsc::Receiver<()>, cap: Duration, meter: &dyn Fn(f32)) {
    let started = Instant::now();
    let mut last_meter: Option<Instant> = None;
    while started.elapsed() < cap && !failed.load(Ordering::Acquire) {
        if last_meter.is_none_or(|at| at.elapsed() >= METER_EVERY) {
            meter(pcm.lock().map(|p| p.live_level()).unwrap_or(0.0));
            last_meter = Some(Instant::now());
        }
        match stopped.recv_timeout(Duration::from_millis(25).min(cap.saturating_sub(started.elapsed()))) {
            Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (),
        }
    }
}

/// A short recording outside any dictation session (mic test, model test). Never transcribed
/// by a provider and never stored.
pub(super) struct Probe {
    stop: std::sync::mpsc::Sender<()>,
    thread: std::thread::JoinHandle<Result<Pcm>>,
}

impl Probe {
    /// Opens the device and starts recording; stops by itself after `cap`.
    pub fn start(device: Option<String>, cap: Duration, meter: Meter) -> Result<Self> {
        let (stop, stopped) = std::sync::mpsc::channel::<()>();
        let (ready_tx, ready) = std::sync::mpsc::channel::<Result<()>>();
        let thread = std::thread::Builder::new()
            .name("voice-probe".into())
            .spawn(move || {
                let (stream, pcm, failed) = match open(device.as_deref()).and_then(|o| {
                    o.0.play().map_err(|_| "Could not start the microphone. Check microphone permission in OS settings.".to_owned())?;
                    Ok(o)
                }) {
                    Ok(opened) => opened,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error.clone()));
                        return Err(error);
                    }
                };
                let _ = ready_tx.send(Ok(()));
                record(&pcm, &failed, &stopped, cap, &*meter);
                drop(stream);
                let pcm = pcm.lock().map_err(|_| "Could not finish microphone audio.".to_owned())?;
                Ok(Pcm {
                    samples: pcm.samples.clone(),
                    level: 0.0,
                    rate: pcm.rate,
                    channels: 1,
                    max_samples: pcm.max_samples,
                    last_input: pcm.last_input,
                })
            })
            .map_err(|_| "Could not start the microphone worker.".to_owned())?;
        match ready.recv() {
            Ok(Ok(())) => Ok(Self { stop, thread }),
            Ok(Err(error)) => Err(error),
            Err(_) => Err("The microphone worker stopped unexpectedly.".into()),
        }
    }

    /// Tests only: a "device" that records 0.1 s of silence and sets `closed` when it stops.
    #[cfg(test)]
    pub fn fake(closed: Arc<AtomicBool>) -> Self {
        let (stop, stopped) = std::sync::mpsc::channel::<()>();
        let thread = std::thread::spawn(move || {
            let _ = stopped.recv();
            closed.store(true, Ordering::Release);
            let mut pcm = Pcm::new(16_000, 1)?;
            pcm.push(&[0.0f32; 1600]);
            Ok(pcm)
        });
        Self { stop, thread }
    }

    /// Stops and returns the audio (blocking; call from a blocking task).
    pub fn finish(self) -> Result<Pcm> {
        let _ = self.stop.send(());
        self.thread
            .join()
            .map_err(|_| "The microphone worker stopped unexpectedly.".to_owned())?
    }
}

fn stream<T: SizedSample>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    pcm: Arc<Mutex<Pcm>>,
    failed: Arc<AtomicBool>,
) -> Result<cpal::Stream>
where
    f32: FromSample<T>,
{
    device.build_input_stream(config, move |data: &[T], _| {
        if let Ok(mut pcm) = pcm.lock() { pcm.push(data); }
    }, move |_| { failed.store(true, Ordering::Release); }, None)
        .map_err(|_| "Could not open the microphone. Check microphone permission and your selected OS input device.".into())
}

pub(super) struct Worker {
    pub voice: Voice,
    pub app: tauri::AppHandle,
    pub id: String,
    pub stop: std::sync::mpsc::Receiver<()>,
    pub cancel: watch::Receiver<bool>,
    pub done: watch::Sender<Option<Result<Arc<Vec<u8>>>>>,
    pub ready: tokio::sync::oneshot::Sender<Result<()>>,
    /// Preferred input device name; the OS default when absent or unplugged.
    pub device: Option<String>,
}

pub(super) fn run(worker: Worker) {
    let Worker {
        voice,
        app,
        id,
        stop,
        cancel,
        done,
        ready,
        device,
    } = worker;
    let setup: Result<_> = (|| {
        if *cancel.borrow() {
            return Err(CANCELLED.into());
        }
        let (stream, pcm, failed) = open(device.as_deref())?;
        // Commit to Recording before play: a cancel that won the race never hears the microphone.
        if *cancel.borrow() || !voice.recording(&id) {
            return Err(CANCELLED.into());
        }
        stream.play().map_err(|_| {
            "Could not start the microphone. Check microphone permission in OS settings."
        })?;
        Ok((stream, pcm, failed))
    })();
    let (stream, pcm, failed) = match setup {
        Ok(setup) => setup,
        Err(error) => {
            let _ = ready.send(Err(error.clone()));
            let _ = done.send(Some(Err(error)));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    let started = Instant::now();
    let mut last_meter = Instant::now() - Duration::from_millis(100);
    let mut automatic_error = None;
    loop {
        if *cancel.borrow() {
            break;
        }
        if failed.load(Ordering::Acquire) {
            automatic_error = Some(
                "Microphone input stopped. Retry to transcribe the captured audio, or discard it.",
            );
            break;
        }
        if started.elapsed() >= Duration::from_secs(MAX_SECONDS)
            || pcm.lock().map(|p| p.full()).unwrap_or(true)
        {
            automatic_error = Some(
                "Recording limit reached. Retry to transcribe the captured audio, or discard it.",
            );
            break;
        }
        if last_meter.elapsed() >= METER_EVERY {
            let level = pcm.lock().map(|p| p.live_level()).unwrap_or(0.0);
            voice.emit(&app, &id, "recording", level, None);
            last_meter = Instant::now();
        }
        match stop.recv_timeout(Duration::from_millis(25)) {
            Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (),
        }
    }
    // Drop first: no callback may append to the finished WAV or outlive Cancel.
    drop(stream);
    if *cancel.borrow() {
        return;
    }
    let audio = pcm
        .lock()
        .map_err(|_| "Could not finish microphone audio. Discard and record again.".to_owned())
        .and_then(|p| p.wav())
        .map(Arc::new);
    let _ = done.send(Some(audio));
    if let Some(error) = automatic_error {
        voice.capture_failed(&app, &id, error);
    }
}
