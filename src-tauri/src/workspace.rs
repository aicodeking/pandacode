use serde::Serialize;
mod file_search;
mod text_search;
pub use file_search::search_files;
pub use text_search::{search_text, search_text_for_phone, TextSearchResult};
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
/// Most changed files a whole-checkout action (`git.stage {all}`) lists and moves, in
/// [`PATHSPEC_CHUNK_BYTES`] runs; the status it reads may be up to [`ALL_STATUS_LIMIT`].
const ALL_FILE_COUNT_LIMIT: usize = 50_000;
const ALL_STATUS_LIMIT: usize = 16 * 1024 * 1024;
const TRUNCATED: &str = "\n\n[Preview truncated at 256 KiB]\n";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    pub index: String,
    pub working: String,
    /// The source of a rename or copy (`R`/`C`): the path the change came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
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
/// Whether an explicit commit, merge or push runs the repository's hooks. Desktop actions
/// run them; PandaConnect phones skip them while "Full access for remote tasks" is off, since
/// a hook is any program the checkout names (docs/remote-access.md).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hooks {
    Run,
    Skip,
}

/// Who asked for a Git operation. Every Git helper a PandaConnect method can reach takes one,
/// so a phone call can never fall through to the desktop's trust by omission
/// (docs/remote-access.md, Round-9 gates): `Desktop` keeps the desktop's behaviour, a phone with
/// "Full access for remote tasks" on is treated as the desktop, and a phone with it off gets a
/// closed [`Gate`] (the checkout's own config refused or neutralised, no lazy fetch, credential
/// helper, askpass, hooks, auto maintenance or submodules).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trust {
    Desktop,
    Phone { full_access: bool },
}

impl Trust {
    pub fn phone(full_access: bool) -> Self {
        Trust::Phone { full_access }
    }

    /// Whether the checkout's own config is untrusted: a phone with the switch off.
    pub fn untrusted(self) -> bool {
        self == Trust::Phone { full_access: false }
    }

    /// Whether an explicit commit, merge or push runs the repository's hooks.
    pub fn hooks(self) -> Hooks {
        if self.untrusted() { Hooks::Skip } else { Hooks::Run }
    }
}

/// How every Git call of one operation runs, decided once from its [`Trust`] before the first
/// call. Built only by [`Gate::read`] and [`Gate::change`], so an operation cannot reach
/// [`run_git_with`] without having decided.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Gate {
    /// The desktop's call (or a Full-access phone's): the checkout's config as the desktop reads it.
    Open,
    /// A phone with the switch off: these options before every subcommand, plus
    /// [`UNTRUSTED_ENV`], [`UNTRUSTED_ARGS`] and [`MAINTENANCE_OFF`].
    Closed(Vec<String>),
}

impl Gate {
    /// For an operation that only reads: [`untrusted_inspection_args`] (refuses a config that
    /// could run a program or reach the network while reading; switches its filters off).
    fn read(root: &Path, trust: Trust) -> Result<Gate, String> {
        if !trust.untrusted() {
            return Ok(Gate::Open);
        }
        untrusted_inspection_args(root).map(Gate::Closed)
    }

    /// For an operation that changes the checkout: [`refuse_untrusted_programs`] first (every
    /// local config key on the allowlist, no submodules), then submodules skipped.
    /// `action` names what the phone asked for in the refusal ("stage files", "push"…).
    fn change(root: &Path, trust: Trust, action: &str) -> Result<Gate, String> {
        if !trust.untrusted() {
            return Ok(Gate::Open);
        }
        refuse_untrusted_programs_for(root, trust, action)?;
        Ok(Gate::Closed(skip_submodule_args().into_iter().map(String::from).collect()))
    }

    /// The prefix options of a closed gate.
    fn prefix(&self) -> Option<&[String]> {
        match self {
            Gate::Open => None,
            Gate::Closed(prefix) => Some(prefix),
        }
    }

    /// One Git call (hooks never run here) under this gate.
    fn run(&self, root: &Path, args: &[&str], limit: usize, timeout: Duration) -> Result<GitOutput, String> {
        match self {
            Gate::Open => run_git_with(root, args, limit, false, Untrusted::No, timeout),
            Gate::Closed(prefix) => {
                let mut all: Vec<&str> = prefix.iter().map(String::as_str).collect();
                all.extend_from_slice(args);
                run_git_with(root, &all, limit, false, Untrusted::Local, timeout)
            }
        }
    }

    /// [`Gate::run`] with the short inspection deadline.
    fn git(&self, root: &Path, args: &[&str], limit: usize) -> Result<GitOutput, String> {
        self.run(root, args, limit, Duration::from_secs(30))
    }

    /// `subcommand` with `--ignore-submodules=all` after its name when the gate is closed.
    fn status_args<'a>(&self, subcommand: &[&'a str]) -> Vec<&'a str> {
        let mut args = subcommand[..1].to_vec();
        if matches!(self, Gate::Closed(_)) {
            args.push("--ignore-submodules=all");
        }
        args.extend_from_slice(&subcommand[1..]);
        args
    }
}

/// Transport rules for every Git call that skips hooks: only Git's own transports, never a
/// remote helper (`<scheme>::`, unknown URL schemes) or `ext::`, whatever the repository's
/// `protocol.*` or `url.*.insteadOf` say (command-line `-c` outranks every config file). Never
/// a local-path or `file://` remote either: `git-receive-pack` on the other side clears
/// `GIT_CONFIG_PARAMETERS`, so a push there would run the target repository's own hooks.
const SKIP_HOOKS_PROTOCOLS: [&str; 7] = [
    "protocol.allow=never",
    "protocol.https.allow=always",
    "protocol.http.allow=always",
    "protocol.ssh.allow=always",
    "protocol.git.allow=always",
    "protocol.file.allow=never",
    "protocol.ext.allow=never",
];

/// Submodule rules for every phone Git call with hooks skipped: a submodule carries its own
/// config (`.git/modules/<x>/config`, filters included) that the top-level allowlist never
/// sees, so Git must not look inside one.
const SKIP_SUBMODULES: [&str; 5] = [
    "diff.ignoreSubmodules=all",
    "status.submoduleSummary=false",
    "submodule.recurse=false",
    "push.recurseSubmodules=no",
    "fetch.recurseSubmodules=false",
];

/// [`SKIP_SUBMODULES`] as `-c` pairs.
fn skip_submodule_args() -> Vec<&'static str> {
    SKIP_SUBMODULES.iter().flat_map(|rule| ["-c", rule]).collect()
}

/// The options before every Git subcommand: no pager, fsmonitor or colour, and with `hooks`
/// false `core.hooksPath=/dev/null` plus [`SKIP_HOOKS_PROTOCOLS`], so no repository hook,
/// remote helper or `ext::` command can run.
fn git_global_args(hooks: bool) -> Vec<&'static str> {
    let mut args = vec!["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "color.ui=false"];
    if !hooks {
        args.extend(["-c", "core.hooksPath=/dev/null"]);
        for rule in SKIP_HOOKS_PROTOCOLS {
            args.extend(["-c", rule]);
        }
    }
    args
}

/// Network URL schemes Git serves itself, with no remote helper (`file://` is local).
const PLAIN_SCHEMES: [&str; 6] = ["https", "http", "ssh", "git", "git+ssh", "ssh+git"];

/// Whether a remote URL reaches another machine through Git's own transports: a plain-scheme
/// URL or scp-like `host:path`. Never a local path or `file://` (the target repository's
/// receive hooks would run), `<helper>::<address>`, `ext::`, an unknown scheme (a
/// `git-remote-<scheme>` helper) or a value that starts like an option.
fn plain_remote_url(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value.starts_with('-') {
        return false;
    }
    match value.split_once("://") {
        Some((scheme, _)) => PLAIN_SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()),
        None => scp_like_url(value),
    }
}

/// `host:path` as Git reads it: a colon before any slash, with a host longer than one letter
/// (`C:` is a Windows drive). Anything else is a local path.
fn scp_like_url(value: &str) -> bool {
    if value.contains("::") {
        return false;
    }
    let Some((host, _)) = value.split_once(':') else { return false };
    host.len() > 1 && !host.contains(['/', '\\'])
}

/// Whether `branch.*.remote`/`pushRemote` names a remote (resolved through `remote.*.url`,
/// which the allowlist checks itself) or holds a plain network URL. `.` (this repository) and
/// anything path-like refuse: Git would push into a local repository.
fn plain_remote_name(value: &str) -> bool {
    let value = value.trim();
    if value.contains(':') {
        return plain_remote_url(value);
    }
    !value.is_empty() && !value.starts_with(['-', '.']) && !value.contains(['/', '\\'])
}

/// Whether a repository-local config entry is one PandaCode knows runs no program, so a phone
/// may use Git on the checkout with hooks skipped. An allowlist: anything else (filters, diff
/// and merge drivers, signing programs, `url.*.insteadOf`, `protocol.*`, `core.sshCommand`,
/// `core.alternateRefsCommand`, includes, credential helpers, keys Git adds later…) refuses.
/// `core.hooksPath` and `core.fsmonitor` are allowed because every hooks-skipped call
/// overrides both on the command line ([`git_global_args`]).
fn config_entry_is_inert(key: &str, value: &str) -> bool {
    let key = key.to_ascii_lowercase();
    let Some((section, rest)) = key.split_once('.') else { return false };
    let (sub, name) = match rest.rsplit_once('.') {
        Some((sub, name)) => (Some(sub), name),
        None => (None, rest),
    };
    let flag = || matches!(value.trim().to_ascii_lowercase().as_str(), "" | "true" | "false" | "yes" | "no" | "on" | "off" | "1" | "0");
    match (section, sub.is_some(), name) {
        (
            "core",
            false,
            "repositoryformatversion" | "filemode" | "bare" | "logallrefupdates" | "ignorecase" | "precomposeunicode" | "symlinks"
            | "autocrlf" | "eol" | "safecrlf" | "sparsecheckout" | "sparsecheckoutcone" | "hookspath" | "untrackedcache"
            | "checkstat" | "trustctime" | "quotepath",
        ) => true,
        ("core", false, "fsmonitor") => flag(),
        ("remote", true, "url" | "pushurl") | ("submodule", true, "url") => plain_remote_url(value),
        ("branch", true, "remote" | "pushremote") => plain_remote_name(value),
        (
            "remote",
            true,
            "fetch" | "push" | "tagopt" | "prune" | "prunetags" | "mirror" | "promisor" | "partialclonefilter" | "skipdefaultupdate" | "skipfetchall",
        ) => true,
        ("branch", true, "merge" | "rebase" | "description") => true,
        ("submodule", _, "active") => true,
        ("user", false, "name" | "email") => true,
        ("pull", false, "rebase" | "ff") => true,
        ("push", false, "default" | "autosetupremote") => true,
        ("init", false, "defaultbranch") => true,
        ("extensions", false, "worktreeconfig" | "objectformat" | "refstorage" | "partialclone") => true,
        ("fetch", false, "prune" | "prunetags") => true,
        // Thresholds and expiry times only: `gc.recentObjectsHook` is a shell command, and any
        // other gc key Git adds later refuses until it is vetted here.
        (
            "gc",
            false,
            "auto" | "autopacklimit" | "autodetach" | "reflogexpire" | "reflogexpireunreachable" | "pruneexpire" | "worktreepruneexpire"
            | "packrefs" | "aggressivewindow" | "aggressivedepth" | "bigpackthreshold" | "logexpiry",
        ) => true,
        ("gc", true, "reflogexpire" | "reflogexpireunreachable") => true,
        // Signing uses the user's own (global) gpg settings; a local gpg.* key refuses.
        ("commit", false, "gpgsign") => flag(),
        // Written by `git lfs install`; the LFS filter itself lives in the user's global config.
        ("lfs", false, "repositoryformatversion") | ("lfs", true, "access") => true,
        _ => false,
    }
}

/// The keys PandaCode cannot vouch for among `git config --null --list` output (`key\nvalue\0`).
fn program_config_keys(listing: &[u8]) -> Vec<String> {
    let mut keys: Vec<String> = String::from_utf8_lossy(listing)
        .split('\0')
        .filter_map(|entry| {
            let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
            (!key.is_empty() && !config_entry_is_inert(key, value)).then(|| key.to_string())
        })
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

/// The checkout's own config entries (repository and worktree files; includes are not
/// followed, and any `include.*` key refuses anyway), as `git config --null --list` bytes.
fn local_config_listings(root: &Path) -> Result<Vec<Vec<u8>>, String> {
    const LIMIT: usize = 256 * 1024;
    let mut listings = Vec::new();
    for scope in ["--local", "--worktree"] {
        let output = run_git(root, &["config", scope, "--null", "--list"], LIMIT, false)?;
        // --worktree fails without extensions.worktreeConfig in a linked worktree: nothing to read.
        // --local exits 1 with no entries only when the file is empty or missing.
        if !output.status.success() {
            if scope == "--local" && !output.stdout.bytes.is_empty() {
                return Err("Could not read this repository's git config.".into());
            }
            continue;
        }
        if output.stdout.truncated {
            return Err("This repository's git config is too large to check; turn on Full access for remote tasks on this computer to use Git from the phone.".into());
        }
        listings.push(output.stdout.bytes);
    }
    Ok(listings)
}

/// Refuse a phone's Git call while hooks are skipped unless every entry of the checkout's own
/// config (repository and worktree files; the user's global config is trusted) is on the
/// [`config_entry_is_inert`] allowlist: skipping hooks would otherwise still run
/// `filter.*.clean`, `diff.*.textconv`, `gpg.program`, a rewritten `ext::` URL…
#[cfg_attr(not(test), allow(dead_code))] // kept for tests; callers use the *_for variants
pub fn refuse_repo_config_programs(root: &Path) -> Result<(), String> {
    refuse_repo_config_programs_for(root, GIT_ACTION)
}

/// What a refusal says the phone was trying to do when its caller does not name the action.
pub const GIT_ACTION: &str = "use Git on this checkout";

/// [`refuse_repo_config_programs`] whose refusal names `action` ("commit", "stage files"…).
pub fn refuse_repo_config_programs_for(root: &Path, action: &str) -> Result<(), String> {
    let mut keys: Vec<String> = local_config_listings(root)?.iter().flat_map(|listing| program_config_keys(listing)).collect();
    keys.sort();
    keys.dedup();
    if keys.is_empty() {
        return Ok(());
    }
    Err(format!(
        "This repository's git config runs programs ({}); turn on Full access for remote tasks on this computer to {action} from the phone.",
        keys.join(", ")
    ))
}

/// The options a phone's read-only Git call (status, diff) puts before its subcommand while
/// hooks are skipped: every filter the checkout's own config defines switched off on the
/// command line (`-c filter.<x>.clean=` …, `required=false`) and [`SKIP_SUBMODULES`], since a
/// status refresh may run clean filters and recurse into submodules with their own config.
/// Refuses a config that includes other files: their filters are not in the local listing.
fn untrusted_inspection_args(root: &Path) -> Result<Vec<String>, String> {
    let listings = local_config_listings(root)?;
    let entries: Vec<String> = listings.iter().flat_map(|listing| String::from_utf8_lossy(listing).split('\0').map(str::to_owned).collect::<Vec<_>>()).collect();
    if entries.iter().any(|entry| config_entry_includes(entry)) {
        return Err(INCLUDES_REFUSED.into());
    }
    if entries.iter().any(|entry| config_entry_moves_worktree(entry)) {
        return Err(WORKTREE_REFUSED.into());
    }
    let mut risky: Vec<String> = entries.iter().filter_map(|entry| network_program_key(entry)).collect();
    if !risky.is_empty() {
        risky.sort();
        risky.dedup();
        return Err(format!(
            "This repository's git config can run programs or fetch from the network while reading it ({}); turn on Full access for remote tasks on this computer to see its changes from the phone.",
            risky.join(", ")
        ));
    }
    let mut names: Vec<String> = entries.iter().filter_map(|entry| filter_name(entry)).collect();
    names.sort();
    names.dedup();
    let mut args: Vec<String> = Vec::new();
    for name in &names {
        if name.contains('=') || name.contains('\n') {
            return Err("This repository's git config defines a filter PandaCode cannot switch off; turn on Full access for remote tasks on this computer to see its changes from the phone.".into());
        }
        for (option, value) in [("clean", ""), ("smudge", ""), ("process", ""), ("required", "false")] {
            args.extend(["-c".to_string(), format!("filter.{name}.{option}={value}")]);
        }
    }
    args.extend(skip_submodule_args().into_iter().map(String::from));
    Ok(args)
}

/// The key of a `key\nvalue` entry that would let a read-only inspection run a program or
/// reach the network: `core.sshCommand`, `core.askPass`, any `credential.*`, and a partial
/// clone (`extensions.partialClone`, a true `remote.*.promisor`), whose missing blobs Git
/// fetches lazily. `promisor=false` and an empty `partialClone` are inert.
fn network_program_key(entry: &str) -> Option<String> {
    let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
    let lower = key.to_ascii_lowercase();
    let value = value.trim().to_ascii_lowercase();
    let falsy = matches!(value.as_str(), "false" | "no" | "off" | "0");
    let risky = match lower.as_str() {
        "core.sshcommand" | "core.askpass" => true,
        "extensions.partialclone" => !value.is_empty(),
        _ if lower.starts_with("credential.") => true,
        _ if lower.starts_with("remote.") && lower.ends_with(".promisor") => !falsy,
        _ => false,
    };
    risky.then_some(lower)
}

const INCLUDES_REFUSED: &str = "This repository's git config includes other config files; turn on Full access for remote tasks on this computer to see its changes from the phone.";

const WORKTREE_REFUSED: &str = "This repository's git config points its working tree outside the project (core.worktree); turn on Full access for remote tasks on this computer to see its changes from the phone.";

/// Whether a `key\nvalue` config entry moves the working tree status and diff read
/// (`core.worktree`): a phone could otherwise read files outside the project. The change
/// allowlist ([`config_entry_is_inert`]) never vouches for it either.
fn config_entry_moves_worktree(entry: &str) -> bool {
    entry.split_once('\n').map_or(entry, |(key, _)| key).eq_ignore_ascii_case("core.worktree")
}

/// Whether a `key\nvalue` config entry is an `include.*` or `includeIf.*` directive.
fn config_entry_includes(entry: &str) -> bool {
    let key = entry.split_once('\n').map_or(entry, |(key, _)| key).to_ascii_lowercase();
    key.starts_with("include.") || key.starts_with("includeif.")
}


/// The prefix options and subcommand arguments of one inspection call; `untrusted` adds the
/// prefix and `--ignore-submodules=all` after the subcommand.
fn inspection_args<'a>(untrusted: Option<&'a [String]>, subcommand: &[&'a str]) -> Vec<&'a str> {
    let mut args: Vec<&str> = untrusted.map(|prefix| prefix.iter().map(String::as_str).collect()).unwrap_or_default();
    args.extend_from_slice(&subcommand[..1]);
    if untrusted.is_some() {
        args.push("--ignore-submodules=all");
    }
    args.extend_from_slice(&subcommand[1..]);
    args
}

/// The filter name of a `filter.<name>.<key>` entry in `key\nvalue` form.
fn filter_name(entry: &str) -> Option<String> {
    let key = entry.split_once('\n').map_or(entry, |(key, _)| key);
    key.get(..7).filter(|head| head.eq_ignore_ascii_case("filter."))?;
    let (name, _) = key[7..].rsplit_once('.')?;
    (!name.is_empty()).then(|| name.to_string())
}

/// [`refuse_repo_config_programs`] and [`refuse_submodules`] for an untrusted phone; nothing
/// for the desktop or a Full-access phone.
pub fn refuse_untrusted_programs(root: &Path, trust: Trust) -> Result<(), String> {
    refuse_untrusted_programs_for(root, trust, GIT_ACTION)
}

/// [`refuse_untrusted_programs`] whose refusal names `action` ("start a task", "push"…).
pub fn refuse_untrusted_programs_for(root: &Path, trust: Trust, action: &str) -> Result<(), String> {
    if trust.untrusted() {
        refuse_repo_config_programs_for(root, action).and_then(|()| refuse_submodules_for(root, action))
    } else {
        Ok(())
    }
}

/// Refuse a phone's commit, push, merge or worktree while hooks are skipped when the checkout
/// has submodules (`.gitmodules`, or a `modules` folder in its Git directory): each carries
/// its own config, which the top-level allowlist cannot vouch for.
#[allow(dead_code)] // kept for tests (some Unix-only); callers use the *_for variants
pub fn refuse_submodules(root: &Path) -> Result<(), String> {
    refuse_submodules_for(root, "change it")
}

/// [`refuse_submodules`] whose refusal names `action`.
fn refuse_submodules_for(root: &Path, action: &str) -> Result<(), String> {
    let mut found = root.join(".gitmodules").exists() || root.join(".git").join("modules").exists();
    if !found {
        let output = checked(run_git(root, &["rev-parse", "--git-common-dir"], 8192, false)?)?;
        let common = String::from_utf8_lossy(&output.bytes).trim_end_matches(['\n', '\r']).to_string();
        found = !common.is_empty() && root.join(common).join("modules").exists();
    }
    if found {
        return Err(format!("This repository has submodules, which carry their own git config; turn on Full access for remote tasks on this computer to {action} from the phone."));
    }
    Ok(())
}

/// A Git call that changes history: hooks as `hooks` says, with the long commit deadline.
/// Skipped hooks also keep Git out of submodules ([`SKIP_SUBMODULES`]).
fn run_git_changing(root: &Path, args: &[&str], limit: usize, hooks: Hooks) -> Result<GitOutput, String> {
    run_git_with(root, &with_skipped_submodules(args, hooks), limit, hooks == Hooks::Run, untrusted_for(hooks, Untrusted::Local), Duration::from_secs(120))
}

/// `level` for a hooks-skipped call, nothing extra when hooks run (the desktop).
fn untrusted_for(hooks: Hooks, level: Untrusted) -> Untrusted {
    if hooks == Hooks::Skip { level } else { Untrusted::No }
}

/// A read-only call with `untrusted` set when it carries [`inspection_args`]' prefix.
fn run_git_inspecting(root: &Path, args: &[&str], limit: usize, untrusted: bool) -> Result<GitOutput, String> {
    let level = if untrusted { Untrusted::Local } else { Untrusted::No };
    run_git_with(root, args, limit, false, level, Duration::from_secs(30))
}

/// A read-only Git call outside status and diff (upstream, ahead/behind) through
/// [`Gate::read`]: hooks always skipped, and for an untrusted phone the
/// [`untrusted_inspection_args`] prefix (refusing a config that could run a program) with
/// [`UNTRUSTED_ENV`]/[`UNTRUSTED_ARGS`].
pub(crate) fn git_inspect(root: &Path, args: &[&str], limit: usize, timeout: Duration, trust: Trust) -> Result<GitOutput, String> {
    Gate::read(root, trust)?.run(root, args, limit, timeout)
}

/// A Git call of a PandaConnect start (`task.start`, `github.startTask`) that may change the
/// checkout or reach origin: `fetch`, `switch`, `merge --ff-only`, `reset --hard` and their
/// lookups. The desktop and a Full-access phone run plain Git as the desktop does; an
/// untrusted phone's goes through [`Gate::change`] (refused when the checkout's config could
/// run a program, submodules skipped, hooks, lazy fetch and auto maintenance off). `network`
/// keeps the user's own (global) credential helper for a fetch, as [`git_push`] does.
pub(crate) fn git_change(root: &Path, args: &[&str], limit: usize, timeout: Duration, network: bool, trust: Trust) -> Result<GitOutput, String> {
    match Gate::change(root, trust, "start a task")? {
        Gate::Open => {
            let mut command = Command::new("git");
            command.arg("-C").arg(git_path(root)).args(args);
            run_process(command, "Git", limit, timeout)
        }
        Gate::Closed(prefix) => {
            let mut all: Vec<&str> = prefix.iter().map(String::as_str).collect();
            all.extend_from_slice(args);
            let level = if network { Untrusted::Network } else { Untrusted::Local };
            run_git_with(root, &all, limit, false, level, timeout)
        }
    }
}

/// The `-c` overrides of a closed gate that a tool running Git itself (`gh pr create`,
/// `gh repo clone`, `gh pr checkout`…) can inherit, as `GIT_CONFIG_COUNT`/`KEY`/`VALUE`.
pub(crate) const TOOL_GIT_CONFIG: [(&str, &str); 6] = [
    ("core.hooksPath", "/dev/null"),
    ("core.fsmonitor", "false"),
    ("protocol.ext.allow", "never"),
    ("protocol.file.allow", "never"),
    ("maintenance.auto", "false"),
    ("gc.auto", "0"),
];

/// Environment for a tool that runs Git itself on a phone's behalf: nothing for the desktop or
/// a Full-access phone; for an untrusted phone [`UNTRUSTED_ENV`] plus [`TOOL_GIT_CONFIG`] as
/// environment config (which outranks every config file, like `-c`).
pub(crate) fn tool_git_env(trust: Trust) -> Vec<(String, String)> {
    if !trust.untrusted() {
        return Vec::new();
    }
    let mut env: Vec<(String, String)> = UNTRUSTED_ENV.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect();
    env.push(("GIT_CONFIG_COUNT".into(), TOOL_GIT_CONFIG.len().to_string()));
    for (index, (key, value)) in TOOL_GIT_CONFIG.iter().enumerate() {
        env.push((format!("GIT_CONFIG_KEY_{index}"), key.to_string()));
        env.push((format!("GIT_CONFIG_VALUE_{index}"), value.to_string()));
    }
    env
}

/// `args` after [`SKIP_SUBMODULES`] when hooks are skipped.
fn with_skipped_submodules<'a>(args: &[&'a str], hooks: Hooks) -> Vec<&'a str> {
    let mut all = if hooks == Hooks::Skip { skip_submodule_args() } else { Vec::new() };
    all.extend_from_slice(args);
    all
}

/// `--no-verify` as well as the hooks path when hooks are skipped, for subcommands that take it.
fn with_no_verify<'a>(subcommand: &'a str, rest: &[&'a str], hooks: Hooks) -> Vec<&'a str> {
    let mut args = vec![subcommand];
    if hooks == Hooks::Skip {
        args.push("--no-verify");
    }
    args.extend_from_slice(rest);
    args
}

pub(crate) fn run_git_bounded(
    root: &Path,
    args: &[&str],
    limit: usize,
    commit: bool,
    timeout: Duration,
) -> Result<GitOutput, String> {
    run_git_with(root, args, limit, commit, Untrusted::No, timeout)
}

/// How a Git call treats the checkout's own config beyond hooks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Untrusted {
    /// The desktop's own call (or one the allowlist already vouched for).
    No,
    /// A phone call with hooks skipped that needs no network: [`UNTRUSTED_ENV`] and
    /// [`UNTRUSTED_ARGS`], so no lazy fetch, credential helper or askpass program runs.
    Local,
    /// A phone push with hooks skipped: [`UNTRUSTED_ENV`] only, since it must reach the remote
    /// with the user's own (global) credential helper; local `credential.*` and
    /// `core.sshCommand` keys are refused by the allowlist before it runs.
    Network,
}

/// Environment for every hooks-skipped phone call: a partial clone (`remote.*.promisor`)
/// would otherwise fetch missing blobs during a diff, through `core.sshCommand` or a
/// credential helper from the repository's own config.
pub(crate) const UNTRUSTED_ENV: [(&str, &str); 2] = [("GIT_NO_LAZY_FETCH", "1"), ("GIT_TERMINAL_PROMPT", "0")];

/// Options for hooks-skipped phone calls that need no network: no credential helper (the
/// empty value clears the whole list) and no askpass program.
pub(crate) const UNTRUSTED_ARGS: [&str; 4] = ["-c", "credential.helper=", "-c", "core.askPass="];

/// Options for every hooks-skipped phone call: no automatic `git maintenance`/`gc --auto`
/// after a commit, merge or worktree change, since gc runs programs of its own
/// (`gc.recentObjectsHook`) from any config file.
pub(crate) const MAINTENANCE_OFF: [&str; 4] = ["-c", "maintenance.auto=false", "-c", "gc.auto=0"];

fn run_git_with(
    root: &Path,
    args: &[&str],
    limit: usize,
    commit: bool,
    untrusted: Untrusted,
    timeout: Duration,
) -> Result<GitOutput, String> {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command.args(git_global_args(commit));
    if untrusted == Untrusted::Local {
        command.args(UNTRUSTED_ARGS);
    }
    if untrusted != Untrusted::No {
        command.args(MAINTENANCE_OFF);
        command.envs(UNTRUSTED_ENV);
    }
    #[cfg(test)]
    tests::apply_test_env(&mut command);
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
fn is_repository(root: &Path) -> Result<bool, String> {
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

/// `git status`; an untrusted phone's through [`Gate::read`] with `--ignore-submodules=all`
/// (filters off, a config that could run a program refused), since a status refresh may run
/// clean filters and recurse into submodules with their own config.
pub fn git_status(root: &Path, trust: Trust) -> Result<GitStatus, String> {
    if !is_repository(root)? {
        return Ok(GitStatus {
            branch: String::new(),
            files: vec![],
            is_repo: false,
        });
    }
    let status = Gate::read(root, trust).and_then(|gate| status_with(root, gate.prefix()));
    if status.is_err() {
        // As in `git_diff`: a failure may mean the repository is gone.
        forget_repository(root);
    }
    status
}

/// `git status` for a root already known to be the repository root, with [`inspection_args`]
/// for a closed [`Gate`].
fn status_with(root: &Path, untrusted: Option<&[String]>) -> Result<GitStatus, String> {
    status_limited(root, untrusted, STATUS_LIMIT, FILE_COUNT_LIMIT)
}

/// [`status_with`] reading up to `bytes` of output and `files` changed files.
fn status_limited(root: &Path, untrusted: Option<&[String]>, bytes: usize, files: usize) -> Result<GitStatus, String> {
    let args = inspection_args(untrusted, &["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"]);
    parse_status_limited(checked(run_git_inspecting(root, &args, bytes, untrusted.is_some())?)?, files)
}

/// [`git_status`] for a whole-checkout action, which moves its files in chunks: up to
/// [`ALL_FILE_COUNT_LIMIT`] changed files instead of the 5,000 a list shows.
pub fn git_status_all(root: &Path, trust: Trust) -> Result<GitStatus, String> {
    require_repository(root)?;
    let gate = Gate::read(root, trust)?;
    status_limited(root, gate.prefix(), ALL_STATUS_LIMIT, ALL_FILE_COUNT_LIMIT)
}

/// Porcelain v1 `-z --branch` output as a [`GitStatus`], refusing more than `limit` changed files.
fn parse_status_limited(output: Capture, limit: usize) -> Result<GitStatus, String> {
    if output.truncated {
        return Err("Git status exceeds the inspection limit; use Git in the terminal".into());
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
        // `-z` names a rename's or copy's source in the next record.
        let orig_path = if matches!(entry[0], b'R' | b'C') || matches!(entry[1], b'R' | b'C') {
            let orig = parts.next().ok_or("Incomplete Git rename record")?;
            Some(std::str::from_utf8(orig).map_err(|_| "A changed filename is not UTF-8")?.to_string())
        } else {
            None
        };
        files.push(GitFile {
            path,
            index: char::from(entry[0]).to_string(),
            working: char::from(entry[1]).to_string(),
            orig_path,
        });
        if files.len() > limit {
            return Err(format!("More than {} changed files; use Git in the terminal", thousands(limit)));
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
fn untracked_path(root: &Path, path: &str, untrusted: Option<&[String]>) -> Result<Vec<String>, String> {
    let mut args: Vec<&str> = untrusted.map(|prefix| prefix.iter().map(String::as_str).collect()).unwrap_or_default();
    args.extend(["ls-files", "--others", "--exclude-standard", "-z", "--", path]);
    let output = checked(run_git_inspecting(root, &args, STATUS_LIMIT, untrusted.is_some())?)?;
    let untracked = output.bytes.split(|byte| *byte == 0).any(|entry| entry == path.as_bytes());
    Ok(if untracked { vec![path.to_string()] } else { Vec::new() })
}

/// `git diff` (with untracked files); an untrusted phone's as in [`git_status`].
pub fn git_diff(root: &Path, path: Option<String>, staged: bool, trust: Trust) -> Result<String, String> {
    git_diff_counted(root, path, staged, trust).map(|(diff, _)| diff)
}

/// [`git_diff`] and how many files it left out. A phone's diff ([`Trust::Phone`], whatever its
/// switch) never shows a file with more than one hard link ([`hard_linked`]), tracked or
/// untracked, as `files.read` refuses one (docs/remote-access.md, Round 12); the desktop's is
/// unchanged and leaves nothing out.
pub fn git_diff_counted(root: &Path, path: Option<String>, staged: bool, trust: Trust) -> Result<(String, usize), String> {
    let diff = diff_repository(root, path, staged, trust);
    if diff.is_err() {
        // A failure may mean the repository is gone; verify it again next time.
        forget_repository(root);
    }
    diff
}

fn diff_repository(root: &Path, path: Option<String>, staged: bool, trust: Trust) -> Result<(String, usize), String> {
    require_repository(root)?;
    let gate = Gate::read(root, trust)?;
    diff_with(root, path, staged, gate.prefix(), matches!(trust, Trust::Phone { .. }))
}

/// The refusal of a hard-linked file to a phone (`files.read`, `git.stage`…).
pub const HARD_LINK_REFUSED: &str = "This file is hard-linked elsewhere, so PandaCode won't open it from your phone.";

/// The refusal of a phone's `git.stage {all}` or `git.commit` that would put the hard-linked
/// `name` into Git, naming it.
pub fn hard_link_refused_named(name: &str, action: &str) -> String {
    format!("{name} is hard-linked elsewhere, so PandaCode won't {action} it from your phone.")
}

/// Most bytes of pathspecs one phone diff names on its command line; a longer list (when a
/// hard link forces explicit paths) runs as several diffs, well under ARG_MAX and Windows'
/// 32K command line. `git diff` has no `--pathspec-from-file`.
const PATHSPEC_CHUNK_BYTES: usize = 8 * 1024;

/// `names` in order, split into runs of at most `budget` bytes (a name over it runs alone).
fn pathspec_chunks(names: &[String], budget: usize) -> Vec<&[String]> {
    let (mut chunks, mut start, mut used) = (Vec::new(), 0, 0);
    for (index, name) in names.iter().enumerate() {
        let size = name.len() + 1;
        if index > start && used + size > budget {
            chunks.push(&names[start..index]);
            (start, used) = (index, 0);
        }
        used += size;
    }
    if start < names.len() {
        chunks.push(&names[start..]);
    }
    chunks
}

/// Whether `path` (followed through symlinks, as a reader would) is a regular file with more
/// than one hard link: a name inside a project for a file that may live anywhere (`~/.ssh/id_rsa`),
/// carrying neither a secret name nor a symlink. Missing files and folders are not.
pub fn hard_linked(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.nlink() > 1)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

/// The changed tracked files of a diff (`--name-only --no-renames`, so both sides of a rename)
/// split into those to show and how many are [`hard_linked`]: `None` when none is, so the
/// diff runs as before; otherwise the names to show, passed as (literal) pathspecs.
fn without_hard_links(root: &Path, path: Option<&str>, staged: bool, untrusted: Option<&[String]>) -> Result<(Option<Vec<String>>, usize), String> {
    let (linked, shown): (Vec<String>, Vec<String>) = changed_names(root, path, staged, untrusted)?
        .into_iter()
        .partition(|name| hard_linked(&root.join(name)));
    Ok(if linked.is_empty() { (None, 0) } else { (Some(shown), linked.len()) })
}

/// The changed tracked files of a diff (`--name-only --no-renames`, so both sides of a rename).
fn changed_names(root: &Path, path: Option<&str>, staged: bool, untrusted: Option<&[String]>) -> Result<Vec<String>, String> {
    let mut args: Vec<&str> = DIFF_PREFIX_CONFIG.to_vec();
    args.extend(inspection_args(untrusted, &["diff", "--no-ext-diff", "--no-textconv", "--submodule=short", "--name-only", "--no-renames", "-z"]));
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.extend(path);
    let names = checked(run_git_inspecting(root, &args, STATUS_LIMIT, untrusted.is_some())?)?;
    if names.truncated {
        return Err("Git status exceeds the 1 MiB inspection limit".into());
    }
    Ok(names
        .bytes
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
        .map(|name| String::from_utf8_lossy(name).into_owned())
        .collect())
}

/// Options before `diff` that switch off the checkout's own prefix settings
/// (`diff.noprefix`, `diff.mnemonicPrefix`); [`DIFF_PATH_PREFIXES`] then fixes the prefixes.
const DIFF_PREFIX_CONFIG: [&str; 4] = ["-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false"];

/// Round 10: every diff names its files `a/<path>` and `b/<path>`, whatever `diff.srcPrefix`,
/// `diff.dstPrefix`, `diff.noprefix` or `diff.mnemonicPrefix` say, so the host's secret-file
/// filter (`remote::host`, which reads the `diff --git` headers) always recognises a path.
const DIFF_PATH_PREFIXES: [&str; 2] = ["--src-prefix=a/", "--dst-prefix=b/"];

/// The diff of a repository root and how many files it left out; `untrusted` as in
/// [`inspection_args`]; `skip_links` leaves out [`hard_linked`] files.
fn diff_with(root: &Path, path: Option<String>, staged: bool, untrusted: Option<&[String]>, skip_links: bool) -> Result<(String, usize), String> {
    let target = path.as_deref().map(|path| scoped_path(root, path)).transpose()?;
    if skip_links && target.as_deref().is_some_and(hard_linked) {
        return Ok((String::new(), 1));
    }
    let (shown, mut skipped) = if skip_links { without_hard_links(root, path.as_deref(), staged, untrusted)? } else { (None, 0) };
    let mut args: Vec<&str> = DIFF_PREFIX_CONFIG.to_vec();
    args.extend(inspection_args(untrusted, &[
        "diff",
        DIFF_PATH_PREFIXES[0],
        DIFF_PATH_PREFIXES[1],
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--submodule=short",
        "--unified=3",
    ]));
    if staged {
        args.push("--cached");
    }
    args.push("--");
    let mut output = match &shown {
        // Every tracked change is a hard-linked file: no tracked diff at all.
        Some(shown) if shown.is_empty() => Capture { bytes: Vec::new(), truncated: false },
        Some(shown) => {
            // In bounded chunks: the list may be long (ARG_MAX). Git sorts the names, so the
            // chunks' diffs concatenate in the same order one diff would print them.
            let mut output = Capture { bytes: Vec::new(), truncated: false };
            for chunk in pathspec_chunks(shown, PATHSPEC_CHUNK_BYTES) {
                let remaining = DIFF_LIMIT.saturating_sub(output.bytes.len());
                if remaining == 0 {
                    output.truncated = true;
                    break;
                }
                let mut chunk_args = args.clone();
                chunk_args.extend(chunk.iter().map(String::as_str));
                let part = checked(run_git_inspecting(root, &chunk_args, remaining, untrusted.is_some())?)?;
                output.bytes.extend_from_slice(&part.bytes);
                output.truncated |= part.truncated;
                if output.truncated {
                    break;
                }
            }
            output
        }
        None => {
            args.extend(path.as_deref());
            checked(run_git_inspecting(root, &args, DIFF_LIMIT, untrusted.is_some())?)?
        }
    };
    if !staged && !output.truncated {
        // `git diff` omits untracked files. Preview them without altering the index.
        let untracked = match &path {
            // A path with tracked changes can't be untracked; otherwise ask about it alone.
            Some(path) if output.bytes.is_empty() && target.as_ref().is_some_and(|t| t.is_file()) => {
                untracked_path(root, path, untrusted)?
            }
            Some(_) => vec![],
            None => status_with(root, untrusted)?
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
            if skip_links && hard_linked(&target) {
                skipped += 1;
                continue;
            }
            let remaining = DIFF_LIMIT.saturating_sub(output.bytes.len());
            if remaining == 0 {
                output.truncated = true;
                break;
            }
            let mut args: Vec<&str> = DIFF_PREFIX_CONFIG.to_vec();
            args.extend(untrusted.into_iter().flatten().map(String::as_str));
            args.extend(["diff", DIFF_PATH_PREFIXES[0], DIFF_PATH_PREFIXES[1], "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", &file]);
            let result = run_git_inspecting(root, &args, remaining, untrusted.is_some())?;
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
    Ok((diff_text(&output.bytes, output.truncated), skipped))
}

/// Stage or unstage files: `add` runs clean filters, so an untrusted phone's goes through
/// [`Gate::change`]. A phone ([`Trust::Phone`]) never stages a [`hard_linked`] file, whose
/// copy in Git would later leak through a diff or a push ([`HARD_LINK_REFUSED`]).
pub fn git_stage(root: &Path, paths: Vec<String>, staged: bool, trust: Trust) -> Result<(), String> {
    stage_limited(root, paths, staged, trust, FILE_COUNT_LIMIT)
}

/// [`git_stage`] for a whole-checkout action (`git.stage {all}`): up to
/// [`ALL_FILE_COUNT_LIMIT`] paths, which [`folder_free`] has already filtered.
pub fn git_stage_all(root: &Path, paths: Vec<String>, staged: bool, trust: Trust) -> Result<(), String> {
    stage_limited(root, paths, staged, trust, ALL_FILE_COUNT_LIMIT)
}

/// `paths` without the folders and gitlinks (`sub/` for an untracked nested repository, `sub`
/// for a changed submodule pointer) that [`git_stage`] and [`git_discard`] refuse, with how
/// many were left out. A path that does not resolve is kept, so the action names its error.
pub fn folder_free(root: &Path, paths: Vec<String>) -> (Vec<String>, usize) {
    let total = paths.len();
    let kept: Vec<String> = paths.into_iter().filter(|path| !is_folder_row(root, path)).collect();
    let skipped = total - kept.len();
    (kept, skipped)
}

fn is_folder_row(root: &Path, path: &str) -> bool {
    path.ends_with('/') || scoped_path(root, path).is_ok_and(|target| target.is_dir())
}

/// `4,500`-style digits for a refusal.
fn thousands(value: usize) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// Runs `command -- <chunk>` through `gate` for each [`PATHSPEC_CHUNK_BYTES`] run of `paths`.
fn git_in_chunks(gate: &Gate, root: &Path, command: &[&str], paths: &[String]) -> Result<(), String> {
    for chunk in pathspec_chunks(paths, PATHSPEC_CHUNK_BYTES) {
        let mut args = command.to_vec();
        args.push("--");
        args.extend(chunk.iter().map(String::as_str));
        checked(gate.git(root, &args, 16 * 1024)?)?;
    }
    Ok(())
}

fn stage_limited(root: &Path, paths: Vec<String>, staged: bool, trust: Trust, limit: usize) -> Result<(), String> {
    require_repository(root)?;
    if paths.is_empty() || paths.len() > limit {
        return Err(format!("Select between 1 and {} files", thousands(limit)));
    }
    for path in &paths {
        let target = scoped_path(root, path)?;
        if target.is_dir() {
            return Err("Select individual files to stage or unstage".into());
        }
        if staged && matches!(trust, Trust::Phone { .. }) && hard_linked(&target) {
            return Err(HARD_LINK_REFUSED.into());
        }
    }
    let gate = Gate::change(root, trust, if staged { "stage files" } else { "unstage files" })?;
    let mut paths = paths;
    let command: &[&str] = if staged {
        &["add"]
    } else {
        let head = gate.git(root, &["rev-parse", "--verify", "HEAD"], 8192)?;
        if head.status.success() {
            // A staged rename (or copy) lists only its new path: unstaging it resets the
            // source too, so the index ends at HEAD rather than with a staged delete.
            let sources = index_sources(&gate, root, &paths, &["R", "C"])?;
            paths = with_sources(paths, sources);
            &["reset", "--quiet", "HEAD"]
        } else {
            &["rm", "--cached", "--ignore-unmatch", "--quiet"]
        }
    };
    git_in_chunks(&gate, root, command, &paths)
}

/// `paths` followed by each of `sources` it does not already name (`./` ignored), de-duplicated.
fn with_sources(mut paths: Vec<String>, sources: Vec<String>) -> Vec<String> {
    for source in sources {
        if !paths.iter().any(|path| path.trim_start_matches("./") == source) {
            paths.push(source);
        }
    }
    paths
}

/// Paths of `paths` that `ls-tree HEAD` / `ls-files` (`list`) names, NUL-separated output.
/// Runs one listing per [`PATHSPEC_CHUNK_BYTES`] run of `paths`.
fn listed_paths(gate: &Gate, root: &Path, list: &[&str], paths: &[String]) -> Result<std::collections::HashSet<String>, String> {
    let mut listed = std::collections::HashSet::new();
    for chunk in pathspec_chunks(paths, PATHSPEC_CHUNK_BYTES) {
        let mut args = list.to_vec();
        args.push("--");
        args.extend(chunk.iter().map(String::as_str));
        let output = checked(gate.git(root, &args, 4 * 1024 * 1024)?)?;
        listed.extend(output.bytes.split(|byte| *byte == 0).filter(|name| !name.is_empty()).map(|name| String::from_utf8_lossy(name).into_owned()));
    }
    Ok(listed)
}

/// Discard uncommitted changes to `paths`: a file HEAD has is restored from HEAD (index and
/// worktree); a file only the index has (newly added) is removed from both; an untracked file
/// is deleted, and only because it is named here. Directories are refused, and a path with
/// nothing to discard is left alone, so a retry changes nothing. Checkout runs smudge filters,
/// so an untrusted phone's call goes through [`Gate::change`].
pub fn git_discard(root: &Path, paths: Vec<String>, trust: Trust) -> Result<usize, String> {
    require_repository(root)?;
    if paths.is_empty() || paths.len() > FILE_COUNT_LIMIT {
        return Err("Select between 1 and 5,000 files".into());
    }
    for path in &paths {
        if scoped_path(root, path)?.is_dir() {
            return Err("Select individual files to discard".into());
        }
    }
    let gate = Gate::change(root, trust, "discard changes")?;
    let has_head = gate.git(root, &["rev-parse", "--verify", "--quiet", "HEAD"], 8192)?.status.success();
    let in_head = if has_head { listed_paths(&gate, root, &["ls-tree", "-z", "-r", "--name-only", "HEAD"], &paths)? } else { Default::default() };
    let in_index = listed_paths(&gate, root, &["ls-files", "-z", "--cached"], &paths)?;
    // A staged rename lists only its new path: discarding it must bring the old one back too.
    let sources = if has_head { index_sources(&gate, root, &paths, &["R"])? } else { Vec::new() };
    let (mut restore, mut added, mut untracked) = (Vec::new(), Vec::new(), Vec::new());
    for path in &paths {
        let name = path.trim_start_matches("./");
        if in_head.contains(name) {
            restore.push(path.as_str());
        } else if in_index.contains(name) {
            added.push(path.as_str());
        } else if fs::symlink_metadata(root.join(path)).is_ok() {
            untracked.push(path.as_str());
        }
    }
    let count = restore.len() + added.len() + untracked.len();
    let restore = with_sources(restore.into_iter().map(str::to_owned).collect(), sources);
    let (added, untracked): (Vec<String>, Vec<String>) = (added.into_iter().map(str::to_owned).collect(), untracked.into_iter().map(str::to_owned).collect());
    for (command, list) in [(&["checkout", "--quiet", "HEAD"][..], restore), (&["rm", "--quiet", "--force"][..], added), (&["clean", "--quiet", "--force"][..], untracked)] {
        git_in_chunks(&gate, root, command, &list)?;
    }
    Ok(count)
}

/// The HEAD paths that `paths` were renamed (`R`) or copied (`C`) from in the index (records
/// with one of `codes` whose new path is named), so [`git_discard`] restores renamed sources
/// and an unstage resets them: the result is HEAD, not a staged delete. Lists only those
/// records (`diff --cached --diff-filter`), so a huge checkout's status never has to fit.
fn index_sources(gate: &Gate, root: &Path, paths: &[String], codes: &[&str]) -> Result<Vec<String>, String> {
    let filter = format!("--diff-filter={}", codes.concat());
    // No pathspec: rename detection pairs only paths inside it, and the old path is not named.
    let args = ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--name-status", "-z", "-M", "-C", &filter, "HEAD", "--"];
    let output = checked(gate.git(root, &args, STATUS_LIMIT)?)?;
    if output.truncated {
        return Err("Git status exceeds the 1 MiB inspection limit".into());
    }
    let named: std::collections::HashSet<&str> = paths.iter().map(|path| path.trim_start_matches("./")).collect();
    let fields: Vec<String> = output.bytes.split(|byte| *byte == 0).map(|field| String::from_utf8_lossy(field).into_owned()).collect();
    // `-z --name-status`: `R100\0old\0new\0` per record.
    Ok(fields
        .as_chunks::<3>()
        .0
        .iter()
        .filter(|record| codes.iter().any(|code| record[0].starts_with(code)) && named.contains(record[2].as_str()))
        .fold(Vec::new(), |sources, record| with_sources(sources, vec![record[1].clone()])))
}

/// Commit the index; the repository's hooks run unless `trust` is an untrusted phone
/// ([`Trust::hooks`]), which is refused first when the checkout's config could run a program.
pub fn git_commit(root: &Path, message: String, trust: Trust) -> Result<String, String> {
    let hooks = trust.hooks();
    if message.trim().is_empty() || message.len() > 16 * 1024 || message.contains('\0') {
        return Err("Commit message must contain 1–16,384 bytes of text".into());
    }
    require_repository(root)?;
    refuse_untrusted_programs_for(root, trust, "commit")?;
    if matches!(trust, Trust::Phone { .. }) {
        refuse_staged_hard_links(root, trust)?;
    }
    let output = checked(run_git_changing(root, &with_no_verify("commit", &["-m", &message], hooks), 16 * 1024, hooks)?)?;
    Ok(String::from_utf8_lossy(&output.bytes).trim().to_string())
}

/// Refuses a phone's commit while a staged path is [`hard_linked`] on disk now, naming it.
fn refuse_staged_hard_links(root: &Path, trust: Trust) -> Result<(), String> {
    let gate = Gate::read(root, trust)?;
    match changed_names(root, None, true, gate.prefix())?.into_iter().find(|name| hard_linked(&root.join(name))) {
        Some(name) => Err(hard_link_refused_named(&name, "commit")),
        None => Ok(()),
    }
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

fn ref_exists(gate: &Gate, root: &Path, reference: &str) -> Result<bool, String> {
    let output = gate.git(root, &["rev-parse", "--verify", "--quiet", reference], 8192)?;
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

/// [`create_worktree_for`] for the desktop's own callers. Never call it from PandaConnect code
/// (a source test checks `remote/methods` and `remote/host.rs`).
pub fn create_worktree_with(root: &Path, branch: &str, base: Option<&str>, existing: bool) -> Result<Worktree, String> {
    create_worktree_for(root, branch, base, existing, Trust::Desktop)
}

/// Create a sibling checkout. `base` chooses the start point for a new branch;
/// `existing` checks out a branch that already exists instead of creating one. The checkout
/// runs smudge filters, so an untrusted phone's goes through [`Gate::change`].
pub fn create_worktree_for(
    root: &Path,
    branch: &str,
    base: Option<&str>,
    existing: bool,
    trust: Trust,
) -> Result<Worktree, String> {
    require_repository(root)?;
    let branch = worktree_branch_name(branch)?;
    let gate = Gate::change(root, trust, "create a worktree")?;
    checked(gate.git(root, &["check-ref-format", "--branch", &branch], 8192)?)?;
    let branch_exists = ref_exists(&gate, root, &format!("refs/heads/{branch}"))?;
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
            if !ref_exists(&gate, root, &format!("{base}^{{commit}}"))? {
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
    checked(gate.git(root, &args, 16 * 1024)?)?;
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

fn default_branch(gate: &Gate, root: &Path, branches: &[String]) -> String {
    let remote = gate.git(root, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], 8192)
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

/// Reads a project file of at most `limit` bytes without following a final symlink
/// (`O_NOFOLLOW`) or blocking on a FIFO (`O_NONBLOCK`), and only when the opened handle is a
/// regular file; reads through `take(limit + 1)`, so a file that grows is still bounded
/// (Round 24). A missing file is `NotFound`; a symlink, FIFO, device or directory is
/// `InvalidInput`; an oversized file is `InvalidData`.
pub(crate) fn read_regular(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    read_bounded_file(path, limit, false)
}

/// [`read_regular`] that follows a symlink to a regular file (a symlinked `AGENTS.md` or a
/// dotfiles `~/.claude/CLAUDE.md`), for callers that never send the content anywhere; a link to
/// `/dev/zero` or a FIFO is still refused on the opened handle.
pub(crate) fn read_regular_target(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    read_bounded_file(path, limit, true)
}

fn read_bounded_file(path: &Path, limit: u64, follow: bool) -> std::io::Result<Vec<u8>> {
    use std::io::{Error, ErrorKind};
    let not_regular = || Error::new(ErrorKind::InvalidInput, "not a regular file");
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(if follow { libc::O_NONBLOCK } else { libc::O_NOFOLLOW | libc::O_NONBLOCK });
    }
    #[cfg(not(unix))]
    if !follow && fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(not_regular());
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => return Err(e),
        // ELOOP: the final component is a symlink; ENXIO: a socket.
        Err(e) => return Err(Error::new(ErrorKind::InvalidInput, e)),
    };
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(not_regular());
    }
    let too_large = || Error::new(ErrorKind::InvalidData, "file too large");
    if meta.len() > limit {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(too_large());
    }
    Ok(bytes)
}

/// The default branch of the remote a pull request opens in ([`crate::github_hub::base_remote`]):
/// its `refs/remotes/<remote>/HEAD`, so a fork checkout's phone pull request targets the
/// upstream's default, not `origin`'s (Round 24). None when that remote or ref is missing; the
/// branch need not exist locally, since it is the base repository's.
pub fn pull_base_default(root: &Path, trust: Trust) -> Option<String> {
    let remote = crate::github_hub::base_remote(root)?;
    remote_head(root, &remote, trust)
}

fn remote_head(root: &Path, remote: &str, trust: Trust) -> Option<String> {
    if remote.is_empty() || remote.starts_with('-') || remote.contains(['/', '\\', ' ', '\0']) || remote.contains("..") {
        return None;
    }
    let gate = Gate::read(root, trust).ok()?;
    let reference = format!("refs/remotes/{remote}/HEAD");
    let output = gate.git(root, &["symbolic-ref", "--quiet", "--short", &reference], 8192).ok().filter(|output| output.status.success())?;
    let text = String::from_utf8_lossy(&output.stdout.bytes).trim().to_string();
    let branch = text.strip_prefix(&format!("{remote}/"))?.to_string();
    (!branch.is_empty() && !branch.starts_with('-')).then_some(branch)
}

/// Check out another local branch in this checkout. Only branches that exist locally are
/// accepted, so the name can never be read as an option; Git itself refuses a switch that
/// would overwrite uncommitted changes, and that message is returned as it is. The checkout
/// runs smudge filters, so an untrusted phone's goes through [`Gate::change`].
pub fn git_switch(root: &Path, branch: &str, trust: Trust) -> Result<BranchList, String> {
    let list = git_branches(root, trust)?;
    if !list.branches.iter().any(|name| name == branch) {
        return Err(format!("There is no local branch named {branch}."));
    }
    if list.current != branch {
        let gate = Gate::change(root, trust, "switch branches")?;
        checked(gate.run(root, &["switch", branch], 64 * 1024, Duration::from_secs(30))?)?;
    }
    git_branches(root, trust)
}

/// The checked-out branch, empty when HEAD is detached; an untrusted phone's through [`Gate::read`].
pub(crate) fn current_branch(root: &Path, trust: Trust) -> Result<String, String> {
    current_branch_in(&Gate::read(root, trust)?, root)
}

fn current_branch_in(gate: &Gate, root: &Path) -> Result<String, String> {
    let output = gate.git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"], 8192)?;
    // A detached HEAD has no branch; that is a state, not a failure.
    Ok(if output.status.success() {
        String::from_utf8_lossy(&output.stdout.bytes).trim().to_string()
    } else {
        String::new()
    })
}

/// Local branches, most recently committed first, for choosing a start point. Sorting reads
/// every branch's commit, which a partial clone fetches lazily (through `core.sshCommand`), so
/// an untrusted phone's goes through [`Gate::read`].
pub fn git_branches(root: &Path, trust: Trust) -> Result<BranchList, String> {
    require_repository(root)?;
    let gate = Gate::read(root, trust)?;
    let output = checked(gate.git(
        root,
        &["for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", "refs/heads/"],
        256 * 1024,
    )?)?;
    let branches: Vec<String> = String::from_utf8_lossy(&output.bytes)
        .lines()
        .filter(|line| !line.is_empty())
        .take(200)
        .map(str::to_string)
        .collect();
    Ok(BranchList {
        current: current_branch_in(&gate, root)?,
        default_branch: default_branch(&gate, root, &branches),
        branches,
    })
}

#[derive(Debug, Default)]
struct WorktreeEntry {
    branch: Option<String>,
    prunable: bool,
}

/// The registered entry for a checkout, including one whose folder is gone.
fn worktree_entry(gate: &Gate, root: &Path, path: &Path) -> Result<Option<WorktreeEntry>, String> {
    let output = checked(gate.git(root, &["worktree", "list", "--porcelain"], 256 * 1024)?)?;
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

/// Everything the cleanup offer needs in one round trip. Status runs clean filters and the
/// upstream/merge checks read commits a partial clone fetches lazily, so an untrusted phone's
/// calls go through [`Gate::read`] of each checkout.
pub fn worktree_status(
    main: &Path,
    path: &Path,
    stored_branch: Option<&str>,
    trust: Trust,
) -> Result<WorktreeStatus, String> {
    let exists = path.is_dir() && path.join(".git").is_file();
    if !exists {
        let branch = stored_branch
            .map(str::to_string)
            .or_else(|| Gate::read(main, trust).and_then(|gate| worktree_entry(&gate, main, path)).ok().flatten().and_then(|e| e.branch))
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
    let in_path = Gate::read(path, trust)?;
    let in_main = Gate::read(main, trust)?;
    let mut branch = current_branch_in(&in_path, path)?;
    if branch.is_empty() {
        branch = stored_branch.unwrap_or_default().to_string();
    }
    let status = checked(in_path.git(path, &in_path.status_args(&["status", "--porcelain=v1", "-z", "--untracked-files=all"]), STATUS_LIMIT)?)?;
    let changes = status
        .bytes
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .count() as u32;
    let has_upstream = in_path.git(path, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], 8192)?.status.success();
    let ahead = if has_upstream {
        let output = checked(in_path.git(path, &["rev-list", "--count", "@{upstream}..HEAD"], 8192)?)?;
        String::from_utf8_lossy(&output.bytes)
            .trim()
            .parse()
            .unwrap_or(0)
    } else {
        0
    };
    let merged = !branch.is_empty() && in_main.git(main, &["merge-base", "--is-ancestor", &branch, "HEAD"], 8192)?.status.success();
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

fn tracked_changes(gate: &Gate, root: &Path) -> Result<bool, String> {
    let status = checked(gate.git(root, &gate.status_args(&["status", "--porcelain=v1", "--untracked-files=no"]), STATUS_LIMIT)?)?;
    Ok(!status.bytes.is_empty())
}

/// Merge a worktree's committed branch into the repository's main branch, in the
/// project's own checkout. Refuses uncommitted work on either side, and a conflict
/// aborts the merge so neither checkout is left half-merged. Hooks as [`Trust::hooks`]; every
/// other call through [`Gate::change`] of its checkout.
pub fn merge_worktree(main: &Path, path: &Path, trust: Trust) -> Result<WorktreeMerge, String> {
    let hooks = trust.hooks();
    require_repository(main)?;
    if !(path.is_dir() && path.join(".git").is_file()) {
        return Err("The worktree folder is missing; recreate it first.".into());
    }
    let in_main = Gate::change(main, trust, "merge a worktree")?;
    let in_path = Gate::change(path, trust, "merge a worktree")?;
    let branch = current_branch_in(&in_path, path)?;
    if branch.is_empty() || branch.starts_with('-') {
        return Err("The worktree is not on a branch, so there is nothing to merge.".into());
    }
    let uncommitted = checked(in_path.git(path, &in_path.status_args(&["status", "--porcelain=v1", "--untracked-files=all"]), STATUS_LIMIT)?)?;
    if !uncommitted.bytes.is_empty() {
        return Err("The worktree has uncommitted changes. Commit or discard them first; only committed work is merged.".into());
    }
    let list = git_branches(main, trust)?;
    let target = list.default_branch.clone();
    if target.is_empty() {
        return Err("This repository has no main branch to merge into.".into());
    }
    if target == branch {
        return Err(format!("The worktree is already on {target}."));
    }
    if tracked_changes(&in_main, main)? {
        return Err(format!("The project checkout has uncommitted changes. Commit or stash them there before merging into {target}."));
    }
    let count = checked(in_main.git(main, &["rev-list", "--count", &format!("{target}..{branch}")], 8192)?)?;
    let commits = String::from_utf8_lossy(&count.bytes).trim().parse().unwrap_or(0);
    let switched_from = (list.current != target).then(|| list.current.clone());
    if switched_from.is_some() {
        checked(in_main.git(main, &["switch", &target], 64 * 1024)?)?;
    }
    if commits > 0 {
        let merged = run_git_changing(main, &with_no_verify("merge", &["--no-edit", &branch], hooks), 64 * 1024, hooks)?;
        if !merged.status.success() {
            let conflicts = in_main.git(main, &["diff", "--name-only", "--diff-filter=U"], 64 * 1024)
                .map(|output| String::from_utf8_lossy(&output.stdout.bytes).lines().map(str::to_string).collect::<Vec<_>>())
                .unwrap_or_default();
            let _ = in_main.git(main, &["merge", "--abort"], 8192);
            if let Some(previous) = switched_from.as_deref().filter(|name| !name.is_empty()) {
                let _ = in_main.git(main, &["switch", previous], 64 * 1024);
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

/// [`remove_worktree_for`] for the desktop's own callers. Never call it from PandaConnect code
/// (a source test checks `remote/methods` and `remote/host.rs`).
#[cfg_attr(not(test), allow(dead_code))] // read by tests and docs only
pub fn remove_worktree(main: &Path, path: &Path, stored_branch: Option<&str>, delete_branch: bool) -> Result<WorktreeRemoval, String> {
    remove_worktree_for(main, path, stored_branch, delete_branch, Trust::Desktop)
}

/// Remove a checkout without force: Git refuses when work would be lost. `worktree remove`
/// runs a status (clean filters) in the checkout and `branch -d` reads commits, so an untrusted
/// phone's calls go through [`Gate::change`].
pub fn remove_worktree_for(
    main: &Path,
    path: &Path,
    stored_branch: Option<&str>,
    delete_branch: bool,
    trust: Trust,
) -> Result<WorktreeRemoval, String> {
    require_repository(main)?;
    if path == main {
        return Err("The main checkout cannot be removed.".into());
    }
    let gate = Gate::change(main, trust, "remove a worktree")?;
    if path.is_dir() && path.join(".git").is_file() {
        // The checkout's own `config.worktree` is only read from inside it.
        Gate::change(path, trust, "remove a worktree")?;
    }
    let entry = worktree_entry(&gate, main, path)?;
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
        checked(gate.git(main, &["worktree", "remove", "--", path_text], 16 * 1024)?)?;
    }
    checked(gate.git(main, &["worktree", "prune"], 16 * 1024)?)?;
    let mut note = String::new();
    let mut branch_deleted = false;
    if delete_branch && !branch.is_empty() {
        match checked(gate.git(main, &["branch", "-d", &branch], 16 * 1024)?) {
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
    let gate = Gate::Open;
    let entry = worktree_entry(&gate, main, path)?;
    let branch = stored_branch
        .map(str::to_string)
        .or_else(|| entry.and_then(|e| e.branch))
        .ok_or("The worktree's branch is unknown; create a new worktree instead.")?;
    if !ref_exists(&gate, main, &format!("refs/heads/{branch}"))? {
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

/// Publish the checkout's branch to its remote, creating the upstream link. The pre-push hook
/// runs as [`Trust::hooks`] says; an untrusted phone's push is refused first when the
/// checkout's config could run a program, and its other calls go through [`Gate::change`].
pub fn git_push(root: &Path, trust: Trust) -> Result<String, String> {
    let hooks = trust.hooks();
    require_repository(root)?;
    let gate = Gate::change(root, trust, "push")?;
    let branch = current_branch_in(&gate, root)?;
    if branch.is_empty() {
        return Err("Check out a branch before pushing.".into());
    }
    let remotes = checked(gate.git(root, &["remote"], 8192)?)?;
    let remotes = String::from_utf8_lossy(&remotes.bytes);
    let remote = remotes
        .lines()
        .find(|name| *name == "origin")
        .or_else(|| remotes.lines().next())
        .ok_or("Add a Git remote before pushing.")?
        .to_string();
    let refspec = format!("{branch}:{branch}");
    let output = run_git_with(
        root,
        &with_skipped_submodules(&with_no_verify("push", &["--set-upstream", &remote, &refspec], hooks), hooks),
        64 * 1024,
        hooks == Hooks::Run,
        untrusted_for(hooks, Untrusted::Network),
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
    // Before opening: opening a FIFO blocks until a writer appears, and a device never ends.
    if !fs::metadata(&target).map_err(|e| e.to_string())?.is_file() {
        return Err("The image is missing or larger than 8 MB".into());
    }
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
    if !fs::metadata(&resolved).map_err(|e| e.to_string())?.is_file() {
        return Err("The file is missing or larger than 64 MB".into());
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
        fn git_output(&self, args: &[&str]) -> String {
            let result = Command::new("git").arg("-C").arg(git_path(&self.root)).args(args).output().unwrap();
            assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
            String::from_utf8_lossy(&result.stdout).into_owned()
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

    /// Round 11: a FIFO (or device) named like an image is refused before it is opened,
    /// which would otherwise block the phone's request until a writer appeared.
    #[cfg(unix)]
    #[test]
    fn fifos_named_like_images_or_documents_are_never_opened() {
        let f = Fixture::new(false);
        for name in ["x.png", "x.pdf"] {
            let status = Command::new("mkfifo").arg(f.root.join(name)).status().unwrap();
            assert!(status.success());
        }
        let (done, finished) = std::sync::mpsc::channel();
        let root = f.root.clone();
        std::thread::spawn(move || {
            let image = image_data_url(&root, "x.png");
            let document = read_document_bytes(&root, "x.pdf");
            let text = read_file(&root, "x.png".into());
            let _ = done.send((image, document, text));
        });
        let (image, document, text) = finished.recv_timeout(std::time::Duration::from_secs(5)).expect("a FIFO blocked the read");
        assert!(image.is_err());
        assert!(document.is_err());
        assert!(text.is_err());
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
        assert!(git_stage(&f.root, vec!["escape/secret".into()], true, Trust::Desktop).is_err());
        assert!(git_diff(&f.root, Some("escape/secret".into()), false, Trust::Desktop).is_err());
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
        git_stage(&f.root, vec!["first.txt".into()], true, Trust::Desktop).unwrap();
        assert_eq!(git_status(&f.root, Trust::Desktop).unwrap().files[0].index, "A");
        git_stage(&f.root, vec!["first.txt".into()], false, Trust::Desktop).unwrap();
        assert_eq!(git_status(&f.root, Trust::Desktop).unwrap().files[0].index, "?");
        assert!(f.root.join("first.txt").is_file());
    }

    /// A repository with `tracked.txt` committed, then edited, plus untracked and staged-new files.
    fn discard_fixture() -> Fixture {
        let f = Fixture::new(true);
        fs::write(f.root.join("tracked.txt"), "one\n").unwrap();
        fs::write(f.root.join("gone.txt"), "kept\n").unwrap();
        f.git(&["add", "tracked.txt", "gone.txt"]);
        f.git(&["-c", "core.hooksPath=/dev/null", "commit", "-m", "Tracked"]);
        fs::write(f.root.join("tracked.txt"), "two\n").unwrap();
        fs::remove_file(f.root.join("gone.txt")).unwrap();
        fs::write(f.root.join("scratch.txt"), "new\n").unwrap();
        fs::create_dir_all(f.root.join("fresh")).unwrap();
        fs::write(f.root.join("fresh/inner.txt"), "new\n").unwrap();
        fs::write(f.root.join("added.txt"), "staged\n").unwrap();
        f.git(&["add", "added.txt"]);
        f
    }

    #[test]
    fn discard_restores_tracked_files_from_head() {
        let f = discard_fixture();
        f.git(&["add", "tracked.txt"]);
        fs::write(f.root.join("tracked.txt"), "three\n").unwrap();
        assert_eq!(git_discard(&f.root, vec!["tracked.txt".into(), "gone.txt".into()], Trust::phone(false)).unwrap(), 2);
        assert_eq!(fs::read_to_string(f.root.join("tracked.txt")).unwrap(), "one\n");
        assert_eq!(fs::read_to_string(f.root.join("gone.txt")).unwrap(), "kept\n");
        let paths: Vec<String> = git_status(&f.root, Trust::Desktop).unwrap().files.into_iter().map(|file| file.path).collect();
        assert!(!paths.iter().any(|path| path == "tracked.txt" || path == "gone.txt"), "{paths:?}");
        // Idempotent: a retry has nothing left to change.
        git_discard(&f.root, vec!["tracked.txt".into()], Trust::phone(false)).unwrap();
        assert_eq!(fs::read_to_string(f.root.join("tracked.txt")).unwrap(), "one\n");
    }

    #[test]
    fn discard_removes_only_the_untracked_files_it_names() {
        let f = discard_fixture();
        git_discard(&f.root, vec!["scratch.txt".into(), "fresh/inner.txt".into(), "added.txt".into()], Trust::Desktop).unwrap();
        assert!(!f.root.join("scratch.txt").exists());
        assert!(!f.root.join("fresh/inner.txt").exists());
        assert!(!f.root.join("added.txt").exists(), "a newly added file leaves the index and the disk");
        assert_eq!(fs::read_to_string(f.root.join("tracked.txt")).unwrap(), "two\n", "unnamed files keep their changes");
        // Naming a file that is already gone changes nothing.
        assert_eq!(git_discard(&f.root, vec!["scratch.txt".into()], Trust::Desktop).unwrap(), 0);
        assert!(git_discard(&f.root, vec!["fresh".into()], Trust::Desktop).is_err(), "directories are refused");
    }

    /// Long-named files in each of discard's three kinds (tracked, added, untracked), far past
    /// Windows' 32,767-character command line, discard in [`PATHSPEC_CHUNK_BYTES`] runs.
    #[test]
    fn discard_and_stage_many_long_paths_in_chunks() {
        let f = Fixture::new(true);
        let folder = "d".repeat(120);
        fs::create_dir_all(f.root.join(&folder)).unwrap();
        let name = |kind: &str, index: usize| format!("{folder}/{kind}-{}-{index:04}.txt", "n".repeat(100));
        let count = 400;
        for index in 0..count {
            fs::write(f.root.join(name("tracked", index)), "one\n").unwrap();
        }
        f.git(&["add", "--all"]);
        f.git(&["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "Tracked"]);
        let mut paths = Vec::new();
        for index in 0..count {
            fs::write(f.root.join(name("tracked", index)), "two\n").unwrap();
            fs::write(f.root.join(name("added", index)), "a\n").unwrap();
            fs::write(f.root.join(name("untracked", index)), "u\n").unwrap();
            paths.extend([name("tracked", index), name("added", index), name("untracked", index)]);
        }
        let added: Vec<String> = (0..count).map(|index| name("added", index)).collect();
        assert!(added.iter().map(|path| path.len() + 1).sum::<usize>() > 32_767);
        git_stage(&f.root, added.clone(), true, Trust::phone(false)).unwrap();
        let staged = git_status(&f.root, Trust::Desktop).unwrap().files.iter().filter(|file| file.index == "A").count();
        assert_eq!(staged, count);
        git_stage(&f.root, added.clone(), false, Trust::phone(false)).unwrap();
        assert!(git_status(&f.root, Trust::Desktop).unwrap().files.iter().all(|file| file.index != "A"));
        git_stage(&f.root, added, true, Trust::Desktop).unwrap();
        assert_eq!(git_discard(&f.root, paths, Trust::phone(false)).unwrap(), 3 * count);
        assert!(git_status(&f.root, Trust::Desktop).unwrap().files.is_empty());
        assert_eq!(fs::read_to_string(f.root.join(name("tracked", count - 1))).unwrap(), "one\n");
    }

    /// `git_stage_all` takes more than the 5,000 files a named stage allows.
    #[test]
    fn stage_all_takes_more_than_five_thousand_files() {
        let f = Fixture::new(true);
        let paths: Vec<String> = (0..5_100).map(|index| format!("f{index:05}.txt")).collect();
        for path in &paths {
            fs::write(f.root.join(path), "x").unwrap();
        }
        assert!(git_stage(&f.root, paths.clone(), true, Trust::Desktop).unwrap_err().contains("5,000"));
        assert!(git_status(&f.root, Trust::Desktop).unwrap_err().contains("5,000"));
        assert_eq!(git_status_all(&f.root, Trust::phone(false)).unwrap().files.len(), 5_100);
        git_stage_all(&f.root, paths.clone(), true, Trust::phone(false)).unwrap();
        assert!(git_status_all(&f.root, Trust::Desktop).unwrap().files.iter().all(|file| file.index == "A"));
        git_stage_all(&f.root, paths, false, Trust::phone(false)).unwrap();
        assert!(git_status_all(&f.root, Trust::Desktop).unwrap().files.iter().all(|file| file.index == "?"));
        assert_eq!(thousands(50_000), "50,000");
        assert_eq!(thousands(500), "500");
    }

    /// Folder rows (`sub/` for an untracked nested repository) leave the whole-checkout list;
    /// naming one is still a clear refusal.
    #[test]
    fn folder_rows_are_skipped_from_all_and_refused_by_name() {
        let f = Fixture::new(true);
        fs::create_dir_all(f.root.join("sub")).unwrap();
        fs::write(f.root.join("sub/x.txt"), "x").unwrap();
        fs::write(f.root.join("plain.txt"), "x").unwrap();
        let (kept, skipped) = folder_free(&f.root, vec!["sub/".into(), "sub".into(), "plain.txt".into(), "missing.txt".into()]);
        assert_eq!((kept, skipped), (vec!["plain.txt".to_string(), "missing.txt".to_string()], 2));
        assert_eq!(git_discard(&f.root, vec!["sub/".into()], Trust::Desktop).unwrap_err(), "Select individual files to discard");
        assert_eq!(git_stage(&f.root, vec!["sub/".into()], true, Trust::Desktop).unwrap_err(), "Select individual files to stage or unstage");
    }

    #[test]
    fn discarding_a_staged_rename_restores_the_old_path() {
        let f = Fixture::new(true);
        fs::write(f.root.join("old.txt"), "original\n").unwrap();
        f.git(&["add", "old.txt"]);
        f.git(&["-c", "core.hooksPath=/dev/null", "commit", "-m", "Old"]);
        f.git(&["mv", "old.txt", "new.txt"]);
        let status = git_status(&f.root, Trust::Desktop).unwrap();
        assert_eq!(status.files.len(), 1, "{status:?}");
        assert_eq!((status.files[0].index.as_str(), status.files[0].path.as_str()), ("R", "new.txt"));
        assert_eq!(status.files[0].orig_path.as_deref(), Some("old.txt"), "the rename's source is kept");
        for trust in [Trust::phone(false), Trust::Desktop] {
            assert_eq!(git_discard(&f.root, vec!["new.txt".into()], trust).unwrap(), 1, "counts the named path");
            assert_eq!(fs::read_to_string(f.root.join("old.txt")).unwrap(), "original\n");
            assert!(!f.root.join("new.txt").exists());
            assert!(git_status(&f.root, Trust::Desktop).unwrap().files.is_empty(), "back at HEAD, no staged delete");
            f.git(&["mv", "old.txt", "new.txt"]);
        }
    }

    #[test]
    fn unstaging_a_staged_rename_resets_both_paths() {
        let f = Fixture::new(true);
        fs::write(f.root.join("old.txt"), "original\n").unwrap();
        f.git(&["add", "old.txt"]);
        f.git(&["-c", "core.hooksPath=/dev/null", "commit", "-m", "Old"]);
        let staged = |f: &Fixture| f.git_output(&["diff", "--cached", "--name-only", "--no-renames"]);
        // Named (a single row) and whole-checkout (the list `git.stage {all}` sends): both new paths only.
        for (all, trust) in [(false, Trust::Desktop), (true, Trust::Desktop), (false, Trust::phone(false)), (true, Trust::phone(true))] {
            f.git(&["mv", "old.txt", "new.txt"]);
            assert_eq!(staged(&f), "new.txt\nold.txt\n");
            let result = if all { git_stage_all(&f.root, vec!["new.txt".into()], false, trust) } else { git_stage(&f.root, vec!["./new.txt".into()], false, trust) };
            result.unwrap();
            assert_eq!(staged(&f), "", "index equals HEAD for both paths (all: {all})");
            assert_eq!(f.git_output(&["ls-files", "--cached"]), "old.txt\n");
            fs::rename(f.root.join("new.txt"), f.root.join("old.txt")).unwrap();
        }
        assert!(git_status(&f.root, Trust::Desktop).unwrap().files.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn phone_diffs_leave_out_hard_linked_files() {
        let f = Fixture::new(true);
        let secret = f.base.join("id_rsa");
        fs::write(&secret, "PRIVATE KEY MATERIAL\n").unwrap();
        fs::write(f.root.join("tracked.txt"), "one\n").unwrap();
        fs::write(f.root.join("plain.txt"), "one\n").unwrap();
        f.git(&["add", "tracked.txt", "plain.txt"]);
        f.git(&["-c", "core.hooksPath=/dev/null", "commit", "-m", "Tracked"]);
        // Untracked: a hard link named like a note; tracked: a file swapped for a hard link.
        fs::hard_link(&secret, f.root.join("notes.txt")).unwrap();
        fs::remove_file(f.root.join("tracked.txt")).unwrap();
        fs::hard_link(&secret, f.root.join("tracked.txt")).unwrap();
        fs::write(f.root.join("plain.txt"), "two\n").unwrap();
        fs::write(f.root.join("fresh.txt"), "new\n").unwrap();
        for trust in [Trust::phone(false), Trust::phone(true)] {
            let (diff, skipped) = git_diff_counted(&f.root, None, false, trust).unwrap();
            assert!(!diff.contains("PRIVATE KEY"), "{diff}");
            assert!(!diff.contains("notes.txt") && !diff.contains("tracked.txt"), "{diff}");
            assert!(diff.contains("+two") && diff.contains("fresh.txt"), "other files still show: {diff}");
            assert_eq!(skipped, 2);
            for path in ["notes.txt", "tracked.txt"] {
                assert_eq!(git_diff_counted(&f.root, Some(path.into()), false, trust).unwrap(), (String::new(), 1), "{path}");
            }
        }
        f.git(&["add", "tracked.txt", "notes.txt"]);
        let (staged, skipped) = git_diff_counted(&f.root, None, true, Trust::phone(false)).unwrap();
        assert!(!staged.contains("PRIVATE KEY") && skipped == 2, "{staged}");
        // Every tracked change linked: nothing but the remaining untracked file.
        let (only, _) = git_diff_counted(&f.root, None, true, Trust::phone(true)).unwrap();
        assert!(only.is_empty(), "{only}");
        let (desktop, skipped) = git_diff_counted(&f.root, None, false, Trust::Desktop).unwrap();
        assert_eq!(skipped, 0, "the desktop's own diff is unchanged");
        assert!(desktop.contains("+two"), "{desktop}");
    }

    #[cfg(unix)]
    #[test]
    fn phones_never_stage_or_commit_hard_linked_files() {
        let f = Fixture::new(true);
        let secret = f.base.join("id_rsa");
        fs::write(&secret, "PRIVATE KEY MATERIAL\n").unwrap();
        fs::hard_link(&secret, f.root.join("notes.txt")).unwrap();
        fs::write(f.root.join("plain.txt"), "one\n").unwrap();
        for trust in [Trust::phone(false), Trust::phone(true)] {
            assert_eq!(git_stage(&f.root, vec!["plain.txt".into(), "notes.txt".into()], true, trust).unwrap_err(), HARD_LINK_REFUSED);
            assert!(git_status(&f.root, Trust::Desktop).unwrap().files.iter().all(|file| file.index == "?"), "nothing staged");
        }
        git_stage(&f.root, vec!["plain.txt".into()], true, Trust::phone(false)).unwrap();
        // A hard link staged elsewhere (the desktop) cannot be committed from the phone.
        git_stage(&f.root, vec!["notes.txt".into()], true, Trust::Desktop).unwrap();
        for trust in [Trust::phone(false), Trust::phone(true)] {
            assert_eq!(git_commit(&f.root, "Leak".into(), trust).unwrap_err(), hard_link_refused_named("notes.txt", "commit"));
        }
        // Unstaging it is harmless and allowed; then the phone's commit goes through.
        git_stage(&f.root, vec!["notes.txt".into()], false, Trust::phone(false)).unwrap();
        git_commit(&f.root, "Plain".into(), Trust::phone(false)).unwrap();
        let committed = Command::new("git").arg("-C").arg(&f.root).args(["ls-tree", "-r", "--name-only", "HEAD"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&committed.stdout).trim(), "plain.txt");
    }

    #[test]
    fn pathspec_chunks_keep_order_within_the_budget() {
        let names: Vec<String> = ["aaaa", "bbbb", "cccc", "dddddddddddd", "e"].map(String::from).to_vec();
        let chunks = pathspec_chunks(&names, 10);
        assert_eq!(chunks, [&names[0..2], &names[2..3], &names[3..4], &names[4..5]]);
        assert_eq!(chunks.concat(), names, "every name once, in order");
        assert!(pathspec_chunks(&[], 10).is_empty());
        assert_eq!(pathspec_chunks(&names, 1 << 20), [&names[..]]);
    }

    #[cfg(unix)]
    #[test]
    fn phone_diffs_with_many_paths_run_in_chunks() {
        let f = Fixture::new(true);
        let secret = f.base.join("id_rsa");
        fs::write(&secret, "PRIVATE KEY MATERIAL\n").unwrap();
        // Enough names that one command line would exceed a chunk several times over.
        let names: Vec<String> = (0..400).map(|i| format!("dir/{}-{i:04}.txt", "n".repeat(60))).collect();
        assert!(names.iter().map(|name| name.len() + 1).sum::<usize>() > 3 * PATHSPEC_CHUNK_BYTES);
        fs::create_dir_all(f.root.join("dir")).unwrap();
        for name in &names {
            fs::write(f.root.join(name), "one\n").unwrap();
        }
        fs::write(f.root.join("linked.txt"), "one\n").unwrap();
        f.git(&["add", "."]);
        f.git(&["-c", "core.hooksPath=/dev/null", "commit", "-m", "Many"]);
        for name in &names {
            fs::write(f.root.join(name), "two\n").unwrap();
        }
        fs::remove_file(f.root.join("linked.txt")).unwrap();
        fs::hard_link(&secret, f.root.join("linked.txt")).unwrap();
        let (diff, skipped) = git_diff_counted(&f.root, None, false, Trust::phone(false)).unwrap();
        assert_eq!(skipped, 1);
        assert!(!diff.contains("PRIVATE KEY") && !diff.contains("linked.txt"));
        let headers: Vec<&str> = diff.lines().filter(|line| line.starts_with("diff --git ")).collect();
        assert_eq!(headers.len(), names.len(), "every other file, once");
        let expected: Vec<String> = names.iter().map(|name| format!("diff --git a/{name} b/{name}")).collect();
        assert_eq!(headers, expected, "in Git's order");
    }

    #[test]
    fn discard_refuses_paths_outside_the_checkout() {
        let f = discard_fixture();
        fs::write(f.base.join("outside.txt"), "private").unwrap();
        for path in ["../outside.txt", ".git/config", "", "/etc/hosts"] {
            assert!(git_discard(&f.root, vec![path.into()], Trust::phone(false)).is_err(), "{path}");
        }
        let absolute = f.base.join("outside.txt").display().to_string();
        assert!(git_discard(&f.root, vec![absolute], Trust::phone(false)).is_err());
        assert!(f.base.join("outside.txt").exists());
        assert!(git_discard(&f.root, Vec::new(), Trust::phone(false)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn discard_from_an_untrusted_phone_never_runs_the_checkouts_programs() {
        let f = discard_fixture();
        let marker = f.base.join("smudge-ran");
        fs::write(f.root.join(".gitattributes"), "*.txt filter=mark\n").unwrap();
        f.git(&["config", "filter.mark.smudge", &format!("touch '{}'; cat", marker.display())]);
        let refused = git_discard(&f.root, vec!["tracked.txt".into()], Trust::phone(false)).unwrap_err();
        assert!(refused.contains("filter.mark.smudge") && refused.ends_with("to discard changes from the phone."), "{refused}");
        assert_eq!(fs::read_to_string(f.root.join("tracked.txt")).unwrap(), "two\n");
        assert!(!marker.exists(), "no smudge filter ran");
        // The desktop's (and a Full-access phone's) checkout runs the filter: the gate is real.
        git_discard(&f.root, vec!["tracked.txt".into()], Trust::phone(true)).unwrap();
        assert_eq!(fs::read_to_string(f.root.join("tracked.txt")).unwrap(), "one\n");
        assert!(marker.exists());
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
        git_stage(&f.root, vec!["file".into()], true, Trust::Desktop).unwrap();
        assert!(git_commit(&f.root, "Should fail".into(), Trust::Desktop)
            .unwrap_err()
            .contains("Test hook refused"));
    }

    #[test]
    fn skipped_hooks_set_an_empty_hooks_path_and_no_verify() {
        let run = git_global_args(true);
        assert!(!run.contains(&"core.hooksPath=/dev/null"));
        let skip = git_global_args(false);
        assert!(skip.windows(2).any(|pair| pair == ["-c", "core.hooksPath=/dev/null"]));
        assert_eq!(with_no_verify("commit", &["-m", "x"], Hooks::Run), ["commit", "-m", "x"]);
        assert_eq!(with_no_verify("commit", &["-m", "x"], Hooks::Skip), ["commit", "--no-verify", "-m", "x"]);
        assert_eq!(with_no_verify("push", &["--set-upstream", "origin", "a:a"], Hooks::Skip), ["push", "--no-verify", "--set-upstream", "origin", "a:a"]);
        assert_eq!(with_no_verify("merge", &["--no-edit", "b"], Hooks::Skip), ["merge", "--no-verify", "--no-edit", "b"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_commit_without_hooks_never_runs_the_repositorys_hook() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new(true);
        f.git(&["config", "core.hooksPath", ".git/hooks"]);
        let marker = f.root.join("hook-ran");
        let hook = f.root.join(".git/hooks/pre-commit");
        fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\nexit 1\n", marker.display())).unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(f.root.join("file"), "data").unwrap();
        git_stage(&f.root, vec!["file".into()], true, Trust::Desktop).unwrap();
        git_commit(&f.root, "No hooks".into(), Trust::phone(false)).unwrap();
        assert!(!marker.exists(), "the hook did not run");
    }

    #[test]
    fn skipped_hooks_refuse_repository_config_that_runs_programs() {
        let f = Fixture::new(true);
        fs::write(f.root.join("file"), "data").unwrap();
        git_stage(&f.root, vec!["file".into()], true, Trust::Desktop).unwrap();
        assert!(refuse_repo_config_programs(&f.root).is_ok(), "a plain repository");
        let marker = f.root.join("filter-ran");
        f.git(&["config", "filter.x.clean", &format!("touch '{}'; cat", marker.display())]);
        let error = git_commit(&f.root, "Filtered".into(), Trust::phone(false)).unwrap_err();
        assert!(error.starts_with("This repository's git config runs programs (filter.x.clean)"), "{error}");
        assert!(git_push(&f.root, Trust::phone(false)).unwrap_err().contains("filter.x.clean"));
        assert!(!marker.exists(), "no filter ran");
        // Desktop commits (hooks run) keep the user's config working.
        git_commit(&f.root, "Desktop".into(), Trust::Desktop).unwrap();
        f.git(&["config", "--unset", "filter.x.clean"]);
        f.git(&["config", "core.fsmonitor", "true"]);
        assert!(refuse_repo_config_programs(&f.root).is_ok(), "the builtin fsmonitor runs nothing");
        f.git(&["config", "include.path", "../elsewhere"]);
        assert!(refuse_repo_config_programs(&f.root).unwrap_err().contains("include.path"));
    }

    #[test]
    fn program_config_keys_cover_drivers_signing_and_transports() {
        let listing = b"core.bare\nfalse\0filter.lfs.process\ngit-lfs\0diff.pdf.textconv\npdftotext\0diff.external\nx\0merge.ours.driver\ntrue\0gpg.program\ngpg2\0gpg.ssh.program\nx\0core.sshcommand\nssh\0core.fsmonitor\n./hook\0credential.helper\nstore\0credential.https://h.helper\nx\0includeif.gitdir:/x.path\ny\0remote.origin.url\next::sh -c x\0remote.up.url\nhttps://h/x\0user.name\nme\0";
        assert_eq!(
            program_config_keys(listing),
            ["core.fsmonitor", "core.sshcommand", "credential.helper", "credential.https://h.helper", "diff.external", "diff.pdf.textconv", "filter.lfs.process", "gpg.program", "gpg.ssh.program", "includeif.gitdir:/x.path", "merge.ours.driver", "remote.origin.url"]
        );
    }

    #[test]
    fn the_allowlist_takes_only_keys_known_to_run_nothing() {
        let listing = b"core.repositoryformatversion\n0\0core.filemode\ntrue\0core.hookspath\n.husky\0remote.origin.url\ngit@github.com:o/r.git\0remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*\0branch.release-0.3.18.remote\norigin\0branch.feat/x.pushremote\nhttps://github.com/o/r.git\0branch.main.merge\nrefs/heads/main\0user.email\na@b\0commit.gpgsign\nfalse\0submodule.lib.url\nhttps://h/lib\0lfs.repositoryformatversion\n0\0gc.auto\n0\0";
        assert!(program_config_keys(listing).is_empty(), "{:?}", program_config_keys(listing));
        let listing = b"url.ext::sh -c touch% x.insteadof\nhttps://e/\0url.ext::y.pushinsteadof\nhttps://e/\0protocol.allow\nalways\0gpg.ssh.defaultkeycommand\nx\0core.alternaterefscommand\nx\0remote.a.url\ncodecommit::us-east-1://r\0remote.b.url\nevil://h/r\0remote.c.url\n-oProxyCommand=x\0branch.m.remote\next::sh\0submodule.s.update\n!sh\0remote.d.vcs\nx\0core.editor\nx\0commit.gpgsign\nsometimes\0";
        assert_eq!(
            program_config_keys(listing),
            ["branch.m.remote", "commit.gpgsign", "core.alternaterefscommand", "core.editor", "gpg.ssh.defaultkeycommand", "protocol.allow", "remote.a.url", "remote.b.url", "remote.c.url", "remote.d.vcs", "submodule.s.update", "url.ext::sh -c touch% x.insteadof", "url.ext::y.pushinsteadof"]
        );
        assert!(plain_remote_url("ssh://[::1]/repo") && plain_remote_url("HTTPS://h/r") && plain_remote_url("git@github.com:o/r.git") && plain_remote_url("host:repo"));
        assert!(!plain_remote_url("ext::sh") && !plain_remote_url("foo::bar") && !plain_remote_url("hg://h/r"));
        // Round 7: a local-path or file:// remote runs the target repository's receive hooks.
        for local in ["/srv/git/r.git", "../lib", "./x", "r.git", "file:///srv/r.git", "FILE://h/r", "C:\\repo", "C:/repo", "a/b:c", ""] {
            assert!(!plain_remote_url(local), "{local}");
        }
        assert!(plain_remote_name("origin") && plain_remote_name("up-stream") && plain_remote_name("https://h/r"));
        for local in [".", "..", "../x", "/srv/r", "a/b", "file:///r", "-x", ""] {
            assert!(!plain_remote_name(local), "{local}");
        }
        assert_eq!(program_config_keys(b"submodule.lib.url\n../lib\0remote.o.url\n/srv/r\0remote.o.pushurl\nfile:///r\0branch.m.remote\n.\0"), ["branch.m.remote", "remote.o.pushurl", "remote.o.url", "submodule.lib.url"]);
    }

    #[test]
    fn skipped_hooks_pin_git_to_its_own_transports() {
        let skip = git_global_args(false);
        for rule in SKIP_HOOKS_PROTOCOLS.into_iter().chain(["core.fsmonitor=false", "core.hooksPath=/dev/null"]) {
            assert!(skip.windows(2).any(|pair| pair == ["-c", rule]), "{rule}");
        }
        assert!(!git_global_args(true).iter().any(|arg| arg.starts_with("protocol.")), "desktop calls keep the user's transports");
    }

    /// The round-6 exploit: `protocol.allow=always` plus an `insteadOf` that rewrites the
    /// remote to `ext::`. The allowlist refuses it, and even without that check the
    /// command-line protocol rules keep `ext::` from running.
    #[cfg(unix)]
    #[test]
    fn an_insteadof_rewrite_to_ext_never_runs_with_hooks_skipped() {
        let f = Fixture::new(true);
        let marker = f.base.join("ext-ran");
        let remote = "https://example.invalid/repo";
        f.git(&["remote", "add", "origin", remote]);
        f.git(&["config", "protocol.allow", "always"]);
        f.git(&["config", &format!("url.ext::sh -c touch% {}.insteadOf", marker.display()), remote]);
        let refused = git_push(&f.root, Trust::phone(false)).unwrap_err();
        assert!(refused.starts_with("This repository's git config runs programs ("), "{refused}");
        assert!(refused.contains("protocol.allow") && refused.contains(".insteadof"), "{refused}");
        // Layer (a) alone: the push itself, past the config check, with hooks skipped.
        let output = run_git_bounded(&f.root, &["push", "--no-verify", "origin", "main:main"], 64 * 1024, false, Duration::from_secs(30)).unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr.bytes).contains("transport 'ext' not allowed"), "{}", String::from_utf8_lossy(&output.stderr.bytes));
        assert!(!marker.exists(), "ext:: did not run");
        // The same push with the user's own rules (a desktop push) does run it: the exploit is real.
        let _ = run_git_bounded(&f.root, &["push", "origin", "main:main"], 64 * 1024, true, Duration::from_secs(30)).unwrap();
        assert!(marker.exists(), "the fixture reproduces the exploit");
    }

    /// `git` with no global or system config, for the round-7 fixtures.
    fn bare_git(dir: &Path, args: &[&str]) {
        let result = Command::new("git")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always"])
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(result.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&result.stderr));
    }

    /// Makes `file` look stale to Git (same size, older mtime), so a status must hash it.
    #[cfg(unix)]
    fn make_stale(file: &Path) {
        assert!(Command::new("touch").args(["-t", "200001010000"]).arg(file).status().unwrap().success());
    }

    /// Round 7: a push to a local-path or `file://` remote runs the TARGET repository's receive
    /// hooks (`git-receive-pack` clears `GIT_CONFIG_PARAMETERS`). With hooks skipped the
    /// allowlist refuses such a remote, and the command line forbids the file transport anyway.
    #[cfg(unix)]
    #[test]
    fn a_push_with_hooks_skipped_never_reaches_a_local_remote() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new(true);
        let bare = f.base.join("remote.git");
        let made = Command::new("git").args(["init", "--bare", "-b", "main"]).arg(&bare).output().unwrap();
        assert!(made.status.success());
        let marker = f.base.join("receive-hook-ran");
        let hook = bare.join("hooks/post-receive");
        fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        bare_git(&bare, &["config", "core.hooksPath", &bare.join("hooks").display().to_string()]);
        for url in [bare.display().to_string(), format!("file://{}", bare.display())] {
            let _ = Command::new("git").arg("-C").arg(&f.root).args(["remote", "remove", "origin"]).output();
            f.git(&["remote", "add", "origin", &url]);
            let refused = git_push(&f.root, Trust::phone(false)).unwrap_err();
            assert!(refused.contains("remote.origin.url"), "{refused}");
            // Past the allowlist, the hooks-skipped command line still forbids the transport.
            let output = run_git_bounded(&f.root, &["push", "--no-verify", "origin", "main:main"], 64 * 1024, false, Duration::from_secs(30)).unwrap();
            assert!(!output.status.success(), "{url}");
            assert!(String::from_utf8_lossy(&output.stderr.bytes).contains("transport 'file' not allowed"), "{}", String::from_utf8_lossy(&output.stderr.bytes));
            assert!(!marker.exists(), "the target's hook did not run for {url}");
        }
        // The desktop's push (hooks run) does reach it: the exploit is real.
        git_push(&f.root, Trust::Desktop).unwrap();
        assert!(marker.exists(), "the fixture reaches the target's receive hook");
    }

    /// Round 7: a submodule's own config (`.git/modules/<x>/config`) never passes through the
    /// top-level allowlist, so with hooks skipped status and diff must not enter submodules and
    /// commits, pushes and merges refuse a checkout that has them.
    #[cfg(unix)]
    #[test]
    fn hooks_skipped_git_never_runs_a_submodules_own_filters() {
        let f = Fixture::new(true);
        let library = f.base.join("library");
        fs::create_dir_all(&library).unwrap();
        bare_git(&library, &["init", "-b", "main"]);
        fs::write(library.join("a.txt"), "one").unwrap();
        fs::write(library.join(".gitattributes"), "*.txt filter=evil\n").unwrap();
        bare_git(&library, &["add", "."]);
        bare_git(&library, &["commit", "-m", "Library"]);
        bare_git(&f.root, &["submodule", "add", &library.display().to_string(), "lib"]);
        bare_git(&f.root, &["commit", "-m", "Add lib"]);
        let marker = f.base.join("submodule-filter-ran");
        let sub = f.root.join("lib");
        bare_git(&sub, &["config", "filter.evil.clean", &format!("touch '{}'; cat", marker.display())]);
        assert!(f.root.join(".git/modules/lib/config").is_file());
        make_stale(&sub.join("a.txt"));
        // As for a submodule from GitHub: the top-level config then passes the allowlist.
        f.git(&["config", "submodule.lib.url", "https://example.invalid/lib.git"]);
        assert!(refuse_repo_config_programs(&f.root).is_ok(), "the top-level config passes the allowlist");
        assert!(git_status(&f.root, Trust::phone(false)).unwrap().is_repo);
        git_diff(&f.root, None, false, Trust::phone(false)).unwrap();
        git_diff(&f.root, Some("lib".into()), false, Trust::phone(false)).unwrap();
        assert!(!marker.exists(), "no submodule filter ran");
        for refused in [git_commit(&f.root, "Sub".into(), Trust::phone(false)).unwrap_err(), git_push(&f.root, Trust::phone(false)).unwrap_err()] {
            assert!(refused.contains("submodules"), "{refused}");
        }
        assert!(refuse_untrusted_programs(&f.root, Trust::Desktop).is_ok(), "the desktop keeps its submodules");
        // A checkout whose `.gitmodules` is gone still has `.git/modules`.
        fs::remove_file(f.root.join(".gitmodules")).unwrap();
        assert!(refuse_submodules(&f.root).unwrap_err().contains("submodules"));
        // The desktop's status (the user's own rules) does run it: the exploit is real.
        git_status(&f.root, Trust::Desktop).unwrap();
        assert!(marker.exists(), "the fixture reaches the submodule's clean filter");
    }

    /// Round 10: a checkout's own `diff.srcPrefix`/`dstPrefix`, `diff.noprefix` or
    /// `diff.mnemonicPrefix` would rewrite the `diff --git` headers the host's secret-file
    /// filter reads; every diff (tracked and untracked, desktop and phone) keeps `a/` and `b/`.
    #[test]
    fn diffs_always_name_files_with_a_and_b_prefixes() {
        let f = Fixture::new(true);
        fs::write(f.root.join(".env"), "KEY=1\n").unwrap();
        bare_git(&f.root, &["add", ".env"]);
        bare_git(&f.root, &["commit", "-m", "env"]);
        fs::write(f.root.join(".env"), "KEY=2\n").unwrap();
        fs::write(f.root.join(".env.local"), "LOCAL=1\n").unwrap();
        for config in [
            vec![("diff.srcPrefix", "Q"), ("diff.dstPrefix", "R")],
            vec![("diff.srcPrefix", "Q")],
            vec![("diff.noprefix", "true")],
            vec![("diff.mnemonicPrefix", "true")],
        ] {
            for (key, value) in &config {
                bare_git(&f.root, &["config", key, value]);
            }
            for trust in [Trust::Desktop, Trust::phone(false), Trust::phone(true)] {
                let diff = git_diff(&f.root, None, false, trust).unwrap();
                assert!(diff.contains("diff --git a/.env b/.env\n") && diff.contains("--- a/.env\n") && diff.contains("+++ b/.env\n"), "{config:?} {trust:?}: {diff}");
                assert!(diff.contains("diff --git a/.env.local b/.env.local\n") && diff.contains("+++ b/.env.local\n"), "untracked, {config:?} {trust:?}: {diff}");
                let one = git_diff(&f.root, Some(".env.local".into()), false, trust).unwrap();
                assert!(one.contains("+++ b/.env.local\n"), "{config:?} {trust:?}: {one}");
            }
            bare_git(&f.root, &["add", ".env"]);
            let staged = git_diff(&f.root, None, true, Trust::phone(false)).unwrap();
            assert!(staged.contains("diff --git a/.env b/.env\n"), "{config:?}: {staged}");
            bare_git(&f.root, &["reset", "-q", "HEAD", "--", ".env"]);
            for (key, _) in &config {
                bare_git(&f.root, &["config", "--unset", key]);
            }
        }
    }

    /// Round 10: `core.worktree` moves the working tree status and diff read, so the read gate
    /// refuses it as the change allowlist does: a phone never reads files outside the project.
    #[test]
    fn hooks_skipped_reads_refuse_a_moved_worktree() {
        let f = Fixture::new(true);
        let outside = f.base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "PRIVATE\n").unwrap();
        bare_git(&f.root, &["config", "core.worktree", &outside.display().to_string()]);
        assert_eq!(Gate::read(&f.root, Trust::phone(false)).unwrap_err(), WORKTREE_REFUSED);
        assert_eq!(Gate::read(&f.root, Trust::Desktop).unwrap(), Gate::Open);
        // Status and diff also refuse it earlier: the repository root no longer matches.
        assert!(git_diff(&f.root, None, false, Trust::phone(false)).is_err());
        // `git_inspect` (no root check) is where the read gate alone stops it.
        assert_eq!(git_inspect(&f.root, &["status", "--porcelain"], 8192, Duration::from_secs(10), Trust::phone(false)).err().unwrap(), WORKTREE_REFUSED);
        assert!(refuse_repo_config_programs(&f.root).unwrap_err().contains("core.worktree"), "the change allowlist refuses it too");
        // Without the gate Git really reads outside the project: the exploit is real.
        let raw = run_git_inspecting(&f.root, &["status", "--porcelain", "--untracked-files=all"], 8192, false).unwrap();
        assert!(String::from_utf8_lossy(&raw.stdout.bytes).contains("secret.txt"));
        assert!(config_entry_moves_worktree("CORE.WorkTree\n/x") && !config_entry_moves_worktree("core.bare\nfalse"));
    }

    /// Round 10: an untrusted-config refusal names what the phone asked for, never "commit"
    /// for a stage, switch or push.
    #[test]
    fn untrusted_config_refusals_name_the_action() {
        let f = Fixture::new(true);
        bare_git(&f.root, &["branch", "other"]);
        fs::write(f.root.join("a.txt"), "a\n").unwrap();
        bare_git(&f.root, &["config", "filter.mark.clean", "cat"]);
        let phone = Trust::phone(false);
        for (refused, action) in [
            (git_stage(&f.root, vec!["a.txt".into()], true, phone).unwrap_err(), "stage files"),
            (git_switch(&f.root, "other", phone).unwrap_err(), "switch branches"),
            (git_commit(&f.root, "x".into(), phone).unwrap_err(), "commit"),
            (git_push(&f.root, phone).unwrap_err(), "push"),
            (refuse_untrusted_programs(&f.root, phone).unwrap_err(), GIT_ACTION),
        ] {
            assert!(refused.contains("filter.mark.clean") && refused.ends_with(&format!("to {action} from the phone.")), "{refused}");
        }
        assert!(!git_stage(&f.root, vec!["a.txt".into()], true, phone).unwrap_err().contains("commit"));
    }

    /// Round 7: filters defined in an included config file are not in the local listing, so
    /// a hooks-skipped status or diff refuses a config with `include.*`/`includeIf.*`.
    #[cfg(unix)]
    #[test]
    fn hooks_skipped_status_refuses_a_config_that_includes_files() {
        let f = Fixture::new(true);
        fs::write(f.root.join("tracked.txt"), "one").unwrap();
        fs::write(f.root.join(".gitattributes"), "*.txt filter=inc\n").unwrap();
        git_stage(&f.root, vec!["tracked.txt".into(), ".gitattributes".into()], true, Trust::Desktop).unwrap();
        git_commit(&f.root, "Tracked".into(), Trust::Desktop).unwrap();
        let marker = f.base.join("included-filter-ran");
        let included = f.base.join("included.cfg");
        fs::write(&included, format!("[filter \"inc\"]\n\tclean = touch '{}'; cat\n", marker.display())).unwrap();
        f.git(&["config", "include.path", &included.display().to_string()]);
        make_stale(&f.root.join("tracked.txt"));
        assert_eq!(git_status(&f.root, Trust::phone(false)).unwrap_err(), INCLUDES_REFUSED);
        assert_eq!(git_diff(&f.root, None, false, Trust::phone(false)).unwrap_err(), INCLUDES_REFUSED);
        f.git(&["config", "--unset", "include.path"]);
        f.git(&["config", "includeIf.gitdir:/.path", &included.display().to_string()]);
        assert_eq!(git_status(&f.root, Trust::phone(false)).unwrap_err(), INCLUDES_REFUSED);
        assert!(!marker.exists(), "no included filter ran");
        // The desktop's status follows the include and runs it: the exploit is real.
        git_status(&f.root, Trust::Desktop).unwrap();
        assert!(marker.exists(), "the fixture reaches the included clean filter");
    }

    /// Round 8: in a partial clone (`remote.origin.promisor=true`) a diff fetches missing blobs
    /// lazily, through the repository's own `core.sshCommand` or credential helper. A
    /// hooks-skipped inspection refuses such a config, and every hooks-skipped call sets
    /// `GIT_NO_LAZY_FETCH` and clears credential helpers and askpass anyway.
    #[cfg(unix)]
    #[test]
    fn hooks_skipped_inspection_never_fetches_lazily_from_a_partial_clone() {
        let f = Fixture::new(true);
        fs::write(f.root.join("a.txt"), "one\n").unwrap();
        bare_git(&f.root, &["add", "a.txt"]);
        bare_git(&f.root, &["commit", "-m", "A"]);
        let blob = String::from_utf8(Command::new("git").arg("-C").arg(&f.root).args(["rev-parse", "HEAD:a.txt"]).output().unwrap().stdout).unwrap();
        let blob = blob.trim();
        fs::remove_file(f.root.join(".git/objects").join(&blob[..2]).join(&blob[2..])).unwrap();
        fs::write(f.root.join("a.txt"), "two\n").unwrap();
        let marker = f.base.join("lazy-fetch-ran");
        bare_git(&f.root, &["config", "remote.origin.url", "ssh://example.invalid/x.git"]);
        bare_git(&f.root, &["config", "remote.origin.promisor", "true"]);
        bare_git(&f.root, &["config", "extensions.partialClone", "origin"]);
        bare_git(&f.root, &["config", "core.sshCommand", &format!("touch '{}'; false", marker.display())]);
        let refused = git_diff(&f.root, None, false, Trust::phone(false)).unwrap_err();
        assert!(refused.contains("core.sshcommand") && refused.contains("remote.origin.promisor") && refused.contains("extensions.partialclone"), "{refused}");
        assert!(git_status(&f.root, Trust::phone(false)).unwrap_err().contains("Full access"));
        assert!(git_inspect(&f.root, &["rev-list", "--count", "HEAD"], 8192, Duration::from_secs(10), Trust::phone(false)).err().unwrap().contains("core.sshcommand"));
        // Past the refusal, the hooks-skipped command line itself never fetches lazily.
        let diff = run_git_inspecting(&f.root, &["diff", "--no-ext-diff", "--no-textconv"], DIFF_LIMIT, true).unwrap();
        assert!(!diff.status.success());
        assert!(!marker.exists(), "no lazy fetch ran");
        // The desktop's diff does fetch through core.sshCommand: the exploit is real.
        let _ = git_diff(&f.root, None, false, Trust::Desktop);
        assert!(marker.exists(), "the fixture reaches the lazy fetch");
        // Credential helpers and askpass refuse too; a false promisor is inert.
        for (key, value, risky) in [
            ("credential.helper", "store", true),
            ("credential.https://x.username", "a", true),
            ("core.askPass", "/bin/x", true),
            ("remote.a.promisor", "", true),
            ("remote.a.promisor", "false", false),
            ("extensions.partialClone", "", false),
            ("remote.a.url", "https://x", false),
        ] {
            assert_eq!(network_program_key(&format!("{key}\n{value}")).is_some(), risky, "{key}={value}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn status_with_hooks_skipped_switches_off_the_checkouts_filters() {
        let f = Fixture::new(true);
        fs::write(f.root.join("tracked.txt"), "one").unwrap();
        git_stage(&f.root, vec!["tracked.txt".into()], true, Trust::Desktop).unwrap();
        git_commit(&f.root, "Tracked".into(), Trust::Desktop).unwrap();
        let marker = f.base.join("filter-ran");
        fs::write(f.root.join(".gitattributes"), "*.txt filter=x\n").unwrap();
        f.git(&["config", "filter.x.clean", &format!("touch '{}'; cat", marker.display())]);
        f.git(&["config", "filter.x.required", "true"]);
        // Same size, older mtime: status must hash the file, through its clean filter.
        let touch = |file: &Path| assert!(Command::new("touch").args(["-t", "200001010000"]).arg(file).status().unwrap().success());
        touch(&f.root.join("tracked.txt"));
        let status = git_status(&f.root, Trust::phone(false)).unwrap();
        assert!(status.is_repo && status.files.iter().any(|file| file.path == ".gitattributes"));
        assert!(!marker.exists(), "no filter ran");
        // The desktop's status (the user's own config) does run it: the check above means something.
        git_status(&f.root, Trust::Desktop).unwrap();
        assert!(marker.exists(), "the fixture reaches the clean filter");
        assert_eq!(filter_name("filter.a.b.clean\nx").as_deref(), Some("a.b"));
        assert_eq!(filter_name("Filter.Up.smudge").as_deref(), Some("Up"));
        assert!(filter_name("diff.x.textconv\ny").is_none());
        // An allowlisted checkout gets the plain status.
        let plain = Fixture::new(true);
        assert!(git_status(&plain.root, Trust::phone(false)).unwrap().is_repo);
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
        let status = git_status(&f.root, Trust::Desktop).unwrap();
        assert!(status.is_repo);
        assert_eq!(status.branch, "main");
        assert!(status
            .files
            .iter()
            .any(|v| v.path == name && v.index == "?"));
        assert!(git_diff(&f.root, Some(name.into()), false, Trust::Desktop)
            .unwrap()
            .contains("+first"));
        assert!(git_diff(&f.root, None, false, Trust::Desktop).unwrap().contains("+first"));
        git_stage(&f.root, vec![name.into()], true, Trust::Desktop).unwrap();
        assert!(git_diff(&f.root, Some(name.into()), true, Trust::Desktop)
            .unwrap()
            .contains("+first"));
        git_stage(&f.root, vec![name.into()], false, Trust::Desktop).unwrap();
        assert!(!git_status(&f.root, Trust::Desktop)
            .unwrap()
            .files
            .iter()
            .any(|v| v.index == "A"));
        git_stage(&f.root, vec![name.into()], true, Trust::Desktop).unwrap();
        assert!(!git_commit(&f.root, "Add literal filename".into(), Trust::Desktop)
            .unwrap()
            .is_empty());
        fs::remove_file(f.root.join(name)).unwrap();
        assert!(git_diff(&f.root, Some(name.into()), false, Trust::Desktop)
            .unwrap()
            .contains("-first"));
        git_stage(&f.root, vec![name.into()], true, Trust::Desktop).unwrap();
        assert!(git_status(&f.root, Trust::Desktop)
            .unwrap()
            .files
            .iter()
            .any(|v| v.path == name && v.index == "D"));
        // Brackets are valid Windows filename characters and still exercise
        // literal Git pathspec handling: this must not stage other.txt.
        fs::write(f.root.join("[o]ther.txt"), "literal pattern\n").unwrap();
        git_stage(&f.root, vec!["[o]ther.txt".into()], true, Trust::Desktop).unwrap();
        #[cfg(unix)]
        {
            fs::write(f.root.join("*.txt"), "literal wildcard\n").unwrap();
            git_stage(&f.root, vec!["*.txt".into()], true, Trust::Desktop).unwrap();
        }
        assert!(git_status(&f.root, Trust::Desktop)
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
        let files = git_status(&f.root, Trust::Desktop).unwrap().files;
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
        let diff = |path: &str, staged| git_diff(&f.root, Some(path.into()), staged, Trust::Desktop).unwrap();

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

        let all = git_diff(&f.root, None, false, Trust::Desktop).unwrap();
        assert!(all.contains("+new") && all.contains("+fresh"));
        assert!(!all.contains("+staged") && !all.contains("hidden"));
    }

    #[test]
    fn repository_cache_is_dropped_when_the_repository_goes_away() {
        let f = Fixture::new(true);
        fs::write(f.root.join("a.txt"), "a\n").unwrap();
        let cached = || verified_repositories().lock().unwrap().contains_key(&f.root);
        assert!(!cached());
        assert!(git_status(&f.root, Trust::Desktop).unwrap().is_repo);
        assert!(cached(), "a status refresh seeds the check git_diff reuses");
        assert!(git_diff(&f.root, Some("a.txt".into()), false, Trust::Desktop).unwrap().contains("+a"));
        assert!(cached());
        // A corrupt HEAD passes the cheap check, so the failing diff itself must evict.
        fs::write(f.root.join(".git/HEAD"), "garbage\n").unwrap();
        assert!(git_diff(&f.root, Some("a.txt".into()), false, Trust::Desktop).is_err());
        assert!(!cached());
        fs::write(f.root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        assert!(git_diff(&f.root, None, false, Trust::Desktop).unwrap().contains("+a"));
        assert!(cached());
        // A removed repository fails the cheap check and is verified again.
        fs::remove_dir_all(f.root.join(".git")).unwrap();
        assert!(git_diff(&f.root, Some("a.txt".into()), false, Trust::Desktop).is_err());
        assert!(!cached());
        assert!(!git_status(&f.root, Trust::Desktop).unwrap().is_repo);
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
        let diff = git_diff(&f.root, Some("large.txt".into()), false, Trust::Desktop).unwrap();
        assert!(diff.len() <= 256 * 1024);
        assert!(diff.contains("Preview truncated"));
    }

    #[test]
    fn non_repository_has_clear_status_and_commit_rejects_empty_message() {
        let f = Fixture::new(false);
        assert!(!git_status(&f.root, Trust::Desktop).unwrap().is_repo);
        assert!(git_commit(&f.root, " ".into(), Trust::Desktop).is_err());
    }

    #[test]
    fn repository_discovery_reports_git_errors() {
        let f = Fixture::new(true);
        fs::write(f.root.join(".git/config"), "[invalid section\n").unwrap();
        let error = git_status(&f.root, Trust::Desktop).unwrap_err();
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
        assert_eq!(git_status(&path, Trust::Desktop).unwrap().branch, "pandacode/feature-one");
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
        assert!(merge_worktree(&f.root, &path, Trust::Desktop).unwrap_err().contains("uncommitted"));
        in_worktree(&["add", "speed.txt"]);
        in_worktree(&["-c", "core.hooksPath=/dev/null", "commit", "-m", "Faster"]);
        // The project checkout moves to main for the merge and gains the commit.
        f.git(&["switch", "-c", "elsewhere"]);
        let merged = merge_worktree(&f.root, &path, Trust::Desktop).unwrap();
        assert_eq!((merged.branch.as_str(), merged.target.as_str(), merged.commits), ("pandacode/fast", "main", 1));
        assert_eq!(merged.switched_from.as_deref(), Some("elsewhere"));
        assert_eq!(fs::read_to_string(f.root.join("speed.txt")).unwrap(), "faster");
        assert!(worktree_status(&f.root, &path, None, Trust::Desktop).unwrap().merged);
        // Merging again has nothing left to bring over.
        assert_eq!(merge_worktree(&f.root, &path, Trust::Desktop).unwrap().commits, 0);

        // A conflict aborts cleanly: main keeps its own version and no merge is left open.
        fs::write(f.root.join("speed.txt"), "main's take").unwrap();
        f.git(&["-c", "core.hooksPath=/dev/null", "commit", "-am", "Main"]);
        fs::write(path.join("speed.txt"), "worktree's take").unwrap();
        in_worktree(&["-c", "core.hooksPath=/dev/null", "commit", "-am", "Worktree"]);
        let error = merge_worktree(&f.root, &path, Trust::Desktop).unwrap_err();
        assert!(error.contains("conflicts in speed.txt"), "{error}");
        assert_eq!(fs::read_to_string(f.root.join("speed.txt")).unwrap(), "main's take");
        assert!(!f.root.join(".git/MERGE_HEAD").exists());

        // Uncommitted tracked changes in the project checkout block the merge.
        fs::write(f.root.join("speed.txt"), "edited").unwrap();
        assert!(merge_worktree(&f.root, &path, Trust::Desktop).unwrap_err().contains("project checkout has uncommitted"));
    }

    #[test]
    fn switching_branches_accepts_only_local_branches_and_keeps_uncommitted_work_safe() {
        let f = Fixture::new(true);
        f.git(&["branch", "feature"]);
        assert_eq!(git_switch(&f.root, "feature", Trust::Desktop).unwrap().current, "feature");
        assert_eq!(git_switch(&f.root, "main", Trust::Desktop).unwrap().current, "main");
        assert!(git_switch(&f.root, "--orphan", Trust::Desktop).unwrap_err().contains("no local branch"));
        assert!(git_switch(&f.root, "missing", Trust::Desktop).unwrap_err().contains("no local branch"));

        // A change that the other branch would overwrite stops the switch; nothing is lost.
        fs::write(f.root.join("note.txt"), "on main").unwrap();
        f.git(&["add", "note.txt"]);
        f.git(&["-c", "core.hooksPath=/dev/null", "commit", "-m", "Note"]);
        f.git(&["switch", "feature"]);
        fs::write(f.root.join("note.txt"), "draft").unwrap();
        assert!(git_switch(&f.root, "main", Trust::Desktop).is_err());
        assert_eq!(git_branches(&f.root, Trust::Desktop).unwrap().current, "feature");
        assert_eq!(fs::read_to_string(f.root.join("note.txt")).unwrap(), "draft");
    }

    /// Round 24: project reads never follow a symlink to `/dev/zero` or block on a FIFO.
    #[cfg(unix)]
    #[test]
    fn read_regular_refuses_links_fifos_and_oversized_files() {
        use std::io::ErrorKind;
        let f = Fixture::new(false);
        let file = f.root.join("AGENTS.md");
        assert_eq!(read_regular(&file, 16).unwrap_err().kind(), ErrorKind::NotFound);
        fs::write(&file, "rules").unwrap();
        assert_eq!(read_regular(&file, 16).unwrap(), b"rules");
        assert_eq!(read_regular(&file, 5).unwrap(), b"rules", "exactly the limit");
        assert_eq!(read_regular(&file, 4).unwrap_err().kind(), ErrorKind::InvalidData);
        let zero = f.root.join("zero.md");
        std::os::unix::fs::symlink("/dev/zero", &zero).unwrap();
        assert_eq!(read_regular(&zero, 1 << 20).unwrap_err().kind(), ErrorKind::InvalidInput);
        let linked = f.root.join("CLAUDE.md");
        std::os::unix::fs::symlink(&file, &linked).unwrap();
        assert_eq!(read_regular(&linked, 16).unwrap_err().kind(), ErrorKind::InvalidInput, "a symlink is never followed");
        assert_eq!(read_regular_target(&linked, 16).unwrap(), b"rules", "unless asked, to a regular file");
        assert_eq!(read_regular_target(&zero, 1 << 20).unwrap_err().kind(), ErrorKind::InvalidInput, "never to a device");
        let fifo = f.root.join("fifo.md");
        let c_path = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        let started = Instant::now();
        assert_eq!(read_regular(&fifo, 16).unwrap_err().kind(), ErrorKind::InvalidInput);
        let fifo_link = f.root.join("fifo-link.md");
        std::os::unix::fs::symlink(&fifo, &fifo_link).unwrap();
        assert_eq!(read_regular_target(&fifo_link, 16).unwrap_err().kind(), ErrorKind::InvalidInput);
        assert!(started.elapsed() < Duration::from_secs(2), "a FIFO never blocks");
        assert_eq!(read_regular(&f.root, 16).unwrap_err().kind(), ErrorKind::InvalidInput, "a directory");
    }

    /// Round 24: a pull request's default base is the base remote's HEAD, not `origin`'s.
    #[test]
    fn pull_base_default_reads_the_base_remotes_head() {
        let f = Fixture::new(true);
        f.git(&["remote", "add", "origin", "git@github.com:me/fork.git"]);
        assert_eq!(pull_base_default(&f.root, Trust::Desktop), None, "no HEAD ref: the caller falls back");
        f.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        f.git(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        assert_eq!(pull_base_default(&f.root, Trust::Desktop).as_deref(), Some("main"), "origin alone");
        f.git(&["remote", "add", "upstream", "https://github.com/up/stream.git"]);
        assert_eq!(pull_base_default(&f.root, Trust::Desktop), None, "upstream has no HEAD: not origin's");
        f.git(&["update-ref", "refs/remotes/upstream/develop", "HEAD"]);
        f.git(&["symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/develop"]);
        assert_eq!(pull_base_default(&f.root, Trust::Desktop).as_deref(), Some("develop"), "the fork's upstream");
        assert_eq!(git_branches(&f.root, Trust::Desktop).unwrap().default_branch, "main", "the desktop's list is unchanged");
        assert_eq!(remote_head(&f.root, "-x", Trust::Desktop), None);
    }

    #[test]
    fn worktree_lifecycle_reports_state_and_removes_only_clean_checkouts() {
        let f = Fixture::new(true);
        fs::write(f.root.join("base.txt"), "base").unwrap();
        git_stage(&f.root, vec!["base.txt".into()], true, Trust::Desktop).unwrap();
        git_commit(&f.root, "Base commit".into(), Trust::Desktop).unwrap();
        let branches = git_branches(&f.root, Trust::Desktop).unwrap();
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

        let status = worktree_status(&f.root, &created.path, Some(&created.branch), Trust::Desktop).unwrap();
        assert!(status.exists && status.clean && status.merged && !status.has_upstream);
        assert_eq!(status.branch, "pandacode/lifecycle");

        // Dirty checkouts are never removed; the status says why.
        fs::write(created.path.join("wip.txt"), "unsaved").unwrap();
        let dirty = worktree_status(&f.root, &created.path, None, Trust::Desktop).unwrap();
        assert!(!dirty.clean && dirty.changes == 1);
        assert!(remove_worktree(&f.root, &created.path, None, true).is_err());
        assert!(created.path.is_dir());
        fs::remove_file(created.path.join("wip.txt")).unwrap();

        // An unmerged branch survives removal; a merged one is deleted.
        fs::write(created.path.join("feature.txt"), "feature").unwrap();
        git_stage(&created.path, vec!["feature.txt".into()], true, Trust::Desktop).unwrap();
        git_commit(&created.path, "Feature commit".into(), Trust::Desktop).unwrap();
        assert!(!worktree_status(&f.root, &created.path, None, Trust::Desktop).unwrap().merged);
        let removal = remove_worktree(&f.root, &created.path, Some("pandacode/lifecycle"), true).unwrap();
        assert!(removal.removed && !removal.branch_deleted);
        assert!(removal.note.contains("kept"), "{}", removal.note);
        assert!(!created.path.exists());
        assert!(ref_exists(&Gate::Open, &f.root, "refs/heads/pandacode/lifecycle").unwrap());

        // The branch can come back at the same path, then go for good once merged.
        let restored = recreate_worktree(&f.root, &created.path, Some("pandacode/lifecycle")).unwrap();
        assert_eq!(restored, created.path);
        assert_eq!(git_status(&restored, Trust::Desktop).unwrap().branch, "pandacode/lifecycle");
        checked(run_git(&f.root, &["merge", "--no-edit", "pandacode/lifecycle"], 16 * 1024, false).unwrap()).unwrap();
        assert!(worktree_status(&f.root, &restored, None, Trust::Desktop).unwrap().merged);
        let removal = remove_worktree(&f.root, &restored, None, true).unwrap();
        assert!(removal.removed && removal.branch_deleted && removal.note.is_empty());
        assert!(!ref_exists(&Gate::Open, &f.root, "refs/heads/pandacode/lifecycle").unwrap());
        assert!(remove_worktree(&f.root, &f.root, None, false).is_err());
    }

    #[test]
    fn missing_worktree_folder_is_recognized_and_recreated_from_the_registry() {
        let f = Fixture::new(true);
        let created = create_worktree_with(&f.root, "vanished", None, false).unwrap();
        let registered = worktree_entry(&Gate::Open, &f.root, &created.path).unwrap().unwrap();
        assert_eq!(registered.branch.as_deref(), Some("pandacode/vanished"));
        assert!(!registered.prunable);
        fs::remove_dir_all(&created.path).unwrap();
        let registered = worktree_entry(&Gate::Open, &f.root, &created.path).unwrap().unwrap();
        assert_eq!(registered.branch.as_deref(), Some("pandacode/vanished"));
        assert!(registered.prunable);
        let unrelated = f.base.join("unrelated").join(created.path.file_name().unwrap());
        assert!(worktree_entry(&Gate::Open, &f.root, &unrelated).unwrap().is_none());
        let status = worktree_status(&f.root, &created.path, None, Trust::Desktop).unwrap();
        assert!(!status.exists);
        assert_eq!(status.branch, "pandacode/vanished", "branch comes from git worktree list");
        let restored = recreate_worktree(&f.root, &created.path, None).unwrap();
        assert!(restored.join(".git").is_file());
        let removal = remove_worktree(&f.root, &restored, None, false).unwrap();
        assert!(removal.removed && !removal.branch_deleted);
        assert!(ref_exists(&Gate::Open, &f.root, "refs/heads/pandacode/vanished").unwrap());
    }

    #[test]
    fn worktree_preserves_explicit_current_and_legacy_prefixes() {
        let f = Fixture::new(true);
        // Historical branch and path prefixes remain supported after a rename.
        for prefix in ["pandacode", "kingcode", "codex"] {
            let branch = format!("{prefix}/existing-convention");
            let path = create_worktree(&f.root, branch.clone()).unwrap();
            assert_eq!(git_status(&path, Trust::Desktop).unwrap().branch, branch);
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
                git_status(&worktree_root, Trust::Desktop).unwrap().branch,
                "pandacode/isolated-task"
            );
            assert_eq!(git_status(&main_root, Trust::Desktop).unwrap().branch, "main");
            git_stage(&worktree_root, vec!["checkout.txt".into()], true, Trust::Desktop).unwrap();
            assert_eq!(git_status(&worktree_root, Trust::Desktop).unwrap().files[0].index, "M");
            assert!(git_status(&main_root, Trust::Desktop).unwrap().files.is_empty());
            git_commit(&worktree_root, "Change worktree checkout".into(), Trust::Desktop).unwrap();
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
                git_status(&empty_path, Trust::Desktop).unwrap().branch,
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


    thread_local! {
        /// Extra environment for every Git call this test thread makes ([`with_test_env`]).
        static TEST_ENV: std::cell::RefCell<Vec<(String, String)>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    /// Applies [`TEST_ENV`] to a Git command built on this thread (`run_git_with` strips
    /// inherited `GIT_*` variables, so a test cannot set them process-wide).
    pub(super) fn apply_test_env(command: &mut Command) {
        TEST_ENV.with(|env| {
            for (key, value) in env.borrow().iter() {
                command.env(key, value);
            }
        });
    }

    /// Runs `body` with `vars` added to every Git call `run_git_with` makes on this thread.
    #[cfg_attr(not(unix), allow(dead_code))] // used by the Unix-only lazy-fetch tests
    fn with_test_env<T>(vars: &[(&str, &str)], body: impl FnOnce() -> T) -> T {
        TEST_ENV.with(|env| *env.borrow_mut() = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect());
        let result = body();
        TEST_ENV.with(|env| env.borrow_mut().clear());
        result
    }

    /// No user or system config for the code under test.
    const NO_GLOBAL: [(&str, &str); 2] = [("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_NOSYSTEM", "1")];

    /// A setup Git command with no user or system config.
    #[cfg_attr(not(unix), allow(dead_code))] // used by the Unix-only lazy-fetch tests
    fn plain_git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// Commits `name` in `dir` and returns the commit id.
    #[cfg_attr(not(unix), allow(dead_code))] // used by the Unix-only lazy-fetch tests
    fn commit_file(dir: &Path, name: &str, text: &str) -> String {
        fs::write(dir.join(name), text).unwrap();
        plain_git(dir, &["add", "--", name]);
        plain_git(dir, &["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-q", "-m", name]);
        plain_git(dir, &["rev-parse", "HEAD"])
    }

    /// Deletes a loose object, as a partial clone that never fetched it would lack it.
    #[cfg_attr(not(unix), allow(dead_code))] // used by the Unix-only lazy-fetch tests
    fn drop_object(dir: &Path, id: &str) {
        let common = plain_git(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        fs::remove_file(Path::new(&common).join("objects").join(&id[..2]).join(&id[2..])).unwrap();
    }

    /// Makes the checkout a partial clone of an ssh remote whose `core.sshCommand` (local
    /// config) touches `marker`: any lazy fetch of a missing object would run it.
    #[cfg_attr(not(unix), allow(dead_code))] // used by the Unix-only lazy-fetch tests
    fn promisor_with_ssh_marker(dir: &Path, marker: &Path) {
        plain_git(dir, &["config", "core.repositoryFormatVersion", "1"]);
        plain_git(dir, &["config", "remote.origin.url", "ssh://example.invalid/never.git"]);
        plain_git(dir, &["config", "remote.origin.promisor", "true"]);
        plain_git(dir, &["config", "extensions.partialClone", "origin"]);
        plain_git(dir, &["config", "core.sshCommand", &format!("touch '{}'; false", marker.display())]);
    }

    /// Round 9: `git.branches` (and `pull.create`'s default base) sorts branches by commit date,
    /// which in a partial clone lazily fetches a missing commit through the checkout's own
    /// `core.sshCommand`. An untrusted phone's call is refused before Git runs.
    #[cfg(unix)]
    #[test]
    fn untrusted_branches_never_lazy_fetch_through_the_checkouts_ssh_command() {
        let f = Fixture::new(true);
        let marker = f.base.join("ssh-ran");
        plain_git(&f.root, &["switch", "-q", "-c", "side"]);
        let side = commit_file(&f.root, "side.txt", "side\n");
        plain_git(&f.root, &["switch", "-q", "main"]);
        drop_object(&f.root, &side);
        promisor_with_ssh_marker(&f.root, &marker);
        let refused = with_test_env(&NO_GLOBAL, || git_branches(&f.root, Trust::phone(false))).unwrap_err();
        assert!(refused.contains("core.sshcommand"), "{refused}");
        assert!(!marker.exists(), "no lazy fetch from the phone");
        // The reproduction: the desktop's own call does fetch (and so runs the command).
        let _ = with_test_env(&NO_GLOBAL, || git_branches(&f.root, Trust::Desktop));
        assert!(marker.exists(), "the setup really triggers a lazy fetch");
    }

    /// Round 9: `worktree.status` reads the worktree's HEAD (status, rev-list, merge-base),
    /// which in a partial clone lazily fetches a missing commit.
    #[cfg(unix)]
    #[test]
    fn untrusted_worktree_status_never_lazy_fetches() {
        let f = Fixture::new(true);
        let marker = f.base.join("ssh-ran");
        let created = create_worktree_with(&f.root, "pandacode/lazy", None, false).unwrap();
        let head = commit_file(&created.path, "lazy.txt", "lazy\n");
        drop_object(&f.root, &head);
        promisor_with_ssh_marker(&f.root, &marker);
        let refused = with_test_env(&NO_GLOBAL, || worktree_status(&f.root, &created.path, None, Trust::phone(false))).unwrap_err();
        assert!(refused.contains("core.sshcommand"), "{refused}");
        assert!(!marker.exists(), "no lazy fetch from the phone");
        let _ = with_test_env(&NO_GLOBAL, || worktree_status(&f.root, &created.path, None, Trust::Desktop));
        assert!(marker.exists(), "the setup really triggers a lazy fetch");
    }

    /// A worktree with a tracked file under a clean filter (local config) that touches `marker`,
    /// its file rewritten unchanged so the next status has to run the filter to compare it.
    #[cfg_attr(not(unix), allow(dead_code))] // used by the Unix-only lazy-fetch tests
    fn filtered_worktree(f: &Fixture, marker: &Path, branch: &str) -> Worktree {
        fs::write(f.root.join(".gitattributes"), "*.txt filter=x\n").unwrap();
        plain_git(&f.root, &["add", ".gitattributes"]);
        commit_file(&f.root, "a.txt", "same\n");
        let created = create_worktree_with(&f.root, branch, None, false).unwrap();
        plain_git(&f.root, &["config", "filter.x.clean", &format!("touch '{}'; cat", marker.display())]);
        std::thread::sleep(Duration::from_millis(20));
        fs::write(created.path.join("a.txt"), "same\n").unwrap();
        created
    }

    /// Round 9: `worktree.status` runs `git status` in the checkout, which runs clean filters;
    /// an untrusted phone's switches them off.
    #[cfg(unix)]
    #[test]
    fn untrusted_worktree_status_switches_clean_filters_off() {
        let f = Fixture::new(true);
        let marker = f.base.join("filter-ran");
        let created = filtered_worktree(&f, &marker, "pandacode/filtered");
        let status = with_test_env(&NO_GLOBAL, || worktree_status(&f.root, &created.path, None, Trust::phone(false))).unwrap();
        assert!(status.exists && status.clean, "{status:?}");
        assert!(!marker.exists(), "no clean filter ran for the phone");
        with_test_env(&NO_GLOBAL, || worktree_status(&f.root, &created.path, None, Trust::Desktop)).unwrap();
        assert!(marker.exists(), "the setup really runs the filter");
    }

    /// Round 9: `worktree.remove` runs a status inside the checkout (clean filters) and
    /// `branch -d` reads commits; an untrusted phone's is refused before either.
    #[cfg(unix)]
    #[test]
    fn untrusted_worktree_remove_refuses_a_filtered_checkout() {
        let f = Fixture::new(true);
        let marker = f.base.join("filter-ran");
        let created = filtered_worktree(&f, &marker, "pandacode/doomed");
        let refused = with_test_env(&NO_GLOBAL, || remove_worktree_for(&f.root, &created.path, None, true, Trust::phone(false))).unwrap_err();
        assert!(refused.contains("filter.x.clean") && refused.contains("Full access"), "{refused}");
        assert!(created.path.exists() && !marker.exists(), "nothing removed, no filter ran");
        let removed = with_test_env(&NO_GLOBAL, || remove_worktree_for(&f.root, &created.path, None, false, Trust::phone(true))).unwrap();
        assert!(removed.removed, "the switch on removes it as the desktop does");
    }

    /// Round 9: only gc's thresholds and expiry times are inert (`gc.recentObjectsHook` is a
    /// shell command), and `core.worktree` is no longer vouched for.
    #[test]
    fn gc_allowlist_is_narrow() {
        for key in ["gc.auto", "gc.autoPackLimit", "gc.autoDetach", "gc.reflogExpire", "gc.pruneExpire", "gc.worktreePruneExpire", "gc.packRefs", "gc.aggressiveDepth", "gc.bigPackThreshold", "gc.logExpiry"] {
            assert!(config_entry_is_inert(key, "1"), "{key}");
        }
        for key in ["gc.recentObjectsHook", "gc.recentobjectshook", "gc.cruftPacks", "gc.x.recentObjectsHook", "core.worktree"] {
            assert!(!config_entry_is_inert(key, "touch /tmp/never"), "{key}");
        }
    }

    /// Round 9: a local `gc.recentObjectsHook` refuses an untrusted commit, and auto
    /// maintenance never runs for one even when the user's own config would gc (and run a
    /// hook) after every commit.
    #[cfg(unix)]
    #[test]
    fn untrusted_commits_never_run_gc_hooks() {
        let f = Fixture::new(true);
        let marker = f.base.join("gc-hook-ran");
        let hook = format!("touch '{}'", marker.display());
        plain_git(&f.root, &["config", "gc.recentObjectsHook", &hook]);
        fs::write(f.root.join("one.txt"), "one\n").unwrap();
        plain_git(&f.root, &["add", "one.txt"]);
        let refused = with_test_env(&NO_GLOBAL, || git_commit(&f.root, "One".into(), Trust::phone(false))).unwrap_err();
        assert!(refused.contains("gc.recentobjectshook"), "{refused}");
        plain_git(&f.root, &["config", "--unset", "gc.recentObjectsHook"]);

        // Enough loose objects in objects/17 for `gc --auto` with gc.auto=1.
        let blobs = f.base.join("blobs");
        fs::create_dir_all(&blobs).unwrap();
        let paths: Vec<String> = (0..2000)
            .map(|n| {
                let path = blobs.join(format!("{n}"));
                fs::write(&path, format!("loose object {n}\n")).unwrap();
                path.display().to_string()
            })
            .collect();
        let mut hash = Command::new("git")
            .arg("-C")
            .arg(&f.root)
            .args(["hash-object", "-w", "--stdin-paths"])
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        std::io::Write::write_all(hash.stdin.as_mut().unwrap(), paths.join("\n").as_bytes()).unwrap();
        drop(hash.stdin.take());
        assert!(hash.wait().unwrap().success());
        let global = f.base.join("global.gitconfig");
        fs::write(
            &global,
            // pruneExpire=now: gc only asks the hook about objects it is about to delete.
            format!("[maintenance]\n\tstrategy = gc\n\tauto = true\n[gc]\n\tauto = 1\n\tautoDetach = false\n\tpruneExpire = now\n\trecentObjectsHook = {hook}\n"),
        )
        .unwrap();
        let global = global.display().to_string();
        let env = [("GIT_CONFIG_GLOBAL", global.as_str()), ("GIT_CONFIG_NOSYSTEM", "1")];
        with_test_env(&env, || git_commit(&f.root, "Phone".into(), Trust::phone(false))).unwrap();
        assert!(!marker.exists(), "no auto gc (and no gc hook) after a phone commit");
        fs::write(f.root.join("two.txt"), "two\n").unwrap();
        plain_git(&f.root, &["add", "two.txt"]);
        with_test_env(&env, || git_commit(&f.root, "Desktop".into(), Trust::Desktop)).unwrap();
        assert!(marker.exists(), "the setup really runs gc and its hook after a desktop commit");
    }

    /// Round 9: the Git a tool like `gh` runs on an untrusted phone's behalf gets the closed
    /// gate's overrides as environment config, which outranks the checkout's own config: no
    /// hook runs, and fsmonitor, `ext::`/`file://` and auto maintenance stay off.
    #[test]
    fn tools_running_git_for_an_untrusted_phone_inherit_the_closed_gate() {
        assert!(tool_git_env(Trust::Desktop).is_empty());
        assert!(tool_git_env(Trust::phone(true)).is_empty());
        let env = tool_git_env(Trust::phone(false));
        for (key, value) in UNTRUSTED_ENV {
            assert!(env.iter().any(|(k, v)| k == key && v == value), "{key}");
        }
        let f = Fixture::new(true);
        let marker = f.base.join("hook-ran");
        let hooks = f.base.join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("post-commit");
        fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let hooks_path = hooks.display().to_string();
        for (key, value) in [("core.hooksPath", hooks_path.as_str()), ("core.fsmonitor", "true"), ("protocol.ext.allow", "always"), ("protocol.file.allow", "always"), ("maintenance.auto", "true"), ("gc.auto", "1")] {
            f.git(&["config", key, value]);
        }
        let git = |args: &[&str], env: &[(String, String)]| {
            let output = Command::new("git").arg("-C").arg(&f.root).args(args).envs(NO_GLOBAL).envs(env.iter().cloned()).output().unwrap();
            assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        for (key, value) in TOOL_GIT_CONFIG {
            assert_eq!(git(&["config", "--get", key], &env), value, "{key}");
        }
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "phone"], &env);
        assert!(!marker.exists(), "no hook for the phone's tool");
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.fsmonitor=false", "commit", "-q", "--allow-empty", "-m", "desktop"], &[]);
        assert!(marker.exists(), "the setup really runs the hook without the overrides");
    }

    /// The non-test part of a source file.
    fn without_tests(source: &str) -> &str {
        source.find("\n#[cfg(test)]\nmod tests {").map_or(source, |end| &source[..end])
    }

    /// The argument text of every `name(` call in `source`.
    fn call_arguments<'a>(source: &'a str, name: &str) -> Vec<&'a str> {
        let mut found = Vec::new();
        let mut from = 0;
        while let Some(at) = source[from..].find(name) {
            let start = from + at + name.len();
            let preceded = source[..from + at].chars().last().is_some_and(|c| c.is_alphanumeric() || c == '_');
            from = start;
            if preceded {
                continue;
            }
            let mut depth = 1;
            let mut end = start;
            for (offset, c) in source[start..].char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => depth -= 1,
                    _ => {}
                }
                if depth == 0 {
                    end = start + offset;
                    break;
                }
            }
            found.push(&source[start..end]);
        }
        found
    }

    /// Workspace Git helpers PandaConnect code may call: each takes a [`Trust`].
    const TRUST_HELPERS: [&str; 18] = [
        "git_status", "git_diff", "git_stage", "git_discard", "git_commit", "git_push", "git_branches", "git_switch", "current_branch", "worktree_status",
        "merge_worktree", "remove_worktree_for", "create_worktree_for", "git_inspect", "refuse_untrusted_programs", "refuse_untrusted_programs_for",
        "git_change", "tool_git_env",
    ];
    /// `lib.rs` helpers the phone's methods call: each takes a [`Trust`] too.
    const LIB_TRUST_HELPERS: [&str; 7] = ["stage_files", "task_branches", "switch_branch", "task_worktree_status", "remove_task_worktree", "merge_task_worktree", "push_and_open_pull"];
    /// Calls PandaConnect code must never make: the untrusted-unaware runners, a raw Git
    /// command, the desktop-only workspace wrappers, and the desktop's own Tauri commands.
    const DESKTOP_ONLY: [&str; 18] = [
        "run_git(", "run_git_bounded(", "run_git_with(", "run_git_inspecting(", "run_git_changing(", "Command::new(\"git\")",
        "workspace::create_worktree_with(", "workspace::remove_worktree(", "workspace::recreate_worktree(",
        "crate::git_status(", "crate::git_diff(", "crate::git_stage(", "crate::git_commit(", "crate::git_push(", "crate::git_branches(",
        "crate::git_switch_branch(", "crate::worktree_status(", "crate::remove_worktree(",
    ];

    /// Round 9: fail closed. Every workspace Git helper a PandaConnect method or the host can
    /// reach takes a `Trust`, every call from `remote/methods`, `remote/host.rs` and
    /// `remote/start.rs` (`task.start` and the team, chat, GitHub and cloud starts built on it)
    /// passes one, and none of them reaches an untrusted-unaware runner or a desktop-only wrapper.
    #[test]
    fn remote_git_calls_always_pass_a_trust() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let workspace = fs::read_to_string(src.join("workspace.rs")).unwrap();
        for helper in TRUST_HELPERS {
            let signature = workspace.find(&format!("fn {helper}(")).unwrap_or_else(|| panic!("{helper} exists"));
            let header = &workspace[signature..signature + workspace[signature..].find('{').unwrap()];
            assert!(header.contains("trust: Trust"), "{helper} takes a Trust: {header}");
        }
        let lib = fs::read_to_string(src.join("lib.rs")).unwrap();
        for helper in LIB_TRUST_HELPERS {
            let signature = lib.find(&format!("fn {helper}(")).unwrap_or_else(|| panic!("{helper} exists"));
            let header = &lib[signature..signature + lib[signature..].find('{').unwrap()];
            assert!(header.contains("trust: workspace::Trust"), "{helper} takes a Trust: {header}");
        }
        let start = fs::read_to_string(src.join("remote/start.rs")).unwrap();
        let start_code = without_tests(&start);
        // The desktop's trust only in `start::git` (the viewer's own checkout, for
        // `remote::mirror`) and the `#[cfg(test)]` wrappers `remote::bench` uses.
        let desktop = start_code.matches("Trust::Desktop").count();
        let test_wrappers = start_code.matches("#[cfg(test)]\npub(crate) fn").count();
        assert_eq!(desktop, 1 + test_wrappers, "remote/start.rs uses the desktop's trust outside start::git");
        assert!(start_code.contains("pub(crate) fn git(root: &Path, args: &[&str], timeout: Duration) -> Result<String> {\n    git_as(root, args, timeout, workspace::Trust::Desktop)"));
        let mut files = vec![src.join("remote/host.rs"), src.join("remote/start.rs")];
        for entry in fs::read_dir(src.join("remote/methods")).unwrap() {
            files.push(entry.unwrap().path());
        }
        let mut checked_calls = 0;
        for file in files {
            let text = fs::read_to_string(&file).unwrap();
            let code = without_tests(&text);
            let name = file.display().to_string();
            for forbidden in DESKTOP_ONLY {
                assert!(!code.contains(forbidden), "{name} calls {forbidden}");
            }
            for helper in TRUST_HELPERS {
                for args in call_arguments(code, &format!("workspace::{helper}(")) {
                    assert!(args.to_ascii_lowercase().contains("trust"), "{name}: workspace::{helper}({args}) passes no Trust");
                    checked_calls += 1;
                }
            }
            for helper in LIB_TRUST_HELPERS {
                for args in call_arguments(code, &format!("crate::{helper}(")) {
                    assert!(args.to_ascii_lowercase().contains("trust"), "{name}: crate::{helper}({args}) passes no Trust");
                    checked_calls += 1;
                }
            }
        }
        assert!(checked_calls >= 15, "the scan found the phone's Git calls ({checked_calls})");
    }
}
