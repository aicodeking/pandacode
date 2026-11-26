//! Tool files and their usage stats in app data: `<base>/global/<name>.json` and
//! `<base>/projects/<projectId>/<name>.json`, with `stats.json` beside them so a run never
//! rewrites a tool file. Every write is a temp file renamed into place.
use super::{same_identity, valid_name, Scope, Stats, Tool};
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

/// Missing scopes are normal on a fresh install; other listing errors must reach Settings.
fn read_entries(dir: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Could not read the tool folder: {e}")),
    };
    // An enumerable but unsearchable folder (0444 on Unix) lets `read_dir` succeed while every
    // stat/open inside it fails; check `.` so an empty unsearchable scope still reports an error.
    match fs::symlink_metadata(dir.join(".")) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Could not read the tool folder: {e}")),
    }
    entries.collect::<Result<Vec<_>, _>>().map_err(|e| format!("Could not read the tool folder: {e}"))
}

/// Project ids that have a tool folder.
pub(super) fn project_ids(base: &Path) -> Result<Vec<String>, String> {
    let mut ids: Vec<String> = read_entries(&base.join("projects"))?.into_iter().filter_map(|entry| entry.file_name().into_string().ok()).filter(|id| valid_project_id(id)).collect();
    ids.sort();
    Ok(ids)
}

fn tool_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err(format!("Invalid tool name: {name}"));
    }
    Ok(dir.join(format!("{name}.json")))
}

/// A regular file of at most `limit` bytes; missing files, links and oversize files return
/// `Ok(None)`, while access errors (`EACCES`, etc.) propagate to Settings.
fn try_read_small(path: &Path, limit: u64) -> Result<Option<String>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Could not read the tool folder: {e}")),
    };
    if !meta.is_file() || meta.len() > limit {
        return Ok(None);
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Could not read the tool folder: {e}")),
    };
    if bytes.len() as u64 > limit {
        return Ok(None);
    }
    Ok(String::from_utf8(bytes).ok())
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

/// One tool, if its file is present and valid; reports access errors instead of hiding them.
pub(super) fn try_load(dir: &Path, name: &str) -> Result<Option<Tool>, String> {
    let Ok(path) = tool_path(dir, name) else { return Ok(None) };
    let Some(text) = try_read_small(&path, MAX_FILE)? else { return Ok(None) };
    let Ok(tool) = serde_json::from_str::<Tool>(&text) else { return Ok(None) };
    Ok((tool.name == name && tool.validate().is_ok()).then_some(tool))
}

/// One tool, if its file is present and valid.
pub(super) fn load(dir: &Path, name: &str) -> Option<Tool> {
    try_load(dir, name).ok().flatten()
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

/// Settings needs directory and entry access failures, while the agent catalog above stays fail-soft.
pub(super) fn try_load_all(dir: &Path) -> Result<Vec<Tool>, String> {
    let mut tools = Vec::new();
    for entry in read_entries(dir)? {
        let Ok(file) = entry.file_name().into_string() else { continue };
        let Some(name) = file.strip_suffix(".json") else { continue };
        if let Some(tool) = try_load(dir, name)? {
            tools.push(tool);
        }
    }
    tools.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(tools)
}

pub(super) fn store(dir: &Path, tool: &Tool) -> Result<(), String> {
    let text = serde_json::to_string_pretty(tool).map_err(|e| e.to_string())?;
    write_atomic(&tool_path(dir, &tool.name)?, &text)
}

pub(super) fn remove(dir: &Path, name: &str) -> Result<(), String> {
    let path = tool_path(dir, name)?;
    fs::remove_file(&path).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "No such tool.".to_owned() } else { format!("Could not delete: {e}") })
}

/// Usage stats for one scope; missing or invalid stats files read as empty, while access
/// errors (`EACCES`, etc.) propagate so writes never wipe an unreadable file and Settings sees them.
pub(super) fn try_read_stats(dir: &Path) -> Result<BTreeMap<String, Stats>, String> {
    Ok(try_read_small(&dir.join(STATS_FILE), MAX_STATS_FILE)?.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default())
}

pub(super) fn read_stats(dir: &Path) -> BTreeMap<String, Stats> {
    try_read_stats(dir).unwrap_or_default()
}

pub(super) fn write_stats(dir: &Path, stats: &BTreeMap<String, Stats>) -> Result<(), String> {
    write_atomic(&dir.join(STATS_FILE), &serde_json::to_string(stats).map_err(|e| e.to_string())?)
}

/// Counts one run of `name` by `session`; `exit` is `None` when it never finished.
#[cfg(test)]
pub(super) fn record(dir: &Path, name: &str, session: &str, exit: Option<i32>, now: i64) -> Result<(), String> {
    let _guard = lock();
    record_locked(dir, name, session, exit, now)
}

/// Credits a run to the same tool, even if it moved while the run was in flight.
pub(super) fn record_for_tool(base: &Path, project: &str, initial_scope: Scope, tool: &Tool, session: &str, exit: Option<i32>, now: i64) -> Result<bool, String> {
    let _guard = lock();
    let project_first = initial_scope == Scope::Project;
    for in_project in [project_first, !project_first] {
        let dir = scope_dir(base, in_project.then_some(project))?;
        if try_load(&dir, &tool.name)?.is_some_and(|current| same_identity(&current, tool)) {
            record_locked(&dir, &tool.name, session, exit, now)?;
            return Ok(true);
        }
    }
    if initial_scope == Scope::Global {
        for entry in read_entries(&base.join("projects"))? {
            let name = entry.file_name();
            if !name.to_str().is_some_and(|id| id != project && valid_project_id(id)) {
                continue;
            }
            if !entry.file_type().map_err(|e| format!("Could not read the tool folder: {e}"))?.is_dir() {
                continue;
            }
            let dir = entry.path();
            if try_load(&dir, &tool.name)?.is_some_and(|current| same_identity(&current, tool)) {
                record_locked(&dir, &tool.name, session, exit, now)?;
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn record_locked(dir: &Path, name: &str, session: &str, exit: Option<i32>, now: i64) -> Result<(), String> {
    let mut all = try_read_stats(dir)?;
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

fn restore_tool_move(from_path: &Path, to_path: &Path, from: &Path, tool: &Tool) {
    if fs::rename(to_path, from_path).is_err() && store(from, tool).is_ok() {
        let _ = fs::remove_file(to_path);
    }
}

/// Moves a tool and its stats between scopes; refuses when the name is taken there.
pub(super) fn move_tool(from: &Path, to: &Path, name: &str) -> Result<(), String> {
    let _guard = lock();
    if from == to {
        return Ok(());
    }
    let from_path = tool_path(from, name)?;
    let to_path = tool_path(to, name)?;
    let tool = try_load(from, name)?.ok_or("No such tool.")?;
    match fs::symlink_metadata(&to_path) {
        Ok(_) => return Err(format!("A tool named {name} already exists there.")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Could not check the destination tool folder: {e}")),
    }
    let mut source = try_read_stats(from)?;
    let prev_to = try_read_stats(to)?;
    let moved_stats = source.remove(name);
    let created_to_dir = matches!(fs::symlink_metadata(to), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
    let cleanup_dir = || {
        if created_to_dir {
            let _ = fs::remove_dir(to);
        }
    };

    // Move the tool file first so a read-only source fails before touching stats or leaving a copy.
    fs::create_dir_all(to).map_err(|e| format!("Could not create the tool folder: {e}"))?;
    match fs::rename(&from_path, &to_path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            if let Err(err) = store(to, &tool) {
                cleanup_dir();
                return Err(err);
            }
            if let Err(err) = remove(from, name) {
                let _ = fs::remove_file(&to_path);
                cleanup_dir();
                return Err(err);
            }
        }
        Err(e) => {
            cleanup_dir();
            return Err(format!("Could not move: {e}"));
        }
    }

    if let Some(stats) = moved_stats {
        let to_stats_path = to.join(STATS_FILE);
        let had_to_stats = fs::symlink_metadata(&to_stats_path).is_ok();
        let mut target = prev_to.clone();
        target.insert(name.to_owned(), stats);
        if let Err(err) = write_stats(to, &target) {
            restore_tool_move(&from_path, &to_path, from, &tool);
            cleanup_dir();
            return Err(err);
        }
        if let Err(err) = write_stats(from, &source) {
            if had_to_stats {
                let _ = write_stats(to, &prev_to);
            } else {
                let _ = fs::remove_file(&to_stats_path);
            }
            restore_tool_move(&from_path, &to_path, from, &tool);
            cleanup_dir();
            return Err(err);
        }
    }
    Ok(())
}

/// Deletes a tool and its stats.
pub(super) fn delete(dir: &Path, name: &str) -> Result<(), String> {
    let _guard = lock();
    let _ = tool_path(dir, name)?;
    let mut stats = try_read_stats(dir)?;
    remove(dir, name)?;
    if stats.remove(name).is_some() {
        write_stats(dir, &stats)?;
    }
    Ok(())
}

pub(super) fn set_disabled(dir: &Path, name: &str, disabled: bool) -> Result<(), String> {
    let _guard = lock();
    let tool = try_load(dir, name)?.ok_or("No such tool.")?;
    store(dir, &Tool { disabled, ..tool })
}
