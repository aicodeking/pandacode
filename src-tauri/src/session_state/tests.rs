use super::*;

/// How many of the next `write` calls to each path fail (any thread, so background writes too).
static FAIL_WRITES: Mutex<BTreeMap<PathBuf, u32>> = Mutex::new(BTreeMap::new());

fn fail_writes(path: &Path, count: u32) {
    FAIL_WRITES.lock().unwrap().insert(path.to_owned(), count);
}

fn failures_left(path: &Path) -> u32 {
    FAIL_WRITES.lock().unwrap().get(path).copied().unwrap_or(0)
}

/// Consumes one injected failure for `path`, if any.
pub(super) fn take_failure(path: &Path) -> bool {
    match FAIL_WRITES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get_mut(path) {
        Some(left) if *left > 0 => {
            *left -= 1;
            true
        }
        _ => false,
    }
}

#[cfg(unix)]
static FAIL_PARENT_SYNC: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

#[cfg(unix)]
pub(super) fn take_parent_sync_failure(path: &Path) -> bool {
    FAIL_PARENT_SYNC.lock().unwrap().remove(path)
}

pub(crate) struct Temp(pub PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A fresh directory (removed on drop) and the state file's path in it.
pub(crate) fn temp() -> (Temp, PathBuf) {
    let dir = std::env::temp_dir().join(format!("pandacode-session-state-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(FILE);
    (Temp(dir), path)
}

fn sample(task: &mut TaskState) {
    task.instructed = Some(Role::ReadOnlyWorker);
    task.owed = true;
    task.compaction = Some(CompactionScan { scanned: 9, newest: 4, answered: 4 });
    task.listed = Some(Listed { on: Some("conv-1".into()), names: ["a".to_owned(), "b".to_owned()].into() });
    task.note = Some(Note { hash: 7, count: 3 });
}

fn listing(names: &[&str]) -> Option<Listed> {
    Some(Listed { on: Some("conv-1".into()), names: names.iter().map(|name| (*name).to_owned()).collect() })
}

#[test]
fn state_round_trips_through_the_file() {
    let (_dir, path) = temp();
    let mut first = SessionState::open(path.clone());
    first.update("task", sample);
    first.flush().unwrap();
    let saved = first.get("task", |task| task.cloned());
    let mut restarted = SessionState::open(path);
    assert_eq!(restarted.get("task", |task| task.cloned()), saved);
    assert!(restarted.get("other", |task| task.is_none()));
}

#[cfg(unix)]
#[test]
fn rename_sync_failure_is_reported_and_leaves_the_renamed_file() {
    let (_dir, path) = temp();
    write(&path, b"old state").unwrap();
    FAIL_PARENT_SYNC.lock().unwrap().insert(path.clone());
    assert_eq!(write(&path, b"new state").unwrap_err().to_string(), "injected parent directory sync failure");
    assert_eq!(std::fs::read(&path).unwrap(), b"new state");
    assert!(!temp_path(&path).exists());
}

#[test]
fn updates_wait_for_a_flush_but_a_listing_is_written_at_once() {
    let (_dir, path) = temp();
    let state = Shared::open(path.clone());
    state.lock().update("task", |task| task.owed = true);
    assert!(!path.exists(), "a counter or mark is not written on the hot path");
    state.update_now("task", |task| task.listed = listing(&["a"]));
    let mut restarted = SessionState::open(path.clone());
    assert!(restarted.get("task", |task| task.is_some_and(|task| task.owed && task.listed == listing(&["a"]))));
    state.lock().update("task", |task| task.owed = false);
    state.lock().flush().unwrap();
    assert!(SessionState::open(path).get("task", |task| task.is_some_and(|task| !task.owed)));
}

/// Waits up to thirty seconds for `done` (generous, so a loaded machine never flakes).
fn eventually(done: impl Fn() -> bool) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        if done() {
            return true;
        }
        if std::time::Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn a_lazy_update_is_written_in_the_background_and_a_failed_write_is_retried() {
    let (_dir, path) = temp();
    let state = Shared::open(path.clone());
    state.update("task", |task| task.instructed = Some(Role::ReadOnlyWorker));
    assert!(eventually(|| SessionState::open(path.clone()).get("task", |task| task.is_some_and(|task| task.instructed == Some(Role::ReadOnlyWorker)))));
    // The first background write fails...
    fail_writes(&path, 1);
    state.update("task", |task| task.instructed = Some(Role::Worker));
    // ...and the retry writes it with no further change.
    assert!(eventually(|| SessionState::open(path.clone()).get("task", |task| task.is_some_and(|task| task.instructed == Some(Role::Worker)))));
    assert_eq!(failures_left(&path), 0, "the first attempt failed");
}

#[test]
fn flush_writes_a_pending_lazy_update() {
    let (_dir, path) = temp();
    let state = Mutex::new(SessionState::open(path.clone()));
    state.lock().unwrap().update("task", |task| task.owed = true);
    assert!(!path.exists());
    flush_in(&mut state.lock().unwrap());
    assert!(SessionState::open(path).get("task", |task| task.is_some_and(|task| task.owed)));
}

#[test]
fn flush_finishes_a_background_write_caught_between_its_snapshot_and_its_rename() {
    let (_dir, path) = temp();
    let state = Shared::open(path.clone());
    state.lock().update("task", |task| task.owed = true);
    // A background write took its snapshot (clearing `dirty`) and the process exits before it writes.
    let in_flight = state.lock().snapshot().unwrap();
    assert!(!state.lock().dirty);
    state.lock().flush().unwrap();
    assert!(SessionState::open(path.clone()).get("task", |task| task.is_some_and(|task| task.owed)));
    in_flight.write().unwrap();
    // The same gap when the background write failed and has not yet marked it.
    state.lock().update("task", |task| task.owed = false);
    state.lock().update("task", |task| task.instructed = Some(Role::ReadOnlyWorker));
    let failing = state.lock().snapshot().unwrap();
    fail_writes(&path, 1);
    assert!(failing.write().is_err());
    state.lock().flush().unwrap();
    assert!(SessionState::open(path.clone()).get("task", |task| task.is_some_and(|task| !task.owed && task.instructed == Some(Role::ReadOnlyWorker))));
    // A flush waits for a write in progress (here: the write lock held by another thread).
    state.lock().update("task", |task| task.owed = true);
    let held = state.lock().written.clone();
    let guard = held.lock().unwrap();
    let flushing = std::thread::spawn(move || state.lock().flush().unwrap());
    std::thread::sleep(Duration::from_millis(50));
    assert!(!flushing.is_finished(), "flush waits for the write lock");
    drop(guard);
    flushing.join().unwrap();
    assert!(SessionState::open(path).get("task", |task| task.is_some_and(|task| task.owed)));
}

#[test]
fn a_listing_whose_first_write_fails_is_rewritten_without_it_keeping_the_other_fields() {
    let (_dir, path) = temp();
    let state = Shared::open(path.clone());
    state.update_now("task", |task| task.listed = listing(&["a"]));
    state.lock().update("task", |task| task.owed = true);
    fail_writes(&path, 1);
    state.update_now("task", |task| task.listed = listing(&["a", "b"]));
    assert_eq!(failures_left(&path), 0);
    assert!(state.lock().get("task", |task| task.is_some_and(|task| task.owed && task.listed.is_none())));
    let mut restarted = SessionState::open(path);
    assert!(restarted.get("task", |task| task.is_some_and(|task| task.owed && task.listed.is_none())), "the retry rewrote the file");
}

#[test]
fn clear_and_retain_schedule_a_write() {
    let (_dir, path) = temp();
    let state = Shared::open(path.clone());
    state.update("task", sample);
    state.update("gone", |task| task.owed = true);
    assert!(eventually(|| SessionState::open(path.clone()).get("gone", |task| task.is_some())));
    state.clear(&["task".to_owned()], |task| task.listed = None);
    assert!(eventually(|| SessionState::open(path.clone()).get("task", |task| task.is_some_and(|task| task.listed.is_none()))));
    state.retain(|id| id != "gone");
    assert!(eventually(|| SessionState::open(path.clone()).get("gone", |task| task.is_none())));
}

#[test]
fn an_older_snapshot_never_overwrites_a_newer_one() {
    let (_dir, path) = temp();
    let state = Shared::open(path.clone());
    state.lock().update("task", |task| task.owed = true);
    let older = state.lock().snapshot().unwrap();
    state.update_now("task", |task| task.listed = listing(&["a", "b"]));
    older.write().unwrap();
    assert!(SessionState::open(path).get("task", |task| task.is_some_and(|task| task.listed == listing(&["a", "b"]))));
}

#[test]
fn a_listing_that_cannot_be_saved_is_unknown_after_a_restart() {
    let (_dir, path) = temp();
    // A background write never comes in this test's lifetime, so the gaps below stay open.
    let state: &'static Shared = Box::leak(Box::new(Shared::new(SessionState::open(path.clone()), Duration::from_secs(3600))));
    let (result, saved) = state.update_now_durable("task", |task| {
        task.listed = listing(&["a"]);
        42
    });
    assert_eq!(result, 42);
    assert_eq!(saved, Ok(()));
    assert!(SessionState::open(path.clone()).get("task", |task| task.is_some_and(|task| task.listed == listing(&["a"]))));
    state.update_now("task", |task| task.note = Some(Note { hash: 1, count: 1 }));
    state.update_now("kept", |task| task.owed = true);
    // A background write took its snapshot (holding the narrower listing) but has not written it.
    state.lock().update("kept", |task| task.instructed = Some(Role::ReadOnlyWorker));
    let older = state.lock().snapshot().unwrap();
    // Both the write and its retry fail, so the file is removed.
    fail_writes(&path, 2);
    let ((), saved) = state.update_now_durable("task", |task| task.listed = listing(&["a", "b"]));
    assert_eq!(saved, Ok(()), "removing the stale file is sufficient for launch");
    assert_eq!(failures_left(&path), 0);
    let forgotten = state.lock().get("task", |task| task.is_some_and(|task| task.listed.is_none() && task.note.is_some()));
    assert!(forgotten, "this process forgets the listing too, keeping the rest");
    assert!(!path.exists(), "the last resort removes the file");
    older.write().unwrap();
    assert!(!path.exists(), "the older snapshot does not bring the narrower listing back");
    state.lock().flush().unwrap();
    let mut restarted = SessionState::open(path);
    assert!(restarted.get("task", |task| task.is_some_and(|task| task.listed.is_none() && task.note.is_some())), "listing unknown");
    assert!(restarted.get("kept", |task| task.is_some()), "the next write restores the rest");
}

#[test]
fn a_removed_file_is_rewritten_in_the_background_without_the_listing() {
    let (_dir, path) = temp();
    let state = Shared::open(path.clone());
    state.update_now("task", |task| task.listed = listing(&["a"]));
    state.update_now("task", |task| task.owed = true);
    fail_writes(&path, 2);
    state.update_now("task", |task| task.listed = listing(&["a", "b"]));
    assert_eq!(failures_left(&path), 0, "the write and its retry failed");
    // No further change: the scheduled write alone brings the file back.
    let rewritten = || SessionState::open(path.clone()).get("task", |task| task.is_some_and(|task| task.owed && task.listed.is_none()));
    assert!(eventually(rewritten));
}

#[cfg(unix)]
#[test]
fn unlink_sync_failure_is_reported_and_the_older_snapshot_stays_blocked() {
    let (_dir, path) = temp();
    let state = Shared::open(path.clone());
    state.update_now("task", |task| task.listed = listing(&["a"]));
    state.lock().update("task", |task| task.owed = true);
    let older = state.lock().snapshot().unwrap();
    state.pending.store(true, Ordering::Release);
    fail_writes(&path, 2);
    FAIL_PARENT_SYNC.lock().unwrap().insert(path.clone());

    let ((), saved) = state.update_now_durable("task", |task| task.listed = listing(&["a", "b"]));
    assert_eq!(
        saved.unwrap_err(),
        "injected failure; could not sync session state directory after unlink: injected parent directory sync failure"
    );
    assert!(!path.exists());
    assert!(older.write().is_err());
    state.lock().flush().unwrap();
    assert!(SessionState::open(path).get("task", |task| task.is_some_and(|task| task.owed && task.listed.is_none())));
}

#[test]
fn failed_invalidation_reports_all_errors_and_flush_recovers() {
    let (_dir, path) = temp();
    // A directory cannot be replaced with a file, removed by remove_file, or truncated.
    std::fs::create_dir(&path).unwrap();
    let mut state = SessionState::open(path.clone());
    state.update("task", |task| task.owed = true);
    let older = state.snapshot().unwrap();

    let state = Shared::leak(state);
    // Keep the scheduled retry from racing the dirty check and the explicit flush.
    state.pending.store(true, Ordering::Release);
    fail_writes(&path, 2);
    let ((), saved) = state.update_now_durable("task", |task| task.listed = listing(&["a", "b"]));
    let error = saved.unwrap_err();
    assert!(error.starts_with("injected failure; could not invalidate stale session state (remove: "), "{error}");
    assert!(error.contains("; truncate: "), "{error}");
    assert!(older.write().is_err(), "a superseded write cannot report durability after failed invalidation");
    let mut current = state.lock();
    assert!(current.dirty);
    assert!(current.get("task", |task| task.is_some_and(|task| task.owed && task.listed.is_none())));
    std::fs::remove_dir(&path).unwrap();
    current.flush().unwrap();
    assert!(!current.dirty);
    assert!(SessionState::open(path).get("task", |task| task.is_some_and(|task| task.owed && task.listed.is_none())));
}

#[test]
fn startup_wiring_inits_prunes_and_flushes() {
    let (dir, path) = temp();
    let mut stored = SessionState::open(path.clone());
    stored.update("live", |task| task.owed = true);
    stored.update("gone", |task| task.owed = true);
    stored.flush().unwrap();
    // As `init`, `retain` and `flush` do on `STATE`, on a non-global state.
    let state = Shared::leak(SessionState::default());
    state.lock().init(&dir.0);
    state.retain(|id| id == "live");
    state.update("new", |task| task.owed = true);
    flush_in(&mut state.lock());
    let mut restarted = SessionState::open(path);
    assert!(restarted.get("live", |task| task.is_some()) && restarted.get("new", |task| task.is_some()));
    assert!(restarted.get("gone", |task| task.is_none()), "pruned at startup");
}

#[test]
fn init_reads_the_directorys_file_once_and_merges_under_earlier_updates() {
    let (dir, path) = temp();
    let mut stored = SessionState::open(path.clone());
    stored.update("early", |task| task.instructed = Some(Role::Worker));
    stored.update("stored", |task| task.owed = true);
    stored.flush().unwrap();
    let mut state = SessionState::default();
    state.update("early", |task| task.instructed = Some(Role::ReadOnlyWorker));
    state.init(&dir.0);
    assert_eq!(state.get("early", |task| task.and_then(|task| task.instructed)), Some(Role::ReadOnlyWorker), "recorded before the file was read");
    assert!(state.get("stored", |task| task.is_some_and(|task| task.owed)), "the file is read after init");
    let (other, _) = temp();
    state.init(&other.0);
    assert_eq!(state.path.as_deref(), Some(path.as_path()), "a second init keeps the first path");
    state.update("late", |task| task.owed = true);
    let clocks = state.tasks["late"].touched > state.tasks["stored"].touched;
    assert!(clocks, "the clock continues past the stored one");
    state.flush().unwrap();
    let mut restarted = SessionState::open(path);
    assert_eq!(restarted.get("early", |task| task.and_then(|task| task.instructed)), Some(Role::ReadOnlyWorker));
    assert!(restarted.get("late", |task| task.is_some()));
}

#[test]
fn a_corrupt_missing_or_foreign_file_is_empty_and_is_replaced() {
    let (_dir, path) = temp();
    assert!(SessionState::open(path.clone()).get("task", |task| task.is_none()), "missing");
    std::fs::write(&path, "{not json").unwrap();
    let mut state = SessionState::open(path.clone());
    assert!(state.get("task", |task| task.is_none()), "corrupt");
    state.update("task", |task| task.instructed = Some(Role::Worker));
    state.flush().unwrap();
    assert_eq!(SessionState::open(path.clone()).get("task", |task| task.and_then(|task| task.instructed)), Some(Role::Worker));
    std::fs::write(&path, r#"{"version":99,"tasks":{"task":{"owed":true}}}"#).unwrap();
    assert!(SessionState::open(path).get("task", |task| task.is_none()), "another version");
}

#[test]
fn clearing_every_field_removes_the_entry_from_the_file() {
    let (_dir, path) = temp();
    let mut state = SessionState::open(path.clone());
    state.update("task", sample);
    state.update("kept", |task| task.instructed = Some(Role::ReadOnlyWorker));
    state.clear(&["task".to_owned()], |task| task.listed = None);
    state.flush().unwrap();
    assert!(SessionState::open(path.clone()).get("task", |task| task.is_some_and(|task| task.listed.is_none() && task.note.is_some())));
    state.clear(&["task".to_owned()], |task| *task = TaskState::default());
    state.flush().unwrap();
    let mut restarted = SessionState::open(path.clone());
    assert!(restarted.get("task", |task| task.is_none()));
    assert!(restarted.get("kept", |task| task.is_some()));
    assert!(!std::fs::read_to_string(path).unwrap().contains("\"task\""));
}

#[test]
fn an_unchanged_update_does_not_write() {
    let (_dir, path) = temp();
    let state = Shared::open(path.clone());
    state.update_now("task", |_| ());
    assert!(!path.exists(), "an empty entry is never saved");
    state.update_now("task", |task| task.owed = true);
    assert!(path.exists());
    std::fs::remove_file(&path).unwrap();
    state.update_now("task", |task| task.owed = true);
    state.lock().flush().unwrap();
    assert!(!path.exists(), "nothing changed");
}

#[test]
fn the_least_recently_touched_tasks_are_evicted() {
    let (_dir, path) = temp();
    let mut state = SessionState::open(path.clone());
    for index in 0..=MAX_TASKS {
        state.update(&format!("task-{index}"), |task| task.owed = true);
    }
    state.flush().unwrap();
    let mut restarted = SessionState::open(path);
    assert!(restarted.get("task-0", |task| task.is_none()));
    assert!(restarted.get(&format!("task-{MAX_TASKS}"), |task| task.is_some()));
    assert_eq!(restarted.tasks.len(), MAX_TASKS);
    restarted.update("task-1", |task| task.instructed = Some(Role::ReadOnlyWorker));
    restarted.update("new", |task| task.owed = true);
    assert!(restarted.get("task-1", |task| task.is_some()), "a restarted clock continues past the stored one");
    assert!(restarted.get("task-2", |task| task.is_none()));
}

#[test]
fn a_task_read_recently_is_not_evicted_and_its_use_is_saved_with_the_next_write() {
    let (_dir, path) = temp();
    let mut state = SessionState::open(path.clone());
    for index in 0..MAX_TASKS {
        state.update(&format!("task-{index}"), |task| task.owed = true);
    }
    state.flush().unwrap();
    assert!(state.get("task-0", |task| task.is_some()));
    assert!(!state.dirty, "a read alone writes nothing");
    state.update("new", |task| task.owed = true);
    assert!(state.get("task-0", |task| task.is_some()) && state.get("task-1", |task| task.is_none()));
    state.flush().unwrap();
    let mut restarted = SessionState::open(path);
    restarted.update("newer", |task| task.owed = true);
    assert!(restarted.get("task-0", |task| task.is_some()), "the read was saved");
    assert!(restarted.get("task-2", |task| task.is_none()));
}

#[test]
fn an_oversized_file_is_not_read() {
    let (_dir, path) = temp();
    let text = r#"{"version":1,"tasks":{"task":{"owed":true,"touched":1}}}"#;
    std::fs::write(&path, text).unwrap();
    assert!(SessionState::open(path.clone()).get("task", |task| task.is_some()));
    std::fs::write(&path, format!("{text}{}", " ".repeat(MAX_BYTES as usize))).unwrap();
    assert!(SessionState::open(path).get("task", |task| task.is_none()));
}

#[test]
fn retain_prunes_deleted_tasks() {
    let (_dir, path) = temp();
    let mut state = SessionState::open(path.clone());
    state.update("live", |task| task.owed = true);
    state.update("gone", |task| task.owed = true);
    state.retain(|id| id == "live");
    state.flush().unwrap();
    let mut restarted = SessionState::open(path);
    assert!(restarted.get("gone", |task| task.is_none()) && restarted.get("live", |task| task.is_some()));
}

#[test]
fn without_a_path_nothing_is_written() {
    let state = Shared::leak(SessionState::default());
    state.update("task", sample);
    state.update_now("task", |task| task.owed = false);
    assert!(state.lock().flush().is_ok());
    assert!(state.lock().get("task", |task| task.is_some_and(|task| !task.owed)));
}

#[test]
fn a_file_holding_the_retired_tools_said_field_still_loads() {
    let (_dir, path) = temp();
    std::fs::write(&path, r#"{"version":1,"tasks":{"task":{"tools_said":true,"owed":true,"touched":1}}}"#).unwrap();
    assert!(SessionState::open(path).get("task", |task| task.is_some_and(|task| task.owed)));
}
