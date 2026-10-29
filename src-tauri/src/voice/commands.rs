//! Tauri commands for voice dictation, plus the download pipeline that turns
//! catalog entries into installed models. Events follow docs/ipc.md: camelCase
//! payloads, errors reject as strings.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use super::model::{self, ModelStatus};
use super::settings::Settings;
use super::{ActiveSession, Voice, EVENT_DOWNLOAD};

/// Cadence of the recording loop and the level meter.
const TICK: Duration = Duration::from_millis(80);
const LEVEL_EVERY: Duration = Duration::from_millis(100);
/// Session-engine label for the online modes (the provider id is in settings).
const ONLINE: &str = "online";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceState {
    pub settings: Settings,
    pub models: Vec<ModelStatus>,
    pub recording: Option<String>,
    pub apple_available: bool,
    pub microphone_available: bool,
    /// Provider ids with a saved API key (ids only, never values).
    pub keys: Vec<String>,
}

fn status_models(state: &Voice) -> Vec<ModelStatus> {
    let downloads = state.downloads.lock().expect("downloads lock");
    let dir = state.models_dir();
    model::CATALOG
        .iter()
        .map(|entry| {
            let progress = downloads.get(entry.id).copied();
            ModelStatus {
                id: entry.id.into(),
                label: entry.label.into(),
                kind: entry.kind,
                languages: entry.languages.into(),
                license: entry.license.into(),
                size: model::total_size(entry),
                installed: model::installed(&dir, entry.id),
                downloading: progress.is_some(),
                progress: progress.unwrap_or(0.0),
            }
        })
        .collect()
}

fn microphone_available() -> bool {
    use cpal::traits::HostTrait;
    cpal::default_host().default_input_device().is_some()
}

#[tauri::command]
pub fn voice_state(voice: State<'_, Voice>) -> VoiceState {
    let settings = voice.settings.lock().expect("settings lock").clone();
    let recording = voice
        .session
        .lock()
        .expect("session lock")
        .as_ref()
        .map(|session| session.engine.to_string());
    VoiceState {
        settings,
        models: status_models(&voice),
        recording,
        apple_available: super::apple_available(),
        microphone_available: microphone_available(),
        keys: voice_keys(),
    }
}

#[tauri::command]
pub fn voice_models(voice: State<'_, Voice>) -> Vec<ModelStatus> {
    status_models(&voice)
}

#[tauri::command]
pub fn voice_save_settings(voice: State<'_, Voice>, settings: Settings) -> Result<Settings, String> {
    let settings = settings.normalized();
    super::settings::save(&voice.dir, &settings)?;
    *voice.settings.lock().expect("settings lock") = settings.clone();
    Ok(settings)
}

/// Secret-store service for online provider keys (own namespace; the values
/// never reach the webview).
const KEY_SERVICE: &str = "app.pandacode.voice";

fn key_account(provider: &str) -> String {
    format!("key.{provider}")
}

/// The provider registry for the Settings picker (no secrets).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub default_model: String,
    pub models: Vec<String>,
    /// Streaming providers transcribe live; multipart ones finalize on stop.
    pub streaming: bool,
}

#[tauri::command]
pub fn voice_providers() -> Vec<ProviderInfo> {
    use super::providers::Transport;
    super::providers::PROVIDERS
        .iter()
        .map(|provider| ProviderInfo {
            id: provider.id.into(),
            label: provider.label.into(),
            base_url: provider.base_url.into(),
            default_model: provider.default_model.into(),
            models: provider.models.iter().map(|model| model.to_string()).collect(),
            streaming: provider.transport != Transport::Multipart,
        })
        .collect()
}

/// Saves (or, with an empty key, forgets) one provider's API key.
#[tauri::command]
pub fn voice_set_key(provider: String, key: String) -> Result<(), String> {
    let entry = super::providers::find(&provider).ok_or("Unknown voice provider.")?;
    if key.trim().is_empty() {
        crate::secret_store::remove(KEY_SERVICE, &key_account(entry.id));
        return Ok(());
    }
    crate::secret_store::set(KEY_SERVICE, &key_account(entry.id), key.trim())
        .map_err(|e| e.to_string())
}

/// Provider ids that currently have a saved key (ids only, never values).
#[tauri::command]
pub fn voice_keys() -> Vec<String> {
    super::providers::PROVIDERS
        .iter()
        .filter(|provider| crate::secret_store::get(KEY_SERVICE, &key_account(provider.id)).is_some())
        .map(|provider| provider.id.to_string())
        .collect()
}

/// A connectivity test: silence in, an HTTP 200 / clean session out.
#[tauri::command]
pub async fn voice_test_provider(
    voice: State<'_, Voice>,
    provider: String,
) -> Result<String, String> {
    let settings = voice.settings.lock().expect("settings lock").clone();
    let entry = super::providers::find(&provider).ok_or("Unknown voice provider.")?;
    let key = crate::secret_store::get(KEY_SERVICE, &key_account(entry.id))
        .ok_or("Save an API key first.")?;
    let model = super::providers::resolved_model(entry, &settings.online_model);
    // A quiet half second: enough to exercise the whole path.
    let samples = vec![0.0f32; super::online::SAMPLE_RATE as usize / 2];
    match entry.transport {
        super::providers::Transport::Multipart => {
            transcribe_or_probe(entry, &settings.online_base_url, model, &key, &samples, true).await
        }
        super::providers::Transport::DeepgramWs => {
            let url = super::providers::deepgram_url(entry, &settings.online_base_url, model);
            let mut stream = super::online::connect_deepgram(&url, &key, |_| {}).await?;
            stream.feed(&samples).await?;
            stream.finish().await.map(|_| format!("{label} is connected.", label = entry.label))
        }
        super::providers::Transport::RealtimeWs => {
            let url = super::providers::realtime_url(entry, &settings.online_base_url, model);
            let mut stream = super::online::connect_realtime(&url, &key, model, |_| {}).await?;
            stream.feed(&samples).await?;
            stream.finish().await.map(|_| format!("{label} is connected.", label = entry.label))
        }
    }
}

/// Multipart call; `probe` treats a well-formed (even empty) answer as success
/// so a connectivity test with silence does not read as a failure.
async fn transcribe_or_probe(
    entry: &'static super::providers::Provider,
    base_override: &str,
    model: &str,
    key: &str,
    samples: &[f32],
    probe: bool,
) -> Result<String, String> {
    let result = super::online::transcribe_multipart(entry, base_override, model, key, samples).await;
    match result {
        Ok(text) => Ok(if probe && text.is_empty() { format!("{} is connected.", entry.label) } else { text }),
        Err(error) => {
            if probe && error.contains("returned no transcript") {
                Ok(format!("{} is connected.", entry.label))
            } else {
                Err(error)
            }
        }
    }
}

/// Starts recording with the configured engine and mode. Configuration
/// problems (no provider, no key) reject synchronously; connection failures
/// surface as `voice-error` so the UI resets without a stuck session.
#[tauri::command]
pub fn voice_start(app: AppHandle, voice: State<'_, Voice>) -> Result<(), String> {
    let mut session = voice.session.lock().expect("session lock");
    if session.is_some() {
        return Err("A voice recording is already running.".into());
    }
    let settings = voice.settings.lock().expect("settings lock").clone();
    if !settings.enabled {
        return Err("Voice is off. Enable it in Settings → Voice.".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let cancel = Arc::new(AtomicBool::new(false));
    let engine = if settings.online_first() {
        ONLINE
    } else {
        settings.resolved_engine()
    };
    let worker = match engine {
        super::settings::ENGINE_APPLE => {
            #[cfg(target_os = "macos")]
            {
                super::apple::start_recording(
                    app.clone(),
                    voice.dir.clone(),
                    settings.clone(),
                    stop.clone(),
                    cancel.clone(),
                )?
            }
            #[cfg(not(target_os = "macos"))]
            {
                return Err("The Apple Speech engine is only on macOS.".into());
            }
        }
        ONLINE => online_start_recording(
            app.clone(),
            voice.dir.clone(),
            settings.clone(),
            stop.clone(),
            cancel.clone(),
        )?,
        _ => sherpa_start_recording(
            app.clone(),
            voice.dir.clone(),
            settings.clone(),
            stop.clone(),
            cancel.clone(),
        )?,
    };
    *session = Some(ActiveSession {
        engine: if engine == super::settings::ENGINE_APPLE {
            super::settings::ENGINE_APPLE
        } else if engine == ONLINE {
            ONLINE
        } else {
            super::settings::ENGINE_SHERPA
        },
        stop,
        cancel,
        worker,
    });
    Ok(())
}

/// Finalizes the recording: the worker emits `voice-result` (or an error) and
/// clears the session.
#[tauri::command]
pub fn voice_stop(voice: State<'_, Voice>) {
    if let Some(session) = voice.session.lock().expect("session lock").as_ref() {
        session.stop.store(true, Ordering::SeqCst);
    }
}

/// Discards the recording without emitting a result.
#[tauri::command]
pub fn voice_cancel(voice: State<'_, Voice>) {
    if let Some(session) = voice.session.lock().expect("session lock").as_ref() {
        session.cancel.store(true, Ordering::SeqCst);
        session.stop.store(true, Ordering::SeqCst);
    }
}

/// Downloads one catalog model (all its files) in the background, emitting
/// `voice-download` progress. One download per id at a time.
#[tauri::command]
pub fn voice_download_model(app: AppHandle, voice: State<'_, Voice>, id: String) -> Result<(), String> {
    let entry = model::find(&id).ok_or("Unknown voice model.")?;
    {
        let mut downloads = voice.downloads.lock().expect("downloads lock");
        if downloads.contains_key(&id) {
            return Err("That model is already downloading.".into());
        }
        downloads.insert(id.clone(), 0.0);
    }
    let dir = voice.dir.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let result = download_model(&app, &dir, entry).await;
        let payload = match &result {
            Ok(()) => serde_json::json!({ "id": id, "status": "done", "progress": 100.0 }),
            Err(error) => serde_json::json!({ "id": id, "status": "error", "error": error }),
        };
        super::emit(&app, EVENT_DOWNLOAD, payload);
        if let Some(state) = app.try_state::<Voice>() {
            state.downloads.lock().expect("downloads lock").remove(&id);
        }
    });
    let _ = handle;
    Ok(())
}

async fn download_model(
    app: &AppHandle,
    dir: &std::path::Path,
    entry: &'static model::Model,
) -> Result<(), String> {
    let target = dir.join("voice").join("models").join(entry.id);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let progress = |app: &AppHandle, fraction: f32| {
        if let Some(state) = app.try_state::<Voice>() {
            state
                .downloads
                .lock()
                .expect("downloads lock")
                .insert(entry.id.to_string(), fraction);
        }
        super::emit(
            app,
            EVENT_DOWNLOAD,
            serde_json::json!({ "id": entry.id, "status": "downloading", "progress": (fraction * 1000.0).floor() / 10.0 }),
        );
    };
    let total = model::total_size(entry).max(1);
    let mut done: u64 = 0;
    if entry.id == model::PUNCT_DEFAULT {
        // The archive unpacks both files in one download; progress is coarse.
        progress(app, 0.05);
        unpack_punct(app, &target).await?;
        progress(app, 1.0);
    } else {
        for file in entry.files {
            let bytes = fetch_with_cap(&model::file_url(entry, file), model::MAX_FILE_BYTES).await?;
            model::verify(&bytes, file)?;
            std::fs::write(target.join(file.name), &bytes).map_err(|e| e.to_string())?;
            done += file.size;
            progress(app, (done as f32 / total as f32).min(1.0));
        }
    }
    Ok(())
}

/// Streams a URL into memory with a hard size cap (downloads are models, tens
/// to hundreds of MB; never trust the content-length alone).
async fn fetch_with_cap(url: &str, cap: u64) -> Result<Vec<u8>, String> {
    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("Could not reach {url}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Could not reach {url}: {e}"))?;
    if let Some(length) = response.content_length() {
        if length > cap {
            return Err(format!("Download is larger than the {cap} byte cap."));
        }
    }
    let mut bytes = Vec::new();
    let mut stream = response;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|e| format!("Download failed: {e}"))?
    {
        if bytes.len() as u64 + chunk.len() as u64 > cap {
            return Err(format!("Download exceeded the {cap} byte cap."));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Downloads and unpacks the punctuation archive (model.int8.onnx + bpe.vocab).
async fn unpack_punct(app: &AppHandle, target: &std::path::Path) -> Result<(), String> {
    let archive_url = model::file_url(
        model::find(model::PUNCT_DEFAULT).expect("punct in catalog"),
        &model::File { name: "", size: 0, sha256: None },
    );
    let bytes = fetch_with_cap(&archive_url, model::MAX_FILE_BYTES).await?;
    let blocking = app.to_owned();
    let target = target.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _ = &blocking;
        let reader = std::io::Cursor::new(bytes);
        let decompressed = bzip2::read::MultiBzDecoder::new(reader);
        let mut archive = tar::Archive::new(decompressed);
        let mut found = 0;
        for entry in archive
            .entries()
            .map_err(|e| format!("Could not read the archive: {e}"))?
        {
            let mut entry = entry.map_err(|e| e.to_string())?;
            let name = entry
                .path()
                .map_err(|e| e.to_string())?
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if name != "model.int8.onnx" && name != "bpe.vocab" {
                continue;
            }
            let mut contents = Vec::new();
            entry
                .read_to_end(&mut contents)
                .map_err(|e| e.to_string())?;
            if contents.len() as u64 > model::MAX_FILE_BYTES {
                return Err("Archive entry exceeded the size cap.".into());
            }
            std::fs::write(target.join(&name), contents).map_err(|e| e.to_string())?;
            found += 1;
        }
        if found == 2 {
            Ok(())
        } else {
            Err(format!("Archive was missing files (found {found} of 2)."))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The recording loop for the sherpa engine: capture → drain → feed → partials.
fn sherpa_start_recording(
    app: AppHandle,
    dir: std::path::PathBuf,
    settings: Settings,
    stop: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
) -> Result<tauri::async_runtime::JoinHandle<()>, String> {
    let capture = super::capture::Capture::start()?;
    let mut recorder = super::sherpa::load(&dir, &settings)?;
    Ok(tauri::async_runtime::spawn(async move {
        let mut last_level = Instant::now() - LEVEL_EVERY;
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(TICK).await;
            let chunk = capture.drain_16k();
            if let Some(text) = recorder.feed(&chunk) {
                super::emit(&app, super::EVENT_PARTIAL, serde_json::json!({ "text": text }));
            }
            if last_level.elapsed() >= LEVEL_EVERY {
                super::emit(&app, super::EVENT_LEVEL, capture.level());
                last_level = Instant::now();
            }
        }
        if cancel.load(Ordering::SeqCst) {
            clear_session(&app);
            return;
        }
        let text = tauri::async_runtime::spawn_blocking(move || recorder.finish())
            .await
            .unwrap_or_default();
        if text.trim().is_empty() {
            super::emit(
                &app,
                super::EVENT_ERROR,
                serde_json::json!({ "message": "No speech was detected." }),
            );
        } else {
            super::emit(
                &app,
                super::EVENT_RESULT,
                serde_json::json!({ "text": text, "engine": "sherpa", "fallback": false }),
            );
        }
        clear_session(&app);
    }))
}

/// The online recording path: capture locally while a streaming provider
/// transcribes live (or, for multipart providers, buffer until stop and send
/// once). A failed online attempt settles on the offline engine when the mode
/// allows fallback; otherwise the error surfaces and the take is kept only in
/// the recording bar's toast.
fn online_start_recording(
    app: AppHandle,
    dir: std::path::PathBuf,
    settings: Settings,
    stop: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
) -> Result<tauri::async_runtime::JoinHandle<()>, String> {
    let provider = super::providers::find(&settings.online_provider)
        .ok_or("Choose an online provider in Settings → Voice.")?;
    let key = crate::secret_store::get(KEY_SERVICE, &key_account(provider.id))
        .ok_or(format!("Save an API key for {} first.", provider.label))?;
    let model = super::providers::resolved_model(provider, &settings.online_model).to_string();
    let capture = super::capture::Capture::start()?;
    Ok(tauri::async_runtime::spawn(async move {
        let app = &app;
        let mut last_level = Instant::now() - LEVEL_EVERY;
        let mut buffer: Vec<f32> = Vec::new();
        // A feed failure after connect: remembered, settled on stop.
        let mut stream_failed: Option<String> = None;
        // Streaming providers connect now; multipart providers connect on stop.
        let mut stream: Option<super::online::OnlineStream> = match provider.transport {
            super::providers::Transport::Multipart => None,
            super::providers::Transport::DeepgramWs => {
                let url = super::providers::deepgram_url(provider, &settings.online_base_url, &model);
                match super::online::connect_deepgram(&url, &key, {
                    let app = app.clone();
                    move |text| super::emit(&app, super::EVENT_PARTIAL, serde_json::json!({ "text": text }))
                })
                .await
                {
                    Ok(stream) => Some(stream),
                    Err(error) => {
                        clear_session(app);
                        settle_offline_or_fail(app, &dir, &settings, &buffer, error).await;
                        return;
                    }
                }
            }
            super::providers::Transport::RealtimeWs => {
                let url = super::providers::realtime_url(provider, &settings.online_base_url, &model);
                match super::online::connect_realtime(&url, &key, &model, {
                    let app = app.clone();
                    move |text| super::emit(&app, super::EVENT_PARTIAL, serde_json::json!({ "text": text }))
                })
                .await
                {
                    Ok(stream) => Some(stream),
                    Err(error) => {
                        clear_session(app);
                        settle_offline_or_fail(app, &dir, &settings, &buffer, error).await;
                        return;
                    }
                }
            }
        };
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(TICK).await;
            let chunk = capture.drain_16k();
            buffer.extend_from_slice(&chunk);
            let mut feed_error = None;
            if let Some(active) = stream.as_mut() {
                if let Err(error) = active.feed(&chunk).await {
                    // Keep capturing; the offline settle happens on stop.
                    feed_error = Some(error);
                }
            }
            if let Some(error) = feed_error {
                // No voice-error mid-recording: the frontend tears the bar
                // down on it, leaving this loop running with no way to stop.
                stream_failed = Some(error);
                stream = None;
            }
            if last_level.elapsed() >= LEVEL_EVERY {
                super::emit(app, super::EVENT_LEVEL, capture.level());
                last_level = Instant::now();
            }
        }
        if cancel.load(Ordering::SeqCst) {
            clear_session(app);
            return;
        }
        // Capture has stopped and cancel has been honoured: free the session
        // slot before the slow finish awaits so the next recording can start
        // while this take settles. Nothing below reads the session again.
        clear_session(app);
        // A mid-stream failure settles the whole take with the offline engine
        // (or surfaces the error) instead of the streaming finish.
        if let Some(error) = stream_failed {
            settle_offline_or_fail(app, &dir, &settings, &buffer, error).await;
            return;
        }
        // Streaming: flush and await the provider's final transcript.
        if let Some(stream) = stream {
            match stream.finish().await {
                Ok(text) if !text.trim().is_empty() => {
                    super::emit(
                        app,
                        super::EVENT_RESULT,
                        serde_json::json!({ "text": text, "engine": provider.id, "fallback": false }),
                    );
                    return;
                }
                Ok(_) => super::emit(
                    app,
                    super::EVENT_ERROR,
                    serde_json::json!({ "message": "No speech was detected." }),
                ),
                Err(error) => settle_offline_or_fail(app, &dir, &settings, &buffer, error).await,
            }
            return;
        }
        // Multipart: one request with the whole take.
        match super::online::transcribe_multipart(provider, &settings.online_base_url, &model, &key, &buffer).await {
            Ok(text) => super::emit(
                app,
                super::EVENT_RESULT,
                serde_json::json!({ "text": text, "engine": provider.id, "fallback": false }),
            ),
            Err(error) => settle_offline_or_fail(app, &dir, &settings, &buffer, error).await,
        }
    }))
}

/// Fallback settle: decode the local buffer with the offline engine; without
/// fallback (or models) the original online error becomes the outcome.
async fn settle_offline_or_fail(
    app: &AppHandle,
    dir: &std::path::Path,
    settings: &Settings,
    buffer: &[f32],
    online_error: String,
) {
    let note = online_note(settings, &online_error);
    if settings.fallback_allowed() {
        let dir = dir.to_path_buf();
        let settings = settings.clone();
        let samples = buffer.to_vec();
        let settled = tauri::async_runtime::spawn_blocking(move || {
            super::sherpa::finalize_buffer(&dir, &settings, &samples)
        })
        .await
        .unwrap_or(None);
        if let Some(text) = settled {
            super::emit(
                app,
                super::EVENT_RESULT,
                serde_json::json!({ "text": text, "engine": "sherpa", "fallback": true }),
            );
            super::emit(
                app,
                super::EVENT_ERROR,
                serde_json::json!({ "message": note }),
            );
            return;
        }
    }
    super::emit(app, super::EVENT_ERROR, serde_json::json!({ "message": note }));
}

/// Fallback failures mention what happened next; plain failures stand alone.
fn online_note(settings: &Settings, error: &str) -> String {
    if settings.fallback_allowed() {
        format!("{error} Settled with the local model where it could.")
    } else {
        error.to_string()
    }
}

/// Workers clear the session themselves so stop/cancel remain fire-and-forget.
pub(crate) fn clear_session(app: &AppHandle) {
    if let Some(state) = app.try_state::<Voice>() {
        *state.session.lock().expect("session lock") = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_serializes_camel_case() {
        let state = VoiceState {
            settings: Settings::default(),
            models: Vec::new(),
            recording: None,
            apple_available: false,
            microphone_available: true,
            keys: Vec::new(),
        };
        let json = serde_json::to_value(&state).unwrap();
        assert!(json.get("appleAvailable").is_some());
        assert!(json.get("microphoneAvailable").is_some());
        assert!(json.get("settings").is_some());
    }
}
