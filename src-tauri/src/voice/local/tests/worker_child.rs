use super::*;

#[test]
fn worker_round_trips_through_a_child_and_reuses_it() {
    let worker = Worker::new(echo_command());
    let never = || false;
    let loaded = worker.load(Path::new("/models/a.gguf"), &never).unwrap();
    assert_eq!(loaded.backend, "echo-auto");
    let pid = worker.child_pid().unwrap();
    let text = worker.transcribe(Path::new("/models/a.gguf"), &TranscribeRequest::default(), &[0.0; 16_000], &never).unwrap();
    assert_eq!(text, "16000 samples");
    assert_eq!(worker.child_pid(), Some(pid), "same model keeps the child");
    assert_eq!(worker.status().0.as_deref(), Some(Path::new("/models/a.gguf")));
    // Another model restarts the child.
    worker.load(Path::new("/models/b.gguf"), &never).unwrap();
    assert_ne!(worker.child_pid(), Some(pid));
    assert!(!alive(pid));
    worker.unload();
    assert!(worker.child_pid().is_none());
}

#[test]
fn worker_falls_back_to_cpu_when_auto_load_fails() {
    let worker = Worker::new(echo_command());
    let loaded = worker.load(Path::new("/models/__fail_auto"), &|| false).unwrap();
    assert_eq!(loaded.backend, "echo-cpu-env");
}

#[test]
fn worker_is_killed_on_timeout_cancel_and_crash() {
    let worker = Worker::with_timeouts(echo_command(), Duration::from_millis(300), Duration::from_secs(60));
    let model = Path::new("/models/a.gguf");
    let never = || false;
    let hang = TranscribeRequest { language: Some("__hang".into()), ..Default::default() };
    worker.load(model, &never).unwrap();
    let pid = worker.child_pid().unwrap();
    let started = std::time::Instant::now();
    assert_eq!(worker.transcribe(model, &hang, &[0.0; 1600], &never), Err(Failure::TimedOut));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(worker.child_pid().is_none() && !alive(pid));

    // Cancel kills too, and the next request starts a fresh child.
    let flag = AtomicBool::new(false);
    worker.load(model, &never).unwrap();
    let pid = worker.child_pid().unwrap();
    std::thread::scope(|s| {
        s.spawn(|| {
            std::thread::sleep(Duration::from_millis(100));
            flag.store(true, Ordering::Release);
        });
        assert_eq!(worker.transcribe(model, &hang, &[], &|| flag.load(Ordering::Acquire)), Err(Failure::Cancelled));
    });
    assert!(!alive(pid));

    let exit = TranscribeRequest { language: Some("__exit".into()), ..Default::default() };
    assert_eq!(worker.transcribe(model, &exit, &[], &never), Err(Failure::Died));
    assert_eq!(worker.transcribe(model, &TranscribeRequest::default(), &[0.0; 2], &never).unwrap(), "2 samples");
}

#[test]
fn worker_reports_a_missing_program() {
    let worker = Worker::new(WorkerCommand { program: "/nonexistent/pandacode".into(), args: vec![], env: vec![] });
    assert_eq!(worker.load(Path::new("/m"), &|| false).unwrap_err(), Failure::Died);
}

#[test]
fn idle_unload_never_cancels_an_in_flight_request() {
    let worker = Worker::with_timeouts(echo_command(), Duration::from_millis(400), Duration::from_secs(60));
    let model = Path::new("/models/a.gguf");
    let hang = TranscribeRequest { language: Some("__hang".into()), ..Default::default() };
    std::thread::scope(|s| {
        let busy = s.spawn(|| worker.transcribe(model, &hang, &[], &|| false));
        while !worker.is_busy() {
            std::thread::sleep(Duration::from_millis(5));
        }
        std::thread::sleep(Duration::from_millis(50));
        // What "Unload immediately" does after another dictation finished.
        worker.unload_idle();
        assert_eq!(busy.join().unwrap(), Err(Failure::TimedOut), "the other request ran to its own end");
    });
    // An idle child is unloaded.
    worker.load(model, &|| false).unwrap();
    worker.unload_idle();
    assert!(worker.child_pid().is_none());
    // A full unload cancels requests issued before it, never ones issued after.
    worker.unload();
    assert_eq!(worker.transcribe(model, &TranscribeRequest::default(), &[0.0; 3], &|| false).unwrap(), "3 samples");
}

#[test]
fn no_speech_from_the_vad_falls_back_to_the_raw_audio() {
    let pcm = vec![0.5f32; 8];
    assert_eq!(audio::speech_or_raw::<()>(Ok(None), pcm.clone()), pcm);
    assert_eq!(audio::speech_or_raw(Err(()), pcm.clone()), pcm);
    assert_eq!(audio::speech_or_raw::<()>(Ok(Some(vec![1.0])), pcm), vec![1.0]);
}

#[test]
fn worker_falls_back_to_cpu_after_an_auto_load_timeout() {
    let worker = Worker::with_timeouts(echo_command(), Duration::from_secs(15), Duration::from_millis(500));
    let loaded = worker.load(Path::new("/models/__hang_auto"), &|| false).unwrap();
    assert_eq!(loaded.backend, "echo-cpu-env");
}

#[test]
fn load_timeout_grows_with_model_size() {
    let temp = Temp::new();
    let path = temp.0.join("big.gguf");
    // Sparse: no disk is used.
    std::fs::File::create(&path).unwrap().set_len(2_000_000_000).unwrap();
    let worker = Worker::new(echo_command());
    assert_eq!(worker.load_timeout_for(&path), Duration::from_secs(180));
    assert_eq!(worker.load_timeout_for(Path::new("/nonexistent/model.gguf")), Duration::from_secs(120));
}

#[test]
fn deleting_an_idle_model_never_cancels_a_request_for_another_model() {
    let worker = Worker::new(echo_command());
    let (gone, other) = (Path::new("/models/gone.gguf"), Path::new("/models/other.gguf"));
    worker.load(gone, &|| false).unwrap();
    std::thread::scope(|s| {
        let mut queued = None;
        // A dictation for another model takes its ticket between the idle check and the unload.
        let deleted = worker.unload_for_delete(gone, || {
            queued = Some(s.spawn(|| worker.transcribe(other, &TranscribeRequest::default(), &[0.0; 4], &|| false)));
            std::thread::sleep(Duration::from_millis(150));
        });
        assert!(deleted.is_some(), "an idle engine lets the delete run");
        assert_eq!(queued.unwrap().join().unwrap().as_deref(), Ok("4 samples"), "the other dictation still runs");
    });
    assert_eq!(worker.status().0.as_deref(), Some(other));
    // A busy engine refuses, and its request is left alone.
    let hang = TranscribeRequest { language: Some("__hang".into()), ..Default::default() };
    let worker = Worker::with_timeouts(echo_command(), Duration::from_millis(400), Duration::from_secs(60));
    std::thread::scope(|s| {
        let busy = s.spawn(|| worker.transcribe(gone, &hang, &[], &|| false));
        while !worker.is_busy() {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(worker.unload_for_delete(gone, || ()).is_none());
        assert_eq!(busy.join().unwrap(), Err(Failure::TimedOut));
    });
}
