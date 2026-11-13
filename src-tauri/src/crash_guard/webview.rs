#![cfg_attr(not(target_os = "macos"), allow(dead_code))]
//! macOS: when WKWebView's web content process dies the window goes blank while the app
//! lives. Tauri (`Builder::on_web_content_process_terminate`, backed by wry's
//! `webViewWebContentProcessDidTerminate:`) lets us reload it. Each webview has its own
//! reload budget, so a hostile page killing its own renderer (browser content) or memory
//! pressure ending every renderer at once never spends `main`'s. When `main` runs out, a
//! native dialog offers a restart instead of leaving a blank window.

use std::collections::HashMap;

/// Terminations within this window count towards a webview's limit.
pub const WEB_CRASH_WINDOW_MS: u64 = 60 * 1000;
/// Reloads allowed per webview within the window; the next termination is not reloaded.
pub const MAX_WEB_RELOADS: usize = 3;
/// PandaCode's own webviews (tauri.conf.json, tray.rs, overlay.rs, agents_dock.rs). Any other
/// label (the in-app browser is `browser-guest`, browser.rs) is browser content: reloaded
/// within its budget, but never reported.
const APP_WEBVIEWS: [&str; 4] = ["main", "tray", "launcher", "agents-dock"];
const MAIN: &str = "main";

pub fn is_app_webview(label: &str) -> bool {
    APP_WEBVIEWS.contains(&label)
}

/// A termination at `at` still counts at `now` (one dated after `now`, a clock set back, does not).
fn in_window(at: u64, now: u64) -> bool {
    at <= now && now - at < WEB_CRASH_WINDOW_MS
}

/// Termination times kept, with whether to reload after the newest (`now`).
pub fn should_reload(history: &[u64], now: u64) -> (Vec<u64>, bool) {
    let mut recent: Vec<u64> = history.iter().copied().filter(|at| in_window(*at, now)).collect();
    let reload = recent.len() < MAX_WEB_RELOADS;
    recent.push(now);
    (recent, reload)
}

/// One termination of webview `label` at `now`, against per-label budgets. Labels with no
/// termination left in the window are dropped, so closed webviews (browser tabs) do not pile up.
pub fn record(budgets: &mut HashMap<String, Vec<u64>>, label: &str, now: u64) -> bool {
    budgets.retain(|_, history| history.iter().any(|at| in_window(*at, now)));
    let history = budgets.entry(label.to_owned()).or_default();
    let (next, reload) = should_reload(history, now);
    *history = next;
    reload
}

#[cfg(target_os = "macos")]
pub fn on_terminate(webview: &tauri::Webview) {
    static BUDGETS: std::sync::Mutex<Option<HashMap<String, Vec<u64>>>> = std::sync::Mutex::new(None);
    let now = super::guard::now_ms();
    let label = webview.label().to_owned();
    let reload = {
        let mut budgets = BUDGETS.lock().unwrap_or_else(|p| p.into_inner());
        record(budgets.get_or_insert_with(HashMap::new), &label, now)
    };
    if is_app_webview(&label) {
        report(&label, reload, now);
    }
    if reload {
        if let Err(error) = webview.reload() {
            eprintln!("Could not reload the {label:?} webview: {error}");
        }
    } else if label == MAIN {
        offer_restart(tauri::Manager::app_handle(webview));
    }
}

#[cfg(target_os = "macos")]
fn report(label: &str, reload: bool, now: u64) {
    let cause = if reload {
        format!("The web content process of the {label:?} webview ended; it was reloaded.")
    } else {
        format!("The web content process of the {label:?} webview kept ending; it was not reloaded again.")
    };
    eprintln!("{cause}");
    if let Some(dir) = super::link::data_dir() {
        if let Err(error) = super::report::write(dir, super::report::Kind::Webview, now, &super::report::death_text(&cause, now)) {
            eprintln!("Could not write a webview crash report: {error}");
        }
    }
}

/// What the restart dialog says. "Not Now" leaves the blank window as it is, so the message
/// names the way back: quitting and reopening.
const RESTART_MESSAGE: &str = "PandaCode's window keeps failing. Restarting usually fixes it but stops running agents. Not Now keeps the window blank until you quit and reopen.";

/// The window's content keeps failing: ask, then restart through the normal quit path (a
/// deliberate exit, so the guard does not count it as a crash).
#[cfg(target_os = "macos")]
fn offer_restart(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let handle = app.clone();
    app.dialog()
        .message(RESTART_MESSAGE)
        .title("PandaCode needs to restart")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Restart PandaCode".into(), "Not Now".into()))
        .show(move |restart| {
            if restart {
                handle.request_restart();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reloads_stop_after_the_limit_and_resume_after_the_window() {
        let mut history = Vec::new();
        let mut reloads = Vec::new();
        for at in [0, 1_000, 2_000, 3_000] {
            let (next, reload) = should_reload(&history, at);
            history = next;
            reloads.push(reload);
        }
        assert_eq!(reloads, [true, true, true, false]);
        let (_, reload) = should_reload(&history, 3_000 + WEB_CRASH_WINDOW_MS);
        assert!(reload);
    }

    #[test]
    fn each_webview_has_its_own_budget() {
        let mut budgets = HashMap::new();
        // A hostile page kills its renderer over and over…
        let browser: Vec<bool> = (0..5).map(|i| record(&mut budgets, "browser-guest", i)).collect();
        assert_eq!(browser, [true, true, true, false, false]);
        // …and memory pressure then ends every renderer at once: main still reloads.
        assert!(["main", "tray", "launcher", "agents-dock"].iter().all(|label| record(&mut budgets, label, 10)));
    }

    #[test]
    fn webviews_with_no_recent_termination_are_forgotten() {
        let mut budgets = HashMap::new();
        record(&mut budgets, "browser-guest", 0);
        record(&mut budgets, "main", WEB_CRASH_WINDOW_MS - 1);
        assert_eq!(budgets.len(), 2);
        record(&mut budgets, "tray", WEB_CRASH_WINDOW_MS);
        let mut labels: Vec<&str> = budgets.keys().map(String::as_str).collect();
        labels.sort_unstable();
        assert_eq!(labels, ["main", "tray"]);
    }

    #[test]
    fn the_restart_dialog_says_agents_stop_and_how_to_restart_later() {
        assert!(RESTART_MESSAGE.contains("Restarting usually fixes it but stops running agents."));
        assert!(RESTART_MESSAGE.ends_with("Not Now keeps the window blank until you quit and reopen."));
        assert_eq!(RESTART_MESSAGE.matches(". ").count() + 1, 3, "three short sentences");
    }

    #[test]
    fn only_app_webviews_are_reported() {
        assert!(is_app_webview("main") && is_app_webview("agents-dock"));
        assert!(!is_app_webview("browser-guest") && !is_app_webview(""));
    }
}
