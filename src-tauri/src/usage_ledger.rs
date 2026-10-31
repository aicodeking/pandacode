//! Estimated API cost from the agents' own local session logs (Claude Code
//! project logs and Codex rollouts). Files are read only when Agent usage is
//! opened; token counts are cached per file so later opens only read what was
//! appended. Nothing leaves the machine except the public price-list request.
//!
//! The parsed cache is saved at most once a minute and dropped from memory after
//! ten idle minutes (reloaded from its file on demand). It is derived from the logs
//! alone: a change not yet saved at quit is simply read again from the saved
//! offsets at the next scan, so no exit hook is needed.

mod parse;
mod pricing;
#[cfg(test)]
mod tests;

use parse::{CodexState, Record};
pub(crate) use parse::unix_seconds;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};
use tauri::Manager;

const HISTORY_DAYS: i64 = 366;
const RESULT_TTL_MS: i64 = 60_000;
const CACHE_VERSION: u32 = 1;
/// Cache saves are coalesced to at most one per this interval.
const SAVE_EVERY_MS: i64 = 60_000;
/// An unused cache is dropped from memory after this long.
const IDLE_DROP_MS: i64 = 600_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Agent {
    Claude,
    Codex,
}

/// Parsed token counts for one log file, with where to resume once it grows.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct FileEntry {
    agent: Option<Agent>,
    length: u64,
    modified: i64,
    offset: u64,
    session: bool,
    #[serde(default)]
    codex: CodexState,
    records: Vec<Record>,
}

#[derive(Default, Serialize, Deserialize)]
struct Cache {
    version: u32,
    files: HashMap<String, FileEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelInfo {
    provider: Agent,
    name: String,
    priced: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionSpan {
    provider: Agent,
    first: i64,
    last: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceInfo {
    provider: Agent,
    files: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pricing {
    source: pricing::Source,
    fetched_at: Option<i64>,
}

/// `[unixHour, modelIndex, input, cacheRead, cacheWrite, output, costUsd, savingsUsd]`
type Row = (i64, usize, u64, u64, u64, u64, f64, f64);
/// Token and dollar sums for one hour of one model.
type Sums = (u64, u64, u64, u64, f64, f64);

/// Rows are `[unixHour, modelIndex, input, cacheRead, cacheWrite, output, costUsd, savingsUsd]`;
/// the UI groups hours into local calendar days.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ledger {
    scanned_at: i64,
    pricing: Pricing,
    sources: Vec<SourceInfo>,
    models: Vec<ModelInfo>,
    rows: Vec<Row>,
    sessions: Vec<SessionSpan>,
}

/// Claude Code `projects` folders across every configuration location.
pub(crate) fn claude_roots() -> Vec<PathBuf> {
    roots(Agent::Claude)
}

/// Log roots per agent, in scan order.
type Roots = Vec<(Agent, Vec<PathBuf>)>;

fn agent_roots() -> Roots {
    [Agent::Claude, Agent::Codex].into_iter().map(|agent| (agent, roots(agent))).collect()
}

fn roots(agent: Agent) -> Vec<PathBuf> {
    let home = crate::agent_usage_providers::home();
    let mut roots: Vec<PathBuf> = match agent {
        Agent::Claude => {
            let mut dirs: Vec<PathBuf> = crate::agent_usage::claude_config_dir().into_iter().collect();
            dirs.extend(home.map(|home| home.join(".config").join("claude")));
            dirs.into_iter().map(|dir| dir.join("projects")).collect()
        }
        Agent::Codex => {
            let base = std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .or_else(|| home.map(|home| home.join(".codex")));
            base.into_iter().flat_map(|base| [base.join("sessions"), base.join("archived_sessions")]).collect()
        }
    };
    roots.dedup();
    roots
}

fn modified_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// `.jsonl` files changed within the history window whose path passes `keep`, without
/// following links. Names are filtered before the stat, so a narrow `keep` stays cheap.
fn log_files(root: &Path, since_ms: i64, keep: &dyn Fn(&Path) -> bool, output: &mut Vec<(PathBuf, std::fs::Metadata)>) {
    let mut pending = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() && depth < 8 {
                pending.push((path, depth + 1));
            } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") && keep(&path) {
                if let Ok(metadata) = entry.metadata() {
                    if modified_ms(&metadata) >= since_ms {
                        output.push((path, metadata));
                    }
                }
            }
        }
    }
}

/// Reads complete lines from `entry.offset`, so an appended log resumes where it
/// stopped and a line still being written is read next time.
fn read_file(path: &Path, agent: Agent, entry: &mut FileEntry) -> std::io::Result<()> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(entry.offset))?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 || line.last() != Some(&b'\n') {
            break;
        }
        entry.offset += read as u64;
        let Ok(text) = std::str::from_utf8(&line) else { continue };
        match agent {
            Agent::Claude => entry.records.extend(parse::claude_line(text)),
            Agent::Codex => {
                if let Some(record) = parse::codex_line(text, &mut entry.codex) {
                    parse::merge_hourly(&mut entry.records, record);
                }
            }
        }
    }
    Ok(())
}

/// Brings one log file's entry up to date; returns whether it changed.
fn refresh_entry(cache: &mut Cache, key: String, path: &Path, metadata: &std::fs::Metadata, agent: Agent) -> bool {
    let (length, modified) = (metadata.len(), modified_ms(metadata));
    let entry = cache.files.entry(key).or_default();
    if entry.agent == Some(agent) && entry.length == length && entry.modified == modified {
        return false;
    }
    // Logs are append-only; anything else (truncated, replaced, first sight) is read from the start.
    if entry.agent != Some(agent) || length < entry.offset {
        *entry = FileEntry {
            agent: Some(agent),
            session: agent == Agent::Codex || !path.components().any(|part| part.as_os_str() == "subagents"),
            ..FileEntry::default()
        };
    }
    if read_file(path, agent, entry).is_err() {
        *entry = FileEntry::default();
        return false;
    }
    entry.length = length;
    entry.modified = modified;
    true
}

/// Brings the cache entries of every log file passing `keep` up to date with the
/// logs on disk and forgets those whose files are gone; returns whether it changed.
fn refresh_matching(cache: &mut Cache, roots: &Roots, since_ms: i64, keep: &dyn Fn(Agent, &Path) -> bool) -> bool {
    let mut changed = false;
    let mut seen = HashSet::new();
    for (agent, dirs) in roots {
        let mut files = Vec::new();
        for root in dirs {
            log_files(root, since_ms, &|path| keep(*agent, path), &mut files);
        }
        for (path, metadata) in files {
            let key = path.to_string_lossy().into_owned();
            seen.insert(key.clone());
            changed |= refresh_entry(cache, key, &path, &metadata, *agent);
        }
    }
    let before = cache.files.len();
    cache.files.retain(|path, entry| seen.contains(path) || entry.agent.is_some_and(|agent| !keep(agent, Path::new(path))));
    changed || cache.files.len() != before
}

/// Brings the cache up to date with the logs on disk; returns whether it changed.
fn refresh_cache(cache: &mut Cache, roots: &Roots, since_ms: i64) -> bool {
    refresh_matching(cache, roots, since_ms, &|_, _| true)
}

/// Like `refresh_cache`, but reads and forgets only the log files of `links`, so a
/// task's totals match a full scan without reading other logs. Every root is walked
/// each time (only matching names are stat'ed), so a rollout moved to
/// `archived_sessions` or a second log of the same session is never missed.
fn refresh_linked(cache: &mut Cache, roots: &Roots, links: &[String], since_ms: i64) -> bool {
    refresh_matching(cache, roots, since_ms, &|agent, path| links.iter().any(|link| file_belongs_to(link, agent, path)))
}

fn aggregate(cache: &Cache, book: &pricing::PriceBook, since_hour: i64, scanned_at: i64) -> Ledger {
    let mut models: Vec<ModelInfo> = Vec::new();
    let mut model_index: HashMap<(Agent, &str), usize> = HashMap::new();
    let mut rows: HashMap<(i64, usize), Sums> = HashMap::new();
    let mut replies = HashSet::new();
    let mut sessions = Vec::new();
    let mut sources: HashMap<Agent, usize> = HashMap::new();
    let mut paths: Vec<&String> = cache.files.keys().collect();
    paths.sort();
    for path in paths {
        let entry = &cache.files[path];
        let Some(agent) = entry.agent else { continue };
        *sources.entry(agent).or_default() += 1;
        let mut span: Option<(i64, i64)> = None;
        for record in entry.records.iter().filter(|record| record.hour >= since_hour) {
            if record.key.is_some_and(|key| !replies.insert(key)) {
                continue;
            }
            let index = *model_index.entry((agent, record.model.as_str())).or_insert_with(|| {
                models.push(ModelInfo { provider: agent, name: record.model.to_string(), priced: book.find(&record.model).is_some() });
                models.len() - 1
            });
            let (cost, savings) = book.cost(record).unwrap_or((0.0, 0.0));
            let row = rows.entry((record.hour, index)).or_default();
            row.0 += record.input;
            row.1 += record.cache_read;
            row.2 += record.cache_write + record.cache_write_1h;
            row.3 += record.output;
            row.4 += cost;
            row.5 += savings;
            span = Some(span.map_or((record.hour, record.hour), |(first, last)| (first.min(record.hour), last.max(record.hour))));
        }
        if let (true, Some((first, last))) = (entry.session, span) {
            sessions.push(SessionSpan { provider: agent, first, last });
        }
    }
    let mut rows: Vec<_> = rows
        .into_iter()
        .map(|((hour, model), (input, read, write, output, cost, savings))| (hour, model, input, read, write, output, cost, savings))
        .collect();
    rows.sort_by_key(|row| (row.0, row.1));
    let mut sources: Vec<SourceInfo> = sources.into_iter().map(|(provider, files)| SourceInfo { provider, files }).collect();
    sources.sort_by_key(|source| source.provider as u8);
    Ledger {
        scanned_at,
        pricing: Pricing { source: book.source, fetched_at: book.fetched_at },
        sources,
        models,
        rows,
        sessions,
    }
}

fn load_cache(path: &Path) -> Cache {
    File::open(path)
        .ok()
        .and_then(|file| serde_json::from_reader::<_, Cache>(BufReader::with_capacity(256 * 1024, file)).ok())
        .filter(|cache| cache.version == CACHE_VERSION)
        .unwrap_or(Cache { version: CACHE_VERSION, files: HashMap::new() })
}

/// Streams the cache to disk (no whole-file buffer); returns whether it was written.
fn save_cache(path: &Path, cache: &Cache) -> bool {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temporary = path.with_extension("tmp");
    let written = File::create(&temporary).and_then(|file| {
        let mut writer = BufWriter::with_capacity(256 * 1024, file);
        serde_json::to_writer(&mut writer, cache)?;
        writer.flush()
    });
    match written.and_then(|_| std::fs::rename(&temporary, path)) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("usage ledger: could not save the log cache: {error}");
            let _ = std::fs::remove_file(&temporary);
            false
        }
    }
}

#[derive(Default)]
struct State {
    cache: Option<Cache>,
    last: Option<(i64, std::sync::Arc<Ledger>)>,
    /// The cache has changes not yet saved.
    dirty: bool,
    saved_at: i64,
    used_at: i64,
    janitor: bool,
}

fn state() -> &'static tokio::sync::Mutex<State> {
    static STATE: std::sync::OnceLock<tokio::sync::Mutex<State>> = std::sync::OnceLock::new();
    STATE.get_or_init(Default::default)
}

fn cache_path(dir: &Path) -> PathBuf {
    dir.join("usage-ledger-cache.json")
}

/// Runs `work` on the cache (loaded on demand) off the async runtime. `work` returns
/// whether it changed the cache; changes are saved now only if the last save is a
/// minute old, otherwise by the janitor.
async fn with_cache<T: Send + 'static>(
    state: &mut State,
    dir: &Path,
    work: impl FnOnce(&mut Cache) -> (bool, T) + Send + 'static,
) -> crate::Result<T> {
    let now = crate::storage::now();
    let path = cache_path(dir);
    let (cache, dirty) = (state.cache.take(), state.dirty);
    let due = now - state.saved_at >= SAVE_EVERY_MS;
    state.dirty = false;
    state.used_at = now;
    let (cache, output, dirty, saved) = tokio::time::timeout(
        Duration::from_secs(300),
        tauri::async_runtime::spawn_blocking(move || {
            let mut cache = cache.unwrap_or_else(|| load_cache(&path));
            let (changed, output) = work(&mut cache);
            let dirty = dirty || changed;
            let saved = dirty && due && save_cache(&path, &cache);
            (cache, output, dirty && !saved, saved)
        }),
    )
    .await
    .map_err(|_| "Reading agent logs took too long. Try again later.".to_string())?
    .map_err(|e| e.to_string())?;
    state.cache = Some(cache);
    state.dirty = dirty;
    if saved {
        state.saved_at = now;
    }
    start_janitor(state, dir.to_path_buf());
    Ok(output)
}

/// Once a minute, saves unsaved changes; after `IDLE_DROP_MS` unused, saves and
/// drops the cache and the last ledger, then stops until the next use.
fn start_janitor(current: &mut State, dir: PathBuf) {
    if current.janitor {
        return;
    }
    current.janitor = true;
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(SAVE_EVERY_MS as u64)).await;
            let mut state = state().lock().await;
            let now = crate::storage::now();
            let idle = now - state.used_at >= IDLE_DROP_MS;
            if state.dirty {
                if let Some(cache) = state.cache.take() {
                    let path = cache_path(&dir);
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        let saved = save_cache(&path, &cache);
                        (cache, saved)
                    })
                    .await;
                    if let Ok((cache, saved)) = result {
                        state.cache = Some(cache);
                        state.dirty = !saved;
                        state.saved_at = now;
                    }
                }
                state.dirty &= state.cache.is_some();
            }
            // A failed save is retried each minute while in use; idle, the cache goes regardless
            // (it is rebuilt from the logs).
            if idle {
                state.dirty = false;
                state.cache = None;
                state.last = None;
                state.janitor = false;
                break;
            }
        }
    });
}

async fn build(dir: PathBuf, refresh: bool) -> crate::Result<std::sync::Arc<Ledger>> {
    // One scan at a time; a second window or a quick reopen shares the result.
    let mut state = state().lock().await;
    let now = crate::storage::now();
    if let Some((_, ledger)) = state.last.as_ref().filter(|(at, _)| !refresh && now - at < RESULT_TTL_MS) {
        return Ok(ledger.clone());
    }
    let book = pricing::load(&dir.join("usage-prices.json"), now).await;
    let since_ms = now - HISTORY_DAYS * 86_400_000;
    let ledger = with_cache(&mut state, &dir, move |cache| {
        let changed = refresh_cache(cache, &agent_roots(), since_ms);
        (changed, aggregate(cache, &book, since_ms.div_euclid(3_600_000), now))
    })
    .await?;
    let ledger = std::sync::Arc::new(ledger);
    state.last = Some((now, ledger.clone()));
    Ok(ledger)
}

#[tauri::command]
pub(crate) async fn usage_ledger(app: tauri::AppHandle, window: tauri::WebviewWindow, refresh: Option<bool>) -> crate::Result<Ledger> {
    if window.label() != "main" {
        return Err("Usage estimates are available only in the main application window.".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(Ledger::clone(&*build(dir, refresh.unwrap_or(false)).await?))
}

/// Token totals for the harness sessions one task has run under, summed from the
/// cached log records.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskUsage {
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    pub first_used: Option<i64>,
    pub last_used: Option<i64>,
}

/// Whether one cached log file belongs to the harness session: Claude names the file
/// after the session, Codex ends the rollout file name with the session id.
fn file_belongs_to(link: &str, agent: Agent, path: &Path) -> bool {
    let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else { return false };
    match agent {
        Agent::Claude => stem == link,
        Agent::Codex => stem.len() > link.len() && stem.ends_with(link),
    }
}

/// Sums the cached records of every log file belonging to one of `links`, keeping
/// only records from `since_hour` on. Pure so tests can build the cache by hand.
fn task_usage_from_cache(cache: &Cache, links: &[String], since_hour: i64) -> TaskUsage {
    let mut usage = TaskUsage::default();
    let mut replies = HashSet::new();
    for (path, entry) in &cache.files {
        let Some(agent) = entry.agent else { continue };
        if !links.iter().any(|link| file_belongs_to(link, agent, Path::new(path))) {
            continue;
        }
        for record in &entry.records {
            if record.hour < since_hour {
                continue;
            }
            // Streaming rewrites a reply and resumed sessions copy earlier ones; count each reply once.
            if let Some(key) = record.key {
                if !replies.insert(key) {
                    continue;
                }
            }
            usage.input += record.input;
            usage.cache_read += record.cache_read;
            usage.cache_write += record.cache_write + record.cache_write_1h;
            usage.output += record.output;
            let started = record.hour * 3_600_000;
            usage.first_used = Some(usage.first_used.map_or(started, |first| first.min(started)));
            usage.last_used = Some(usage.last_used.map_or(started, |last| last.max(started)));
        }
    }
    usage
}

/// Task totals sharing the ledger's log cache; `since_ms` trims older records.
/// Only the task's own log files are refreshed, so a run end reads just what it appended.
pub(crate) async fn task_usage(dir: PathBuf, links: Vec<String>, since_ms: Option<i64>) -> crate::Result<TaskUsage> {
    let mut state = state().lock().await;
    let since_scan = crate::storage::now() - HISTORY_DAYS * 86_400_000;
    with_cache(&mut state, &dir, move |cache| {
        let changed = refresh_linked(cache, &agent_roots(), &links, since_scan);
        let since_hour = since_ms.map_or(0, |ms| ms.div_euclid(3_600_000));
        (changed, task_usage_from_cache(cache, &links, since_hour))
    })
    .await
}
