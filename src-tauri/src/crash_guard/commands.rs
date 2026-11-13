//! IPC for the crash notice and the restart setting (main webview only).

use super::protocol::Message;
use super::state::{self, Pending, Settings};
use super::{link, report};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Manager;

/// The notice `start` took out of `crash-guard.json` at setup (`super::take_notice`), held
/// until the main webview says it showed it, and the report name `crash_report_reveal` uses.
struct Holder {
    notice: Mutex<Option<Pending>>,
    /// The report file name of the notice this run handed out (`Pending::report`). Stays
    /// native: the webview never sees a path or a name. Kept after `shown`.
    report: Mutex<Option<String>>,
    /// The unshown notice was written back to the state file at a deliberate exit. Only set
    /// while `notice` is locked, so `shown` and the put-back never interleave.
    put_back: AtomicBool,
}

impl Holder {
    const fn new() -> Self {
        Self { notice: Mutex::new(None), report: Mutex::new(None), put_back: AtomicBool::new(false) }
    }

    fn hold(&self, pending: Pending) {
        *self.notice.lock().unwrap_or_else(|p| p.into_inner()) = Some(pending);
    }

    /// The held notice, not consumed: a page that dies before showing it gets it again.
    fn peek(&self) -> Option<Pending> {
        let pending = self.notice.lock().unwrap_or_else(|p| p.into_inner()).clone()?;
        *self.report.lock().unwrap_or_else(|p| p.into_inner()) = pending.report.clone().filter(|name| report::is_crash_report_name(name));
        Some(pending)
    }

    /// The notice was shown: nothing is handed out again in this run. If it was already put
    /// back for the next launch (the page finished booting during the quit), it is removed from
    /// `dir`'s state file again, so the next launch does not show it a second time.
    fn shown(&self, dir: Option<&std::path::Path>) {
        let mut notice = self.notice.lock().unwrap_or_else(|p| p.into_inner());
        let Some(pending) = notice.take() else { return };
        let Some(dir) = dir.filter(|_| self.put_back.load(Ordering::SeqCst)) else { return };
        let path = state::state_path(dir, super::Mode::Desktop);
        if let Err(error) = state::remove_pending(&path, pending.crashed_at) {
            eprintln!("Could not clear the crash notice kept for the next launch: {error}");
        }
    }

    /// A deliberate exit: writes the notice, if never shown, back to `dir`'s state file (once).
    /// It stays held: a page that finishes booting during the quit still gets it, and `shown`
    /// then takes it out of the file again.
    fn put_back(&self, dir: &std::path::Path) {
        let notice = self.notice.lock().unwrap_or_else(|p| p.into_inner());
        let Some(pending) = notice.clone() else { return };
        if self.put_back.swap(true, Ordering::SeqCst) {
            return;
        }
        let path = state::state_path(dir, super::Mode::Desktop);
        if let Err(error) = state::put_back_pending(&path, pending) {
            eprintln!("Could not keep the crash notice for the next launch: {error}");
        }
    }

    /// This launch's database recovery marked `restart_interrupted` tasks Interrupted: the held
    /// notice keeps it (a put-back carries it to the next launch). True when an unshown notice
    /// is held and says agents were stopped; with no notice held the count belongs to no crash
    /// the guard could report, so it is never kept for a later one.
    fn note_interrupted(&self, restart_interrupted: usize) -> bool {
        let mut notice = self.notice.lock().unwrap_or_else(|p| p.into_inner());
        let counted = restart_interrupted > 0;
        *notice = notice.take().map(|pending| Pending { agents_interrupted: pending.agents_interrupted || counted, ..pending });
        notice.as_ref().is_some_and(|pending| pending.agents_interrupted)
    }

    fn report(&self) -> Option<String> {
        self.report.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

static HOLDER: Holder = Holder::new();

/// Keeps the notice this run took at setup for `crash_recovery_take`, and tells the guard
/// (`held`), which puts it back if this run is killed before its page shows it.
pub(super) fn hold_notice(pending: Pending) {
    HOLDER.hold(pending.clone());
    tell_guard(&Message::Held(pending));
}

/// The guard's view of the held notice, for every resync (`link::resync`): `held` while one
/// is unshown, `shown` otherwise. Locks only the notice: never call it while that is held.
pub(super) fn held_line() -> Message {
    HOLDER.notice.lock().unwrap_or_else(|p| p.into_inner()).clone().map_or(Message::Shown, Message::Held)
}

/// A dropped line marks the link for a resync, which resends `held_line`.
fn tell_guard(message: &Message) {
    if let link::Sent::Failed(error) = link::send(message) {
        eprintln!("Crash guard did not get the crash notice state yet ({error:?}); it is resent.");
    }
}

/// See `Holder::note_interrupted`.
pub(super) fn note_interrupted(restart_interrupted: usize) -> bool {
    HOLDER.note_interrupted(restart_interrupted)
}

/// A deliberate exit: a notice the page never showed (the user quit before it booted) goes
/// back into the desktop state file, so the next launch shows it (`state::put_back_pending`).
pub(super) fn put_back_unshown() {
    if let Some(dir) = link::data_dir() {
        HOLDER.put_back(dir);
    }
}

fn data_dir(app: &tauri::AppHandle) -> crate::Result<std::path::PathBuf> {
    match link::data_dir() {
        Some(dir) => Ok(dir.to_owned()),
        None => app.path().app_data_dir().map_err(|e| e.to_string()),
    }
}

/// The notice as the webview gets it (`CrashRecovery` in the frontend). `summary` is only
/// ever a value from `policy::public_cause`'s closed set: the full text stays in the report.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashRecovery {
    pub crashed_at: u64,
    pub summary: Option<String>,
    pub has_report: bool,
    pub restarts_paused: bool,
    pub restarted: bool,
    /// Running agents were stopped: this launch's database recovery marked at least one task
    /// `restart_interrupted`, or the notice carried it from an earlier launch that never showed
    /// it (`Pending::agents_interrupted`).
    pub agents_interrupted: bool,
}

/// The crash notice `start` took out of `crash-guard.json` at setup (after the single-instance
/// plugin, so a duplicate launch never takes it): the same notice on every call until
/// `crash_recovery_shown`, so a reload after the page died before showing it still gets it.
/// Nothing when this run has no guard.
#[tauri::command]
pub fn crash_recovery_take(state: tauri::State<'_, crate::AppState>) -> Option<CrashRecovery> {
    let interrupted = || state.store.lock().map(|store| store.restart_interrupted).unwrap_or_else(|p| p.into_inner().restart_interrupted);
    let pending = HOLDER.peek()?;
    Some(recovery(pending, interrupted()))
}

/// The main webview showed the notice: `crash_recovery_take` returns nothing for the rest of
/// the run (`crash_report_reveal` still knows its report), and a copy a quit already put back
/// for the next launch is removed again.
#[tauri::command]
pub fn crash_recovery_shown() {
    HOLDER.shown(link::data_dir());
    // The stopped agents belonged to that notice: a later crash must not repeat them.
    link::clear_interrupted();
    // After the notice lock is released: a resync under the link lock takes it too. A lost
    // `shown` would let the guard put the notice back if the app is killed before the next
    // periodic check, so the resync runs at once instead.
    if matches!(link::send(&Message::Shown), link::Sent::Failed(_)) {
        eprintln!("Crash guard did not get that the crash notice was shown; it is resent now.");
        link::repair_soon();
    }
}

fn recovery(pending: Pending, restart_interrupted: usize) -> CrashRecovery {
    CrashRecovery {
        crashed_at: pending.crashed_at,
        // A notice an older guard saved may still hold the raw text: filter it here too.
        summary: pending.summary.as_deref().and_then(super::policy::public_cause),
        has_report: pending.has_report,
        restarts_paused: pending.restarts_paused,
        restarted: pending.restarted,
        agents_interrupted: pending.agents_interrupted || restart_interrupted > 0,
    }
}

#[tauri::command]
pub fn crash_restart_enabled(app: tauri::AppHandle) -> crate::Result<bool> {
    Ok(shown_setting(&data_dir(&app)?, super::ENABLED.load(Ordering::SeqCst)))
}

/// The switch shows what the guard will decide from when the app dies: `crash-restart.json`
/// as it is now, which another process on this data directory (a desktop app beside a `serve`
/// host) may have changed since this one started. `in_memory` (the value loaded at start or
/// last set here, on by default) only when the file is missing or unreadable.
fn shown_setting(dir: &std::path::Path, in_memory: bool) -> bool {
    state::saved_setting(dir).unwrap_or(in_memory)
}

/// Saves the setting and arms or disarms the running guard at once.
#[tauri::command]
pub fn set_crash_restart_enabled(app: tauri::AppHandle, enabled: bool) -> crate::Result<()> {
    let path = data_dir(&app)?.join(state::SETTINGS_FILE);
    state::save(&path, &Settings { enabled }).map_err(|e| format!("Could not save the setting: {e}"))?;
    super::ENABLED.store(enabled, Ordering::SeqCst);
    // Saved either way: with no guard (off by env, failed to start, gone) it applies next launch.
    if link::connected() && link::send(if enabled { &Message::Arm } else { &Message::Disarm }) != link::Sent::Delivered {
        eprintln!("Crash guard did not get the new setting; it applies from the next launch.");
    }
    Ok(())
}

/// The frontend matches `/no crash report/i` on this text.
const NO_REPORT: &str = "There is no crash report on this computer.";

/// Shows this notice's report in the file manager, or the newest when it is gone (or the
/// notice predates report names); the webview never names a path.
#[tauri::command]
pub async fn crash_report_reveal(app: tauri::AppHandle) -> crate::Result<()> {
    let remembered = HOLDER.report();
    let shown_report = report_to_reveal(&data_dir(&app)?, remembered.as_deref()).ok_or(NO_REPORT)?;
    let shown = crate::reveal_path(shown_report.to_string_lossy().into_owned()).await;
    shown.map_err(|error| reveal_error(&shown_report, error))
}

fn report_to_reveal(dir: &std::path::Path, remembered: Option<&str>) -> Option<std::path::PathBuf> {
    remembered.and_then(|name| report::named(dir, name)).or_else(|| report::newest(dir))
}

/// A report pruned between `newest` and the reveal is "no crash report", not `reveal_path`'s
/// attachment wording.
fn reveal_error(report: &std::path::Path, error: String) -> String {
    if std::fs::symlink_metadata(report).is_err() {
        NO_REPORT.into()
    } else {
        error
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_notice_is_held_until_shown_and_its_report_kept_after() {
        let holder = Holder::new();
        assert_eq!(holder.peek(), None);
        let pending = Pending { crashed_at: 5, summary: None, has_report: true, restarts_paused: false, restarted: true, report: Some("5-crash.txt".into()), relaunching: false, agents_interrupted: false, not_restarted: None };
        holder.hold(pending.clone());
        assert_eq!(holder.report(), None, "remembered once handed out");
        // The page died before showing it: the reload gets the same notice.
        assert_eq!(holder.peek(), Some(pending.clone()));
        assert_eq!(holder.peek(), Some(pending));
        holder.shown(None);
        assert_eq!(holder.peek(), None);
        assert_eq!(holder.report().as_deref(), Some("5-crash.txt"));
        // A name that is not a report name (a path) is never remembered.
        let odd = Holder::new();
        odd.hold(Pending { crashed_at: 5, summary: None, has_report: true, restarts_paused: false, restarted: true, report: Some("../x/5-crash.txt".into()), relaunching: false, agents_interrupted: false, not_restarted: None });
        assert!(odd.peek().is_some() && odd.report().is_none());
    }

    #[test]
    fn quitting_before_the_notice_showed_keeps_it_for_the_next_launch() {
        let dir = std::env::temp_dir().join(format!("pandacode-put-back-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pending = Pending { crashed_at: 5, summary: Some("Panic".into()), has_report: true, restarts_paused: false, restarted: true, report: Some("5-panic.txt".into()), relaunching: false, agents_interrupted: false, not_restarted: None };
        let holder = Holder::new();
        holder.hold(pending.clone());
        assert_eq!(holder.peek(), Some(pending.clone()), "the page asked, then the app quit");
        holder.put_back(&dir);
        assert_eq!(state::take_pending(&dir, super::super::Mode::Desktop, 5), Some(pending.clone()));
        // Put back once: a second exit line writes nothing.
        holder.put_back(&dir);
        assert_eq!(state::take_pending(&dir, super::super::Mode::Desktop, 5), None);
        // Shown before the quit: nothing comes back.
        let shown = Holder::new();
        shown.hold(pending);
        shown.shown(Some(&dir));
        shown.put_back(&dir);
        assert_eq!(state::take_pending(&dir, super::super::Mode::Desktop, 5), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn agents_stopped_survive_a_quit_before_the_notice_showed() {
        let dir = std::env::temp_dir().join(format!("pandacode-put-back-agents-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pending = Pending { crashed_at: 5, summary: None, has_report: true, restarts_paused: false, restarted: true, report: None, relaunching: false, agents_interrupted: false, not_restarted: None };
        let holder = Holder::new();
        holder.hold(pending);
        // This launch's database recovery marked two tasks Interrupted; then the user quit.
        assert!(holder.note_interrupted(2));
        holder.put_back(&dir);
        // The next launch counts none of its own, and still says agents were stopped.
        let next = state::take_pending(&dir, super::super::Mode::Desktop, 5).unwrap();
        assert!(recovery(next, 0).agents_interrupted);
        // A held notice that carried it says so with no count; nothing held, nothing counted: no.
        let carried = Holder::new();
        carried.hold(Pending { crashed_at: 6, summary: None, has_report: false, restarts_paused: false, restarted: false, report: None, relaunching: false, agents_interrupted: true, not_restarted: None });
        assert!(carried.note_interrupted(0) && carried.peek().unwrap().agents_interrupted);
        assert!(!Holder::new().note_interrupted(0) && !Holder::new().note_interrupted(1), "no notice held: never kept for a later crash");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_notice_shown_after_it_was_put_back_is_not_shown_again_next_launch() {
        let dir = std::env::temp_dir().join(format!("pandacode-put-back-shown-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pending = Pending { crashed_at: 5, summary: Some("Panic".into()), has_report: true, restarts_paused: false, restarted: true, report: Some("5-panic.txt".into()), relaunching: false, agents_interrupted: false, not_restarted: None };
        let holder = Holder::new();
        holder.hold(pending.clone());
        // Quit during boot: the notice goes back to the file...
        holder.put_back(&dir);
        // ...but the page still finishes booting during the shutdown wait and shows it.
        assert_eq!(holder.peek(), Some(pending.clone()), "still handed out until shown");
        holder.shown(Some(&dir));
        assert_eq!(holder.peek(), None);
        assert_eq!(state::take_pending(&dir, super::super::Mode::Desktop, 5), None, "the next launch does not show it again");
        // A newer crash's notice in the file is never removed by an older notice being shown.
        let other = Holder::new();
        other.hold(pending.clone());
        other.put_back(&dir);
        let path = state::state_path(&dir, super::super::Mode::Desktop);
        let newer = Pending { crashed_at: 9, ..pending };
        state::save(&path, &state::GuardState { crashes: Vec::new(), pending: Some(newer.clone()) }).unwrap();
        other.shown(Some(&dir));
        assert_eq!(state::take_pending(&dir, super::super::Mode::Desktop, 9), Some(newer));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_report_gone_before_the_reveal_reads_as_no_crash_report() {
        let gone = std::env::temp_dir().join(format!("pandacode-no-report-{}", uuid::Uuid::new_v4()));
        let failed = "This attachment is no longer on this computer.".to_string();
        assert_eq!(reveal_error(&gone, failed), NO_REPORT);
        let here = std::env::temp_dir();
        assert_eq!(reveal_error(&here, "Could not open the folder".into()), "Could not open the folder");
    }

    #[test]
    fn the_reveal_shows_this_notices_report_and_falls_back_to_the_newest() {
        let dir = std::env::temp_dir().join(format!("pandacode-crash-reveal-{}", uuid::Uuid::new_v4()));
        assert_eq!(report_to_reveal(&dir, Some("1-crash.txt")), None);
        let ours = report::write(&dir, report::Kind::Crash, 10, "desktop").unwrap();
        // A `serve` host on the same data directory crashed later.
        let newest = report::write(&dir, report::Kind::Panic, 20, "serve").unwrap();
        assert_eq!(report_to_reveal(&dir, Some("10-crash.txt")), Some(ours.clone()));
        assert_eq!(report_to_reveal(&dir, None), Some(newest.clone()));
        // Pruned, or not a report name (never a path): the newest.
        assert_eq!(report_to_reveal(&dir, Some("11-crash.txt")), Some(newest.clone()));
        assert_eq!(report_to_reveal(&dir, Some("../crash-reports/10-crash.txt")), Some(newest.clone()));
        std::fs::remove_file(&ours).unwrap();
        assert_eq!(report_to_reveal(&dir, Some("10-crash.txt")), Some(newest));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_switch_shows_the_saved_setting_not_the_one_loaded_at_start() {
        let dir = std::env::temp_dir().join(format!("pandacode-crash-setting-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // No file: the in-memory value.
        assert!(shown_setting(&dir, true) && !shown_setting(&dir, false));
        // Another process on this data directory switched it off, then on.
        state::save(&dir.join(state::SETTINGS_FILE), &Settings { enabled: false }).unwrap();
        assert!(!shown_setting(&dir, true));
        state::save(&dir.join(state::SETTINGS_FILE), &Settings { enabled: true }).unwrap();
        assert!(shown_setting(&dir, false));
        // An unreadable file falls back too.
        std::fs::write(dir.join(state::SETTINGS_FILE), "{not json").unwrap();
        assert!(shown_setting(&dir, true) && !shown_setting(&dir, false));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_payload_is_camel_case_and_flat_with_agents_interrupted() {
        let pending = Pending { crashed_at: 5, summary: None, has_report: true, restarts_paused: false, restarted: true, report: None, relaunching: false, agents_interrupted: false, not_restarted: None };
        let json = serde_json::to_value(recovery(pending.clone(), 2)).unwrap();
        assert_eq!(json, serde_json::json!({"crashedAt": 5, "summary": null, "hasReport": true, "restartsPaused": false, "restarted": true, "agentsInterrupted": true}));
        assert!(!recovery(pending.clone(), 0).agents_interrupted);
        assert!(recovery(Pending { agents_interrupted: true, ..pending }, 0).agents_interrupted, "carried from an unshown notice");
    }

    #[test]
    fn panic_text_never_reaches_the_payload() {
        let summary = "Panic: could not open /Users/alice/Secret Project/notes.md: denied".to_string();
        let pending = Pending { crashed_at: 5, summary: Some(summary), has_report: true, restarts_paused: false, restarted: true, report: None, relaunching: false, agents_interrupted: false, not_restarted: None };
        let json = serde_json::to_string(&recovery(pending.clone(), 0)).unwrap();
        assert!(!json.contains("/Users") && !json.contains("alice") && !json.contains("denied"), "{json}");
        assert_eq!(serde_json::from_str::<serde_json::Value>(&json).unwrap()["summary"], "Panic");
        let other = Pending { summary: Some("Crashed with exception 0xDEAD0001".into()), ..pending };
        assert_eq!(recovery(other, 0).summary, None);
    }

    #[test]
    fn opening_the_store_counts_only_tasks_this_restart_interrupted() {
        let path = std::env::temp_dir().join(format!("pandacode-crash-interrupted-{}.sqlite3", uuid::Uuid::new_v4()));
        {
            let store = crate::storage::Store::open(&path).unwrap();
            let project = store.add_project(&std::env::temp_dir()).unwrap();
            let ids: Vec<String> = (0..3).map(|_| store.create_session(&project.id, "claude", "sonnet", "auto").unwrap().id).collect();
            store.db.execute("UPDATE sessions SET status='running' WHERE id IN (?1,?2)", [&ids[0], &ids[1]]).unwrap();
            // The user pressed Stop on this one before the crash: not interrupted by it.
            store.db.execute("UPDATE sessions SET stop_requested=1 WHERE id=?1", [&ids[1]]).unwrap();
            // Archived: no visible task shows Interrupted, so the notice must not count it.
            store.db.execute("UPDATE sessions SET status='running',archived=1 WHERE id=?1", [&ids[2]]).unwrap();
        }
        assert_eq!(crate::storage::Store::open(&path).unwrap().restart_interrupted, 1);
        // Marked once: a later launch does not count it again.
        assert_eq!(crate::storage::Store::open(&path).unwrap().restart_interrupted, 0);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
}
