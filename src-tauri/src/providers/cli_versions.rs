//! What `--version` answered for each installed CLI, shared by every discovery and saved across
//! launches in `cli-versions.json`.
//!
//! Only a background round runs probes: one round at a time, at most `PROBES_AT_ONCE`
//! processes. The blocking discovery joins that round (starting one if none runs) and waits a
//! bounded time, so two paths never probe the same binary twice. Every round announces what it
//! learned, failures and timeouts included (as ""), through the announcer (the app's
//! `provider-versions` event), with `done` once nothing more is pending.
//!
//! Freshness: an answer is trusted for `ANSWER_MAX_AGE`, then still shown while a background
//! round asks again. A shim (Volta, mise, asdf: one shared binary or an unchanging script, so the
//! build stamp cannot see an update) is kept on disk for the current day only and asked again
//! once per launch. A failure or timeout is saved and not asked again for `FAILURE_MAX_AGE`.

use super::{capture, launch};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

/// How many `--version` probes run at once, in total: all of them at once pushed more of them
/// past the timeout on a loaded machine.
pub(super) const PROBES_AT_ONCE: usize = 4;
/// The version cache's file in the app data folder.
pub(super) const CACHE_FILE: &str = "cli-versions.json";
/// An answer is asked again in the background after this many seconds.
const ANSWER_MAX_AGE: u64 = 24 * 60 * 60;
/// A failure or timeout is not asked again for this many seconds.
const FAILURE_MAX_AGE: u64 = 6 * 60 * 60;
const DAY: u64 = 24 * 60 * 60;
/// Format 1 had no timestamps or failures; its answers load as due for a background check.
const CACHE_FORMAT: u32 = 2;
/// A saved file never grows past this many binaries.
const CACHE_LIMIT: usize = 256;
/// A version answer keeps this many characters.
const VERSION_CHARS: usize = 150;
/// File stems of version-manager shims that run every tool through one binary.
const SHIM_NAMES: [&str; 4] = ["volta-shim", "mise", "asdf", "rtx"];

/// A provider id and the binary it would run (None when not installed or not probed).
pub(super) type VersionTarget = (String, Option<PathBuf>);

/// What a round learned, per provider id ("" for a failure or timeout). `done`: no round is
/// pending after this one. Serialized as the `provider-versions` payload.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub(crate) struct VersionReport {
    pub(crate) versions: BTreeMap<String, String>,
    pub(crate) done: bool,
}

/// Hears each round's report; called on a probe thread with no lock held.
pub(super) type Announce = Arc<dyn Fn(VersionReport) + Send + Sync>;

#[derive(Clone, Copy, Debug)]
pub(super) struct Timing {
    /// The first background round starts this long after the first list asked, so it is not
    /// during the first paint.
    pub(super) boot_delay: Duration,
    /// A background probe's timeout. Nothing waits on it, so slow CLIs (cline and commandcode
    /// take about 9 s when cold) get their answer in.
    pub(super) round_timeout: Duration,
    /// How long the blocking discovery waits for versions nobody knows yet.
    pub(super) blocking_wait: Duration,
}

impl Timing {
    pub(super) const LAUNCH: Self = Self {
        boot_delay: Duration::from_secs(3),
        round_timeout: Duration::from_secs(20),
        blocking_wait: Duration::from_secs(8),
    };
}

/// One build of a binary as it was found. `path` is the path as found, not resolved: Volta and
/// mise shims are symlinks to one shared binary that answers by its own name, so a key on the
/// resolved file alone gave every shimmed CLI the same version. `target`, `size` and `modified`
/// describe the resolved file, so an update changes the stamp (except for shims, see `shim`).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub(super) struct BinaryStamp {
    pub(super) path: PathBuf,
    pub(super) target: PathBuf,
    pub(super) size: u64,
    /// Nanoseconds since the Unix epoch.
    pub(super) modified: Option<u64>,
}

impl BinaryStamp {
    pub(super) fn of(path: &Path) -> Option<Self> {
        let target = std::fs::canonicalize(path).ok()?;
        let metadata = std::fs::metadata(&target).ok()?;
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|since| u64::try_from(since.as_nanos()).ok());
        Some(Self { path: path.to_owned(), target, size: metadata.len(), modified })
    }

    fn of_targets(targets: &[VersionTarget]) -> Vec<Option<Self>> {
        targets.iter().map(|(_, path)| path.as_deref().and_then(Self::of)).collect()
    }

    /// Whether an update can leave this stamp unchanged: the resolved file is a shared shim or
    /// an unchanging script, so its answers need checking once per launch.
    pub(super) fn shim(&self) -> bool {
        is_shim(&self.path, &self.target)
    }
}

/// A known shim binary (Volta, mise, asdf, rtx) or a file in an asdf or mise shims folder: one
/// file that answers for whatever version the manager selects. A plain link to a differently
/// named file (npm's link to `cli.js`, Claude's versioned binary) is not a shim: an upgrade
/// changes the resolved target's path, size or mtime, and so the cache key.
fn is_shim(path: &Path, target: &Path) -> bool {
    let stem = target.file_stem().map(|stem| stem.to_string_lossy().to_lowercase()).unwrap_or_default();
    SHIM_NAMES.contains(&stem.as_str()) || in_shims_folder(path) || in_shims_folder(target)
}

/// Whether the file sits in `.asdf/shims`, `.mise/shims` or `mise/shims` (e.g.
/// `~/.local/share/mise/shims`).
fn in_shims_folder(file: &Path) -> bool {
    let folders: Vec<_> = file
        .parent()
        .map(|folder| folder.components().map(|part| part.as_os_str().to_owned()).collect())
        .unwrap_or_default();
    folders.windows(2).any(|pair| pair[1] == "shims" && [".asdf", ".mise", "mise"].iter().any(|manager| pair[0] == *manager))
}

#[derive(Clone, Debug, Default)]
struct Answer {
    /// The last version this build answered.
    version: Option<String>,
    /// When `version` was answered, in Unix seconds.
    checked: u64,
    /// When a probe last failed or timed out since that answer, in Unix seconds.
    failed: Option<u64>,
    /// Answered (or failed) in this process.
    verified: bool,
}

enum Known {
    /// Shown as is; no probe.
    Fresh(String),
    /// Shown while a background round asks again.
    Stale(String),
    /// Never asked: shown as "" until a round answers.
    Missing,
}

impl Answer {
    fn known(&self, shim: bool, now: u64) -> Known {
        let shown = self.version.clone().unwrap_or_default();
        let age = |at: u64| now.saturating_sub(at);
        if self.failed.is_some_and(|at| age(at) < FAILURE_MAX_AGE) {
            return Known::Fresh(shown);
        }
        if self.version.is_some() && age(self.checked) < ANSWER_MAX_AGE && (self.verified || !shim) {
            Known::Fresh(shown)
        } else {
            Known::Stale(shown)
        }
    }
}

#[derive(Serialize, Deserialize)]
struct SavedVersion {
    #[serde(flatten)]
    stamp: BinaryStamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(default)]
    checked: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    failed: Option<u64>,
}

impl SavedVersion {
    /// The answer worth keeping at `now`: an expired failure is dropped, and a shim's version
    /// only lasts the day it was checked.
    fn into_answer(self, now: u64) -> Option<(BinaryStamp, Answer)> {
        if !self.stamp.path.is_absolute() || !self.stamp.target.is_absolute() {
            return None;
        }
        let checked = self.checked.min(now);
        let failed = self.failed.map(|at| at.min(now)).filter(|at| now - at < FAILURE_MAX_AGE);
        let version = self
            .version
            .filter(|version| !version.is_empty())
            .filter(|_| !self.stamp.shim() || checked / DAY == now / DAY)
            .map(|version| version.chars().take(VERSION_CHARS).collect());
        if version.is_none() && failed.is_none() {
            return None;
        }
        Some((self.stamp, Answer { version, checked, failed, verified: false }))
    }
}

#[derive(Serialize, Deserialize)]
struct SavedVersions {
    format: u32,
    versions: Vec<SavedVersion>,
}

/// The cache as it should be on disk; `sequence` orders snapshots so an older one never
/// replaces a newer file.
struct VersionSnapshot {
    sequence: u64,
    file: PathBuf,
    versions: Vec<SavedVersion>,
}

#[derive(Default)]
struct VersionState {
    answers: HashMap<BinaryStamp, Answer>,
    /// Where answers are saved; unset until `load` (tests, helpers without a data dir).
    file: Option<PathBuf>,
    /// Builds the next round asks, with the provider ids that want each.
    wanted: HashMap<BinaryStamp, BTreeSet<String>>,
    /// Builds the running round is asking, with the provider ids that want each.
    asking: HashMap<BinaryStamp, BTreeSet<String>>,
    /// A round thread is alive (single flight).
    running: bool,
    /// When a list first asked; the first round waits `boot_delay` from then.
    first_list: Option<Instant>,
    /// A blocking discovery is waiting: a round skips what is left of its boot delay.
    hurry: bool,
    /// Bumped by `forget`; a round started before it asks its builds again.
    generation: u64,
    saves: u64,
}

impl VersionState {
    fn known(&self, stamp: &BinaryStamp, now: u64) -> Known {
        self.answers.get(stamp).map_or(Known::Missing, |answer| answer.known(stamp.shim(), now))
    }

    fn shown(&self, stamp: Option<&BinaryStamp>, now: u64) -> String {
        match stamp.map(|stamp| self.known(stamp, now)) {
            Some(Known::Fresh(version) | Known::Stale(version)) => version,
            Some(Known::Missing) | None => String::new(),
        }
    }

    /// The shown version for each target; with `request`, each one not fresh is wanted by a round.
    fn versions(&mut self, current: &[VersionTarget], stamps: &[Option<BinaryStamp>], now: u64, request: bool) -> Vec<String> {
        current
            .iter()
            .zip(stamps)
            .map(|((id, _), stamp)| {
                let Some(stamp) = stamp else { return String::new() };
                let (shown, fresh) = match self.known(stamp, now) {
                    Known::Fresh(version) => (version, true),
                    Known::Stale(version) => (version, false),
                    Known::Missing => (String::new(), false),
                };
                if request && !fresh {
                    self.want(stamp, id);
                }
                shown
            })
            .collect()
    }

    fn want(&mut self, stamp: &BinaryStamp, id: &str) {
        let ids = match self.asking.get_mut(stamp) {
            Some(ids) => ids,
            None => self.wanted.entry(stamp.clone()).or_default(),
        };
        ids.insert(id.to_owned());
    }

    /// Marks a round running when one is needed and none runs; returns its start delay.
    fn start(&mut self, delay: Duration) -> Option<Duration> {
        if self.running || self.wanted.is_empty() {
            return None;
        }
        self.running = true;
        Some(delay)
    }

    fn record(&mut self, stamp: &BinaryStamp, answer: Option<String>, now: u64) {
        // An older build of the same file is never asked for again.
        self.answers.retain(|known, _| known.path != stamp.path || known == stamp);
        let entry = self.answers.entry(stamp.clone()).or_insert_with(|| Answer { checked: now, ..Answer::default() });
        match answer {
            Some(version) => {
                entry.version = Some(version);
                entry.checked = now;
                entry.failed = None;
            }
            None => entry.failed = Some(now),
        }
        entry.verified = true;
    }

    fn snapshot(&mut self) -> Option<VersionSnapshot> {
        let file = self.file.clone()?;
        self.saves += 1;
        let versions = self
            .answers
            .iter()
            .filter(|(_, answer)| answer.version.is_some() || answer.failed.is_some())
            .map(|(stamp, answer)| SavedVersion {
                stamp: stamp.clone(),
                version: answer.version.clone(),
                checked: answer.checked,
                failed: answer.failed,
            })
            .take(CACHE_LIMIT)
            .collect();
        Some(VersionSnapshot { sequence: self.saves, file, versions })
    }
}

/// What `--version` answered for each binary, shared by every discovery.
pub(super) struct VersionCache {
    /// Leaf lock: held only to read or change the state (or to wait on `changed`, which
    /// releases it), never across a probe, a file operation, an announcement or a call into
    /// another module.
    state: Mutex<VersionState>,
    /// Signalled when an answer lands, a round ends, or a blocking discovery hurries a round.
    changed: Condvar,
    /// The sequence of the last snapshot written. Leaf lock held across that one file write,
    /// taken with no other lock held.
    written: Mutex<u64>,
    announcer: OnceLock<Announce>,
    timing: Timing,
}

/// Clears `running` if a round panics, so later lists can start one.
struct RoundReset<'a>(&'a VersionCache);

impl Drop for RoundReset<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            let mut state = self.0.lock();
            state.running = false;
            state.asking.clear();
            drop(state);
            self.0.changed.notify_all();
        }
    }
}

impl VersionCache {
    pub(super) fn new(timing: Timing) -> Self {
        Self { state: Mutex::new(VersionState::default()), changed: Condvar::new(), written: Mutex::new(0), announcer: OnceLock::new(), timing }
    }

    fn lock(&self) -> MutexGuard<'_, VersionState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(all(test, unix))]
    pub(super) fn running(&self) -> bool {
        self.lock().running
    }

    /// Who hears each round's report; the first one set stays.
    pub(super) fn set_announcer(&self, announce: Announce) {
        let _ = self.announcer.set(announce);
    }

    fn announce(&self, report: VersionReport) {
        if let Some(announce) = self.announcer.get() {
            announce(report);
        }
    }

    /// Reads the saved answers (once, at startup) and saves new ones to `file` from now on.
    pub(super) fn load(&self, file: PathBuf) {
        let saved = read_saved_versions(&file, now_secs());
        let mut state = self.lock();
        state.file = Some(file);
        for (stamp, answer) in saved {
            state.answers.entry(stamp).or_insert(answer);
        }
    }

    /// Forgets every answer (Settings refresh); a round already running asks its builds again.
    pub(super) fn forget(&self) {
        let mut state = self.lock();
        state.answers.clear();
        state.generation += 1;
    }

    /// The shown version for each target, in order ("" when unknown), without waiting. With
    /// `probe`, builds that are unknown or due for a check go to a background round (started
    /// if none runs); with nothing pending, a report with `done` names the installed targets
    /// still without a version. Without `probe`, nothing is asked or announced.
    pub(super) fn versions_now(&'static self, current: &[VersionTarget], probe: bool) -> Vec<String> {
        let stamps = BinaryStamp::of_targets(current);
        let now = now_secs();
        let (versions, start, pending) = {
            let mut state = self.lock();
            let versions = state.versions(current, &stamps, now, probe);
            let start = if probe {
                let first = *state.first_list.get_or_insert_with(Instant::now);
                state.start(self.timing.boot_delay.saturating_sub(first.elapsed()))
            } else {
                None
            };
            (versions, start, state.running)
        };
        if let Some(delay) = start {
            self.spawn_round(delay);
        }
        if probe && !pending {
            let unresolved: BTreeMap<String, String> = current
                .iter()
                .zip(&versions)
                .filter(|((_, path), version)| path.is_some() && version.is_empty())
                .map(|((id, _), _)| (id.clone(), String::new()))
                .collect();
            if !unresolved.is_empty() {
                self.announce(VersionReport { versions: unresolved, done: true });
            }
        }
        versions
    }

    /// Joins the background round (starting one if none runs) and waits up to
    /// `blocking_wait` for builds nobody has asked yet; builds due for a check are shown as
    /// they are while the round asks. What the round learns is announced as usual.
    pub(super) fn versions_blocking(&'static self, current: &[VersionTarget]) -> Vec<String> {
        let stamps = BinaryStamp::of_targets(current);
        let now = now_secs();
        let (missing, start) = {
            let mut state = self.lock();
            let missing: Vec<BinaryStamp> = stamps.iter().flatten().filter(|stamp| matches!(state.known(stamp, now), Known::Missing)).cloned().collect();
            state.versions(current, &stamps, now, true);
            let delay = if missing.is_empty() { self.timing.boot_delay } else { Duration::ZERO };
            if !missing.is_empty() {
                state.hurry = true;
            }
            (missing, state.start(delay))
        };
        if !missing.is_empty() {
            self.changed.notify_all();
        }
        if let Some(delay) = start {
            self.spawn_round(delay);
        }
        let state = self.lock();
        let (state, _) = self
            .changed
            .wait_timeout_while(state, self.timing.blocking_wait, |state| {
                state.running && missing.iter().any(|stamp| !state.answers.contains_key(stamp))
            })
            .unwrap_or_else(PoisonError::into_inner);
        let now = now_secs();
        stamps.iter().map(|stamp| state.shown(stamp.as_ref(), now)).collect()
    }

    fn spawn_round(&'static self, delay: Duration) {
        let spawned = std::thread::Builder::new().name("cli-versions".into()).spawn(move || self.run_rounds(delay));
        if let Err(error) = spawned {
            eprintln!("PandaCode: could not start the CLI version probe: {error}");
            self.lock().running = false;
            self.changed.notify_all();
        }
    }

    fn run_rounds(&self, delay: Duration) {
        let _reset = RoundReset(self);
        {
            let state = self.lock();
            let (mut state, _) = self.changed.wait_timeout_while(state, delay, |state| !state.hurry).unwrap_or_else(PoisonError::into_inner);
            state.hurry = false;
        }
        loop {
            let report = self.round();
            let done = report.done;
            if !report.versions.is_empty() || done {
                self.announce(report);
            }
            if done {
                return;
            }
        }
    }

    /// Asks every wanted build, at most `PROBES_AT_ONCE` at a time and each once, remembers
    /// and saves the answers, and reports them per provider id. Answers land one by one, so a
    /// blocking discovery can return before the round ends. `done` (and `running` cleared)
    /// when nothing more is wanted.
    fn round(&self) -> VersionReport {
        let (generation, batch) = {
            let mut state = self.lock();
            let wanted = std::mem::take(&mut state.wanted);
            let batch: Vec<BinaryStamp> = wanted.keys().cloned().collect();
            state.asking = wanted;
            if batch.is_empty() {
                state.running = false;
                drop(state);
                self.changed.notify_all();
                return VersionReport { versions: BTreeMap::new(), done: true };
            }
            (state.generation, batch)
        };
        let timeout = self.timing.round_timeout;
        let answers = probe_limited(&batch, PROBES_AT_ONCE, |stamp| {
            let answer = version(&stamp.path, timeout);
            let mut state = self.lock();
            if state.generation == generation {
                state.record(stamp, answer.clone(), now_secs());
            }
            drop(state);
            self.changed.notify_all();
            answer
        });
        let (report, snapshot) = {
            let mut state = self.lock();
            let asking = std::mem::take(&mut state.asking);
            let mut versions = BTreeMap::new();
            let snapshot = if state.generation == generation {
                let now = now_secs();
                for (stamp, answer) in batch.iter().zip(&answers) {
                    // A probe that panicked recorded nothing: it counts as a failure.
                    if !state.answers.get(stamp).is_some_and(|known| known.verified) {
                        state.record(stamp, None, now);
                    }
                    for id in asking.get(stamp).into_iter().flatten() {
                        versions.insert(id.clone(), answer.clone().unwrap_or_default());
                    }
                }
                state.snapshot()
            } else {
                // `forget` ran meanwhile: these answers may be stale, so ask again.
                for (stamp, ids) in asking {
                    state.wanted.entry(stamp).or_default().extend(ids);
                }
                None
            };
            let done = state.wanted.is_empty();
            if done {
                state.running = false;
            }
            (VersionReport { versions, done }, snapshot)
        };
        self.changed.notify_all();
        if let Some(snapshot) = snapshot {
            self.save(snapshot);
        }
        report
    }

    fn save(&self, snapshot: VersionSnapshot) {
        let mut written = self.written.lock().unwrap_or_else(PoisonError::into_inner);
        if *written >= snapshot.sequence {
            return;
        }
        let saved = SavedVersions { format: CACHE_FORMAT, versions: snapshot.versions };
        match serde_json::to_vec(&saved).map_err(|error| error.to_string()).and_then(|bytes| write_atomically(&snapshot.file, &bytes)) {
            Ok(()) => *written = snapshot.sequence,
            Err(error) => eprintln!("PandaCode: could not save CLI versions to {}: {error}", snapshot.file.display()),
        }
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_secs())
}

/// Saved answers still worth keeping; a missing, unreadable or foreign file is empty.
fn read_saved_versions(file: &Path, now: u64) -> Vec<(BinaryStamp, Answer)> {
    let bytes = match std::fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            eprintln!("PandaCode: could not read saved CLI versions: {error}");
            return Vec::new();
        }
    };
    let saved: SavedVersions = match serde_json::from_slice(&bytes) {
        Ok(saved) => saved,
        Err(error) => {
            eprintln!("PandaCode: ignoring unreadable saved CLI versions: {error}");
            return Vec::new();
        }
    };
    if !(1..=CACHE_FORMAT).contains(&saved.format) {
        return Vec::new();
    }
    saved.versions.into_iter().filter_map(|entry| entry.into_answer(now)).take(CACHE_LIMIT).collect()
}

/// Writes `bytes` to a temporary file beside `file` and renames it over `file`, so a reader
/// never sees half a file.
fn write_atomically(file: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = file.file_name().ok_or("The version cache has no file name.")?.to_string_lossy();
    let temporary = file.with_file_name(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let written = std::fs::write(&temporary, bytes).and_then(|()| std::fs::rename(&temporary, file));
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written.map_err(|error| error.to_string())
}

/// Runs `probe` on every item, at most `limit` at a time, and returns the answers in item order.
/// Workers take the next item from a shared counter, so one slow probe holds a single slot.
fn probe_limited<T: Sync>(items: &[T], limit: usize, probe: impl Fn(&T) -> Option<String> + Sync) -> Vec<Option<String>> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let mut found: Vec<Option<String>> = vec![None; items.len()];
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..limit.max(1).min(items.len()))
            .map(|_| {
                scope.spawn(|| {
                    let mut answers = Vec::new();
                    loop {
                        let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some(item) = items.get(index) else { break };
                        answers.push((index, probe(item)));
                    }
                    answers
                })
            })
            .collect();
        // A worker that panicked reports no version for what it had answered, like a failed probe;
        // the others keep taking items, so nothing is left unprobed but its own item.
        for worker in workers {
            for (index, answer) in worker.join().unwrap_or_default() {
                found[index] = answer;
            }
        }
    });
    found
}

/// What `path --version` printed (first `VERSION_CHARS` characters); None when it failed,
/// printed nothing or ran past `timeout`. The Antigravity `agy` CLI is told not to update itself
/// while it answers.
pub(super) fn version(path: &Path, timeout: Duration) -> Option<String> {
    let mut command = launch::std_command(path).ok()?;
    if super::acp::is_agy_cli(path) {
        command.env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    }
    capture(command, &["--version"], timeout)
        .filter(|text| !text.is_empty())
        .map(|text| text.chars().take(VERSION_CHARS).collect())
}

static VERSIONS: std::sync::LazyLock<VersionCache> = std::sync::LazyLock::new(|| VersionCache::new(Timing::LAUNCH));

/// The cache every discovery shares.
pub(super) fn shared() -> &'static VersionCache {
    &VERSIONS
}

#[cfg(test)]
#[path = "cli_versions_tests.rs"]
mod tests;
