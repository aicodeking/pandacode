//! Desktop notifications when a task needs approval or input, or ends. The webview decides when
//! one may show (src/notifications.ts) and calls `notifications_show`; this module draws the
//! banner through tauri-plugin-notification and plays the chosen macOS system sound. A click on
//! the banner reopens its task.

use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

/// The payload of `open-task`, emitted when the user clicks a notification's banner.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenTask {
    session_id: String,
}

/// Shows one notification (unless the banner is suppressed: the focused chime plays a sound only)
/// and plays the named macOS system sound. The webview passes its own settings and focus gate.
#[tauri::command]
pub fn notifications_show(
    app: AppHandle,
    title: String,
    body: String,
    session_id: Option<String>,
    sound: Option<String>,
    suppress_banner: bool,
) -> Result<(), String> {
    if !suppress_banner {
        let mut builder = app.notification().builder().title(title).body(body);
        if let Some(session_id) = session_id {
            // Round-trips through the plugin's action report, so a click knows which task to open.
            builder = builder.extra("sessionId", session_id);
        }
        builder.show().map_err(|error| error.to_string())?;
    }
    play_sound(&app, sound.as_deref());
    Ok(())
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
        let Some(session_id) = performed
            .notification()
            .and_then(|notification| notification.extra().get("sessionId").cloned())
            .and_then(|value| value.as_str().map(str::to_owned))
        else {
            return;
        };
        let _ = handle.emit("open-task", OpenTask { session_id });
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
