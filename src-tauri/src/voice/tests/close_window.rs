//! Closing (hiding) the main window: a recording dictation is stopped and transcribed as Stop
//! would, a starting one is cancelled, and transcribing or failed (awaiting Retry) ones stay.
use super::*;

fn with_audio(voice: &Voice, id: &str, phase: Phase, endpoint: String) {
    install_session(voice, id, phase);
    let (_, audio) = watch::channel(Some(Ok(wav())));
    let mut guard = voice.session.lock().unwrap();
    let s = guard.as_mut().unwrap();
    s.profile = snapshot(endpoint);
    s.audio = audio;
}

fn phase(voice: &Voice) -> Option<Phase> {
    voice.session.lock().unwrap().as_ref().map(|s| s.phase)
}

#[tokio::test]
async fn closing_while_recording_stops_and_transcribes_like_stop() {
    let (endpoint, upload, server) = mock(response("200 OK", r#"{"text":"kept speech"}"#, "")).await;
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    let (cancelled, stopped) = install_session(&voice, "live", Phase::Recording);
    {
        let (_, audio) = watch::channel(Some(Ok(wav())));
        let mut guard = voice.session.lock().unwrap();
        let s = guard.as_mut().unwrap();
        s.profile = snapshot(endpoint);
        s.audio = audio;
    }
    let closing = voice.close(None).expect("a recording dictation is transcribed");
    assert!(stopped.try_recv().is_ok(), "the microphone was told to stop");
    assert!(!*cancelled.borrow(), "it was not cancelled");
    // The composer's own Stop (as on a thread switch) joins the same transcription.
    let joined = voice.transcribe(None, "live", false).await.unwrap();
    assert_eq!((joined.capture_id.as_str(), joined.text.as_str()), ("live", "kept speech"));
    tokio::time::timeout(Duration::from_secs(5), closing).await.unwrap().unwrap();
    assert!(voice.session.lock().unwrap().is_none(), "a finished transcription releases the session");
    assert!(String::from_utf8_lossy(&upload.await.unwrap()).contains("RIFF"));
    server.await.unwrap();
}

#[tokio::test]
async fn closing_during_transcription_leaves_it_running() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    let (cancelled, stopped) = install_session(&voice, "busy", Phase::Transcribing);
    assert!(voice.close(None).is_none());
    assert!(phase(&voice) == Some(Phase::Transcribing));
    assert!(!*cancelled.borrow() && stopped.try_recv().is_err(), "nothing was cancelled or stopped");
}

#[tokio::test]
async fn closing_while_awaiting_retry_keeps_the_audio() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    with_audio(&voice, "failed", Phase::Failed, "http://127.0.0.1:1/never".into());
    assert!(voice.close(None).is_none());
    assert!(phase(&voice) == Some(Phase::Failed));
    assert!(voice.transcription_failure("failed", "upload failed".into()).retryable, "Retry still has its audio");
}

#[tokio::test]
async fn closing_while_starting_cancels_before_the_microphone_opens() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    let (cancelled, _stopped) = install_session(&voice, "starting", Phase::Starting);
    assert!(voice.close(None).is_none());
    assert!(*cancelled.borrow(), "the pending Start is cancelled");
    assert!(voice.session.lock().unwrap().is_none());
    assert!(!voice.recording("starting"), "a late device open cannot commit to recording");
}

#[tokio::test]
async fn exit_still_cancels_every_phase() {
    for p in [Phase::Starting, Phase::Recording, Phase::Transcribing, Phase::Failed] {
        let dir = Temp::new();
        let voice = Voice::new(dir.0.clone());
        let (cancelled, _stopped) = install_session(&voice, "any", p);
        voice.shutdown();
        assert!(*cancelled.borrow());
        assert!(voice.session.lock().unwrap().is_none());
    }
}

#[tokio::test]
async fn stop_racing_the_window_close_still_gets_the_transcript() {
    let (endpoint, _upload, server) = mock(response("200 OK", r#"{"text":"raced speech"}"#, "")).await;
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    with_audio(&voice, "raced", Phase::Recording, endpoint);
    // Stop's join check runs before the window closes...
    assert!(voice.closed_transcription("raced").is_none());
    // ...then close() claims the recording...
    let closing = voice.close(None).expect("a recording dictation is transcribed");
    // ...and only then does Stop try to claim it: it joins the close's transcription.
    let stopped = voice.claim_and_transcribe(None, "raced", false).await.unwrap();
    assert_eq!((stopped.capture_id.as_str(), stopped.text.as_str()), ("raced", "raced speech"));
    tokio::time::timeout(Duration::from_secs(5), closing).await.unwrap().unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn a_stop_after_a_failed_close_transcription_sends_the_audio_again() {
    let (failing, _first, first_server) = mock(response("500 Internal Server Error", r#"{"error":"down"}"#, "")).await;
    let (working, second, second_server) = mock(response("200 OK", r#"{"text":"second try"}"#, "")).await;
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    // The window closes while the composer's voice_start is still pending...
    with_audio(&voice, "raced", Phase::Recording, failing);
    let closing = voice.close(None).expect("a recording dictation is transcribed");
    tokio::time::timeout(Duration::from_secs(5), closing).await.unwrap().unwrap();
    first_server.await.unwrap();
    // ...its transcription fails, keeping the audio for Retry...
    assert!(phase(&voice) == Some(Phase::Failed));
    voice.session.lock().unwrap().as_mut().unwrap().profile = snapshot(working);
    // ...and the composer's first Retry (sent as Stop, since it never saw the capture stop)
    // sends that audio again instead of getting the stored failure back.
    let retried = voice.transcribe(None, "raced", false).await.unwrap();
    assert_eq!((retried.capture_id.as_str(), retried.text.as_str()), ("raced", "second try"));
    assert!(voice.closed_transcription("raced").is_none(), "the stale close result is gone");
    assert!(String::from_utf8_lossy(&second.await.unwrap()).contains("RIFF"));
    second_server.await.unwrap();
}

#[tokio::test]
async fn a_stop_that_joined_the_close_transcription_consumes_its_result() {
    let (failing, _upload, server) = mock(response("500 Internal Server Error", r#"{"error":"down"}"#, "")).await;
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    with_audio(&voice, "joined", Phase::Recording, failing);
    let closing = voice.close(None).expect("a recording dictation is transcribed");
    // Stop arrives while the close transcription runs: it joins and gets that failure.
    assert!(voice.transcribe(None, "joined", false).await.is_err());
    tokio::time::timeout(Duration::from_secs(5), closing).await.unwrap().unwrap();
    server.await.unwrap();
    assert!(voice.closed_transcription("joined").is_none(), "a joined result is not handed out again");
    assert!(phase(&voice) == Some(Phase::Failed), "Retry still has the audio");
}

#[tokio::test]
async fn a_refused_start_keeps_the_close_transcription_for_the_old_stop() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    // The window-close transcription of "closed" is still running...
    install_session(&voice, "closed", Phase::Transcribing);
    let (_done, joined) = watch::channel(None);
    *voice.closing.lock().unwrap() = Some(("closed".into(), joined));
    // ...so a new Start is refused before it reserves...
    let spawned = Arc::new(AtomicBool::new(false));
    let error = voice.start_with("next".into(), profile(), async { Ok(()) }, never_spawn(spawned.clone())).await.unwrap_err();
    assert_eq!(error, ACTIVE);
    assert!(!spawned.load(Ordering::Acquire));
    // ...and the composer's Stop for "closed" can still join that transcription.
    assert!(voice.closed_transcription("closed").is_some(), "a refused Start forgets nothing");
}

/// The capture worker commits to Recording before `voice_start` confirms it; a window close in
/// that gap cancels the Start (as in Starting) rather than transcribing audio nobody asked for.
#[tokio::test]
async fn closing_before_start_confirms_cancels_instead_of_transcribing() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    let (committed_tx, committed) = std::sync::mpsc::channel();
    let spawn: Spawn = Box::new(move |io: StartIo| {
        std::thread::Builder::new().spawn(move || {
            if !io.voice.recording(&io.id) {
                let _ = io.ready.send(Err(CANCELLED.into()));
                return;
            }
            let _ = committed_tx.send(());
            // Holds the device open (not yet "ready") until the close stops or cancels it.
            while !*io.cancel.borrow() {
                match io.stop.recv_timeout(Duration::from_millis(5)) {
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (),
                    _ => break,
                }
            }
            let _ = io.done.send(Some(Ok(wav())));
            let _ = io.ready.send(Ok(()));
        })
    });
    let starter = voice.clone();
    let start = tokio::spawn(async move { starter.start_with("closing-start".into(), profile(), async { Ok(()) }, spawn).await });
    tokio::task::spawn_blocking(move || committed.recv_timeout(Duration::from_secs(5)).unwrap()).await.unwrap();
    assert!(phase(&voice) == Some(Phase::Recording), "the worker committed before voice_start returned");
    let closer = voice.clone();
    let transcription = tokio::task::spawn_blocking(move || closer.close(None)).await.unwrap();
    assert!(transcription.is_none(), "no transcription starts for an unconfirmed recording");
    let result = tokio::time::timeout(Duration::from_secs(5), start).await.unwrap().unwrap();
    assert_eq!(result.unwrap_err(), CANCELLED, "voice_start rejects with the quiet cancel");
    assert!(voice.session.lock().unwrap().is_none(), "the cancelled session is released");
    assert!(voice.closing.lock().unwrap().is_none(), "no window-close transcription to join");
    fresh_start_works(&voice, "after-close").await;
}
