//! Where Claude Code looks for its settings: the config folder a launch's environment selects,
//! the project folders from cwd through the repository root (and a linked worktree's main
//! checkout), and the host's managed (enterprise) policy locations. Pure discovery; what the
//! files say is judged in `claude_policy.rs`.
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

/// Linked worktrees inherit the main checkout's local settings. Ordinary gitfiles (including
/// submodules) have no commondir, and bare common repositories have no main checkout.
pub(crate) fn linked_worktree_main_root(root: &Path) -> std::result::Result<Option<PathBuf>, &'static str> {
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
pub(crate) fn git_core_checkout(config: &str) -> std::result::Result<(bool, Option<String>), &'static str> {
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
pub(crate) fn read_git_metadata(path: &Path) -> std::result::Result<String, &'static str> {
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
