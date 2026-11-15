//! Desktop notifications when a task needs approval or input, or ends. The webview decides when
//! one may show (src/notifications.ts) and calls `notifications_show`; this module draws the
//! banner through tauri-plugin-notification and plays the chosen macOS system sound. A click on
//! the banner brings the window up and opens the task.

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// The payload of `open-task`, emitted when a click has no single task to open.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenTask {
    session_id: Option<String>,
}

/// Shows one notification (unless suppressed) and plays the named macOS system sound.
#[tauri::command]
pub fn notifications_show(
    app: AppHandle,
    title: String,
    body: String,
    session_id: Option<String>,
    sound: Option<String>,
    suppress_banner: bool,
    sound_when_focused: bool,
) -> Result<(), String> {
    // The webview only knows its own document's focus (the Quick launcher or another PandaCode
    // window can hold it): the app's windows decide here whether anything may show.
    let focused = app_focused(&app);
    if !suppress_banner && !focused {
        let mut builder = app.notification().builder().title(title).body(body);
        if let Some(session_id) = session_id {
            // Round-trips through the plugin's action report, so a click knows which task to open.
            builder = builder.extra("sessionId", session_id);
        }
        builder.show().map_err(|error| error.to_string())?;
    }
    // Unfocused, a notification carries its sound; focused, only the setting allows one.
    if sound.as_deref().is_some_and(|name| name != "None") && (!focused || sound_when_focused) {
        play_sound(&app, sound.as_deref());
    }
    Ok(())
}

/// Whether any PandaCode window holds the user's focus. A window hidden to the menu bar reports
/// unfocused, so an app parked in the tray still notifies.
fn app_focused(app: &AppHandle) -> bool {
    app.webview_windows().values().any(|window| window.is_focused().unwrap_or(false))
}

/// Brings the workspace window up, whether it was minimized, hidden or merely behind.
fn foreground(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Registers the click handler. Must run before the first notification is shown: the plugin
/// reports actions only for notifications shown while a handler or listener exists.
pub fn setup(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.notification().on_action(move |performed| {
        // Only a click on the banner itself (`tap`) is reported; no action buttons are registered.
        if performed.action_id() != "tap" {
            return;
        }
        let session_id = performed
            .notification()
            .and_then(|notification| notification.extra().get("sessionId").cloned())
            .and_then(|value| value.as_str().map(str::to_owned));
        // The window comes up whatever the notice was for. A task click then resolves like the
        // Quick launcher's (a managed worker opens its parent's worker inspector); a batch
        // across tasks has no single task to open.
        foreground(&handle);
        let Some(session_id) = session_id else {
            let _ = handle.emit("open-task", OpenTask { session_id: None });
            return;
        };
        let target = handle
            .state::<crate::AppState>()
            .store
            .lock()
            .ok()
            .and_then(|store| crate::overlay::open_target(&store, &session_id, None, false).ok());
        match target {
            Some(target) => {
                let _ = handle.emit("overlay-open-task", target);
            }
            // The task is gone or unreadable: say so rather than leaving the click dead.
            None => {
                let _ = handle.emit("open-task", OpenTask { session_id: Some(session_id) });
            }
        }
    });
}

/// Plays the named macOS system sound (an NSSound looked up by name, nothing bundled). Other
/// platforms have no sound yet.
#[cfg(target_os = "macos")]
fn play_sound(app: &AppHandle, sound: Option<&str>) {
    use objc2_app_kit::NSSound;
    use objc2_foundation::NSString;
    let Some(sound) = sound else { return };
    if sound == "None" {
        return;
    }
    let app = app.clone();
    let sound = sound.to_owned();
    // AppKit wants the main thread; the command runs on a worker.
    let _ = app.run_on_main_thread(move || {
        let name = NSString::from_str(&sound);
        if let Some(played) = NSSound::soundNamed(&name) {
            played.play();
            // NSSound plays asynchronously and stops when deallocated; forgetting it lets the
            // sound finish (a few hundred bytes per notification).
            std::mem::forget(played);
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn play_sound(_app: &AppHandle, _sound: Option<&str>) {}
