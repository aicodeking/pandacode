use serde::Serialize;
mod file_search;
mod text_search;
pub use file_search::search_files;
pub use text_search::{search_text, TextSearchResult};
/// Build output and version-control folders that no listing should walk into.
pub(crate) fn excluded_entry(name: &str, directory: bool) -> bool {
    file_search::excluded(std::ffi::OsStr::new(name), directory)
}
use std::{
    collections::{BinaryHeap, HashMap},
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const FILE_LIMIT: usize = 128 * 1024;
const DIFF_LIMIT: usize = 256 * 1024;
const STATUS_LIMIT: usize = 1024 * 1024;
const FILE_COUNT_LIMIT: usize = 5000;
const TRUNCATED: &str = "\n\n[Preview truncated at 256 KiB]\n";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    pub index: String,
    pub working: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub files: Vec<GitFile>,
    pub is_repo: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug)]
enum PathError {
    Rejected(&'static str),
    Io(std::io::Error),
}
impl std::fmt::Display for PathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(message) => f.write_str(message),
            Self::Io(error) => error.fmt(f),
        }
    }
}

fn scoped_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    resolve_scoped_path(root, value).map_err(|e| e.to_string())
}

/// Resolve a relative project path, checking existing ancestors even for deleted files.
fn resolve_scoped_path(root: &Path, value: &str) -> Result<PathBuf, PathError> {
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        return Err(PathError::Rejected("Invalid project path"));
    }
    let relative = Path::new(value);
    for part in relative.components() {
        match part {
            Component::Normal(name) if name != ".git" => {}
            Component::CurDir => {}
            _ => return Err(PathError::Rejected("Path must stay inside the project")),
        }
    }
    let candidate = root.join(relative);
    let mut ancestor = candidate.as_path();
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => {
                let resolved = fs::canonicalize(ancestor).map_err(PathError::Io)?;
                if !resolved.starts_with(root) {
                    return Err(PathError::Rejected("Symlink points outside the project"));
                }
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor
                    .parent()
                    .ok_or(PathError::Rejected("Invalid project path"))?;
            }
            Err(e) => return Err(PathError::Io(e)),
        }
    }
    Ok(candidate)
}

/// Resolve an agent- or user-supplied path onto one of a task's folders
/// (storage::RepoFolder as Store::workspace_folders builds it). Relative input
/// means the primary folder, resolved exactly as scoped_path does for a
/// single-folder task. Absolute input joins the one folder that contains it —
/// the longest matching path wins for nested folders — and must stay inside it
/// after symlinks resolve, judged against that folder alone.
pub fn resolve_in_folders(
    folders: &[crate::storage::RepoFolder],
    input: &str,
) -> Result<(usize, PathBuf), String> {
    if !Path::new(input).is_absolute() {
        let primary = folders
            .iter()
            .position(|folder| folder.is_primary)
            .or_else(|| (!folders.is_empty()).then_some(0))
            .ok_or_else(|| "This task has no folders.".to_string())?;
        return scoped_path(&folders[primary].path, input).map(|path| (primary, path));
    }
    let candidate = Path::new(input);
    let mut best: Option<(usize, &PathBuf)> = None;
    for (index, folder) in folders.iter().enumerate() {
        let Ok(relative) = candidate.strip_prefix(&folder.path) else {
            continue;
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        if best.is_none_or(|(_, path)| folder.path.as_os_str().len() > path.as_os_str().len()) {
            best = Some((index, &folder.path));
        }
    }
    let Some((index, root)) = best else {
        let named = folders
            .iter()
            .map(|folder| folder.path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!("Path is outside this task's folders: {named}"));
    };
    for part in candidate.components() {
        match part {
            Component::Normal(name) if name != ".git" => {}
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => {}
            _ => return Err("Path must stay inside the project".into()),
        }
    }
    let mut ancestor = candidate;
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => {
                let resolved = fs::canonicalize(ancestor).map_err(|e| e.to_string())?;
                if !resolved.starts_with(root) {
                    return Err("Symlink points outside the folder".into());
                }
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| "Invalid project path".to_string())?;
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok((index, candidate.to_path_buf()))
}

pub(crate) struct Capture {
    pub(crate) bytes: Vec<u8>,
    pub(crate) truncated: bool,
}
pub(crate) struct GitOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Capture,
    pub(crate) stderr: Capture,
}

fn capture(
    mut pipe: impl Read + Send + 'static,
    limit: usize,
) -> mpsc::Receiver<Result<Capture, String>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = (|| {
            let mut bytes = Vec::with_capacity(limit.min(8192));
            let mut buffer = [0; 8192];
            let mut truncated = false;
            loop {
                let size = pipe.read(&mut buffer).map_err(|e| e.to_string())?;
                if size == 0 {
                    break;
                }
                let keep = size.min(limit.saturating_sub(bytes.len()));
                bytes.extend_from_slice(&buffer[..keep]);
                truncated |= keep < size;
            }
            Ok(Capture { bytes, truncated })
        })();
        let _ = sender.send(result);
    });
    receiver
}

/// Drain both pipes while retaining fixed byte budgets. Git inspection never invokes
/// external diff, fsmonitor, or repository hooks; explicit commits retain normal hooks.
fn run_git(root: &Path, args: &[&str], limit: usize, commit: bool) -> Result<GitOutput, String> {
    run_git_bounded(
        root,
        args,
        limit,
        commit,
        Duration::from_secs(if commit { 120 } else { 30 }),
    )
}
pub(crate) fn run_git_bounded(
    root: &Path,
    args: &[&str],
    limit: usize,
    commit: bool,
    timeout: Duration,
) -> Result<GitOutput, String> {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command.args([
        "--no-pager",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "color.ui=false",
    ]);
    if !commit {
        command.args(["-c", "core.hooksPath=/dev/null"]);
    }
    command
        .arg("-C")
        .arg(git_path(root))
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_EDITOR", "true")
        .env("LC_ALL", "C");
    run_process(command, "Git", limit, timeout)
}

/// Run a prepared external command with a null stdin, byte-bounded pipes, and a
/// deadline that also stops the process group, so no tool can hold the app.
pub(crate) fn run_process(
    command: Command,
    tool: &str,
    limit: usize,
    timeout: Duration,
) -> Result<GitOutput, String> {
    run_bounded(command, tool, limit, 16 * 1024, timeout, None)
}

/// Like `run_process`, but feeds `input` to stdin (from a thread, then closes it) and keeps
/// up to `limit` bytes of stderr too, for tools that report their errors there.
pub(crate) fn run_process_with_input(
    command: Command,
    tool: &str,
    limit: usize,
    timeout: Duration,
    input: Option<&[u8]>,
) -> Result<GitOutput, String> {
    run_bounded(command, tool, limit, limit, timeout, input)
}

fn run_bounded(
    mut command: Command,
    tool: &str,
    limit: usize,
    stderr_limit: usize,
    timeout: Duration,
    input: Option<&[u8]>,
) -> Result<GitOutput, String> {
    crate::child_env::sanitize(&mut command);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start {tool}: {e}"))?;
    let process_id = child.id();
    #[cfg(windows)]
    let _job = crate::providers::windows_job::Job::attach(process_id);
    if let (Some(mut stdin), Some(input)) = (child.stdin.take(), input) {
        let input = input.to_vec();
        // A process that exits without reading gives a broken pipe; its status tells the story.
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let stdout = capture(
        child
            .stdout
            .take()
            .ok_or(format!("Missing {tool} stdout"))?,
        limit,
    );
    let stderr = capture(
        child
            .stderr
            .take()
            .ok_or(format!("Missing {tool} stderr"))?,
        stderr_limit,
    );
    let deadline = Instant::now() + timeout;
    // Most git calls finish in a few ms; back off from 1 ms so they aren't rounded up to 10.
    let mut pause = Duration::from_millis(1);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(pause);
                pause = (pause * 2).min(Duration::from_millis(10));
            }
            Ok(None) => {
                stop_process_group(process_id);
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{tool} operation timed out. Check the repository before retrying."
                ));
            }
            Err(e) => {
                stop_process_group(process_id);
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
    };
    let stdout = stdout
        .recv_timeout(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_secs(1)),
        )
        .map_err(|_| {
            stop_process_group(process_id);
            format!("{tool} output stream did not close")
        })??;
    let stderr = stderr
        .recv_timeout(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_secs(1)),
        )
        .map_err(|_| {
            stop_process_group(process_id);
            format!("{tool} error stream did not close")
        })??;
    Ok(GitOutput {
        status,
        stdout,
        stderr,
    })
}

/// Read-only index enumeration: no refresh, checkout, filters, refs, or index writes.
#[cfg(test)]
pub(crate) type TurnSnapshotPaths = (Vec<String>, Vec<String>, bool);
#[cfg(test)]
pub(crate) fn turn_snapshot_paths(
    root: &Path,
    deadline: Instant,
) -> Result<Option<TurnSnapshotPaths>, String> {
    let remaining = || {
        deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| "Change tracking exceeded its time budget.".to_owned())
    };
    let output = run_git_bounded(
        root,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        1024 * 1024,
        false,
        remaining()?,
    )?;
    if !output.status.success() {
        if String::from_utf8_lossy(&output.stderr.bytes).contains("not a git repository") {
            return Ok(None);
        }
        return checked(output).map(|_| None);
    }
    let mut truncated = output.stdout.truncated;
    let mut parse = |bytes: &[u8]| {
        let end = bytes.iter().rposition(|b| *b == 0).map_or(0, |i| i + 1);
        if end < bytes.len() {
            truncated = true;
        }
        bytes[..end]
            .split(|c| *c == 0)
            .filter(|s| !s.is_empty())
            .filter_map(|s| match std::str::from_utf8(s) {
                Ok(path) => Some(path.to_owned()),
                Err(_) => {
                    truncated = true;
                    None
                }
            })
            .collect::<Vec<_>>()
    };
    let paths = parse(&output.stdout.bytes);
    let ignored = run_git_bounded(
        root,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ],
        1024 * 1024,
        false,
        remaining()?,
    )?;
    let ignored = checked(ignored)?;
    let excluded = parse(&ignored.bytes);
    truncated |= ignored.truncated;
    Ok(Some((paths, excluded, truncated)))
}

fn stop_process_group(process_id: u32) {
    #[cfg(unix)]
    // Each Git command owns a fresh group, so timeout cleanup includes its hooks.
    unsafe {
        libc::kill(-(process_id as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill.exe");
        command.creation_flags(0x08000000);
        let _ = command.args(["/PID", &process_id.to_string(), "/T", "/F"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    #[cfg(not(any(unix, windows)))]
    let _ = process_id;
}

pub(crate) fn checked(output: GitOutput) -> Result<Capture, String> {
    if output.status.success() {
        return Ok(output.stdout);
    }
    let message = String::from_utf8_lossy(&output.stderr.bytes)
        .trim()
        .to_string();
    Err(if message.is_empty() {
        "Git operation failed".into()
    } else {
        message
    })
}

fn repository_root(root: &Path) -> Result<bool, String> {
    let output = run_git(root, &["rev-parse", "--show-toplevel"], 8192, false)?;
    if !output.status.success() {
        // Only a genuine non-repository is an empty Git state. Permission errors,
        // broken configuration, and other failures must remain visible to users.
        if String::from_utf8_lossy(&output.stderr.bytes)
            .trim_start()
            .starts_with("fatal: not a git repository")
        {
            return Ok(false);
        }
        return checked(output).map(|_| false);
    }
    let path = std::str::from_utf8(&output.stdout.bytes)
        .map_err(|_| "Repository path is not UTF-8")?
        .trim_end_matches('\n');
    Ok(fs::canonicalize(path).map_err(|e| e.to_string())? == root)
}

const REPOSITORY_TTL: Duration = Duration::from_secs(30);

/// Roots that `rev-parse` recently confirmed, so repeated diffs skip a process.
fn verified_repositories() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static VERIFIED: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    VERIFIED.get_or_init(Default::default)
}

fn forget_repository(root: &Path) {
    if let Ok(mut verified) = verified_repositories().lock() {
        verified.remove(root);
    }
}

fn require_repository(root: &Path) -> Result<(), String> {
    if is_repository(root)? {
        Ok(())
    } else {
        Err("Open the Git repository's root folder to use Git actions".into())
    }
}

/// `repository_root`, remembered for `REPOSITORY_TTL` while `.git` still looks intact.
pub(crate) fn is_repository(root: &Path) -> Result<bool, String> {
    let fresh = verified_repositories()
        .lock()
        .is_ok_and(|verified| verified.get(root).is_some_and(|at| at.elapsed() < REPOSITORY_TTL));
    // The `.git` check catches a repository removed or moved since it was verified, which
    // would otherwise let Git fall back to an enclosing repository.
    let git = root.join(".git");
    if fresh && (git.is_file() || git.join("HEAD").is_file()) {
        return Ok(true);
    }
    forget_repository(root);
    let repository = repository_root(root)?;
    if repository {
        if let Ok(mut verified) = verified_repositories().lock() {
            verified.insert(root.to_path_buf(), Instant::now());
        }
    }
    Ok(repository)
}

pub fn git_status(root: &Path) -> Result<GitStatus, String> {
    if !is_repository(root)? {
        return Ok(GitStatus {
            branch: String::new(),
            files: vec![],
            is_repo: false,
        });
    }
    let status = read_status(root);
    if status.is_err() {
        // As in `git_diff`: a failure may mean the repository is gone.
        forget_repository(root);
    }
    status
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub label: String,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusAll {
    pub branch: String,
    pub files: Vec<GitFile>,
    pub is_repo: bool,
    pub repos: Vec<RepoStatus>,
}

/// Ahead/behind against the upstream; a checkout without one reports 0/0.
fn ahead_behind(root: &Path) -> (u32, u32) {
    let Ok(output) = run_git(
        root,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        8192,
        false,
    ) else {
        return (0, 0);
    };
    if !output.status.success() {
        return (0, 0);
    }
    let counts = String::from_utf8_lossy(&output.stdout.bytes);
    let mut parts = counts.split_whitespace();
    let ahead = parts.next().and_then(|value| value.parse().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|value| value.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

/// One status entry per folder of a task, in folder order, each read from its
/// effective checkout; plain folders report nothing. The top level keeps
/// mirroring the primary repository exactly as the single-repo payload.
pub fn git_status_all(folders: &[crate::storage::RepoFolder]) -> GitStatusAll {
    let mut entries: Vec<(bool, RepoStatus)> = Vec::with_capacity(folders.len());
    for folder in folders {
        let label = folder.label.clone();
        let entry = match git_status(&folder.path) {
            Ok(status) if status.is_repo => {
                let (ahead, behind) = ahead_behind(&folder.path);
                (
                    true,
                    RepoStatus {
                        label,
                        branch: status.branch,
                        ahead,
                        behind,
                        files: status.files,
                    },
                )
            }
            _ => (
                false,
                RepoStatus {
                    label,
                    branch: String::new(),
                    ahead: 0,
                    behind: 0,
                    files: Vec::new(),
                },
            ),
        };
        entries.push(entry);
    }
    let primary = entries.first();
    GitStatusAll {
        branch: primary.map_or_else(String::new, |(_, repo)| repo.branch.clone()),
        files: primary.map_or_else(Vec::new, |(_, repo)| repo.files.clone()),
        is_repo: primary.is_some_and(|(is_repo, _)| *is_repo),
        repos: entries.into_iter().map(|(_, repo)| repo).collect(),
    }
}

/// `git status` for a root already known to be the repository root.
fn read_status(root: &Path) -> Result<GitStatus, String> {
    let output = checked(run_git(
        root,
        &[
            "status",
            "--porcelain=v1",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
        STATUS_LIMIT,
        false,
    )?)?;
    if output.truncated {
        return Err("Git status exceeds the 1 MiB inspection limit".into());
    }
    let mut parts = output
        .bytes
        .split(|byte| *byte == 0)
        .filter(|v| !v.is_empty());
    let mut branch = String::new();
    let mut files = Vec::new();
    while let Some(entry) = parts.next() {
        if entry.starts_with(b"## ") {
            let header =
                std::str::from_utf8(&entry[3..]).map_err(|_| "Branch name is not UTF-8")?;
            branch = header
                .strip_prefix("No commits yet on ")
                .or_else(|| header.strip_prefix("Initial commit on "))
                .unwrap_or(header)
                .split("...")
                .next()
                .unwrap_or(header)
                .to_string();
            continue;
        }
        if entry.len() < 4 || entry[2] != b' ' {
            return Err("Invalid Git status response".into());
        }
        let path = std::str::from_utf8(&entry[3..])
            .map_err(|_| "A changed filename is not UTF-8")?
            .to_string();
        files.push(GitFile {
            path,
            index: char::from(entry[0]).to_string(),
            working: char::from(entry[1]).to_string(),
        });
        if matches!(entry[0], b'R' | b'C') || matches!(entry[1], b'R' | b'C') {
            parts.next().ok_or("Incomplete Git rename record")?;
        }
        if files.len() > FILE_COUNT_LIMIT {
            return Err("More than 5,000 changed files; use Git in the terminal".into());
        }
    }
    Ok(GitStatus {
        branch,
        files,
        is_repo: true,
    })
}

fn diff_text(bytes: &[u8], truncated: bool) -> String {
    let mut text = String::from_utf8_lossy(bytes).into_owned();
    if truncated || text.len() > DIFF_LIMIT {
        let mut end = (DIFF_LIMIT - TRUNCATED.len()).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str(TRUNCATED);
    }
    text
}

/// The path itself when Git reports it untracked (exact match, as in `git status`).
fn untracked_path(root: &Path, path: &str) -> Result<Vec<String>, String> {
    let output = checked(run_git(
        root,
        &["ls-files", "--others", "--exclude-standard", "-z", "--", path],
        STATUS_LIMIT,
        false,
    )?)?;
    let untracked = output.bytes.split(|byte| *byte == 0).any(|entry| entry == path.as_bytes());
    Ok(if untracked { vec![path.to_string()] } else { Vec::new() })
}

pub fn git_diff(root: &Path, path: Option<String>, staged: bool) -> Result<String, String> {
    let diff = diff_repository(root, path, staged);
    if diff.is_err() {
        // A failure may mean the repository is gone; verify it again next time.
        forget_repository(root);
    }
    diff
}

fn diff_repository(root: &Path, path: Option<String>, staged: bool) -> Result<String, String> {
    require_repository(root)?;
    let target = path.as_deref().map(|path| scoped_path(root, path)).transpose()?;
    let mut args = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--submodule=short",
        "--unified=3",
    ];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    if let Some(path) = &path {
        args.push(path);
    }
    let mut output = checked(run_git(root, &args, DIFF_LIMIT, false)?)?;
    if !staged && !output.truncated {
        // `git diff` omits untracked files. Preview them without altering the index.
        let untracked = match &path {
            // A path with tracked changes can't be untracked; otherwise ask about it alone.
            Some(path) if output.bytes.is_empty() && target.as_ref().is_some_and(|t| t.is_file()) => {
                untracked_path(root, path)?
            }
            Some(_) => vec![],
            None => read_status(root)?
                .files
                .into_iter()
                .filter(|file| file.index == "?")
                .map(|file| file.path)
                .collect(),
        };
        for file in untracked {
            let target = scoped_path(root, &file)?;
            if !target.is_file() {
                continue;
            }
            let remaining = DIFF_LIMIT.saturating_sub(output.bytes.len());
            if remaining == 0 {
                output.truncated = true;
                break;
            }
            let result = run_git(
                root,
                &[
                    "diff",
                    "--no-index",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-color",
                    "--",
                    "/dev/null",
                    &file,
                ],
                remaining,
                false,
            )?;
            if result.status.success() || result.status.code() == Some(1) {
                output.bytes.extend_from_slice(&result.stdout.bytes);
                output.truncated |= result.stdout.truncated;
                if output.truncated {
                    break;
                }
            } else {
                checked(result)?;
            }
        }
    }
    Ok(diff_text(&output.bytes, output.truncated))
}

pub fn git_stage(root: &Path, paths: Vec<String>, staged: bool) -> Result<(), String> {
    require_repository(root)?;
    if paths.is_empty() || paths.len() > FILE_COUNT_LIMIT {
        return Err("Select between 1 and 5,000 files".into());
    }
    for path in &paths {
        let target = scoped_path(root, path)?;
        if target.is_dir() {
            return Err("Select individual files to stage or unstage".into());
        }
    }
    let mut args = if staged {
        vec!["add", "--"]
    } else {
        let head = run_git(root, &["rev-parse", "--verify", "HEAD"], 8192, false)?;
        if head.status.success() {
            vec!["reset", "--quiet", "HEAD", "--"]
        } else {
            vec!["rm", "--cached", "--ignore-unmatch", "--"]
        }
    };
    args.extend(paths.iter().map(String::as_str));
    checked(run_git(root, &args, 16 * 1024, false)?)?;
    Ok(())
}

pub fn git_commit(root: &Path, message: String) -> Result<String, String> {
    if message.trim().is_empty() || message.len() > 16 * 1024 || message.contains('\0') {
        return Err("Commit message must contain 1–16,384 bytes of text".into());
    }
    require_repository(root)?;
    let output = checked(run_git(root, &["commit", "-m", &message], 16 * 1024, true)?)?;
    Ok(String::from_utf8_lossy(&output.bytes).trim().to_string())
}

// Rust canonical paths use the extended Windows prefix. Git rewrites that prefix
// into an invalid //?/ path when creating a linked worktree. Simplify only where
// doing so preserves Windows path semantics; keep canonical paths in storage.
fn git_path(path: &Path) -> &Path {
    #[cfg(windows)]
    { dunce::simplified(path) }
    #[cfg(not(windows))]
    { path }
}

/// The final branch name for a worktree request: validated and prefixed with the
/// app's namespace unless it already carries a known one.
pub fn worktree_branch_name(branch: &str) -> Result<String, String> {
    let branch = branch.trim();
    if branch.is_empty()
        || branch.len() > 120
        || branch.contains("..")
        || !branch
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/-_".contains(&c))
    {
        return Err(
            "Use a branch name with letters, numbers, hyphens, underscores, and slashes".into(),
        );
    }
    // Keep explicitly named historical branches intact when creating worktrees.
    Ok(if branch.starts_with("pandacode/")
        || branch.starts_with("kingcode/")
        || branch.starts_with("codex/")
    {
        branch.to_string()
    } else {
        format!("pandacode/{branch}")
    })
}

fn ref_exists(root: &Path, reference: &str) -> Result<bool, String> {
    let output = run_git(
        root,
        &["rev-parse", "--verify", "--quiet", reference],
        8192,
        false,
    )?;
    Ok(output.status.success())
}

fn valid_start_point(base: &str) -> bool {
    !base.is_empty()
        && base.len() <= 200
        && !base.contains("..")
        && !base.starts_with('-')
        && base
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/-_.".contains(&c))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: PathBuf,
    pub branch: String,
}

#[cfg(test)]
pub fn create_worktree(root: &Path, branch: String) -> Result<PathBuf, String> {
    create_worktree_with(root, &branch, None, false).map(|worktree| worktree.path)
}

/// Create a sibling checkout. `base` chooses the start point for a new branch;
/// `existing` checks out a branch that already exists instead of creating one.
pub fn create_worktree_with(
    root: &Path,
    branch: &str,
    base: Option<&str>,
    existing: bool,
) -> Result<Worktree, String> {
    require_repository(root)?;
    let branch = worktree_branch_name(branch)?;
    checked(run_git(
        root,
        &["check-ref-format", "--branch", &branch],
        8192,
        false,
    )?)?;
    let branch_exists = ref_exists(root, &format!("refs/heads/{branch}"))?;
    if existing && !branch_exists {
        return Err(format!("Branch {branch} does not exist yet. Create it instead."));
    }
    if !existing && branch_exists {
        return Err(format!(
            "Branch {branch} already exists. Use the existing branch or choose another name."
        ));
    }
    let base = match base.map(str::trim).filter(|b| !b.is_empty()) {
        Some(base) if existing => {
            return Err(format!("{base} cannot be a start point for an existing branch."))
        }
        Some(base) => {
            if !valid_start_point(base) {
                return Err("Choose a valid branch to start from.".into());
            }
            if !ref_exists(root, &format!("{base}^{{commit}}"))? {
                return Err(format!("Start point {base} was not found."));
            }
            Some(base.to_string())
        }
        None => None,
    };
    let parent = root.parent().ok_or("Project has no parent directory")?;
    let name = root
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Project name is not UTF-8")?;
    let directory = parent.join(format!("{name}-worktrees"));
    match fs::create_dir(&directory) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(&directory).map_err(|e| e.to_string())?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("Worktree container must be a real directory".into());
            }
        }
        Err(e) => return Err(e.to_string()),
    }
    let destination = directory.join(branch.replace('/', "-"));
    if fs::symlink_metadata(&destination).is_ok() {
        return Err("Worktree destination already exists; choose a different branch".into());
    }
    let destination_text = git_path(&destination).to_str().ok_or("Worktree path is not UTF-8")?;
    let mut args: Vec<&str> = vec!["worktree", "add"];
    if !existing {
        args.extend(["-b", &branch]);
    }
    args.extend(["--", destination_text]);
    if existing {
        args.push(&branch);
    } else if let Some(base) = &base {
        args.push(base);
    }
    checked(run_git(root, &args, 16 * 1024, false)?)?;
    let path = fs::canonicalize(destination).map_err(|e| e.to_string())?;
    Ok(Worktree { path, branch })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    pub current: String,
    pub branches: Vec<String>,
    /// The repository's main branch: origin's HEAD when known, else `main` or `master`; empty when neither exists.
    pub default_branch: String,
}

fn default_branch(root: &Path, branches: &[String]) -> String {
    let remote = run_git(root, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], 8192, false)
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout.bytes).trim().trim_start_matches("origin/").to_string())
        .unwrap_or_default();
    let found = [remote.as_str(), "main", "master"]
        .into_iter()
        .find(|name| !name.is_empty() && branches.iter().any(|branch| branch == name))
        .map(str::to_string);
    found.unwrap_or_default()
}

/// Check out another local branch in this checkout. Only branches that exist locally are
/// accepted, so the name can never be read as an option; Git itself refuses a switch that
/// would overwrite uncommitted changes, and that message is returned as it is.
pub fn git_switch(root: &Path, branch: &str) -> Result<BranchList, String> {
    let list = git_branches(root)?;
    if !list.branches.iter().any(|name| name == branch) {
        return Err(format!("There is no local branch named {branch}."));
    }
    if list.current != branch {
        checked(run_git(root, &["switch", branch], 64 * 1024, false)?)?;
    }
    git_branches(root)
}

fn current_branch(root: &Path) -> Result<String, String> {
    let output = run_git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"], 8192, false)?;
    // A detached HEAD has no branch; that is a state, not a failure.
    Ok(if output.status.success() {
        String::from_utf8_lossy(&output.stdout.bytes).trim().to_string()
    } else {
        String::new()
    })
}

/// Local branches, most recently committed first, for choosing a start point.
pub fn git_branches(root: &Path) -> Result<BranchList, String> {
    require_repository(root)?;
    let output = checked(run_git(
        root,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "--sort=-committerdate",
            "refs/heads/",
        ],
        256 * 1024,
        false,
    )?)?;
    let branches: Vec<String> = String::from_utf8_lossy(&output.bytes)
        .lines()
        .filter(|line| !line.is_empty())
        .take(200)
        .map(str::to_string)
        .collect();
    Ok(BranchList {
        current: current_branch(root)?,
        default_branch: default_branch(root, &branches),
        branches,
    })
}

#[derive(Debug, Default)]
struct WorktreeEntry {
    branch: Option<String>,
    prunable: bool,
}

/// The registered entry for a checkout, including one whose folder is gone.
fn worktree_entry(root: &Path, path: &Path) -> Result<Option<WorktreeEntry>, String> {
    let output = checked(run_git(
        root,
        &["worktree", "list", "--porcelain"],
        256 * 1024,
        false,
    )?)?;
    let wanted = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = String::from_utf8_lossy(&output.bytes);
    for block in text.split("\n\n") {
        let mut entry = WorktreeEntry::default();
        let mut matches = false;
        for line in block.lines() {
            if let Some(listed) = line.strip_prefix("worktree ") {
                let listed = Path::new(listed);
                // Deleted checkouts cannot be canonicalized. Git reports ordinary
                // Windows paths while stored canonical paths retain the \\?\ prefix.
                matches = git_path(listed) == git_path(path)
                    || fs::canonicalize(listed).is_ok_and(|resolved| resolved == wanted);
            } else if let Some(reference) = line.strip_prefix("branch ") {
                entry.branch = Some(
                    reference
                        .strip_prefix("refs/heads/")
                        .unwrap_or(reference)
                        .to_string(),
                );
            } else if line.starts_with("prunable") {
                entry.prunable = true;
            }
        }
        if matches {
            return Ok(Some(entry));
        }
    }
    Ok(None)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub exists: bool,
    pub branch: String,
    pub changes: u32,
    pub clean: bool,
    pub has_upstream: bool,
    pub ahead: u32,
    pub merged: bool,
}

/// Everything the cleanup offer needs in one round trip.
pub fn worktree_status(
    main: &Path,
    path: &Path,
    stored_branch: Option<&str>,
) -> Result<WorktreeStatus, String> {
    let exists = path.is_dir() && path.join(".git").is_file();
    if !exists {
        let branch = stored_branch
            .map(str::to_string)
            .or_else(|| worktree_entry(main, path).ok().flatten().and_then(|e| e.branch))
            .unwrap_or_default();
        return Ok(WorktreeStatus {
            exists: false,
            branch,
            changes: 0,
            clean: true,
            has_upstream: false,
            ahead: 0,
            merged: false,
        });
    }
    let mut branch = current_branch(path)?;
    if branch.is_empty() {
        branch = stored_branch.unwrap_or_default().to_string();
    }
    let status = checked(run_git(
        path,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        STATUS_LIMIT,
        false,
    )?)?;
    let changes = status
        .bytes
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .count() as u32;
    let has_upstream = run_git(
        path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        8192,
        false,
    )?
    .status
    .success();
    let ahead = if has_upstream {
        let output = checked(run_git(
            path,
            &["rev-list", "--count", "@{upstream}..HEAD"],
            8192,
            false,
        )?)?;
        String::from_utf8_lossy(&output.bytes)
            .trim()
            .parse()
            .unwrap_or(0)
    } else {
        0
    };
    let merged = !branch.is_empty()
        && run_git(
            main,
            &["merge-base", "--is-ancestor", &branch, "HEAD"],
            8192,
            false,
        )?
        .status
        .success();
    Ok(WorktreeStatus {
        exists: true,
        branch,
        changes,
        clean: changes == 0 || status.truncated,
        has_upstream,
        ahead,
        merged,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMerge {
    pub branch: String,
    pub target: String,
    /// Commits the target gained; 0 when it already had the branch's work.
    pub commits: u32,
    /// The branch the project checkout was on before it moved to the target.
    pub switched_from: Option<String>,
}

fn tracked_changes(root: &Path) -> Result<bool, String> {
    let status = checked(run_git(root, &["status", "--porcelain=v1", "--untracked-files=no"], STATUS_LIMIT, false)?)?;
    Ok(!status.bytes.is_empty())
}

/// Merge a worktree's committed branch into the repository's main branch, in the
/// project's own checkout. Refuses uncommitted work on either side, and a conflict
/// aborts the merge so neither checkout is left half-merged.
pub fn merge_worktree(main: &Path, path: &Path) -> Result<WorktreeMerge, String> {
    require_repository(main)?;
    if !(path.is_dir() && path.join(".git").is_file()) {
        return Err("The worktree folder is missing; recreate it first.".into());
    }
    let branch = current_branch(path)?;
    if branch.is_empty() || branch.starts_with('-') {
        return Err("The worktree is not on a branch, so there is nothing to merge.".into());
    }
    let uncommitted = checked(run_git(path, &["status", "--porcelain=v1", "--untracked-files=all"], STATUS_LIMIT, false)?)?;
    if !uncommitted.bytes.is_empty() {
        return Err("The worktree has uncommitted changes. Commit or discard them first; only committed work is merged.".into());
    }
    let list = git_branches(main)?;
    let target = list.default_branch.clone();
    if target.is_empty() {
        return Err("This repository has no main branch to merge into.".into());
    }
    if target == branch {
        return Err(format!("The worktree is already on {target}."));
    }
    if tracked_changes(main)? {
        return Err(format!("The project checkout has uncommitted changes. Commit or stash them there before merging into {target}."));
    }
    let count = checked(run_git(main, &["rev-list", "--count", &format!("{target}..{branch}")], 8192, false)?)?;
    let commits = String::from_utf8_lossy(&count.bytes).trim().parse().unwrap_or(0);
    let switched_from = (list.current != target).then(|| list.current.clone());
    if switched_from.is_some() {
        checked(run_git(main, &["switch", &target], 64 * 1024, false)?)?;
    }
    if commits > 0 {
        let merged = run_git(main, &["merge", "--no-edit", &branch], 64 * 1024, true)?;
        if !merged.status.success() {
            let conflicts = run_git(main, &["diff", "--name-only", "--diff-filter=U"], 64 * 1024, false)
                .map(|output| String::from_utf8_lossy(&output.stdout.bytes).lines().map(str::to_string).collect::<Vec<_>>())
                .unwrap_or_default();
            let _ = run_git(main, &["merge", "--abort"], 8192, false);
            if let Some(previous) = switched_from.as_deref().filter(|name| !name.is_empty()) {
                let _ = run_git(main, &["switch", previous], 64 * 1024, false);
            }
            return Err(if conflicts.is_empty() {
                checked(merged).err().unwrap_or_else(|| "Git could not merge the branch.".into())
            } else {
                format!(
                    "Merging {branch} into {target} conflicts in {}. Nothing was changed; merge {target} into the worktree, resolve it there, and try again.",
                    conflicts.join(", ")
                )
            });
        }
    }
    Ok(WorktreeMerge { branch, target, commits, switched_from })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoval {
    pub removed: bool,
    pub branch: String,
    pub branch_deleted: bool,
    pub note: String,
}

/// Remove a checkout without force: Git refuses when work would be lost.
pub fn remove_worktree(
    main: &Path,
    path: &Path,
    stored_branch: Option<&str>,
    delete_branch: bool,
) -> Result<WorktreeRemoval, String> {
    require_repository(main)?;
    if path == main {
        return Err("The main checkout cannot be removed.".into());
    }
    let entry = worktree_entry(main, path)?;
    let branch = stored_branch
        .map(str::to_string)
        .or_else(|| entry.as_ref().and_then(|e| e.branch.clone()))
        .unwrap_or_default();
    let present = path.is_dir();
    if present {
        if entry.is_none() {
            return Err("This folder is not a worktree of the project.".into());
        }
        let path_text = git_path(path).to_str().ok_or("Worktree path is not UTF-8")?;
        checked(run_git(
            main,
            &["worktree", "remove", "--", path_text],
            16 * 1024,
            false,
        )?)?;
    }
    checked(run_git(main, &["worktree", "prune"], 16 * 1024, false)?)?;
    let mut note = String::new();
    let mut branch_deleted = false;
    if delete_branch && !branch.is_empty() {
        match checked(run_git(main, &["branch", "-d", &branch], 16 * 1024, false)?) {
            Ok(_) => branch_deleted = true,
            Err(message) => {
                note = format!(
                    "Branch {branch} was kept: {}",
                    message.lines().next().unwrap_or("it is not fully merged")
                );
            }
        }
    }
    Ok(WorktreeRemoval {
        removed: present,
        branch,
        branch_deleted,
        note,
    })
}

/// Check the branch out again at the same path after its folder disappeared.
pub fn recreate_worktree(
    main: &Path,
    path: &Path,
    stored_branch: Option<&str>,
) -> Result<PathBuf, String> {
    require_repository(main)?;
    if path.exists() {
        return Err("The worktree folder already exists.".into());
    }
    let entry = worktree_entry(main, path)?;
    let branch = stored_branch
        .map(str::to_string)
        .or_else(|| entry.and_then(|e| e.branch))
        .ok_or("The worktree's branch is unknown; create a new worktree instead.")?;
    if !ref_exists(main, &format!("refs/heads/{branch}"))? {
        return Err(format!("Branch {branch} no longer exists; create a new worktree instead."));
    }
    checked(run_git(main, &["worktree", "prune"], 16 * 1024, false)?)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let path_text = git_path(path).to_str().ok_or("Worktree path is not UTF-8")?;
    checked(run_git(
        main,
        &["worktree", "add", "--", path_text, &branch],
        16 * 1024,
        false,
    )?)?;
    fs::canonicalize(path).map_err(|e| e.to_string())
}

/// Publish the checkout's branch to its remote, creating the upstream link.
pub fn git_push(root: &Path) -> Result<String, String> {
    require_repository(root)?;
    let branch = current_branch(root)?;
    if branch.is_empty() {
        return Err("Check out a branch before pushing.".into());
    }
    let remotes = checked(run_git(root, &["remote"], 8192, false)?)?;
    let remotes = String::from_utf8_lossy(&remotes.bytes);
    let remote = remotes
        .lines()
        .find(|name| *name == "origin")
        .or_else(|| remotes.lines().next())
        .ok_or("Add a Git remote before pushing.")?
        .to_string();
    let output = run_git_bounded(
        root,
        &["push", "--set-upstream", &remote, &format!("{branch}:{branch}")],
        64 * 1024,
        true,
        Duration::from_secs(180),
    )?;
    let combined = String::from_utf8_lossy(&output.stderr.bytes).trim().to_string();
    if !output.status.success() {
        return Err(if combined.is_empty() {
            "Git push failed".into()
        } else {
            combined
        });
    }
    Ok(combined)
}

/// Resolve app-created sibling chains to a registered main checkout. Every link
/// must use the historical layout and belong to the same Git common directory.
pub fn legacy_worktree_parent(path: &Path, registered: &[PathBuf]) -> Option<PathBuf> {
    let mut checkout = path.canonicalize().ok()?;
    let common = linked_worktree_common(&checkout)?;
    // Bound filesystem/Git discovery for malformed or unusually deep layouts.
    for _ in 0..16 {
        let leaf = checkout.file_name()?.to_str()?;
        // Existing installations may still have either historical prefix on disk.
        if !leaf.starts_with("pandacode-")
            && !leaf.starts_with("kingcode-")
            && !leaf.starts_with("codex-")
        {
            return None;
        }
        let container = checkout.parent()?;
        let name = container
            .file_name()?
            .to_str()?
            .strip_suffix("-worktrees")?;
        let parent = container.parent()?.join(name).canonicalize().ok()?;
        if registered.contains(&parent) && parent.join(".git").is_dir() {
            return (common == parent.join(".git").canonicalize().ok()?).then_some(parent);
        }
        // A v4 upgrade may already have folded the intermediate project into
        // its repository. Its on-disk checkout still proves the original chain.
        if linked_worktree_common(&parent)? != common {
            return None;
        }
        checkout = parent;
    }
    None
}

fn linked_worktree_common(path: &Path) -> Option<PathBuf> {
    if !fs::symlink_metadata(path.join(".git")).ok()?.is_file() {
        return None;
    }
    let common = checked(
        run_git(
            path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            8192,
            false,
        )
        .ok()?,
    )
    .ok()?;
    if common.truncated {
        return None;
    }
    fs::canonicalize(
        std::str::from_utf8(&common.bytes)
            .ok()?
            .trim_end_matches('\n'),
    )
    .ok()
}

/// Directory entries one listing reads; a larger folder shows a partial listing.
const LIST_ENTRIES: usize = 200_000;
/// Symlinks one listing resolves; the listing shows 500 rows, so more could never all appear.
const LIST_LINK_CHECKS: usize = 2_000;

pub fn list_files(root: &Path, path: Option<String>) -> Result<Vec<FileEntry>, String> {
    list_directory(root, path, LIST_ENTRIES, LIST_LINK_CHECKS)
}

fn list_directory(
    root: &Path,
    path: Option<String>,
    entries: usize,
    mut link_checks: usize,
) -> Result<Vec<FileEntry>, String> {
    let directory = match path.as_deref() {
        None | Some("") => root.to_path_buf(),
        Some(path) => scoped_path(root, path)?,
    };
    // Retain only the first 500 sorted entries even in very large directories.
    let mut names = BinaryHeap::new();
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())?.take(entries) {
        let entry = entry.map_err(|e| e.to_string())?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name == ".git" {
            continue;
        }
        let relative_path = entry.path();
        let relative_path = relative_path
            .strip_prefix(root)
            .map_err(|_| "Path is outside project")?;
        let relative = relative_path
            .components()
            .map(|part| part.as_os_str().to_str().ok_or("Filename is not UTF-8"))
            .collect::<Result<Vec<_>, _>>()?
            .join("/");
        // Entries can disappear during enumeration.
        let kind = match entry.file_type() {
            Ok(kind) => kind,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("Cannot inspect {relative}: {e}")),
        };
        // Only a link can leave the already verified folder. Resolving every entry opens a
        // handle per file on Windows, which security software and cloud drives make slow.
        let is_dir = if kind.is_symlink() {
            if link_checks == 0 {
                continue;
            }
            link_checks -= 1;
            match resolve_scoped_path(root, &relative) {
                Ok(target) => target.is_dir(),
                Err(PathError::Rejected(_)) => continue,
                // Dangling links are omitted too.
                Err(PathError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(format!("Cannot inspect {relative}: {error}")),
            }
        } else {
            kind.is_dir()
        };
        names.push((!is_dir, name, relative));
        if names.len() > 500 {
            names.pop();
        }
    }
    Ok(names
        .into_sorted_vec()
        .into_iter()
        .map(|(file, name, path)| FileEntry {
            name,
            path,
            is_dir: !file,
        })
        .collect())
}

/// Largest image an agent's question may show inline.
const IMAGE_LIMIT: u64 = 8 * 1024 * 1024;

/// An image in the workspace as a `data:` URL, so an agent's question can show it inline.
/// Only image types, only inside the project, and bounded in size.
pub fn image_data_url(root: &Path, path: &str) -> Result<String, String> {
    use base64::Engine;
    let target = scoped_path(root, path)?;
    let mime = match target.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => return Err("Only PNG, JPEG, GIF, WebP and SVG images can be shown".into()),
    };
    let file = File::open(&target).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > IMAGE_LIMIT {
        return Err("The image is missing or larger than 8 MB".into());
    }
    let mut bytes = Vec::new();
    file.take(IMAGE_LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

pub fn read_file(root: &Path, path: String) -> Result<String, String> {
    let target = scoped_path(root, &path)?;
    let metadata = fs::metadata(&target).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Only regular text files can be previewed".into());
    }
    let file = File::open(target).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Only regular text files can be previewed".into());
    }
    if metadata.len() > FILE_LIMIT as u64 {
        return Err("File exceeds the 128 KiB preview limit".into());
    }
    let mut bytes = Vec::new();
    file.take(FILE_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > FILE_LIMIT {
        return Err("File exceeds the 128 KiB preview limit".into());
    }
    if bytes.contains(&0) {
        return Err("Binary files cannot be previewed as text".into());
    }
    String::from_utf8(bytes).map_err(|_| "File is not UTF-8 text".into())
}

/// Largest PDF, Word, spreadsheet or image file the viewer will open.
const DOCUMENT_LIMIT: u64 = 64 * 1024 * 1024;

/// The bytes of a PDF, Word, spreadsheet or image file for the viewer, which renders it in the window.
/// Only those types, only inside the project, and bounded in size.
pub fn read_document_bytes(root: &Path, path: &str) -> Result<Vec<u8>, String> {
    let target = scoped_path(root, path)?;
    // A link named report.pdf must not reach another kind of file, such as .git/config.
    let resolved = fs::canonicalize(&target).map_err(|e| e.to_string())?;
    let document = |file: &Path| {
        let extension = file.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
        matches!(extension.as_deref(), Some("pdf" | "docx" | "xlsx" | "xlsm" | "xls" | "ods" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "bmp" | "ico" | "svg"))
    };
    let inside = fs::canonicalize(root).ok().and_then(|base| resolved.strip_prefix(base).ok().map(Path::to_path_buf));
    let in_git = inside.is_none_or(|relative| relative.components().any(|part| part.as_os_str() == ".git"));
    if !document(&target) || !document(&resolved) || in_git {
        return Err("Only PDF, Word (.docx), spreadsheet and image files can be shown".into());
    }
    let file = File::open(&resolved).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > DOCUMENT_LIMIT {
        return Err("The file is missing or larger than 64 MB".into());
    }
    let mut bytes = Vec::new();
    file.take(DOCUMENT_LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > DOCUMENT_LIMIT {
        return Err("The file is missing or larger than 64 MB".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};

    #[cfg(unix)]
    #[test]
    fn run_process_drains_large_output_and_feeds_stdin() {
        let started = Instant::now();
        let mut flood = Command::new("sh");
        flood.args(["-c", "head -c 300000 /dev/zero; head -c 100000 /dev/zero >&2"]);
        let output = run_process(flood, "sh", 1 << 20, Duration::from_secs(20)).unwrap();
        assert!(output.status.success() && output.stdout.bytes.len() == 300_000);
        assert!(output.stderr.truncated && started.elapsed() < Duration::from_secs(10));
        let input = vec![b'x'; 200_000];
        let output = run_process_with_input(Command::new("cat"), "cat", 1 << 20, Duration::from_secs(20), Some(&input)).unwrap();
        assert!(output.status.success() && output.stdout.bytes == input);
        let mut sleeper = Command::new("sh");
        sleeper.args(["-c", "sleep 30"]);
        let err = run_process_with_input(sleeper, "sh", 1024, Duration::from_millis(200), None).err().unwrap();
        assert!(err.contains("timed out"));
    }

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
    }
    impl Fixture {
        fn new(repo: bool) -> Self {
            let base =
                std::env::temp_dir().join(format!("pandacode-workspace-{}", uuid::Uuid::new_v4()));
            let root = base.join("project");
            fs::create_dir_all(&root).unwrap();
            let this = Self {
                base: fs::canonicalize(base).unwrap(),
                root: fs::canonicalize(root).unwrap(),
            };
            if repo {
                this.git(&["init", "-b", "main"]);
                this.git(&["config", "user.name", "Workspace Tests"]);
                this.git(&["config", "user.email", "workspace@example.invalid"]);
                this.git(&["config", "commit.gpgSign", "false"]);
                this.git(&[
                    "-c",
                    "core.hooksPath=/dev/null",
                    "commit",
                    "--allow-empty",
                    "-m",
                    "Initial",
                ]);
            }
            this
        }
        fn git(&self, args: &[&str]) {
            let result = Command::new("git")
                .arg("-C")
                .arg(git_path(&self.root))
                .args(args.iter().map(|arg| git_path(Path::new(arg))))
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn question_images_are_scoped_typed_and_encoded() {
        let f = Fixture::new(false);
        fs::write(f.root.join("chart.png"), [137, 80, 78, 71]).unwrap();
        fs::write(f.root.join("notes.txt"), "hello").unwrap();
        fs::write(f.base.join("outside.png"), [137, 80, 78, 71]).unwrap();
        assert_eq!(image_data_url(&f.root, "chart.png").unwrap(), "data:image/png;base64,iVBORw==");
        assert!(image_data_url(&f.root, "notes.txt").is_err(), "not an image");
        assert!(image_data_url(&f.root, "../outside.png").is_err(), "outside the project");
        assert!(image_data_url(&f.root, "missing.png").is_err());
    }

    #[test]
    fn document_bytes_are_scoped_typed_and_larger_than_text_previews() {
        let f = Fixture::new(false);
        let large = vec![7u8; FILE_LIMIT * 4];
        fs::write(f.root.join("Report.PDF"), &large).unwrap();
        fs::write(f.root.join("notes.txt"), "hello").unwrap();
        fs::write(f.base.join("outside.docx"), b"PK").unwrap();
        assert_eq!(read_document_bytes(&f.root, "Report.PDF").unwrap(), large, "beyond the 128 KiB text limit");
        assert!(read_document_bytes(&f.root, "notes.txt").is_err(), "not a document");
        assert!(read_document_bytes(&f.root, "../outside.docx").is_err(), "outside the project");
        assert!(read_document_bytes(&f.root, "missing.xlsx").is_err());
        #[cfg(unix)]
        {
            fs::create_dir_all(f.root.join(".git")).unwrap();
            fs::write(f.root.join(".git/config"), "[core]").unwrap();
            std::os::unix::fs::symlink(f.root.join(".git/config"), f.root.join("disguised.pdf")).unwrap();
            std::os::unix::fs::symlink(f.root.join("notes.txt"), f.root.join("notes.pdf")).unwrap();
            assert!(read_document_bytes(&f.root, "disguised.pdf").is_err(), "a link into .git");
            assert!(read_document_bytes(&f.root, "notes.pdf").is_err(), "a link to a non-document");
        }
    }

    #[test]
    fn file_reads_are_scoped_and_bounded() {
        let f = Fixture::new(false);
        fs::write(f.root.join("notes.txt"), "hello").unwrap();
        fs::write(f.base.join("outside.txt"), "private").unwrap();
        assert_eq!(read_file(&f.root, "notes.txt".into()).unwrap(), "hello");
        assert!(read_file(&f.root, "../outside.txt".into()).is_err());
        assert!(read_file(&f.root, f.base.join("outside.txt").display().to_string()).is_err());
        fs::write(f.root.join("large.txt"), vec![b'x'; 128 * 1024 + 1]).unwrap();
        assert!(read_file(&f.root, "large.txt".into()).is_err());
        fs::write(f.root.join("binary.bin"), [0, 1, 2]).unwrap();
        assert!(read_file(&f.root, "binary.bin".into()).is_err());
        assert!(read_file(&f.root, ".".into()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_project() {
        let f = Fixture::new(true);
        fs::write(f.base.join("secret"), "private").unwrap();
        std::os::unix::fs::symlink(&f.base, f.root.join("escape")).unwrap();
        assert!(read_file(&f.root, "escape/secret".into()).is_err());
        assert!(list_files(&f.root, Some("escape".into())).is_err());
        assert!(git_stage(&f.root, vec!["escape/secret".into()], true).is_err());
        assert!(git_diff(&f.root, Some("escape/secret".into()), false).is_err());
        fs::write(f.root.join("local"), "safe").unwrap();
        std::os::unix::fs::symlink("local", f.root.join("local-link")).unwrap();
        assert_eq!(read_file(&f.root, "local-link".into()).unwrap(), "safe");
    }

    #[cfg(unix)]
    #[test]
    fn listing_preserves_backslash_and_newline_filenames() {
        let f = Fixture::new(false);
        fs::write(f.root.join("back\\slash\nfile.txt"), "literal").unwrap();
        let files = list_files(&f.root, None).unwrap();
        assert_eq!(files[0].path, "back\\slash\nfile.txt");
        assert_eq!(
            read_file(&f.root, files[0].path.clone()).unwrap(),
            "literal"
        );
    }

    #[test]
    fn unstage_supports_an_unborn_branch() {
        let f = Fixture::new(false);
        f.git(&["init", "-b", "main"]);
        fs::write(f.root.join("first.txt"), "first").unwrap();
        git_stage(&f.root, vec!["first.txt".into()], true).unwrap();
        assert_eq!(git_status(&f.root).unwrap().files[0].index, "A");
        git_stage(&f.root, vec!["first.txt".into()], false).unwrap();
        assert_eq!(git_status(&f.root).unwrap().files[0].index, "?");
        assert!(f.root.join("first.txt").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn explicit_commit_preserves_repository_hooks() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new(true);
        // Use the fixture's hooks even when the user configures a different hooksPath.
        f.git(&["config", "core.hooksPath", ".git/hooks"]);
        let hook = f.root.join(".git/hooks/pre-commit");
        fs::write(&hook, "#!/bin/sh\necho Test hook refused >&2\nexit 1\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(f.root.join("file"), "data").unwrap();
        git_stage(&f.root, vec!["file".into()], true).unwrap();
        assert!(git_commit(&f.root, "Should fail".into())
            .unwrap_err()
            .contains("Test hook refused"));
    }

    #[test]
    fn folder_listing_is_one_level_and_bounded() {
        let f = Fixture::new(true);
        fs::create_dir(f.root.join("src")).unwrap();
        fs::write(f.root.join("src/main.rs"), "main").unwrap();
        let files = list_files(&f.root, None).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src");
        assert!(files[0].is_dir);
        assert_eq!(
            list_files(&f.root, Some("src".into())).unwrap()[0].path,
            "src/main.rs"
        );
        for i in 0..510 {
            fs::write(f.root.join(format!("f{i}")), "").unwrap();
        }
        assert_eq!(list_files(&f.root, None).unwrap().len(), 500);
    }

    #[test]
    fn plain_entries_are_listed_without_spending_a_path_check() {
        let f = Fixture::new(false);
        fs::create_dir(f.root.join("src")).unwrap();
        for i in 0..50 {
            fs::write(f.root.join(format!("f{i}")), "").unwrap();
        }
        // No link checks at all: a plain entry must not need one, however many there are.
        let files = list_directory(&f.root, None, LIST_ENTRIES, 0).unwrap();
        assert_eq!(files.len(), 51);
        assert_eq!((files[0].path.as_str(), files[0].is_dir), ("src", true));
        assert!(files[1..].iter().all(|file| !file.is_dir));
    }

    #[test]
    fn listing_stops_at_its_entry_budget() {
        let f = Fixture::new(false);
        for i in 0..50 {
            fs::write(f.root.join(format!("f{i}")), "").unwrap();
        }
        assert_eq!(list_directory(&f.root, None, 7, 0).unwrap().len(), 7);
    }

    #[cfg(unix)]
    #[test]
    fn listing_resolves_only_a_bounded_number_of_links() {
        let f = Fixture::new(false);
        fs::write(f.root.join("target"), "").unwrap();
        for i in 0..10 {
            std::os::unix::fs::symlink("target", f.root.join(format!("link{i}"))).unwrap();
        }
        let listed = |checks| list_directory(&f.root, None, LIST_ENTRIES, checks).unwrap().len();
        assert_eq!(listed(3), 4, "the file and the first three links");
        assert_eq!(listed(10), 11);
    }

    #[cfg(unix)]
    #[test]
    fn process_deadline_also_bounds_inherited_output_pipes() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 2 &"]);
        let started = Instant::now();
        let result = run_process(command, "Fixture", 1024, Duration::from_millis(100));
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_millis(750), "pipe draining must share the process deadline");
    }

    #[test]
    fn status_diff_stage_commit_and_unstage_handle_literal_names() {
        let f = Fixture::new(true);
        let name = "name with spaces.txt";
        fs::write(f.root.join(name), "first\n").unwrap();
        fs::write(f.root.join("other.txt"), "other\n").unwrap();
        let status = git_status(&f.root).unwrap();
        assert!(status.is_repo);
        assert_eq!(status.branch, "main");
        assert!(status
            .files
            .iter()
            .any(|v| v.path == name && v.index == "?"));
        assert!(git_diff(&f.root, Some(name.into()), false)
            .unwrap()
            .contains("+first"));
        assert!(git_diff(&f.root, None, false).unwrap().contains("+first"));
        git_stage(&f.root, vec![name.into()], true).unwrap();
        assert!(git_diff(&f.root, Some(name.into()), true)
            .unwrap()
            .contains("+first"));
        git_stage(&f.root, vec![name.into()], false).unwrap();
        assert!(!git_status(&f.root)
            .unwrap()
            .files
            .iter()
            .any(|v| v.index == "A"));
        git_stage(&f.root, vec![name.into()], true).unwrap();
        assert!(!git_commit(&f.root, "Add literal filename".into())
            .unwrap()
            .is_empty());
        fs::remove_file(f.root.join(name)).unwrap();
        assert!(git_diff(&f.root, Some(name.into()), false)
            .unwrap()
            .contains("-first"));
        git_stage(&f.root, vec![name.into()], true).unwrap();
        assert!(git_status(&f.root)
            .unwrap()
            .files
            .iter()
            .any(|v| v.path == name && v.index == "D"));
        // Brackets are valid Windows filename characters and still exercise
        // literal Git pathspec handling: this must not stage other.txt.
        fs::write(f.root.join("[o]ther.txt"), "literal pattern\n").unwrap();
        git_stage(&f.root, vec!["[o]ther.txt".into()], true).unwrap();
        #[cfg(unix)]
        {
            fs::write(f.root.join("*.txt"), "literal wildcard\n").unwrap();
            git_stage(&f.root, vec!["*.txt".into()], true).unwrap();
        }
        assert!(git_status(&f.root)
            .unwrap()
            .files
            .iter()
            .any(|v| v.path == "other.txt" && v.index == "?"));
    }

    #[test]
    fn porcelain_renames_do_not_swallow_next_entry() {
        let f = Fixture::new(true);
        fs::write(f.root.join("old name.txt"), "same\n").unwrap();
        f.git(&["add", "."]);
        f.git(&[
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            "Add original",
        ]);
        f.git(&["mv", "old name.txt", "new name.txt"]);
        fs::write(f.root.join("tail.txt"), "tail").unwrap();
        let files = git_status(&f.root).unwrap().files;
        assert_eq!(files.len(), 2);
        assert!(files
            .iter()
            .any(|v| v.path == "new name.txt" && v.index == "R"));
        assert!(files.iter().any(|v| v.path == "tail.txt" && v.index == "?"));
    }

    #[test]
    fn path_diffs_cover_tracked_untracked_staged_and_clean_files() {
        let f = Fixture::new(true);
        fs::create_dir(f.root.join("dir")).unwrap();
        fs::write(f.root.join("tracked.txt"), "old\n").unwrap();
        fs::write(f.root.join("clean.txt"), "same\n").unwrap();
        fs::write(f.root.join(".gitignore"), "ignored.txt\n").unwrap();
        f.git(&["add", "."]);
        f.git(&["-c", "core.hooksPath=/dev/null", "commit", "-m", "Base"]);
        fs::write(f.root.join("tracked.txt"), "new\n").unwrap();
        fs::write(f.root.join("dir/fresh.txt"), "fresh\n").unwrap();
        fs::write(f.root.join("ignored.txt"), "hidden\n").unwrap();
        fs::write(f.root.join("staged.txt"), "staged\n").unwrap();
        f.git(&["add", "staged.txt"]);
        let diff = |path: &str, staged| git_diff(&f.root, Some(path.into()), staged).unwrap();

        let tracked = diff("tracked.txt", false);
        assert!(tracked.contains("-old") && tracked.contains("+new") && !tracked.contains("fresh"));
        let untracked = diff("dir/fresh.txt", false);
        assert!(untracked.contains("new file mode") && untracked.contains("+fresh"));
        assert!(diff("staged.txt", true).contains("+staged"));
        assert!(diff("staged.txt", false).is_empty(), "staged-only file has no worktree diff");
        assert!(diff("dir/fresh.txt", true).is_empty(), "untracked files are never staged");
        assert!(diff("clean.txt", false).is_empty());
        assert!(diff("ignored.txt", false).is_empty());
        assert!(diff("missing.txt", false).is_empty());
        assert!(diff("dir", false).is_empty(), "untracked previews match exact paths only");

        let all = git_diff(&f.root, None, false).unwrap();
        assert!(all.contains("+new") && all.contains("+fresh"));
        assert!(!all.contains("+staged") && !all.contains("hidden"));
    }

    #[test]
    fn repository_cache_is_dropped_when_the_repository_goes_away() {
        let f = Fixture::new(true);
        fs::write(f.root.join("a.txt"), "a\n").unwrap();
        let cached = || verified_repositories().lock().unwrap().contains_key(&f.root);
        assert!(!cached());
        assert!(git_status(&f.root).unwrap().is_repo);
        assert!(cached(), "a status refresh seeds the check git_diff reuses");
        assert!(git_diff(&f.root, Some("a.txt".into()), false).unwrap().contains("+a"));
        assert!(cached());
        // A corrupt HEAD passes the cheap check, so the failing diff itself must evict.
        fs::write(f.root.join(".git/HEAD"), "garbage\n").unwrap();
        assert!(git_diff(&f.root, Some("a.txt".into()), false).is_err());
        assert!(!cached());
        fs::write(f.root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        assert!(git_diff(&f.root, None, false).unwrap().contains("+a"));
        assert!(cached());
        // A removed repository fails the cheap check and is verified again.
        fs::remove_dir_all(f.root.join(".git")).unwrap();
        assert!(git_diff(&f.root, Some("a.txt".into()), false).is_err());
        assert!(!cached());
        assert!(!git_status(&f.root).unwrap().is_repo);
        assert!(!cached());
    }

    #[test]
    fn diff_is_bounded_and_external_diff_is_disabled() {
        let f = Fixture::new(true);
        fs::write(f.root.join("large.txt"), "line\n".repeat(100_000)).unwrap();
        f.git(&["add", "."]);
        f.git(&[
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            "Add large",
        ]);
        fs::write(f.root.join("large.txt"), "changed\n".repeat(100_000)).unwrap();
        f.git(&["config", "diff.external", "false"]);
        let diff = git_diff(&f.root, Some("large.txt".into()), false).unwrap();
        assert!(diff.len() <= 256 * 1024);
        assert!(diff.contains("Preview truncated"));
    }

    #[test]
    fn non_repository_has_clear_status_and_commit_rejects_empty_message() {
        let f = Fixture::new(false);
        assert!(!git_status(&f.root).unwrap().is_repo);
        assert!(git_commit(&f.root, " ".into()).is_err());
    }

    #[test]
    fn repository_discovery_reports_git_errors() {
        let f = Fixture::new(true);
        fs::write(f.root.join(".git/config"), "[invalid section\n").unwrap();
        let error = git_status(&f.root).unwrap_err();
        assert!(error.contains("bad config"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn listing_skips_outside_symlinks_but_reports_access_errors() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let f = Fixture::new(false);
        fs::write(f.root.join("safe"), "visible").unwrap();
        symlink(&f.base, f.root.join("outside")).unwrap();
        let files = list_files(&f.root, None).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "safe");

        let locked = f.root.join("locked");
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("secret"), "unreadable").unwrap();
        symlink("locked/secret", f.root.join("inaccessible")).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let result = list_files(&f.root, None);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
        // Root can bypass these mode bits; normal desktop users cannot.
        if unsafe { libc::geteuid() } != 0 {
            let error = result.unwrap_err();
            assert!(error.contains("inaccessible"), "{error}");
            assert!(error.contains("Permission denied"), "{error}");
        }
    }

    #[test]
    fn worktree_is_a_sibling_and_does_not_overwrite_existing_paths() {
        let f = Fixture::new(true);
        let path = create_worktree(&f.root, "feature-one".into()).unwrap();
        assert!(path.starts_with(f.base.join("project-worktrees")));
        assert!(!path.starts_with(&f.root));
        assert_eq!(git_status(&path).unwrap().branch, "pandacode/feature-one");
        assert!(create_worktree(&f.root, "feature-one".into()).is_err());
        assert!(create_worktree(&f.root, "../../escape".into()).is_err());
    }

    #[test]
    fn merging_a_worktree_lands_committed_work_on_main_and_refuses_unsafe_states() {
        let f = Fixture::new(true);
        let path = create_worktree(&f.root, "fast".into()).unwrap();
        let in_worktree = |args: &[&str]| assert!(Command::new("git").arg("-C").arg(git_path(&path)).args(args).output().unwrap().status.success());
        // Uncommitted work in the worktree is never merged.
        fs::write(path.join("speed.txt"), "faster").unwrap();
        assert!(merge_worktree(&f.root, &path).unwrap_err().contains("uncommitted"));
        in_worktree(&["add", "speed.txt"]);
        in_worktree(&["-c", "core.hooksPath=/dev/null", "commit", "-m", "Faster"]);
        // The project checkout moves to main for the merge and gains the commit.
        f.git(&["switch", "-c", "elsewhere"]);
        let merged = merge_worktree(&f.root, &path).unwrap();
        assert_eq!((merged.branch.as_str(), merged.target.as_str(), merged.commits), ("pandacode/fast", "main", 1));
        assert_eq!(merged.switched_from.as_deref(), Some("elsewhere"));
        assert_eq!(fs::read_to_string(f.root.join("speed.txt")).unwrap(), "faster");
        assert!(worktree_status(&f.root, &path, None).unwrap().merged);
        // Merging again has nothing left to bring over.
        assert_eq!(merge_worktree(&f.root, &path).unwrap().commits, 0);

        // A conflict aborts cleanly: main keeps its own version and no merge is left open.
        fs::write(f.root.join("speed.txt"), "main's take").unwrap();
        f.git(&["-c", "core.hooksPath=/dev/null", "commit", "-am", "Main"]);
        fs::write(path.join("speed.txt"), "worktree's take").unwrap();
        in_worktree(&["-c", "core.hooksPath=/dev/null", "commit", "-am", "Worktree"]);
        let error = merge_worktree(&f.root, &path).unwrap_err();
        assert!(error.contains("conflicts in speed.txt"), "{error}");
        assert_eq!(fs::read_to_string(f.root.join("speed.txt")).unwrap(), "main's take");
        assert!(!f.root.join(".git/MERGE_HEAD").exists());

        // Uncommitted tracked changes in the project checkout block the merge.
        fs::write(f.root.join("speed.txt"), "edited").unwrap();
        assert!(merge_worktree(&f.root, &path).unwrap_err().contains("project checkout has uncommitted"));
    }

    #[test]
    fn switching_branches_accepts_only_local_branches_and_keeps_uncommitted_work_safe() {
        let f = Fixture::new(true);
        f.git(&["branch", "feature"]);
        assert_eq!(git_switch(&f.root, "feature").unwrap().current, "feature");
        assert_eq!(git_switch(&f.root, "main").unwrap().current, "main");
        assert!(git_switch(&f.root, "--orphan").unwrap_err().contains("no local branch"));
        assert!(git_switch(&f.root, "missing").unwrap_err().contains("no local branch"));

        // A change that the other branch would overwrite stops the switch; nothing is lost.
        fs::write(f.root.join("note.txt"), "on main").unwrap();
        f.git(&["add", "note.txt"]);
        f.git(&["-c", "core.hooksPath=/dev/null", "commit", "-m", "Note"]);
        f.git(&["switch", "feature"]);
        fs::write(f.root.join("note.txt"), "draft").unwrap();
        assert!(git_switch(&f.root, "main").is_err());
        assert_eq!(git_branches(&f.root).unwrap().current, "feature");
        assert_eq!(fs::read_to_string(f.root.join("note.txt")).unwrap(), "draft");
    }

    #[test]
    fn worktree_lifecycle_reports_state_and_removes_only_clean_checkouts() {
        let f = Fixture::new(true);
        fs::write(f.root.join("base.txt"), "base").unwrap();
        git_stage(&f.root, vec!["base.txt".into()], true).unwrap();
        git_commit(&f.root, "Base commit".into()).unwrap();
        let branches = git_branches(&f.root).unwrap();
        assert!(!branches.current.is_empty());
        assert!(branches.branches.contains(&branches.current));
        assert_eq!(branches.default_branch, "main");

        // A start point is honored, an existing branch can be reused, and a duplicate is explained.
        let created = create_worktree_with(&f.root, "lifecycle", Some(&branches.current), false).unwrap();
        assert_eq!(created.branch, "pandacode/lifecycle");
        let duplicate = create_worktree_with(&f.root, "lifecycle", None, false).unwrap_err();
        assert!(duplicate.contains("already exists"), "{duplicate}");
        assert!(create_worktree_with(&f.root, "lifecycle", None, true).is_err(), "branch is checked out");
        assert!(create_worktree_with(&f.root, "ghost", None, true).unwrap_err().contains("does not exist"));
        assert!(create_worktree_with(&f.root, "bad-base", Some("nope"), false).unwrap_err().contains("not found"));

        let status = worktree_status(&f.root, &created.path, Some(&created.branch)).unwrap();
        assert!(status.exists && status.clean && status.merged && !status.has_upstream);
        assert_eq!(status.branch, "pandacode/lifecycle");

        // Dirty checkouts are never removed; the status says why.
        fs::write(created.path.join("wip.txt"), "unsaved").unwrap();
        let dirty = worktree_status(&f.root, &created.path, None).unwrap();
        assert!(!dirty.clean && dirty.changes == 1);
        assert!(remove_worktree(&f.root, &created.path, None, true).is_err());
        assert!(created.path.is_dir());
        fs::remove_file(created.path.join("wip.txt")).unwrap();

        // An unmerged branch survives removal; a merged one is deleted.
        fs::write(created.path.join("feature.txt"), "feature").unwrap();
        git_stage(&created.path, vec!["feature.txt".into()], true).unwrap();
        git_commit(&created.path, "Feature commit".into()).unwrap();
        assert!(!worktree_status(&f.root, &created.path, None).unwrap().merged);
        let removal = remove_worktree(&f.root, &created.path, Some("pandacode/lifecycle"), true).unwrap();
        assert!(removal.removed && !removal.branch_deleted);
        assert!(removal.note.contains("kept"), "{}", removal.note);
        assert!(!created.path.exists());
        assert!(ref_exists(&f.root, "refs/heads/pandacode/lifecycle").unwrap());

        // The branch can come back at the same path, then go for good once merged.
        let restored = recreate_worktree(&f.root, &created.path, Some("pandacode/lifecycle")).unwrap();
        assert_eq!(restored, created.path);
        assert_eq!(git_status(&restored).unwrap().branch, "pandacode/lifecycle");
        checked(run_git(&f.root, &["merge", "--no-edit", "pandacode/lifecycle"], 16 * 1024, false).unwrap()).unwrap();
        assert!(worktree_status(&f.root, &restored, None).unwrap().merged);
        let removal = remove_worktree(&f.root, &restored, None, true).unwrap();
        assert!(removal.removed && removal.branch_deleted && removal.note.is_empty());
        assert!(!ref_exists(&f.root, "refs/heads/pandacode/lifecycle").unwrap());
        assert!(remove_worktree(&f.root, &f.root, None, false).is_err());
    }

    #[test]
    fn missing_worktree_folder_is_recognized_and_recreated_from_the_registry() {
        let f = Fixture::new(true);
        let created = create_worktree_with(&f.root, "vanished", None, false).unwrap();
        let registered = worktree_entry(&f.root, &created.path).unwrap().unwrap();
        assert_eq!(registered.branch.as_deref(), Some("pandacode/vanished"));
        assert!(!registered.prunable);
        fs::remove_dir_all(&created.path).unwrap();
        let registered = worktree_entry(&f.root, &created.path).unwrap().unwrap();
        assert_eq!(registered.branch.as_deref(), Some("pandacode/vanished"));
        assert!(registered.prunable);
        let unrelated = f.base.join("unrelated").join(created.path.file_name().unwrap());
        assert!(worktree_entry(&f.root, &unrelated).unwrap().is_none());
        let status = worktree_status(&f.root, &created.path, None).unwrap();
        assert!(!status.exists);
        assert_eq!(status.branch, "pandacode/vanished", "branch comes from git worktree list");
        let restored = recreate_worktree(&f.root, &created.path, None).unwrap();
        assert!(restored.join(".git").is_file());
        let removal = remove_worktree(&f.root, &restored, None, false).unwrap();
        assert!(removal.removed && !removal.branch_deleted);
        assert!(ref_exists(&f.root, "refs/heads/pandacode/vanished").unwrap());
    }

    #[test]
    fn worktree_preserves_explicit_current_and_legacy_prefixes() {
        let f = Fixture::new(true);
        // Historical branch and path prefixes remain supported after a rename.
        for prefix in ["pandacode", "kingcode", "codex"] {
            let branch = format!("{prefix}/existing-convention");
            let path = create_worktree(&f.root, branch.clone()).unwrap();
            assert_eq!(git_status(&path).unwrap().branch, branch);
            assert_eq!(
                path,
                f.base
                    .join(format!("project-worktrees/{prefix}-existing-convention"))
            );
            assert_eq!(
                legacy_worktree_parent(&path, std::slice::from_ref(&f.root)),
                Some(f.root.clone())
            );
        }
    }
    #[test]
    fn worktree_creates_an_isolated_task_in_the_same_project_and_survives_restart() {
        use crate::storage::Store;
        use std::sync::{Arc, Mutex};
        let fixture = Fixture::new(true);
        fs::write(fixture.root.join("checkout.txt"), "main checkout").unwrap();
        fixture.git(&["add", "checkout.txt"]);
        fixture.git(&[
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            "Track checkout",
        ]);
        let database = fixture.base.join("store.sqlite");
        let store = Arc::new(Mutex::new(Store::open(&database).unwrap()));
        let (project, source) = {
            let store = store.lock().unwrap();
            let project = store.add_project(&fixture.root).unwrap();
            let source = store
                .create_session(&project.id, "codex", "gpt-5.6-sol", "full")
                .unwrap();
            let source = store
                .set_reasoning_effort(&source.id, Some("high"))
                .unwrap();
            store
                .record_context_usage(
                    &source.id,
                    &crate::storage::ContextUsage {
                        used_tokens: 30_000,
                        context_window: Some(200_000),
                    },
                )
                .unwrap();
            store
                .message(&source.id, "user", "Existing conversation")
                .unwrap();
            store.resume(&source.id, "existing-remote-session").unwrap();
            (project, source)
        };
        let task = crate::create_worktree_task(&store, &source.id, "isolated-task".into()).unwrap();
        let path = PathBuf::from(task.worktree_path.as_ref().unwrap());
        assert_ne!(task.id, source.id);
        assert_eq!(task.project_id, project.id);
        assert_eq!(task.provider, source.provider);
        assert_eq!(task.model, source.model);
        assert_eq!(task.reasoning_effort.as_deref(), Some("high"));
        assert!(task.context_usage.is_none());
        assert_eq!(task.mode, "full");
        assert!(task.resume_id.is_none());
        fs::write(path.join("checkout.txt"), "worktree checkout").unwrap();
        {
            let store = store.lock().unwrap();
            assert_eq!(store.projects().unwrap().len(), 1);
            assert_eq!(store.sessions().unwrap().len(), 2);
            assert!(store.messages(&task.id, None).unwrap().is_empty());
            assert_eq!(
                store.session(&source.id).unwrap().resume_id.as_deref(),
                Some("existing-remote-session")
            );
            let worktree_root = store.workspace_root(&project.id, Some(&task.id)).unwrap();
            let main_root = store.workspace_root(&project.id, Some(&source.id)).unwrap();
            assert_eq!(
                read_file(&worktree_root, "checkout.txt".into()).unwrap(),
                "worktree checkout"
            );
            assert_eq!(
                read_file(&main_root, "checkout.txt".into()).unwrap(),
                "main checkout"
            );
            assert_eq!(
                store.workspace_root(&project.id, None).unwrap(),
                fixture.root
            );
            assert_eq!(
                git_status(&worktree_root).unwrap().branch,
                "pandacode/isolated-task"
            );
            assert_eq!(git_status(&main_root).unwrap().branch, "main");
            git_stage(&worktree_root, vec!["checkout.txt".into()], true).unwrap();
            assert_eq!(git_status(&worktree_root).unwrap().files[0].index, "M");
            assert!(git_status(&main_root).unwrap().files.is_empty());
            git_commit(&worktree_root, "Change worktree checkout".into()).unwrap();
        }
        let nested = crate::create_worktree_task(&store, &task.id, "nested-task".into()).unwrap();
        assert_eq!(nested.project_id, project.id);
        assert_eq!(nested.reasoning_effort.as_deref(), Some("high"));
        assert!(nested.context_usage.is_none());
        assert_eq!(
            read_file(
                Path::new(nested.worktree_path.as_ref().unwrap()),
                "checkout.txt".into()
            )
            .unwrap(),
            "worktree checkout"
        );
        assert_eq!(store.lock().unwrap().projects().unwrap().len(), 1);
        drop(store);
        let reopened = Store::open(&database).unwrap();
        assert_eq!(
            reopened
                .session(&task.id)
                .unwrap()
                .reasoning_effort
                .as_deref(),
            Some("high")
        );
        assert!(reopened.session(&task.id).unwrap().context_usage.is_none());
        assert_eq!(
            reopened.session(&task.id).unwrap().worktree_path,
            task.worktree_path
        );
        assert_eq!(
            reopened
                .workspace_root(&project.id, Some(&nested.id))
                .unwrap(),
            PathBuf::from(nested.worktree_path.unwrap())
        );
    }

    #[test]
    fn worktree_task_rejects_project_reassignment_mismatched_context_and_missing_checkout() {
        use crate::storage::Store;
        use std::sync::{Arc, Mutex};
        let fixture = Fixture::new(true);
        let store = Arc::new(Mutex::new(Store::open(Path::new(":memory:")).unwrap()));
        let source = {
            let store = store.lock().unwrap();
            let project = store.add_project(&fixture.root).unwrap();
            store
                .create_session(&project.id, "claude", "sonnet", "ask")
                .unwrap()
        };
        let task = crate::create_worktree_task(&store, &source.id, "guarded-task".into()).unwrap();
        {
            let store = store.lock().unwrap();
            let other = store.add_project(&fixture.base).unwrap();
            assert!(store
                .workspace_root(&other.id, Some(&task.id))
                .unwrap_err()
                .contains("does not belong"));
            assert!(store
                .configure(&task.id, "kimi", "other-model", Some(&other.id))
                .unwrap_err()
                .contains("original project"));
            let unchanged = store.session(&task.id).unwrap();
            assert_eq!(unchanged.provider, "claude");
            assert_eq!(unchanged.model, "sonnet");
            assert_eq!(unchanged.project_id, source.project_id);
            let changed = store
                .configure(&task.id, "kimi", "kimi-code", Some(&source.project_id))
                .unwrap();
            assert_eq!(changed.provider, "kimi");
            assert_eq!(changed.worktree_path, task.worktree_path);
            let metadata_path = Path::new(task.worktree_path.as_ref().unwrap()).join(".git");
            let metadata = fs::read(&metadata_path).unwrap();
            fs::remove_file(&metadata_path).unwrap();
            assert!(store
                .workspace_root(&source.project_id, Some(&task.id))
                .unwrap_err()
                .contains("Git metadata is missing"));
            fs::write(metadata_path, metadata).unwrap();
            fs::remove_dir_all(task.worktree_path.as_ref().unwrap()).unwrap();
            assert!(store
                .workspace_root(&source.project_id, Some(&task.id))
                .unwrap_err()
                .contains("Worktree folder is unavailable"));
            assert_eq!(
                store
                    .workspace_root(&source.project_id, Some(&source.id))
                    .unwrap(),
                fixture.root
            );
        }
        assert!(
            crate::create_worktree_task(&store, &task.id, "missing-parent".into())
                .unwrap_err()
                .contains("Worktree folder is unavailable")
        );
        assert_eq!(store.lock().unwrap().sessions().unwrap().len(), 2);
        assert!(!fixture
            .base
            .join("project-worktrees/pandacode-missing-parent")
            .exists());
    }

    #[test]
    fn legacy_worktree_projects_migrate_without_losing_history_or_touching_files() {
        use crate::storage::Store;
        let fixture = Fixture::new(true);
        let first_path = create_worktree(&fixture.root, "kingcode/legacy-task".into()).unwrap();
        let empty_path = create_worktree(&fixture.root, "kingcode/empty-task".into()).unwrap();
        fs::write(first_path.join("unsaved.txt"), "keep uncommitted work").unwrap();
        let database = fixture.base.join("legacy.sqlite");
        let (main, task, legacy_id);
        {
            let store = Store::open(&database).unwrap();
            main = store.add_project(&fixture.root).unwrap();
            let legacy = store.add_project(&first_path).unwrap();
            legacy_id = legacy.id.clone();
            store.add_project(&empty_path).unwrap();
            task = store
                .create_session(&legacy.id, "codex", "gpt-5.6-sol", "plan")
                .unwrap();
            store
                .update(
                    &task.id,
                    Some("Keep this title".into()),
                    Some(true),
                    None,
                    None,
                )
                .unwrap();
            store
                .message(&task.id, "user", "Keep this conversation")
                .unwrap();
            store.resume(&task.id, "keep-provider-resume").unwrap();
            // Recreate the last released schema to exercise the real upgrade.
            store
                .db
                .execute_batch(
                    "ALTER TABLE sessions DROP COLUMN goal_state; ALTER TABLE sessions DROP COLUMN codex_settings; DROP TABLE subagents; DROP INDEX sessions_completed_archive; ALTER TABLE sessions DROP COLUMN task_stage; ALTER TABLE sessions DROP COLUMN task_description; ALTER TABLE sessions DROP COLUMN completed_at; ALTER TABLE sessions DROP COLUMN reasoning_effort; ALTER TABLE sessions DROP COLUMN context_used_tokens; ALTER TABLE sessions DROP COLUMN context_window; ALTER TABLE messages DROP COLUMN turn_duration_ms; ALTER TABLE sessions DROP COLUMN worktree_path; PRAGMA user_version=3;",
                )
                .unwrap();
        }
        {
            let store = Store::open(&database).unwrap();
            assert_eq!(store.projects().unwrap().len(), 1);
            assert_eq!(store.projects().unwrap()[0].id, main.id);
            assert!(store.project(&legacy_id).is_err());
            let migrated = store.session(&task.id).unwrap();
            assert_eq!(migrated.project_id, main.id);
            assert_eq!(migrated.worktree_path.as_deref(), first_path.to_str());
            assert_eq!(migrated.title, "Keep this title");
            // There is no archive: an archived task is settled when the store opens.
            assert!(!migrated.archived);
            assert_eq!(migrated.task_stage, "completed");
            assert_eq!(migrated.mode, "plan");
            assert_eq!(migrated.resume_id.as_deref(), Some("keep-provider-resume"));
            assert_eq!(
                store.messages(&task.id, None).unwrap()[0].content,
                "Keep this conversation"
            );
            let empty = store
                .sessions()
                .unwrap()
                .into_iter()
                .find(|session| session.worktree_path.as_deref() == empty_path.to_str())
                .unwrap();
            assert_eq!(empty.project_id, main.id);
            assert!(store.messages(&empty.id, None).unwrap().is_empty());
            assert_eq!(
                fs::read_to_string(first_path.join("unsaved.txt")).unwrap(),
                "keep uncommitted work"
            );
            assert_eq!(
                git_status(&empty_path).unwrap().branch,
                "kingcode/empty-task"
            );
        }
        let reopened = Store::open(&database).unwrap();
        assert_eq!(reopened.projects().unwrap().len(), 1);
        assert_eq!(reopened.sessions().unwrap().len(), 2);
        assert_eq!(reopened.session(&task.id).unwrap().id, task.id);
    }

    #[test]
    fn nested_legacy_worktrees_migrate_directly_to_main_before_or_after_v4_in_any_order() {
        use crate::storage::Store;
        for old_version in [3, 4] {
            for reverse_order in [false, true] {
                let fixture = Fixture::new(true);
                let new_path = create_worktree(&fixture.root, "kingcode/New".into()).unwrap();
                let yo_path = create_worktree(&new_path, "kingcode/Yo".into()).unwrap();
                fs::write(yo_path.join("draft.txt"), "preserve nested changes").unwrap();
                let database = fixture.base.join("nested.sqlite");
                let (main, new_task, yo_task);
                {
                    let store = Store::open(&database).unwrap();
                    main = store.add_project(&fixture.root).unwrap();
                    let new_project = if old_version == 3 {
                        store.add_project(&new_path).unwrap()
                    } else {
                        main.clone()
                    };
                    let yo_project = store.add_project(&yo_path).unwrap();
                    if old_version == 3 {
                        store
                            .db
                            .execute(
                                "UPDATE projects SET name=?2 WHERE id=?1",
                                [
                                    new_project.id.as_str(),
                                    if reverse_order { "Z-New" } else { "A-New" },
                                ],
                            )
                            .unwrap();
                    }
                    store
                        .db
                        .execute(
                            "UPDATE projects SET name=?2 WHERE id=?1",
                            [
                                yo_project.id.as_str(),
                                if reverse_order { "A-Yo" } else { "Z-Yo" },
                            ],
                        )
                        .unwrap();
                    new_task = store
                        .create_session(&new_project.id, "codex", "default", "ask")
                        .unwrap();
                    yo_task = store
                        .create_session(&yo_project.id, "claude", "sonnet", "plan")
                        .unwrap();
                    store
                        .message(&yo_task.id, "user", "Keep nested history")
                        .unwrap();
                    store.resume(&yo_task.id, "nested-resume").unwrap();
                    if old_version == 3 {
                        store.db.execute_batch("ALTER TABLE sessions DROP COLUMN goal_state; ALTER TABLE sessions DROP COLUMN codex_settings; DROP TABLE subagents; DROP INDEX sessions_completed_archive; ALTER TABLE sessions DROP COLUMN task_stage; ALTER TABLE sessions DROP COLUMN task_description; ALTER TABLE sessions DROP COLUMN completed_at; ALTER TABLE sessions DROP COLUMN reasoning_effort; ALTER TABLE sessions DROP COLUMN context_used_tokens; ALTER TABLE sessions DROP COLUMN context_window; ALTER TABLE messages DROP COLUMN turn_duration_ms; ALTER TABLE sessions DROP COLUMN worktree_path; PRAGMA user_version=3;").unwrap();
                    } else {
                        // Match an installed v4 build: New is already a task,
                        // while its nested Yo checkout remains a project.
                        store
                            .db
                            .execute(
                                "UPDATE sessions SET worktree_path=?2 WHERE id=?1",
                                [&new_task.id, new_path.to_str().unwrap()],
                            )
                            .unwrap();
                        store
                            .db
                            .execute_batch("ALTER TABLE sessions DROP COLUMN goal_state; ALTER TABLE sessions DROP COLUMN codex_settings; DROP TABLE subagents; DROP INDEX sessions_completed_archive; ALTER TABLE sessions DROP COLUMN task_stage; ALTER TABLE sessions DROP COLUMN task_description; ALTER TABLE sessions DROP COLUMN completed_at; ALTER TABLE sessions DROP COLUMN reasoning_effort; ALTER TABLE sessions DROP COLUMN context_used_tokens; ALTER TABLE sessions DROP COLUMN context_window; ALTER TABLE messages DROP COLUMN turn_duration_ms;")
                            .unwrap();
                        store.db.pragma_update(None, "user_version", 4).unwrap();
                    }
                }
                {
                    let store = Store::open(&database).unwrap();
                    assert_eq!(
                        store.projects().unwrap().len(),
                        1,
                        "v{old_version}, reverse={reverse_order}"
                    );
                    assert_eq!(store.projects().unwrap()[0].id, main.id);
                    assert_eq!(store.sessions().unwrap().len(), 2);
                    for (task, path) in [(&new_task, &new_path), (&yo_task, &yo_path)] {
                        let migrated = store.session(&task.id).unwrap();
                        assert_eq!(migrated.project_id, main.id);
                        assert_eq!(migrated.worktree_path.as_deref(), path.to_str());
                        assert_eq!(
                            store.workspace_root(&main.id, Some(&task.id)).unwrap(),
                            *path
                        );
                    }
                    assert_eq!(
                        store.session(&yo_task.id).unwrap().resume_id.as_deref(),
                        Some("nested-resume")
                    );
                    assert_eq!(
                        store.messages(&yo_task.id, None).unwrap()[0].content,
                        "Keep nested history"
                    );
                    assert_eq!(
                        fs::read_to_string(yo_path.join("draft.txt")).unwrap(),
                        "preserve nested changes"
                    );
                    assert_eq!(
                        store
                            .db
                            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                            .unwrap(),
                        crate::storage::SCHEMA_VERSION
                    );
                }
                let reopened = Store::open(&database).unwrap();
                assert_eq!(reopened.projects().unwrap().len(), 1);
                assert_eq!(reopened.sessions().unwrap().len(), 2);
            }
        }
    }

    #[test]
    fn legacy_migration_ignores_unregistered_roots_custom_paths_and_unrelated_repositories() {
        let fixture = Fixture::new(true);
        let worktree = create_worktree(&fixture.root, "recognized".into()).unwrap();
        assert_eq!(
            legacy_worktree_parent(&worktree, std::slice::from_ref(&fixture.root)),
            Some(fixture.root.clone())
        );
        assert!(legacy_worktree_parent(&worktree, &[]).is_none());
        let custom = fixture.base.join("custom-worktree");
        fixture.git(&["worktree", "add", "-b", "custom", custom.to_str().unwrap()]);
        assert!(legacy_worktree_parent(&custom, std::slice::from_ref(&fixture.root)).is_none());
        let nested_custom = create_worktree(&custom, "nested-custom".into()).unwrap();
        assert!(
            legacy_worktree_parent(&nested_custom, std::slice::from_ref(&fixture.root)).is_none()
        );
        let unrelated = fixture.base.join("project-worktrees/kingcode-unrelated");
        let other = Fixture::new(true);
        other.git(&[
            "worktree",
            "add",
            "-b",
            "different-repository",
            unrelated.to_str().unwrap(),
        ]);
        assert!(legacy_worktree_parent(&unrelated, std::slice::from_ref(&fixture.root)).is_none());
    }

    // Multi-folder resolution: resolve_in_folders maps an agent- or user-supplied
    // path onto one folder of a task's folder set (storage::RepoFolder as
    // Store::workspace_folders builds it: path is the effective root, worktree
    // records the checkout when one exists).
    use crate::storage::RepoFolder;

    fn repo_folder(path: &Path, label: &str, is_primary: bool) -> RepoFolder {
        RepoFolder {
            path: fs::canonicalize(path).unwrap(),
            label: label.into(),
            is_primary,
            worktree: None,
            branch: None,
        }
    }

    #[test]
    fn resolve_in_folders_routes_relative_input_to_primary_and_absolute_to_its_folder() {
        let f = Fixture::new(false);
        let docs = f.base.join("docs");
        fs::create_dir_all(&docs).unwrap();
        let docs = fs::canonicalize(&docs).unwrap();
        fs::write(f.root.join("app.txt"), "one\n").unwrap();
        fs::write(docs.join("guide.md"), "two\n").unwrap();
        let folders = vec![
            repo_folder(&f.root, "app", true),
            repo_folder(&docs, "docs", false),
        ];
        // Relative input means the primary folder, exactly as a single-root task
        // resolves it today.
        assert_eq!(
            resolve_in_folders(&folders, "app.txt").unwrap(),
            (0, f.root.join("app.txt"))
        );
        // A relative path never reaches an additional folder, even when only that
        // folder holds the file.
        assert_eq!(
            resolve_in_folders(&folders, "guide.md").unwrap(),
            (0, f.root.join("guide.md"))
        );
        // Absolute input resolves inside the one folder that contains it.
        assert_eq!(
            resolve_in_folders(&folders, docs.join("guide.md").to_str().unwrap()).unwrap(),
            (1, docs.join("guide.md"))
        );
        assert_eq!(
            resolve_in_folders(&folders, f.root.join("app.txt").to_str().unwrap()).unwrap(),
            (0, f.root.join("app.txt"))
        );
    }

    #[test]
    fn resolve_in_folders_with_one_folder_behaves_as_scoped_path_does_today() {
        let f = Fixture::new(false);
        fs::write(f.root.join("real.txt"), "x\n").unwrap();
        let folders = vec![repo_folder(&f.root, "app", true)];
        for input in ["real.txt", "./real.txt", "made/up/missing.txt"] {
            assert_eq!(
                resolve_in_folders(&folders, input).unwrap(),
                (0, scoped_path(&f.root, input).unwrap()),
                "single-folder resolution matches today: {input}"
            );
        }
        for input in ["../escape.txt", ".git/config", "", "nul\0byte"] {
            assert_eq!(
                resolve_in_folders(&folders, input).is_err(),
                scoped_path(&f.root, input).is_err(),
                "single-folder refusals match today: {input}"
            );
        }
    }

    #[test]
    fn resolve_in_folders_names_the_task_folders_when_an_absolute_path_matches_none() {
        let f = Fixture::new(false);
        let docs = f.base.join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(f.base.join("elsewhere.txt"), "outside every folder\n").unwrap();
        let folders = vec![
            repo_folder(&f.root, "app", true),
            repo_folder(&docs, "docs", false),
        ];
        let error = resolve_in_folders(&folders, f.base.join("elsewhere.txt").to_str().unwrap())
            .unwrap_err();
        assert!(
            error.to_lowercase().contains("outside")
                && error.to_lowercase().contains("folder"),
            "the error names that the path is outside the task's folders: {error}"
        );
    }

    #[test]
    fn resolve_in_folders_refuses_git_directory_paths_in_any_folder() {
        let f = Fixture::new(false);
        let docs = f.base.join("docs");
        fs::create_dir_all(docs.join(".git")).unwrap();
        fs::write(docs.join(".git/config"), "[core]\n").unwrap();
        fs::write(f.root.join(".gitignore"), "ignored names\n").unwrap();
        let folders = vec![
            repo_folder(&f.root, "app", true),
            repo_folder(&docs, "docs", false),
        ];
        assert!(resolve_in_folders(&folders, ".git/config").is_err());
        assert!(resolve_in_folders(&folders, docs.join(".git/config").to_str().unwrap()).is_err());
        // .gitignore is an ordinary file, not the .git directory.
        assert_eq!(
            resolve_in_folders(&folders, ".gitignore").unwrap(),
            (0, f.root.join(".gitignore"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_in_folders_refuses_symlinks_that_escape_their_folder() {
        let f = Fixture::new(false);
        let docs = f.base.join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(f.base.join("secret.txt"), "private\n").unwrap();
        std::os::unix::fs::symlink(f.base.join("secret.txt"), docs.join("leak.txt")).unwrap();
        fs::write(docs.join("local.txt"), "safe\n").unwrap();
        std::os::unix::fs::symlink("local.txt", docs.join("stay.txt")).unwrap();
        let folders = vec![
            repo_folder(&f.root, "app", true),
            repo_folder(&docs, "docs", false),
        ];
        assert!(
            resolve_in_folders(&folders, docs.join("leak.txt").to_str().unwrap()).is_err(),
            "a symlink escaping its folder is refused even though the input is absolute"
        );
        let (index, path): (usize, PathBuf) =
            resolve_in_folders(&folders, docs.join("stay.txt").to_str().unwrap())
                .expect("a symlink that stays inside its folder resolves");
        assert_eq!(index, 1);
        assert!(path.starts_with(&docs));
    }

    #[test]
    fn resolve_in_folders_resolves_inside_a_folders_worktree_checkout() {
        let f = Fixture::new(false);
        let checkout = f.base.join("worktrees/docs-task");
        fs::create_dir_all(&checkout).unwrap();
        fs::write(checkout.join("guide.md"), "checked out\n").unwrap();
        let checkout = fs::canonicalize(&checkout).unwrap();
        let folders = vec![
            repo_folder(&f.root, "app", true),
            RepoFolder {
                path: checkout.clone(),
                label: "docs".into(),
                is_primary: false,
                worktree: Some(checkout.clone()),
                branch: Some("task-branch".into()),
            },
        ];
        assert_eq!(
            resolve_in_folders(&folders, checkout.join("guide.md").to_str().unwrap()).unwrap(),
            (1, checkout.join("guide.md"))
        );
    }

    // Multi-repo worktree tasks: git at an arbitrary folder (Fixture covers only
    // its own root) and a project whose primary is the fixture's repository plus
    // one folder per extra name (`repo` extras become single-commit repositories,
    // plain extras stay ordinary folders).
    fn git_at(dir: &Path, args: &[&str]) {
        let result = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "git {:?} in {}: {}",
            args,
            dir.display(),
            String::from_utf8_lossy(&result.stderr)
        );
    }

    fn init_repo_at(path: &Path, file: &str) {
        fs::create_dir_all(path).unwrap();
        git_at(path, &["init", "-b", "main"]);
        git_at(path, &["config", "user.name", "Workspace Tests"]);
        git_at(path, &["config", "user.email", "workspace@example.invalid"]);
        git_at(path, &["config", "commit.gpgSign", "false"]);
        fs::write(path.join(file), "initial\n").unwrap();
        git_at(path, &["add", file]);
        git_at(path, &["-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial"]);
    }

    fn folder_project(
        f: &Fixture,
        extras: &[(&str, bool)],
    ) -> (
        std::sync::Arc<std::sync::Mutex<crate::storage::Store>>,
        crate::storage::Project,
        crate::storage::Session,
    ) {
        let store = std::sync::Arc::new(std::sync::Mutex::new(
            crate::storage::Store::open(Path::new(":memory:")).unwrap(),
        ));
        let guard = store.lock().unwrap();
        let project = guard.add_project(&f.root).unwrap();
        for (name, repo) in extras {
            let path = f.base.join(name);
            if *repo {
                init_repo_at(&path, &format!("{name}.txt"));
            } else {
                fs::create_dir_all(&path).unwrap();
            }
            guard.add_project_folder(&project.id, &path).unwrap();
        }
        let session = guard
            .create_session(&project.id, "claude", "sonnet", "full")
            .unwrap();
        drop(guard);
        (store, project, session)
    }

    /// REGRESSION PIN (passes before the multi-repo worktree change): a
    /// single-folder project's worktree task records exactly today's state, one
    /// checkout in sessions.worktree_path and no per-repo rows at all.
    #[test]
    fn single_folder_worktree_creation_records_only_the_primary() {
        use crate::storage::Store;
        use std::sync::{Arc, Mutex};
        let f = Fixture::new(true);
        let store = Arc::new(Mutex::new(Store::open(Path::new(":memory:")).unwrap()));
        let project = store.lock().unwrap().add_project(&f.root).unwrap();
        let source = store
            .lock()
            .unwrap()
            .create_session(&project.id, "claude", "sonnet", "full")
            .unwrap();
        let task = crate::create_worktree_task(&store, &source.id, "solo".into()).unwrap();
        assert_eq!(
            PathBuf::from(task.worktree_path.clone().unwrap()),
            fs::canonicalize(f.base.join("project-worktrees/pandacode-solo")).unwrap()
        );
        {
            let store = store.lock().unwrap();
            let repos: i64 = store
                .db
                .query_row("SELECT COUNT(*) FROM session_repos", [], |r| r.get(0))
                .unwrap();
            assert_eq!(repos, 1, "a single-folder task records only the primary pin");
            let (path, worktree): (String, String) = store
                .db
                .query_row("SELECT path,worktree_path FROM session_repos", [], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap();
            assert_eq!(PathBuf::from(path), PathBuf::from(&project.path), "the pin names the primary folder");
            assert_eq!(
                PathBuf::from(worktree),
                fs::canonicalize(f.base.join("project-worktrees/pandacode-solo")).unwrap(),
                "the pin carries the task's worktree"
            );
            assert_eq!(store.workspace_folders(&project.id, &task.id).unwrap().len(), 1);
        }
    }

    /// REGRESSION PIN (passes before the multi-repo worktree change):
    /// workspace_root keeps meaning the primary repository's checkout even in a
    /// multi-folder project; additional folders never move it.
    #[test]
    fn workspace_root_stays_the_primary_checkout_in_multi_folder_projects() {
        use std::sync::{Arc, Mutex};
        let f = Fixture::new(true);
        let store = Arc::new(Mutex::new(crate::storage::Store::open(Path::new(":memory:")).unwrap()));
        let project = store.lock().unwrap().add_project(&f.root).unwrap();
        let docs = f.base.join("docs");
        fs::create_dir_all(&docs).unwrap();
        store.lock().unwrap().add_project_folder(&project.id, &docs).unwrap();
        let source = store
            .lock()
            .unwrap()
            .create_session(&project.id, "claude", "sonnet", "full")
            .unwrap();
        let task = crate::create_worktree_task(&store, &source.id, "primary-only".into()).unwrap();
        let worktree =
            fs::canonicalize(f.base.join("project-worktrees/pandacode-primary-only")).unwrap();
        let store = store.lock().unwrap();
        assert_eq!(store.workspace_root(&project.id, Some(&task.id)).unwrap(), worktree);
        assert_eq!(store.workspace_root(&project.id, Some(&source.id)).unwrap(), f.root);
        assert_eq!(store.workspace_root(&project.id, None).unwrap(), f.root);
    }

    /// The existing worktree entry points gain the per-repo loop without changing
    /// shape: the return stays a plain Session (the type annotation is the
    /// signature pin) and the additional repository gets its checkout in the store.
    #[test]
    fn the_existing_worktree_entry_point_creates_per_repo_worktrees_unchanged() {
        let f = Fixture::new(true);
        let (store, project, source) = folder_project(&f, &[("lib", true)]);
        let task: crate::storage::Session = crate::create_worktree_task_with_defaults(
            &store,
            &source.id,
            "entry".into(),
            None,
            false,
            false,
        )
        .unwrap();
        assert!(task.worktree_path.is_some());
        let lib_entry = store
            .lock()
            .unwrap()
            .workspace_folders(&project.id, &task.id)
            .unwrap()[1]
            .clone();
        assert!(
            lib_entry
                .worktree
                .as_ref()
                .is_some_and(|wt| wt.ends_with("lib-worktrees/pandacode-entry")),
            "every entry point creates the per-repo checkouts, not just the new one: {lib_entry:?}"
        );
    }

    /// A worktree task in a multi-folder project carries one checkout per
    /// repository folder: the same branch name in each, each beside its own
    /// folder, the primary in sessions.worktree_path and the others per session
    /// repo. Plain folders are skipped: no checkout, no row, no outcome.
    #[test]
    fn multi_repo_worktree_tasks_create_one_worktree_per_repo_folder() {
        let f = Fixture::new(true);
        let (store, project, source) = folder_project(&f, &[("lib", true), ("docs", false)]);
        let (task, outcomes): (
            crate::storage::Session,
            Vec<crate::RepoWorktreeOutcome>,
        ) = crate::create_worktree_task_with_repos(
            &store,
            &source.id,
            "multi".into(),
            None,
            false,
            false,
        )
        .unwrap();
        let primary_worktree =
            fs::canonicalize(f.base.join("project-worktrees/pandacode-multi")).unwrap();
        let lib_worktree =
            fs::canonicalize(f.base.join("lib-worktrees/pandacode-multi")).unwrap();
        let docs = fs::canonicalize(f.base.join("docs")).unwrap();

        assert_eq!(
            PathBuf::from(task.worktree_path.clone().unwrap()),
            primary_worktree,
            "the primary worktree stays in sessions.worktree_path"
        );
        assert_eq!(task.worktree_branch.as_deref(), Some("pandacode/multi"));
        assert_eq!(outcomes.len(), 1, "only additional git repositories report outcomes");
        assert_eq!(outcomes[0].label, "lib");
        let created = outcomes[0].result.as_ref().expect("the lib checkout succeeds");
        assert_eq!(
            (created.path.as_path(), created.branch.as_str()),
            (lib_worktree.as_path(), "pandacode/multi"),
            "the same branch name in every repository"
        );

        assert_eq!(git_status(&primary_worktree).unwrap().branch, "pandacode/multi");
        assert_eq!(git_status(&lib_worktree).unwrap().branch, "pandacode/multi");
        assert_eq!(
            fs::read_to_string(lib_worktree.join("lib.txt")).unwrap(),
            "initial\n",
            "the checkout carries the repository's committed files"
        );
        assert!(!f.base.join("docs-worktrees").exists(), "plain folders get no worktree");

        {
            let store = store.lock().unwrap();
            assert_eq!(
                store.workspace_folders(&project.id, &task.id).unwrap(),
                vec![
                    RepoFolder {
                        path: primary_worktree.clone(),
                        label: "project".into(),
                        is_primary: true,
                        worktree: Some(primary_worktree.clone()),
                        branch: Some("pandacode/multi".into()),
                    },
                    RepoFolder {
                        path: lib_worktree.clone(),
                        label: "lib".into(),
                        is_primary: false,
                        worktree: Some(lib_worktree.clone()),
                        branch: Some("pandacode/multi".into()),
                    },
                    RepoFolder {
                        path: docs.clone(),
                        label: "docs".into(),
                        is_primary: false,
                        worktree: None,
                        branch: None,
                    },
                ]
            );
            let repos: i64 = store
                .db
                .query_row(
                    "SELECT COUNT(*) FROM session_repos WHERE session_id=?1",
                    [&task.id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(repos, 2, "the primary pin plus the additional repository are recorded");
        }
        assert!(
            store
                .lock()
                .unwrap()
                .session(&source.id)
                .unwrap()
                .worktree_path
                .is_none(),
            "the source task itself is untouched, exactly as today"
        );
    }

    /// A repository whose checkout fails never aborts the task: the task exists
    /// with the primary and the repositories that succeeded, the failure rides
    /// the per-repo outcomes, and the failed repository records nothing.
    #[test]
    fn a_failing_repo_worktree_never_aborts_the_task_and_is_reported_per_repo() {
        let f = Fixture::new(true);
        let (store, project, source) =
            folder_project(&f, &[("lib", true), ("util", true), ("docs", false)]);
        // The lib worktree destination is already taken, so its checkout fails.
        fs::create_dir_all(f.base.join("lib-worktrees/pandacode-multi")).unwrap();
        let (task, outcomes): (
            crate::storage::Session,
            Vec<crate::RepoWorktreeOutcome>,
        ) = crate::create_worktree_task_with_repos(
            &store,
            &source.id,
            "multi".into(),
            None,
            false,
            false,
        )
        .unwrap();
        let util_worktree =
            fs::canonicalize(f.base.join("util-worktrees/pandacode-multi")).unwrap();
        let lib = fs::canonicalize(f.base.join("lib")).unwrap();

        assert!(
            task.worktree_path.is_some(),
            "the task is created with the primary worktree"
        );
        assert_eq!(
            outcomes.len(),
            2,
            "one outcome per additional git repository, in folder order"
        );
        assert_eq!(outcomes[0].label, "lib");
        let error = outcomes[0].result.as_ref().unwrap_err();
        assert!(error.contains("already exists"), "{error}");
        assert_eq!(outcomes[1].label, "util");
        assert_eq!(outcomes[1].result.as_ref().unwrap().path, util_worktree);

        let folders = store
            .lock()
            .unwrap()
            .workspace_folders(&project.id, &task.id)
            .unwrap();
        assert_eq!(
            folders[1],
            RepoFolder {
                path: lib,
                label: "lib".into(),
                is_primary: false,
                worktree: None,
                branch: None,
            },
            "the failed repository keeps its main checkout and records nothing"
        );
        assert_eq!(folders[2].worktree.as_deref(), Some(util_worktree.as_path()));
    }

    /// The multi paths query lists every repository with its main checkout and
    /// this task's checkout; plain folders never appear; the primary is first.
    #[test]
    fn worktree_paths_all_lists_each_repository_with_its_main_and_worktree() {
        let f = Fixture::new(true);
        let (store, _project, source) = folder_project(&f, &[("lib", true), ("docs", false)]);
        let (task, _) = crate::create_worktree_task_with_repos(
            &store,
            &source.id,
            "multi".into(),
            None,
            false,
            false,
        )
        .unwrap();
        assert_eq!(
            crate::worktree_paths_all(&store, &task.id).unwrap(),
            vec![
                crate::RepoWorktreePaths {
                    label: "project".into(),
                    main: f.root.clone(),
                    worktree: Some(
                        fs::canonicalize(f.base.join("project-worktrees/pandacode-multi"))
                            .unwrap()
                    ),
                    branch: Some("pandacode/multi".into()),
                },
                crate::RepoWorktreePaths {
                    label: "lib".into(),
                    main: fs::canonicalize(f.base.join("lib")).unwrap(),
                    worktree: Some(
                        fs::canonicalize(f.base.join("lib-worktrees/pandacode-multi")).unwrap()
                    ),
                    branch: Some("pandacode/multi".into()),
                },
            ],
            "one entry per repository; plain folders are never listed"
        );
    }

    /// A repository whose checkout failed still lists, with no worktree, and the
    /// multi query keeps today's refusal for tasks without a worktree.
    #[test]
    fn worktree_paths_all_lists_repos_without_a_worktree_and_keeps_today_refusals() {
        let f = Fixture::new(true);
        let (store, _project, source) =
            folder_project(&f, &[("lib", true), ("util", true), ("docs", false)]);
        fs::create_dir_all(f.base.join("lib-worktrees/pandacode-multi")).unwrap();
        let (task, _) = crate::create_worktree_task_with_repos(
            &store,
            &source.id,
            "multi".into(),
            None,
            false,
            false,
        )
        .unwrap();
        let paths = crate::worktree_paths_all(&store, &task.id).unwrap();
        assert_eq!(paths.len(), 3, "the primary, the failed lib and util");
        assert_eq!(
            paths[1],
            crate::RepoWorktreePaths {
                label: "lib".into(),
                main: fs::canonicalize(f.base.join("lib")).unwrap(),
                worktree: None,
                branch: None,
            }
        );
        let error = crate::worktree_paths_all(&store, &source.id).unwrap_err();
        assert!(
            error.contains("main checkout"),
            "a task without a worktree keeps today's refusal: {error}"
        );
    }

    /// A single-folder task keeps exactly today's values in the multi query.
    #[test]
    fn worktree_paths_all_keeps_today_single_folder_values() {
        use crate::storage::Store;
        use std::sync::{Arc, Mutex};
        let f = Fixture::new(true);
        let store = Arc::new(Mutex::new(Store::open(Path::new(":memory:")).unwrap()));
        let project = store.lock().unwrap().add_project(&f.root).unwrap();
        let source = store
            .lock()
            .unwrap()
            .create_session(&project.id, "claude", "sonnet", "full")
            .unwrap();
        let task = crate::create_worktree_task(&store, &source.id, "solo".into()).unwrap();
        assert_eq!(
            crate::worktree_paths_all(&store, &task.id).unwrap(),
            vec![crate::RepoWorktreePaths {
                label: "project".into(),
                main: f.root.clone(),
                worktree: Some(PathBuf::from(task.worktree_path.clone().unwrap())),
                branch: task.worktree_branch.clone(),
            }],
            "single-folder tasks return exactly one entry with today's values"
        );
    }

    /// The folder qualifier resolves by label or effective path and defaults to
    /// the primary repository, whose effective path is the task's own checkout.
    #[test]
    fn git_repo_folder_qualifies_labels_and_paths_and_defaults_to_the_primary() {
        let f = Fixture::new(true);
        let (store, project, source) = folder_project(&f, &[("lib", true), ("docs", false)]);
        let (task, _) = crate::create_worktree_task_with_repos(
            &store,
            &source.id,
            "multi".into(),
            None,
            false,
            false,
        )
        .unwrap();
        let primary_worktree =
            fs::canonicalize(f.base.join("project-worktrees/pandacode-multi")).unwrap();
        let lib_worktree =
            fs::canonicalize(f.base.join("lib-worktrees/pandacode-multi")).unwrap();
        let lib = fs::canonicalize(f.base.join("lib")).unwrap();
        let docs = fs::canonicalize(f.base.join("docs")).unwrap();
        let resolve = |session: Option<&str>, qualifier: Option<&str>| {
            let store = store.lock().unwrap();
            crate::git_repo_folder(&store, &project.id, session, qualifier).unwrap()
        };

        let primary = resolve(Some(&task.id), None);
        assert!(primary.is_primary && primary.worktree.is_some());
        assert_eq!(
            primary.path, primary_worktree,
            "no qualifier keeps meaning the primary, worktree included"
        );
        assert_eq!(
            resolve(Some(&task.id), Some("project")).path,
            primary_worktree,
            "the primary answers to its label too"
        );
        assert_eq!(resolve(Some(&task.id), Some("lib")).path, lib_worktree);
        assert_eq!(
            resolve(Some(&task.id), Some(lib_worktree.to_str().unwrap())).path,
            lib_worktree,
            "the effective path qualifies"
        );
        assert_eq!(resolve(Some(&task.id), Some("docs")).path, docs);
        assert_eq!(resolve(Some(&task.id), Some(docs.to_str().unwrap())).path, docs);

        // A task without worktrees, and no session at all, resolve the plain folders.
        assert_eq!(resolve(Some(&source.id), None).path, f.root);
        assert_eq!(resolve(Some(&source.id), Some("lib")).path, lib);
        assert_eq!(resolve(None, None).path, f.root);
        assert_eq!(resolve(None, Some("lib")).path, lib);

        let error = {
            let store = store.lock().unwrap();
            crate::git_repo_folder(&store, &project.id, Some(&task.id), Some("nope"))
                .unwrap_err()
        };
        assert!(
            error.to_lowercase().contains("repositor") && error.contains("nope"),
            "an unknown qualifier names both the miss and the repositories: {error}"
        );
        let elsewhere = f.base.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let other = store.lock().unwrap().add_project(&elsewhere).unwrap();
        let error = {
            let store = store.lock().unwrap();
            crate::git_repo_folder(&store, &other.id, Some(&task.id), None).unwrap_err()
        };
        assert!(
            error.contains("does not belong"),
            "a foreign session keeps today's guard: {error}"
        );
    }

    /// The task_links key of a qualified repository: the primary keeps the legacy
    /// '' key whatever its own remote, an additional repository keys by its
    /// origin's `owner/name` read at its effective checkout (a task worktree
    /// included), and a folder without a GitHub identity has none. Unknown
    /// qualifiers keep git_repo_folder's refusal.
    #[test]
    fn task_link_repo_keys_each_qualified_repository_by_its_origin() {
        let f = Fixture::new(true);
        f.git(&["remote", "add", "origin", "https://github.com/o/primary.git"]);
        let (store, project, source) =
            folder_project(&f, &[("lib", true), ("web", true), ("plain", false)]);
        let lib = fs::canonicalize(f.base.join("lib")).unwrap();
        git_at(&lib, &["remote", "add", "origin", "https://github.com/o/lib.git"]);
        let web = fs::canonicalize(f.base.join("web")).unwrap();
        git_at(&web, &["remote", "add", "origin", "git@github.com:octo/web.git"]);
        let (task, _) = crate::create_worktree_task_with_repos(
            &store,
            &source.id,
            "multi".into(),
            None,
            false,
            false,
        )
        .unwrap();
        let key = |session: Option<&str>, qualifier: Option<&str>| {
            let store = store.lock().unwrap();
            crate::task_link_repo(&store, &project.id, session, qualifier).unwrap()
        };

        assert_eq!(
            key(Some(&source.id), None).as_deref(),
            Some(""),
            "the primary keys as the primary even with its own remote"
        );
        assert_eq!(
            key(Some(&task.id), None).as_deref(),
            Some(""),
            "the primary worktree keys as the primary"
        );
        assert_eq!(key(Some(&source.id), Some("lib")).as_deref(), Some("o/lib"));
        assert_eq!(
            key(Some(&task.id), Some("lib")).as_deref(),
            Some("o/lib"),
            "a task worktree of the lib repository shares its origin"
        );
        assert_eq!(key(Some(&source.id), Some("web")).as_deref(), Some("octo/web"));
        assert_eq!(
            key(Some(&source.id), Some("plain")),
            None,
            "a folder without a GitHub identity has no key"
        );
        assert_eq!(
            key(None, None).as_deref(),
            Some(""),
            "project-level reads default to the primary"
        );
        assert_eq!(
            key(None, Some("web")).as_deref(),
            Some("octo/web"),
            "project-level reads qualify the same way"
        );
        assert!(
            crate::task_link_repo(&store.lock().unwrap(), &project.id, Some(&source.id), Some("nope")).is_err(),
            "an unknown qualifier keeps git_repo_folder's refusal"
        );
    }

    /// Qualified Git operations run against the qualified repository's effective
    /// checkout: diff, stage, commit and push land in that repository's task
    /// branch, and no other checkout moves.
    #[test]
    fn qualified_git_operations_run_in_the_qualified_repositorys_checkout() {
        let f = Fixture::new(true);
        let (store, project, source) = folder_project(&f, &[("lib", true)]);
        let (task, _) = crate::create_worktree_task_with_repos(
            &store,
            &source.id,
            "multi".into(),
            None,
            false,
            false,
        )
        .unwrap();
        let lib = fs::canonicalize(f.base.join("lib")).unwrap();
        let lib_worktree =
            fs::canonicalize(f.base.join("lib-worktrees/pandacode-multi")).unwrap();
        let bare = f.base.join("lib-origin.git");
        git_at(&f.base, &["init", "--bare", "-b", "main", "lib-origin.git"]);
        git_at(&lib, &["remote", "add", "origin", bare.to_str().unwrap()]);

        let folder = {
            let store = store.lock().unwrap();
            crate::git_repo_folder(&store, &project.id, Some(&task.id), Some("lib")).unwrap()
        };
        assert_eq!(folder.path, lib_worktree);
        fs::write(folder.path.join("note.txt"), "qualified\n").unwrap();
        assert!(
            git_diff(&folder.path, Some("note.txt".into()), false)
                .unwrap()
                .contains("+qualified")
        );
        assert!(
            git_diff(&lib, Some("note.txt".into()), false)
                .unwrap()
                .is_empty(),
            "the repository's main checkout has no such change"
        );
        git_stage(&folder.path, vec!["note.txt".into()], true).unwrap();
        git_commit(&folder.path, "Qualified commit".into()).unwrap();
        assert!(git_status(&folder.path).unwrap().files.is_empty());
        assert!(
            git_status(&lib).unwrap().files.is_empty(),
            "the main checkout stays clean"
        );
        assert_eq!(
            git_status(&lib).unwrap().branch,
            "main",
            "the repository's own branch never moved"
        );
        git_push(&folder.path).unwrap();
        let shown = Command::new("git")
            .arg("-C")
            .arg(&lib)
            .args(["show", "pandacode/multi:note.txt"])
            .output()
            .unwrap();
        assert!(
            shown.status.success()
                && String::from_utf8_lossy(&shown.stdout) == "qualified\n",
            "the qualified commit lives on the repository's task branch"
        );
        let primary_worktree =
            fs::canonicalize(f.base.join("project-worktrees/pandacode-multi")).unwrap();
        assert_eq!(git_status(&primary_worktree).unwrap().branch, "pandacode/multi");
        assert!(
            git_status(&primary_worktree).unwrap().files.is_empty(),
            "the primary checkout is untouched"
        );
    }

    /// The branch-switch refusal follows the qualified repository: repositories
    /// with their own task checkout keep their branch, others still switch.
    #[test]
    fn branch_switch_refusal_follows_the_qualified_repository() {
        let f = Fixture::new(true);
        let (store, project, source) = folder_project(&f, &[("lib", true), ("util", true)]);
        fs::create_dir_all(f.base.join("lib-worktrees/pandacode-multi")).unwrap();
        let (task, _) = crate::create_worktree_task_with_repos(
            &store,
            &source.id,
            "multi".into(),
            None,
            false,
            false,
        )
        .unwrap();
        let lib = fs::canonicalize(f.base.join("lib")).unwrap();
        for qualifier in [None, Some("util")] {
            let error = {
                let store = store.lock().unwrap();
                crate::switch_branch_root(&store, &project.id, Some(&task.id), qualifier)
                    .unwrap_err()
            };
            assert!(
                error.contains("own worktree"),
                "today's refusal, per repository now: {error} for {qualifier:?}"
            );
        }
        assert_eq!(
            {
                let store = store.lock().unwrap();
                crate::switch_branch_root(&store, &project.id, Some(&task.id), Some("lib"))
                    .unwrap()
            },
            lib,
            "a repository without its own task checkout still switches"
        );
        assert_eq!(
            {
                let store = store.lock().unwrap();
                crate::switch_branch_root(&store, &project.id, Some(&source.id), None).unwrap()
            },
            f.root,
            "a task without any worktree switches its primary, exactly as today"
        );
    }

    /// The multi-repo status payload: one entry per folder in folder order, each
    /// read from its effective checkout (worktree included), ahead/behind its
    /// upstream when one exists, while the top level keeps carrying the primary
    /// repository exactly as today's single-repo payload.
    #[test]
    fn git_status_all_reports_one_entry_per_folder_with_the_primary_at_the_top_level() {
        let f = Fixture::new(true);
        // The primary tracks a remote: one local commit ahead, one remote commit behind.
        let origin = f.base.join("origin.git");
        git_at(&f.base, &["init", "--bare", "-b", "main", "origin.git"]);
        git_at(&f.root, &["remote", "add", "origin", origin.to_str().unwrap()]);
        git_at(&f.root, &["push", "-u", "origin", "main"]);
        fs::write(f.root.join("ahead.txt"), "local\n").unwrap();
        git_at(&f.root, &["add", "ahead.txt"]);
        git_at(
            &f.root,
            &["-c", "core.hooksPath=/dev/null", "commit", "-m", "Ahead"],
        );
        let other = f.base.join("other");
        git_at(&f.base, &["clone", origin.to_str().unwrap(), "other"]);
        git_at(&other, &["config", "user.name", "Workspace Tests"]);
        git_at(&other, &["config", "user.email", "workspace@example.invalid"]);
        fs::write(other.join("behind.txt"), "remote\n").unwrap();
        git_at(&other, &["add", "behind.txt"]);
        git_at(
            &other,
            &["-c", "core.hooksPath=/dev/null", "commit", "-m", "Behind"],
        );
        git_at(&other, &["push", "origin", "main"]);
        git_at(&f.root, &["fetch", "origin"]);
        fs::write(f.root.join("dirty-a.txt"), "dirty\n").unwrap();

        // The lib repository reports through its task checkout, not its main one.
        let lib = f.base.join("lib");
        init_repo_at(&lib, "lib.txt");
        let lib_worktree = create_worktree_with(&lib, "docs-task", None, false)
            .unwrap()
            .path;
        fs::write(lib.join("main-note.txt"), "main side\n").unwrap();
        fs::write(lib_worktree.join("wt-note.txt"), "worktree side\n").unwrap();

        let docs = f.base.join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("guide.md"), "plain\n").unwrap();

        let folders = vec![
            repo_folder(&f.root, "app", true),
            RepoFolder {
                path: lib_worktree.clone(),
                label: "lib".into(),
                is_primary: false,
                worktree: Some(lib_worktree.clone()),
                branch: Some("pandacode/docs-task".into()),
            },
            repo_folder(&docs, "docs", false),
        ];
        let status: super::GitStatusAll = git_status_all(&folders);
        let paths_of: fn(&super::RepoStatus) -> Vec<&str> = |repo: &super::RepoStatus| {
            repo.files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(status.repos.len(), 3, "one entry per folder, in order");
        assert_eq!(
            (status.branch.as_str(), status.is_repo),
            ("main", true),
            "the top level keeps the primary's numbers"
        );
        assert_eq!(
            (
                status.repos[0].label.as_str(),
                status.repos[0].branch.as_str(),
                status.repos[0].ahead,
                status.repos[0].behind
            ),
            ("app", "main", 1, 1)
        );
        assert_eq!(paths_of(&status.repos[0]), vec!["dirty-a.txt"]);
        assert_eq!(
            (
                status.repos[1].label.as_str(),
                status.repos[1].branch.as_str(),
                status.repos[1].ahead,
                status.repos[1].behind
            ),
            ("lib", "pandacode/docs-task", 0, 0)
        );
        assert_eq!(
            paths_of(&status.repos[1]),
            vec!["wt-note.txt"],
            "status reads the effective checkout, never the main one"
        );
        assert_eq!(
            (status.repos[2].label.as_str(), status.repos[2].branch.as_str()),
            ("docs", "")
        );
        assert!(status.repos[2].files.is_empty(), "plain folders report nothing");
        assert_eq!(
            status
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["dirty-a.txt"],
            "the top-level files mirror the primary entry"
        );
    }

    /// Single-folder tasks report exactly one repo entry that mirrors the
    /// top-level payload, repo or not.
    #[test]
    fn git_status_all_keeps_single_folder_tasks_at_exactly_one_entry() {
        let f = Fixture::new(true);
        fs::write(f.root.join("note.txt"), "note\n").unwrap();
        let status = git_status_all(&[repo_folder(&f.root, "app", true)]);
        assert_eq!(status.repos.len(), 1);
        assert_eq!(status.repos[0].label, "app");
        assert_eq!(status.repos[0].branch, status.branch);
        assert_eq!(status.repos[0].files.len(), status.files.len());
        assert!(status.is_repo);

        let docs = f.base.join("docs");
        fs::create_dir_all(&docs).unwrap();
        let plain = git_status_all(&[repo_folder(&docs, "docs", true)]);
        assert!(!plain.is_repo, "a plain folder reports not-a-repo as today");
        assert_eq!(plain.repos.len(), 1);
        assert_eq!(plain.repos[0].branch, "");
        assert!(plain.repos[0].files.is_empty());
    }
}
