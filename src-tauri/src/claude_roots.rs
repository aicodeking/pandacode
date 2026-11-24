//! Where Claude Code looks for its settings: the config folder a launch's environment selects,
//! the project folders from cwd through the repository root (and a linked worktree's main
//! checkout), and the host's managed (enterprise) policy locations. Pure discovery; what the
//! files say is judged in `turn_changes/claude_policy.rs`.
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub(crate) fn claude_config_dir_value(env: &[(String, String)], ignore_case: bool) -> Option<&str> {
    crate::account_config::last_value(env, "CLAUDE_CONFIG_DIR", ignore_case)
}

// Claude receives the raw value without shell expansion.
fn join_claude_config_dir(cwd: &Path, value: &str) -> Option<PathBuf> {
    (!value.is_empty()).then(|| cwd.join(value))
}

/// The Claude config folder a launch with `env` (over PandaCode's own environment) uses. Claude
/// Code resolves a set but empty `CLAUDE_CONFIG_DIR` relative to `cwd` (not `<home>/.claude`);
/// this deliberately returns `None` for it, so the permission and read policy checks fail
/// closed and warm-spare callers can tell an explicit empty value from an unset one.
pub(crate) fn resolve_claude_config_dir_env(
    env: &[(String, String)],
    cwd: &Path,
    ignore_case: bool,
) -> Option<PathBuf> {
    let inherited = std::env::var_os("CLAUDE_CONFIG_DIR");
    resolve_claude_config_dir_env_with(env, inherited.as_deref(), cwd, ignore_case)
}

/// `resolve_claude_config_dir_env` with PandaCode's own `CLAUDE_CONFIG_DIR` passed in as
/// `inherited`, so tests never depend on the process environment.
pub(crate) fn resolve_claude_config_dir_env_with(
    env: &[(String, String)],
    inherited: Option<&OsStr>,
    cwd: &Path,
    ignore_case: bool,
) -> Option<PathBuf> {
    if let Some(value) = claude_config_dir_value(env, ignore_case) {
        return join_claude_config_dir(cwd, value);
    }
    match inherited {
        Some(value) => (!value.is_empty()).then(|| cwd.join(value)),
        None => crate::account_config::home_with(env, ignore_case).map(|home| home.join(".claude")),
    }
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

pub(crate) fn same_settings_directory(left: &Path, right: &Path) -> bool {
    left == right || left.canonicalize().ok().zip(right.canonicalize().ok())
        .is_some_and(|(left, right)| left == right)
}

/// The first folder at or above `cwd` holding a `.git` (folder, gitfile or link), or `None` outside
/// a repository. A `.git` that cannot be probed is skipped: callers fall back to the enclosing one.
pub(crate) fn git_checkout_root(cwd: &Path) -> Option<PathBuf> {
    cwd.ancestors()
        .find(|ancestor| std::fs::symlink_metadata(ancestor.join(".git")).is_ok())
        .map(Path::to_path_buf)
}

/// The gitdir and common gitdir of the nearest checkout at or above `cwd` (`None` outside a repo):
/// a main checkout's `.git` folder is both; a linked worktree's gitfile leads to its own gitdir,
/// whose `commondir` names the shared one. An unfollowable `.git` or bad metadata is `Some(Err)`.
pub(crate) fn git_dirs_for(cwd: &Path) -> Option<std::result::Result<(PathBuf, PathBuf), &'static str>> {
    for ancestor in cwd.ancestors() {
        match std::fs::symlink_metadata(ancestor.join(".git")) {
            Ok(_) => return Some(gitdir_of(ancestor).and_then(|(gitdir, _)| {
                let common = commondir_of(&gitdir)?.unwrap_or_else(|| gitdir.clone());
                Ok((gitdir, common))
            })),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Some(Err("unreadable gitfile")),
        }
    }
    None
}

/// The git directory `root/.git` stands for, and whether a gitfile led there: the folder itself,
/// or the folder a gitfile's `gitdir:` line names (relative to `root`).
fn gitdir_of(root: &Path) -> std::result::Result<(PathBuf, bool), &'static str> {
    let dot_git = root.join(".git");
    if std::fs::metadata(&dot_git).map_err(|_| "unreadable gitfile")?.is_dir() {
        return Ok((dot_git, false));
    }
    let pointer = read_git_metadata(&dot_git)?;
    let gitdir = pointer.trim().strip_prefix("gitdir:").map(str::trim)
        .filter(|path| !path.is_empty()).ok_or("invalid gitfile")?;
    let gitdir = root.join(gitdir);
    if !std::fs::metadata(&gitdir).map_err(|_| "unreadable gitdir")?.is_dir() {
        return Err("invalid gitdir");
    }
    Ok((gitdir, true))
}

/// The common git directory `gitdir/commondir` names (relative to `gitdir`), or `None` when there
/// is no `commondir` (a main checkout, or an ordinary gitfile such as a submodule's).
fn commondir_of(gitdir: &Path) -> std::result::Result<Option<PathBuf>, &'static str> {
    let commondir = gitdir.join("commondir");
    match std::fs::symlink_metadata(&commondir) {
        Ok(_) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("unreadable commondir"),
    }
    let common = read_git_metadata(&commondir)?;
    let common = common.trim();
    if common.is_empty() {
        return Err("empty commondir");
    }
    Ok(Some(gitdir.join(common)))
}

/// Whether `root` is a linked worktree: its `.git` is a gitfile whose gitdir holds a `commondir`.
/// A main checkout (`.git` folder), a submodule (gitfile without `commondir`) or an unreadable
/// `.git` is not.
pub(crate) fn is_linked_worktree_root(root: &Path) -> bool {
    matches!(gitdir_of(root), Ok((gitdir, true)) if std::fs::symlink_metadata(gitdir.join("commondir")).is_ok())
}

/// Linked worktrees inherit the main checkout's local settings. Ordinary gitfiles (including
/// submodules) have no commondir, and bare common repositories have no main checkout.
pub(crate) fn linked_worktree_main_root(root: &Path) -> std::result::Result<Option<PathBuf>, &'static str> {
    let gitfile = root.join(".git");
    match std::fs::symlink_metadata(&gitfile) {
        Ok(_) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && settings_path_absent(&gitfile) => return Ok(None),
        Err(_) => return Err("unreadable gitfile"),
    }
    let (gitdir, true) = gitdir_of(root)? else { return Ok(None) };
    let Some(common) = commondir_of(&gitdir)? else { return Ok(None) };
    let common = common.canonicalize().map_err(|_| "unreadable common gitdir")?;
    if !common.is_dir() {
        return Err("invalid common gitdir");
    }
    let (bare, worktree) = read_git_core_checkout(&common.join("config"))?;
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
/// interpret rather than treating an ambiguous common directory as having no checkout. A config
/// held as text has no folder to resolve `[include] path` against, so any include fails closed
/// here; [`read_git_core_checkout`] follows them.
#[cfg(test)]
pub(crate) fn git_core_checkout(config: &str) -> std::result::Result<(bool, Option<String>), &'static str> {
    let mut checkout = (false, None);
    parse_git_config(config, None, &mut checkout)?;
    Ok(checkout)
}

/// Parses unsubsectioned `[core]` (`bare`, `worktree`) for the file at `config_path`, following
/// `[include] path`s as Git does: in place, relative to the including file's folder (`~/` from
/// home), at most `MAX_INCLUDE_DEPTH` deep in one shared `MAX_GIT_CONFIG_BYTES` budget. A missing
/// include is skipped like Git; an unreadable, oversize, cyclic or too-deep one fails closed, as
/// does any `[includeIf]`.
pub(crate) fn read_git_core_checkout(config_path: &Path) -> std::result::Result<(bool, Option<String>), &'static str> {
    let mut budget = IncludeBudget { remaining: MAX_GIT_CONFIG_BYTES, chain: Vec::new() };
    let mut checkout = (false, None);
    budget.parse_file(config_path, &mut checkout)?;
    Ok(checkout)
}

/// How deep `[include]` may nest below the common config.
const MAX_INCLUDE_DEPTH: usize = 4;

/// Bytes left to read across a config and its includes, and the canonical include chain being
/// parsed (a file already on it is a cycle; one included twice side by side is not).
struct IncludeBudget { remaining: u64, chain: Vec<PathBuf> }

impl IncludeBudget {
    fn parse_file(&mut self, path: &Path, checkout: &mut (bool, Option<String>)) -> std::result::Result<(), &'static str> {
        if self.chain.len() > MAX_INCLUDE_DEPTH {
            return Err("git config include too deep");
        }
        let canonical = path.canonicalize().map_err(|_| "unreadable worktree metadata")?;
        if self.chain.contains(&canonical) {
            return Err("cyclic git config include");
        }
        let config = read_git_file(path, self.remaining)?;
        self.remaining -= config.len() as u64;
        self.chain.push(canonical);
        let parsed = parse_git_config(&config, Some((path, &mut *self)), checkout);
        self.chain.pop();
        parsed
    }

    fn include(&mut self, base: &Path, value: &str, checkout: &mut (bool, Option<String>)) -> std::result::Result<(), &'static str> {
        let path = if let Some(rest) = value.strip_prefix("~/") {
            crate::account_config::home(&[]).ok_or("unknown home for git config include")?.join(rest)
        } else if value.starts_with('~') || value.starts_with("%(") {
            return Err("unsupported git config include path");
        } else {
            base.parent().ok_or("invalid git config include path")?.join(value)
        };
        if settings_path_absent(&path) {
            return Ok(()); // Git ignores an include whose file does not exist.
        }
        self.parse_file(&path, checkout)
    }
}

/// One config's lines in order, updating `checkout` and handing `[include] path` to `includes`
/// at the point it appears, so later assignments override included ones as in Git.
fn parse_git_config(config: &str, mut includes: Option<(&Path, &mut IncludeBudget)>, checkout: &mut (bool, Option<String>))
    -> std::result::Result<(), &'static str> {
    let (mut core, mut include, mut section) = (false, false, false);
    let mut lines = config.lines();
    while let Some(line) = lines.next() {
        let line = line.trim_start();
        if line.is_empty() || line.starts_with(['#', ';']) {
            continue;
        }
        if line.contains('\0') {
            return Err("invalid git config character");
        }
        if let Some(header) = line.strip_prefix('[') {
            let (name, subsectioned) = git_config_section(header)?;
            include = name.eq_ignore_ascii_case("include");
            if name.eq_ignore_ascii_case("includeif")
                || (include && (subsectioned || includes.is_none()))
            {
                return Err("unsupported git config include");
            }
            core = name.eq_ignore_ascii_case("core") && !subsectioned;
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
            let mut raw = value.to_owned();
            while git_config_continues(&raw) {
                raw.pop();
                let next = lines.next().ok_or("unterminated git config continuation")?;
                if next.contains('\0') {
                    return Err("invalid git config character");
                }
                raw.push_str(next);
            }
            Some(git_config_value(&raw)?)
        } else if tail.is_empty() || tail.starts_with(['#', ';']) {
            None // A key without '=' is Git's implicit boolean true.
        } else {
            return Err("invalid git config assignment");
        };
        if core && key.eq_ignore_ascii_case("bare") {
            checkout.0 = match value.as_deref().map(str::to_ascii_lowercase).as_deref() {
                None | Some("true" | "yes" | "on" | "1") => true,
                Some("" | "false" | "no" | "off" | "0") => false,
                _ => return Err("invalid git core.bare"),
            };
        } else if core && key.eq_ignore_ascii_case("worktree") {
            let value = value.filter(|value| !value.is_empty()).ok_or("empty git core.worktree")?;
            checkout.1 = Some(value);
        } else if include && key.eq_ignore_ascii_case("path") {
            let path = value.filter(|value| !value.is_empty()).ok_or("invalid git config include path")?;
            match &mut includes {
                None => return Err("unsupported git config include"),
                Some((base, budget)) => budget.include(base, &path, checkout)?,
            }
        }
    }
    Ok(())
}

/// A section header (the text after `[`): its name and whether it has a quoted subsection.
fn git_config_section(header: &str) -> std::result::Result<(&str, bool), &'static str> {
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
    Ok((name, !subsection.is_empty()))
}

/// Whether a raw value line ends in a continuation (`git-config(1)`): a final `\` that is not
/// itself escaped and not inside a comment. Quotes do not stop a continuation.
fn git_config_continues(value: &str) -> bool {
    let mut quoted = false;
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '#' | ';' if !quoted => return false,
            '\\' if chars.next().is_none() => return true, // An escape also consumes the next character.
            _ => (),
        }
    }
    false
}

/// Decode Git's quoted values and escapes, preserving quoted whitespace and comment bytes.
/// Leading unquoted whitespace is dropped and trailing unquoted whitespace trimmed, as in Git.
/// Unsupported escapes fail closed (continuations are joined by the caller); the entire config
/// is already bounded.
pub(crate) fn git_config_value(value: &str) -> std::result::Result<String, &'static str> {
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
            c if c.is_whitespace() && !quoted && decoded.is_empty() => (),
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

/// Bound for Git's small path-pointer files (`.git` gitfile, `commondir`).
const MAX_GIT_METADATA_BYTES: u64 = 16 * 1024;
/// Bound for a common `config` with its includes: a `[branch]` section per branch grows it far past
/// the pointer files (16 KiB is only ~180 branches), and an oversize one disables explore.
const MAX_GIT_CONFIG_BYTES: u64 = 1024 * 1024;

/// Git's small path-pointer files are bounded independently of JSON settings, even if they
/// grow after stat. Symlinks must resolve to readable regular files.
pub(crate) fn read_git_metadata(path: &Path) -> std::result::Result<String, &'static str> {
    read_git_file(path, MAX_GIT_METADATA_BYTES)
}

/// A regular UTF-8 file of at most `limit` bytes, checked at stat and again while reading.
fn read_git_file(path: &Path, limit: u64) -> std::result::Result<String, &'static str> {
    use std::io::Read;
    let metadata = std::fs::metadata(path).map_err(|_| "unreadable worktree metadata")?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("invalid worktree metadata file");
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path).and_then(|file| file.take(limit + 1).read_to_end(&mut bytes))
        .map_err(|_| "unreadable worktree metadata")?;
    if bytes.len() as u64 > limit {
        return Err("oversized worktree metadata");
    }
    String::from_utf8(bytes).map_err(|_| "invalid worktree metadata encoding")
}
#[cfg(windows)]
pub(crate) fn host_managed_settings_match(path_matches: impl FnMut(&Path) -> bool) -> bool {
    windows_managed_settings_match_with(
        std::env::var_os("ProgramFiles"),
        std::env::var_os("PROGRAMDATA"),
        path_matches,
        windows_registry_policy_status,
    )
}

#[cfg(not(windows))]
pub(crate) fn host_managed_settings_match(path_matches: impl FnMut(&Path) -> bool) -> bool {
    host_managed_settings_paths()
        .as_ref()
        .is_none_or(|paths| managed_entries_match(paths.iter().map(PathBuf::as_path), path_matches))
}

/// Windows policy files (and `.d` drop-ins) under `%ProgramFiles%` and `%PROGRAMDATA%`, then the
/// policy registry keys. Both probes are injected so every platform tests this exact function.
/// An unknown `PROGRAMDATA` (legacy policy location) fails closed.
#[cfg(any(windows, test))]
pub(crate) fn windows_managed_settings_match_with(
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

pub(crate) fn managed_entries_match<'a>(
    mut paths: impl Iterator<Item = &'a Path>,
    mut path_matches: impl FnMut(&Path) -> bool,
) -> bool {
    paths.any(|path| path_matches(path) || path_matches(&path.with_extension("d")))
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
pub(crate) fn windows_registry_policy_status(root: u32, path: &str) -> i32 {
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
/// A dangling symlink is an unreadable policy, not proof that no settings exist.
pub(crate) fn settings_path_absent(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("pandacode-claude-roots-{name}-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect()
    }

    #[test]
    fn the_config_dir_override_wins_and_an_explicit_empty_one_is_unknown() {
        let scratch = Scratch::new("env");
        let cwd = scratch.0.join("project");
        let custom = scratch.0.join("custom-claude");
        let home = scratch.0.join("home");
        let home_env = [("HOME", home.to_str().unwrap()), ("USERPROFILE", home.to_str().unwrap())];
        // An explicit override (absolute or relative to the launch's cwd) beats the inherited value and home.
        let with = |pairs: &[(&str, &str)]| env(&[&home_env[..], pairs].concat());
        let inherited = Some(OsStr::new("inherited"));
        assert_eq!(resolve_claude_config_dir_env_with(&with(&[("CLAUDE_CONFIG_DIR", custom.to_str().unwrap())]), inherited, &cwd, false), Some(custom.clone()));
        assert_eq!(resolve_claude_config_dir_env_with(&with(&[("CLAUDE_CONFIG_DIR", "relative")]), None, &cwd, false), Some(cwd.join("relative")));
        // Set but empty (in the launch or inherited) is not the same as unset: unknown, so callers fail closed.
        assert_eq!(resolve_claude_config_dir_env_with(&with(&[("CLAUDE_CONFIG_DIR", "")]), inherited, &cwd, false), None);
        assert_eq!(resolve_claude_config_dir_env_with(&with(&[]), Some(OsStr::new("")), &cwd, false), None);
        // Inherited from PandaCode's own environment when the launch sets none.
        assert_eq!(resolve_claude_config_dir_env_with(&with(&[]), inherited, &cwd, false), Some(cwd.join("inherited")));
        // Unset everywhere: `<home>/.claude`.
        assert_eq!(resolve_claude_config_dir_env_with(&with(&[]), None, &cwd, false), Some(home.join(".claude")));
        // Windows matches variable names case-insensitively; elsewhere a lowercase name is another variable.
        let lower = with(&[("claude_config_dir", custom.to_str().unwrap())]);
        assert_eq!(resolve_claude_config_dir_env_with(&lower, None, &cwd, true), Some(custom));
        assert_eq!(resolve_claude_config_dir_env_with(&lower, None, &cwd, false), Some(home.join(".claude")));
    }

    #[test]
    fn only_a_missing_registry_policy_key_proves_absence() {
        const NOT_FOUND: i32 = 2;
        const ACCESS_DENIED: i32 = 5;
        let mut asked = Vec::new();
        assert!(!windows_registry_policy_present(|root, path| {
            asked.push((root, path.to_owned()));
            NOT_FOUND
        }));
        assert_eq!(asked.len(), 2, "both HKLM and HKCU are probed");
        assert!(asked.iter().all(|(_, path)| path == r"SOFTWARE\Policies\ClaudeCode"));
        assert!(windows_registry_policy_present(|_, _| 0), "an existing policy key is present");
        assert!(windows_registry_policy_present(|root, _| if root == 0x8000_0001 { 0 } else { NOT_FOUND }), "a user policy key counts too");
        assert!(windows_registry_policy_present(|_, _| ACCESS_DENIED), "an unreadable key fails closed");
    }

    #[test]
    fn a_settings_path_is_absent_only_when_nothing_is_there() {
        let scratch = Scratch::new("absent");
        let file = scratch.0.join("managed-settings.json");
        assert!(settings_path_absent(&file));
        std::fs::write(&file, "{}").unwrap();
        assert!(!settings_path_absent(&file));
        assert!(!settings_path_absent(&scratch.0), "a folder is not absent");
    }

    #[test]
    fn a_plain_repo_walks_to_its_root_and_has_no_main_checkout() {
        let scratch = Scratch::new("plain");
        let repo = scratch.0.join("repo");
        let nested = repo.join("src").join("deep");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        let roots = project_config_roots(&nested);
        assert_eq!(roots.ancestors, vec![nested.clone(), repo.join("src"), repo.clone()]);
        assert_eq!(roots.main_worktree, None);
        assert_eq!(roots.error, None);
        assert_eq!(linked_worktree_main_root(&repo), Ok(None), "a `.git` folder is the main checkout itself");
        assert_eq!(linked_worktree_main_root(&scratch.0), Ok(None), "no `.git` at all");
    }

    #[test]
    fn a_linked_worktrees_gitdir_file_leads_to_its_main_checkout() {
        let scratch = Scratch::new("linked");
        let main = scratch.0.join("main");
        let admin = main.join(".git").join("worktrees").join("wt");
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::write(main.join(".git").join("config"), "[core]\n\tbare = false\n").unwrap();
        std::fs::write(admin.join("commondir"), "../..\n").unwrap();
        let worktree = scratch.0.join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
        let main_root = main.canonicalize().unwrap();
        assert_eq!(linked_worktree_main_root(&worktree), Ok(Some(main_root.clone())));
        let roots = project_config_roots(&worktree);
        assert_eq!(roots.ancestors, vec![worktree.clone()]);
        assert_eq!(roots.main_worktree, Some(main_root));
        assert_eq!(roots.error, None);
        // A gitfile pointing nowhere is an error, never silently "no main checkout".
        std::fs::write(worktree.join(".git"), "gitdir: missing\n").unwrap();
        assert_eq!(linked_worktree_main_root(&worktree), Err("unreadable gitdir"));
        // An ordinary gitfile (a submodule's) has no commondir and so no main checkout.
        std::fs::remove_file(admin.join("commondir")).unwrap();
        std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
        assert_eq!(linked_worktree_main_root(&worktree), Ok(None));
    }

    #[test]
    fn only_a_gitfile_with_a_commondir_is_a_linked_worktree() {
        let scratch = Scratch::new("is-linked");
        let main = scratch.0.join("main");
        let admin = main.join(".git").join("worktrees").join("wt");
        let module = main.join(".git").join("modules").join("sub");
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::create_dir_all(&module).unwrap();
        std::fs::write(admin.join("commondir"), "../..\n").unwrap();
        let worktree = scratch.0.join("wt");
        let submodule = main.join("sub");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::create_dir_all(&submodule).unwrap();
        std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
        std::fs::write(submodule.join(".git"), "gitdir: ../.git/modules/sub\n").unwrap();
        assert!(is_linked_worktree_root(&worktree));
        assert!(!is_linked_worktree_root(&main), "a `.git` folder is a main checkout");
        assert!(!is_linked_worktree_root(&submodule), "a submodule's gitfile has no commondir");
        assert!(!is_linked_worktree_root(&scratch.0), "no `.git` at all");
    }

    #[test]
    fn a_large_common_config_still_resolves_and_an_oversize_one_fails_closed() {
        let scratch = Scratch::new("large-config");
        let main = scratch.0.join("main");
        let admin = main.join(".git").join("worktrees").join("wt");
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::write(admin.join("commondir"), "../..\n").unwrap();
        let worktree = scratch.0.join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
        // One section per branch, as `git worktree add -b` with upstream tracking leaves them.
        let branches: String = (0..250)
            .map(|n| format!("[branch \"pandacode/wt-{n}\"]\n\tremote = origin\n\tmerge = refs/heads/pandacode/wt-{n}\n\tvscode-merge-base = origin/main\n"))
            .collect();
        let config = format!("{branches}[core]\n\tbare = false\n");
        assert!(config.len() > 20 * 1024, "well past the 16 KiB pointer-file bound: {} bytes", config.len());
        let config_path = main.join(".git").join("config");
        std::fs::write(&config_path, &config).unwrap();
        let main_root = main.canonicalize().unwrap();
        assert_eq!(linked_worktree_main_root(&worktree), Ok(Some(main_root.clone())));
        assert_eq!(project_config_roots(&worktree).main_worktree, Some(main_root));
        // The pointer files keep their small bound.
        assert_eq!(read_git_metadata(&config_path), Err("invalid worktree metadata file"));
        // Past 1 MiB the config is refused, never read as "no main checkout".
        let comments = "# padding\n".repeat((MAX_GIT_CONFIG_BYTES as usize) / 10 + 1);
        std::fs::write(&config_path, format!("{comments}{config}")).unwrap();
        assert_eq!(linked_worktree_main_root(&worktree), Err("invalid worktree metadata file"));
        assert_eq!(project_config_roots(&worktree).error, Some("invalid worktree metadata file"));
    }

    #[test]
    fn git_dirs_follow_plain_repos_subfolders_and_linked_worktrees() {
        let scratch = Scratch::new("git-dirs");
        assert_eq!((git_dirs_for(&scratch.0), git_checkout_root(&scratch.0)), (None, None), "outside a repository");
        let repo = scratch.0.join("repo");
        let (dot_git, deep, worktree) = (repo.join(".git"), repo.join("src").join("deep"), scratch.0.join("wt"));
        let admin = dot_git.join("worktrees").join("wt");
        for dir in [&admin, &deep, &worktree.join("src")] { std::fs::create_dir_all(dir).unwrap(); }
        for cwd in [&repo, &deep] {
            assert_eq!(git_dirs_for(cwd), Some(Ok((dot_git.clone(), dot_git.clone()))), "{cwd:?}");
            assert_eq!(git_checkout_root(cwd), Some(repo.clone()));
        }
        std::fs::write(admin.join("commondir"), "../..\n").unwrap();
        std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
        assert_eq!(git_dirs_for(&worktree.join("src")), Some(Ok((admin.clone(), admin.join("../..")))));
        assert_eq!(git_checkout_root(&worktree.join("src")), Some(worktree.clone()));
        std::fs::write(admin.join("commondir"), " \n").unwrap();
        assert_eq!(git_dirs_for(&worktree), Some(Err("empty commondir")));
        std::fs::write(worktree.join(".git"), "nonsense\n").unwrap();
        assert_eq!(git_dirs_for(&worktree), Some(Err("invalid gitfile")));
    }

    #[test]
    fn git_config_values_continue_after_an_unescaped_trailing_backslash() {
        let main = Ok((false, Some("../main".to_owned())));
        for config in ["[core]\n worktree = ../ma\\\nin\n", "[core]\r\n worktree = \"../ma\\\r\nin\" # c\r\n", "[core]\n worktree = \\\n  ../main\n"] {
            assert_eq!(git_core_checkout(config), main, "{config:?}");
        }
        // A continued value in another section swallows what would otherwise be a `[core]` header.
        assert_eq!(git_core_checkout("[remote \"origin\"]\n url = a\\\n[core]\n worktree = ../main\n"), Ok((false, None)));
        // Neither a backslash in a comment nor an escaped one continues; a dangling one at the end fails closed.
        assert_eq!(git_core_checkout("[core]\n bare = true # note \\\n worktree = ../main\n"), Ok((true, Some("../main".to_owned()))));
        assert_eq!(git_core_checkout("[core]\n worktree = C:\\\\\n bare\n"), Ok((true, Some("C:\\".to_owned()))));
        assert_eq!(git_core_checkout("[core]\n worktree = a\\"), Err("unterminated git config continuation"));
    }

    #[test]
    fn git_config_includes_apply_in_place_skip_missing_files_and_refuse_cycles() {
        let scratch = Scratch::new("include");
        let (config, extra) = (scratch.0.join("config"), scratch.0.join("extra").join("checkout.config"));
        std::fs::create_dir_all(scratch.0.join("extra")).unwrap();
        std::fs::write(&extra, "[core]\n\tworktree = ../main\n").unwrap();
        let text = "[core]\n bare = true\n[InClUdE]\n PaTh = extra/checkout.config\n path = missing.config\n";
        std::fs::write(&config, text).unwrap();
        assert_eq!(read_git_core_checkout(&config), Ok((true, Some("../main".to_owned()))));
        assert_eq!(git_core_checkout(text), Err("unsupported git config include"), "text alone has no folder to resolve against");
        // Later lines override included ones, as if the file were pasted in place.
        std::fs::write(&config, "[include]\n path = extra/checkout.config\n[core]\n worktree = ../other\n").unwrap();
        assert_eq!(read_git_core_checkout(&config), Ok((false, Some("../other".to_owned()))));
        std::fs::write(&extra, "[include]\n path = ../config\n").unwrap();
        assert_eq!(read_git_core_checkout(&config), Err("cyclic git config include"));
        std::fs::write(&config, "[includeIf \"gitdir:/x/\"]\n path = missing.config\n").unwrap();
        assert_eq!(read_git_core_checkout(&config), Err("unsupported git config include"));
        // d2 through d5 nest four deep (d6 is missing); starting at d1 is one too many.
        (1..=5).for_each(|n| std::fs::write(scratch.0.join(format!("d{n}")), format!("[include]\n path = d{}\n", n + 1)).unwrap());
        std::fs::write(&config, "[include]\n path = d2\n").unwrap();
        assert_eq!(read_git_core_checkout(&config), Ok((false, None)));
        std::fs::write(&config, "[include]\n path = d1\n").unwrap();
        assert_eq!(read_git_core_checkout(&config), Err("git config include too deep"));
    }
}
