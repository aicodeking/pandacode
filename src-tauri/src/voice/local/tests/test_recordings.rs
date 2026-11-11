//! Mic and model test recordings: a Stop or Cancel that arrives while Start still waits for
//! permission or the device aborts that Start, and its device is closed.
use super::*;
use super::super::super::{capture, CANCELLED};
use std::future::Future;
use std::pin::Pin;

type Permission = Pin<Box<dyn Future<Output = crate::Result<()>> + Send>>;

fn slow_permission(ms: u64) -> Permission {
    Box::pin(async move {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        Ok(())
    })
}

/// An opener that records whether it ran and whether its (fake) device was closed.
fn opener(opened: Arc<AtomicBool>, closed: Arc<AtomicBool>, delay: Duration) -> impl FnOnce() -> crate::Result<capture::Probe> + Send + 'static {
    move || {
        std::thread::sleep(delay);
        opened.store(true, Ordering::Release);
        Ok(capture::Probe::fake(closed))
    }
}

fn voice() -> (Temp, super::super::Voice) {
    let (body, _) = fake_model();
    let temp = Temp::new();
    let local = local_with(&temp.0, "http://127.0.0.1:9", &body);
    let voice = voice_with(&temp.0, local);
    (temp, voice)
}

fn flags() -> (Arc<AtomicBool>, Arc<AtomicBool>) {
    (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)))
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_during_the_permission_wait_aborts_the_start_without_opening() {
    let (_temp, voice) = voice();
    let (opened, closed) = flags();
    let start = {
        let voice = voice.clone();
        let open = opener(opened.clone(), closed.clone(), Duration::ZERO);
        tokio::spawn(async move { voice.start_probe_with(|l| &l.mic_test, slow_permission(300), None, open).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    voice.cancel_probe(|l| &l.mic_test).await.unwrap();
    assert_eq!(start.await.unwrap().unwrap_err(), CANCELLED);
    assert!(!opened.load(Ordering::Acquire), "a cancelled start never opens the device");
    assert!(voice.local.mic_test.is_idle());
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_while_the_device_opens_closes_it_again() {
    let (_temp, voice) = voice();
    let (opened, closed) = flags();
    let start = {
        let voice = voice.clone();
        let open = opener(opened.clone(), closed.clone(), Duration::from_millis(300));
        tokio::spawn(async move { voice.start_probe_with(|l| &l.model_test, slow_permission(0), None, open).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    voice.cancel_probe(|l| &l.model_test).await.unwrap();
    assert_eq!(start.await.unwrap().unwrap_err(), CANCELLED);
    assert!(opened.load(Ordering::Acquire));
    assert!(closed.load(Ordering::Acquire), "the device opened after the cancel is closed");
    assert!(voice.local.model_test.is_idle(), "nothing records unseen");
}

#[tokio::test(flavor = "multi_thread")]
async fn mic_stop_during_a_pending_start_cancels_it_and_says_so() {
    let (_temp, voice) = voice();
    let (opened, closed) = flags();
    let start = {
        let voice = voice.clone();
        let open = opener(opened.clone(), closed.clone(), Duration::ZERO);
        tokio::spawn(async move { voice.start_probe_with(|l| &l.mic_test, slow_permission(300), None, open).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    let stopped = serde_json::to_value(voice.mic_test_stop().await.unwrap()).unwrap();
    assert_eq!(stopped, serde_json::json!({ "wavBase64": "", "durationMs": 0, "cancelled": true }));
    assert_eq!(start.await.unwrap().unwrap_err(), CANCELLED);
    assert!(!opened.load(Ordering::Acquire));
    assert!(voice.local.mic_test.is_idle());
}

#[tokio::test(flavor = "multi_thread")]
async fn model_stop_during_a_pending_start_cancels_it_and_says_so() {
    let (_temp, voice) = voice();
    let (opened, closed) = flags();
    let start = {
        let voice = voice.clone();
        let open = opener(opened.clone(), closed.clone(), Duration::from_millis(300));
        tokio::spawn(async move { voice.start_probe_with(|l| &l.model_test, slow_permission(0), None, open).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    let stopped = serde_json::to_value(voice.model_test_stop().await.unwrap()).unwrap();
    assert_eq!(stopped, serde_json::json!({ "text": "", "cancelled": true }));
    assert_eq!(start.await.unwrap().unwrap_err(), CANCELLED);
    assert!(closed.load(Ordering::Acquire));
    assert!(voice.local.model_test.is_idle());
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_without_any_start_still_fails_and_a_finished_start_records() {
    let (_temp, voice) = voice();
    assert_eq!(voice.mic_test_stop().await.err().as_deref(), Some("No test recording is running."));
    let (opened, closed) = flags();
    voice.start_probe_with(|l| &l.mic_test, slow_permission(0), None, opener(opened, closed.clone(), Duration::ZERO)).await.unwrap();
    assert!(!voice.local.mic_test.is_idle());
    let stopped = serde_json::to_value(voice.mic_test_stop().await.unwrap()).unwrap();
    assert!(stopped.get("cancelled").is_none(), "{stopped}");
    assert!(stopped["wavBase64"].as_str().is_some_and(|w| !w.is_empty()));
    assert!(closed.load(Ordering::Acquire));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_newer_start_supersedes_a_pending_one() {
    let (_temp, voice) = voice();
    let (first_opened, first_closed) = flags();
    let first = {
        let voice = voice.clone();
        let open = opener(first_opened.clone(), first_closed, Duration::ZERO);
        tokio::spawn(async move { voice.start_probe_with(|l| &l.mic_test, slow_permission(300), None, open).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    let (opened, closed) = flags();
    voice.start_probe_with(|l| &l.mic_test, slow_permission(0), None, opener(opened, closed.clone(), Duration::ZERO)).await.unwrap();
    assert_eq!(first.await.unwrap().unwrap_err(), CANCELLED);
    assert!(!first_opened.load(Ordering::Acquire));
    voice.cancel_probe(|l| &l.mic_test).await.unwrap();
    assert!(closed.load(Ordering::Acquire));
    assert!(voice.local.mic_test.is_idle());
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_the_window_reports_each_test_recording_it_discards() {
    use super::super::test_recordings::{TestEnded, TestKind};
    let (_temp, voice) = voice();
    assert!(voice.end_tests(None).is_empty(), "nothing was recording");
    // Only one test records at a time, so each kind is closed in turn.
    let (mic_open, mic_closed) = flags();
    voice.start_probe_with(|l| &l.mic_test, async { Ok(()) }, None, opener(mic_open, mic_closed.clone(), Duration::ZERO)).await.unwrap();
    assert_eq!(voice.end_tests(None), [TestKind::Mic]);
    assert!(mic_closed.load(Ordering::Acquire), "the mic test device closed");
    let (model_open, model_closed) = flags();
    voice.start_probe_with(|l| &l.model_test, async { Ok(()) }, None, opener(model_open, model_closed.clone(), Duration::ZERO)).await.unwrap();
    assert_eq!(voice.end_tests(None), [TestKind::Model]);
    assert!(model_closed.load(Ordering::Acquire), "the model test device closed");
    assert!(voice.local.mic_test.is_idle() && voice.local.model_test.is_idle());
    assert!(voice.end_tests(None).is_empty(), "reported once");
    assert_eq!(
        serde_json::to_value(TestEnded::closed(TestKind::Mic)).unwrap(),
        serde_json::json!({ "kind": "mic", "reason": "closed" })
    );
    assert_eq!(serde_json::to_value(TestEnded::closed(TestKind::Model)).unwrap()["kind"], "model");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pending_test_start_cancelled_by_closing_is_not_reported() {
    let (_temp, voice) = voice();
    let (opened, closed) = flags();
    let start = {
        let voice = voice.clone();
        let open = opener(opened.clone(), closed, Duration::ZERO);
        tokio::spawn(async move { voice.start_probe_with(|l| &l.mic_test, slow_permission(300), None, open).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(voice.end_tests(None).is_empty(), "the Start rejects as cancelled instead");
    assert_eq!(start.await.unwrap().unwrap_err(), CANCELLED);
    assert!(!opened.load(Ordering::Acquire));
}

/// A Start whose capture worker must never run: the dictation is refused before it opens.
fn dictation(voice: &super::super::Voice) -> impl Future<Output = crate::Result<String>> + '_ {
    use super::super::super::{config::Snapshot, Target};
    let none = Snapshot { endpoint: String::new(), model: String::new(), language: None, key: None };
    voice.start_with("dictation".into(), Target { remote: none, route: None }, async { Ok(()) }, |_| {
        Err(std::io::Error::other("must not open the microphone"))
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dictation_cannot_start_while_a_test_records() {
    let (_temp, voice) = voice();
    let (opened, closed) = flags();
    voice.start_probe_with(|l| &l.mic_test, async { Ok(()) }, None, opener(opened.clone(), closed.clone(), Duration::ZERO)).await.unwrap();
    assert_eq!(dictation(&voice).await.unwrap_err(), "Finish the microphone test first.");
    assert!(voice.session.lock().unwrap().is_none(), "nothing was reserved");
    assert!(!closed.load(Ordering::Acquire), "the mic test keeps recording");
    voice.cancel_probe(|l| &l.mic_test).await.unwrap();

    let (opened, closed) = flags();
    voice.start_probe_with(|l| &l.model_test, async { Ok(()) }, None, opener(opened, closed, Duration::ZERO)).await.unwrap();
    assert_eq!(dictation(&voice).await.unwrap_err(), "Finish the model test first.");
    voice.cancel_probe(|l| &l.model_test).await.unwrap();

    // A test Start still waiting for permission also holds the microphone.
    let pending = {
        let voice = voice.clone();
        let (opened, closed) = flags();
        let open = opener(opened, closed, Duration::ZERO);
        tokio::spawn(async move { voice.start_probe_with(|l| &l.mic_test, slow_permission(300), None, open).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(dictation(&voice).await.unwrap_err(), "Finish the microphone test first.");
    voice.cancel_probe(|l| &l.mic_test).await.unwrap();
    assert_eq!(pending.await.unwrap().unwrap_err(), CANCELLED);
    // With both tests idle, a dictation reserves again (and fails only at the fake device).
    assert_eq!(dictation(&voice).await.unwrap_err(), "Could not start the microphone worker.");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_mic_and_model_tests_never_record_at_the_same_time() {
    let (_temp, voice) = voice();
    let (opened, closed) = flags();
    voice.start_probe_with(|l| &l.mic_test, async { Ok(()) }, None, opener(opened, closed.clone(), Duration::ZERO)).await.unwrap();
    let (model_open, _) = flags();
    let refused = voice.start_probe_with(|l| &l.model_test, async { Ok(()) }, None, opener(model_open.clone(), flags().1, Duration::ZERO));
    assert_eq!(refused.await.unwrap_err(), "Finish the microphone test first.");
    assert!(!model_open.load(Ordering::Acquire) && voice.local.model_test.is_idle(), "the model test never opened");
    assert!(!closed.load(Ordering::Acquire), "the mic test keeps recording");
    voice.cancel_probe(|l| &l.mic_test).await.unwrap();

    // A model test Start still waiting for permission also holds the microphone.
    let pending = {
        let voice = voice.clone();
        let (opened, closed) = flags();
        let open = opener(opened, closed, Duration::ZERO);
        tokio::spawn(async move { voice.start_probe_with(|l| &l.model_test, slow_permission(300), None, open).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    let (mic_open, _) = flags();
    let refused = voice.start_probe_with(|l| &l.mic_test, async { Ok(()) }, None, opener(mic_open.clone(), flags().1, Duration::ZERO));
    assert_eq!(refused.await.unwrap_err(), "Finish the model test first.");
    assert!(!mic_open.load(Ordering::Acquire) && voice.local.mic_test.is_idle());
    voice.cancel_probe(|l| &l.model_test).await.unwrap();
    assert_eq!(pending.await.unwrap().unwrap_err(), CANCELLED);
    // With the model test gone, the mic test records again.
    let (opened, closed) = flags();
    voice.start_probe_with(|l| &l.mic_test, async { Ok(()) }, None, opener(opened.clone(), closed, Duration::ZERO)).await.unwrap();
    assert!(opened.load(Ordering::Acquire));
    voice.cancel_probe(|l| &l.mic_test).await.unwrap();
}
