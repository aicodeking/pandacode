//! Claude Code's own permission policy as it bears on file tracking: whether native edits wait
//! for approval (mode plus the user's Edit/Write allow rules) and whether Read deny rules,
//! managed settings or a linked worktree's main checkout restrict reads.
use crate::account_pool::{eligible_member_ids, DEFAULT};
use crate::connections::{self, Connection, Launch};
use serde_json::Value;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

#[cfg(test)]
use crate::claude_roots::managed_entries_match;
use crate::claude_roots::{
    claude_config_dir_value, host_managed_settings_match, project_config_roots,
    resolve_claude_config_dir_env, resolve_claude_config_dir_env_with, same_settings_directory,
    settings_path_absent,
};

/// Whether a run's native edit tools wait for the user's approval before writing. A native
/// edit's baseline is taken when its tool event reaches PandaCode, which only a waiting edit
/// guarantees happens before the write: Claude-family harnesses in Standard mode (they ask
/// through PandaCode's permission prompt). Accept edits, Claude's auto review, Plan (whose
/// accepted plan continues without asking) and Full access never wait, nor does Codex (it
/// applies workspace edits in Standard too); other harnesses are treated as never waiting.
/// A user's own Claude Code allow rule for Edit/Write also skips the wait: `edits_wait_for_run`
/// checks for one before relying on this.
pub(crate) fn edits_wait_for_approval(provider: &str, mode: &str) -> bool {
    // Only Standard ("ask", launched as Claude's `default`) waits; every other mode, and any
    // mode this list does not know, is treated as never waiting (the handshake covers it).
    crate::providers::claude_family(provider) && mode == "ask"
}

/// `edits_wait_for_approval` for a run, unless the user's Claude Code settings may let its edits
/// through without asking (`claude_allows_edits`): then the full begin/complete handshake is
/// used for native edits too. Reads a few small settings files on each launch.
pub(crate) fn edits_wait_for_run(config: &crate::providers::RunConfig) -> bool {
    edits_wait_for_run_using(config, claude_allows_edits)
}

pub(super) fn edits_wait_for_run_using(
    config: &crate::providers::RunConfig,
    allows_edits: impl FnOnce(&crate::providers::RunConfig) -> bool,
) -> bool {
    edits_wait_for_approval(&config.provider, &config.mode) && !allows_edits(config)
}

/// Whether Claude Code may apply this run's edits without asking. GLM, MiMo and Alibaba launch
/// with `--setting-sources ""`, so user, project and local settings files do not apply to them,
/// but Claude Code still enforces enterprise `managed-settings.json`, and a named connection on
/// any Claude-family harness may pass `--allowedTools` or use another Claude config folder.
/// An assigned or rotation-eligible named account is therefore treated as allowing edits.
pub(super) fn claude_allows_edits(config: &crate::providers::RunConfig) -> bool {
    claude_allows_edits_with(
        config,
        || connections::for_task(&config.session_id, &config.provider).is_some(),
        || eligible_member_ids(&config.provider),
        host_managed_settings_may_allow,
        || {
            let env = crate::provider_settings::environment("claude");
            resolve_claude_config_dir_env(&env, &config.cwd, cfg!(windows))
        },
    )
}

pub(super) fn claude_allows_edits_with(
    config: &crate::providers::RunConfig,
    has_connection: impl FnOnce() -> bool,
    pool_members: impl FnOnce() -> Option<Vec<String>>,
    managed_settings: impl FnOnce() -> bool,
    claude_config_dir: impl FnOnce() -> Option<std::path::PathBuf>,
) -> bool {
    if !crate::providers::claude_family(&config.provider) {
        return false;
    }
    if has_connection() || pool_members().is_some_and(|ids| ids.iter().any(|id| id != DEFAULT)) {
        return true;
    }
    if managed_settings() {
        return true;
    }
    if config.provider != "claude" {
        return false;
    }
    match claude_config_dir() {
        Some(dir) => edit_allow_rules(&dir, &config.cwd),
        None => true,
    }
}

/// Explore must not bypass Claude's native read permissions, in any permission mode.
pub(crate) fn claude_restricts_reads(session_id: &str, provider: &str, cwd: &Path) -> bool {
    claude_restricts_reads_with(
        provider,
        cwd,
        || {
            read_account_launches(
                connections::for_task(session_id, provider),
                eligible_member_ids(provider),
                connections::get,
                connections::launch,
            )
        },
        host_managed_settings_restrict_reads,
        |env| launch_config_dir(crate::provider_settings::environment(provider), env, cwd),
    )
}

/// Pool preparation and rotation can change the assignment after this policy check.
/// Check the current launch and each eligible rotation member once.
pub(super) fn read_account_launches(
    current: Option<Connection>,
    pool: Option<Vec<String>>,
    mut get: impl FnMut(&str) -> Option<Connection>,
    mut launch: impl FnMut(&Connection) -> crate::Result<Launch>,
) -> impl Iterator<Item = crate::Result<Option<Launch>>> {
    let current_id = current.as_ref().map_or(DEFAULT, |account| account.id.as_str());
    let mut seen = HashSet::from([current_id.to_owned()]);
    let alternatives = pool.into_iter().flatten().filter(move |id| seen.insert(id.clone()));
    let accounts = alternatives.map(move |id| {
        if id == DEFAULT {
            Ok(None)
        } else {
            get(&id).map(Some).ok_or_else(|| format!("Eligible pool member {id} is unavailable"))
        }
    });
    std::iter::once(Ok(current))
        .chain(accounts)
        .map(move |account| account?.as_ref().map(&mut launch).transpose())
}

/// The Claude config folder of a launch whose environment is `provider_env` then
/// `connection_env`, in `Launch::apply` order (a connection's `HOME`, `USERPROFILE` or
/// `CLAUDE_CONFIG_DIR` overrides the saved provider environment).
pub(super) fn launch_config_dir(
    provider_env: Vec<(String, String)>, connection_env: &[(String, String)], cwd: &Path,
) -> Option<PathBuf> {
    let inherited = std::env::var_os("CLAUDE_CONFIG_DIR");
    launch_config_dir_with(provider_env, connection_env, inherited.as_deref(), cwd)
}

/// `launch_config_dir` with PandaCode's own `CLAUDE_CONFIG_DIR` passed in as `inherited`.
pub(super) fn launch_config_dir_with(
    provider_env: Vec<(String, String)>, connection_env: &[(String, String)],
    inherited: Option<&OsStr>, cwd: &Path,
) -> Option<PathBuf> {
    let env: Vec<_> = provider_env.into_iter().chain(connection_env.iter().cloned()).collect();
    resolve_claude_config_dir_env_with(&env, inherited, cwd, cfg!(windows))
}

/// `config_dir` maps each candidate's connection env to `launch_config_dir`.
pub(super) fn claude_restricts_reads_with<I>(
    provider: &str,
    cwd: &Path,
    launches: impl FnOnce() -> I,
    managed_settings: impl FnOnce() -> bool,
    mut config_dir: impl FnMut(&[(String, String)]) -> Option<PathBuf>,
) -> bool
where
    I: IntoIterator<Item = crate::Result<Option<Launch>>>,
{
    if !crate::providers::claude_family(provider) {
        return false;
    }
    if managed_settings() {
        return true;
    }
    launches()
        .into_iter()
        .any(|launch| launch_restricts_reads(provider, cwd, launch, &mut config_dir))
}

fn launch_restricts_reads(
    provider: &str,
    cwd: &Path,
    launch: crate::Result<Option<Launch>>,
    config_dir: impl FnOnce(&[(String, String)]) -> Option<PathBuf>,
) -> bool {
    let connection_env = match launch {
        Ok(Some(connection)) => {
            if connection.args.iter().any(|arg| {
                let flag = arg.split('=').next().unwrap_or_default();
                matches!(flag, "--settings" | "--setting-sources" | "--disallowedTools" | "--disallowed-tools")
            }) {
                return true;
            }
            connection.env
        }
        Ok(None) => Vec::new(),
        Err(_) => return true,
    };
    // A connection's empty CLAUDE_CONFIG_DIR is an unknown folder: fail closed, relays too.
    if claude_config_dir_value(&connection_env, cfg!(windows)).is_some_and(str::is_empty) {
        return true;
    }
    // Relays disable user/project sources, but still obey managed policy and connection flags.
    if provider != "claude" {
        return false;
    }
    let Some(config_dir) = config_dir(&connection_env) else { return true };
    read_deny_rules(&config_dir, cwd)
}

pub(super) fn host_managed_settings_restrict_reads() -> bool {
    host_managed_settings_match(managed_entry_restricts_reads)
}

pub(super) fn managed_entry_restricts_reads(path: &Path) -> bool {
    if path.extension().is_some_and(|ext| ext == "d") {
        settings_drop_ins_restrict_reads(path)
    } else {
        file_restricts_reads(path)
    }
}

#[cfg(test)]
pub(super) fn managed_settings_restrict_reads(path: Option<&Path>) -> bool {
    path.is_none_or(|path| {
        managed_entries_match(std::iter::once(path), managed_entry_restricts_reads)
    })
}

pub(super) fn settings_drop_ins_restrict_reads(path: &Path) -> bool {
    /// More entries than this are not walked: the policy fails closed instead.
    const MANAGED_DROP_INS_LIMIT: usize = 256;
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && settings_path_absent(path) => return false,
        Err(_) => return read_settings_warning("unreadable managed settings directory"),
    };
    for (index, entry) in entries.enumerate() {
        if index >= MANAGED_DROP_INS_LIMIT {
            return read_settings_warning("too many managed settings files");
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => return read_settings_warning("unreadable managed settings entry"),
        };
        if entry.path().extension().is_some_and(|ext| ext == "json")
            && file_restricts_reads(&entry.path())
        {
            return true;
        }
    }
    false
}

/// User settings plus project/local settings from cwd through the nearest repository root.
/// Without a repository, only cwd is a project. When `CLAUDE_CONFIG_DIR` points elsewhere,
/// Claude Code still loads `$HOME/.claude/settings*.json` as project settings for a repository
/// rooted at home, so only the active config folder itself is skipped (not read twice).
pub(super) fn read_deny_rules(config_dir: &Path, cwd: &Path) -> bool {
    if SETTINGS_FILES.iter().any(|name| file_restricts_reads(&config_dir.join(name))) {
        return true;
    }
    let roots = project_config_roots(cwd);
    for ancestor in &roots.ancestors {
        let project = ancestor.join(".claude");
        if !same_settings_directory(&project, config_dir)
            && SETTINGS_FILES.iter().any(|name| file_restricts_reads(&project.join(name)))
        {
            return true;
        }
    }
    if let Some(reason) = roots.error {
        return read_settings_warning(reason);
    }
    let Some(main_root) = roots.main_worktree else { return false };
    let project = main_root.join(".claude");
    !same_settings_directory(&project, config_dir)
        && file_restricts_reads(&project.join("settings.local.json"))
}

pub(super) fn read_settings_warning(reason: &str) -> bool {
    eprintln!("PandaCode: Claude Code settings could not be checked for read restrictions ({reason}); the local code explorer is withheld.");
    true
}

pub(super) fn file_restricts_reads(path: &Path) -> bool {
    match read_settings(path) {
        Ok(None) => false,
        Ok(Some(settings)) => settings_restrict_reads(&settings),
        Err(reason) => read_settings_warning(reason),
    }
}

pub(super) fn settings_restrict_reads(settings: &Value) -> bool {
    let Some(settings) = settings.as_object() else { return true };
    let Some(permissions) = settings.get("permissions") else { return false };
    let Some(permissions) = permissions.as_object() else { return true };
    ["deny", "ask"].into_iter().any(|kind| match permissions.get(kind) {
        None => false,
        Some(Value::Array(rules)) => rules.iter().any(|rule| rule.as_str().is_none_or(|rule| {
            let tool = rule.split('(').next().unwrap_or_default().trim();
            ["Read", "Grep", "Glob", "mcp__pandacode_architect__pandacode_explore", "mcp__pandacode_architect"]
                .into_iter().any(|name| wildcard_matches(tool, name))
        })),
        Some(_) => true,
    })
}

/// Match Claude's tool-name `*` globs without recursion or regex backtracking. Only the most
/// recent star can absorb more bytes; target names are fixed, short ASCII tool identifiers.
pub(super) fn wildcard_matches(pattern: &str, text: &str) -> bool {
    let (pattern, text) = (pattern.as_bytes(), text.as_bytes());
    let (mut p, mut t) = (0, 0);
    let (mut star, mut absorbed) = (None, 0);
    while t < text.len() {
        if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            absorbed = t;
        } else if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if let Some(last_star) = star {
            absorbed += 1;
            t = absorbed;
            p = last_star + 1;
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|byte| *byte == b'*')
}

/// A policy's presence (including an unreadable path or registry key) is enough to require
/// tracking. Policy contents need not be read, and unknown platforms never assume absence.
pub(super) fn host_managed_settings_may_allow() -> bool {
    host_managed_settings_match(managed_path_may_allow)
}

/// A policy file and its sibling drop-in directory. An unknown location fails closed.
#[cfg(test)]
pub(super) fn managed_settings_may_allow(path: Option<&Path>) -> bool {
    path.is_none_or(|path| managed_entries_match(std::iter::once(path), managed_path_may_allow))
}

pub(super) fn managed_path_may_allow(path: &std::path::Path) -> bool {
    managed_path_may_allow_with(|| std::fs::symlink_metadata(path).map(|_| ()))
}

pub(super) fn managed_path_may_allow_with(stat: impl FnOnce() -> std::io::Result<()>) -> bool {
    match stat() {
        Ok(()) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

/// Settings files larger than this are not parsed (treated as holding an allow rule).
pub(super) const SETTINGS_LIMIT: u64 = 256 * 1024;
/// The settings files Claude Code reads in its config folder and in a project's `.claude`.
pub(super) const SETTINGS_FILES: [&str; 2] = ["settings.json", "settings.local.json"];
/// Claude Code's native edit tools: an allow rule for any of them, with or without a path
/// specifier (`Edit`, `Write(src/**)`, `Edit(*)`), lets some edits through unasked.
pub(super) const EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// Best-effort, read-only check for an allow rule that lets native edits through without
/// asking (`permissions.allow`, or a `permissions.defaultMode` other than `default`), in the
/// same files `read_deny_rules` walks: `config_dir`'s settings, each `.claude` from `project`
/// up to the nearest repository root, and a linked worktree's main checkout local settings.
/// Any unreadable, oversized or unexpected file, or unreadable repository metadata, counts as
/// holding one, so the wait is never relied on by mistake. Managed (enterprise) settings are
/// checked separately (`host_managed_settings_may_allow`). Limits: `--settings` flags and the
/// user's environment are not read, so a rule there still lets a write beat its baseline; the
/// tracker then marks the turn partial. Nothing from a file's contents is ever logged.
pub(crate) fn edit_allow_rules(config_dir: &Path, project: &Path) -> bool {
    let roots = project_config_roots(project);
    let mut files: Vec<PathBuf> = SETTINGS_FILES.iter().map(|name| config_dir.join(name)).collect();
    for ancestor in &roots.ancestors {
        let settings = ancestor.join(".claude");
        if !same_settings_directory(&settings, config_dir) {
            files.extend(SETTINGS_FILES.iter().map(|name| settings.join(name)));
        }
    }
    if let Some(main_root) = &roots.main_worktree {
        let settings = main_root.join(".claude");
        if !same_settings_directory(&settings, config_dir) {
            files.push(settings.join("settings.local.json"));
        }
    }
    // Every file is checked, so each unreadable one is reported.
    let found = files.iter().map(PathBuf::as_path).map(file_allows_edits).fold(false, |found, allows| found | allows);
    match roots.error {
        Some(reason) => edit_settings_warning(reason),
        None => found,
    }
}

pub(super) fn file_allows_edits(path: &Path) -> bool {
    match read_settings(path) {
        Ok(None) => false,
        Ok(Some(settings)) => settings_allow_edits(&settings),
        Err(reason) => edit_settings_warning(reason),
    }
}

fn edit_settings_warning(reason: &str) -> bool {
    eprintln!("PandaCode: Claude Code settings could not be checked for edit allow rules ({reason}); native edits use the tracking handshake.");
    true
}

/// The parsed file, `None` when it does not exist, or why it could not be read.
pub(super) fn read_settings(path: &std::path::Path) -> std::result::Result<Option<Value>, &'static str> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && settings_path_absent(path) => return Ok(None),
        Err(_) => return Err("unreadable"),
    };
    let meta = file.metadata().map_err(|_| "unreadable")?;
    if !meta.is_file() {
        return Err("not a file");
    }
    if meta.len() > SETTINGS_LIMIT {
        return Err("too large");
    }
    let mut bytes = Vec::new();
    file.take(SETTINGS_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "unreadable")?;
    if bytes.len() as u64 > SETTINGS_LIMIT {
        return Err("too large");
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| "not JSON")
}

/// Whether parsed settings may let an edit through unasked; any unexpected shape does.
pub(super) fn settings_allow_edits(settings: &Value) -> bool {
    let Some(settings) = settings.as_object() else { return true };
    let Some(permissions) = settings.get("permissions") else { return false };
    let Some(permissions) = permissions.as_object() else { return true };
    if permissions.get("defaultMode").is_some_and(|mode| mode.as_str() != Some("default")) {
        return true;
    }
    match permissions.get("allow") {
        None => false,
        Some(Value::Array(rules)) => rules.iter().any(|rule| rule.as_str().is_none_or(edit_rule)),
        Some(_) => true,
    }
}

/// `Edit`, `Write(src/**)`, `*` …: a rule naming an edit tool (or every tool).
pub(super) fn edit_rule(rule: &str) -> bool {
    let tool = rule.split('(').next().unwrap_or_default().trim();
    EDIT_TOOLS.iter().any(|name| wildcard_matches(tool, name))
}
