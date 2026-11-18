//! On-device dictation: a downloadable model catalog and a speech engine (transcribe-cpp) that
//! runs in a killable `__speech-worker` child. No network traffic until the user downloads.
//!
//! IPC contract (all commands are main-window only, like the other `voice_*` commands):
//! - `voice_local_catalog()` -> `{ models: [CatalogModel], vad: VadView, platformSupported: bool,
//!   unsupportedReason: string | null, defaultModel: string | null }`. `unsupportedReason` is the
//!   user-facing reason when `platformSupported` is false (e.g. a Windows on Arm CPU without the
//!   dot-product or i8mm extension), `null` otherwise. `CatalogModel` is a catalog.json entry (`id, revision, name,
//!   description, filename, size, sha256, license, licenseUrl?, languages, benchmark, recommended,
//!   supportsStreaming, supportsLanguageDetection, supportsTranslation, maxAudioMs?,
//!   supportsLongForm?`) plus `state: 'downloadable' | 'downloading' | 'verifying' | 'installed'`,
//!   `downloaded?: number` and `active: boolean` (it is the selected model). `downloaded` is the
//!   live byte count while downloading/verifying, and on a `downloadable` model the bytes of a
//!   resumable `<filename>.part` (show "Resume (NN%)" = downloaded / size); absent otherwise.
//!   `VadView` is the Silero silence filter, tracked apart from every model: `{ state:
//!   'downloadable' | 'downloading' | 'verifying' | 'installed' | 'unavailable', downloaded?:
//!   number (same rules), size: number (0 when unavailable) }`.
//! - `voice_local_download({ modelId })`: downloads the model. On success, with no model selected
//!   yet, it is saved as the selection; only then is its final `installed` event emitted, and a
//!   model's events never go back to `downloading` after it. The VAD then downloads (once) in
//!   the same slot but reported only through `vad` (no `voice://local-model` events; its failure
//!   is ignored), and the command resolves after that, so a catalog read on resolve sees both
//!   the selection and the VAD. One download at a time (the VAD counts as one).
//! - `voice_local_cancel_download({ modelId })` -> keeps the partial file for resuming. Also
//!   cancels the VAD download that follows that model (the command still resolves).
//! - `voice_local_delete({ modelId })` -> refuses while transcribing or downloading it, while
//!   a dictation (starting, recording, transcribing or awaiting Retry) is routed to it (the route
//!   is recorded when Start reserves the session), and while the model test (starting,
//!   recording, converting or transcribing) uses it, explicitly or as the selection ("Stop the
//!   model test first."); a loaded model is unloaded first. Clears the selection if it was
//!   selected.
//! - `voice_local_select({ modelId })` -> `Preferences`; the model must be installed (checked
//!   under the config lock, so a concurrent delete wins).
//! - `voice_local_test_model({ action: 'start' | 'stop' | 'cancel', modelId? })` -> `{ text: string,
//!   cancelled?: true }`: start records (normal capture, preferred mic) and fixes the model:
//!   `modelId` (must be installed; start fails otherwise) or, without it, the selection read at
//!   Stop. Stop transcribes with that model (`''` when nothing was heard), cancel discards the
//!   recording or cancels that transcription (also while it waits for the engine), and the
//!   stop then resolves `{ text: '', cancelled: true }`. Never touches drafts. `modelId` is
//!   ignored for stop and cancel.
//! - `voice_mic_devices()` -> `[{ id, name, isDefault }]` (`id` is the name).
//! - `voice_mic_test_start()` / `voice_mic_test_stop()` -> `{ wavBase64, durationMs, cancelled?:
//!   true }` (capped at 10 s, never transcribed or stored) / `voice_mic_test_cancel()`.
//!   While the mic test records, event `voice://mic-test-level` `{ level: number }` (0..1, the
//!   same input meter dictation reports, about 10 Hz) goes to the main window; it stops when the
//!   recording ends (stop, cancel, the 10 s cap, a newer start, or the window closing). The
//!   model test emits no level events.
//! - Both tests: a start waits for microphone permission and the device. A stop or cancel that
//!   arrives meanwhile cancels that start, which then rejects with "Voice input was cancelled."
//!   and closes the device; such a stop resolves `{ cancelled: true }` (`text: ''`, or
//!   `wavBase64: ''` and `durationMs: 0`). A newer start supersedes a pending one the same way.
//!   A stop with no start at all still fails ("No test recording is running.").
//! - Event `voice://test-ended` `{ kind: 'mic' | 'model', reason: 'closed' }` goes to the main
//!   window when closing (hiding) it discarded that test's recording, so the card returns to
//!   idle (a later stop would fail as above). Not sent for a normal stop or cancel, a pending
//!   Start (which rejects as cancelled) or a model test already transcribing (its stop resolves
//!   `{ cancelled: true }`).
//! - `voice_preferences()` -> `Preferences`:
//!   `{ destination: 'local' | 'off' | { profileId }, deviceName: string | null,
//!   shortcutMode: 'auto' | 'hold' | 'toggle', language: 'auto' | string,
//!   unloadAfter: 'immediately' | 'min_2' | 'min_5' | 'min_10' | 'min_15' | 'hour_1',
//!   selectedModel: string | null }`.
//! - `voice_update_preferences({ patch })` -> `Preferences` (the merged, saved result). `patch` is
//!   any subset of `Preferences` (same camelCase keys; unknown keys are refused). An absent key
//!   keeps the stored value; `null` clears `deviceName` / `selectedModel`. The merge happens under
//!   the config lock, so a native auto-select or delete-clear made since the UI read survives.
//!   A patched non-null `selectedModel` must be installed (not merely in the catalog); the merged
//!   result is validated as in a full save and nothing is written on error.
//! - `voice_start({ requestId, profileId? })`: without `profileId` the saved destination decides
//!   (local model, profile, or an "off" error). Stop/Retry reuse the destination taken at Start.
//! - Event `voice://local-model` `{ modelId, state, downloaded, size, error? }`, at most 10/s.
mod audio;
mod catalog;
mod engine;
pub(crate) mod test_recordings;
mod platform;
mod store;
#[cfg(test)]
mod tests;
mod worker;

use super::{authorized, capture, config, Voice};
use crate::Result;
use catalog::Catalog;
use test_recordings::TestSlot;
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc, Mutex, OnceLock, Weak},
    time::Duration,
};
use store::{Item, Store};
use tauri::{Emitter, Manager};
use tokio::sync::watch;
use worker::{TranscribeRequest, Worker, WorkerCommand};

pub(super) const EVENT: &str = "voice://local-model";
const IDLE_CHECK: Duration = Duration::from_secs(30);
const NO_MODEL: &str = "Choose and download a local speech model in Settings → Voice.";
const IN_USE: &str = "A dictation is using this model. Delete it after the dictation finishes or is discarded.";
/// Download-slot id while the VAD downloads (not a valid catalog id: no `/`).
const VAD_SLOT: &str = "silence-filter";
const UNAVAILABLE: &str = "Voice input is unavailable.";

fn bundled() -> Arc<Catalog> {
    static CATALOG: OnceLock<Arc<Catalog>> = OnceLock::new();
    CATALOG.get_or_init(|| Arc::new(Catalog::bundled())).clone()
}

/// Entry for `main.rs`: true when this process is a speech worker (it has already run).
pub fn handle_speech_worker() -> bool {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(worker::SUBCOMMAND) {
        return false;
    }
    // The protocol-only echo worker exists in test and debug builds only.
    #[cfg(any(test, debug_assertions))]
    if args.any(|a| a == "--echo") {
        return finish_worker(worker::run_child(&mut worker::Echo));
    }
    // ggml/Metal diagnostics would flood the app's stderr on every load.
    transcribe_cpp::disable_logging();
    finish_worker(worker::run_child(&mut engine::Engine::default()))
}

fn finish_worker(result: std::io::Result<()>) -> bool {
    if let Err(error) = result {
        eprintln!("Speech worker stopped: {error}");
        std::process::exit(1);
    }
    true
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEvent {
    pub model_id: String,
    pub state: &'static str,
    pub downloaded: u64,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub(super) type Emit = Arc<dyn Fn(ModelEvent) + Send + Sync>;

/// What a local capture is transcribed with, fixed at Start.
#[derive(Clone, Debug)]
pub(super) struct Route {
    pub(super) model: PathBuf,
    request: TranscribeRequest,
}

pub(crate) struct Local {
    catalog: Arc<Catalog>,
    store: Arc<Store>,
    worker: Arc<Worker>,
    idle_after: Mutex<Option<Duration>>,
    watcher: OnceLock<()>,
    model_test: TestSlot,
    mic_test: TestSlot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    #[serde(flatten)]
    model: catalog::Model,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded: Option<u64>,
    active: bool,
}
#[derive(Serialize)]
pub struct VadState {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded: Option<u64>,
    size: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogView {
    models: Vec<CatalogModel>,
    vad: VadState,
    platform_supported: bool,
    unsupported_reason: Option<&'static str>,
    default_model: Option<String>,
}
impl Local {
    pub(super) fn new(app_data: &std::path::Path) -> Self {
        Self::with(bundled(), Store::new(app_data), WorkerCommand::current().unwrap_or(WorkerCommand {
            program: PathBuf::new(),
            args: Vec::new(),
            env: Vec::new(),
        }))
    }

    pub(super) fn with(catalog: Arc<Catalog>, store: Store, command: WorkerCommand) -> Self {
        Self {
            catalog,
            store: Arc::new(store),
            worker: Worker::new(command),
            idle_after: Mutex::new(Some(Duration::from_secs(15 * 60))),
            watcher: OnceLock::new(),
            model_test: TestSlot::default(),
            mic_test: TestSlot::default(),
        }
    }

    fn model(&self, id: &str) -> Result<&catalog::Model> {
        self.catalog.model(id).ok_or_else(|| "This speech model is not in the catalog.".to_owned())
    }

    /// `slot_id`: the download-slot id this file uses (its model id, or `VAD_SLOT`).
    fn state_of(&self, item: &Item, slot_id: &str) -> (&'static str, Option<u64>) {
        if let Some(active) = self.store.active().filter(|a| a.model_id == slot_id) {
            let verifying = active.verifying.load(Ordering::Acquire);
            return (
                if verifying { "verifying" } else { "downloading" },
                Some(active.downloaded.load(Ordering::Acquire)),
            );
        }
        if self.store.installed(item) {
            return ("installed", None);
        }
        let partial = self.store.partial(item);
        ("downloadable", (partial > 0).then_some(partial))
    }

    pub(super) fn catalog_view(&self, selected: Option<&str>) -> CatalogView {
        let models = self
            .catalog
            .models
            .iter()
            .map(|m| {
                let (state, downloaded) = self.state_of(&Item::from(m), &m.id);
                CatalogModel { model: m.clone(), state, downloaded, active: selected == Some(m.id.as_str()) }
            })
            .collect();
        let vad = match &self.catalog.vad {
            Some(v) => {
                let (state, downloaded) = self.state_of(&Item::from(v), VAD_SLOT);
                VadState { state, downloaded, size: v.size }
            }
            None => VadState { state: "unavailable", downloaded: None, size: 0 },
        };
        let unsupported_reason = platform::current_unsupported_reason();
        CatalogView {
            models,
            vad,
            platform_supported: unsupported_reason.is_none(),
            unsupported_reason,
            default_model: self.catalog.default_model.clone(),
        }
    }

    /// Downloads and installs a model, then (once) the VAD. Model progress goes to `emit`;
    /// `on_installed` (the auto-selection) runs before the final `installed` event, and the VAD
    /// downloads after it under its own slot id, so the model never reads as downloading again.
    /// The model reads as installed only after `on_installed` returns.
    pub(super) async fn download(
        &self,
        model_id: &str,
        emit: Emit,
        on_installed: impl FnOnce() + Send,
    ) -> Result<PathBuf> {
        let model = self.model(model_id)?.clone();
        let item = Item::from(&model);
        let mut slot = self.store.begin(model_id)?;
        let active = slot.active.clone();
        let (event_id, size) = (model.id.clone(), model.size);
        let event = move |state: &'static str, downloaded: u64, error: Option<String>| ModelEvent {
            model_id: event_id.clone(),
            state,
            downloaded,
            size,
            error,
        };
        // At most ten progress events a second.
        let (done_tx, mut done_rx) = watch::channel(false);
        let ticker = {
            let (active, emit, event) = (active.clone(), emit.clone(), event.clone());
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_millis(100));
                loop {
                    tokio::select! {
                        _ = done_rx.changed() => break,
                        _ = tick.tick() => {
                            let state = if active.verifying.load(Ordering::Acquire) { "verifying" } else { "downloading" };
                            emit(event(state, active.downloaded.load(Ordering::Acquire), None));
                        }
                    }
                }
            })
        };
        let result = self.store.fetch(&item, &active).await;
        let _ = done_tx.send(true);
        let _ = ticker.await;
        let path = match result {
            Ok(path) => path,
            Err(error) => {
                let cancelled = error == super::CANCELLED;
                emit(event("downloadable", self.store.partial(&item), (!cancelled).then(|| error.clone())));
                return Err(error);
            }
        };
        // Select first: until the slot moves on, a catalog read still shows the model downloading.
        on_installed();
        // Keep the slot (one download at a time) but stop tying it to the model.
        let vad = self.catalog.vad.as_ref().map(|v| (Item::from(v), slot.switch(VAD_SLOT)));
        emit(event("installed", model.size, None));
        if let Some((vad, vad_active)) = vad {
            if let Err(error) = self.store.fetch(&vad, &vad_active).await {
                if error != super::CANCELLED {
                    eprintln!("Silence filter download failed (dictation still works): {error}");
                }
            }
        }
        drop(slot);
        Ok(path)
    }

    /// Cancels `model_id`'s download, or the silence filter downloading after it.
    pub(super) fn cancel_download(&self, model_id: &str) {
        if let Some(active) = self.store.active().filter(|a| a.model_id == model_id || a.owner == model_id) {
            active.cancel.store(true, Ordering::Release);
        }
    }

    /// `routed`: the model file of the dictation that has not finished (or been discarded), if
    /// any; `selected`: the saved selection (what a model test without its own model uses).
    pub(super) fn delete(&self, model_id: &str, routed: Option<&std::path::Path>, selected: Option<&str>) -> Result<()> {
        let item = Item::from(self.model(model_id)?);
        if self.store.active().is_some_and(|a| a.model_id == model_id) {
            return Err("Cancel this model's download before deleting it.".into());
        }
        if self.model_test.holds(model_id, selected) {
            return Err(test_recordings::TEST_HOLDS.into());
        }
        let path = self.store.path(&item.filename);
        if routed == Some(path.as_path()) {
            return Err(IN_USE.into());
        }
        // Idle check, delete and unload under the engine lock: never cancels another dictation.
        self.worker
            .unload_for_delete(&path, || self.store.delete(&item))
            .unwrap_or_else(|| Err("This model is transcribing. Delete it when it finishes.".into()))
    }

    pub(super) fn installed_path(&self, model_id: &str) -> Result<PathBuf> {
        let item = Item::from(self.model(model_id)?);
        if !self.store.installed(&item) {
            return Err("Download this speech model in Settings → Voice first.".into());
        }
        Ok(self.store.path(&item.filename))
    }

    /// A selected model must be installed, not merely in the catalog.
    fn check_selection(&self, model_id: Option<&str>) -> Result<()> {
        model_id.map_or(Ok(()), |id| self.installed_path(id).map(|_| ()))
    }

    /// Resolves the route for a recording from the saved preferences.
    pub(super) fn route_for(&self, prefs: &config::Preferences) -> Result<Route> {
        self.route_with(prefs.selected_model.as_deref().ok_or(NO_MODEL)?, prefs)
    }

    /// The model test's route: `model_id` when given (it must be installed), else the selection.
    fn test_route(&self, prefs: &config::Preferences, model_id: Option<&str>) -> Result<Route> {
        match model_id {
            Some(id) => self.route_with(id, prefs),
            None => self.route_for(prefs),
        }
    }

    /// `model_id` with the language and silence filter from `prefs`.
    fn route_with(&self, model_id: &str, prefs: &config::Preferences) -> Result<Route> {
        let model = self.model(model_id)?;
        let path = self.installed_path(model_id)?;
        let vad = self.catalog.vad.as_ref().map(Item::from).filter(|v| self.store.installed(v));
        Ok(Route {
            model: path,
            request: TranscribeRequest {
                language: catalog::run_language(model, &prefs.language),
                task: None,
                filter_silence: vad.is_some(),
                vad_path: vad.map(|v| self.store.path(&v.filename).to_string_lossy().into_owned()),
                chunk_samples: model.chunk_samples(),
                seconds_per30s: model.benchmark.as_ref().and_then(|b| b.seconds_per30s),
            },
        })
    }

    pub(super) fn set_unload_after(&self, after: Option<Duration>) {
        if let Ok(mut slot) = self.idle_after.lock() {
            *slot = after;
        }
    }

    fn watch_idle(self: &Arc<Self>) {
        self.watcher.get_or_init(|| {
            let weak: Weak<Self> = Arc::downgrade(self);
            let _ = std::thread::Builder::new().name("speech-idle".into()).spawn(move || loop {
                std::thread::sleep(IDLE_CHECK);
                let Some(local) = weak.upgrade() else { break };
                if let Some(after) = local.idle_after.lock().ok().and_then(|a| *a) {
                    local.worker.unload_if_idle(after);
                }
            });
        });
    }

    /// Transcribes 16 kHz PCM with `route`, then applies the unload preference.
    pub(super) async fn run(self: &Arc<Self>, route: Route, pcm: Vec<f32>, cancel: watch::Receiver<bool>) -> Result<String> {
        self.watch_idle();
        let local = self.clone();
        let text = crate::blocking(move || {
            let cancelled = || *cancel.borrow();
            local
                .worker
                .transcribe(&route.model, &route.request, &pcm, &cancelled)
                .map_err(|f| f.message())
        })
        .await?;
        // Never `unload`: another dictation may already hold the worker.
        if self.idle_after.lock().ok().is_some_and(|a| a.is_none()) {
            self.worker.unload_idle();
        }
        Ok(text.trim().to_owned())
    }

    /// Transcribes a finished dictation WAV.
    pub(super) async fn transcribe_wav(self: &Arc<Self>, route: Route, wav: Arc<Vec<u8>>, cancel: watch::Receiver<bool>) -> Result<String> {
        let pcm = crate::blocking(move || capture::Pcm::from_wav(&wav)?.mono_f32_16k()).await?;
        let text = self.run(route, pcm, cancel).await?;
        if text.is_empty() {
            return Err("No speech was recognized. Record again, or retry this recording.".into());
        }
        Ok(text)
    }

    /// App exit: stops the tests, cancels the download and unloads the engine. (A hidden
    /// window only stops the tests: see `stop_tests`.)
    pub(super) fn shutdown(&self) {
        self.stop_tests();
        if let Some(active) = self.store.active() {
            active.cancel.store(true, Ordering::Release);
        }
        self.worker.unload();
    }
}

impl Voice {
    fn session_active(&self) -> bool {
        self.session.lock().map(|s| s.is_some()).unwrap_or(true)
    }

    /// `voice_local_delete`. The session lock is held across the delete, so a Start reserving
    /// now either records its route first (and the delete refuses) or finds the file gone.
    pub(super) fn delete_local_model(&self, model_id: &str) -> Result<()> {
        // Read before the session lock (never hold it while taking the config lock).
        let selected = self.preferences()?.selected_model;
        {
            let guard = self.session.lock().map_err(|_| "Voice input is unavailable.".to_owned())?;
            // Starting, recording, transcribing or awaiting Retry: its model must stay.
            let routed = guard
                .as_ref()
                .filter(|s| s.phase != super::Phase::Cancelled)
                .and_then(|s| s.route.as_ref())
                .map(|r| r.model.as_path());
            self.local.delete(model_id, routed, selected.as_deref())?;
        }
        self.update_preferences(|p| {
            Ok(if p.selected_model.as_deref() == Some(model_id) {
                config::Preferences { selected_model: None, ..p }
            } else {
                p
            })
        })?;
        Ok(())
    }

    /// `voice_local_select`.
    pub(super) fn select_local_model(&self, model_id: &str) -> Result<config::Preferences> {
        // Checked under the config lock, so a delete that lands first is never overwritten.
        self.update_preferences(|p| {
            self.local.installed_path(model_id)?;
            Ok(config::Preferences { selected_model: Some(model_id.to_owned()), ..p })
        })
    }

    /// `voice_update_preferences`: merges `patch` into the stored preferences under the config
    /// lock, so native changes (auto-select, delete-clear) made since the UI read survive.
    pub(super) fn patch_preferences(&self, patch: config::PreferencesPatch) -> Result<config::Preferences> {
        let local = self.local.clone();
        let saved = self.update_preferences(|p| {
            if let Some(selected) = &patch.selected_model {
                local.check_selection(selected.as_deref())?;
            }
            Ok(patch.apply(p))
        })?;
        self.local.set_unload_after(saved.unload_after.duration());
        Ok(saved)
    }

}

fn emitter(app: &tauri::AppHandle) -> Emit {
    let app = app.clone();
    Arc::new(move |event| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit(EVENT, event);
        }
    })
}

#[tauri::command]
pub async fn voice_local_catalog(window: tauri::WebviewWindow, voice: tauri::State<'_, Voice>) -> Result<CatalogView> {
    authorized(&window)?;
    let voice = voice.inner().clone();
    crate::blocking(move || {
        let selected = voice.preferences().ok().and_then(|p| p.selected_model);
        Ok(voice.local.catalog_view(selected.as_deref()))
    })
    .await
}

#[tauri::command]
pub async fn voice_local_download(window: tauri::WebviewWindow, voice: tauri::State<'_, Voice>, model_id: String) -> Result<()> {
    authorized(&window)?;
    let voice = voice.inner().clone();
    let (selector, chosen) = (voice.clone(), model_id.clone());
    // The first installed model becomes the selection, saved before `installed` is emitted.
    let select = move || {
        let saved = selector.update_preferences(|p| {
            Ok(match p.selected_model {
                None => config::Preferences { selected_model: Some(chosen), ..p },
                Some(_) => p,
            })
        });
        if let Err(error) = saved {
            eprintln!("Could not select the downloaded speech model: {error}");
        }
    };
    voice.local.download(&model_id, emitter(window.app_handle()), select).await?;
    Ok(())
}

#[tauri::command]
pub async fn voice_local_cancel_download(window: tauri::WebviewWindow, voice: tauri::State<'_, Voice>, model_id: String) -> Result<()> {
    authorized(&window)?;
    voice.local.cancel_download(&model_id);
    Ok(())
}

#[tauri::command]
pub async fn voice_local_delete(window: tauri::WebviewWindow, voice: tauri::State<'_, Voice>, model_id: String) -> Result<()> {
    authorized(&window)?;
    let voice = voice.inner().clone();
    crate::blocking(move || voice.delete_local_model(&model_id)).await
}

#[tauri::command]
pub async fn voice_local_select(window: tauri::WebviewWindow, voice: tauri::State<'_, Voice>, model_id: String) -> Result<config::Preferences> {
    authorized(&window)?;
    let voice = voice.inner().clone();
    crate::blocking(move || voice.select_local_model(&model_id)).await
}

#[tauri::command]
pub async fn voice_preferences(window: tauri::WebviewWindow, voice: tauri::State<'_, Voice>) -> Result<config::Preferences> {
    authorized(&window)?;
    let voice = voice.inner().clone();
    crate::blocking(move || voice.preferences()).await
}

#[tauri::command]
pub async fn voice_update_preferences(
    window: tauri::WebviewWindow,
    voice: tauri::State<'_, Voice>,
    patch: config::PreferencesPatch,
) -> Result<config::Preferences> {
    authorized(&window)?;
    let voice = voice.inner().clone();
    crate::blocking(move || voice.patch_preferences(patch)).await
}
