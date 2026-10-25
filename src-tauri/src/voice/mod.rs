//! Voice dictation: microphone capture and speech-to-text for the composer.
//!
//! Nothing is bundled and nothing phones home: the Apple Speech engine uses
//! the OS, the sherpa engine runs models the user downloaded once
//! ([`model`]), and online engines (separate change) only talk to providers
//! the user configured. Design notes in docs/voice.md.

#[cfg(target_os = "macos")]
pub mod apple;
pub mod capture;
pub mod commands;
pub mod model;
pub mod sherpa;
pub mod settings;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager};

/// Events the webview subscribes to. `voice-partial` replaces the previous
/// live text; `voice-result` carries the final transcript; a `voice-level`
/// f32 (0..1) drives the recording meter.
pub const EVENT_PARTIAL: &str = "voice-partial";
pub const EVENT_RESULT: &str = "voice-result";
pub const EVENT_ERROR: &str = "voice-error";
pub const EVENT_LEVEL: &str = "voice-level";
pub const EVENT_DOWNLOAD: &str = "voice-download";

/// One running recording. The engine worker owns its audio pipeline; these
/// flags ask it to finalize (`stop`) or discard (`cancel`), and the worker
/// clears `session` when it exits.
pub struct ActiveSession {
    pub engine: &'static str,
    pub stop: Arc<AtomicBool>,
    pub cancel: Arc<AtomicBool>,
    pub worker: tauri::async_runtime::JoinHandle<()>,
}

impl ActiveSession {
    pub fn stopping(&self) -> bool {
        self.stop.load(Ordering::SeqCst) || self.cancel.load(Ordering::SeqCst)
    }
}

/// Active model downloads, keyed by catalog id.
pub type Downloads = HashMap<String, f32>;

/// Per-app voice state, managed like `vm::Vms` and friends.
pub struct Voice {
    pub dir: PathBuf,
    pub settings: Mutex<settings::Settings>,
    pub session: Mutex<Option<ActiveSession>>,
    pub downloads: Mutex<Downloads>,
}

impl Voice {
    pub fn models_dir(&self) -> PathBuf {
        self.dir.join("voice").join("models")
    }
}

pub fn setup(app: &AppHandle, dir: &PathBuf) -> Result<(), std::io::Error> {
    let models = dir.join("voice").join("models");
    std::fs::create_dir_all(&models)?;
    let settings = settings::load(dir);
    app.manage(Voice {
        dir: dir.clone(),
        settings: Mutex::new(settings),
        session: Mutex::new(None),
        downloads: Mutex::new(Downloads::new()),
    });
    Ok(())
}

/// Emits an event to the main webview; failures are ignored because a closed
/// window must not break the audio pipeline.
pub fn emit<T: serde::Serialize + Clone>(app: &AppHandle, event: &str, payload: T) {
    let _ = app.emit(event, payload);
}

#[cfg(target_os = "macos")]
pub fn apple_available() -> bool {
    apple::available()
}

#[cfg(not(target_os = "macos"))]
pub fn apple_available() -> bool {
    false
}
