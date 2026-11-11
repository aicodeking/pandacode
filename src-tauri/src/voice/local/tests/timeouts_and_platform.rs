use super::*;

fn sleepy(ms: u64, seconds_per30s: Option<f64>) -> TranscribeRequest {
    TranscribeRequest { language: Some(format!("__sleep_ms={ms}")), seconds_per30s, ..Default::default() }
}

#[test]
fn transcription_timeout_scales_with_model_speed_backend_and_unknowns() {
    let floor = Duration::from_secs(15);
    let audio = Duration::from_secs(30);
    // Benchmarked: 3x the measured pace, never less than twice the audio.
    assert_eq!(worker::transcribe_timeout(floor, audio, Some(39.5), false), Duration::from_millis(15_000 + 118_500));
    assert_eq!(worker::transcribe_timeout(floor, audio, Some(1.0), false), Duration::from_secs(15 + 60));
    // CPU fallback is slower than the (GPU) benchmark.
    assert_eq!(worker::transcribe_timeout(floor, audio, Some(39.5), true), Duration::from_millis(15_000 + 474_000));
    // Unbenchmarked (e.g. Voxtral Small 24B): generous.
    assert_eq!(worker::transcribe_timeout(floor, audio, None, false), Duration::from_secs(15 + 300));
    assert!(worker::transcribe_timeout(floor, audio, None, true) > worker::transcribe_timeout(floor, audio, None, false));
}

#[test]
fn slow_models_and_cpu_fallback_get_longer_to_transcribe() {
    // 0.1 s of audio, a 200 ms floor; the echo child answers after 600 ms.
    let worker = Worker::with_timeouts(echo_command(), Duration::from_millis(200), Duration::from_secs(60));
    let pcm = [0.0f32; 1600];
    let gpu = Path::new("/models/a.gguf");
    // A fast benchmarked model on its own backend: 200 ms + 2 x 0.1 s.
    assert_eq!(worker.transcribe(gpu, &sleepy(600, Some(0.3)), &pcm, &|| false), Err(Failure::TimedOut));
    // Unbenchmarked: 200 ms + 10 x 0.1 s.
    assert_eq!(worker.transcribe(gpu, &sleepy(600, None), &pcm, &|| false).unwrap(), "1600 samples");
    // The same fast model after a CPU fallback: 200 ms + 8 x 0.1 s.
    let cpu = Path::new("/models/__fail_auto");
    assert_eq!(worker.transcribe(cpu, &sleepy(600, Some(0.3)), &pcm, &|| false).unwrap(), "1600 samples");
    worker.unload();
}

#[test]
fn routes_carry_the_model_benchmark_pace() {
    let (body, _) = fake_model();
    let temp = Temp::new();
    let local = local_with(&temp.0, "http://127.0.0.1:9", &body);
    install_one(&local, &body);
    let voice = voice_with(&temp.0, local.clone());
    let prefs = super::super::config::Preferences { selected_model: Some("test/one".into()), ..voice.preferences().unwrap() };
    // The test catalog's model has no benchmark.
    assert_eq!(local.route_for(&prefs).unwrap().request.seconds_per30s, None);
}

#[test]
fn selecting_checks_installed_under_the_config_lock() {
    use super::super::config::Preferences;
    let (body, _) = fake_model();
    let temp = Temp::new();
    let local = local_with(&temp.0, "http://127.0.0.1:9", &body);
    install_one(&local, &body);
    let voice = voice_with(&temp.0, local.clone());
    let selector = voice.clone();
    let mut racer = None;
    // While another config change holds the lock, the model is deleted.
    voice
        .update_preferences(|p| {
            racer = Some(std::thread::spawn(move || selector.select_local_model("test/one")));
            std::thread::sleep(Duration::from_millis(200));
            local.store.delete(&Item::from(local.catalog.model("test/one").unwrap())).unwrap();
            Ok(Preferences { language: "de".into(), ..p })
        })
        .unwrap();
    let error = racer.unwrap().join().unwrap().unwrap_err();
    assert!(error.contains("Download"), "{error}");
    assert_eq!(voice.preferences().unwrap().selected_model, None, "a deleted model is never selected");
    install_one(&voice.local, &body);
    assert_eq!(voice.select_local_model("test/one").unwrap().selected_model.as_deref(), Some("test/one"));
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_select_runs_before_the_model_reads_as_installed() {
    let (body, _) = fake_model();
    let server = mock(body.clone(), Mode::Normal).await;
    let temp = Temp::new();
    let local = local_with(&temp.0, &server.base, &body);
    let seen = Arc::new(Mutex::new(None));
    let on_installed = {
        let (local, seen) = (local.clone(), seen.clone());
        move || *seen.lock().unwrap() = Some(view(&local)["models"][0]["state"].as_str().unwrap().to_owned())
    };
    local.download("test/one", Arc::new(|_| {}), on_installed).await.unwrap();
    let state = seen.lock().unwrap().clone().expect("on_installed ran");
    assert_ne!(state, "installed", "a catalog read between install and auto-select would show it unselected");
    assert_eq!(view(&local)["models"][0]["state"], "installed");
}

#[test]
fn model_test_uses_the_requested_model_over_the_selection() {
    let (body, _) = fake_model();
    let temp = Temp::new();
    let local = local_with(&temp.0, "http://127.0.0.1:9", &body);
    let voice = voice_with(&temp.0, local.clone());
    let prefs = voice.preferences().unwrap();
    assert_eq!(prefs.selected_model, None);
    // Not installed: refused.
    let error = local.test_route(&prefs, Some("test/one")).unwrap_err();
    assert!(error.contains("Download"), "{error}");
    install_one(&local, &body);
    // No selection, but an explicit (installed) model works.
    let route = local.test_route(&prefs, Some("test/one")).unwrap();
    assert!(route.model.ends_with("one.gguf"));
    // Without a model id the selection decides (none here).
    assert!(local.test_route(&prefs, None).is_err());
    assert!(local.test_route(&prefs, Some("test/none")).is_err());
}

#[tokio::test]
async fn cancel_frees_the_slot_while_the_request_is_unanswered() {
    let (body, item) = fake_model();
    let server = mock(body, Mode::HangHeaders).await;
    let temp = Temp::new();
    let store = Arc::new(store(&temp.0, &server.base));
    let active = active();
    let task = {
        let (store, item, active) = (store.clone(), item.clone(), active.clone());
        tokio::spawn(async move { store.fetch(&item, &active).await })
    };
    while server.requests.lock().unwrap().is_empty() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    active.cancel.store(true, Ordering::Release);
    let error = tokio::time::timeout(Duration::from_secs(2), task).await.expect("cancel is prompt").unwrap().unwrap_err();
    assert_eq!(error, super::super::super::CANCELLED);
}

#[test]
fn windows_arm_needs_dot_product_and_i8mm() {
    use super::super::platform::{unsupported_reason, Cpu, UNSUPPORTED_CPU};
    assert_eq!(unsupported_reason(Cpu::WindowsArm64 { dotprod: true, i8mm: true }), None);
    assert_eq!(unsupported_reason(Cpu::WindowsArm64 { dotprod: false, i8mm: true }), Some(UNSUPPORTED_CPU));
    // Snapdragon 8cx Gen 1-3 have dot product but no i8mm; Windows before SDK 26100 also says no.
    assert_eq!(unsupported_reason(Cpu::WindowsArm64 { dotprod: true, i8mm: false }), Some(UNSUPPORTED_CPU));
    assert_eq!(unsupported_reason(Cpu::WindowsArm64 { dotprod: false, i8mm: false }), Some(UNSUPPORTED_CPU));
    assert_eq!(unsupported_reason(Cpu::Other), None);
    assert_eq!(UNSUPPORTED_CPU, "This computer’s processor can’t run on-device speech models. Use a speech service instead.");
    // This machine (macOS/Linux/x64 CI) is supported and says so.
    let temp = Temp::new();
    let (body, _) = fake_model();
    let v = view(&local_with(&temp.0, "http://127.0.0.1:9", &body));
    assert_eq!(v["platformSupported"], true);
    assert!(v["unsupportedReason"].is_null());
}
