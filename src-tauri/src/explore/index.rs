//! In-process trigram index per checkout root. Every query stat-walks the tree first and
//! re-indexes whatever changed, so an edit is visible to the next query. Files are always read
//! from disk to verify a hit: the index only says which files may hold one.
use super::{
    limit::Limit,
    plan::{fold_trigrams, Plan},
};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex, OnceLock, RwLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// Under these a scan takes about 100 ms and an index would save little for at least 14 MiB a
/// root (measured with `explore_bench`: 1,400 files scan in 25 ms, 20,000 in 500 ms).
pub(super) const INDEX_MIN_FILES: usize = 4_000;
pub(super) const INDEX_MIN_BYTES: u64 = 64 * 1024 * 1024;
/// Consistent with text_search; past either one a query scans and stores nothing.
const MAX_INDEX_FILES: usize = 100_000;
const MAX_INDEX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_POSTING_BYTES: usize = 256 * 1024 * 1024;
const MAX_WALK_ENTRIES: usize = 500_000;
const WALK_LIMIT_CHECK: usize = 1_024;
// Parallel tests must not evict one another's roots.
const MAX_ROOTS: usize = if cfg!(test) { 1_000 } else { 3 };
/// A root no query has touched for this long gives its memory back.
const IDLE_ROOT: Duration = Duration::from_secs(600);
const SWEEP_EVERY: Duration = Duration::from_secs(60);
/// Paths named per skip reason in a reply.
const SKIPS_NAMED: usize = 20;
/// A file written within this long before it was read could change again with the same stamp.
const RACY_NS: i128 = 2_000_000_000;
const TRIGRAM_SPACE: usize = 1 << 21;
const NO_SLOT: u32 = u32::MAX;

#[derive(Clone, Copy, PartialEq, Debug)]
struct Fingerprint {
    size: u64,
    mtime: i128,
    ctime: i128,
    inode: u64,
}

fn nanos(time: std::io::Result<SystemTime>) -> i128 {
    time.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as i128)
}

fn fingerprint_of(metadata: &std::fs::Metadata) -> Fingerprint {
    #[cfg(unix)]
    let (ctime, inode) = {
        use std::os::unix::fs::MetadataExt;
        (metadata.ctime() as i128 * 1_000_000_000 + metadata.ctime_nsec() as i128, metadata.ino())
    };
    #[cfg(not(unix))]
    let (ctime, inode) = (0, 0);
    Fingerprint { size: metadata.len(), mtime: nanos(metadata.modified()), ctime, inode }
}

pub(super) struct WalkedFile {
    pub(super) path: Arc<str>,
    fingerprint: Fingerprint,
}

/// How many paths were skipped for one reason, and the first few of them.
#[derive(Default)]
pub(super) struct SkipList {
    pub(super) count: usize,
    pub(super) first: Vec<String>,
}

impl SkipList {
    pub(super) fn add(&mut self, path: &str) {
        self.count += 1;
        if self.first.len() < SKIPS_NAMED {
            self.first.push(path.to_owned());
        }
    }
}

#[derive(Default)]
pub(super) struct Walk {
    pub(super) files: Vec<WalkedFile>,
    pub(super) secret: SkipList,
    pub(super) large: SkipList,
    pub(super) excluded: SkipList,
    pub(super) incomplete: bool,
    /// Walked by Plan mode's rule, which file reads apply again.
    pub(super) strict: bool,
}

impl Walk {
    fn bytes(&self) -> u64 {
        self.files.iter().map(|f| f.fingerprint.size).sum()
    }
}

/// A skipped folder counts once, with a `/` so its name says it stands for all it holds.
fn note(list: &Mutex<SkipList>, root: &Path, path: &Path, directory: bool) {
    let mut relative = relative(root, path).unwrap_or_else(|| path.to_string_lossy().into_owned());
    if directory {
        relative.push('/');
    }
    list.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).add(&relative);
}

/// Whether the walk goes into an entry; what it leaves out is noted by reason.
fn admit(root: &Path, entry: &ignore::DirEntry, strict: bool, secret: &Mutex<SkipList>, excluded: &Mutex<SkipList>) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    let directory = entry.file_type().is_some_and(|t| t.is_dir());
    let name = entry.file_name().to_string_lossy();
    if name == ".git" {
        return false;
    }
    if crate::workspace::excluded_entry(&name, directory) {
        note(excluded, root, entry.path(), directory);
        return false;
    }
    let refused = if directory {
        crate::workspace::refused_entry(&name, true, strict)
    } else {
        // A file's folders matter too: a non-source file inside `secrets/` is refused.
        relative(root, entry.path()).is_none_or(|path| crate::workspace::secret_path(&path, strict))
    };
    if refused {
        note(secret, root, entry.path(), directory);
        return false;
    }
    true
}

#[cfg(test)]
thread_local! {
    /// Lets a test reach the walk's entry cap without half a million files.
    pub(super) static WALK_CAP: std::cell::Cell<usize> = const { std::cell::Cell::new(MAX_WALK_ENTRIES) };
}

#[cfg(test)]
fn walk_cap() -> usize {
    WALK_CAP.with(std::cell::Cell::get)
}

#[cfg(not(test))]
fn walk_cap() -> usize {
    MAX_WALK_ENTRIES
}

/// The set of files a search may read: gitignore-aware, no symlinks, no credential names.
pub(super) fn walk(root: &Path, strict: bool, limit: &Limit) -> Walk {
    let (secret, excluded) = (Arc::new(Mutex::new(SkipList::default())), Arc::new(Mutex::new(SkipList::default())));
    let large = Mutex::new(SkipList::default());
    let (entries, stopped) = (AtomicUsize::new(0), AtomicBool::new(false));
    let (filter_root, filter_secret, filter_excluded) = (root.to_owned(), secret.clone(), excluded.clone());
    let walker = crate::workspace::project_walker(root).threads(worker_count()).filter_entry(move |entry| admit(&filter_root, entry, strict, &filter_secret, &filter_excluded)).build_parallel();
    let (sender, receiver) = mpsc::channel();
    let cap = walk_cap();
    walker.run(|| {
        let (sender, entries, large, stopped) = (sender.clone(), &entries, &large, &stopped);
        Box::new(move |entry| {
            use ignore::WalkState;
            let seen = entries.fetch_add(1, Ordering::Relaxed);
            if seen >= cap || (seen.is_multiple_of(WALK_LIMIT_CHECK) && limit.expired()) {
                limit.cut();
                stopped.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            let Ok(entry) = entry else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            let Ok(metadata) = entry.metadata() else { return WalkState::Continue };
            if metadata.len() > crate::workspace::MAX_READ_BYTES {
                note(large, root, entry.path(), false);
                return WalkState::Continue;
            }
            let _ = sender.send((entry.into_path(), fingerprint_of(&metadata)));
            WalkState::Continue
        })
    });
    drop(sender);
    let mut files: Vec<WalkedFile> = receiver.into_iter().filter_map(|(path, fingerprint)| Some(WalkedFile { path: relative(root, &path)?.into(), fingerprint })).collect();
    files.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    let take = |list: &Mutex<SkipList>| std::mem::take(&mut *list.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
    Walk { files, secret: take(&secret), large: take(&large), excluded: take(&excluded), incomplete: stopped.load(Ordering::Relaxed), strict }
}

/// Paths that are not valid Unicode could not be named back by the agent, so they are skipped.
fn relative(root: &Path, path: &Path) -> Option<String> {
    let text = path.strip_prefix(root).ok()?.to_str()?;
    #[cfg(windows)]
    return Some(text.replace('\\', "/"));
    #[cfg(not(windows))]
    Some(text.to_owned())
}

pub(super) fn worker_count() -> usize {
    std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(2, 12)
}

/// Runs `work` for each index on a bounded set of threads; results arrive in no fixed order.
pub(super) fn parallel<R: Send>(count: usize, work: impl Fn(usize) -> Option<R> + Sync) -> Vec<R> {
    let cursor = AtomicUsize::new(0);
    let drain = || {
        let next = || Some(cursor.fetch_add(1, Ordering::Relaxed)).filter(|&at| at < count);
        std::iter::from_fn(next).filter_map(&work).collect::<Vec<R>>()
    };
    std::thread::scope(|scope| {
        let threads: Vec<_> = (0..worker_count().min(count)).map(|_| scope.spawn(drain)).collect();
        // A panic reaches the caller as an error: its results must not simply go missing.
        threads.into_iter().flat_map(|thread| thread.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic))).collect()
    })
}

#[derive(Default)]
struct Posting {
    bytes: Vec<u8>,
    last: u32,
}

impl Posting {
    /// Ids only ever grow, so a posting is a varint delta list.
    fn push(&mut self, id: u32) {
        let mut delta = id - self.last;
        while delta >= 0x80 {
            self.bytes.push(delta as u8 | 0x80);
            delta >>= 7;
        }
        self.bytes.push(delta as u8);
        self.last = id;
    }

    fn ids(&self) -> Vec<u32> {
        let mut ids = Vec::with_capacity(self.bytes.len());
        let (mut current, mut delta, mut shift) = (0u32, 0u32, 0u32);
        for &byte in &self.bytes {
            delta |= ((byte & 0x7F) as u32) << shift;
            shift += 7;
            if byte < 0x80 {
                current += delta;
                ids.push(current);
                (delta, shift) = (0, 0);
            }
        }
        ids
    }
}

struct Known {
    fingerprint: Fingerprint,
    read_at: i128,
    id: Option<u32>,
}

#[derive(Default)]
struct Table {
    known: HashMap<Arc<str>, Known>,
    paths: Vec<Option<Arc<str>>>,
    /// Trigram to its slot in `postings`; allocated by the first build.
    slots: Vec<u32>,
    postings: Vec<Posting>,
    posting_bytes: usize,
    dead: usize,
    oversize: bool,
    /// Tests lower this to reach the ceiling.
    posting_limit: Option<usize>,
}

impl Table {
    fn forget(&mut self, path: &str) {
        if let Some(id) = self.known.remove(path).and_then(|known| known.id) {
            self.paths[id as usize] = None;
            self.dead += 1;
        }
    }

    fn add(&mut self, path: Arc<str>, fingerprint: Fingerprint, read_at: i128, trigrams: Option<Vec<u32>>) {
        self.forget(&path);
        let id = trigrams.map(|trigrams| {
            let id = self.paths.len() as u32;
            self.paths.push(Some(path.clone()));
            trigrams.into_iter().for_each(|t| self.post(t, id));
            id
        });
        self.known.insert(path, Known { fingerprint, read_at, id });
    }

    fn post(&mut self, trigram: u32, id: u32) {
        if self.slots.is_empty() {
            self.slots = vec![NO_SLOT; TRIGRAM_SPACE];
        }
        let slot = &mut self.slots[trigram as usize];
        if *slot == NO_SLOT {
            *slot = self.postings.len() as u32;
            self.postings.push(Posting::default());
        }
        let posting = &mut self.postings[*slot as usize];
        let before = posting.bytes.len();
        posting.push(id);
        self.posting_bytes += posting.bytes.len() - before;
    }

    /// Drops dead ids from every posting once they pile up from repeated edits.
    fn compact(&mut self) {
        if self.dead < 1024 || self.dead * 4 < self.known.len() {
            return;
        }
        let paths = &self.paths;
        let mut total = 0;
        for posting in &mut self.postings {
            let mut fresh = Posting::default();
            posting.ids().into_iter().filter(|&id| paths[id as usize].is_some()).for_each(|id| fresh.push(id));
            fresh.bytes.shrink_to_fit();
            total += fresh.bytes.len();
            *posting = fresh;
        }
        self.posting_bytes = total;
        self.dead = 0;
    }

    fn eval(&self, plan: &Plan) -> Option<Vec<u32>> {
        match plan {
            Plan::Everything => None,
            Plan::Trigram(trigram) => Some(match self.slots.get(*trigram as usize) {
                Some(&slot) if slot != NO_SLOT => self.postings[slot as usize].ids(),
                _ => Vec::new(),
            }),
            Plan::All(parts) => parts.iter().filter_map(|part| self.eval(part)).reduce(|a, b| intersect(&a, &b)),
            Plan::Any(parts) => {
                let lists: Option<Vec<Vec<u32>>> = parts.iter().map(|part| self.eval(part)).collect();
                let mut all: Vec<u32> = lists?.into_iter().flatten().collect();
                all.sort_unstable();
                all.dedup();
                Some(all)
            }
        }
    }

    fn over_ceiling(&self) -> bool {
        self.posting_bytes > self.posting_limit.unwrap_or(MAX_POSTING_BYTES)
    }

    #[cfg(test)]
    fn memory_bytes(&self) -> usize {
        let paths: usize = self.known.keys().map(|path| path.len() + 80).sum();
        self.posting_bytes + self.postings.len() * std::mem::size_of::<Posting>() + self.slots.len() * 4 + self.paths.len() * 16 + paths
    }
}

fn intersect(a: &[u32], b: &[u32]) -> Vec<u32> {
    let (mut i, mut j, mut out) = (0, 0, Vec::with_capacity(a.len().min(b.len())));
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                out.push(a[i]);
                i += 1;
                j += 1;
            }
        }
    }
    out
}

// ponytail: the index lives in memory only and is rebuilt per process; persist it if a cold
// build at the file cap starts to hurt. Measured per root (cold build, table, process RSS growth):
// 20,000 files (vscode) 0.7 s, 44 MiB, 65 MiB; 97,000 files (Linux, 2.1 GiB on disk) 4.6 s,
// 164 MiB, 199 MiB. Ceiling: MAX_ROOTS tables of MAX_POSTING_BYTES postings plus 8 MiB of slots
// and the file table; past it a root empties its table and scans. Idle roots go after IDLE_ROOT.
#[derive(Default)]
struct Store {
    /// One refresh at a time; a query that finds it held scans instead of waiting.
    refreshing: Mutex<()>,
    table: RwLock<Table>,
}

/// One table per root, shared by both secret rules: each query keeps only what its own walk
/// saw (`Snapshot::candidates`), and the strict walk is a subset of the plain one.
struct Stored {
    root: PathBuf,
    used: Instant,
    store: Arc<Store>,
}

fn stores() -> std::sync::MutexGuard<'static, Vec<Stored>> {
    static STORES: OnceLock<Mutex<Vec<Stored>>> = OnceLock::new();
    STORES.get_or_init(Default::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn store_for(root: &Path) -> Arc<Store> {
    let mut stores = stores();
    let store = match stores.iter().position(|stored| stored.root == root) {
        Some(at) => stores.remove(at).store,
        None => Arc::default(),
    };
    stores.insert(0, Stored { root: root.to_owned(), used: Instant::now(), store: store.clone() });
    stores.truncate(MAX_ROOTS);
    drop(stores);
    start_sweeper();
    store
}

fn drop_idle(stores: &mut Vec<Stored>, now: Instant) {
    stores.retain(|stored| now.duration_since(stored.used) < IDLE_ROOT);
}

/// One thread gives idle roots back; it ends when none are left, and the next store starts it.
fn start_sweeper() {
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(SWEEP_EVERY);
        let mut stores = stores();
        drop_idle(&mut stores, Instant::now());
        if stores.is_empty() {
            RUNNING.store(false, Ordering::SeqCst);
            return;
        }
    });
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum Policy {
    Auto,
    #[cfg_attr(not(test), allow(dead_code))]
    AlwaysIndex,
    #[cfg_attr(not(test), allow(dead_code))]
    NeverIndex,
}

/// A fresh file list plus, when the repo is worth it and free to refresh, its index.
pub(super) struct Snapshot {
    pub(super) walk: Walk,
    store: Option<Arc<Store>>,
}

impl Snapshot {
    pub(super) fn open(root: &Path, policy: Policy, strict: bool, limit: &Limit) -> Self {
        let walk = walk(root, strict, limit);
        let store = indexable(&walk, policy).then(|| store_for(root)).filter(|store| refresh(root, store, &walk, limit));
        Self { walk, store }
    }

    pub(super) fn indexed(&self) -> bool {
        self.store.is_some()
    }

    /// Files that may match `plan`; None means every file. Newer files are seen as well, and
    /// a file that has since gone is simply skipped by the reader. A table another query has
    /// since given up on says nothing, which must not read as "no candidates".
    pub(super) fn candidates(&self, plan: &Plan) -> Option<Vec<Arc<str>>> {
        let store = self.store.as_ref()?;
        let table = store.table.read().ok()?;
        if table.oversize {
            return None;
        }
        let ids = table.eval(plan)?;
        // Only what this query's walk saw: another query may have indexed a file this rule hides,
        // or one gitignored since.
        let mut found: Vec<Arc<str>> = ids.into_iter().filter_map(|id| table.paths[id as usize].clone()).filter(|path| self.walked(path)).collect();
        // And all it saw that the table lacks or holds older: a query that walked earlier but
        // refreshed later may have forgotten it.
        found.extend(self.walk.files.iter().filter(|file| table.known.get(&file.path).is_none_or(|known| known.fingerprint != file.fingerprint)).map(|file| file.path.clone()));
        found.sort_unstable();
        found.dedup();
        Some(found)
    }

    fn walked(&self, path: &str) -> bool {
        self.walk.files.binary_search_by(|file| (*file.path).cmp(path)).is_ok()
    }

    /// Indexed files this query's walk saw that turned out to be binary or unreadable.
    pub(super) fn binary(&self) -> SkipList {
        let mut list = SkipList::default();
        let Some(table) = self.store.as_ref().and_then(|store| store.table.read().ok()) else { return list };
        let mut paths: Vec<&Arc<str>> = table.known.iter().filter(|(path, known)| known.id.is_none() && self.walked(path)).map(|(path, _)| path).collect();
        paths.sort_unstable();
        paths.into_iter().for_each(|path| list.add(path));
        list
    }

    #[cfg(test)]
    pub(super) fn memory_bytes(&self) -> usize {
        self.store.as_ref().and_then(|store| store.table.read().ok().map(|t| t.memory_bytes())).unwrap_or(0)
    }

    #[cfg(test)]
    pub(super) fn index_shape(&self) -> (usize, usize) {
        let table = self.store.as_ref().map(|store| store.table.read().unwrap());
        table.map_or((0, 0), |t| (t.paths.iter().flatten().count(), t.postings.len()))
    }
}

fn indexable(walk: &Walk, policy: Policy) -> bool {
    let (count, bytes) = (walk.files.len(), walk.bytes());
    match policy {
        Policy::NeverIndex => false,
        _ if walk.incomplete || count > MAX_INDEX_FILES || bytes > MAX_INDEX_BYTES => false,
        Policy::AlwaysIndex => true,
        Policy::Auto => count >= INDEX_MIN_FILES || bytes >= INDEX_MIN_BYTES,
    }
}

/// Brings the table up to this walk. False when another query holds it or it is over its caps.
fn refresh(root: &Path, store: &Store, walk: &Walk, limit: &Limit) -> bool {
    let Ok(_held) = store.refreshing.try_lock() else { return false };
    // A file only the plain walk sees is forgotten by a strict refresh and read again by the next
    // plain one; `candidates` keeps each query to its own walk either way.
    let Some((changed, removed)) = delta(store, walk) else { return false };
    refresh_now(root, store, walk, &changed, &removed, limit)
}

fn refresh_now(root: &Path, store: &Store, walk: &Walk, changed: &[usize], removed: &[Arc<str>], limit: &Limit) -> bool {
    let Ok(mut table) = store.table.write() else { return false };
    removed.iter().for_each(|path| table.forget(path));
    drop(table);
    let merged = merge_changes(root, store, walk, changed, limit);
    let Ok(mut table) = store.table.write() else { return false };
    if table.oversize {
        // Keeps the marker and the test ceiling, frees the rest.
        *table = Table { oversize: true, posting_limit: table.posting_limit, ..Table::default() };
        return false;
    }
    table.compact();
    merged
}

/// Indices of walked files to (re)read, and paths no longer present.
fn delta(store: &Store, walk: &Walk) -> Option<(Vec<usize>, Vec<Arc<str>>)> {
    let table = store.table.read().ok()?;
    if table.oversize {
        return None;
    }
    let settled = |file: &WalkedFile, known: &Known| known.fingerprint == file.fingerprint && file.fingerprint.mtime + RACY_NS < known.read_at;
    let changed = (0..walk.files.len())
        .filter(|&at| !table.known.get(&walk.files[at].path).is_some_and(|known| settled(&walk.files[at], known)))
        .collect();
    let walked: HashSet<&str> = walk.files.iter().map(|f| &*f.path).collect();
    let removed = table.known.keys().filter(|path| !walked.contains(&***path)).cloned().collect();
    Some((changed, removed))
}

/// A walked file's position, when it was read, and its trigrams.
type ReadFile = (usize, i128, Option<Vec<u32>>);

/// The files to read and split, shared by the worker threads.
struct Readers<'a> {
    root: &'a Path,
    walk: &'a Walk,
    changed: &'a [usize],
    cursor: AtomicUsize,
    quit: AtomicBool,
    limit: &'a Limit,
}

impl Readers<'_> {
    fn next(&self) -> Option<usize> {
        let at = self.cursor.fetch_add(1, Ordering::Relaxed);
        (at < self.changed.len() && !self.quit.load(Ordering::Relaxed) && !self.limit.expired()).then(|| self.changed[at])
    }

    fn read_until_done(&self, sender: mpsc::SyncSender<ReadFile>) {
        let mut seen = vec![0u64; TRIGRAM_SPACE / 64];
        while let Some(at) = self.next() {
            let read_at = nanos(Ok(SystemTime::now()));
            let trigrams = read_trigrams(self.root, &self.walk.files[at].path, &mut seen);
            if sender.send((at, read_at, trigrams)).is_err() {
                return;
            }
        }
    }
}

/// Adds what the readers send to the table, one file at a time. False at the memory ceiling.
fn merge_into_table(store: &Store, walk: &Walk, received: mpsc::Receiver<ReadFile>) -> bool {
    for (at, read_at, trigrams) in received {
        let file = &walk.files[at];
        let Ok(mut table) = store.table.write() else { return false };
        table.add(file.path.clone(), file.fingerprint, read_at, trigrams);
        if table.over_ceiling() {
            table.oversize = true;
            return false;
        }
    }
    true
}

/// Workers read and split files with no lock held; this thread merges them one at a time, so
/// the table never holds more than the postings themselves.
fn merge_changes(root: &Path, store: &Store, walk: &Walk, changed: &[usize], limit: &Limit) -> bool {
    let readers = Readers { root, walk, changed, cursor: AtomicUsize::new(0), quit: AtomicBool::new(false), limit };
    let (sender, receiver) = mpsc::sync_channel::<ReadFile>(worker_count() * 4);
    std::thread::scope(|scope| {
        for _ in 0..worker_count().min(changed.len()) {
            let (readers, sender) = (&readers, sender.clone());
            scope.spawn(move || readers.read_until_done(sender));
        }
        drop(sender);
        let merged = merge_into_table(store, walk, receiver);
        readers.quit.store(true, Ordering::Relaxed);
        // A refresh cut short leaves a sound table that lacks files, so this query scans.
        merged && !limit.was_cut()
    })
}

/// A file's distinct trigrams, or None when it is binary or unreadable (and so never a hit).
fn read_trigrams(root: &Path, path: &str, seen: &mut [u64]) -> Option<Vec<u32>> {
    // The table is shared by both rules, so the plain one applies here; each query keeps to
    // its own walk.
    let bytes = super::read_file(root, &root.join(path), crate::workspace::MAX_READ_BYTES, false)?;
    if bytes.contains(&0) {
        return None;
    }
    let mut trigrams = Vec::new();
    fold_trigrams(&bytes, |trigram| {
        let (word, bit) = (trigram as usize / 64, 1u64 << (trigram % 64));
        if seen[word] & bit == 0 {
            seen[word] |= bit;
            trigrams.push(trigram);
        }
    });
    for &trigram in &trigrams {
        seen[trigram as usize / 64] = 0;
    }
    Some(trigrams)
}

#[cfg(test)]
#[path = "index_tests.rs"]
mod tests;
