//! Tool files and their usage stats in app data: `<base>/global/<name>.json` and
//! `<base>/projects/<projectId>/<name>.json`, with `stats.json` beside them so a run never
//! rewrites a tool file. Every write is a temp file renamed into place.
use super::{valid_name, Stats, Tool};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// Hidden, so no tool name (`[a-z0-9]…`) can collide with it.
const STATS_FILE: &str = ".stats.json";
const MAX_FILE: u64 = 64 * 1024;
const MAX_STATS_FILE: u64 = 4 * 1024 * 1024;
/// Distinct tasks kept per tool.
pub(super) const MAX_TASKS: usize = 50;

/// Serialises every read-modify-write (stats, moves, version bumps).
// ponytail: one process-wide lock; per-scope locks if saves ever contend.
static WRITES: Mutex<()> = Mutex::new(());

pub(super) fn lock() -> std::sync::MutexGuard<'static, ()> {
    WRITES.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A project id from the database: a short id, never a path.
fn valid_project_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

/// The folder of one scope: `None` is global.
pub(super) fn scope_dir(base: &Path, project: Option<&str>) -> Result<PathBuf, String> {
    match project {
        None => Ok(base.join("global")),
        Some(id) if valid_project_id(id) => Ok(base.join("projects").join(id)),
        Some(_) => Err("Unknown project.".into()),
    }
}

/// Project ids that have a tool folder.
pub(super) fn project_ids(base: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(base.join("projects")) else { return Vec::new() };
    let mut ids: Vec<String> = entries.flatten().filter_map(|entry| entry.file_name().into_string().ok()).filter(|id| valid_project_id(id)).collect();
    ids.sort();
    ids
}

fn tool_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err(format!("Invalid tool name: {name}"));
    }
    Ok(dir.join(format!("{name}.json")))
}

/// A regular file of at most `limit` bytes; links and oversize files read as missing.
fn read_small(path: &Path, limit: u64) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > limit {
        return None;
    }
    fs::read_to_string(path).ok()
}

pub(super) fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("Invalid tool folder.")?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create the tool folder: {e}"))?;
    let temp = dir.join(format!(".tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&temp, text).map_err(|e| format!("Could not save: {e}"))?;
    fs::rename(&temp, path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        format!("Could not save: {e}")
    })
}

/// One tool, if its file is present and valid.
pub(super) fn load(dir: &Path, name: &str) -> Option<Tool> {
    let text = read_small(&tool_path(dir, name).ok()?, MAX_FILE)?;
    let tool: Tool = serde_json::from_str(&text).ok()?;
    (tool.name == name && tool.validate().is_ok()).then_some(tool)
}

/// Every valid tool of one scope, by name.
pub(super) fn load_all(dir: &Path) -> Vec<Tool> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut tools: Vec<Tool> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|file| file.strip_suffix(".json").map(str::to_owned))
        .filter_map(|name| load(dir, &name))
        .collect();
    tools.sort_by(|a, b| a.name.cmp(&b.name));
    tools
}

pub(super) fn store(dir: &Path, tool: &Tool) -> Result<(), String> {
    let text = serde_json::to_string_pretty(tool).map_err(|e| e.to_string())?;
    write_atomic(&tool_path(dir, &tool.name)?, &text)
}

pub(super) fn remove(dir: &Path, name: &str) -> Result<(), String> {
    let path = tool_path(dir, name)?;
    fs::remove_file(&path).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "No such tool.".to_owned() } else { format!("Could not delete: {e}") })
}

pub(super) fn read_stats(dir: &Path) -> BTreeMap<String, Stats> {
    read_small(&dir.join(STATS_FILE), MAX_STATS_FILE).and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

pub(super) fn write_stats(dir: &Path, stats: &BTreeMap<String, Stats>) -> Result<(), String> {
    write_atomic(&dir.join(STATS_FILE), &serde_json::to_string(stats).map_err(|e| e.to_string())?)
}

/// Counts one run of `name` by `session`; `exit` is `None` when it never finished.
pub(super) fn record(dir: &Path, name: &str, session: &str, exit: Option<i32>, now: i64) -> Result<(), String> {
    let _guard = lock();
    let mut all = read_stats(dir);
    let stats = all.entry(name.to_owned()).or_default();
    stats.uses += 1;
    if exit != Some(0) {
        stats.failures += 1;
    }
    stats.last_used_at = Some(now);
    stats.last_exit = exit;
    stats.tasks.retain(|task| task != session);
    stats.tasks.push(session.to_owned());
    let over = stats.tasks.len().saturating_sub(MAX_TASKS);
    stats.tasks.drain(..over);
    write_stats(dir, &all)
}

/// Moves a tool and its stats between scopes; refuses when the name is taken there.
pub(super) fn move_tool(from: &Path, to: &Path, name: &str) -> Result<(), String> {
    let _guard = lock();
    if from == to {
        return Ok(());
    }
    let tool = load(from, name).ok_or("No such tool.")?;
    if tool_path(to, name)?.exists() {
        return Err(format!("A tool named {name} already exists there."));
    }
    store(to, &tool)?;
    let mut source = read_stats(from);
    if let Some(stats) = source.remove(name) {
        let mut target = read_stats(to);
        target.insert(name.to_owned(), stats);
        write_stats(to, &target)?;
        write_stats(from, &source)?;
    }
    remove(from, name)
}

/// Deletes a tool and its stats.
pub(super) fn delete(dir: &Path, name: &str) -> Result<(), String> {
    let _guard = lock();
    remove(dir, name)?;
    let mut stats = read_stats(dir);
    if stats.remove(name).is_some() {
        write_stats(dir, &stats)?;
    }
    Ok(())
}

pub(super) fn set_disabled(dir: &Path, name: &str, disabled: bool) -> Result<(), String> {
    let _guard = lock();
    let tool = load(dir, name).ok_or("No such tool.")?;
    store(dir, &Tool { disabled, ..tool })
}
