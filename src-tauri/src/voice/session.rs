//! Dictation session bookkeeping: reserving a session, its phases, cancelling it, and claiming
//! its audio for transcription.
use super::{config::Snapshot, local, Event, Failure, Voice, ACTIVE, CANCELLED, MAX_AUDIO_BYTES, MAX_SECONDS, MODEL_GONE};
use super::{CANCELLED_REQUEST_TTL, MAX_CANCELLED_REQUESTS};
use crate::Result;
use std::{sync::Arc, time::Instant};
use tauri::{Emitter, Manager};
use tokio::sync::watch;

/// A session claimed for transcription: what it sends and how it is cancelled.
pub(super) struct Claimed {
    pub(super) request_id: String,
    pub(super) profile: Snapshot,
    pub(super) route: Option<local::Route>,
    pub(super) audio: watch::Receiver<Option<Result<Arc<Vec<u8>>>>>,
    pub(super) cancel: watch::Receiver<bool>,
}

/// Channels a capture worker needs; the real worker adds the app handle.
pub(in crate::voice) struct StartIo {
    pub voice: Voice,
    pub id: String,
    pub stop: std::sync::mpsc::Receiver<()>,
    pub cancel: watch::Receiver<bool>,
    pub done: watch::Sender<Option<Result<Arc<Vec<u8>>>>>,
    pub ready: tokio::sync::oneshot::Sender<Result<()>>,
}

/// The capture worker's ends of a session's stop, cancel and audio channels.
pub(super) type WorkerChannels = (
    std::sync::mpsc::Receiver<()>,
    watch::Receiver<bool>,
    watch::Sender<Option<Result<Arc<Vec<u8>>>>>,
);

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
    Starting,
    Recording,
    Transcribing,
    Failed,
    Cancelled,
}

pub(super) struct Session {
    pub(super) id: String,
    pub(super) request_id: String,
    pub(super) profile: Snapshot,
    /// The local model this dictation transcribes with, recorded when the session is reserved.
    pub(super) route: Option<local::Route>,
    pub(super) phase: Phase,
    /// `voice_start` confirmed the recording and returned its capture id; until then a window
    /// close cancels it like a Starting one (the composer has no capture to stop yet).
    pub(super) confirmed: bool,
    pub(super) started: Instant,
    pub(super) elapsed_ms: u64,
    pub(super) stop: std::sync::mpsc::Sender<()>,
    pub(super) cancel: watch::Sender<bool>,
    pub(super) audio: watch::Receiver<Option<Result<Arc<Vec<u8>>>>>,
    pub(super) thread: Option<std::thread::JoinHandle<()>>,
}

impl Voice {
    /// Fails closed: a poisoned list refuses to start rather than ignore a cancel.
    pub(super) fn request_cancelled(&self, request_id: &str) -> bool {
        let Ok(mut list) = self.cancelled.lock() else {
            return true;
        };
        while list
            .front()
            .is_some_and(|(_, at)| at.elapsed() >= CANCELLED_REQUEST_TTL)
        {
            list.pop_front();
        }
        list.iter().any(|(id, _)| id == request_id)
    }

    pub(super) fn mark_cancelled(&self, request_id: &str) -> Result<()> {
        if self.request_cancelled(request_id) {
            return Ok(());
        }
        let mut list = self
            .cancelled
            .lock()
            .map_err(|_| "Voice input is unavailable.".to_owned())?;
        if list.len() >= MAX_CANCELLED_REQUESTS {
            list.pop_front();
        }
        list.push_back((request_id.to_owned(), Instant::now()));
        Ok(())
    }

    pub(super) fn recording(&self, id: &str) -> bool {
        let Ok(mut guard) = self.session.lock() else {
            return false;
        };
        let Some(s) = guard
            .as_mut()
            .filter(|s| s.id == id && s.phase == Phase::Starting && !*s.cancel.borrow())
        else {
            return false;
        };
        // Cancel marks the request before it takes the session lock, so this sees it.
        if self.request_cancelled(&s.request_id) {
            return false;
        }
        s.phase = Phase::Recording;
        s.started = Instant::now();
        true
    }

    pub(super) fn capture_failed(&self, app: &tauri::AppHandle, id: &str, error: &str) {
        let changed = if let Ok(mut guard) = self.session.lock() {
            if let Some(s) = guard
                .as_mut()
                .filter(|s| s.id == id && s.phase == Phase::Recording)
            {
                s.elapsed_ms = (s.started.elapsed().as_millis() as u64).min(MAX_SECONDS * 1000);
                s.phase = Phase::Failed;
                true
            } else {
                false
            }
        } else {
            false
        };
        if changed {
            let message = error.replace(
                "Retry to transcribe the captured audio",
                "Choose Transcribe recording to send the captured audio",
            );
            self.emit(app, id, "error", 0.0, Some(&message));
        }
    }

    /// Cancels the session matching every given id; `None` for both cancels any session.
    pub(super) fn cancel(
        &self,
        app: Option<&tauri::AppHandle>,
        id: Option<&str>,
        request_id: Option<&str>,
    ) -> Result<()> {
        if let Some(request_id) = request_id {
            // Mark before taking the session lock: a Start that has not reserved yet sees the mark.
            self.mark_cancelled(request_id)?;
        }
        self.cancel_where(app, |s| {
            id.is_none_or(|id| s.id == id) && request_id.is_none_or(|r| s.request_id == r)
        })
    }

    /// Cancels the session if `matches` holds for it (checked under the session lock).
    pub(super) fn cancel_where(&self, app: Option<&tauri::AppHandle>, matches: impl Fn(&Session) -> bool) -> Result<()> {
        let (capture_id, thread) = {
            let mut guard = self
                .session
                .lock()
                .map_err(|_| "Voice input is unavailable.".to_owned())?;
            let Some(s) = guard.as_mut().filter(|s| matches(s)) else {
                return Ok(());
            };
            if s.phase == Phase::Cancelled {
                return Ok(());
            }
            s.phase = Phase::Cancelled;
            let _ = s.cancel.send(true);
            let _ = s.stop.send(());
            if let Some(window) = app.and_then(|app| app.get_webview_window("main")) {
                let _ = window.emit(
                    "voice-event",
                    Event {
                        capture_id: s.id.clone(),
                        request_id: s.request_id.clone(),
                        phase: "cancelled".into(),
                        elapsed_ms: s.elapsed_ms,
                        level: 0.0,
                        message: None,
                    },
                );
            }
            (s.id.clone(), s.thread.take())
        };
        if let Some(thread) = thread {
            let _ = thread.join();
        }
        let mut guard = self
            .session
            .lock()
            .map_err(|_| "Voice input is unavailable.".to_owned())?;
        if guard.as_ref().is_some_and(|s| s.id == capture_id) {
            *guard = None;
        }
        Ok(())
    }

    /// Installs a `Starting` session unless its request was cancelled, another recording or a
    /// Settings test recording is live, or its local model was deleted (a delete holds this lock while it removes one).
    pub(super) fn reserve(&self, session: Session) -> Result<()> {
        let mut guard = self
            .session
            .lock()
            .map_err(|_| "Voice input is unavailable.".to_owned())?;
        // Under the session lock: a request cancel either marked first or finds this session.
        if self.request_cancelled(&session.request_id) {
            return Err(CANCELLED.into());
        }
        // A cancelled session is only waiting for its worker to join; a fresh request may start.
        if guard
            .as_ref()
            .is_some_and(|s| !matches!(s.phase, Phase::Failed | Phase::Cancelled))
        {
            return Err(ACTIVE.into());
        }
        // A Settings mic or model test holds the microphone (as a dictation does for them).
        if let Some(busy) = self.local.test_recording() {
            return Err(busy.into());
        }
        if session.route.as_ref().is_some_and(|r| !r.model.is_file()) {
            return Err(MODEL_GONE.into());
        }
        *guard = Some(session);
        Ok(())
    }

    /// The session is still this recording and nothing cancelled it; marks it confirmed, so a
    /// window close from now on transcribes it instead of cancelling it.
    pub(super) fn confirm_recording(&self, id: &str) -> Result<()> {
        let mut guard = self
            .session
            .lock()
            .map_err(|_| "Voice input is unavailable.".to_owned())?;
        let s = guard
            .as_mut()
            .filter(|s| s.id == id && s.phase == Phase::Recording && !*s.cancel.borrow())
            .filter(|s| !self.request_cancelled(&s.request_id))
            .ok_or(CANCELLED)?;
        s.confirmed = true;
        Ok(())
    }

    /// `release` drops the session (success, or no usable audio to retry); otherwise it waits for Retry.
    pub(super) fn finish_transcription(&self, id: &str, release: bool) -> Result<()> {
        let mut guard = self
            .session
            .lock()
            .map_err(|_| "Voice input is unavailable.".to_owned())?;
        let s = guard
            .as_mut()
            .filter(|s| s.id == id && s.phase == Phase::Transcribing && !*s.cancel.borrow())
            .ok_or(CANCELLED)?;
        if release {
            *guard = None;
        } else {
            s.phase = Phase::Failed;
        }
        Ok(())
    }

    /// Moves the session to Transcribing (stopping its microphone) from a phase `allowed` accepts.
    pub(super) fn claim(&self, id: &str, allowed: fn(Phase) -> bool) -> Result<Claimed> {
        let mut guard = self
            .session
            .lock()
            .map_err(|_| "Voice input is unavailable.".to_owned())?;
        let s = guard.as_mut().filter(|s| s.id == id).ok_or(
            "This voice recording is no longer available. Discard it and record again.",
        )?;
        if !allowed(s.phase) {
            return Err("This voice recording is not ready to transcribe.".into());
        }
        if s.phase == Phase::Recording {
            s.elapsed_ms = (s.started.elapsed().as_millis() as u64).min(MAX_SECONDS * 1000);
        }
        s.phase = Phase::Transcribing;
        let _ = s.stop.send(());
        Ok(Claimed {
            request_id: s.request_id.clone(),
            profile: s.profile.clone(),
            route: s.route.clone(),
            audio: s.audio.clone(),
            cancel: s.cancel.subscribe(),
        })
    }

    /// Read after transcription settles: only the matching retained WAV can be sent again.
    pub(super) fn transcription_failure(&self, id: &str, message: String) -> Failure {
        let retryable = self.session.lock().ok().is_some_and(|guard| {
            guard.as_ref().is_some_and(|s| {
                s.id == id
                    && s.phase == Phase::Failed
                    && !*s.cancel.borrow()
                    && s.audio.borrow().as_ref().is_some_and(|audio| {
                        audio
                            .as_ref()
                            .is_ok_and(|wav| wav.len() > 44 && wav.len() <= MAX_AUDIO_BYTES)
                    })
            })
        });
        Failure { message, retryable }
    }

    /// The session `id` is awaiting Retry (its last transcription failed and kept the audio).
    pub(super) fn failed(&self, id: &str) -> bool {
        self.session.lock().is_ok_and(|guard| guard.as_ref().is_some_and(|s| s.id == id && s.phase == Phase::Failed))
    }
}
