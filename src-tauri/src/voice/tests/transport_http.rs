use super::*;

#[tokio::test]
async fn voice_transport_sends_multipart_and_reads_text() {
    let (endpoint, request, server) =
        mock(response("200 OK", r#"{"text":" hello voice "}"#, "")).await;
    let (cancel, rx) = watch::channel(false);
    let text = transport::transcribe(&snapshot(endpoint), wav(), rx)
        .await
        .unwrap();
    assert_eq!(text, "hello voice");
    let request = request.await.unwrap();
    let request = String::from_utf8_lossy(&request);
    for field in [
        "POST /transcribe",
        "multipart/form-data",
        "Bearer mock-only-token",
        "name=\"file\"",
        "filename=\"dictation.wav\"",
        "audio/wav",
        "RIFF",
        "name=\"model\"",
        "whisper-local",
        "name=\"language\"",
        "en",
    ] {
        assert!(request.contains(field), "{field}");
    }
    drop(cancel);
    server.await.unwrap();
}

#[tokio::test]
async fn voice_transport_rejects_redirect_errors_oversize_and_invalid_text() {
    let cases = [
        response(
            "302 Found",
            "sensitive body mock-only-token",
            "Location: http://127.0.0.1:1/leak\r\n",
        ),
        response("401 Unauthorized", "sensitive body mock-only-token", ""),
        response("200 OK", "not json sensitive body mock-only-token", ""),
        response("200 OK", r#"{"text":""}"#, ""),
        response("200 OK", r#"{"text":"\u0000"}"#, ""),
        response(
            "200 OK",
            &format!(r#"{{"text":"{}"}}"#, "a".repeat(64 * 1024 + 1)),
            "",
        ),
        response("200 OK", &"a".repeat(256 * 1024 + 1), ""),
    ];
    for (i, response) in cases.into_iter().enumerate() {
        let (endpoint, _, server) = mock(response).await;
        let (_cancel, rx) = watch::channel(false);
        let error = transport::transcribe(&snapshot(endpoint), wav(), rx)
            .await
            .unwrap_err();
        assert!(!error.contains("mock-only-token") && !error.contains("sensitive body"));
        // Settings fixes never apply to Retry: the guidance must say to record again.
        if i < 2 {
            assert!(error.ends_with(transport::SETTINGS_FIX), "{error}");
        }
        server.await.unwrap();
    }
    for status in ["404 Not Found", "500 Internal Server Error"] {
        let (endpoint, _, server) = mock(response(status, "{}", "")).await;
        let (_cancel, rx) = watch::channel(false);
        let error = transport::transcribe(&snapshot(endpoint), wav(), rx)
            .await
            .unwrap_err();
        assert!(
            error.contains("original settings") && error.contains("discard and record again"),
            "{error}"
        );
        server.await.unwrap();
    }
    let (_cancel, rx) = watch::channel(false);
    let error = transport::transcribe(
        &snapshot("http://127.0.0.1:1/unreachable".into()),
        wav(),
        rx,
    )
    .await
    .unwrap_err();
    assert!(error.ends_with(transport::SETTINGS_FIX), "{error}");
}

#[tokio::test]
async fn voice_transport_cancel_interrupts_wait_and_retry_reuses_audio() {
    let (endpoint, request, server) = mock(String::new()).await;
    let (cancel, rx) = watch::channel(false);
    let profile = snapshot(endpoint);
    let audio = wav();
    let kept = audio.clone();
    let pending = tokio::spawn(async move { transport::transcribe(&profile, audio, rx).await });
    request.await.unwrap();
    cancel.send(true).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err(),
        CANCELLED
    );
    server.await.unwrap();
    let (endpoint, _, server) = mock(response("200 OK", r#"{"text":"retried"}"#, "")).await;
    let (_cancel, rx) = watch::channel(false);
    assert_eq!(
        transport::transcribe(&snapshot(endpoint), kept, rx)
            .await
            .unwrap(),
        "retried"
    );
    server.await.unwrap();
    let (cancel, rx) = watch::channel(false);
    cancel.send(true).unwrap();
    assert_eq!(
        transport::transcribe(&snapshot("http://127.0.0.1:1/no-request".into()), wav(), rx)
            .await
            .unwrap_err(),
        CANCELLED
    );
}
