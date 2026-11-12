//! The real audio stack, for what mocks cannot see: cpal 0.16 segfaulted while listing devices,
//! but only under the release profile. Run with `--release --ignored`. A machine with no usable
//! input passes, so only a crash fails, unless `REQUIRE_MIC_ENV` is `1` or `true` (any case),
//! which asks for real samples.
//!
//! The probe's cap is wall time; audio is only bounded by `Pcm`'s `MAX_SECONDS` buffer, which an
//! unpaced input (Linux CI's null ALSA default) fills within the cap. So the limit is checked by
//! when the probe's meter stops, which holds on any device, and by audio length only when the
//! input runs in real time.

use super::*;

const RECORD_FOR: Duration = Duration::from_millis(800);
/// Lets the probe pass its own cap well before `finish` asks it to stop, so an ignored cap shows.
const SETTLE: Duration = Duration::from_millis(500);
/// Scheduling jitter allowed past `RECORD_FOR`; well under `SETTLE`.
const SLACK: Duration = Duration::from_millis(150);
/// Real-time audio runs past the meter's span: it includes what the device buffered before
/// `record` started (864–928 ms seen on darwin-aarch64 for the 800 ms cap), so its bound is looser.
const AUDIO_BOUND: Duration = Duration::from_millis(1100);
const REQUIRE_MIC_ENV: &str = "PANDACODE_REQUIRE_REAL_MIC";

#[test]
#[ignore = "opens the real audio stack; run in --release to match shipped builds"]
fn real_audio_lists_opens_and_records() {
    let required = std::env::var(REQUIRE_MIC_ENV).is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
    let devices = capture::devices(None);
    let names: Vec<&str> = devices.iter().map(|d| d.name.as_str()).collect();
    eprintln!("real_audio: input devices: {names:?}");
    let Some(default) = devices.iter().find(|d| d.is_default) else {
        eprintln!("real_audio: no default input device; nothing to record");
        assert!(!required, "{REQUIRE_MIC_ENV} is set but no default input exists");
        return;
    };
    eprintln!("real_audio: default input: {:?}", default.name);

    // A saved id resolves to that device; a stale one falls back to the OS default.
    let resolved = capture::input_device(Some(&default.id)).expect("the listed default resolves");
    assert_eq!(capture::saved_name(&resolved).as_deref(), Some(default.id.as_str()));
    let fallback = capture::input_device(Some("A microphone that is not plugged in"))
        .expect("a stale saved id falls back to the default");
    assert_eq!(capture::saved_name(&fallback).as_deref(), Some(default.id.as_str()));

    // The meter runs only while the probe records: its first and last calls bound the recording.
    let meters: Arc<Mutex<Vec<Instant>>> = Arc::default();
    let meter = {
        let meters = Arc::clone(&meters);
        Box::new(move |_: f32| meters.lock().unwrap().push(Instant::now()))
    };
    let probe = match capture::Probe::start(Some(default.id.clone()), RECORD_FOR, meter) {
        Ok(probe) => probe,
        Err(error) => {
            eprintln!("real_audio: could not open the input: {error}");
            assert!(!required, "{REQUIRE_MIC_ENV} is set but the input did not open");
            return;
        }
    };
    let started = Instant::now();
    std::thread::sleep(RECORD_FOR + SETTLE);
    let pcm = probe.finish().expect("the recording finishes");
    let wall = started.elapsed();
    let audio = Duration::from_millis(pcm.duration_ms());
    let meters = meters.lock().unwrap().clone();
    let metered = meters.last().zip(meters.first()).map_or(Duration::ZERO, |(last, first)| *last - *first);
    // A real-time input delivers about one second of audio per second; an unpaced one far more.
    let paced = audio <= wall * 2;
    eprintln!(
        "real_audio: captured {} samples ({} ms of audio in {} ms wall; probe metered for {} ms; paced: {paced})",
        pcm.samples.len(), audio.as_millis(), wall.as_millis(), metered.as_millis(),
    );
    assert!(metered <= RECORD_FOR + SLACK, "the probe recorded for {metered:?}, past its {RECORD_FOR:?} cap");
    assert!(audio <= Duration::from_secs(MAX_SECONDS), "{audio:?} of audio exceeds the {MAX_SECONDS} s buffer");
    assert!(!paced || audio <= AUDIO_BOUND, "{audio:?} of real-time audio is past {AUDIO_BOUND:?} for the {RECORD_FOR:?} cap");
    assert!(!required || !pcm.samples.is_empty(), "{REQUIRE_MIC_ENV} is set but nothing was captured");
    if !pcm.samples.is_empty() {
        assert!(pcm.wav().expect("captured audio encodes").starts_with(b"RIFF"));
    }
    unprobed_falls_back_for_dictation(required);
}

/// Linux lists `jack` and `oss` without opening them (alsa-plugins defines both). With no server
/// behind a saved one, dictation records from the default input while the mic test reports why.
fn unprobed_falls_back_for_dictation(required: bool) {
    let listed = capture::devices(None);
    let Some(id) = listed.iter().map(|d| d.id.as_str()).find(|id| cfg!(target_os = "linux") && matches!(*id, "jack" | "oss")) else {
        eprintln!("real_audio: no jack or oss input listed; dictation fallback not exercised");
        return;
    };
    match capture::open_and_record(id, true, RECORD_FOR) {
        Ok(samples) => eprintln!("real_audio: {id:?} opened itself ({samples} samples); dictation fallback not exercised"),
        Err(error) => {
            eprintln!("real_audio: mic test on saved {id:?} reports: {error}");
            let samples = capture::open_and_record(id, false, RECORD_FOR).expect("dictation on a saved jack/oss falls back to the default input");
            eprintln!("real_audio: dictation on saved {id:?} fell back to the default input and recorded {samples} samples");
            assert!(!required || samples > 0, "{REQUIRE_MIC_ENV} is set but the fallback captured nothing");
        }
    }
}

#[test]
fn saved_windows_ids_stay_the_friendly_name() {
    let builder = || cpal::DeviceDescriptionBuilder::new("Microphone");
    let differing = builder().add_extended_line("Microphone (USB Audio)").build();
    assert_eq!(capture::friendly_name(&differing), "Microphone (USB Audio)");
    assert_eq!(capture::friendly_name(&builder().build()), "Microphone");
}
