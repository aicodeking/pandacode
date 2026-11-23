//! The warm key: everything that shapes a Claude launch, so a spare is adopted only by the exact
//! launch it was started for, and why a spare was not adopted.
use super::*;
use crate::connections::Connection;

/// Everything that shapes the launch: the command line, the folder and the tool catalog.
pub(in crate::providers) fn key(config: &RunConfig, tools: &[Value]) -> String {
    key_with(config, tools, &crate::connections::warm_key(&config.session_id, &config.provider))
}

/// `connection` is the task's named connection and its revision, or empty for the global setup.
pub(super) fn key_with(config: &RunConfig, tools: &[Value], connection: &str) -> String {
    let disabled = crate::skill_manager::disabled_for(&config.session_id);
    key_with_disabled(config, tools, connection, &disabled)
}

/// Whether this launch passes `--settings {"fastMode":true}` (`configure_command_with_agents`).
pub(super) fn claude_fast_mode(config: &RunConfig) -> bool {
    config.provider == "claude"
        && config
            .codex_settings
            .as_ref()
            .is_some_and(|settings| settings["serviceTier"] == "fast")
}

pub(super) fn key_with_disabled(
    config: &RunConfig,
    tools: &[Value],
    connection: &str,
    disabled: &std::collections::BTreeSet<String>,
) -> String {
    json!({
        "namedConnection": connection,
        "provider": config.provider, "model": config.model, "effort": config.reasoning_effort,
        "mode": config.mode, "cwd": config.cwd, "resume": config.resume_id,
        "instructions": config.instructions, "tools": tools,
        // Claude's fast mode passes `--settings {"fastMode":true}` at spawn (`configure_command_with_agents`).
        "fastMode": claude_fast_mode(config),
        // A team worker's tool trim (read-only, skills) is on its command line.
        "worker": config.worker,
        // The deny set read once per turn from the conversation's history (`lib.rs`), so a
        // spare launched with another `--disallowedTools` is never adopted.
        "disallowedTools": config.disallowed_tools,
        "disabledSkills": disabled,
        // The login a process starts with (API key or subscription) is fixed at spawn.
        "connection": format!("{:?}", crate::provider_settings::claude_connection_mode()),
        // A saved environment variable change starts the next turn cold.
        "environment": crate::provider_settings::environment_fingerprint(&config.provider),
        // So do the telemetry opt-outs (`privacy.rs`).
        "telemetryOff": super::super::privacy::telemetry_off(),
        // So does a saved executable location.
        "executable": crate::provider_settings::executable_override(&config.provider),
        // Config files Claude reads only at startup: an edit while a spare idles starts cold.
        "claudeConfig": claude_config_fingerprint(config),
    })
    .to_string()
}

/// Project-scoped files under the working folder that Claude Code reads at startup.
const PROJECT_CLAUDE_FILES: [&str; 7] = [
    ".mcp.json",
    ".claude/settings.json",
    ".claude/settings.local.json",
    "CLAUDE.md",
    "CLAUDE.local.md",
    ".claude/CLAUDE.md",
    "AGENTS.md",
];
/// Project-scoped folders of rules, agents, commands and skills Claude Code loads at startup.
const PROJECT_CLAUDE_DIRS: [&str; 4] = [".claude/rules", ".claude/agents", ".claude/commands", ".claude/skills"];
/// User-scoped files under the effective Claude config folder. Never `~/.claude.json`: Claude
/// Code rewrites it at every startup, which would refuse every spare.
const USER_CLAUDE_FILES: [&str; 2] = ["settings.json", "CLAUDE.md"];
/// User-scoped folders under the effective Claude config folder.
const USER_CLAUDE_DIRS: [&str; 4] = ["rules", "agents", "commands", "skills"];
/// How deep, and how many entries, one config folder's metadata walk reads.
const CONFIG_WALK_DEPTH: usize = 3;
const CONFIG_WALK_ENTRIES: usize = 128;
/// The variable Claude Code reads its config folder from.
const CLAUDE_CONFIG_DIR: &str = "CLAUDE_CONFIG_DIR";

/// Metadata of the Claude config files and folders this launch's process would read.
fn claude_config_fingerprint(config: &RunConfig) -> Vec<Value> {
    let user_dir = effective_claude_config_dir(&config.session_id, &config.provider, &config.cwd);
    claude_config_fingerprint_in(&config.cwd, user_dir.as_deref())
}

/// Metadata only (never contents) of the Claude config files and folders for a launch in `cwd`
/// (every folder up to the repository root, a linked worktree's main checkout, `user_dir` and
/// the host's managed settings), so a spare started before one was created, edited or removed
/// is never adopted.
pub(super) fn claude_config_fingerprint_in(cwd: &Path, user_dir: Option<&Path>) -> Vec<Value> {
    let home_claude = dirs::home_dir().map(|home| home.join(".claude"));
    let managed = crate::turn_changes::host_managed_settings_path();
    claude_config_fingerprint_with(cwd, user_dir, home_claude.as_deref(), managed.as_deref())
}

/// `claude_config_fingerprint_in` with the home `.claude` folder and managed settings given.
fn claude_config_fingerprint_with(
    cwd: &Path,
    user_dir: Option<&Path>,
    home_claude: Option<&Path>,
    managed: Option<&Path>,
) -> Vec<Value> {
    let roots = crate::turn_changes::project_config_roots(cwd);
    // A project's `.claude` that is the user folder (a repository rooted at home) is stamped as
    // the user folder only, as `read_deny_rules` does, even when CLAUDE_CONFIG_DIR moved it.
    let project = |root: &Path| {
        let claude = root.join(".claude");
        let skip_claude = user_dir == Some(claude.as_path()) || home_claude == Some(claude.as_path());
        let files = PROJECT_CLAUDE_FILES
            .iter()
            .map(|name| if skip_claude && name.starts_with(".claude/") { Value::Null } else { config_file_stamp(&root.join(name)) });
        let dirs = PROJECT_CLAUDE_DIRS
            .iter()
            .map(|name| if skip_claude { Value::Null } else { config_dir_stamp(&root.join(name)) });
        let mut stamp = vec![json!(root.to_string_lossy())];
        stamp.extend(files.chain(dirs));
        Value::Array(stamp)
    };
    let projects = roots.ancestors.iter().chain(roots.main_worktree.as_ref()).map(|root| project(root.as_path()));
    let user_files = USER_CLAUDE_FILES
        .iter()
        .map(|name| user_dir.map_or(Value::Null, |dir| config_file_stamp(&dir.join(name))));
    let user_dirs = USER_CLAUDE_DIRS
        .iter()
        .map(|name| user_dir.map_or(Value::Null, |dir| config_dir_stamp(&dir.join(name))));
    let managed = [
        managed.map_or(Value::Null, config_file_stamp),
        managed.map_or(Value::Null, |path| config_dir_stamp(&path.with_extension("d"))),
    ];
    let error = json!(roots.error);
    projects.chain(user_files).chain(user_dirs).chain(managed).chain([error]).collect()
}

/// The Claude config folder this task's process starts with: the saved environment, then the
/// task's named connection (its variables, then its own folder, as `connections::launch` orders
/// them). Secrets are never read; a relative folder resolves against the working folder the
/// process starts in.
pub(super) fn effective_claude_config_dir(session_id: &str, provider: &str, cwd: &Path) -> Option<PathBuf> {
    let connection = crate::connections::for_task(session_id, provider);
    claude_config_dir_from(crate::provider_settings::environment("claude"), connection.as_ref(), cwd)
}

/// `effective_claude_config_dir` over a given saved environment and connection.
pub(super) fn claude_config_dir_from(
    provider_env: Vec<(String, String)>,
    connection: Option<&Connection>,
    cwd: &Path,
) -> Option<PathBuf> {
    claude_config_dir_from_with(provider_env, connection, cwd, cfg!(windows))
}

/// `claude_config_dir_from`, matching variable names case-insensitively when `ignore_case`
/// (Windows environment names are).
pub(super) fn claude_config_dir_from_with(
    provider_env: Vec<(String, String)>,
    connection: Option<&Connection>,
    cwd: &Path,
    ignore_case: bool,
) -> Option<PathBuf> {
    let mut env = provider_env;
    if let Some(connection) = connection {
        env.extend(connection.env.iter().map(|(name, value)| (name.clone(), value.clone())));
        if let Some(dir) = connection
            .config_dir
            .as_ref()
            .filter(|_| crate::connections::config_dir_var(&connection.provider) == Some(CLAUDE_CONFIG_DIR))
        {
            env.push((CLAUDE_CONFIG_DIR.into(), dir.clone()));
        }
    }
    claude_config_dir_in(&env, cwd, ignore_case)
}

/// The config folder `env` (then this process's environment) selects. A leading `~` expands to
/// the home folder and a relative folder resolves against `cwd`.
fn claude_config_dir_in(env: &[(String, String)], cwd: &Path, ignore_case: bool) -> Option<PathBuf> {
    let value = env_lookup(env, CLAUDE_CONFIG_DIR, ignore_case).or_else(|| std::env::var(CLAUDE_CONFIG_DIR).ok());
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return crate::account_config::home(env).map(|home| home.join(".claude"));
    };
    let tilde = value.strip_prefix('~').filter(|rest| rest.is_empty() || rest.starts_with('/') || (cfg!(windows) && rest.starts_with('\\')));
    let dir = match tilde {
        Some(rest) => crate::account_config::home(env)?.join(rest.trim_start_matches(['/', '\\'])),
        None => PathBuf::from(&value),
    };
    Some(if dir.is_relative() { cwd.join(dir) } else { dir })
}

/// The last value of `name` in `env`, as `account_config::var` reads it (without the process
/// fallback), comparing names case-insensitively when `ignore_case`.
fn env_lookup(env: &[(String, String)], name: &str, ignore_case: bool) -> Option<String> {
    env.iter()
        .rev()
        .find(|(key, _)| if ignore_case { key.eq_ignore_ascii_case(name) } else { key == name })
        .map(|(_, value)| value.clone())
}

fn metadata_stamp(meta: &std::fs::Metadata) -> Value {
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_nanos().to_string());
    json!([meta.is_dir(), meta.len(), modified])
}

fn error_stamp(error: &std::io::Error) -> Value {
    json!(format!("err:{:?}", error.kind()))
}

fn config_file_stamp(path: &Path) -> Value {
    match std::fs::metadata(path) {
        Ok(meta) => metadata_stamp(&meta),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(error) => error_stamp(&error),
    }
}

/// A config folder's own metadata and, sorted by relative path, that of every entry up to
/// `CONFIG_WALK_DEPTH` levels and `CONFIG_WALK_ENTRIES` entries deep, plus `"capped"` when
/// the walk stopped early. Never opens a file; a symlinked folder is walked (so editing a linked
/// skill counts) unless its target was already visited, so a link loop cannot recurse.
pub(super) fn config_dir_stamp(root: &Path) -> Value {
    let meta = match std::fs::metadata(root) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Value::Null,
        Err(error) => return error_stamp(&error),
    };
    if !meta.is_dir() {
        return metadata_stamp(&meta);
    }
    let mut entries = Vec::new();
    let mut visited: std::collections::HashSet<PathBuf> = root.canonicalize().into_iter().collect();
    let complete = walk_config_dir(root, "", 1, &mut entries, &mut visited);
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut stamp = vec![metadata_stamp(&meta)];
    stamp.extend(entries.into_iter().map(|(relative, entry)| json!([relative, entry])));
    if !complete {
        stamp.push(json!("capped"));
    }
    Value::Array(stamp)
}

/// Collects `(relative path, stamp)` for `dir`'s entries in name order; false once capped.
fn walk_config_dir(
    dir: &Path,
    relative: &str,
    depth: usize,
    entries: &mut Vec<(String, Value)>,
    visited: &mut std::collections::HashSet<PathBuf>,
) -> bool {
    let mut names: Vec<std::ffi::OsString> = match std::fs::read_dir(dir) {
        Ok(read) => read.filter_map(|entry| entry.ok().map(|entry| entry.file_name())).collect(),
        Err(error) => {
            entries.push((relative.to_owned(), error_stamp(&error)));
            return true;
        }
    };
    names.sort();
    for name in names {
        if entries.len() >= CONFIG_WALK_ENTRIES {
            return false;
        }
        let path = dir.join(&name);
        let name = name.to_string_lossy();
        let child = if relative.is_empty() { name.into_owned() } else { format!("{relative}/{name}") };
        let link = match std::fs::symlink_metadata(&path) {
            Ok(link) => link,
            Err(error) => {
                entries.push((child, error_stamp(&error)));
                continue;
            }
        };
        // A symlink is stamped by its target, so editing the target counts. A symlinked folder
        // is walked only when its target was not visited yet, so a link loop cannot recurse.
        let symlink = link.file_type().is_symlink();
        let target = if symlink { std::fs::metadata(&path).ok() } else { None };
        entries.push((child.clone(), metadata_stamp(target.as_ref().unwrap_or(&link))));
        let is_dir = target.as_ref().map_or(link.is_dir(), std::fs::Metadata::is_dir);
        if !is_dir || depth >= CONFIG_WALK_DEPTH {
            continue;
        }
        let canonical = path.canonicalize();
        let descend = match canonical {
            Ok(canonical) => visited.insert(canonical) || !symlink,
            Err(_) => !symlink,
        };
        if descend && !walk_config_dir(&path, &child, depth + 1, entries, visited) {
            return false;
        }
    }
    true
}

/// The spare launches with the instructions a cold launch would use (`run_inner` applies the
/// skill reminder before keying), so its key and its `--append-system-prompt` both match.
pub(super) fn prepared(mut config: RunConfig, disabled: &std::collections::BTreeSet<String>) -> RunConfig {
    crate::skill_manager::apply_instructions(&mut config, disabled);
    config
}

/// Why a warm agent cannot take this launch, if it cannot.
pub(super) fn miss(alive: bool, spare_key: &str, key: &str, age: Duration, idle: Duration) -> Option<String> {
    if !alive {
        return Some("its process exited".into());
    }
    if age >= idle {
        return Some("it expired".into());
    }
    if spare_key == key {
        return None;
    }
    let (Ok(Value::Object(spare)), Ok(Value::Object(next))) = (serde_json::from_str::<Value>(spare_key), serde_json::from_str::<Value>(key)) else {
        return Some("its launch changed".into());
    };
    Some(format!("changed: {}", changed_fields(&spare, &next).join(", ")))
}

/// The names (never values) of the warm-key fields that differ.
fn changed_fields<'a>(spare: &serde_json::Map<String, Value>, next: &'a serde_json::Map<String, Value>) -> Vec<&'a str> {
    next.iter().filter(|(field, value)| spare.get(*field) != Some(value)).map(|(field, _)| field.as_str()).collect()
}
