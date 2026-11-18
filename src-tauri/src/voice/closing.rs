//! Closing (hiding) the main window: the test recordings stop, a starting dictation is
//! cancelled, and a recording one is transcribed as Stop would; the composer's Stop joins it.
use super::{local, Phase, Transcript, Voice, CANCELLED};
use crate::Result;
use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::sync::watch;

pub(super) type Closed = (String, watch::Receiver<Option<Result<String>>>);

/// Event `voice://transcript` `{ captureId, requestId, text }`: the transcript of a dictation
/// that closing the window stopped (the composer's Stop for that capture also resolves with it).
const TRANSCRIPT_EVENT: &str = "voice://transcript";
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosedTranscript<'a> {
    capture_id: &'a str,
    request_id: &'a str,
    text: &'a str,
}

impl Voice {
    /// Main window closed (on macOS and Windows only hidden). Downloads keep going and the
    /// loaded model stays (its idle unload still applies); see `close`.
    pub(crate) fn stop_recording(&self, app: &tauri::AppHandle) {
        let _ = self.close(Some(app.clone()));
    }

    /// Stops the mic and model tests; cancels a dictation still starting (no microphone opens, or
    /// it opened but `voice_start` has not confirmed it);
    /// stops and transcribes a recording one exactly as Stop does (the returned task), and the
    /// composer's Stop joins that transcription; leaves Transcribing and Failed (Retry) alone.
    pub(super) fn close(&self, app: Option<tauri::AppHandle>) -> Option<tauri::async_runtime::JoinHandle<()>> {
        self.end_tests(app.as_ref());
        // A recording voice_start has not confirmed yet is cancelled like a Starting one: the
        // composer gets the `cancelled` event and goes idle; voice_start then rejects quietly.
        let _ = self.cancel_where(app.as_ref(), |s| s.phase == Phase::Starting || (s.phase == Phase::Recording && !s.confirmed));
        // Held across the claim, so a Stop arriving now either claims first or joins this one.
        let mut closing = self.closing.lock().ok()?;
        let id = self.session.lock().ok()?.as_ref().filter(|s| s.phase == Phase::Recording && s.confirmed).map(|s| s.id.clone())?;
        let claimed = self.claim(&id, |phase| phase == Phase::Recording).ok()?;
        let (done, joined) = watch::channel(None);
        *closing = Some((id.clone(), joined));
        drop(closing);
        let voice = self.clone();
        Some(tauri::async_runtime::spawn(async move {
            let request_id = claimed.request_id.clone();
            let result = voice.transcribe_claimed(app.as_ref(), &id, claimed).await;
            if let (Some(window), Ok(transcript)) = (app.as_ref().and_then(|a| a.get_webview_window("main")), &result) {
                let _ = window.emit(TRANSCRIPT_EVENT, ClosedTranscript { capture_id: &id, request_id: &request_id, text: &transcript.text });
            }
            let _ = done.send(Some(result.map(|t| t.text)));
        }))
    }

    /// Window close: stops the test recordings and tells the webview which it stopped
    /// (`voice://test-ended`; see the IPC contract in `local/mod.rs`). Returns their kinds.
    pub(super) fn end_tests(&self, app: Option<&tauri::AppHandle>) -> Vec<local::test_recordings::TestKind> {
        let ended = self.local.stop_tests();
        if let Some(window) = app.and_then(|a| a.get_webview_window("main")) {
            for &kind in &ended {
                let _ = window.emit(local::test_recordings::TEST_ENDED, local::test_recordings::TestEnded::closed(kind));
            }
        }
        ended
    }

    /// The window-close transcription of `id`, if one was started.
    pub(super) fn closed_transcription(&self, id: &str) -> Option<watch::Receiver<Option<Result<String>>>> {
        let closing = self.closing.lock().ok()?;
        closing.as_ref().filter(|(closed, _)| closed == id).map(|(_, rx)| rx.clone())
    }

    /// Waits for the window-close transcription of `id` (the composer's Stop for that capture),
    /// then forgets it: a later Stop or Retry sends the retained audio again.
    pub(super) async fn join_closed(&self, id: &str, mut joined: watch::Receiver<Option<Result<String>>>) -> Result<Transcript> {
        let result = joined.wait_for(Option::is_some).await.map_err(|_| CANCELLED.to_owned())?.clone();
        self.forget_closed(id);
        result.unwrap_or_else(|| Err(CANCELLED.into())).map(|text| Transcript { capture_id: id.into(), text })
    }

    /// Drops the stored window-close result of `id` once something consumed or superseded it.
    pub(super) fn forget_closed(&self, id: &str) {
        if let Ok(mut closing) = self.closing.lock() {
            if closing.as_ref().is_some_and(|(closed, _)| closed == id) {
                *closing = None;
            }
        }
    }
}
