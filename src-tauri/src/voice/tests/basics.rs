use super::*;

#[test]
fn voice_commands_require_local_main_window() {
    let url = reqwest::Url::parse("tauri://localhost/index.html").unwrap();
    assert!(authorized_caller("main", false, &url).is_ok());
    assert!(authorized_caller("tray", false, &url).is_err());
    assert!(authorized_caller("main", true, &url).is_err());
    for origin in [
        "https://remote.example/index.html",
        "https://localhost/index.html",
        "tauri://remote.example/index.html",
    ] {
        assert!(authorized_caller("main", false, &reqwest::Url::parse(origin).unwrap()).is_err());
    }
}

#[test]
fn voice_urls_reject_unsafe_destinations() {
    for url in [
        "https://example.com/v1/audio/transcriptions",
        "http://127.0.0.1:8080/inference",
        "http://[::1]:8080/inference",
    ] {
        assert!(validate_endpoint(url).is_ok(), "{url}");
    }
    for url in [
        "http://example.com/stt",
        "http://localhost/stt",
        "https://user:pass@example.com/stt",
        "https://example.com/stt?key=secret",
        "https://example.com/stt#fragment",
        "file:///tmp/audio",
        "https://example.com/",
        " https://example.com/stt",
    ] {
        assert!(validate_endpoint(url).is_err(), "{url}");
    }
}

#[test]
fn voice_pcm_downmix_meter_and_wav_use_negotiated_rate() {
    let mut pcm = capture::Pcm::new(48_000, 2).unwrap();
    pcm.push(&[0.5f32, 0.5, 1.0, -1.0, f32::NAN, 0.0]);
    assert_eq!(pcm.samples, vec![16_384, 0, 0]);
    assert!(pcm.level > 0.0 && pcm.level <= 1.0);
    let wav = pcm.wav().unwrap();
    assert_eq!(&wav[..4], b"RIFF");
    assert_eq!(&wav[8..12], b"WAVE");
    assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 48_000);
    assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
    assert_eq!(wav.len(), 44 + 6);
}

#[test]
fn voice_pcm_limits_and_integer_formats() {
    let mut pcm = capture::Pcm::new(1, 1).unwrap();
    pcm.push(&[u16::MAX, 32_768, 0]);
    assert_eq!(pcm.samples, vec![32_767, 0, -32_768]);
    pcm.push(&vec![0i16; 150]);
    assert_eq!(pcm.samples.len(), 120);
    assert!(pcm.full());
    let mut pcm = capture::Pcm::new(192_000, 1).unwrap();
    pcm.push(&vec![0f32; MAX_AUDIO_BYTES]);
    assert!(pcm.wav().unwrap().len() <= MAX_AUDIO_BYTES);
    assert!(pcm.full());
    assert!(capture::Pcm::new(0, 1).is_err());
    assert!(capture::Pcm::new(48_000, 0).is_err());
}

/// The mic test's recording loop reports the live input level about 10 times a second and
/// stops reporting on Stop and at its cap.
#[test]
fn voice_probe_recording_reports_live_levels_until_stop_or_cap() {
    use std::sync::atomic::AtomicBool;
    let pcm = Mutex::new(capture::Pcm::new(16_000, 1).unwrap());
    pcm.lock().unwrap().push(&[0.5f32; 160]);
    let failed = AtomicBool::new(false);
    let levels = Mutex::new(Vec::<f32>::new());
    let meter = |level: f32| levels.lock().unwrap().push(level);
    // Cap: returns by itself.
    let (_stop, stopped) = std::sync::mpsc::channel::<()>();
    let started = Instant::now();
    capture::record(&pcm, &failed, &stopped, Duration::from_millis(350), &meter);
    assert!(started.elapsed() < Duration::from_secs(2));
    let seen = std::mem::take(&mut *levels.lock().unwrap());
    assert!((2..=6).contains(&seen.len()), "about 10 Hz: {seen:?}");
    assert!((seen[0] - 0.5).abs() < 1e-3, "the measured level: {seen:?}");
    assert!(seen.iter().all(|l| (0.0..=1.0).contains(l)));
    // Stop: returns promptly, and nothing is reported afterwards.
    let (stop, stopped) = std::sync::mpsc::channel::<()>();
    stop.send(()).unwrap();
    let started = Instant::now();
    capture::record(&pcm, &failed, &stopped, Duration::from_secs(10), &meter);
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(levels.lock().unwrap().len() <= 1);
    // Stale input (no callback for a while) reads as silence.
    std::thread::sleep(Duration::from_millis(350));
    let (_stop, stopped) = std::sync::mpsc::channel::<()>();
    capture::record(&pcm, &failed, &stopped, Duration::from_millis(120), &meter);
    assert!(levels.lock().unwrap().iter().skip(1).all(|l| *l == 0.0));
}
