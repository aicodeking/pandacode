//! The warm key: everything that shapes a Claude launch, so a spare is adopted only by the exact
//! launch it was started for, and why a spare was not adopted.
use super::*;
use crate::connections::Connection;

/// Everything that shapes the launch: the command line, the folder and the tool catalog.
/// `None` when the launch's Claude config cannot be fingerprinted: no spare is started or adopted.
/// A launch keys itself with `key_fields` and `with_git_status`, which give the same string.
#[cfg(test)]
pub(in crate::providers) fn key(config: &RunConfig, tools: &[Value]) -> Option<String> {
    key_with(config, tools, &crate::connections::warm_key(&config.session_id, &config.provider), None)
}

/// `key` completed with the working tree's `git_status` digest, as every spare's key (ordinary
/// and lead) carries it.
#[cfg(test)]
pub(in crate::providers) fn lead_key(config: &RunConfig, tools: &[Value], git_status: &str) -> Option<String> {
    key_with(config, tools, &crate::connections::warm_key(&config.session_id, &config.provider), Some(git_status))
}

/// `connection` is the task's named connection and its revision, or empty for the global setup.
#[cfg(test)]
pub(super) fn key_with(config: &RunConfig, tools: &[Value], connection: &str, git_status: Option<&str>) -> Option<String> {
    let disabled = crate::skill_manager::disabled_for(&config.session_id);
    key_with_disabled(config, tools, connection, &disabled, &mcp_host::stdio_servers(&config.session_id), git_status)
}

/// Whether this launch passes `--settings {"fastMode":true}` (`configure_command_with_agents`).
pub(super) fn claude_fast_mode(config: &RunConfig) -> bool {
    config.provider == "claude"
        && config
            .codex_settings
            .as_ref()
            .is_some_and(|settings| settings["serviceTier"] == "fast")
}

/// `key_fields_with_disabled` completed with a `gitStatus` digest (`with_git_status`).
#[cfg(test)]
pub(super) fn key_with_disabled(
    config: &RunConfig,
    tools: &[Value],
    connection: &str,
    disabled: &std::collections::BTreeSet<String>,
    stdio: &[mcp_host::Stdio],
    git_status: Option<&str>,
) -> Option<String> {
    key_fields_with_disabled(config, tools, connection, disabled, stdio).map(|fields| with_git_status(fields, git_status))
}

/// The warm key's fields (no `gitStatus`) with the task's named connection looked up: what a
/// spare is spawned and a renewal checked with. `None` when the Claude config cannot be fingerprinted.
pub(super) fn key_fields_with_disabled(
    config: &RunConfig,
    tools: &[Value],
    connection: &str,
    disabled: &std::collections::BTreeSet<String>,
    stdio: &[mcp_host::Stdio],
) -> Option<Value> {
    let named = crate::connections::for_task(&config.session_id, &config.provider);
    key_fields_for_connection(config, tools, connection, named.as_ref(), disabled, stdio)
}

/// The key with the task's named connection (`named`) already looked up.
/// `git_status`: the working tree's digest (`git_status`), or `None` to leave it out.
#[cfg(test)]
pub(super) fn key_for_connection(
    config: &RunConfig,
    tools: &[Value],
    connection: &str,
    named: Option<&Connection>,
    disabled: &std::collections::BTreeSet<String>,
    stdio: &[mcp_host::Stdio],
    git_status: Option<&str>,
) -> Option<String> {
    key_fields_for_connection(config, tools, connection, named, disabled, stdio).map(|fields| with_git_status(fields, git_status))
}

/// The warm key's fields for a launch keyed against a pooled spare, without its `gitStatus`, so
/// the config walk can run beside the working tree's `git status`; `with_git_status` completes it.
/// `None` when the launch's Claude config cannot be fingerprinted. Reads files: off the runtime.
pub(in crate::providers) fn key_fields(config: &RunConfig, tools: &[Value]) -> Option<Value> {
    let connection = crate::connections::warm_key(&config.session_id, &config.provider);
    let disabled = crate::skill_manager::disabled_for(&config.session_id);
    let named = crate::connections::for_task(&config.session_id, &config.provider);
    key_fields_for_connection(config, tools, &connection, named.as_ref(), &disabled, &mcp_host::stdio_servers(&config.session_id))
}

/// Claude Code snapshots the working tree's status in `gitStatus` at spawn, and files may change
/// while a spare waits (a lead's workers, the user, another tool): every spare is adopted only if
/// that is unchanged too. A spawn completes its key the same way, with the status read once the
/// previous turn has exited.
pub(in crate::providers) fn with_git_status(mut fields: Value, git_status: Option<&str>) -> String {
    if let (Some(status), Value::Object(map)) = (git_status, &mut fields) {
        map.insert("gitStatus".into(), json!(status));
    }
    fields.to_string()
}

/// The warm key's fields before its `gitStatus` is added.
pub(super) fn key_fields_for_connection(
    config: &RunConfig,
    tools: &[Value],
    connection: &str,
    named: Option<&Connection>,
    disabled: &std::collections::BTreeSet<String>,
    stdio: &[mcp_host::Stdio],
) -> Option<Value> {
    // Config files Claude reads only at startup: an edit while a spare idles starts cold.
    // An unavailable fingerprint (see `claude_config_fingerprint_with`) leaves no warm key.
    let claude_config = claude_config_fingerprint(config, named)?;
    Some(json!({
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
        // So does a saved executable location (the connection's own first, as at launch), or a
        // CLI upgraded in place (in the app or not).
        "executable": executable_stamp(&config.provider, named),
        "claudeConfig": claude_config,
        // Claude Code snapshots `gitStatus` (branch, recent commits, working tree) at spawn:
        // `gitHead` catches branch switches, detaches and commits; `gitStatus` (added via
        // `with_git_status`) catches working-tree edits that change porcelain status.
        "gitHead": git_head_stamp(&config.cwd),
        // So does turning Colab's MCP on or off: its server rides `--mcp-config`.
        "stdioMcp": stdio.iter().map(|server| json!([server.name, server.command, server.args])).collect::<Vec<_>>(),
    }))
}

/// The saved executable location, the binary a launch would run, and that binary's metadata
/// (following symlinks), so an upgraded CLI starts the next turn cold.
fn executable_stamp(provider: &str, connection: Option<&Connection>) -> Value {
    let (saved, resolved) = executable_for(
        connection,
        crate::provider_settings::executable_override(provider),
        || crate::providers::executable(provider),
    );
    executable_stamp_for(saved, resolved)
}

/// The saved location and the binary a launch runs: a named connection's own executable first,
/// exactly as `spawn_claude_process` and `connections::launch` pick it, else the global setup.
pub(super) fn executable_for(
    connection: Option<&Connection>,
    saved: Option<PathBuf>,
    resolved: impl FnOnce() -> Option<PathBuf>,
) -> (Option<PathBuf>, Option<PathBuf>) {
    match connection.and_then(|connection| connection.executable.as_deref()).map(PathBuf::from) {
        Some(own) => (Some(own.clone()), Some(own)),
        None => (saved, resolved()),
    }
}

pub(super) fn executable_stamp_for(saved: Option<PathBuf>, resolved: Option<PathBuf>) -> Value {
    let binary = resolved.as_deref().map_or(Value::Null, config_file_stamp);
    let target = resolved.as_deref().and_then(|path| path.canonicalize().ok());
    json!({"saved": saved, "resolved": resolved, "target": target, "binary": binary})
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
/// Code rewrites it at every startup, which would refuse every spare. `settings.local.json` is
/// here too: a project rooted at the user folder's parent (a dotfiles repo at `~`) skips its own
/// `.claude/` stamps, so this is where that file's edits are noticed.
const USER_CLAUDE_FILES: [&str; 3] = ["settings.json", "settings.local.json", "CLAUDE.md"];
/// User-scoped folders under the effective Claude config folder.
const USER_CLAUDE_DIRS: [&str; 4] = ["rules", "agents", "commands", "skills"];
/// How deep, and how many entries, one config folder's metadata walk reads.
const CONFIG_WALK_DEPTH: usize = 3;
const CONFIG_WALK_ENTRIES: usize = 128;
/// The variable Claude Code reads its config folder from.
const CLAUDE_CONFIG_DIR: &str = "CLAUDE_CONFIG_DIR";

/// Metadata of the Claude config files and folders this launch's process would read; `None`
/// when the folder is unknown or a config walk exceeds its cap (see `claude_config_fingerprint_with`).
pub(super) fn claude_config_fingerprint(config: &RunConfig, connection: Option<&Connection>) -> Option<Vec<Value>> {
    let env = claude_launch_env(crate::provider_settings::environment("claude"), connection);
    // A legacy connection may hold a folder variable as a secret, which is never read here.
    let secret_config = connection.is_some_and(|connection| {
        connection.secret_env.iter().any(|name| {
            name.eq_ignore_ascii_case(CLAUDE_CONFIG_DIR)
                || name.eq_ignore_ascii_case("HOME")
                || name.eq_ignore_ascii_case("USERPROFILE")
        })
    });
    let inherited = std::env::var_os(CLAUDE_CONFIG_DIR);
    let empty_config = crate::claude_roots::claude_config_dir_value(&env, cfg!(windows))
        .map_or_else(|| inherited.as_deref().is_some_and(std::ffi::OsStr::is_empty), str::is_empty);
    let user_dir = crate::claude_roots::resolve_claude_config_dir_env_with(
        &env,
        inherited.as_deref(),
        &config.cwd,
        cfg!(windows),
    );
    let home_claude = crate::account_config::home(&env).map(|home| home.join(".claude"));
    let managed = crate::claude_roots::host_managed_settings_paths();
    claude_config_fingerprint_with(
        &config.cwd,
        user_config_root(user_dir.as_deref(), empty_config, secret_config),
        home_claude.as_deref(),
        managed.as_deref().unwrap_or_default(),
    )
}

/// Where a launch's user-scoped Claude config lives, as far as PandaCode can tell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum UserConfigRoot<'a> {
    /// `CLAUDE_CONFIG_DIR` (or `<home>/.claude` when unset) resolved to this folder.
    Resolved(&'a Path),
    /// `CLAUDE_CONFIG_DIR` is set but empty.
    EmptyConfigDir,
    /// The folder cannot be known: an unresolvable home, or a folder variable kept as a secret.
    Unresolvable,
}

/// `user_dir` is the resolved folder (`None` when empty or unresolvable); `empty_config` says
/// `CLAUDE_CONFIG_DIR` is set but empty; `secret_config` says a legacy connection keeps
/// `CLAUDE_CONFIG_DIR`, `HOME` or `USERPROFILE` as a secret, whose value is never read.
pub(super) fn user_config_root(user_dir: Option<&Path>, empty_config: bool, secret_config: bool) -> UserConfigRoot<'_> {
    match user_dir {
        _ if secret_config => UserConfigRoot::Unresolvable,
        _ if empty_config => UserConfigRoot::EmptyConfigDir,
        Some(user) => UserConfigRoot::Resolved(user),
        None => UserConfigRoot::Unresolvable,
    }
}

/// Metadata only (never contents) of startup configuration, memory and rules. Claude Code
/// resolves its config folder with `CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")`, so an
/// empty value stays `""`: user settings, memory, rules, agents, commands, skills (and
/// credentials, which are never stamped) are read relative to `cwd`, while only `~/.claude.json`
/// and legacy IDE paths use home. Both `cwd` and `home_claude` then get the full user stamps,
/// and the leading marker keeps the key apart from an unset variable. When the folder cannot be
/// known (an empty value with no known home, an unresolvable home, or a folder variable kept as
/// a secret) or a config walk exceeds `CONFIG_WALK_ENTRIES`, this returns `None` and no spare
/// is started or adopted for the launch.
pub(super) fn claude_config_fingerprint_with(
    cwd: &Path,
    user_root: UserConfigRoot<'_>,
    home_claude: Option<&Path>,
    managed_paths: &[PathBuf],
) -> Option<Vec<Value>> {
    const MEMORY_FILES: [&str; 4] = [
        "CLAUDE.md",
        "CLAUDE.local.md",
        "AGENTS.md",
        ".claude/CLAUDE.md",
    ];
    // A linked worktree's committed `.claude/` files are in its own checkout (stamped under
    // `roots.ancestors`); only the untracked local settings come from the main checkout, as in
    // `claude_policy.rs`.
    const MAIN_LOCAL_SETTINGS: &str = ".claude/settings.local.json";

    let (marker, user_dir, user_roots): (&str, Option<&Path>, Vec<&Path>) = match (user_root, home_claude) {
        (UserConfigRoot::Resolved(user), _) => ("resolved", Some(user), vec![user]),
        (UserConfigRoot::EmptyConfigDir, Some(home)) => (
            "empty-config-dir",
            Some(home),
            std::iter::once(cwd).chain((home != cwd).then_some(home)).collect(),
        ),
        (UserConfigRoot::EmptyConfigDir, None) | (UserConfigRoot::Unresolvable, _) => return None,
    };
    let roots = crate::claude_roots::project_config_roots(cwd);
    let above_project = roots
        .ancestors
        .last()
        .and_then(|root| root.parent())
        .into_iter()
        .flat_map(Path::ancestors);
    let mut home_memory_stamped = false;
    let mut stamp_project = |root: &Path, files: &[&str], dirs: &[&str]| -> Option<Value> {
        let claude = root.join(".claude");
        // The effective user folder is stamped below.
        let skip_claude = user_dir == Some(claude.as_path());
        home_memory_stamped |= !skip_claude && home_claude == Some(claude.as_path());
        let files = files
            .iter()
            .filter(|name| !skip_claude || !name.starts_with(".claude/"))
            .map(|name| config_file_stamp(&root.join(name)));
        let mut stamp = vec![json!(root.to_string_lossy())];
        stamp.extend(files);
        if !skip_claude {
            for name in dirs {
                stamp.push(config_dir_stamp(&root.join(name))?);
            }
        }
        Some(Value::Array(stamp))
    };

    let mut stamps = vec![json!(marker)];
    for root in &roots.ancestors {
        stamps.push(stamp_project(
            root,
            &PROJECT_CLAUDE_FILES,
            &PROJECT_CLAUDE_DIRS,
        )?);
    }
    for root in above_project {
        stamps.push(stamp_project(root, &MEMORY_FILES, &[".claude/rules"])?);
    }
    if let Some(main) = roots.main_worktree.filter(|main| user_dir != Some(main.join(".claude").as_path())) {
        stamps.push(json!([main.to_string_lossy(), config_file_stamp(&main.join(MAIN_LOCAL_SETTINGS))]));
    }
    for user in user_roots {
        stamps.extend(
            USER_CLAUDE_FILES
                .iter()
                .map(|name| config_file_stamp(&user.join(name))),
        );
        for name in USER_CLAUDE_DIRS {
            stamps.push(config_dir_stamp(&user.join(name))?);
        }
    }
    if let Some(home) = home_claude.filter(|home| !home_memory_stamped && Some(*home) != user_dir) {
        stamps.push(config_file_stamp(&home.join("CLAUDE.md")));
        stamps.push(config_dir_stamp(&home.join("rules"))?);
    }
    for path in managed_paths {
        stamps.push(config_file_stamp(path));
        stamps.push(config_dir_stamp(&path.with_extension("d"))?);
    }
    stamps.push(json!(roots.error));
    Some(stamps)
}

#[cfg(test)]
pub(super) fn claude_config_dir_from(
    provider_env: Vec<(String, String)>,
    connection: Option<&Connection>,
    cwd: &Path,
) -> Option<PathBuf> {
    claude_config_dir_from_with(provider_env, connection, cwd, cfg!(windows))
}

#[cfg(test)]
pub(super) fn claude_config_dir_from_with(
    provider_env: Vec<(String, String)>,
    connection: Option<&Connection>,
    cwd: &Path,
    ignore_case: bool,
) -> Option<PathBuf> {
    let env = claude_launch_env(provider_env, connection);
    crate::claude_roots::resolve_claude_config_dir_env(&env, cwd, ignore_case)
}

/// The saved environment, then the connection's variables and its own config folder, in the
/// order used by `connections::launch`. Secrets are never read.
fn claude_launch_env(
    mut env: Vec<(String, String)>,
    connection: Option<&Connection>,
) -> Vec<(String, String)> {
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
    env
}

fn metadata_stamp(meta: &std::fs::Metadata) -> Value {
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_nanos().to_string());
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        Some((meta.dev(), meta.ino()))
    };
    #[cfg(not(unix))]
    let identity: Option<(u64, u64)> = None;
    json!([meta.is_dir(), meta.len(), modified, identity])
}

fn error_stamp(error: &std::io::Error) -> Value {
    json!(format!("err:{:?}", error.kind()))
}

pub(super) fn config_file_stamp(path: &Path) -> Value {
    let stamp = match std::fs::metadata(path) {
        Ok(meta) => metadata_stamp(&meta),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(error) => error_stamp(&error),
    };
    if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        let link = std::fs::read_link(path).ok();
        let target = path.canonicalize().ok();
        json!([stamp, link.as_deref().map(Path::to_string_lossy), target.as_deref().map(Path::to_string_lossy)])
    } else {
        stamp
    }
}

/// A config folder's own metadata and, sorted by relative path, that of every entry up to
/// `CONFIG_WALK_DEPTH` levels. Returns `None` if more than `CONFIG_WALK_ENTRIES` entries
/// would be needed. Never opens a file; a symlinked folder is walked (so editing a linked skill
/// counts) unless its target was already visited, so a link loop cannot recurse.
pub(super) fn config_dir_stamp(root: &Path) -> Option<Value> {
    let meta = match std::fs::metadata(root) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(Value::Null),
        Err(error) => return Some(error_stamp(&error)),
    };
    if !meta.is_dir() {
        return Some(metadata_stamp(&meta));
    }
    let mut entries = Vec::new();
    let mut visited: std::collections::HashSet<PathBuf> = root.canonicalize().into_iter().collect();
    if !walk_config_dir(root, "", 1, &mut entries, &mut visited) {
        return None;
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut stamp = vec![metadata_stamp(&meta)];
    stamp.extend(entries.into_iter().map(|(relative, entry)| json!([relative, entry])));
    Some(Value::Array(stamp))
}

/// Collects `(relative path, stamp)` for `dir`'s entries in name order; false once capped.
fn walk_config_dir(
    dir: &Path,
    relative: &str,
    depth: usize,
    entries: &mut Vec<(String, Value)>,
    visited: &mut std::collections::HashSet<PathBuf>,
) -> bool {
    let remaining = CONFIG_WALK_ENTRIES.saturating_sub(entries.len());
    let read = match std::fs::read_dir(dir) {
        Ok(read) => read,
        Err(error) => {
            if remaining == 0 {
                return false;
            }
            entries.push((relative.to_owned(), error_stamp(&error)));
            return true;
        }
    };
    let mut names = Vec::new();
    for (index, entry) in read.enumerate() {
        if index == remaining {
            return false;
        }
        if let Ok(entry) = entry {
            names.push(entry.file_name());
        }
    }
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
        // A symlink is stamped by its target metadata plus its link text and canonical target,
        // so editing the target or retargeting the link to an equal-size, equal-mtime file
        // counts (even on Windows where `metadata_stamp` has no inode identity). A symlinked
        // folder is walked only when its target was not visited yet, so a link loop cannot recurse.
        let symlink = link.file_type().is_symlink();
        let target = if symlink { std::fs::metadata(&path).ok() } else { None };
        let canonical = if symlink { path.canonicalize().ok() } else { None };
        let stamp = metadata_stamp(target.as_ref().unwrap_or(&link));
        let stamp = if symlink {
            let link_target = std::fs::read_link(&path).ok();
            json!([
                stamp,
                link_target.as_deref().map(Path::to_string_lossy),
                canonical.as_deref().map(Path::to_string_lossy),
            ])
        } else {
            stamp
        };
        entries.push((child.clone(), stamp));
        let is_dir = target.as_ref().map_or(link.is_dir(), std::fs::Metadata::is_dir);
        if !is_dir || depth >= CONFIG_WALK_DEPTH {
            continue;
        }
        let canonical = if symlink { canonical } else { path.canonicalize().ok() };
        let descend = match canonical {
            Some(canonical) => visited.insert(canonical) || !symlink,
            None => !symlink,
        };
        if descend && !walk_config_dir(&path, &child, depth + 1, entries, visited) {
            return false;
        }
    }
    true
}

/// The checked-out branch (or detached commit) and its tip, read from the repository's files
/// (`claude_roots::git_dirs_for`; git is never run): `HEAD` and the branch's loose ref, or, only
/// when there is no loose ref, `packed-refs` metadata (so `git fetch --prune` or `git gc` rewriting
/// it never refuses a spare whose branch is loose). A linked worktree reads its own `HEAD` and the
/// shared refs. A reftable repository keeps every ref in its tables, whose list changes on each
/// branch switch, commit or ref update, so that list is stamped instead. The index and working
/// tree are not stamped. `null` outside a repository.
pub(super) fn git_head_stamp(cwd: &Path) -> Value {
    let (gitdir, common) = match crate::claude_roots::git_dirs_for(cwd) {
        None => return Value::Null,
        Some(Err(reason)) => return json!({"error": reason}),
        Some(Ok(dirs)) => dirs,
    };
    let tables = common.join("reftable").join("tables.list");
    if !path_absent(&tables) {
        let own = gitdir.join("reftable").join("tables.list");
        return json!({"reftable": git_file_stamp(&tables), "worktreeReftable": (gitdir != common).then(|| git_file_stamp(&own))});
    }
    let head = match crate::claude_roots::read_git_metadata(&gitdir.join("HEAD")) {
        Ok(head) => head,
        Err(reason) => return json!({"head": {"error": reason}}),
    };
    let head = head.trim();
    let branch = head
        .strip_prefix("ref:")
        .map(str::trim)
        .filter(|name| name.starts_with("refs/") && !name.split('/').any(|part| part == ".."));
    let Some(branch) = branch else { return json!({"head": head}) };
    let loose = common.join(branch);
    match crate::claude_roots::read_git_metadata(&loose) {
        Ok(tip) => json!({"head": head, "ref": tip.trim()}),
        Err(_) if path_absent(&loose) => json!({"head": head, "ref": null, "packedRefs": config_file_stamp(&common.join("packed-refs"))}),
        Err(reason) => json!({"head": head, "ref": {"error": reason}}),
    }
}

/// A small git metadata file's text and metadata (`null` when absent).
fn git_file_stamp(path: &Path) -> Value {
    if path_absent(path) {
        return Value::Null;
    }
    let text = crate::claude_roots::read_git_metadata(path).map_or_else(|reason| json!({"error": reason}), |text| json!(text));
    json!([text, config_file_stamp(path)])
}

/// Whether nothing at all is at `path` (a dangling link or an unreadable entry is something).
fn path_absent(path: &Path) -> bool {
    matches!(std::fs::symlink_metadata(path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
}

/// What a spare's working-tree digest is outside a repository.
pub(super) const NOT_GIT: &str = "not-git";
/// At most this much `git status` output is digested; a larger status is unknown.
const GIT_STATUS_LIMIT: usize = 1024 * 1024;
/// How long the single `git status` process may run after local config inspection in Rust.
/// A launch with a pooled spare waits on it beside its config walk, so a slow one starts cold.
const GIT_STATUS_TIMEOUT: Duration = Duration::from_millis(500);

/// The SHA-256 digest of the working tree's bounded
/// `git status --porcelain=v1 -z --untracked-files=all`, stamped on every spare (ordinary and
/// lead): Claude Code snapshots it (`gitStatus`) at spawn, and files may change while a spare
/// waits. `--untracked-files=all` lists every untracked file, so a file added inside a folder that
/// was already untracked changes the digest too. `NOT_GIT` outside a repository; `None` when it
/// cannot be known (an unreadable repository, a failed, timed-out or truncated `git status`), so
/// no spare starts or is adopted on an unknown status. Local config and root and Git-directory
/// attributes are checked before running status. Includes, filters, and settings that could run
/// a program or fetch fail closed. The bounded Git process ignores global and system config,
/// suppresses hooks, fsmonitor, lazy fetches, credential helpers, askpass and optional locks.
/// Checkouts with submodules also return `None`, since skipping their status would hide changes
/// in them. Runs off the async runtime for pooled launches.
pub(super) fn git_status(cwd: &Path) -> Option<String> {
    let (git_dir, common_dir) = match crate::claude_roots::git_dirs_for(cwd) {
        None => return Some(NOT_GIT.into()),
        Some(Err(_)) => return None,
        Some(Ok(dirs)) => dirs,
    };
    let worktree_root = cwd.ancestors().find(|ancestor| !path_absent(&ancestor.join(".git")));
    if has_submodules(worktree_root, &git_dir, &common_dir) {
        return None;
    }
    crate::git_config::check_status_config_safe(&git_dir, &common_dir, worktree_root).ok()?;
    let args = ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"];
    let output = crate::workspace::run_git_status_safe(cwd, &args, GIT_STATUS_LIMIT, GIT_STATUS_TIMEOUT).ok()?;
    if !output.status.success() || output.stdout.truncated {
        return None;
    }
    use sha2::Digest;
    Some(format!("{:x}", sha2::Sha256::digest(&output.stdout.bytes)))
}

/// Whether the checkout around `cwd` has (or may have) submodules: a `modules` folder in its own
/// or the common git directory, or a `.gitmodules` at the root of its working tree (the nearest
/// ancestor holding `.git`, as `claude_roots::git_dirs_for` finds it). Anything at those paths
/// counts, unreadable entries included, so the check fails closed.
fn has_submodules(worktree_root: Option<&Path>, git_dir: &Path, common_dir: &Path) -> bool {
    if !path_absent(&git_dir.join("modules")) || !path_absent(&common_dir.join("modules")) {
        return true;
    }
    worktree_root.is_some_and(|root| !path_absent(&root.join(".gitmodules")))
}

/// A spare's key without its `gitStatus`: a renewal reads the working tree again right
/// before it spawns, so only the other fields decide whether it is current. `None` when the key
/// is not a JSON object.
pub(super) fn without_git_status(key: &str) -> Option<Value> {
    let Ok(Value::Object(mut fields)) = serde_json::from_str::<Value>(key) else { return None };
    fields.remove("gitStatus");
    Some(Value::Object(fields))
}

/// `git_status` on a blocking thread.
pub(in crate::providers) async fn git_status_digest(cwd: &Path) -> Option<String> {
    let cwd = cwd.to_path_buf();
    crate::blocking(move || Ok(git_status(&cwd))).await.ok().flatten()
}

/// The spare launches with the instructions a cold launch would use (`run_inner` applies the
/// skill reminder before keying), so its key and its `--append-system-prompt` both match.
pub(super) fn prepared(mut config: RunConfig, disabled: &std::collections::BTreeSet<String>) -> RunConfig {
    crate::skill_manager::apply_instructions(&mut config, disabled);
    config
}

/// Whether a spare has waited `limit` on the monotonic clock or, when it is readable, the wall
/// clock: `Instant` may stand still while the machine sleeps, the wall clock does not.
pub(super) fn age_expired(monotonic: Duration, wall: Option<Duration>, limit: Duration) -> bool {
    monotonic >= limit || wall.is_some_and(|elapsed| elapsed >= limit)
}

/// Why a warm agent cannot take this launch, if it cannot. `expired`: `age_expired` held.
pub(super) fn miss(alive: bool, spare_key: &str, key: &str, expired: bool) -> Option<String> {
    if !alive {
        return Some("its process exited".into());
    }
    if expired {
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

#[cfg(all(test, unix))]
mod tests {
    use super::super::test_support::TempDir;
    use super::*;

    #[test]
    fn retargeting_a_symlink_in_a_config_dir_changes_config_dir_stamp() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("warm-dir-symlink-{}", uuid::Uuid::new_v4()));
        let _cleanup = TempDir(root.clone());
        let rules = root.join("rules");
        std::fs::create_dir_all(&rules).unwrap();
        let first = root.join("first.md");
        let second = root.join("second.md");
        std::fs::write(&first, "same rule\n").unwrap();
        std::fs::write(&second, "same rule\n").unwrap();
        let fixed = std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        std::fs::File::options().write(true).open(&first).unwrap().set_modified(fixed).unwrap();
        std::fs::File::options().write(true).open(&second).unwrap().set_modified(fixed).unwrap();
        let first_meta = std::fs::metadata(&first).unwrap();
        let second_meta = std::fs::metadata(&second).unwrap();
        assert_eq!(first_meta.len(), second_meta.len());
        assert_eq!(first_meta.modified().unwrap(), second_meta.modified().unwrap());

        let link = rules.join("active.md");
        symlink(&first, &link).unwrap();
        let first_stamp = config_dir_stamp(&rules).unwrap();
        std::fs::remove_file(&link).unwrap();
        symlink(&second, &link).unwrap();
        let second_stamp = config_dir_stamp(&rules).unwrap();

        assert_ne!(first_stamp, second_stamp);
        let entry_stamp = |dir_stamp: &Value| {
            dir_stamp
                .as_array()
                .unwrap()
                .iter()
                .find_map(|item| (item.get(0).and_then(Value::as_str) == Some("active.md")).then(|| item.get(1).unwrap()))
                .unwrap()
                .as_array()
                .unwrap()
                .clone()
        };
        let first_entry = entry_stamp(&first_stamp);
        let second_entry = entry_stamp(&second_stamp);
        assert_eq!(first_entry.len(), 3);
        assert_eq!(second_entry.len(), 3);
        assert_eq!(first_entry[1].as_str(), Some(first.to_string_lossy().as_ref()));
        assert_eq!(second_entry[1].as_str(), Some(second.to_string_lossy().as_ref()));
        assert_ne!(first_entry[2], second_entry[2]);
    }
}
