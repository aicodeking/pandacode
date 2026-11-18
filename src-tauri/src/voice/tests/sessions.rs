use super::*;

#[tokio::test]
async fn voice_terminal_audio_failures_release_session_and_serialize_no_retry() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    let no_audio = capture::Pcm::new(16_000, 1).unwrap().wav().map(Arc::new);
    for audio in [
        None,
        Some(no_audio),
        Some(Ok(Arc::new(vec![0; 44]))),
        Some(Ok(Arc::new(vec![0; MAX_AUDIO_BYTES + 1]))),
    ] {
        install_session(&voice, "empty", Phase::Recording);
        let (_, audio) = watch::channel(audio);
        voice.session.lock().unwrap().as_mut().unwrap().audio = audio;
        let message = voice.transcribe(None, "empty", false).await.err().unwrap();
        assert!(voice.session.lock().unwrap().is_none());
        assert_eq!(
            json(voice.transcription_failure("empty", message.clone())),
            serde_json::json!({
                "message": message, "retryable": false
            })
        );
        let message = voice.transcribe(None, "empty", true).await.err().unwrap();
        assert!(!voice.transcription_failure("empty", message).retryable);
    }
}

#[tokio::test]
async fn voice_authorization_startup_and_state_failures_never_offer_retry() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    let url = reqwest::Url::parse("tauri://localhost/index.html").unwrap();
    let message = authorized_caller("tray", false, &url).unwrap_err();
    assert_eq!(
        json(Failure::terminal(message.clone())),
        serde_json::json!({
            "message": message, "retryable": false
        })
    );
    for phase in [
        Phase::Starting,
        Phase::Recording,
        Phase::Transcribing,
        Phase::Cancelled,
    ] {
        install_session(&voice, "unready", phase);
        let (_, audio) = watch::channel(Some(Ok(wav())));
        voice.session.lock().unwrap().as_mut().unwrap().audio = audio;
        let message = voice.transcribe(None, "unready", true).await.err().unwrap();
        assert!(!voice.transcription_failure("unready", message).retryable);
    }
}

#[tokio::test]
async fn voice_failed_upload_retains_same_wav_and_profile_for_retry() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/transcribe", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut uploads = Vec::new();
        for reply in [
            response("503 Service Unavailable", "{}", ""),
            response("200 OK", r#"{"text":"retried"}"#, ""),
        ] {
            let (mut socket, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut request = Vec::new();
            loop {
                let mut buf = [0u8; 4096];
                let read = socket.read(&mut buf).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buf[..read]);
                if let Some(end) = request.windows(4).position(|s| s == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                    let size: usize = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if request.len() >= end + 4 + size {
                        break;
                    }
                }
            }
            uploads.push(request);
            socket.write_all(reply.as_bytes()).await.unwrap();
        }
        uploads
    });
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    install_session(&voice, "kept", Phase::Recording);
    let kept = wav();
    let (_, audio) = watch::channel(Some(Ok(kept.clone())));
    {
        let mut guard = voice.session.lock().unwrap();
        let s = guard.as_mut().unwrap();
        s.profile = snapshot(endpoint.clone());
        s.audio = audio;
    }
    let message = voice.transcribe(None, "kept", false).await.err().unwrap();
    assert_eq!(
        json(voice.transcription_failure("kept", message.clone())),
        serde_json::json!({
            "message": message, "retryable": true
        })
    );
    assert!(!voice.transcription_failure("stale", message).retryable);
    {
        let guard = voice.session.lock().unwrap();
        let s = guard.as_ref().unwrap();
        assert!(Arc::ptr_eq(
            s.audio.borrow().as_ref().unwrap().as_ref().unwrap(),
            &kept
        ));
        assert_eq!(s.profile.endpoint, endpoint);
        assert_eq!(s.profile.model, "whisper-local");
        assert_eq!(s.profile.key.as_deref(), Some("mock-only-token"));
    }
    let transcript = voice.transcribe(None, "kept", true).await.unwrap();
    assert_eq!(transcript.text, "retried");
    assert!(voice.session.lock().unwrap().is_none());
    for request in server.await.unwrap() {
        assert!(request
            .windows(kept.len())
            .any(|part| part == kept.as_slice()));
        let request = String::from_utf8_lossy(&request);
        assert!(request.contains("whisper-local") && request.contains("Bearer mock-only-token"));
    }
}

#[test]
fn voice_cancel_joins_capture_and_stale_results_cannot_touch_new_session() {
    let dir = Temp::new();
    let voice = Voice::new(dir.0.clone());
    let (cancel, stop) = install_session(&voice, "old", Phase::Starting);
    assert!(voice.recording("old"));
    let exited = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let exited_worker = exited.clone();
    let thread = std::thread::spawn(move || {
        stop.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(*cancel.borrow());
        exited_worker.store(true, std::sync::atomic::Ordering::Release);
    });
    voice.session.lock().unwrap().as_mut().unwrap().thread = Some(thread);
    voice.cancel(None, Some("unrelated"), None).unwrap();
    voice.cancel(None, None, Some("stale-request")).unwrap();
    voice
        .cancel(None, Some("old"), Some("stale-request"))
        .unwrap();
    assert!(voice.session.lock().unwrap().is_some());
    voice.cancel(None, Some("old"), None).unwrap();
    assert!(exited.load(std::sync::atomic::Ordering::Acquire));
    assert!(voice.session.lock().unwrap().is_none());
    voice.cancel(None, Some("old"), None).unwrap();
    install_session(&voice, "cancelling", Phase::Cancelled);
    voice.cancel(None, Some("cancelling"), None).unwrap();
    assert!(voice.session.lock().unwrap().is_some(), "A second cancel must not release the first cancel's capture reservation before its thread joins");
    install_session(&voice, "new", Phase::Transcribing);
    assert!(!voice.recording("old"));
    assert!(voice.finish_transcription("old", true).is_err());
    assert!(voice.finish_transcription("old", false).is_err());
    assert_eq!(voice.session.lock().unwrap().as_ref().unwrap().id, "new");
    voice.finish_transcription("new", false).unwrap();
    assert!(voice.session.lock().unwrap().as_ref().unwrap().phase == Phase::Failed);
    voice.session.lock().unwrap().as_mut().unwrap().phase = Phase::Transcribing;
    voice.finish_transcription("new", true).unwrap();
    assert!(voice.session.lock().unwrap().is_none());
}
