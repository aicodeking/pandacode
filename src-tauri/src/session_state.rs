//! Per-task conversation state that has to outlive the process: the role its instructions last
//! went out for, how far its compactions were read, the tool names it may hold and its Project
//! tools note counter.
//!
//! Without it, the first turn after a restart treated every resumed conversation as unknown:
//! it widened the tool listing (a cache rewrite) and resent the tools note. The state is one
//! small JSON file in app data (`FILE`), loaded lazily on first use. Files written by older
//! builds may still hold retired fields; unknown fields are ignored on load.
//!
//! Counters and marks are written in the background a moment after they change (`WRITE_DELAY`:
//! one write for a turn's several updates; a failed one is retried once) and on exit (`flush`,
//! which also waits for and finishes a background write in progress). A tool listing is written
//! at once (`update_now`; the launch runs it on a blocking thread beside the harness's start and
//! joins it before the turn ends). One that cannot be written is forgotten (the listing only),
//! and the file is rewritten or invalidated to keep a restart from trusting an older, narrower
//! listing. A failed invalidation is logged and leaves the state dirty for another write. Only `flush`
//! writes under the state lock; the others write outside it. Writes are atomic (synced temp
//! file, then rename). A missing, oversized or corrupt file is an empty one, which behaves
//! exactly as a fresh process did: unknown history keeps everything listed. Without `init`
//! (tests, the cloud bridge) nothing touches the disk.
//!
//! Entries are capped at `MAX_TASKS`, least recently used first out; an evicted task is
//! simply unknown again. Deleted tasks are cleared by their owners' `forget`, and tasks deleted
//! by paths that do not call it (bot resets) are pruned at startup (`retain`).
use crate::app_instructions::Role;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

/// The file's name in app data.
pub(crate) const FILE: &str = "session-state.json";
const VERSION: u32 = 1;
/// At most this many tasks are kept.
const MAX_TASKS: usize = 400;
/// A larger file is not read (treated as corrupt).
const MAX_BYTES: u64 = 8 * 1024 * 1024;
/// How long changes wait before a background write, so a turn's several updates cost one.
const WRITE_DELAY: Duration = Duration::from_secs(2);

/// How far a task's tool rows have been read for compactions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CompactionScan {
    /// The newest tool row read: later turns read only past it.
    pub scanned: i64,
    /// The newest compaction row found.
    pub newest: i64,
    /// The compaction row the instructions were last resent after.
    pub answered: i64,
}

/// The conversation a task's last listing went out on (`None` for a new conversation, until
/// the conversation's id is first seen) and every tool name listed on it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Listed {
    pub on: Option<String>,
    pub names: BTreeSet<String>,
}

/// The catalog hash a task's last accepted message saw and the messages counted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Note {
    pub hash: u64,
    pub count: u64,
}

/// One task's state; every field is owned by one module (named on it).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct TaskState {
    /// `app_instructions`: the role the instructions last went out for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructed: Option<Role>,
    /// `app_instructions`: a new conversation's full instructions were held back (its first
    /// message was a slash command) and are owed to its next message.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub owed: bool,
    /// `app_instructions`: compaction reading.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compaction: Option<CompactionScan>,
    /// `app_instructions::catalog`: what the conversation may hold.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listed: Option<Listed>,
    /// `custom_tools`: the Project tools note counter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<Note>,
    /// When the entry was last changed or read, on this file's own clock (for eviction).
    pub touched: u64,
}

impl TaskState {
    fn is_empty(&self) -> bool {
        *self == Self { touched: self.touched, ..Self::default() }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    version: u32,
    tasks: BTreeMap<String, TaskState>,
}

/// The state of every task, backed by `path` when it has one.
#[derive(Default)]
pub(crate) struct SessionState {
    path: Option<PathBuf>,
    loaded: bool,
    tasks: HashMap<String, TaskState>,
    clock: u64,
    /// Changes not yet written (`flush` or a `Snapshot` writes them).
    dirty: bool,
    /// Snapshots taken; a snapshot older than the last one written is skipped.
    taken: u64,
    /// The newest snapshot written, locked while writing so two writes never interleave.
    written: Arc<Mutex<u64>>,
}

/// A serialized state, written outside the state lock.
pub(crate) struct Snapshot {
    path: PathBuf,
    number: u64,
    bytes: Vec<u8>,
    written: Arc<Mutex<u64>>,
}

impl Snapshot {
    /// Writes the file unless a newer snapshot already was.
    fn write(&self) -> std::io::Result<()> {
        let mut written = self.written.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.number <= *written {
            return Ok(());
        }
        write(&self.path, &self.bytes)?;
        *written = self.number;
        Ok(())
    }

    /// `write`, invalidating the file by removing or truncating it if replacement fails.
    /// This snapshot counts as written even on failure, so an older one taken before it
    /// (holding a listing it dropped) can never recreate the file.
    fn write_or_remove(&self) -> std::io::Result<()> {
        let mut written = self.written.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.number <= *written {
            return Ok(());
        }
        *written = self.number;
        let Err(write_err) = write(&self.path, &self.bytes) else { return Ok(()) };
        let Err(remove_err) = std::fs::remove_file(&self.path) else { return Err(write_err) };
        if remove_err.kind() == std::io::ErrorKind::NotFound {
            return Err(write_err);
        }
        match std::fs::write(&self.path, b"") {
            Ok(()) => Err(write_err),
            Err(trunc_err) => Err(std::io::Error::other(format!(
                "{write_err}; could not invalidate stale session state (remove: {remove_err}; truncate: {trunc_err})"
            ))),
        }
    }
}

impl SessionState {
    /// State backed by `path`, read on first use (tests; the app's `STATE` gets its path from `init`).
    #[cfg(test)]
    pub(crate) fn open(path: PathBuf) -> Self {
        Self { path: Some(path), ..Self::default() }
    }

    /// Backs the state with `dir`'s file, read on next use and merged under anything already
    /// recorded. A second call keeps the first path.
    fn init(&mut self, dir: &Path) {
        if self.path.is_none() {
            self.path = Some(dir.join(FILE));
            self.loaded = false;
        }
    }

    fn load(&mut self) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        let Some(path) = &self.path else { return };
        let stored = read(path);
        self.clock = self.clock.max(stored.values().map(|task| task.touched).max().unwrap_or(0));
        for (id, task) in stored {
            // Anything recorded before the file was read is newer.
            self.tasks.entry(id).or_insert(task);
        }
    }

    pub(crate) fn get<R>(&mut self, id: &str, read: impl FnOnce(Option<&TaskState>) -> R) -> R {
        self.load();
        self.touch(id);
        read(self.tasks.get(id))
    }

    /// Changes one task's entry, leaving the file to a later write when anything changed.
    /// An entry left empty is removed.
    pub(crate) fn update<R>(&mut self, id: &str, change: impl FnOnce(&mut TaskState) -> R) -> R {
        self.change(id, change).0
    }

    /// `update`, also snapshotting the change when anything changed (a tool listing), for the
    /// caller to write outside the state lock (`Shared::update_now`).
    fn change_now<R>(&mut self, id: &str, change: impl FnOnce(&mut TaskState) -> R) -> (R, Option<Snapshot>) {
        let (result, changed) = self.change(id, change);
        (result, if changed { self.snapshot() } else { None })
    }

    /// Drops the listing of a task whose listing could not be written (its listing history is
    /// unknown again), keeps its other fields, and snapshots the state.
    fn forget_unsaved(&mut self, id: &str) -> Option<Snapshot> {
        if let Some(task) = self.tasks.get_mut(id) {
            task.listed = None;
            if task.is_empty() {
                self.tasks.remove(id);
            }
        }
        self.dirty = true;
        self.snapshot()
    }

    /// Marks a task as just used, in memory only: the next write carries it, so an active task
    /// is not evicted by others' changes and a read never costs a write.
    fn touch(&mut self, id: &str) {
        let clock = self.clock;
        if let Some(task) = self.tasks.get_mut(id).filter(|task| task.touched != clock) {
            self.clock += 1;
            task.touched = self.clock;
        }
    }

    fn change<R>(&mut self, id: &str, change: impl FnOnce(&mut TaskState) -> R) -> (R, bool) {
        self.load();
        let before = self.tasks.get(id).cloned();
        let mut task = before.clone().unwrap_or_default();
        let result = change(&mut task);
        let unchanged = match &before {
            Some(before) => *before == task,
            None => task.is_empty(),
        };
        if unchanged {
            self.touch(id);
            return (result, false);
        }
        if task.is_empty() {
            self.tasks.remove(id);
        } else {
            self.clock += 1;
            task.touched = self.clock;
            self.tasks.insert(id.to_owned(), task);
            self.evict();
        }
        self.dirty = true;
        (result, true)
    }

    /// Applies `clear` to each task's entry.
    pub(crate) fn clear(&mut self, ids: &[String], clear: impl Fn(&mut TaskState)) {
        self.load();
        for id in ids {
            let Some(task) = self.tasks.get_mut(id) else { continue };
            let before = task.clone();
            clear(task);
            if task.is_empty() {
                self.tasks.remove(id);
                self.dirty = true;
            } else {
                self.dirty |= *task != before;
            }
        }
    }

    /// Keeps only the tasks for which `live` holds.
    pub(crate) fn retain(&mut self, live: impl Fn(&str) -> bool) {
        self.load();
        let before = self.tasks.len();
        self.tasks.retain(|id, _| live(id));
        self.dirty |= self.tasks.len() != before;
    }

    fn evict(&mut self) {
        while self.tasks.len() > MAX_TASKS {
            let Some(oldest) = self.tasks.iter().min_by_key(|(_, task)| task.touched).map(|(id, _)| id.clone()) else { return };
            self.tasks.remove(&oldest);
        }
    }

    /// The unwritten changes (`None` when there are none or no file), counted as written; a
    /// failed write must call `failed`.
    // ponytail: every write serializes the whole file (up to `MAX_TASKS` entries) under the global
    // state lock, then fsyncs it; milliseconds today. Use per-entry or append-only storage if
    // turns start waiting on it.
    fn snapshot(&mut self) -> Option<Snapshot> {
        if !self.dirty {
            return None;
        }
        let path = self.path.clone()?;
        let stored = Stored { version: VERSION, tasks: self.tasks.iter().map(|(id, task)| (id.clone(), task.clone())).collect() };
        let bytes = match serde_json::to_vec(&stored) {
            Ok(bytes) => bytes,
            Err(error) => {
                eprintln!("PandaCode: could not encode session state: {error}");
                return None;
            }
        };
        self.dirty = false;
        self.taken += 1;
        Some(Snapshot { path, number: self.taken, bytes, written: self.written.clone() })
    }

    fn failed(&mut self) {
        self.dirty = true;
    }

    /// Writes unwritten changes now. It waits for any write in progress, and it also writes when
    /// a snapshot was taken but not written (a background write between its snapshot and its
    /// rename, or one that failed), so an exit in that gap loses nothing. Lock order is always
    /// state, then write: no writer takes the state lock while it holds the write lock.
    pub(crate) fn flush(&mut self) -> std::io::Result<()> {
        let written = self.written.clone();
        let mut written = written.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.taken > *written {
            self.dirty = true;
        }
        let Some(snapshot) = self.snapshot() else { return Ok(()) };
        write(&snapshot.path, &snapshot.bytes).inspect_err(|_| self.failed())?;
        *written = snapshot.number;
        Ok(())
    }
}

/// The stored tasks, or none when the file is missing, too large, corrupt or another version.
fn read(path: &Path) -> BTreeMap<String, TaskState> {
    let text = match std::fs::metadata(path) {
        Ok(metadata) if metadata.len() > MAX_BYTES => {
            eprintln!("PandaCode: ignoring oversized session state ({} bytes)", metadata.len());
            return BTreeMap::new();
        }
        Ok(_) => std::fs::read_to_string(path),
        Err(error) => Err(error),
    };
    let text = match text {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return BTreeMap::new(),
        Err(error) => {
            eprintln!("PandaCode: could not read session state: {error}");
            return BTreeMap::new();
        }
    };
    match serde_json::from_str::<Stored>(&text) {
        Ok(stored) if stored.version == VERSION => stored.tasks,
        Ok(stored) => {
            eprintln!("PandaCode: ignoring session state version {}", stored.version);
            BTreeMap::new()
        }
        Err(error) => {
            eprintln!("PandaCode: ignoring corrupt session state: {error}");
            BTreeMap::new()
        }
    }
}

/// The temporary file `write` renames over `path`.
fn temp_path(path: &Path) -> PathBuf {
    path.with_extension(format!("json.{}.tmp", std::process::id()))
}

/// Writes next to `path`, syncs, then renames over it, so a reader never sees half a file.
// ponytail: the directory is not synced, so a crash right after the rename can keep the previous
// file; a listing it could hold was narrower only if this write was the widening one.
fn write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    #[cfg(test)]
    if tests::take_failure(path) {
        return Err(std::io::Error::other("injected failure"));
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temp = temp_path(path);
    let written = std::fs::File::create(&temp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    written.and_then(|()| std::fs::rename(&temp, path)).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

/// The state with its background writer.
pub(crate) struct Shared {
    state: Mutex<SessionState>,
    /// A background write is already waiting.
    pending: AtomicBool,
    /// How long changes wait before a background write (`WRITE_DELAY`; shorter in tests).
    delay: Duration,
}

/// How many times a background write is tried before the changes wait for the next one.
const WRITE_ATTEMPTS: u32 = 2;

impl Shared {
    fn new(state: SessionState, delay: Duration) -> Self {
        Self { state: Mutex::new(state), pending: AtomicBool::new(false), delay }
    }

    /// State backed by `path` with a short write delay, kept for the test process.
    #[cfg(test)]
    pub(crate) fn open(path: PathBuf) -> &'static Self {
        Self::leak(SessionState::open(path))
    }

    #[cfg(test)]
    fn leak(state: SessionState) -> &'static Self {
        Box::leak(Box::new(Self::new(state, Duration::from_millis(10))))
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, SessionState> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Starts a background write of the changes after `delay`, unless one is waiting.
    fn schedule(&'static self, current: &SessionState) {
        if !current.dirty || current.path.is_none() || self.pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let spawned = std::thread::Builder::new().name("session-state".into()).spawn(move || self.write_later());
        if let Err(error) = spawned {
            self.pending.store(false, Ordering::Release);
            eprintln!("PandaCode: could not schedule a session state save: {error}");
        }
    }

    /// The background write: after `delay`, outside the state lock so a turn never waits for the
    /// file; a failure is retried once after another delay, then waits for the next change or exit.
    fn write_later(&self) {
        for attempt in 1..=WRITE_ATTEMPTS {
            std::thread::sleep(self.delay);
            self.pending.store(false, Ordering::Release);
            let Some(snapshot) = self.lock().snapshot() else { return };
            let Err(error) = snapshot.write() else { return };
            eprintln!("PandaCode: could not save session state: {error}");
            self.lock().failed();
            // Another change already scheduled the next write.
            if attempt == WRITE_ATTEMPTS || self.pending.swap(true, Ordering::AcqRel) {
                return;
            }
        }
    }

    fn update<R>(&'static self, id: &str, change: impl FnOnce(&mut TaskState) -> R) -> R {
        let mut state = self.lock();
        let result = state.update(id, change);
        self.schedule(&state);
        result
    }

    /// `update`, writing the file before returning when anything changed (a tool listing): the
    /// change is snapshotted under the state lock and written under the write lock only, so no
    /// fsync holds up other tasks. If the write fails, the task's listing is dropped in memory and
    /// the state is rewritten without it. If that fails too, invalidate the file and retry the save.
    // ponytail: the write (one fsync of the whole file) runs on the caller's thread. The launch
    // moves `remember_catalog_listed` to a blocking thread; `History::of` still writes inline,
    // only when it binds a new conversation's listing (once per conversation).
    pub(crate) fn update_now<R>(&'static self, id: &str, change: impl FnOnce(&mut TaskState) -> R) -> R {
        let (result, snapshot) = self.lock().change_now(id, change);
        let Some(Err(error)) = snapshot.map(|snapshot| snapshot.write()) else { return result };
        eprintln!("PandaCode: could not save session state, forgetting task {id}: {error}");
        let retry = self.lock().forget_unsaved(id);
        if let Some(Err(error)) = retry.map(|retry| retry.write_or_remove()) {
            eprintln!("PandaCode: could not save session state after forgetting task {id}: {error}");
            let mut state = self.lock();
            state.failed();
            self.schedule(&state);
        }
        result
    }

    fn clear(&'static self, ids: &[String], clear: impl Fn(&mut TaskState)) {
        let mut state = self.lock();
        state.clear(ids, clear);
        self.schedule(&state);
    }

    fn retain(&'static self, live: impl Fn(&str) -> bool) {
        let mut state = self.lock();
        state.retain(live);
        self.schedule(&state);
    }
}

static STATE: LazyLock<Shared> = LazyLock::new(|| Shared::new(SessionState::default(), WRITE_DELAY));

/// Backs the process's state with `dir`'s file (desktop and headless startup).
pub(crate) fn init(dir: &Path) {
    STATE.lock().init(dir);
}

/// Reads one task's entry.
pub(crate) fn get<R>(id: &str, read: impl FnOnce(Option<&TaskState>) -> R) -> R {
    STATE.lock().get(id, read)
}

/// Changes one task's entry (`SessionState::update`); the file is written shortly after.
pub(crate) fn update<R>(id: &str, change: impl FnOnce(&mut TaskState) -> R) -> R {
    STATE.update(id, change)
}

/// Changes one task's entry and writes the file first (`Shared::update_now`).
pub(crate) fn update_now<R>(id: &str, change: impl FnOnce(&mut TaskState) -> R) -> R {
    STATE.update_now(id, change)
}

/// Clears fields of deleted tasks (`SessionState::clear`).
pub(crate) fn clear(ids: &[String], clear: impl Fn(&mut TaskState)) {
    STATE.clear(ids, clear);
}

/// Drops entries of tasks that no longer exist (`SessionState::retain`).
pub(crate) fn retain(live: impl Fn(&str) -> bool) {
    STATE.retain(live);
}

/// Writes any changes still waiting (`RunEvent::Exit`, desktop and serve).
pub(crate) fn flush() {
    flush_in(&mut STATE.lock());
}

fn flush_in(state: &mut SessionState) {
    if let Err(error) = state.flush() {
        eprintln!("PandaCode: could not save session state: {error}");
    }
}

#[cfg(test)]
pub(crate) mod tests;
