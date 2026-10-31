//! Immutable, bounded snapshots scoped to write tools from this task.
//! Unreported writes and ambiguous shared-file edits are never attributed by checkout status.
use crate::{
    storage::{self, Store},
    Result,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

mod host;
mod team;
pub(crate) use host::{instruction, with_host, TOOL as TRACK_TOOL};

#[cfg(test)]
const FILES: usize = 6000;
const FILE_BYTES: usize = 1024 * 1024;
const SCAN_BYTES: usize = 32 * 1024 * 1024;
const CHANGE_FILES: usize = 200;
const PATCH_BYTES: usize = 256 * 1024;
const TURN_BYTES: usize = 2 * 1024 * 1024;
const RETAINED_BYTES: i64 = 128 * 1024 * 1024;
const SCAN_TIME: Duration = Duration::from_millis(500);
const SNAPSHOT_WAIT: Duration = Duration::from_millis(750);
const MAX_SCANS: usize = 8;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: String,
    pub additions: Option<usize>,
    pub deletions: Option<usize>,
    pub binary: bool,
    pub truncated: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnChanges {
    pub id: String,
    pub files: Vec<ChangedFile>,
    pub additions: usize,
    pub deletions: usize,
    pub truncated: bool,
    pub concurrent: bool,
    /// Older captures observed the whole checkout and cannot claim task ownership.
    #[serde(default)]
    pub attributed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangeDiff {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub patch: String,
    pub binary: bool,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
pub struct Captured {
    pub summary: TurnChanges,
    pub details: Vec<TurnChangeDiff>,
}
#[derive(Clone)]
struct Entry {
    len: u64,
    mode: u32,
    hash: Option<[u8; 32]>,
    blob: Option<PathBuf>,
    binary: bool,
    truncated: bool,
}
struct Snapshot {
    directory: Option<PathBuf>,
    entries: BTreeMap<String, Entry>,
    known: BTreeSet<String>,
    absent: BTreeSet<String>,
    excluded: Vec<String>,
    complete: bool,
    truncated: bool,
    error: Option<String>,
}
impl Snapshot {
    fn unavailable(error: &str) -> Self {
        Self {
            directory: None,
            entries: BTreeMap::new(),
            known: BTreeSet::new(),
            absent: BTreeSet::new(),
            excluded: Vec::new(),
            complete: false,
            truncated: true,
            error: Some(error.into()),
        }
    }
}
impl Drop for Snapshot {
    fn drop(&mut self) {
        if let Some(path) = &self.directory {
            let _ = fs::remove_dir_all(path);
        }
    }
}
struct Lease {
    id: String,
    concurrent: Arc<AtomicBool>,
    conflicts: Arc<Mutex<BTreeSet<String>>>,
}
struct Live {
    root: PathBuf,
    concurrent: Arc<AtomicBool>,
    paths: BTreeMap<PathBuf, String>,
    conflicts: Arc<Mutex<BTreeSet<String>>>,
}
fn live() -> &'static Mutex<HashMap<String, Live>> {
    static LIVE: OnceLock<Mutex<HashMap<String, Live>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashMap::new()))
}
impl Lease {
    fn start(root: &Path) -> Self {
        let id = storage::id();
        let concurrent = Arc::new(AtomicBool::new(false));
        let conflicts = Arc::new(Mutex::new(BTreeSet::new()));
        let mut active = live().lock().unwrap_or_else(|e| e.into_inner());
        for other in active.values() {
            if root.starts_with(&other.root) || other.root.starts_with(root) {
                other.concurrent.store(true, Ordering::SeqCst);
                concurrent.store(true, Ordering::SeqCst);
            }
        }
        active.insert(
            id.clone(),
            Live {
                root: root.to_path_buf(),
                concurrent: concurrent.clone(),
                paths: BTreeMap::new(),
                conflicts: conflicts.clone(),
            },
        );
        Self {
            id,
            concurrent,
            conflicts,
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        live()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

/// Filesystem calls can stall beyond a cooperative deadline. Never let one hold
/// provider startup; a late baseline is discarded because the agent may be editing.
fn bounded_snapshot(work: impl FnOnce() -> Snapshot + Send + 'static, wait: Duration) -> Snapshot {
    static ACTIVE: AtomicUsize = AtomicUsize::new(0);
    struct Slot;
    impl Drop for Slot {
        fn drop(&mut self) {
            ACTIVE.fetch_sub(1, Ordering::SeqCst);
        }
    }
    // A compare-exchange loop rather than fetch_update, which newer toolchains deprecate.
    let mut active = ACTIVE.load(Ordering::SeqCst);
    loop {
        if active >= MAX_SCANS {
            return Snapshot::unavailable("Change tracking is busy; this turn has no file baseline.");
        }
        match ACTIVE.compare_exchange_weak(active, active + 1, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => break,
            Err(current) => active = current,
        }
    }
    let slot = Slot;
    let (sender, receiver) = mpsc::sync_channel(1);
    if std::thread::Builder::new()
        .name("turn-snapshot".into())
        .spawn(move || {
            let _slot = slot;
            let _ = sender.send(work());
        })
        .is_err()
    {
        return Snapshot::unavailable(
            "Change tracking could not start; this turn has no file baseline.",
        );
    }
    receiver.recv_timeout(wait).unwrap_or_else(|_| {
        Snapshot::unavailable(
            "Change tracking exceeded its time budget; some files were not inspected.",
        )
    })
}

/// One tracker per provider run. Only successful tools with explicit file paths
/// contribute bytes; neither the checkout inventory nor Git status establishes ownership.
pub struct Tracker {
    root: PathBuf,
    requested_root: PathBuf,
    cache: PathBuf,
    before: Snapshot,
    after: Snapshot,
    retained: Vec<Snapshot>,
    pending: HashMap<String, Snapshot>,
    finished: BTreeSet<String>,
    ambiguous: BTreeSet<String>,
    lease: Option<Lease>,
    dirty_since_boundary: bool,
    limited: bool,
    snapshot_bytes: usize,
    observed_paths: BTreeSet<String>,
}
fn empty_snapshot() -> Snapshot {
    Snapshot {
        directory: None,
        entries: BTreeMap::new(),
        known: BTreeSet::new(),
        absent: BTreeSet::new(),
        excluded: vec![],
        complete: true,
        truncated: false,
        error: None,
    }
}
fn copy_path(target: &mut Snapshot, source: &Snapshot, path: &str) {
    target.known.insert(path.into());
    target.entries.remove(path);
    target.absent.remove(path);
    if let Some(entry) = source.entries.get(path) {
        target.entries.insert(path.into(), entry.clone());
    } else if source.absent.contains(path) {
        target.absent.insert(path.into());
    }
    target.truncated |= source.truncated;
    if target.error.is_none() {
        target.error = source.error.clone();
    }
}
fn same_path(a: &Snapshot, b: &Snapshot, path: &str) -> bool {
    match (a.entries.get(path), b.entries.get(path)) {
        (Some(a), Some(b)) => a.hash.is_some() && b.hash.is_some() && entry_equal(a, b),
        (None, None) => a.absent.contains(path) && b.absent.contains(path),
        _ => false,
    }
}
impl Tracker {
    pub fn start(root: PathBuf, cache: PathBuf) -> Self {
        let requested_root = root.clone();
        let root = root.canonicalize().unwrap_or(root);
        let lease = Lease::start(&root);
        Self {
            root,
            requested_root,
            cache,
            before: empty_snapshot(),
            after: empty_snapshot(),
            retained: vec![],
            pending: HashMap::new(),
            finished: BTreeSet::new(),
            ambiguous: BTreeSet::new(),
            lease: Some(lease),
            dirty_since_boundary: true,
            limited: false,
            snapshot_bytes: 0,
            observed_paths: BTreeSet::new(),
        }
    }
    pub fn started(&mut self) {
        self.dirty_since_boundary = true;
        if self.lease.is_none() {
            self.lease = Some(Lease::start(&self.root));
        }
    }
    fn relative_path(&self, path: &str) -> Option<String> {
        let path = Path::new(path);
        #[cfg(windows)]
        let (path, root, requested) = (
            dunce::simplified(path),
            dunce::simplified(&self.root),
            dunce::simplified(&self.requested_root),
        );
        #[cfg(not(windows))]
        let (root, requested) = (self.root.as_path(), self.requested_root.as_path());
        let relative = if path.is_absolute() {
            path.strip_prefix(root)
                .or_else(|_| path.strip_prefix(requested))
                .ok()?
        } else {
            path
        };
        let relative = relative
            .components()
            .filter(|part| !matches!(part, Component::CurDir))
            .collect::<PathBuf>()
            .to_str()?
            .to_owned();
        #[cfg(windows)]
        let relative = relative.replace('\\', "/");
        safe_relative(&relative).then_some(relative)
    }

    fn capture_paths(&mut self, paths: &BTreeSet<String>) -> Snapshot {
        if self.snapshot_bytes >= SCAN_BYTES
            || self.retained.len() >= 512
            || self.retained.iter().map(|s| s.known.len()).sum::<usize>() + paths.len() > 2000
        {
            return Snapshot::unavailable("This turn reached its change snapshot limit.");
        }
        let (root, cache, paths) = (self.root.clone(), self.cache.clone(), paths.clone());
        let snapshot = bounded_snapshot(
            move || {
                scan_paths(
                    &root,
                    &cache,
                    paths,
                    vec![],
                    true,
                    None,
                    Instant::now() + SCAN_TIME,
                )
            },
            SNAPSHOT_WAIT,
        );
        self.snapshot_bytes = self.snapshot_bytes.saturating_add(
            snapshot
                .entries
                .values()
                .filter(|e| e.blob.is_some())
                .map(|e| e.len as usize)
                .sum::<usize>(),
        );
        snapshot
    }
    fn claim_paths(&mut self, paths: &BTreeSet<String>) {
        let Some(lease) = &self.lease else {
            return;
        };
        let mut active = live().lock().unwrap_or_else(|e| e.into_inner());
        let claims: Vec<_> = paths
            .iter()
            .map(|path| {
                let absolute = self.root.join(path);
                // macOS and Windows commonly resolve case aliases to one file.
                // Treat them conservatively as conflicts even on a case-sensitive
                // volume, rather than attributing another task's bytes.
                #[cfg(any(target_os = "macos", windows))]
                let absolute = PathBuf::from(absolute.to_string_lossy().to_lowercase());
                (absolute, path.clone())
            })
            .collect();
        for (id, other) in active.iter() {
            if id == &lease.id {
                continue;
            }
            for (absolute, path) in &claims {
                if let Some(other_path) = other.paths.get(absolute) {
                    lease
                        .conflicts
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(path.clone());
                    other
                        .conflicts
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(other_path.clone());
                }
            }
        }
        if let Some(own) = active.get_mut(&lease.id) {
            for (absolute, path) in claims {
                if let Some(previous) = own.paths.insert(absolute, path.clone()) {
                    if previous != path {
                        let mut conflicts =
                            lease.conflicts.lock().unwrap_or_else(|e| e.into_inner());
                        conflicts.insert(previous);
                        conflicts.insert(path);
                    }
                }
            }
        }
    }

    pub fn observe(&mut self, event: &crate::providers::AgentEvent) {
        if let Some(tool) = &event.tool {
            self.observe_tool(&tool.id, tool);
        }
        // Native delegates belong to their parent task. Team workers run through
        // their own task sink and tracker; their writes never enter this one.
        if event.kind == "subagent" {
            if let Some(data) = &event.data {
                if let Ok(child) =
                    serde_json::from_value::<crate::providers::SubagentActivity>(data.clone())
                {
                    for tool in &child.tools {
                        self.observe_tool(&format!("child:{}:{}", child.id, tool.id), tool);
                    }
                }
            }
        }
    }
    fn observe_tool(&mut self, id: &str, tool: &crate::providers::ToolActivity) {
        let Some(reported) = &tool.write_paths else {
            return;
        };
        if !self.dirty_since_boundary || self.finished.contains(id) {
            return;
        }
        if self.finished.len() + self.pending.len() >= 512 {
            self.limited = true;
            return;
        }
        let mut paths: BTreeSet<_> = reported
            .iter()
            .take(CHANGE_FILES)
            .filter_map(|p| self.relative_path(p))
            .collect();
        self.limited |= paths.len() != reported.iter().collect::<BTreeSet<_>>().len()
            || (reported.is_empty()
                && tool.status != "running"
                && !id.starts_with("reported:")
                && !self.pending.keys().any(|id| id.starts_with("reported:")));
        if !id.starts_with("reported:") && !paths.is_empty() {
            // An explicit pre-write handshake owns these paths. Native events
            // inside that batch must not create a second, later baseline.
            paths.retain(|path| {
                !self.pending.iter().any(|(id, snapshot)| {
                    id.starts_with("reported:") && snapshot.known.contains(path)
                })
            });
            if paths.is_empty() {
                return;
            }
        }
        if tool.status == "running" {
            let pending = self.pending.entry(id.into()).or_insert_with(empty_snapshot);
            let mut missing: BTreeSet<_> = paths.difference(&pending.known).cloned().collect();
            missing.retain(|path| {
                if self.observed_paths.contains(path) {
                    true
                } else if self.observed_paths.len() < CHANGE_FILES {
                    self.observed_paths.insert(path.clone());
                    true
                } else {
                    self.limited = true;
                    false
                }
            });
            if !missing.is_empty() {
                self.claim_paths(&missing);
                let captured = self.capture_paths(&missing);
                if captured.directory.is_none() {
                    self.limited = true;
                    return;
                }
                let pending = self.pending.get_mut(id).unwrap();
                for path in &missing {
                    copy_path(pending, &captured, path);
                }
                self.retained.push(captured);
            }
            return;
        }
        self.finished.insert(id.into());
        let Some(before) = self.pending.remove(id) else {
            self.limited |= !paths.is_empty();
            return;
        };
        if tool.status != "completed" {
            return;
        }
        self.limited |= !paths.is_subset(&before.known);
        let paths: BTreeSet<_> = paths.intersection(&before.known).cloned().collect();
        if paths.is_empty() {
            return;
        }
        let after = self.capture_paths(&paths);
        for path in &paths {
            if self.before.known.len() >= CHANGE_FILES && !self.before.known.contains(path) {
                self.limited = true;
                continue;
            }
            if (!before.entries.contains_key(path) && !before.absent.contains(path))
                || (!after.entries.contains_key(path) && !after.absent.contains(path))
            {
                self.limited = true;
                continue;
            }
            if self.after.known.contains(path) && !same_path(&self.after, &before, path) {
                // Someone changed this file between this task's tools. A net diff
                // would incorporate those unowned bytes, so omit the file.
                self.ambiguous.insert(path.clone());
            }
            if !self.before.known.contains(path) {
                copy_path(&mut self.before, &before, path);
            }
            copy_path(&mut self.after, &after, path);
        }
        if after.directory.is_some() {
            self.retained.push(after);
        }
    }
    pub fn boundary(&mut self) -> Option<Captured> {
        if !self.dirty_since_boundary {
            return None;
        }
        if let Some(lease) = &self.lease {
            self.ambiguous.extend(
                lease
                    .conflicts
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .iter()
                    .cloned(),
            );
        }
        for path in &self.ambiguous {
            for snapshot in [&mut self.before, &mut self.after] {
                snapshot.entries.remove(path);
                snapshot.absent.remove(path);
                snapshot.known.remove(path);
            }
        }
        let concurrent = self
            .lease
            .as_ref()
            .is_some_and(|l| l.concurrent.load(Ordering::SeqCst));
        let mut changes = compare(&self.before, &self.after, concurrent);
        changes.summary.attributed = true;
        if self.limited || !self.pending.is_empty() || !self.ambiguous.is_empty() {
            changes.summary.truncated = true;
            changes.summary.error.get_or_insert("Only files confirmed by this task's write tools are shown. Unreported or ambiguous edits were omitted.".into());
        }
        self.before = empty_snapshot();
        self.after = empty_snapshot();
        self.pending.clear();
        self.finished.clear();
        self.ambiguous.clear();
        self.retained.clear();
        self.lease = None;
        self.limited = false;
        self.snapshot_bytes = 0;
        self.observed_paths.clear();
        self.dirty_since_boundary = false;
        Some(changes)
    }
    pub fn finish(&mut self) -> Option<Captured> {
        self.boundary()
    }
}

fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains('\0')
        && Path::new(path)
            .components()
            .all(|c| matches!(c,Component::Normal(name) if !name.to_string_lossy().eq_ignore_ascii_case(".git")))
}
#[cfg(test)]
fn excluded_directory(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | ".venv"
            | "venv"
            | ".next"
            | ".cache"
            | "dist"
            | "build"
    )
}
#[cfg(test)]
fn inventory(root: &Path, deadline: Instant) -> (Vec<String>, Vec<String>, bool, Option<String>) {
    if Instant::now() >= deadline {
        return (
            vec![],
            vec![],
            false,
            Some("Change tracking exceeded its time budget.".into()),
        );
    }
    match crate::workspace::turn_snapshot_paths(root, deadline) {
        Ok(Some((mut paths, excluded, truncated))) => {
            paths.sort();
            paths.dedup();
            let capped = paths.len() > FILES;
            paths.truncate(FILES);
            return (paths, excluded, !truncated && !capped, None);
        }
        Err(error) => {
            return (
                vec![],
                vec![],
                false,
                Some(format!("Checkout inventory unavailable: {error}")),
            )
        }
        Ok(None) => {}
    }
    let mut stack = vec![PathBuf::new()];
    let mut paths = Vec::new();
    let mut excluded = Vec::new();
    let mut complete = true;
    let mut error = None;
    let mut visited = 0;
    let mut path_bytes = 0;
    while let Some(relative) = stack.pop() {
        if Instant::now() >= deadline || visited >= FILES * 2 {
            complete = false;
            break;
        }
        let directory = match fs::read_dir(root.join(&relative)) {
            Ok(v) => v,
            Err(e) => {
                complete = false;
                error = Some(format!("Some folders could not be inspected: {e}"));
                continue;
            }
        };
        for item in directory {
            visited += 1;
            if visited >= FILES * 2 || paths.len() >= FILES || Instant::now() >= deadline {
                complete = false;
                break;
            }
            let Ok(item) = item else {
                complete = false;
                continue;
            };
            let child = relative.join(item.file_name());
            let Some(path) = child.to_str() else {
                complete = false;
                continue;
            };
            let Ok(kind) = item.file_type() else {
                complete = false;
                continue;
            };
            #[cfg(windows)]
            let normalized_path = path.replace('\\', "/");
            #[cfg(windows)]
            let path = normalized_path.as_str();
            if kind.is_dir() {
                if excluded_directory(&item.file_name().to_string_lossy()) {
                    excluded.push(format!("{path}/"));
                } else {
                    stack.push(child);
                }
            } else if kind.is_file() || kind.is_symlink() {
                path_bytes += path.len();
                if path_bytes > 1024 * 1024 {
                    complete = false;
                    break;
                }
                paths.push(path.into());
            }
        }
        if !complete && (paths.len() >= FILES || path_bytes > 1024 * 1024) {
            break;
        }
    }
    paths.sort();
    (paths, excluded, complete, error)
}
#[cfg(unix)]
fn open_entry(root: &Path, path: &str) -> std::io::Result<(File, String)> {
    use std::{
        ffi::CString,
        os::fd::{AsRawFd, FromRawFd},
        os::unix::fs::OpenOptionsExt,
    };
    let mut dir = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)?;
    let mut components = Path::new(path).components().peekable();
    while let Some(Component::Normal(name)) = components.next() {
        let name = CString::new(name.as_encoded_bytes())?;
        if components.peek().is_none() {
            return Ok((dir, name.to_string_lossy().into()));
        }
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        dir = unsafe { File::from_raw_fd(fd) };
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        "Invalid relative path",
    ))
}
#[cfg(unix)]
fn read_bytes(
    root: &Path,
    path: &str,
    limit: usize,
) -> std::io::Result<(Vec<u8>, fs::Metadata, bool)> {
    use std::{
        ffi::CString,
        os::fd::{AsRawFd, FromRawFd},
        os::unix::fs::MetadataExt,
    };
    let (dir, name) = open_entry(root, path)?;
    let name = CString::new(name)?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ELOOP) {
            return Err(error);
        }
        let mut bytes = vec![0u8; 8192];
        let size = unsafe {
            libc::readlinkat(
                dir.as_raw_fd(),
                name.as_ptr(),
                bytes.as_mut_ptr().cast(),
                bytes.len(),
            )
        };
        if size < 0 {
            return Err(std::io::Error::last_os_error());
        }
        bytes.truncate(size as usize);
        // Only the target bytes describe a symlink; no target is opened.
        let metadata = dir.metadata()?;
        return Ok((bytes, metadata, true));
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let before = file.metadata()?;
    if !before.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Not a regular file",
        ));
    }
    let read_limit = if before.len() > limit as u64 {
        limit.min(4096)
    } else {
        limit
    };
    let mut bytes = Vec::with_capacity((before.len() as usize).min(read_limit));
    (&file)
        .take(read_limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
    {
        return Err(std::io::Error::other(
            "File changed while its snapshot was being read",
        ));
    }
    Ok((bytes, after, false))
}
#[cfg(windows)]
fn read_bytes(
    root: &Path,
    path: &str,
    limit: usize,
) -> std::io::Result<(Vec<u8>, fs::Metadata, bool)> {
    use std::os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    };
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{
            GetFinalPathNameByHandleW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_NORMALIZED,
        },
    };
    let invalid =
        || std::io::Error::other("Snapshot path is not a regular file inside this checkout");
    if path.is_empty()
        || !Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(invalid());
    }
    let root = root.canonicalize()?;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0 | FILE_FLAG_BACKUP_SEMANTICS.0)
        .open(root.join(path))?;
    let before = file.metadata()?;
    if !before.is_file() || before.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(invalid());
    }
    // Validate the opened handle before reading bytes. Checking the string path
    // alone would race a worker replacing an ancestor with a junction/symlink.
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            HANDLE(file.as_raw_handle()),
            &mut buffer,
            FILE_NAME_NORMALIZED,
        )
    };
    if length == 0 || length as usize >= buffer.len() {
        return Err(invalid());
    }
    let actual =
        PathBuf::from(String::from_utf16(&buffer[..length as usize]).map_err(|_| invalid())?);
    if !actual.starts_with(&root) {
        return Err(invalid());
    }
    let read_limit = if before.len() > limit as u64 {
        limit.min(4096)
    } else {
        limit
    };
    let mut bytes = Vec::with_capacity((before.len() as usize).min(read_limit));
    (&file)
        .take(read_limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if before.len() != after.len() || before.last_write_time() != after.last_write_time() {
        return Err(std::io::Error::other(
            "File changed while its snapshot was being read",
        ));
    }
    Ok((bytes, after, false))
}
#[cfg(not(any(unix, windows)))]
fn read_bytes(
    _root: &Path,
    _path: &str,
    _limit: usize,
) -> std::io::Result<(Vec<u8>, fs::Metadata, bool)> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Safe checkout snapshots are currently available on macOS and Linux.",
    ))
}
/// Only abandoned app-owned capture directories are removed. Another live app
/// instance's PID is left alone; none of this touches a checkout or Git data.
pub(crate) fn cleanup_cache(cache: &Path) {
    let Ok(entries) = fs::read_dir(cache) else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    for entry in entries.take(128).flatten() {
        if Instant::now() > deadline {
            break;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some((pid, uuid)) = name
            .strip_prefix("capture-")
            .and_then(|s| s.split_once('-'))
        else {
            continue;
        };
        let Ok(pid) = pid.parse::<u32>() else {
            continue;
        };
        if uuid::Uuid::parse_str(uuid).is_err() || pid == std::process::id() {
            continue;
        }
        #[cfg(unix)]
        {
            if pid > i32::MAX as u32 {
                continue;
            }
            let alive = unsafe { libc::kill(pid as i32, 0) } == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
            if alive {
                continue;
            }
        }
        #[cfg(windows)]
        {
            use windows::Win32::{
                Foundation::{CloseHandle, ERROR_INVALID_PARAMETER},
                System::Threading::{
                    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
                },
            };
            // Access denied means the process may still be alive. Only remove
            // caches after proving its owner exited or no longer exists.
            match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
                Ok(handle) => {
                    let mut code = 259;
                    let result = unsafe { GetExitCodeProcess(handle, &mut code) };
                    let _ = unsafe { CloseHandle(handle) };
                    if result.is_err() || code == 259 {
                        continue;
                    }
                }
                Err(error)
                    if error.code()
                        == windows::core::HRESULT::from_win32(ERROR_INVALID_PARAMETER.0) => {}
                Err(_) => continue,
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            continue;
        }
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
fn scan(root: &Path, cache: &Path, known: Option<&BTreeSet<String>>) -> Snapshot {
    // The production budget is 500 ms, on purpose: the baseline must never hold
    // the agent's start. A loaded machine can miss it, and a partial
    // inventory omits files the tests then count exactly, so the tests wait.
    let deadline = Instant::now() + Duration::from_secs(30);
    let (paths, excluded, complete, error) = inventory(root, deadline);
    let mut paths: BTreeSet<_> = paths.into_iter().collect();
    if let Some(known) = known {
        paths.extend(known.iter().cloned());
    }
    scan_paths(root, cache, paths, excluded, complete, error, deadline)
}
fn scan_paths(
    root: &Path,
    cache: &Path,
    paths: BTreeSet<String>,
    excluded: Vec<String>,
    complete: bool,
    error: Option<String>,
    deadline: Instant,
) -> Snapshot {
    if !root.is_dir() {
        return Snapshot::unavailable(
            "The task folder is unavailable; no file deletions were inferred.",
        );
    }
    let mut result = Snapshot {
        directory: None,
        entries: BTreeMap::new(),
        known: paths.iter().cloned().collect(),
        absent: BTreeSet::new(),
        excluded,
        complete,
        truncated: !complete,
        error,
    };
    let dir = cache.join(format!("capture-{}-{}", std::process::id(), storage::id()));
    if let Err(e) = fs::create_dir_all(cache).and_then(|_| fs::create_dir(&dir)) {
        result.complete = false;
        result.truncated = true;
        result.error = Some(format!("Snapshot storage unavailable: {e}"));
        return result;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    result.directory = Some(dir.clone());
    let mut bytes_left = SCAN_BYTES;
    for path in paths {
        if !safe_relative(&path) {
            result.truncated = true;
            continue;
        }
        if Instant::now() >= deadline {
            result.complete = false;
            result.truncated = true;
            result.error.get_or_insert(
                "Snapshot time limit reached; some files were not inspected.".into(),
            );
            break;
        }
        let budget = FILE_BYTES.min(bytes_left);
        match read_bytes(root, &path, budget) {
            Ok((bytes, metadata, symlink)) => {
                let truncated =
                    bytes.len() > budget || (!symlink && bytes.len() as u64 != metadata.len());
                let blob = (!truncated).then(|| dir.join(result.entries.len().to_string()));
                let hash = (!truncated).then(|| Sha256::digest(&bytes).into());
                let mut entry = Entry {
                    len: if symlink {
                        bytes.len() as u64
                    } else {
                        metadata.len()
                    },
                    mode: if symlink { 0o120000 } else { 0o100644 },
                    hash,
                    blob: blob.clone(),
                    binary: bytes.contains(&0) || std::str::from_utf8(&bytes).is_err(),
                    truncated,
                };
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if !symlink && metadata.mode() & 0o111 != 0 {
                        entry.mode = 0o100755;
                    }
                }
                bytes_left = bytes_left.saturating_sub(bytes.len());
                if let Some(blob) = blob {
                    if let Err(e) = File::create(&blob).and_then(|mut f| f.write_all(&bytes)) {
                        entry.blob = None;
                        entry.truncated = true;
                        result.error = Some(format!("Some snapshots could not be stored: {e}"));
                    }
                }
                result.truncated |= entry.truncated;
                result.entries.insert(path, entry);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                result.absent.insert(path);
            }
            Err(e) => {
                result.truncated = true;
                result
                    .error
                    .get_or_insert(format!("Some files could not be captured: {e}"));
            }
        }
    }
    result
}
fn entry_equal(a: &Entry, b: &Entry) -> bool {
    a.mode == b.mode
        && match (a.hash, b.hash) {
            (Some(a), Some(b)) => a == b,
            _ => a.len == b.len,
        }
}
fn was_excluded(before: &Snapshot, path: &str) -> bool {
    before.excluded.iter().any(|x| {
        if x.ends_with('/') {
            path.starts_with(x)
        } else {
            path == x
        }
    })
}
fn compare(before: &Snapshot, after: &Snapshot, concurrent: bool) -> Captured {
    let mut summary = TurnChanges {
        id: storage::id(),
        files: vec![],
        additions: 0,
        deletions: 0,
        truncated: before.truncated || after.truncated,
        concurrent,
        attributed: false,
        error: before.error.clone().or_else(|| after.error.clone()),
    };
    type Candidate<'a> = (
        String,
        Option<String>,
        String,
        Option<&'a Entry>,
        Option<&'a Entry>,
    );
    let mut changes: Vec<Candidate<'_>> = Vec::new();
    let mut deleted: BTreeSet<String> = before
        .entries
        .keys()
        .filter(|p| after.absent.contains(*p) && (after.complete || after.known.contains(*p)))
        .cloned()
        .collect();
    let mut rename_sources: HashMap<([u8; 32], u32), Vec<String>> = HashMap::new();
    for path in deleted.iter().rev() {
        let entry = &before.entries[path];
        if let Some(hash) = entry.hash {
            rename_sources
                .entry((hash, entry.mode))
                .or_default()
                .push(path.clone());
        }
    }
    for (path, new) in &after.entries {
        if let Some(old) = before.entries.get(path) {
            if !entry_equal(old, new) {
                changes.push((path.clone(), None, "modified".into(), Some(old), Some(new)));
            }
        } else {
            let eligible = before.complete
                && !was_excluded(before, path)
                && (!before.known.contains(path) || before.absent.contains(path));
            if !eligible {
                summary.truncated = true;
                summary.error.get_or_insert(
                    "Some newly visible files had no baseline and were omitted.".into(),
                );
                continue;
            }
            let rename = new
                .hash
                .and_then(|hash| rename_sources.get_mut(&(hash, new.mode)))
                .and_then(Vec::pop);
            if let Some(old) = rename {
                deleted.remove(&old);
                changes.push((
                    path.clone(),
                    Some(old.clone()),
                    "renamed".into(),
                    Some(&before.entries[&old]),
                    Some(new),
                ));
            } else if before.complete
                && !was_excluded(before, path)
                && (!before.known.contains(path) || before.absent.contains(path))
            {
                changes.push((path.clone(), None, "added".into(), None, Some(new)));
            } else {
                summary.truncated = true;
                summary.error.get_or_insert(
                    "Some newly visible files had no baseline and were omitted.".into(),
                );
            }
        }
    }
    for path in deleted {
        changes.push((
            path.clone(),
            None,
            "deleted".into(),
            Some(&before.entries[&path]),
            None,
        ));
    }
    changes.sort_by(|a, b| a.0.cmp(&b.0));
    if changes.len() > CHANGE_FILES {
        changes.truncate(CHANGE_FILES);
        summary.truncated = true;
        summary
            .error
            .get_or_insert("Only the first 200 changed files are included.".into());
    }
    let mut details = Vec::new();
    let mut left = TURN_BYTES;
    let deadline = Instant::now() + Duration::from_millis(1500);
    for (path, old_path, status, old, new) in changes {
        let binary = old.is_some_and(|e| e.binary) || new.is_some_and(|e| e.binary);
        let timed_out = Instant::now() > deadline;
        let unavailable = timed_out
            || old.is_some_and(|e| e.blob.is_none())
            || new.is_some_and(|e| e.blob.is_none());
        let mut detail = TurnChangeDiff {
            path: path.clone(),
            old_path: old_path.clone(),
            patch: String::new(),
            binary,
            truncated: unavailable,
            error: None,
        };
        let (mut additions, mut deletions) = (None, None);
        if binary {
            detail.error = Some("Binary content changed. A text diff is unavailable.".into());
        } else if unavailable {
            detail.error = Some(
                if timed_out {
                    "Turn diff time limit reached; this file's preview is unavailable."
                } else {
                    "File exceeded snapshot limits; its complete diff is unavailable."
                }
                .into(),
            );
        } else {
            let content = |entry: Option<&Entry>| -> Result<String> {
                entry
                    .map(|e| {
                        fs::read_to_string(e.blob.as_ref().unwrap()).map_err(|e| e.to_string())
                    })
                    .transpose()
                    .map(|s| s.unwrap_or_default())
            };
            match content(old).and_then(|a| content(new).map(|b| (a, b))) {
                Ok((a, b)) => match text_patch(
                    &path,
                    old_path.as_deref(),
                    &a,
                    &b,
                    old.is_some(),
                    new.is_some(),
                    PATCH_BYTES.min(left),
                ) {
                    Some((patch, plus, minus)) => {
                        additions = Some(plus);
                        deletions = Some(minus);
                        left = left.saturating_sub(patch.len());
                        detail.patch = patch;
                    }
                    None => {
                        detail.truncated = true;
                        detail.error=Some("Diff complexity or preview limit reached; this file is listed without a patch.".into());
                    }
                },
                Err(e) => {
                    detail.truncated = true;
                    detail.error = Some(format!("Snapshot content unavailable: {e}"));
                }
            }
        }
        if old.zip(new).is_some_and(|(a, b)| a.mode != b.mode) {
            let mode = format!(
                "old mode {:06o}\nnew mode {:06o}\n",
                old.unwrap().mode,
                new.unwrap().mode
            );
            if detail.patch.len() + mode.len() <= PATCH_BYTES && mode.len() <= left {
                left -= mode.len();
                let after_header = detail.patch.find('\n').map_or(0, |i| i + 1);
                detail.patch.insert_str(after_header, &mode);
            } else {
                detail.truncated = true;
            }
        }
        if let Some(new) = new {
            detail.patch = detail.patch.replacen(
                "new file mode 100644",
                &format!("new file mode {:06o}", new.mode),
                1,
            );
        }
        if let Some(old) = old {
            detail.patch = detail.patch.replacen(
                "deleted file mode 100644",
                &format!("deleted file mode {:06o}", old.mode),
                1,
            );
        }
        summary.additions += additions.unwrap_or(0);
        summary.deletions += deletions.unwrap_or(0);
        summary.truncated |= detail.truncated;
        summary.files.push(ChangedFile {
            path,
            old_path,
            status,
            additions,
            deletions,
            binary,
            truncated: detail.truncated,
        });
        details.push(detail);
    }
    Captured { summary, details }
}

fn git_quote(path: &str) -> String {
    if !path
        .bytes()
        .any(|b| b <= 32 || b >= 127 || b == b'"' || b == b'\\')
    {
        return path.into();
    }
    let mut quoted = String::from("\"");
    for byte in path.bytes() {
        match byte {
            b'\n' => quoted.push_str("\\n"),
            b'\t' => quoted.push_str("\\t"),
            b'"' => quoted.push_str("\\\""),
            b'\\' => quoted.push_str("\\\\"),
            32..=126 => quoted.push(byte as char),
            _ => quoted.push_str(&format!("\\{byte:03o}")),
        }
    }
    quoted.push('"');
    quoted
}

#[derive(Clone, Copy)]
enum Op {
    Equal(usize),
    Delete(usize),
    Add(usize),
}
fn text_patch(
    path: &str,
    old_path: Option<&str>,
    old: &str,
    new: &str,
    had_old: bool,
    has_new: bool,
    limit: usize,
) -> Option<(String, usize, usize)> {
    let a: Vec<_> = old.split_inclusive('\n').collect();
    let b: Vec<_> = new.split_inclusive('\n').collect();
    if a.len() + b.len() > 30_000 {
        return None;
    }
    let ops = myers(&a, &b)?;
    let adds = ops.iter().filter(|o| matches!(o, Op::Add(_))).count();
    let dels = ops.iter().filter(|o| matches!(o, Op::Delete(_))).count();
    let mut output = format!(
        "diff --git {} {}\n",
        git_quote(&format!("a/{}", old_path.unwrap_or(path))),
        git_quote(&format!("b/{path}"))
    );
    if !had_old {
        output.push_str("new file mode 100644\n");
    }
    if !has_new {
        output.push_str("deleted file mode 100644\n");
    }
    if let Some(old) = old_path {
        output.push_str(&format!(
            "similarity index 100%\nrename from {}\nrename to {}\n",
            git_quote(old),
            git_quote(path)
        ));
    }
    if adds + dels == 0 {
        return (output.len() <= limit).then_some((output, 0, 0));
    }
    let from = if had_old {
        format!("a/{}", old_path.unwrap_or(path))
    } else {
        "/dev/null".into()
    };
    let to = if has_new {
        format!("b/{path}")
    } else {
        "/dev/null".into()
    };
    output.push_str(&format!(
        "--- {}\n+++ {}\n",
        git_quote(&from),
        git_quote(&to)
    ));
    let mut ranges: Vec<(usize, usize)> = vec![];
    for (i, op) in ops.iter().enumerate() {
        if !matches!(op, Op::Equal(_)) {
            let start = i.saturating_sub(3);
            let end = (i + 4).min(ops.len());
            if let Some(last) = ranges.last_mut().filter(|last| last.1 >= start) {
                last.1 = end;
            } else {
                ranges.push((start, end));
            }
        }
    }
    let mut old_at = vec![0; ops.len() + 1];
    let mut new_at = old_at.clone();
    for (i, op) in ops.iter().enumerate() {
        old_at[i + 1] = old_at[i] + usize::from(!matches!(op, Op::Add(_)));
        new_at[i + 1] = new_at[i] + usize::from(!matches!(op, Op::Delete(_)));
    }
    for (start, end) in ranges {
        let old_count = old_at[end] - old_at[start];
        let new_count = new_at[end] - new_at[start];
        output.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            old_at[start] + usize::from(old_count > 0),
            old_count,
            new_at[start] + usize::from(new_count > 0),
            new_count
        ));
        for op in &ops[start..end] {
            let (tag, line) = match *op {
                Op::Equal(i) => (' ', a[i]),
                Op::Delete(i) => ('-', a[i]),
                Op::Add(i) => ('+', b[i]),
            };
            if output.len() + line.len() + 40 > limit {
                return None;
            }
            output.push(tag);
            output.push_str(line);
            if !line.ends_with('\n') {
                output.push_str("\n\\ No newline at end of file\n");
            }
        }
    }
    if output.len() > limit {
        return None;
    }
    Some((output, adds, dels))
}
fn myers(a: &[&str], b: &[&str]) -> Option<Vec<Op>> {
    if a.is_empty() {
        return Some((0..b.len()).map(Op::Add).collect());
    }
    if b.is_empty() {
        return Some((0..a.len()).map(Op::Delete).collect());
    }
    let mut trace: Vec<Vec<i32>> = vec![];
    let mut work = 0usize;
    let mut found = None;
    let max = (a.len() + b.len()).min(512);
    let get = |row: &[i32], d: usize, k: i32| -> i32 {
        if k.abs() > d as i32 {
            0
        } else {
            row[(k + d as i32) as usize]
        }
    };
    for d in 0..=max {
        let mut row = vec![0; 2 * d + 1];
        for k in (-(d as i32)..=d as i32).step_by(2) {
            let mut x = if d == 0 {
                0
            } else {
                let previous = &trace[d - 1];
                if k == -(d as i32)
                    || (k != d as i32 && get(previous, d - 1, k - 1) < get(previous, d - 1, k + 1))
                {
                    get(previous, d - 1, k + 1)
                } else {
                    get(previous, d - 1, k - 1) + 1
                }
            };
            let mut y = x - k;
            while (x as usize) < a.len() && (y as usize) < b.len() && a[x as usize] == b[y as usize]
            {
                x += 1;
                y += 1;
                work += 1;
            }
            work += 1;
            if work > 2_000_000 {
                return None;
            }
            row[(k + d as i32) as usize] = x;
            if x as usize >= a.len() && y as usize >= b.len() {
                found = Some(d);
                break;
            }
        }
        trace.push(row);
        if found.is_some() {
            break;
        }
    }
    let d = found?;
    let (mut x, mut y) = (a.len() as i32, b.len() as i32);
    let mut ops = vec![];
    for depth in (1..=d).rev() {
        let k = x - y;
        let previous = &trace[depth - 1];
        let previous_k = if k == -(depth as i32)
            || (k != depth as i32
                && get(previous, depth - 1, k - 1) < get(previous, depth - 1, k + 1))
        {
            k + 1
        } else {
            k - 1
        };
        let px = get(previous, depth - 1, previous_k);
        let py = px - previous_k;
        while x > px && y > py {
            x -= 1;
            y -= 1;
            ops.push(Op::Equal(x as usize));
        }
        if x == px {
            y -= 1;
            ops.push(Op::Add(y as usize));
        } else {
            x -= 1;
            ops.push(Op::Delete(x as usize));
        }
    }
    while x > 0 && y > 0 {
        x -= 1;
        y -= 1;
        ops.push(Op::Equal(x as usize));
    }
    ops.reverse();
    Some(ops)
}

pub fn persist(store: &Store, sid: &str, mut capture: Captured) -> Result<i64> {
    let transaction = store
        .db
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    store.session(sid)?;
    let team_sources = team::merge(store, sid, &mut capture)?;
    let message_id:i64=store.db.query_row("INSERT INTO messages(session_id,role,content,created_at) VALUES(?1,'changes','',?2) RETURNING id",params![sid,storage::now()],|r|r.get(0)).map_err(|e|e.to_string())?;
    let mut saved_summary = serde_json::to_value(&capture.summary).map_err(|e| e.to_string())?;
    if !team_sources.is_empty() {
        saved_summary["teamSources"] =
            serde_json::to_value(team_sources).map_err(|e| e.to_string())?;
    }
    let summary = serde_json::to_string(&saved_summary).map_err(|e| e.to_string())?;
    let details = capture
        .details
        .into_iter()
        .map(|detail| {
            serde_json::to_string(&detail)
                .map(|data| (detail.path, data))
                .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>>>()?;
    let bytes: i64 = details.iter().map(|(_, data)| data.len() as i64).sum();
    if bytes > 8 * 1024 * 1024
        || capture.summary.files.len() > CHANGE_FILES
        || summary.len() > 2 * 1024 * 1024
    {
        return Err("Turn change snapshot exceeded its storage limit.".into());
    }
    store.db.execute("INSERT INTO turn_changes(id,session_id,message_id,summary,created_at,diff_bytes) VALUES(?1,?2,?3,?4,?5,?6)",params![capture.summary.id,sid,message_id,summary,storage::now(),bytes]).map_err(|e|e.to_string())?;
    for (path, data) in details {
        store
            .db
            .execute(
                "INSERT INTO turn_change_files(change_id,path,detail) VALUES(?1,?2,?3)",
                params![capture.summary.id, path, data],
            )
            .map_err(|e| e.to_string())?;
    }
    let mut retained: i64 = store
        .db
        .query_row(
            "SELECT COALESCE(SUM(diff_bytes),0) FROM turn_changes WHERE diff_bytes>0",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if retained > RETAINED_BYTES {
        let mut stmt = store
            .db
            .prepare(
                "SELECT id,diff_bytes FROM turn_changes WHERE diff_bytes>0 ORDER BY created_at,id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for (id, bytes) in rows {
            if retained <= RETAINED_BYTES {
                break;
            }
            store
                .db
                .execute("DELETE FROM turn_change_files WHERE change_id=?1", [&id])
                .map_err(|e| e.to_string())?;
            store
                .db
                .execute("UPDATE turn_changes SET diff_bytes=0 WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
            retained -= bytes;
        }
    }
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(message_id)
}
pub fn detail(store: &Store, sid: &str, id: &str, path: &str) -> Result<TurnChangeDiff> {
    if !safe_relative(path) || uuid::Uuid::parse_str(id).is_err() {
        return Err("Invalid turn change selection.".into());
    }
    let summary = summary(store, sid, id)?;
    let file = summary
        .files
        .iter()
        .find(|f| f.path == path)
        .ok_or("This file is not in this turn's change summary.")?;
    let stored: Option<String> = store
        .db
        .query_row(
            "SELECT detail FROM turn_change_files WHERE change_id=?1 AND path=?2",
            params![id, path],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    stored.map(|s|serde_json::from_str(&s).map_err(|e|e.to_string())).unwrap_or_else(||Ok(TurnChangeDiff{path:path.into(),old_path:file.old_path.clone(),patch:String::new(),binary:file.binary,truncated:true,error:Some("This older diff preview was removed to keep local storage bounded. Its file summary is still available.".into())}))
}
pub fn summary(store: &Store, sid: &str, id: &str) -> Result<TurnChanges> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("Invalid turn change selection.".into());
    }
    let summary: String = store
        .db
        .query_row(
            "SELECT summary FROM turn_changes WHERE id=?1 AND session_id=?2",
            params![id, sid],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("This change summary does not belong to this task.")?;
    serde_json::from_str(&summary).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn turn_change_summary(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
    change_id: String,
) -> Result<TurnChanges> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    summary(&store, &session_id, &change_id)
}
#[tauri::command]
pub async fn turn_change_diff(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
    change_id: String,
    path: String,
) -> Result<TurnChangeDiff> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    detail(&store, &session_id, &change_id, &path)
}
#[cfg(test)]
mod tests;
