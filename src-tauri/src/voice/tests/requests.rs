use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn voice_request_cancel_before_reservation_skips_permission_and_device() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    // Cancel reaches native before voice_start does (no session yet).
    cancel_request(&voice, "early").await;
    let (asked, spawned) = (
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
    );
    let asked_in = asked.clone();
    let error = voice
        .start_with(
            "early".into(),
            profile(),
            async move {
                asked_in.store(true, Ordering::Release);
                Ok(())
            },
            never_spawn(spawned.clone()),
        )
        .await
        .unwrap_err();
    assert_eq!(error, CANCELLED);
    assert!(!asked.load(Ordering::Acquire) && !spawned.load(Ordering::Acquire));
    assert!(voice.session.lock().unwrap().is_none());
    fresh_start_works(&voice, "after-early").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn voice_request_cancel_during_permission_never_opens_device_after_grant() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    let (grant, granted) = tokio::sync::oneshot::channel::<Result<()>>();
    let (asked, spawned) = (
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
    );
    let asked_in = asked.clone();
    let pending = tokio::spawn({
        let (voice, spawned) = (voice.clone(), spawned.clone());
        async move {
            voice
                .start_with(
                    "slow-permission".into(),
                    profile(),
                    async move {
                        asked_in.store(true, Ordering::Release);
                        granted.await.unwrap_or(Ok(()))
                    },
                    never_spawn(spawned),
                )
                .await
        }
    });
    wait_for("the permission prompt", || asked.load(Ordering::Acquire)).await;
    cancel_request(&voice, "slow-permission").await;
    // The user grants access after cancelling; nothing may open.
    let _ = grant.send(Ok(()));
    assert_eq!(pending.await.unwrap().unwrap_err(), CANCELLED);
    assert!(!spawned.load(Ordering::Acquire));
    assert!(voice.session.lock().unwrap().is_none());
    fresh_start_works(&voice, "after-permission").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn voice_request_cancel_during_device_open_never_plays_and_allows_restart() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    let (open, device) = std::sync::mpsc::channel();
    let played = Arc::new(AtomicBool::new(false));
    let pending = tokio::spawn({
        let (voice, played) = (voice.clone(), played.clone());
        async move {
            voice
                .start_with(
                    "slow-device".into(),
                    profile(),
                    async { Ok(()) },
                    fake_worker(Some(device), played, || ()),
                )
                .await
        }
    });
    wait_for("the device worker", || {
        voice
            .session
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|s| s.thread.is_some())
    })
    .await;
    // voice_cancel blocks until the worker joins; run it concurrently with the slow open.
    let cancelling = tokio::task::spawn_blocking({
        let voice = voice.clone();
        move || voice.cancel(None, None, Some("slow-device"))
    });
    wait_for("the cancel mark", || {
        session_phase(&voice).is_some_and(|s| s.2)
    })
    .await;
    assert_eq!(pending.await.unwrap().unwrap_err(), CANCELLED);
    // An immediate fresh Start is not blocked by the old worker still joining.
    let fresh_played = Arc::new(AtomicBool::new(false));
    let fresh = voice
        .start_with(
            "fresh".into(),
            profile(),
            async { Ok(()) },
            fake_worker(None, fresh_played.clone(), || ()),
        )
        .await
        .unwrap();
    assert!(fresh_played.load(Ordering::Acquire));
    open.send(()).unwrap();
    cancelling.await.unwrap().unwrap();
    assert!(
        !played.load(Ordering::Acquire),
        "the cancelled start must not play"
    );
    assert_eq!(session_phase(&voice).unwrap().0, fresh);
    // The stale request cancel cannot touch the new session either.
    cancel_request(&voice, "slow-device").await;
    assert_eq!(session_phase(&voice).unwrap().0, fresh);
    cancel_request(&voice, "fresh").await;
    assert!(voice.session.lock().unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn voice_request_cancel_racing_late_completion_returns_no_capture() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    let played = Arc::new(AtomicBool::new(false));
    // The cancel is recorded after the worker committed but before Start replies.
    let marker = voice.clone();
    let error = voice
        .start_with(
            "late".into(),
            profile(),
            async { Ok(()) },
            fake_worker(None, played, move || marker.mark_cancelled("late").unwrap()),
        )
        .await
        .unwrap_err();
    assert_eq!(error, CANCELLED);
    assert!(
        voice.session.lock().unwrap().is_none(),
        "the worker is joined and released"
    );
    fresh_start_works(&voice, "after-late").await;
}

#[test]
fn voice_cancelled_requests_are_bounded_and_expire() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    for i in 0..MAX_CANCELLED_REQUESTS + 10 {
        voice.mark_cancelled(&format!("r{i}")).unwrap();
    }
    assert_eq!(
        voice.cancelled.lock().unwrap().len(),
        MAX_CANCELLED_REQUESTS
    );
    assert!(!voice.request_cancelled("r0"));
    assert!(voice.request_cancelled(&format!("r{}", MAX_CANCELLED_REQUESTS + 9)));
    voice.mark_cancelled("r20").unwrap();
    assert_eq!(
        voice.cancelled.lock().unwrap().len(),
        MAX_CANCELLED_REQUESTS
    );
    let old = Instant::now()
        .checked_sub(CANCELLED_REQUEST_TTL + Duration::from_secs(1))
        .unwrap();
    voice
        .cancelled
        .lock()
        .unwrap()
        .push_front(("expired".into(), old));
    assert!(!voice.request_cancelled("expired"));
    assert_eq!(
        voice.cancelled.lock().unwrap().len(),
        MAX_CANCELLED_REQUESTS
    );
    assert!(valid_request("").is_err() && valid_request("a\nb").is_err());
    assert!(valid_request(&"a".repeat(129)).is_err() && valid_request("ok").is_ok());
}
