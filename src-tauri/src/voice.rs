//! Desktop dictation: no microphone or provider traffic until explicit user actions.
mod capture;
mod closing;
mod config;
pub(crate) mod local;
mod permission;
mod session;
#[cfg(test)]
mod tests;
mod transport;

use crate::Result;
use closing::Closed;
use config::{validate_endpoint, Configuration, ProfileInput, Snapshot};
use serde::Serialize;
use std::{
    collections::VecDeque,
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use session::{Claimed, Phase, Session, StartIo, WorkerChannels};
use tokio::sync::watch;

const MAX_SECONDS: u64 = 120;
const MAX_AUDIO_BYTES: usize = 16 * 1024 * 1024;
const CANCELLED: &str = "Voice input was cancelled.";
const CANCELLED_REQUEST_TTL: Duration = Duration::from_secs(600);
const MAX_CANCELLED_REQUESTS: usize = 64;
const ACTIVE: &str = "A voice recording is already active. Stop or cancel it first.";
const MODEL_GONE: &str = "This speech model was deleted. Choose a model in Settings → Voice.";

#[derive(Clone)]
pub(crate) struct Voice {
    dir: PathBuf,
    config_lock: Arc<Mutex<()>>,
    session: Arc<Mutex<Option<Session>>>,
    /// Requests cancelled by the composer, possibly before `voice_start` reserved them.
    cancelled: Arc<Mutex<VecDeque<(String, Instant)>>>,
    /// On-device models, downloads and the speech worker (voice/local).
    local: Arc<local::Local>,
    /// The transcription a window close started (capture id, result), joined by its Stop.
    closing: Arc<Mutex<Option<Closed>>>,
}

fn valid_request(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        return Err("Invalid voice recording request.".into());
    }
    Ok(())
}

/// Where a recording goes, fixed at Start: a remote profile, or (with `route`) a local model.
pub(super) struct Target {
    pub(in crate::voice) remote: Snapshot,
    pub(in crate::voice) route: Option<local::Route>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    capture_id: String,
    request_id: String,
    phase: String,
    elapsed_ms: u64,
    level: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    capture_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    capture_id: String,
    text: String,
}
#[derive(Debug, Serialize)]
pub struct Failure {
    message: String,
    retryable: bool,
}
impl Failure {
    fn terminal(message: String) -> Self {
        Self {
            message,
            retryable: false,
        }
    }
}

fn authorized_caller(label: &str, headless: bool, url: &reqwest::Url) -> Result<()> {
    if label != "main" || headless {
        return Err("Voice input is available only in the local main app window.".into());
    }
    let local = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420);
    if !(local
        || (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")))
    {
        return Err("Voice input is available only from PandaCode's local app content.".into());
    }
    Ok(())
}

fn authorized(window: &tauri::WebviewWindow) -> Result<()> {
    // Tauri injects the invoking window; callers cannot supply its identity.
    let url = window
        .url()
        .map_err(|_| "Could not verify the voice input window.".to_owned())?;
    authorized_caller(window.label(), crate::headless::active(), &url)
}

impl Voice {
    pub(crate) fn new(dir: PathBuf) -> Self {
        let voice = Self {
            local: Arc::new(local::Local::new(&dir)),
            dir,
            config_lock: Arc::new(Mutex::new(())),
            session: Arc::new(Mutex::new(None)),
            cancelled: Arc::new(Mutex::new(VecDeque::new())),
            closing: Arc::default(),
        };
        // The saved "Unload after" holds from launch, not only after the first dictation.
        if let Ok(prefs) = voice.preferences() {
            voice.local.set_unload_after(prefs.unload_after.duration());
        }
        voice
    }

    fn emit(
        &self,
        app: &tauri::AppHandle,
        id: &str,
        phase: &str,
        level: f32,
        message: Option<&str>,
    ) {
        if let Ok(guard) = self.session.lock() {
            if let Some(s) = guard
                .as_ref()
                .filter(|s| s.id == id && s.phase != Phase::Cancelled && !*s.cancel.borrow())
            {
                // Meter callbacks from a stopping stream must not revive the recording UI.
                if phase == "recording" && s.phase != Phase::Recording {
                    return;
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit(
                        "voice-event",
                        Event {
                            capture_id: s.id.clone(),
                            request_id: s.request_id.clone(),
                            phase: phase.into(),
                            elapsed_ms: if s.phase == Phase::Recording {
                                (s.started.elapsed().as_millis() as u64).min(MAX_SECONDS * 1000)
                            } else {
                                s.elapsed_ms
                            },
                            level,
                            message: message.map(str::to_owned),
                        },
                    );
                }
            }
        }
    }

    /// App exit: also cancels the active download and unloads the engine.
    pub(crate) fn shutdown(&self) {
        let _ = self.cancel(None, None, None);
        self.local.shutdown();
    }

    /// The destination for a new recording: an explicit profile, else the saved destination.
    fn destination(&self, profile_id: Option<String>) -> Result<(Target, Option<String>)> {
        use config::{Destination, DestinationMode};
        let prefs = self.preferences();
        let device = prefs.as_ref().ok().and_then(|p| p.device_name.clone());
        if let Some(id) = profile_id.filter(|id| !id.is_empty()) {
            return Ok((Target { remote: self.snapshot(&id)?, route: None }, device));
        }
        let prefs = prefs?;
        match &prefs.destination {
            Destination::Profile(p) => Ok((Target { remote: self.snapshot(&p.profile_id)?, route: None }, device)),
            Destination::Mode(DestinationMode::Off) => {
                Err("Voice input is off. Choose a speech model or provider in Settings → Voice.".into())
            }
            Destination::Mode(DestinationMode::Local) => {
                let route = self.local.route_for(&prefs)?;
                self.local.set_unload_after(prefs.unload_after.duration());
                // Remote fields stay empty: this capture never leaves the device.
                let none = Snapshot { endpoint: String::new(), model: String::new(), language: None, key: None };
                Ok((Target { remote: none, route: Some(route) }, device))
            }
        }
    }

    async fn start(
        &self,
        app: tauri::AppHandle,
        request_id: String,
        profile_id: Option<String>,
    ) -> Result<Started> {
        valid_request(&request_id)?;
        if self.request_cancelled(&request_id) {
            return Err(CANCELLED.into());
        }
        let (target, device) = self.destination(profile_id)?;
        let worker_app = app.clone();
        let id = self
            .start_with(request_id, target, permission::request(), move |io| {
                std::thread::Builder::new()
                    .name("voice-capture".into())
                    .spawn(move || {
                        capture::run(capture::Worker {
                            voice: io.voice,
                            app: worker_app,
                            id: io.id,
                            stop: io.stop,
                            cancel: io.cancel,
                            done: io.done,
                            ready: io.ready,
                            device,
                        })
                    })
            })
            .await?;
        self.emit(&app, &id, "recording", 0.0, None);
        Ok(Started { capture_id: id })
    }

    /// Reserves, asks permission and opens the device, checking for cancellation between steps.
    /// `permission` and `spawn` are injected so tests can delay each step without a microphone.
    async fn start_with<P, S>(
        &self,
        request_id: String,
        target: Target,
        permission: P,
        spawn: S,
    ) -> Result<String>
    where
        P: Future<Output = Result<()>>,
        S: FnOnce(StartIo) -> std::io::Result<std::thread::JoinHandle<()>>,
    {
        let id = uuid::Uuid::new_v4().to_string();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (audio_tx, audio_rx) = watch::channel(None);
        self.reserve(Session {
            id: id.clone(),
            request_id,
            profile: target.remote,
            route: target.route,
            phase: Phase::Starting,
            confirmed: false,
            started: Instant::now(),
            elapsed_ms: 0,
            stop: stop_tx,
            cancel: cancel_tx,
            audio: audio_rx,
            thread: None,
        })?;
        // Reserving replaced the settled closed dictation; its joinable result goes. A refused
        // Start keeps it, so that dictation's own Stop can still join it.
        if let Ok(mut closing) = self.closing.lock() {
            *closing = None;
        }
        let result = self
            .open_device(&id, (stop_rx, cancel_rx, audio_tx), permission, spawn)
            .await
            // A cancel that lands while the device opens must not hand back a live capture id.
            .and_then(|()| self.confirm_recording(&id));
        if let Err(error) = result {
            self.cancel(None, Some(&id), None)?;
            return Err(error);
        }
        Ok(id)
    }

    /// Waits for permission, then spawns the capture worker and waits until the device is ready.
    async fn open_device<P, S>(&self, id: &str, channels: WorkerChannels, permission: P, spawn: S) -> Result<()>
    where
        P: Future<Output = Result<()>>,
        S: FnOnce(StartIo) -> std::io::Result<std::thread::JoinHandle<()>>,
    {
        let (stop, mut cancel_rx, done) = channels;
        tokio::select! {
            biased;
            _ = cancel_rx.changed() => return Err(CANCELLED.into()),
            result = tokio::time::timeout(Duration::from_secs(120), permission) => {
                result.map_err(|_| "Microphone permission request timed out. Try again.".to_owned())??;
            }
        }
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        {
            let mut guard = self.session.lock().map_err(|_| "Voice input is unavailable.".to_owned())?;
            let s = guard.as_mut().filter(|s| s.id == id && s.phase == Phase::Starting && !*s.cancel.borrow()).ok_or(CANCELLED)?;
            if self.request_cancelled(&s.request_id) {
                return Err(CANCELLED.into());
            }
            let io = StartIo { voice: self.clone(), id: id.to_owned(), stop, cancel: cancel_rx.clone(), done, ready: ready_tx };
            s.thread = Some(spawn(io).map_err(|_| "Could not start the microphone worker.".to_owned())?);
        }
        tokio::select! {
            biased;
            _ = cancel_rx.changed() => Err(CANCELLED.into()),
            result = ready_rx => result.map_err(|_| "The microphone worker stopped unexpectedly.".to_owned())?,
        }
    }

    async fn transcribe(
        &self,
        app: Option<&tauri::AppHandle>,
        id: &str,
        retry: bool,
    ) -> Result<Transcript> {
        // A Stop joins the window-close transcription, unless that already failed: then the Stop
        // is the composer's Retry (it never saw the capture stop) and sends the audio again.
        if !retry && !self.failed(id) {
            if let Some(joined) = self.closed_transcription(id) {
                return self.join_closed(id, joined).await;
            }
        }
        self.claim_and_transcribe(app, id, retry).await
    }

    /// The rest of `transcribe` once no window-close transcription was found to join.
    async fn claim_and_transcribe(&self, app: Option<&tauri::AppHandle>, id: &str, retry: bool) -> Result<Transcript> {
        let allowed: fn(Phase) -> bool = if retry { |p| p == Phase::Failed } else { |p| matches!(p, Phase::Recording | Phase::Failed) };
        let claimed = match self.claim(id, allowed) {
            Ok(claimed) => claimed,
            // close() claimed it after Stop's join check; it publishes its transcription before
            // releasing `closing`, so this re-check finds it.
            Err(error) if !retry => match self.closed_transcription(id) {
                Some(joined) => return self.join_closed(id, joined).await,
                None => return Err(error),
            },
            Err(error) => return Err(error),
        };
        // This transcription supersedes a failed window-close one.
        self.forget_closed(id);
        self.transcribe_claimed(app, id, claimed).await
    }

    async fn transcribe_claimed(&self, app: Option<&tauri::AppHandle>, id: &str, claimed: Claimed) -> Result<Transcript> {
        let Claimed { profile, route, mut audio, mut cancel, .. } = claimed;
        if let Some(app) = app {
            self.emit(app, id, "transcribing", 0.0, None);
        }
        // Retry only resends retained audio; an empty or broken capture would fail the same way forever.
        let mut unusable = false;
        let result = async {
            let wav = loop {
                if *cancel.borrow() { return Err(CANCELLED.into()); }
                if let Some(result) = audio.borrow().clone() { unusable = result.is_err(); break result?; }
                tokio::select! {
                    biased;
                    _ = cancel.changed() => return Err(CANCELLED.into()),
                    result = audio.changed() => { result.map_err(|_| { unusable = true; "The microphone stopped before audio was ready. Discard and record again.".to_owned() })?; }
                }
            };
            if wav.len() <= 44 || wav.len() > MAX_AUDIO_BYTES {
                unusable = true;
                return Err("No valid recorded audio is available. Record again.".into());
            }
            match route {
                Some(route) => self.local.transcribe_wav(route, wav, cancel).await,
                None => transport::transcribe(&profile, wav, cancel).await,
            }
        }.await;
        if let (Some(app), Err(error)) = (app, &result) {
            self.emit(app, id, "error", 0.0, Some(error));
        }
        self.finish_transcription(id, result.is_ok() || unusable)?;
        result.map(|text| Transcript {
            capture_id: id.into(),
            text,
        })
    }

}

#[tauri::command]
pub async fn voice_configuration(
    window: tauri::WebviewWindow,
    voice: tauri::State<'_, Voice>,
) -> Result<Configuration> {
    authorized(&window)?;
    let voice = voice.inner().clone();
    crate::blocking(move || voice.configuration()).await
}
#[tauri::command]
pub async fn voice_save_profile(
    window: tauri::WebviewWindow,
    voice: tauri::State<'_, Voice>,
    input: ProfileInput,
) -> Result<Configuration> {
    authorized(&window)?;
    let voice = voice.inner().clone();
    crate::blocking(move || voice.save_profile(input)).await
}
#[tauri::command]
pub async fn voice_select_profile(
    window: tauri::WebviewWindow,
    voice: tauri::State<'_, Voice>,
    profile_id: Option<String>,
) -> Result<Configuration> {
    authorized(&window)?;
    let voice = voice.inner().clone();
    crate::blocking(move || voice.select_profile(profile_id)).await
}
#[tauri::command]
pub async fn voice_delete_profile(
    window: tauri::WebviewWindow,
    voice: tauri::State<'_, Voice>,
    profile_id: String,
) -> Result<Configuration> {
    authorized(&window)?;
    let voice = voice.inner().clone();
    crate::blocking(move || voice.delete_profile(&profile_id)).await
}
#[tauri::command]
pub async fn voice_start(
    window: tauri::WebviewWindow,
    voice: tauri::State<'_, Voice>,
    request_id: String,
    profile_id: Option<String>,
) -> Result<Started> {
    authorized(&window)?;
    voice
        .start(window.app_handle().clone(), request_id, profile_id)
        .await
}
#[tauri::command]
pub async fn voice_stop(
    window: tauri::WebviewWindow,
    voice: tauri::State<'_, Voice>,
    capture_id: String,
) -> std::result::Result<Transcript, Failure> {
    authorized(&window).map_err(Failure::terminal)?;
    voice
        .transcribe(Some(window.app_handle()), &capture_id, false)
        .await
        .map_err(|message| voice.transcription_failure(&capture_id, message))
}
#[tauri::command]
pub async fn voice_retry(
    window: tauri::WebviewWindow,
    voice: tauri::State<'_, Voice>,
    capture_id: String,
) -> std::result::Result<Transcript, Failure> {
    authorized(&window).map_err(Failure::terminal)?;
    voice
        .transcribe(Some(window.app_handle()), &capture_id, true)
        .await
        .map_err(|message| voice.transcription_failure(&capture_id, message))
}
#[tauri::command]
pub async fn voice_cancel(
    window: tauri::WebviewWindow,
    voice: tauri::State<'_, Voice>,
    capture_id: Option<String>,
    request_id: Option<String>,
) -> Result<()> {
    authorized(&window)?;
    if capture_id.is_none() && request_id.is_none() {
        return Err("Invalid voice recording request.".into());
    }
    if let Some(id) = &request_id {
        valid_request(id)?;
    }
    let voice = voice.inner().clone();
    let app = window.app_handle().clone();
    crate::blocking(move || voice.cancel(Some(&app), capture_id.as_deref(), request_id.as_deref()))
        .await
}
