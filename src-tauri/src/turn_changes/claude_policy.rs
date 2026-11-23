//! Claude Code's own permission policy as it bears on file tracking: whether native edits wait
//! for approval (mode plus the user's Edit/Write allow rules) and whether Read deny rules,
//! managed settings or a linked worktree's main checkout restrict reads.
use serde_json::Value;
use std::path::{Path, PathBuf};

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
/// any Claude-family harness may pass `--allowedTools` or use another Claude config folder
/// (not followed: treated as allowing). The config folder is resolved exactly as for reads.
pub(super) fn claude_allows_edits(config: &crate::providers::RunConfig) -> bool {
    claude_allows_edits_with(
        config,
        || crate::connections::for_task(&config.session_id, &config.provider).is_some(),
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
    managed_settings: impl FnOnce() -> bool,
    claude_config_dir: impl FnOnce() -> Option<std::path::PathBuf>,
) -> bool {
    if !crate::providers::claude_family(&config.provider) {
        return false;
    }
    if has_connection() {
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
        || crate::connections::for_task(session_id, provider)
            .map(|connection| crate::connections::launch(&connection)).transpose(),
        host_managed_settings_restrict_reads,
        |env| launch_config_dir(crate::provider_settings::environment(provider), env, cwd),
    )
}

/// The Claude config folder of a launch whose environment is `provider_env` then
/// `connection_env`, in `Launch::apply` order (a connection's `HOME`, `USERPROFILE` or
/// `CLAUDE_CONFIG_DIR` overrides the saved provider environment).
pub(super) fn launch_config_dir(
    provider_env: Vec<(String, String)>, connection_env: &[(String, String)], cwd: &Path,
) -> Option<PathBuf> {
    let env: Vec<_> = provider_env.into_iter().chain(connection_env.iter().cloned()).collect();
    resolve_claude_config_dir_env(&env, cwd, cfg!(windows))
}

/// `config_dir` maps the connection's env (empty without one) to `launch_config_dir`.
pub(super) fn claude_restricts_reads_with(
    provider: &str,
    cwd: &Path,
    connection: impl FnOnce() -> std::result::Result<Option<crate::connections::Launch>, String>,
    managed_settings: impl FnOnce() -> bool,
    config_dir: impl FnOnce(&[(String, String)]) -> Option<PathBuf>,
) -> bool {
    if !crate::providers::claude_family(provider) {
        return false;
    }
    if managed_settings() {
        return true;
    }
    let connection_env = match connection() {
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

fn claude_config_dir_value(env: &[(String, String)], ignore_case: bool) -> Option<&str> {
    env.iter().rev().find_map(|(name, value)| {
        let matches = if ignore_case {
            name.eq_ignore_ascii_case("CLAUDE_CONFIG_DIR")
        } else {
            name == "CLAUDE_CONFIG_DIR"
        };
        matches.then_some(value.as_str())
    })
}

// Claude receives the raw value without shell expansion.
fn join_claude_config_dir(cwd: &Path, value: &str) -> Option<PathBuf> {
    (!value.is_empty()).then(|| cwd.join(value))
}

/// The Claude config folder a launch with `env` (over PandaCode's own environment) uses. A set
/// but empty `CLAUDE_CONFIG_DIR` is unknown (`None`, fail closed), never `<home>/.claude`.
pub(crate) fn resolve_claude_config_dir_env(
    env: &[(String, String)],
    cwd: &Path,
    ignore_case: bool,
) -> Option<PathBuf> {
    if let Some(value) = claude_config_dir_value(env, ignore_case) {
        return join_claude_config_dir(cwd, value);
    }
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(value) => (!value.is_empty()).then(|| cwd.join(value)),
        None => crate::account_config::home(env).map(|home| home.join(".claude")),
    }
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

/// The project folders whose Claude Code settings, memory and rules apply to a launch in `cwd`.
pub(crate) struct ProjectConfigRoots {
    /// Directories from `cwd` up to the nearest `.git` root (inclusive), or just `[cwd]` outside a repo.
    pub(crate) ancestors: Vec<PathBuf>,
    /// For a linked worktree, the main checkout root (omitted if already covered by `ancestors`).
    pub(crate) main_worktree: Option<PathBuf>,
    /// Non-NotFound error while probing `.git` or linked worktree metadata, if any.
    pub(crate) error: Option<&'static str>,
}

/// `cwd` through the nearest repository root and, for a linked worktree, its main checkout
/// (shared by `read_deny_rules` and the warm key). A `.git` probe that fails stops the walk at
/// that folder and reports the error.
pub(crate) fn project_config_roots(cwd: &Path) -> ProjectConfigRoots {
    let mut ancestors = Vec::new();
    let mut root = None;
    for ancestor in cwd.ancestors() {
        ancestors.push(ancestor.to_path_buf());
        match std::fs::symlink_metadata(ancestor.join(".git")) {
            Ok(_) => {
                root = Some(ancestor);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return ProjectConfigRoots { ancestors, main_worktree: None, error: Some("unreadable project root") },
        }
    }
    let Some(root) = root else {
        return ProjectConfigRoots { ancestors: vec![cwd.to_path_buf()], main_worktree: None, error: None };
    };
    let (main_worktree, error) = match linked_worktree_main_root(root) {
        Ok(main_root) => (main_root, None),
        Err(reason) => (None, Some(reason)),
    };
    let covered = |main_root: &PathBuf| ancestors.iter().any(|ancestor| {
        same_settings_directory(main_root, ancestor)
            || same_settings_directory(&main_root.join(".claude"), &ancestor.join(".claude"))
    });
    let main_worktree = main_worktree.filter(|main_root| !covered(main_root));
    ProjectConfigRoots { ancestors, main_worktree, error }
}

/// Where this host keeps Claude Code's enterprise settings files, or `None` when unknown.
pub(crate) fn host_managed_settings_paths() -> Option<Vec<PathBuf>> {
    #[cfg(target_os = "macos")]
    {
        Some(vec![PathBuf::from(
            "/Library/Application Support/ClaudeCode/managed-settings.json",
        )])
    }
    #[cfg(target_os = "linux")]
    {
        Some(vec![PathBuf::from(
            "/etc/claude-code/managed-settings.json",
        )])
    }
    #[cfg(windows)]
    {
        Some(windows_managed_settings_paths(
            std::env::var_os("ProgramFiles"),
            std::env::var_os("PROGRAMDATA"),
        ))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        None
    }
}

#[cfg(any(windows, test))]
fn windows_managed_settings_paths(
    program_files: Option<std::ffi::OsString>,
    program_data: Option<std::ffi::OsString>,
) -> Vec<PathBuf> {
    // Joined like the others so a `%ProgramFiles%` equal to the default deduplicates on every
    // platform's path rules.
    let mut paths = vec![PathBuf::from(r"C:\Program Files")
        .join("ClaudeCode")
        .join("managed-settings.json")];
    for root in [program_files, program_data]
        .into_iter()
        .flatten()
        .filter(|root| !root.is_empty())
    {
        let path = PathBuf::from(root)
            .join("ClaudeCode")
            .join("managed-settings.json");
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

pub(super) fn same_settings_directory(left: &Path, right: &Path) -> bool {
    left == right || left.canonicalize().ok().zip(right.canonicalize().ok())
        .is_some_and(|(left, right)| left == right)
}

/// Linked worktrees inherit the main checkout's local settings. Ordinary gitfiles (including
/// submodules) have no commondir, and bare common repositories have no main checkout.
pub(super) fn linked_worktree_main_root(root: &Path) -> std::result::Result<Option<PathBuf>, &'static str> {
    let gitfile = root.join(".git");
    match std::fs::symlink_metadata(&gitfile) {
        Ok(_) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && settings_path_absent(&gitfile) => return Ok(None),
        Err(_) => return Err("unreadable gitfile"),
    }
    let metadata = std::fs::metadata(&gitfile).map_err(|_| "unreadable gitfile")?;
    if metadata.is_dir() {
        return Ok(None);
    }
    let pointer = read_git_metadata(&gitfile)?;
    let gitdir = pointer.trim().strip_prefix("gitdir:").map(str::trim)
        .filter(|path| !path.is_empty()).ok_or("invalid gitfile")?;
    let gitdir = root.join(gitdir);
    if !std::fs::metadata(&gitdir).map_err(|_| "unreadable gitdir")?.is_dir() {
        return Err("invalid gitdir");
    }
    let commondir = gitdir.join("commondir");
    match std::fs::symlink_metadata(&commondir) {
        Ok(_) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && settings_path_absent(&commondir) => return Ok(None),
        Err(_) => return Err("unreadable commondir"),
    }
    let common = read_git_metadata(&commondir)?;
    let common = common.trim();
    if common.is_empty() {
        return Err("empty commondir");
    }
    let common = gitdir.join(common).canonicalize().map_err(|_| "unreadable common gitdir")?;
    if !common.is_dir() {
        return Err("invalid common gitdir");
    }
    let (bare, worktree) = git_core_checkout(&read_git_metadata(&common.join("config"))?)?;
    if let Some(worktree) = worktree {
        // Path handles native drive letters, separators and UNC prefixes on Windows. In
        // particular, do not split paths on ':' or replace backslashes with Unix separators.
        let worktree = Path::new(&worktree);
        let worktree = if worktree.is_absolute() { worktree.to_path_buf() } else { common.join(worktree) };
        let worktree = worktree.canonicalize().map_err(|_| "unreadable main checkout")?;
        if !worktree.is_dir() || std::fs::read_dir(&worktree).is_err() {
            return Err("invalid or unreadable main checkout");
        }
        return Ok(Some(worktree));
    }
    if bare {
        return Ok(None);
    }
    if common.file_name() == Some(std::ffi::OsStr::new(".git")) {
        return common.parent().map(|parent| Some(parent.to_path_buf()))
            .ok_or("missing main checkout parent");
    }
    Err("unknown main checkout for common gitdir")
}

/// Only an unsubsectioned [core] defines bare/worktree. Reject syntax we cannot safely
/// interpret rather than treating an ambiguous common directory as having no checkout.
pub(super) fn git_core_checkout(config: &str) -> std::result::Result<(bool, Option<String>), &'static str> {
    let (mut core, mut section, mut bare, mut worktree) = (false, false, false, None);
    for line in config.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(['#', ';']) {
            continue;
        }
        if line.contains('\0') {
            return Err("invalid git config character");
        }
        if let Some(header) = line.strip_prefix('[') {
            let (header, tail) = header.split_once(']').ok_or("invalid git config section")?;
            let tail = tail.trim();
            if !tail.is_empty() && !tail.starts_with(['#', ';']) {
                return Err("invalid git config section suffix");
            }
            let header = header.trim();
            let name_end = header.find(char::is_whitespace).unwrap_or(header.len());
            let (name, subsection) = header.split_at(name_end);
            if name.is_empty() || !name.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'.')) {
                return Err("invalid git config section name");
            }
            if name.eq_ignore_ascii_case("include") || name.eq_ignore_ascii_case("includeif") {
                return Err("unsupported git config include");
            }
            let subsection = subsection.trim();
            if !subsection.is_empty() {
                let inner = subsection.strip_prefix('"').and_then(|s| s.strip_suffix('"'))
                    .ok_or("invalid git config subsection")?;
                let mut escaped = false;
                for c in inner.chars() {
                    if escaped {
                        if !matches!(c, '\\' | '"') {
                            return Err("invalid git config subsection escape");
                        }
                        escaped = false;
                    } else if c == '\\' {
                        escaped = true;
                    } else if c == '"' {
                        return Err("invalid git config subsection quote");
                    }
                }
                if escaped {
                    return Err("unterminated git config subsection escape");
                }
            }
            core = name.eq_ignore_ascii_case("core") && subsection.is_empty();
            section = true;
            continue;
        }
        let key_end = line.find(|c: char| c == '=' || c.is_whitespace() || matches!(c, '#' | ';'))
            .unwrap_or(line.len());
        let (key, tail) = line.split_at(key_end);
        if !section || !key.starts_with(|c: char| c.is_ascii_alphabetic())
            || !key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err("invalid git config key");
        }
        let tail = tail.trim_start();
        let value = if let Some(value) = tail.strip_prefix('=') {
            Some(git_config_value(value.trim_start())?)
        } else if tail.is_empty() || tail.starts_with(['#', ';']) {
            None // A key without '=' is Git's implicit boolean true.
        } else {
            return Err("invalid git config assignment");
        };
        if core && key.eq_ignore_ascii_case("bare") {
            bare = match value.as_deref().map(str::to_ascii_lowercase).as_deref() {
                None | Some("true" | "yes" | "on" | "1") => true,
                Some("" | "false" | "no" | "off" | "0") => false,
                _ => return Err("invalid git core.bare"),
            };
        } else if core && key.eq_ignore_ascii_case("worktree") {
            let value = value.filter(|value| !value.is_empty()).ok_or("empty git core.worktree")?;
            worktree = Some(value);
        }
    }
    Ok((bare, worktree))
}

/// Decode Git's quoted values and escapes, preserving quoted whitespace and comment bytes.
/// Unsupported continuations/escapes fail closed; the entire config is already bounded.
pub(super) fn git_config_value(value: &str) -> std::result::Result<String, &'static str> {
    let mut decoded = String::new();
    let mut quoted = false;
    let mut significant = 0;
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '#' | ';' if !quoted => break,
            '\\' => {
                decoded.push(match chars.next() {
                    Some('\\') => '\\',
                    Some('"') => '"',
                    Some('n') => '\n',
                    Some('t') => '\t',
                    Some('b') => '\u{8}',
                    _ => return Err("invalid git config escape"),
                });
                significant = decoded.len();
            }
            _ => {
                decoded.push(c);
                if quoted || !c.is_whitespace() {
                    significant = decoded.len();
                }
            }
        }
    }
    if quoted {
        return Err("unterminated git config quote");
    }
    decoded.truncate(significant);
    Ok(decoded)
}

/// Git's small path-pointer files are bounded independently of JSON settings, even if they
/// grow after stat. Symlinks must resolve to readable regular files.
pub(super) fn read_git_metadata(path: &Path) -> std::result::Result<String, &'static str> {
    use std::io::Read;
    const LIMIT: u64 = 16 * 1024;
    let metadata = std::fs::metadata(path).map_err(|_| "unreadable worktree metadata")?;
    if !metadata.is_file() || metadata.len() > LIMIT {
        return Err("invalid worktree metadata file");
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path).and_then(|file| file.take(LIMIT + 1).read_to_end(&mut bytes))
        .map_err(|_| "unreadable worktree metadata")?;
    if bytes.len() as u64 > LIMIT {
        return Err("oversized worktree metadata");
    }
    String::from_utf8(bytes).map_err(|_| "invalid worktree metadata encoding")
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

#[cfg(windows)]
fn host_managed_settings_match(path_matches: impl FnMut(&Path) -> bool) -> bool {
    windows_managed_settings_match_with(
        std::env::var_os("ProgramFiles"),
        std::env::var_os("PROGRAMDATA"),
        path_matches,
        windows_registry_policy_status,
    )
}

#[cfg(not(windows))]
fn host_managed_settings_match(path_matches: impl FnMut(&Path) -> bool) -> bool {
    host_managed_settings_paths()
        .as_ref()
        .is_none_or(|paths| managed_entries_match(paths.iter().map(PathBuf::as_path), path_matches))
}

/// Windows policy files (and `.d` drop-ins) under `%ProgramFiles%` and `%PROGRAMDATA%`, then the
/// policy registry keys. Both probes are injected so every platform tests this exact function.
/// An unknown `PROGRAMDATA` (legacy policy location) fails closed.
#[cfg(any(windows, test))]
pub(super) fn windows_managed_settings_match_with(
    program_files: Option<std::ffi::OsString>,
    program_data: Option<std::ffi::OsString>,
    path_matches: impl FnMut(&Path) -> bool,
    registry_status: impl FnMut(u32, &str) -> i32,
) -> bool {
    if program_data.as_ref().is_none_or(|value| value.is_empty()) {
        return true;
    }
    let paths = windows_managed_settings_paths(program_files, program_data);
    managed_entries_match(paths.iter().map(PathBuf::as_path), path_matches)
        || windows_registry_policy_present(registry_status)
}

fn managed_entries_match<'a>(
    mut paths: impl Iterator<Item = &'a Path>,
    mut path_matches: impl FnMut(&Path) -> bool,
) -> bool {
    paths.any(|path| path_matches(path) || path_matches(&path.with_extension("d")))
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

#[cfg(any(windows, test))]
fn windows_registry_policy_present(mut registry_status: impl FnMut(u32, &str) -> i32) -> bool {
    // ERROR_FILE_NOT_FOUND alone proves absence. Success or any other error (including
    // access denied) requires the handshake.
    const HKEY_LOCAL_MACHINE: u32 = 0x8000_0002;
    const HKEY_CURRENT_USER: u32 = 0x8000_0001;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER]
        .into_iter()
        .any(|root| registry_status(root, r"SOFTWARE\Policies\ClaudeCode") != ERROR_FILE_NOT_FOUND)
}

#[cfg(windows)]
pub(super) fn windows_registry_policy_status(root: u32, path: &str) -> i32 {
    use std::ffi::c_void;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            key: *mut c_void,
            subkey: *const u16,
            options: u32,
            access: u32,
            result: *mut *mut c_void,
        ) -> i32;
        fn RegCloseKey(key: *mut c_void) -> i32;
    }
    const KEY_READ: u32 = 0x20019;
    const ERROR_SUCCESS: i32 = 0;
    let path: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let mut key = std::ptr::null_mut();
    // SAFETY: predefined HKEY constants are sign-extended from a 32-bit LONG, as in winreg.h.
    // The UTF-16 path is NUL-terminated, and the output handle stays valid until closed here.
    // KEY_READ (0x20019) only opens existing keys and does not modify enterprise policy.
    unsafe {
        let status = RegOpenKeyExW(
            root as i32 as isize as *mut c_void,
            path.as_ptr(),
            0,
            KEY_READ,
            &mut key,
        );
        if status == ERROR_SUCCESS {
            RegCloseKey(key);
        }
        status
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

/// A dangling symlink is an unreadable policy, not proof that no settings exist.
pub(super) fn settings_path_absent(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

/// The parsed file, `None` when it does not exist, or why it could not be read.
pub(super) fn read_settings(path: &std::path::Path) -> std::result::Result<Option<Value>, &'static str> {
    use std::io::Read;
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && settings_path_absent(path) => return Ok(None),
        Err(_) => return Err("unreadable"),
    };
    if !meta.is_file() {
        return Err("not a file");
    }
    if meta.len() > SETTINGS_LIMIT {
        return Err("too large");
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path).and_then(|file| file.take(SETTINGS_LIMIT + 1).read_to_end(&mut bytes)).map_err(|_| "unreadable")?;
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
    tool == "*" || EDIT_TOOLS.contains(&tool)
}
