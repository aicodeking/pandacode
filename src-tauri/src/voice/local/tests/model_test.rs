//! The model test owns its model until it finishes, its transcription can be cancelled (even
//! while it waits for the engine), and hiding the window stops recordings but not downloads.
use super::*;
use super::super::super::capture;

fn voice_with_one() -> (Temp, super::super::Voice) {
    let (body, _) = fake_model();
    let temp = Temp::new();
    let local = local_with(&temp.0, "http://127.0.0.1:9", &body);
    install_one(&local, &body);
    let voice = voice_with(&temp.0, local);
    (temp, voice)
}

async fn start_test(voice: &super::super::Voice, model: Option<&str>) -> Arc<AtomicBool> {
    let closed = Arc::new(AtomicBool::new(false));
    let fake = closed.clone();
    voice
        .start_probe_with(|l| &l.model_test, async { Ok(()) }, model.map(str::to_owned), move || Ok(capture::Probe::fake(fake)))
        .await
        .unwrap();
    closed
}

fn delete(voice: &super::super::Voice) -> crate::Result<()> {
    voice.delete_local_model("test/one")
}

/// Holds the worker's lock with a request that never answers, until `release` is set.
fn occupy(local: &Arc<super::super::Local>, release: Arc<AtomicBool>) -> std::thread::JoinHandle<()> {
    let worker = local.clone();
    let handle = std::thread::spawn(move || {
        let hang = TranscribeRequest { language: Some("__hang".into()), ..Default::default() };
        let _ = worker.worker.transcribe(Path::new("/models/other.gguf"), &hang, &[], &|| release.load(Ordering::Acquire));
    });
    while !local.worker.is_busy() {
        std::thread::sleep(Duration::from_millis(5));
    }
    handle
}

#[tokio::test(flavor = "multi_thread")]
async fn delete_refuses_the_model_a_test_is_recording_with() {
    let (_temp, voice) = voice_with_one();
    let path = voice.local.store.path("one.gguf");
    let closed = start_test(&voice, Some("test/one")).await;
    assert_eq!(delete(&voice).unwrap_err(), "Stop the model test first.");
    assert!(path.exists());
    assert!(!closed.load(Ordering::Acquire), "the refused delete leaves the test recording");
    voice.cancel_probe(|l| &l.model_test).await.unwrap();
    delete(&voice).unwrap();
    assert!(!path.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn delete_refuses_the_selected_model_a_test_without_a_model_uses() {
    let (_temp, voice) = voice_with_one();
    voice.select_local_model("test/one").unwrap();
    start_test(&voice, None).await;
    assert_eq!(delete(&voice).unwrap_err(), "Stop the model test first.");
    voice.cancel_probe(|l| &l.model_test).await.unwrap();
    delete(&voice).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn delete_refuses_while_the_test_transcribes_and_cancel_stops_the_wait_for_the_engine() {
    let (_temp, voice) = voice_with_one();
    start_test(&voice, Some("test/one")).await;
    let release = Arc::new(AtomicBool::new(false));
    let busy = occupy(&voice.local, release.clone());
    let stop = {
        let voice = voice.clone();
        tokio::spawn(async move { voice.model_test_stop().await })
    };
    // The Stop now waits for the engine lock.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!stop.is_finished());
    assert_eq!(delete(&voice).unwrap_err(), "Stop the model test first.");
    voice.cancel_probe(|l| &l.model_test).await.unwrap();
    let stopped = tokio::time::timeout(Duration::from_secs(2), stop).await.expect("cancel is prompt").unwrap().unwrap();
    assert_eq!(serde_json::to_value(stopped).unwrap(), serde_json::json!({ "text": "", "cancelled": true }));
    assert!(voice.local.worker.is_busy(), "the other request still holds the engine");
    assert!(voice.local.model_test.is_idle(), "the cancelled test no longer holds its model");
    release.store(true, Ordering::Release);
    busy.join().unwrap();
    delete(&voice).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_finished_model_test_releases_its_model() {
    let (_temp, voice) = voice_with_one();
    start_test(&voice, Some("test/one")).await;
    let stopped = serde_json::to_value(voice.model_test_stop().await.unwrap()).unwrap();
    assert_eq!(stopped["text"], "1600 samples");
    delete(&voice).unwrap();
}

#[test]
fn a_cancelled_waiting_request_returns_without_the_engine() {
    let worker = Worker::with_timeouts(echo_command(), Duration::from_secs(30), Duration::from_secs(60));
    let cancel = &AtomicBool::new(false);
    let release = Arc::new(AtomicBool::new(false));
    let hang = TranscribeRequest { language: Some("__hang".into()), ..Default::default() };
    std::thread::scope(|s| {
        let first = s.spawn(|| worker.transcribe(Path::new("/models/a.gguf"), &hang, &[], &|| release.load(Ordering::Acquire)));
        while !worker.is_busy() {
            std::thread::sleep(Duration::from_millis(5));
        }
        let started = std::time::Instant::now();
        s.spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancel.store(true, Ordering::Release);
        });
        let queued = worker.transcribe(Path::new("/models/a.gguf"), &TranscribeRequest::default(), &[], &|| cancel.load(Ordering::Acquire));
        assert_eq!(queued, Err(Failure::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(2), "the wait for the lock saw the cancel");
        assert!(worker.is_busy(), "the first request still runs");
        release.store(true, Ordering::Release);
        assert_eq!(first.join().unwrap(), Err(Failure::Cancelled));
    });
}

#[test]
fn a_cancelled_queued_request_never_unloads_the_loaded_model() {
    let worker = Worker::new(echo_command());
    let a = Path::new("/models/a.gguf");
    worker.load(a, &|| false).unwrap();
    let pid = worker.child_pid().unwrap();
    let result = worker.transcribe(Path::new("/models/b.gguf"), &TranscribeRequest::default(), &[], &|| true);
    assert_eq!(result, Err(Failure::Cancelled));
    assert_eq!(worker.child_pid(), Some(pid), "model a stays loaded");
    assert!(alive(pid));
    assert_eq!(worker.status().0.as_deref(), Some(a));
    // Same model, cancelled before it runs: the child stays too.
    assert_eq!(worker.transcribe(a, &TranscribeRequest::default(), &[], &|| true), Err(Failure::Cancelled));
    assert_eq!(worker.child_pid(), Some(pid));
    worker.unload();
}

#[tokio::test(flavor = "multi_thread")]
async fn hiding_the_window_stops_recordings_but_keeps_downloads() {
    let (body, _) = fake_model();
    let server = mock(body.clone(), Mode::Stall).await;
    let temp = Temp::new();
    let local = local_with(&temp.0, &server.base, &body);
    let voice = voice_with(&temp.0, local.clone());
    let closed = start_test(&voice, None).await;
    let emit: super::super::Emit = Arc::new(|_| {});
    let download = {
        let local = local.clone();
        tokio::spawn(async move { local.download("test/one", emit, || {}).await })
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while view(&local)["models"][0]["downloaded"] != 1000 {
        assert!(std::time::Instant::now() < deadline, "download never started");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    voice.close(None);
    assert!(closed.load(Ordering::Acquire), "the microphone is closed");
    assert!(voice.local.model_test.is_idle());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!download.is_finished(), "the download keeps going");
    assert_eq!(view(&local)["models"][0]["state"], "downloading");
    // A real exit cancels it.
    voice.shutdown();
    let error = tokio::time::timeout(Duration::from_secs(5), download).await.unwrap().unwrap().unwrap_err();
    assert_eq!(error, super::super::super::CANCELLED);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_without_a_recording_leaves_a_running_test_transcription_alone() {
    let (_temp, voice) = voice_with_one();
    start_test(&voice, Some("test/one")).await;
    let release = Arc::new(AtomicBool::new(false));
    let busy = occupy(&voice.local, release.clone());
    let stop = {
        let voice = voice.clone();
        tokio::spawn(async move { voice.model_test_stop().await })
    };
    // The first Stop now transcribes (waiting for the engine); a second Stop has no recording.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(voice.model_test_stop().await.err().as_deref(), Some("No test recording is running."));
    release.store(true, Ordering::Release);
    busy.join().unwrap();
    let stopped = tokio::time::timeout(Duration::from_secs(5), stop).await.unwrap().unwrap().unwrap();
    assert_eq!(serde_json::to_value(stopped).unwrap()["text"], "1600 samples", "the running transcription finished");
}
