//! The real audio stack, for what mocks cannot see: cpal 0.16 segfaulted while listing devices,
//! but only under the release profile. Run with `--release --ignored`. A machine with no usable
//! input passes, so only a crash fails, unless `REQUIRE_MIC_ENV` asks for real samples.

use super::*;

const RECORD_FOR: Duration = Duration::from_millis(800);
/// Allows the probe thread to reach its own cap before `finish` asks it to stop.
const SETTLE: Duration = Duration::from_millis(200);
const REQUIRE_MIC_ENV: &str = "PANDACODE_REQUIRE_REAL_MIC";

#[test]
#[ignore = "opens the real audio stack; run in --release to match shipped builds"]
fn real_audio_lists_opens_and_records() {
    let required = std::env::var_os(REQUIRE_MIC_ENV).is_some();
    let devices = capture::devices();
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

    let probe = match capture::Probe::start(Some(default.id.clone()), RECORD_FOR, Box::new(|_| ())) {
        Ok(probe) => probe,
        Err(error) => {
            eprintln!("real_audio: could not open the input: {error}");
            assert!(!required, "{REQUIRE_MIC_ENV} is set but the input did not open");
            return;
        }
    };
    std::thread::sleep(RECORD_FOR + SETTLE);
    let pcm = probe.finish().expect("the recording finishes");
    eprintln!("real_audio: captured {} samples ({} ms)", pcm.samples.len(), pcm.duration_ms());
    assert!(!required || !pcm.samples.is_empty(), "{REQUIRE_MIC_ENV} is set but nothing was captured");
    if !pcm.samples.is_empty() {
        assert!(pcm.wav().expect("captured audio encodes").starts_with(b"RIFF"));
    }
}

#[test]
fn saved_windows_ids_stay_the_friendly_name() {
    let builder = || cpal::DeviceDescriptionBuilder::new("Microphone");
    let differing = builder().add_extended_line("Microphone (USB Audio)").build();
    assert_eq!(capture::friendly_name(&differing), "Microphone (USB Audio)");
    assert_eq!(capture::friendly_name(&builder().build()), "Microphone");
}
