//! Asks before quitting while local agents run. Called from the one `ExitRequested`
//! handler, so the tray, Cmd+Q, closing the last window and `app.exit` all pass through it.
//!
//! Extensions (R0107): the one quit account also holds the extension packages that are still working — a background
//! service that reported `working: true` or owned tool jobs that are running — each package once, however many jobs
//! it runs (`extensions::runtime_service_lifetime::runtime_service_status::quit_packages`). With no package working
//! the question and its wording are exactly the original's.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// An extension package still working when the user asks to quit: its service's status line while it reports
/// `working: true`, and the number of its owned tool jobs that are running.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkingPackage { pub id: String, pub text: Option<String>, pub jobs: usize }
/// Everything quitting would stop: local agents, then extension packages (each once).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct QuitAccount { pub agents: usize, pub packages: Vec<WorkingPackage> }
impl QuitAccount {
    /// Agents and working packages; a package counts once whatever it runs.
    pub(crate) fn total(&self) -> usize { self.agents + self.packages.len() }
}

/// `should_confirm_quit` for the whole account.
pub(crate) fn should_confirm(account: &QuitAccount, headless: bool, confirmed: bool, shutting_down: bool, restart: bool) -> bool {
    should_confirm_quit(account.total(), headless, confirmed, shutting_down, restart)
}

/// The original sentence for agents alone; otherwise the agents sentence (if any), then the working packages by id
/// with their status line and running jobs, then what quitting does.
pub(crate) fn account_message(account: &QuitAccount) -> String {
    if account.packages.is_empty() { return quit_message(account.agents); }
    let mut text = match account.agents {
        0 => String::new(),
        1 => "1 agent is still running. ".into(),
        agents => format!("{agents} agents are still running. "),
    };
    let named: Vec<String> = account.packages.iter().map(|package| {
        let mut details = Vec::new();
        if let Some(status) = package.text.as_deref().map(display_text).filter(|status| !status.is_empty()) { details.push(status); }
        match package.jobs { 0 => {}, 1 => details.push("1 job running".into()), jobs => details.push(format!("{jobs} jobs running")) }
        if details.is_empty() { package.id.clone() } else { format!("{} ({})", package.id, details.join("; ")) }
    }).collect();
    text.push_str(if named.len() == 1 { "Extension still working: " } else { "Extensions still working: " });
    text.push_str(&named.join(", "));
    text.push_str(if account.total() == 1 { ". Quitting stops it." } else { ". Quitting stops them." });
    text
}
/// A package's status line as the dialog shows it: one line without control characters, at most 80 characters.
fn display_text(text: &str) -> String {
    let line: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let line = line.trim();
    if line.chars().count() <= 80 { line.to_owned() } else { format!("{}…", line.chars().take(79).collect::<String>().trim_end()) }
}

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

/// Shows the warning without blocking the event loop; Quit re-requests the exit. The account is taken when the user
/// asks to quit: work that ends while the dialog is up does not change it, and the next request counts again.
pub(crate) fn ask_account(app: &tauri::AppHandle, account: &QuitAccount) {
    if ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    app.dialog()
        .message(account_message(account))
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

    fn package(id: &str, text: Option<&str>, jobs: usize) -> WorkingPackage { WorkingPackage { id: id.into(), text: text.map(str::to_owned), jobs } }

    /// R0107: with no package working the account asks and words exactly as the original; a working package is named
    /// once (its status line and running jobs together); clearing the work removes it from the question.
    #[test]
    fn the_quit_account_names_working_packages_once_and_keeps_the_original_wording_without_them() {
        for agents in [0, 1, 3] {
            let account = QuitAccount { agents, packages: Vec::new() };
            assert_eq!(should_confirm(&account, false, false, false, false), should_confirm_quit(agents, false, false, false, false));
            assert_eq!(account_message(&account), quit_message(agents));
        }
        let working = QuitAccount { agents: 0, packages: vec![package("sample.service-status", Some("Indexing 3 files"), 0)] };
        assert!(should_confirm(&working, false, false, false, false), "a working service alone asks");
        assert_eq!(account_message(&working), "Extension still working: sample.service-status (Indexing 3 files). Quitting stops it.");
        for (headless, confirmed, shutting_down, restart) in [(true, false, false, false), (false, true, false, false), (false, false, true, false), (false, false, false, true)] {
            assert!(!should_confirm(&working, headless, confirmed, shutting_down, restart));
        }
        let both = QuitAccount { agents: 1, packages: vec![package("a.one", Some("Syncing"), 2), package("b.two", None, 1)] };
        assert_eq!(both.total(), 3, "a package with a working service and two jobs counts once");
        assert_eq!(account_message(&both), "1 agent is still running. Extensions still working: a.one (Syncing; 2 jobs running), b.two (1 job running). Quitting stops them.");
        let long = QuitAccount { agents: 2, packages: vec![package("c.three", Some(&format!("line\none {}", "x".repeat(200))), 0)] };
        let message = account_message(&long);
        assert!(message.starts_with("2 agents are still running. Extension still working: c.three (line one xxx"), "{message}");
        assert!(message.contains("…). Quitting stops them.") && !message.contains('\n'), "{message}");
        let cleared = QuitAccount { agents: 0, packages: Vec::new() };
        assert!(!should_confirm(&cleared, false, false, false, false), "cleared work: no question");
    }
}
