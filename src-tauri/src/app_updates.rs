//! PandaCode's own updates.
//!
//! Two owners share one state, deliberately. The updater itself runs in the webview
//! (`src/app-updates.ts`): it checks GitHub Releases at launch and every six hours, downloads a
//! newer version in the background and installs it with a restart once nothing is running. Rust
//! owns the half a paired phone needs (docs/remote-access.md, "Updates"): whether an update is
//! waiting, whether this copy can install over itself, a restart in flight, and the last check's
//! failure. `host.updateStatus`, `host.checkUpdate` and `host.updateAndRestart`
//! (`remote/methods/host_methods.rs`) read and write the same state as the page — so a phone sees a
//! check the desktop already made without a second request to GitHub, and the page's own automatic
//! check keeps working unchanged. Whichever side checked last wins; that is deliberate.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

/// Longest version or error text kept: a phone shows it, and its page has a budget.
const MAX_VERSION: usize = 64;
const MAX_ERROR: usize = 300;

/// What is known about this computer's update, shared by the webview's updater and the remote
/// `host.*` methods.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct HostUpdateState {
    /// The running version, once a publisher said; empty until then.
    pub(crate) current: String,
    /// The version an update would install, when one was found.
    pub(crate) pending: Option<String>,
    /// Whether this copy may install over itself (`install_supported`).
    pub(crate) installable: bool,
    /// An install-and-restart is under way.
    pub(crate) restarting: bool,
    /// The last check's failure, a short sentence.
    pub(crate) error: Option<String>,
    /// Whether the webview (or a remote check) has published anything yet. Until it has, the status
    /// answers the running version and how this copy was installed instead of blank values.
    pub(crate) published: bool,
}

fn state() -> &'static Mutex<HostUpdateState> {
    static STATE: OnceLock<Mutex<HostUpdateState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HostUpdateState::default()))
}

fn locked() -> MutexGuard<'static, HostUpdateState> {
    state().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Reads the shared state under the lock.
pub(crate) fn read<R>(f: impl FnOnce(&HostUpdateState) -> R) -> R {
    f(&locked())
}

/// Changes the shared state under the lock.
pub(crate) fn update<R>(f: impl FnOnce(&mut HostUpdateState) -> R) -> R {
    f(&mut locked())
}

impl HostUpdateState {
    /// Whether this copy may install in place: what a publisher said, else `fallback`.
    pub(crate) fn installable(&self, fallback: bool) -> bool {
        if self.published {
            self.installable
        } else {
            fallback
        }
    }

    /// The wire shape `host.updateStatus` and `host.checkUpdate` answer, with `fallback_version`
    /// (this build's own) and `fallback_installable` standing in for a state nothing published.
    pub(crate) fn to_json(&self, fallback_version: &str, fallback_installable: bool) -> Value {
        json!({
            "currentVersion": if self.current.is_empty() { fallback_version } else { &self.current },
            "update": self.pending.as_ref().map(|version| json!({"version": version})),
            "installable": self.installable(fallback_installable),
            "restarting": self.restarting,
            "error": self.error,
        })
    }
}

fn bounded(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

/// Records one check's outcome: a version found, nothing new, or why it failed. A failure clears
/// the pending version (it may no longer be there) and never leaves a restart promised.
pub(crate) fn apply_check(state: &mut HostUpdateState, current: &str, outcome: Result<Option<String>, String>) {
    state.published = true;
    if !current.is_empty() {
        state.current = bounded(current, MAX_VERSION);
    }
    match outcome {
        Ok(pending) => {
            state.pending = pending.map(|version| bounded(&version, MAX_VERSION));
            state.error = None;
        }
        Err(error) => {
            state.pending = None;
            state.error = Some(bounded(&error, MAX_ERROR));
        }
    }
}

/// Records a failed install: no restart is coming, and the phone sees why.
pub(crate) fn apply_failure(state: &mut HostUpdateState, error: &str) {
    state.published = true;
    state.restarting = false;
    state.error = Some(bounded(error, MAX_ERROR));
}

/// Records that a restart it had promised is not coming because nothing was left to install (the
/// release was withdrawn between the check and the download): no error, no pending version.
pub(crate) fn apply_up_to_date(state: &mut HostUpdateState) {
    state.published = true;
    state.restarting = false;
    state.pending = None;
    state.error = None;
}

/// Atomically takes the restart: `true` for the one caller that got it, `false` when a restart is
/// already under way. Two callers (two phones, or a retried call) cannot both start an install.
pub(crate) fn claim_restart() -> bool {
    update(|state| {
        if state.restarting {
            return false;
        }
        state.published = true;
        state.restarting = true;
        state.error = None;
        true
    })
}

/// The wire shape a phone reads, seeding this build's version and installability when nothing has
/// been published yet, so a fresh host answers sensibly rather than blank.
pub(crate) fn status_json(version: &str) -> Value {
    read(|state| state.to_json(version, install_supported_now()))
}

/// Whether this copy may install over itself, from the shared state or, before anything published,
/// from how it was installed.
pub(crate) fn installable_now() -> bool {
    read(|state| state.installable(install_supported_now()))
}

/// Whether the updater may install over this copy. On Linux it replaces `$APPIMAGE`, or
/// else the running executable: an unpacked AppImage or a distro package would get a whole
/// AppImage written over its program, so those copies only report updates.
#[tauri::command]
pub fn app_update_install_supported() -> bool {
    install_supported_now()
}

fn install_supported_now() -> bool {
    install_supported(cfg!(target_os = "linux"), std::env::var_os("APPIMAGE").is_some_and(|path| !path.is_empty()))
}

fn install_supported(linux: bool, appimage: bool) -> bool {
    !linux || appimage
}

/// What the webview's updater knows, from `src/app-updates.ts`: called after every state change so
/// a phone's `host.updateStatus` shows a check the desktop already made. `current` is empty until
/// the page has read its own version; the status then answers this build's.
#[tauri::command]
pub fn app_update_publish(current: String, pending: Option<String>, installable: bool, error: Option<String>) {
    update(|state| {
        state.published = true;
        if !current.trim().is_empty() {
            state.current = bounded(current.trim(), MAX_VERSION);
        }
        state.pending = pending.filter(|version| !version.trim().is_empty()).map(|version| bounded(version.trim(), MAX_VERSION));
        state.installable = installable;
        state.error = error.filter(|message| !message.trim().is_empty()).map(|message| bounded(message.trim(), MAX_ERROR));
    });
}

/// One updater check at a time. A caller that arrives while another check runs waits for it and
/// shares its answer instead of asking GitHub again.
#[derive(Default)]
pub(crate) struct CheckGate {
    running: tokio::sync::Mutex<()>,
    finished: AtomicU64,
}

impl CheckGate {
    /// Runs `check` unless another caller finished one while this caller waited, in which case it
    /// answers `None` and the state already holds the shared answer.
    pub(crate) async fn run<T>(&self, check: impl std::future::Future<Output = T>) -> Option<T> {
        let seen = self.finished.load(Ordering::SeqCst);
        let _turn = self.running.lock().await;
        if self.finished.load(Ordering::SeqCst) != seen {
            return None;
        }
        let outcome = check.await;
        self.finished.fetch_add(1, Ordering::SeqCst);
        Some(outcome)
    }
}

/// The one gate every check passes through, so two phones never make two requests at once.
pub(crate) fn checks() -> &'static CheckGate {
    static CHECKS: OnceLock<CheckGate> = OnceLock::new();
    CHECKS.get_or_init(CheckGate::default)
}

/// The shared state is process-global, so tests that read or write it take turns here and reset it
/// first, whatever module they live in.
#[cfg(test)]
pub(crate) fn test_lock() -> MutexGuard<'static, ()> {
    static TESTS: Mutex<()> = Mutex::new(());
    let guard = TESTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *locked() = HostUpdateState::default();
    guard
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_installs_only_over_an_appimage() {
        assert!(install_supported(false, false));
        assert!(install_supported(true, true));
        assert!(!install_supported(true, false));
    }

    #[test]
    fn an_unpublished_status_answers_this_build_and_how_it_was_installed() {
        let state = HostUpdateState::default();
        let status = state.to_json("0.3.161", false);
        assert_eq!(status["currentVersion"], "0.3.161");
        assert_eq!(status["update"], Value::Null);
        assert_eq!(status["installable"], false, "the fallback, not the state's default");
        assert_eq!(status["restarting"], false);
        assert_eq!(status["error"], Value::Null);
    }

    #[test]
    fn a_pending_update_is_a_version_object_and_other_fields_survive() {
        let state = HostUpdateState { current: "0.3.161".into(), pending: Some("0.3.162".into()), installable: true, restarting: true, error: None, published: true };
        let status = state.to_json("9.9.9", false);
        assert_eq!(status["currentVersion"], "0.3.161", "the published version, not the fallback");
        assert_eq!(status["update"], json!({"version": "0.3.162"}));
        assert_eq!(status["installable"], true);
        assert_eq!(status["restarting"], true);
        assert_eq!(status["error"], Value::Null);
    }

    #[test]
    fn an_error_status_carries_the_sentence_and_no_update() {
        let state = HostUpdateState { current: "0.3.161".into(), pending: None, installable: true, restarting: false, error: Some("Couldn’t check: offline.".into()), published: true };
        let status = state.to_json("0.3.161", true);
        assert_eq!(status["update"], Value::Null);
        assert_eq!(status["error"], "Couldn’t check: offline.");
    }

    #[test]
    fn a_failed_check_records_the_error_and_leaves_no_pending_update() {
        // A pending version from an earlier check must not survive a failure: it may be gone.
        let mut state = HostUpdateState { pending: Some("0.3.162".into()), installable: true, ..Default::default() };
        apply_check(&mut state, "0.3.161", Err("Couldn’t check for updates: offline.".into()));
        assert_eq!(state.pending, None);
        assert_eq!(state.error.as_deref(), Some("Couldn’t check for updates: offline."));
        assert!(state.published);
        assert_eq!(state.current, "0.3.161");

        // A check that finds nothing clears both the pending version and an older error.
        let mut state = HostUpdateState { pending: Some("0.3.162".into()), error: Some("old".into()), ..Default::default() };
        apply_check(&mut state, "0.3.161", Ok(None));
        assert_eq!((state.pending, state.error), (None, None));

        // A found version becomes the pending update.
        let mut state = HostUpdateState::default();
        apply_check(&mut state, "0.3.161", Ok(Some("0.3.162".into())));
        assert_eq!(state.pending.as_deref(), Some("0.3.162"));
    }

    #[test]
    fn a_failed_install_stops_the_restart_and_records_why() {
        let mut state = HostUpdateState { restarting: true, installable: true, ..Default::default() };
        apply_failure(&mut state, "Couldn’t install PandaCode: disk full.");
        assert!(!state.restarting);
        assert_eq!(state.error.as_deref(), Some("Couldn’t install PandaCode: disk full."));
    }

    #[test]
    fn published_text_is_cut_to_what_a_page_can_show() {
        let mut state = HostUpdateState::default();
        apply_check(&mut state, &"9".repeat(200), Ok(Some("1".repeat(200))));
        assert_eq!(state.current.len(), MAX_VERSION);
        assert_eq!(state.pending.as_ref().map(String::len), Some(MAX_VERSION));
        let mut state = HostUpdateState::default();
        apply_check(&mut state, "1", Err("e".repeat(2_000)));
        assert_eq!(state.error.as_ref().map(String::len), Some(MAX_ERROR));
    }

    #[tokio::test]
    async fn checks_that_overlap_share_one_run() {
        let gate = CheckGate::default();
        let runs = std::sync::atomic::AtomicU64::new(0);
        let work = || async {
            runs.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            "answer"
        };
        let (first, second) = tokio::join!(gate.run(work()), gate.run(work()));
        // One of the two ran the check; the other shared its answer.
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert_eq!([first, second].iter().filter(|outcome| outcome.is_some()).count(), 1);
        // A caller after the check ran starts a new one.
        assert_eq!(gate.run(work()).await, Some("answer"));
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn only_one_caller_can_claim_the_restart() {
        let _tests = test_lock();
        assert!(claim_restart(), "the first caller takes it");
        assert!(read(|state| state.restarting));
        assert!(!claim_restart(), "a second caller must not start another install");
        // A failed install hands it back, so a phone can ask again.
        update(|state| apply_failure(state, "Couldn’t install PandaCode."));
        assert!(!read(|state| state.restarting));
        assert!(claim_restart());
    }

    #[test]
    fn publishing_records_what_the_page_knows() {
        let _tests = test_lock();
        // A page that has not read its version yet publishes an empty `current` first: the status
        // answers this build's version rather than going blank.
        app_update_publish(String::new(), None, true, None);
        assert_eq!(status_json("9.9.9")["currentVersion"], "9.9.9");

        app_update_publish("0.3.161".into(), Some("0.3.162".into()), true, None);
        let status = status_json("9.9.9");
        assert_eq!(status["currentVersion"], "0.3.161");
        assert_eq!(status["update"], json!({"version": "0.3.162"}));
        assert_eq!(status["installable"], true);
        assert_eq!(status["error"], Value::Null);
        assert!(installable_now());

        // A later publish with a found version cleared and an error records both, and keeps the
        // version it already knew instead of blanking it.
        app_update_publish(String::new(), None, true, Some("Couldn’t check: offline.".into()));
        let status = status_json("9.9.9");
        assert_eq!(status["currentVersion"], "0.3.161");
        assert_eq!(status["update"], Value::Null);
        assert_eq!(status["error"], "Couldn’t check: offline.");
    }
}
