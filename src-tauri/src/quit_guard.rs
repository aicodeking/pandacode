//! Asks before quitting while local agents run. Called from the one `ExitRequested`
//! handler, so the tray, Cmd+Q, closing the last window and `app.exit` all pass through it.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Set once the user picks Quit, so the follow-up exit request goes through.
static CONFIRMED: AtomicBool = AtomicBool::new(false);
/// True while the dialog is up, so a repeated Cmd+Q does not stack a second one.
static ASKING: AtomicBool = AtomicBool::new(false);

/// Whether this exit request must wait for the user. Headless has no UI, a shutdown
/// already under way is past asking, and a restart (updater) must never be held.
pub(crate) fn should_confirm_quit(local_running: usize, headless: bool, confirmed: bool, shutting_down: bool, restart: bool) -> bool {
    local_running > 0 && !headless && !confirmed && !shutting_down && !restart
}

pub(crate) fn quit_message(local_running: usize) -> String {
    if local_running == 1 {
        "1 agent is still running. Quitting stops it.".into()
    } else {
        format!("{local_running} agents are still running. Quitting stops them.")
    }
}

pub(crate) fn confirmed() -> bool {
    CONFIRMED.load(Ordering::SeqCst)
}

/// Shows the warning without blocking the event loop; Quit re-requests the exit.
pub(crate) fn ask(app: &tauri::AppHandle, local_running: usize) {
    if ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    app.dialog()
        .message(quit_message(local_running))
        .title("Quit PandaCode?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Cancel".into()))
        .show(move |quit| {
            if quit {
                CONFIRMED.store(true, Ordering::SeqCst);
                handle.exit(0);
            }
            ASKING.store(false, Ordering::SeqCst);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_asks_only_with_local_agents_and_an_unconfirmed_ui_quit() {
        assert!(should_confirm_quit(1, false, false, false, false));
        assert!(should_confirm_quit(3, false, false, false, false));
        assert!(!should_confirm_quit(0, false, false, false, false), "no local agent");
        assert!(!should_confirm_quit(1, true, false, false, false), "headless");
        assert!(!should_confirm_quit(1, false, true, false, false), "already confirmed");
        assert!(!should_confirm_quit(1, false, false, true, false), "shutting down");
        assert!(!should_confirm_quit(1, false, false, false, true), "restart");
    }

    #[test]
    fn quit_message_counts_agents() {
        assert_eq!(quit_message(1), "1 agent is still running. Quitting stops it.");
        assert_eq!(quit_message(2), "2 agents are still running. Quitting stops them.");
    }
}
