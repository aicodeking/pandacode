//! Small JSON files in the app data dir. `crash-guard.json` (desktop) and
//! `crash-guard-serve.json` (`serve`) are written by that mode's guard after the app died and
//! read (pending cleared) by that mode's next launch: a desktop app and a `serve` host on one
//! data dir never take each other's notice or count each other's crashes. `crash-restart.json`
//! holds the user setting, like the other per-feature preference files there. All are written
//! atomically (temp file + rename), read without following a symlink, and a corrupt, missing,
//! linked or oversized file reads as the default. Every load-change-save of a state file
//! (`update`, `replace_pending`, `take_pending`) holds an exclusive lock on its sibling
//! `<file>.lock` (`files::lock_exclusive`), so the app and a guard never lose each other's
//! change; a writer that cannot get it within `LOCK_WAIT` changes nothing.

use super::policy::CrashRecord;
use super::relaunch::Mode;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const STATE_FILE: &str = "crash-guard.json";
pub const SERVE_STATE_FILE: &str = "crash-guard-serve.json";
pub const SETTINGS_FILE: &str = "crash-restart.json";
/// How long a load-change-save waits for another process's lock on the same state file: each
/// holds it only for one small read and write.
pub const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
/// Larger files are not ours (or are corrupt): read as the default.
const MAX_FILE_BYTES: u64 = 64 * 1024;

/// What the next launch tells the user (`CrashRecovery` over IPC).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub crashed_at: u64,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub has_report: bool,
    #[serde(default)]
    pub restarts_paused: bool,
    /// True only when the guard relaunched the app itself; false when the crash was recorded
    /// but nothing was started (paused, the setting off, or the relaunch failed).
    #[serde(default)]
    pub restarted: bool,
    /// The guard launched a relaunch for this crash, not yet confirmed: the launch it started
    /// (marked `--crash-restart=<crashed_at>`) makes the notice `restarted` when it takes it
    /// (`confirmed`). Any other launch (the relaunch died first, or handed off to one the user
    /// opened) shows it as not restarted. Only the guard sets it; false in older files.
    #[serde(default)]
    pub relaunching: bool,
    /// The file name (never a path) of this crash's report in `crash-reports/`, for
    /// `crash_report_reveal`; never sent to the webview. None in files older guards wrote.
    #[serde(default)]
    pub report: Option<String>,
    /// Running agents were stopped by this crash or by an earlier one whose notice was never
    /// shown: carried from notice to notice (`guard::conclude`, `put_back_pending`) until a page
    /// shows it. False in files older guards wrote.
    #[serde(default)]
    pub agents_interrupted: bool,
    /// Why the guard started nothing, when it knows (the `serve` startup line says it);
    /// `restarts_paused` covers the loop limit. None in files older guards wrote.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_restarted: Option<NotRestarted>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotRestarted {
    /// Automatic restarts were off.
    Off,
    /// Starting the relaunch failed.
    Failed,
}

impl Pending {
    /// The notice as the launch taking it tells it: `restarted` once this launch is the
    /// guard's relaunch for this crash (`mark`, from `relaunch::restart_mark`). A `restarted`
    /// an older guard saved stands.
    pub fn confirmed(self, mark: Option<u64>) -> Self {
        let restarted = self.restarted || (self.relaunching && mark == Some(self.crashed_at));
        Self { restarted, relaunching: false, ..self }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuardState {
    #[serde(default)]
    pub crashes: Vec<CrashRecord>,
    #[serde(default)]
    pub pending: Option<Pending>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

fn enabled_by_default() -> bool {
    true
}

/// Lenient: unknown fields, missing fields and garbage all fall back to defaults.
pub fn parse<T: Default + for<'de> Deserialize<'de>>(bytes: Option<&[u8]>) -> T {
    bytes.and_then(|bytes| serde_json::from_slice(bytes).ok()).unwrap_or_default()
}

pub fn load<T: Default + for<'de> Deserialize<'de>>(path: &Path) -> T {
    parse(super::files::read_private(path, MAX_FILE_BYTES).as_deref())
}

/// The restart setting saved in `dir`; None when there is no readable settings file.
pub fn saved_setting(dir: &Path) -> Option<bool> {
    let bytes = super::files::read_private(&dir.join(SETTINGS_FILE), MAX_FILE_BYTES)?;
    serde_json::from_slice::<Settings>(&bytes).ok().map(|settings| settings.enabled)
}

/// Owner-only (0600 on Unix) and atomic.
pub fn save<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    super::files::write_private_atomic(path, &bytes)
}

/// The state file of `mode`'s guard.
pub fn state_path(dir: &Path, mode: Mode) -> PathBuf {
    dir.join(match mode {
        Mode::Desktop => STATE_FILE,
        Mode::Serve => SERVE_STATE_FILE,
    })
}

/// Reads the state as it is now, changes it and saves it, under the lock; returns what was
/// saved.
pub fn update(path: &Path, change: impl FnOnce(GuardState) -> GuardState) -> std::io::Result<GuardState> {
    let _lock = lock(path)?;
    let next = change(load(path));
    save(path, &next)?;
    Ok(next)
}

/// Replaces the pending notice with `next` only while it is still `expected`, under the lock:
/// false (and nothing written) when another launch took it or another death replaced it
/// meanwhile. Err when the lock cannot be taken: a launch whose clear could not be saved holds
/// it for its whole run (`take_pending`), so the guard cannot prove the notice is still its
/// own and must start nothing.
pub fn replace_pending(path: &Path, expected: &Pending, next: Pending) -> std::io::Result<bool> {
    let _lock = lock(path)?;
    let mut state: GuardState = load(path);
    if state.pending.as_ref() != Some(expected) {
        return Ok(false);
    }
    state.pending = Some(next);
    save(path, &state).map(|()| true)
}

/// Removes and returns `mode`'s pending notice. The crash history keeps only the records the
/// loop limit can still read at `now` (`policy::in_window`): without a later crash nothing
/// else would ever drop them. Nothing is taken when the lock cannot be had: the notice stays
/// for a later launch.
pub fn take_pending(dir: &Path, mode: Mode, now: u64) -> Option<Pending> {
    let path = state_path(dir, mode);
    let lock = self::lock(&path).inspect_err(|error| eprintln!("Could not take the crash notice: {error}")).ok()?;
    let state: GuardState = load(&path);
    let next = GuardState { crashes: super::policy::in_window(&state.crashes, now), pending: None };
    if next == state {
        return state.pending;
    }
    match save(&path, &next) {
        Ok(()) => state.pending,
        Err(error) => {
            eprintln!("Could not clear the crash notice: {error}");
            state.pending.and_then(|pending| clear_by_removing(&path, lock, pending))
        }
    }
}

/// A pending notice older than this is dropped by `prune_old`: that mode was not started since.
pub const MAX_PENDING_AGE_MS: u64 = 90 * 24 * 60 * 60 * 1000;

/// Both modes' state files, under each one's lock: crash times the loop limit no longer reads
/// (`policy::in_window`) and a notice older than `MAX_PENDING_AGE_MS` (or dated more than
/// `report::FUTURE_SLACK_MS` ahead) go, so a mode that never
/// starts again keeps neither forever. A missing file is left missing (no lock file is made).
pub fn prune_old(dir: &Path, now: u64) {
    for mode in [Mode::Desktop, Mode::Serve] {
        let path = state_path(dir, mode);
        if std::fs::symlink_metadata(&path).is_err() {
            continue;
        }
        let pruned = update_if_changed(&path, |state| GuardState {
            crashes: super::policy::in_window(&state.crashes, now),
            // One dated far ahead (a clock set forward) would otherwise never age out.
            pending: state.pending.filter(|pending| now.saturating_sub(pending.crashed_at) <= MAX_PENDING_AGE_MS && pending.crashed_at <= now.saturating_add(super::report::FUTURE_SLACK_MS)),
        });
        if let Err(error) = pruned {
            eprintln!("Could not remove old crash times: {error}");
        }
    }
}

/// `update`, saving only when `change` changed something.
fn update_if_changed(path: &Path, change: impl FnOnce(GuardState) -> GuardState) -> std::io::Result<()> {
    let _lock = lock(path)?;
    let state: GuardState = load(path);
    let next = change(state.clone());
    if next == state {
        return Ok(());
    }
    save(path, &next)
}

/// Writes back a notice this run took but never showed (the app quits before its page
/// booted), so the next launch shows it. Only when no notice of a later (or the same) crash
/// is pending: a newer one already says more, and keeps this one's `agents_interrupted`. Under
/// the lock; the crash history is kept.
pub fn put_back_pending(path: &Path, pending: Pending) -> std::io::Result<()> {
    update_if_changed(path, |state| {
        let interrupted = pending.agents_interrupted || state.pending.as_ref().is_some_and(|p| p.agents_interrupted);
        let kept = match state.pending {
            Some(newer) if newer.crashed_at >= pending.crashed_at => newer,
            _ => pending,
        };
        GuardState { pending: Some(Pending { agents_interrupted: interrupted, ..kept }), crashes: state.crashes }
    })
}

/// Removes the pending notice only when it is the crash at `crashed_at` (a notice put back by
/// `put_back_pending` that the page then showed after all), under the lock.
pub fn remove_pending(path: &Path, crashed_at: u64) -> std::io::Result<()> {
    update_if_changed(path, |state| GuardState { pending: state.pending.filter(|pending| pending.crashed_at != crashed_at), ..state })
}

/// State files whose lock this process keeps on purpose (`clear_by_removing`).
static KEPT_LOCKS: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

/// `path`'s lock, waiting up to `LOCK_WAIT` for another process. One this process keeps on
/// purpose fails at once: a second open file description would wait on our own lock.
fn lock(path: &Path) -> std::io::Result<std::fs::File> {
    if KEPT_LOCKS.lock().unwrap_or_else(|p| p.into_inner()).iter().any(|kept| kept == path) {
        return Err(std::io::Error::other("this launch keeps the crash state locked, as its notice could not be cleared"));
    }
    super::files::lock_exclusive(path, LOCK_WAIT)
}

/// The clear could not be saved (a full disk: the save needs a new temp file). Removing the
/// file needs no space: the notice is then taken, losing the crash history (the loop limit
/// starts again). When even that fails (no write access to the folder) the notice cannot be
/// taken, so it is not handed out (every launch would show it again), and this process keeps
/// the lock until it exits: a guard still in its pause then cannot replace the notice
/// (`replace_pending` fails) and starts nothing beside this launch.
fn clear_by_removing(path: &Path, lock: std::fs::File, pending: Pending) -> Option<Pending> {
    match std::fs::remove_file(path) {
        Ok(()) => Some(pending),
        Err(error) => {
            eprintln!("Could not remove the crash notice either, so it is not shown: {error}");
            keep_lock(path, lock);
            None
        }
    }
}

/// Holds `lock` until this process exits; this process's own later lock attempts on `path`
/// fail at once (`lock`) rather than wait `LOCK_WAIT` on it.
fn keep_lock(path: &Path, lock: std::fs::File) {
    KEPT_LOCKS.lock().unwrap_or_else(|p| p.into_inner()).push(path.to_owned());
    std::mem::forget(lock);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pandacode-crash-state-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_the_guards_own_relaunch_confirms_a_restart() {
        let claimed = Pending { crashed_at: 9, summary: None, has_report: true, restarts_paused: false, restarted: false, report: None, relaunching: true, agents_interrupted: false, not_restarted: None };
        let confirmed = claimed.clone().confirmed(Some(9));
        assert!(confirmed.restarted && !confirmed.relaunching);
        // A manual launch, or one marked for another crash, says it was not restarted.
        for mark in [None, Some(8)] {
            let told = claimed.clone().confirmed(mark);
            assert!(!told.restarted && !told.relaunching, "{mark:?}");
        }
        // Nothing claimed: no mark makes it a restart. A confirmed (put back) one stays.
        assert!(!Pending { relaunching: false, ..claimed.clone() }.confirmed(Some(9)).restarted);
        assert!(confirmed.confirmed(None).restarted);
        // An older file without the field reads as unclaimed.
        let old: GuardState = parse(Some(br#"{"pending": {"crashedAt": 5, "restarted": true}}"#));
        assert!(!old.pending.as_ref().unwrap().relaunching && old.pending.unwrap().confirmed(None).restarted);
    }

    #[test]
    fn corrupt_and_partial_files_read_as_defaults() {
        assert_eq!(parse::<GuardState>(None), GuardState::default());
        assert_eq!(parse::<GuardState>(Some(b"{\"crashes\": [")), GuardState::default());
        assert_eq!(parse::<GuardState>(Some(b"[]")), GuardState::default());
        assert_eq!(parse::<Settings>(Some(b"not json")), Settings { enabled: true });
        assert_eq!(parse::<Settings>(Some(b"{}")), Settings { enabled: true });
        assert_eq!(parse::<Settings>(Some(br#"{"enabled": false, "extra": 1}"#)), Settings { enabled: false });
        let state: GuardState = parse(Some(br#"{"pending": {"crashedAt": 5}}"#));
        assert_eq!(state.pending, Some(Pending { crashed_at: 5, summary: None, has_report: false, restarts_paused: false, restarted: false, report: None, relaunching: false, agents_interrupted: false, not_restarted: None }));
    }

    #[test]
    fn pending_is_taken_once_and_history_stays() {
        let dir = temp_dir();
        let state = GuardState {
            crashes: vec![CrashRecord { at: 9, startup: true }],
            pending: Some(Pending { crashed_at: 9, summary: Some("Panic: boom".into()), has_report: true, restarts_paused: true, restarted: false, report: None, relaunching: false, agents_interrupted: false, not_restarted: None }),
        };
        save(&dir.join(STATE_FILE), &state).unwrap();
        assert_eq!(take_pending(&dir, Mode::Serve, 9), None, "serve never takes the desktop notice");
        assert_eq!(take_pending(&dir, Mode::Desktop, 9), state.pending);
        assert_eq!(take_pending(&dir, Mode::Desktop, 9), None);
        assert_eq!(load::<GuardState>(&dir.join(STATE_FILE)).crashes, state.crashes);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn taking_the_notice_drops_crash_times_the_loop_limit_no_longer_reads() {
        use super::super::policy::CRASH_WINDOW_MS;
        let dir = temp_dir();
        let path = state_path(&dir, Mode::Serve);
        let now = 100 * CRASH_WINDOW_MS;
        let at = |at| CrashRecord { at, startup: false };
        let notice = Pending { crashed_at: now - 1, summary: None, has_report: true, restarts_paused: false, restarted: true, report: Some("1-crash.txt".into()), relaunching: false, agents_interrupted: false, not_restarted: None };
        let history = vec![at(1), at(now - CRASH_WINDOW_MS - 1), at(now - CRASH_WINDOW_MS), at(now - 1), at(now + 1)];
        save(&path, &GuardState { crashes: history, pending: Some(notice.clone()) }).unwrap();
        assert_eq!(take_pending(&dir, Mode::Serve, now), Some(notice));
        assert_eq!(load::<GuardState>(&path), GuardState { crashes: vec![at(now - CRASH_WINDOW_MS), at(now - 1)], pending: None });
        // Later launches with nothing pending still let old times go.
        assert_eq!(take_pending(&dir, Mode::Serve, now + 2 * CRASH_WINDOW_MS), None);
        assert_eq!(load::<GuardState>(&path), GuardState::default());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_notice_without_a_report_name_still_parses() {
        let state: GuardState = parse(Some(br#"{"pending": {"crashedAt": 5, "hasReport": true}}"#));
        assert_eq!(state.pending.and_then(|p| p.report), None);
        let named: GuardState = parse(Some(br#"{"pending": {"crashedAt": 5, "report": "5-crash.txt"}}"#));
        assert_eq!(named.pending.and_then(|p| p.report).as_deref(), Some("5-crash.txt"));
    }

    #[test]
    fn oversized_files_are_ignored_and_saves_leave_no_temp_file() {
        let dir = temp_dir();
        let path = dir.join(SETTINGS_FILE);
        std::fs::write(&path, vec![b' '; MAX_FILE_BYTES as usize + 1]).unwrap();
        assert_eq!(load::<Settings>(&path), Settings::default());
        save(&path, &Settings { enabled: false }).unwrap();
        assert_eq!(load::<Settings>(&path), Settings { enabled: false });
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_notice_is_replaced_only_while_it_is_still_the_expected_one() {
        let dir = temp_dir();
        let path = state_path(&dir, Mode::Desktop);
        let waiting = Pending { crashed_at: 1, summary: None, has_report: false, restarts_paused: false, restarted: false, report: None, relaunching: false, agents_interrupted: false, not_restarted: None };
        let restarted = Pending { restarted: true, ..waiting.clone() };
        // Nothing pending (a launch took it): nothing is written.
        assert!(!replace_pending(&path, &waiting, restarted.clone()).unwrap());
        assert!(!path.exists());
        let history = vec![CrashRecord { at: 1, startup: false }];
        save(&path, &GuardState { crashes: history.clone(), pending: Some(waiting.clone()) }).unwrap();
        assert!(replace_pending(&path, &waiting, restarted.clone()).unwrap());
        assert_eq!(load::<GuardState>(&path), GuardState { crashes: history, pending: Some(restarted) });
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn updates_keep_what_another_writer_saved_before_them() {
        let dir = temp_dir();
        let path = state_path(&dir, Mode::Serve);
        assert_eq!(path, dir.join(SERVE_STATE_FILE));
        save(&path, &GuardState { crashes: vec![CrashRecord { at: 5, startup: false }], pending: None }).unwrap();
        let saved = update(&path, |mut state| {
            state.crashes.push(CrashRecord { at: 6, startup: true });
            state
        })
        .unwrap();
        assert_eq!(saved.crashes.len(), 2);
        assert_eq!(load::<GuardState>(&path), saved);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn two_writers_racing_never_lose_a_record() {
        let dir = temp_dir();
        let path = state_path(&dir, Mode::Desktop);
        let writer = |offset: u64| {
            let path = path.clone();
            std::thread::spawn(move || {
                for at in 0..40 {
                    update(&path, |mut state| {
                        state.crashes.push(CrashRecord { at: offset + at, startup: false });
                        state
                    })
                    .unwrap();
                }
            })
        };
        let (a, b) = (writer(0), writer(1000));
        a.join().unwrap();
        b.join().unwrap();
        assert_eq!(load::<GuardState>(&path).crashes.len(), 80);
        // The lock file is empty and owner-only; nothing else is left beside the state.
        let lock = dir.join(format!("{STATE_FILE}.lock"));
        assert_eq!(std::fs::metadata(&lock).unwrap().len(), 0);
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&lock).unwrap().permissions()) & 0o777, 0o600);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pruning_drops_old_crash_times_and_old_notices_from_both_state_files() {
        use super::super::policy::CRASH_WINDOW_MS;
        let dir = temp_dir();
        let now = 10 * MAX_PENDING_AGE_MS;
        let at = |at| CrashRecord { at, startup: false };
        let notice = |crashed_at| Pending { crashed_at, ..waiting() };
        let desktop = state_path(&dir, Mode::Desktop);
        let serve = state_path(&dir, Mode::Serve);
        save(&desktop, &GuardState { crashes: vec![at(1), at(now - CRASH_WINDOW_MS - 1), at(now - 5), at(now + 5)], pending: Some(notice(now - MAX_PENDING_AGE_MS - 1)) }).unwrap();
        save(&serve, &GuardState { crashes: vec![at(now - 1)], pending: Some(notice(now - MAX_PENDING_AGE_MS)) }).unwrap();
        prune_old(&dir, now);
        assert_eq!(load::<GuardState>(&desktop), GuardState { crashes: vec![at(now - 5)], pending: None });
        assert_eq!(load::<GuardState>(&serve), GuardState { crashes: vec![at(now - 1)], pending: Some(notice(now - MAX_PENDING_AGE_MS)) }, "within the limits");
        // No state file: none is made, nor a lock file.
        let empty = temp_dir();
        prune_old(&empty, now);
        assert_eq!(std::fs::read_dir(&empty).unwrap().count(), 0);
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(empty).unwrap();
    }

    #[test]
    fn pruning_drops_a_notice_dated_far_in_the_future() {
        use super::super::report::FUTURE_SLACK_MS;
        let dir = temp_dir();
        let now = 10 * MAX_PENDING_AGE_MS;
        let path = state_path(&dir, Mode::Desktop);
        let notice = |crashed_at| Pending { crashed_at, ..waiting() };
        save(&path, &GuardState { crashes: Vec::new(), pending: Some(notice(now + FUTURE_SLACK_MS)) }).unwrap();
        prune_old(&dir, now);
        assert_eq!(load::<GuardState>(&path).pending, Some(notice(now + FUTURE_SLACK_MS)), "within the slack");
        save(&path, &GuardState { crashes: Vec::new(), pending: Some(notice(now + FUTURE_SLACK_MS + 1)) }).unwrap();
        prune_old(&dir, now);
        assert_eq!(load::<GuardState>(&path).pending, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unshown_notice_is_put_back_unless_a_newer_one_is_waiting() {
        let dir = temp_dir();
        let path = state_path(&dir, Mode::Desktop);
        let history = vec![CrashRecord { at: 5, startup: false }];
        let taken = Pending { crashed_at: 5, restarted: true, ..waiting() };
        save(&path, &GuardState { crashes: history.clone(), pending: None }).unwrap();
        put_back_pending(&path, taken.clone()).unwrap();
        assert_eq!(load::<GuardState>(&path), GuardState { crashes: history.clone(), pending: Some(taken.clone()) });
        assert_eq!(take_pending(&dir, Mode::Desktop, 5), Some(taken.clone()), "the next launch shows it");
        // A later crash's notice is already waiting: it stays.
        let newer = Pending { crashed_at: 9, ..waiting() };
        save(&path, &GuardState { crashes: history.clone(), pending: Some(newer.clone()) }).unwrap();
        put_back_pending(&path, taken.clone()).unwrap();
        assert_eq!(load::<GuardState>(&path).pending, Some(newer));
        // An older one is replaced.
        save(&path, &GuardState { crashes: history, pending: Some(Pending { crashed_at: 2, ..waiting() }) }).unwrap();
        put_back_pending(&path, taken.clone()).unwrap();
        assert_eq!(load::<GuardState>(&path).pending, Some(taken.clone()));
        // Either way the notice left says agents were stopped when either did.
        let stopped = Pending { agents_interrupted: true, ..taken.clone() };
        save(&path, &GuardState { crashes: Vec::new(), pending: Some(Pending { crashed_at: 9, ..waiting() }) }).unwrap();
        put_back_pending(&path, stopped).unwrap();
        assert_eq!(load::<GuardState>(&path).pending, Some(Pending { crashed_at: 9, agents_interrupted: true, ..waiting() }));
        save(&path, &GuardState { crashes: Vec::new(), pending: Some(Pending { crashed_at: 2, agents_interrupted: true, ..waiting() }) }).unwrap();
        put_back_pending(&path, taken.clone()).unwrap();
        assert_eq!(load::<GuardState>(&path).pending, Some(Pending { agents_interrupted: true, ..taken }));
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn waiting() -> Pending {
        Pending { crashed_at: 1, summary: None, has_report: false, restarts_paused: false, restarted: false, report: None, relaunching: false, agents_interrupted: false, not_restarted: None }
    }

    #[test]
    fn a_clear_that_cannot_be_saved_removes_the_file_instead() {
        let dir = temp_dir();
        let path = state_path(&dir, Mode::Desktop);
        save(&path, &GuardState { crashes: vec![CrashRecord { at: 1, startup: false }], pending: Some(waiting()) }).unwrap();
        // A directory at the temp path makes the atomic save fail, as a full disk would.
        std::fs::create_dir(dir.join(format!("{STATE_FILE}.{}.tmp", std::process::id()))).unwrap();
        assert_eq!(take_pending(&dir, Mode::Desktop, 1), Some(waiting()));
        assert!(!path.exists());
        // The guard in its pause finds it taken.
        assert!(!replace_pending(&path, &waiting(), Pending { restarted: true, ..waiting() }).unwrap());
        assert_eq!(take_pending(&dir, Mode::Desktop, 1), None, "shown once");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_notice_that_cannot_be_cleared_is_not_shown_and_the_guard_starts_nothing() {
        use std::os::unix::fs::PermissionsExt;
        // SAFETY: geteuid(2) has no preconditions. Root ignores the folder's permissions.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = temp_dir();
        let path = state_path(&dir, Mode::Desktop);
        save(&path, &GuardState { crashes: Vec::new(), pending: Some(waiting()) }).unwrap();
        drop(super::super::files::lock_exclusive(&path, LOCK_WAIT).unwrap());
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        assert_eq!(take_pending(&dir, Mode::Desktop, 1), None, "a notice that stays would show at every launch");
        // This run keeps the lock: the guard (another open of the lock file) cannot prove the
        // notice is still its own.
        assert!(super::super::files::lock_exclusive(&path, std::time::Duration::from_millis(50)).is_err());
        // This process's own later attempts (quit put-back, `shown`, the daily prune) skip at
        // once instead of waiting LOCK_WAIT on the lock it keeps.
        let started = std::time::Instant::now();
        assert!(replace_pending(&path, &waiting(), Pending { restarted: true, ..waiting() }).is_err());
        assert!(put_back_pending(&path, waiting()).is_err() && remove_pending(&path, 1).is_err());
        prune_old(&dir, 1);
        assert!(started.elapsed() < LOCK_WAIT / 2, "no wait on our own lock: {:?}", started.elapsed());
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(load::<GuardState>(&path).pending, Some(waiting()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_state_file_is_ignored() {
        let dir = temp_dir();
        let real = dir.join("elsewhere.json");
        save(&real, &Settings { enabled: false }).unwrap();
        std::os::unix::fs::symlink(&real, dir.join(SETTINGS_FILE)).unwrap();
        assert_eq!(load::<Settings>(&real), Settings { enabled: false });
        assert_eq!(load::<Settings>(&dir.join(SETTINGS_FILE)), Settings::default());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
