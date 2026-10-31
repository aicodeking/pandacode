//! `task.start` on the host: use a local project or find (or clone) a GitHub repository,
//! check out the viewer's branch, then start an ordinary task there.
use super::host::{name_param, text_param};
use crate::{github_hub, storage::Project, workspace, AppState, Result};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

/// Worst case for a start: clone 6 min + a fetch (an existing project) or the checkout a
/// worktree start defers (a fresh clone) 90 s + 8 local git steps of 15 s ≈ 9.5 min.
/// The viewer waits longer ([`super::mirror`]'s `START_TIMEOUT`).
const CLONE: Duration = Duration::from_secs(6 * 60);
const FETCH: Duration = Duration::from_secs(90);
const CHECKOUT: Duration = Duration::from_secs(90);
const GIT: Duration = Duration::from_secs(15);
pub(crate) const WORST_CASE: Duration = Duration::from_secs(6 * 60 + 90 + 8 * 15);
/// Clones land in `~/PandaCode/<name>`.
const CLONE_FOLDER: &str = "PandaCode";
/// The stages a host reports to the viewer while it readies a start (`task.progress`),
/// in order, then `error` when it fails. The viewer adds its own `connecting` first.
pub(crate) const STAGES: [&str; 5] = ["finding", "downloading", "preparing", "starting", "error"];
/// Percent updates within one stage are sent at most this often (stage changes at once).
const PROGRESS_EVERY: Duration = Duration::from_millis(400);
const PROGRESS_EVENT: &str = "task.progress";
/// The error of a start the viewer cancelled (`task.cancelStart`); no `error` stage is sent for it.
pub(crate) const CANCELLED: &str = "Start cancelled.";

/// A start's cancel switch: `task.cancelStart` flips it only until the start commits to
/// making its task; after that it is too late, and the caller links and stops the task instead.
#[derive(Default)]
pub(crate) struct Cancel(AtomicU8);

const OPEN: u8 = 0;
const STOPPED: u8 = 1;
const COMMITTED: u8 = 2;

impl Cancel {
    pub(crate) fn is_set(&self) -> bool {
        self.0.load(Ordering::SeqCst) == STOPPED
    }

    /// Cancels the start unless it already committed; whether it is cancelled now.
    pub(crate) fn cancel(&self) -> bool {
        matches!(self.0.compare_exchange(OPEN, STOPPED, Ordering::SeqCst, Ordering::SeqCst), Ok(_) | Err(STOPPED))
    }

    /// Past this, a cancel is refused; fails if one came first.
    pub(crate) fn commit(&self) -> Result<()> {
        match self.0.compare_exchange(OPEN, COMMITTED, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) | Err(COMMITTED) => Ok(()),
            Err(_) => Err(CANCELLED.into()),
        }
    }
}

fn check(cancel: &Cancel) -> Result<()> {
    if cancel.is_set() {
        return Err(CANCELLED.into());
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
pub(crate) struct Start {
    /// The viewer's id for this start, echoed in its progress events.
    pub start_id: Option<String>,
    pub target: Target,
    pub branch: Option<String>,
    pub worktree: bool,
    pub prompt: String,
    pub provider: String,
    pub model: String,
    pub mode: Option<String>,
    pub effort: Option<String>,
    /// Images the viewer sent with `image.put` for the first prompt.
    pub image_ids: Vec<String>,
}

#[derive(Debug, PartialEq)]
pub(crate) enum Target {
    Repo(String),
    ProjectId(String),
}

pub(crate) fn parse(params: &Value) -> Result<Start> {
    let repo = params.get("repo").filter(|value| !value.is_null());
    let project_id = params.get("projectId").filter(|value| !value.is_null());
    let target = match (repo, project_id) {
        (Some(_), Some(_)) => return Err("Send either repo or projectId, not both.".into()),
        (Some(repo), None) => Target::Repo(github_hub::valid_repo(repo.as_str().ok_or("Invalid repo.")?)?),
        (None, Some(_)) => Target::ProjectId(super::host::id_param(params, "projectId")?),
        (None, None) => return Err("Missing repo or projectId.".into()),
    };
    let branch = name_param(params, "branch")?;
    if let Some(branch) = &branch {
        valid_branch(branch)?;
    }
    Ok(Start {
        start_id: name_param(params, "startId")?,
        target,
        branch,
        worktree: params["worktree"].as_bool().unwrap_or(false),
        prompt: text_param(params, "prompt")?,
        provider: name_param(params, "provider")?.ok_or("Missing provider.")?,
        model: name_param(params, "model")?.ok_or("Missing model.")?,
        mode: name_param(params, "mode")?,
        effort: name_param(params, "effort")?,
        image_ids: super::images::ids_param(params)?,
    })
}

/// A branch name git accepts that can never be read as an option.
fn valid_branch(branch: &str) -> Result<()> {
    if branch.starts_with('-') || branch.contains("..") || branch.ends_with('/') || branch.ends_with(".lock") || !branch.chars().all(|c| c.is_ascii_alphanumeric() || "/-_.".contains(c)) {
        return Err("Invalid branch.".into());
    }
    Ok(())
}

/// The first project whose origin is `repo` (GitHub names ignore case).
pub(crate) fn find_project(projects: Vec<(Project, Option<String>)>, repo: &str) -> Option<Project> {
    projects.into_iter().find(|(_, origin)| origin.as_deref().is_some_and(|origin| origin.eq_ignore_ascii_case(repo))).map(|(project, _)| project)
}

/// The repository's own config file, where `remote.origin.url` lives: `.git/config`, or the
/// common directory's for a linked worktree.
fn config_path(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git.join("config"));
    }
    let gitdir = root.join(std::fs::read_to_string(&dot_git).ok()?.trim().strip_prefix("gitdir:")?.trim());
    Some(match std::fs::read_to_string(gitdir.join("commondir")) {
        Ok(common) => gitdir.join(common.trim()).join("config"),
        Err(_) => gitdir.join("config"),
    })
}

/// `remote.origin.url` from the text of a git config, as the GitHub repository it names.
/// The outer None means this file can't answer the way `git config --get` would (an include,
/// a quoted or escaped value, an unusual header), so ask git.
fn config_repo(config: &str) -> Option<Option<String>> {
    let (mut inside, mut url) = (false, None);
    for line in config.lines().map(str::trim) {
        if let Some(header) = line.strip_prefix('[') {
            let (name, rest) = header.split_once(']')?;
            if !(rest.trim().is_empty() || rest.trim().starts_with(['#', ';'])) {
                return None;
            }
            let name = name.trim();
            let lowered = name.to_ascii_lowercase();
            if lowered.starts_with("include") || lowered.starts_with("remote.") {
                return None;
            }
            inside = name.split_once(char::is_whitespace).is_some_and(|(section, subsection)| section.eq_ignore_ascii_case("remote") && subsection.trim() == "\"origin\"");
        } else if inside {
            if let Some((_, value)) = line.split_once('=').filter(|(key, _)| key.trim().eq_ignore_ascii_case("url")) {
                let value = value.trim();
                if value.contains(['"', '\\', '#', ';']) {
                    return None;
                }
                url = Some(value.to_owned());
            }
        }
    }
    Some(url.and_then(|url| github_hub::repo_from_remote(&url)))
}

/// Each project's GitHub repository. The origin comes from the config file, which takes
/// microseconds; only a project whose config is out of the ordinary costs a git process, and
/// those run side by side.
pub(crate) fn origins(projects: Vec<Project>) -> Vec<(Project, Option<String>)> {
    let direct: Vec<_> = projects.iter().map(|project| config_path(Path::new(&project.path)).and_then(|path| std::fs::read_to_string(path).ok()).and_then(|config| config_repo(&config))).collect();
    let found: Vec<Option<String>> = std::thread::scope(|scope| {
        let asked: Vec<_> = projects.iter().zip(&direct).map(|(project, direct)| direct.is_none().then(|| scope.spawn(|| github_hub::project_repo(Path::new(&project.path))))).collect();
        direct.iter().zip(asked).map(|(direct, asked)| direct.clone().unwrap_or_else(|| asked.and_then(|handle| handle.join().ok()).flatten())).collect()
    });
    projects.into_iter().zip(found).collect()
}

fn find_project_id(projects: Vec<Project>, id: &str) -> Option<Project> {
    projects.into_iter().find(|project| project.id == id)
}

/// `<home>/PandaCode/<name>`, or `<name>-2`, `-3`… when taken.
pub(crate) fn clone_path(home: &Path, repo: &str, taken: impl Fn(&Path) -> bool) -> PathBuf {
    let name = repo.rsplit('/').next().unwrap_or(repo);
    let parent = home.join(CLONE_FOLDER);
    (1..).map(|n| parent.join(if n == 1 { name.to_owned() } else { format!("{name}-{n}") })).find(|path| !taken(path)).expect("an unused name")
}

pub(crate) fn git(root: &Path, args: &[&str], timeout: Duration) -> Result<String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(root).args(args);
    let output = workspace::checked(workspace::run_process(command, "Git", 64 * 1024, timeout)?)?;
    Ok(String::from_utf8_lossy(&output.bytes).trim().to_owned())
}

fn on_origin(root: &Path, branch: &str) -> bool {
    git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{branch}")], GIT).is_ok()
}

/// One `git clone --progress` line as overall clone progress: receiving is 0–80 %,
/// resolving deltas 80–95 %, checking out files 95–100 %. Other lines are None.
pub(crate) fn clone_percent(line: &str) -> Option<u8> {
    let (phase, rest) = line.trim().split_once(':')?;
    let percent: u32 = rest.split_once('%')?.0.trim().parse().ok()?;
    let (from, span) = match phase {
        "Receiving objects" => (0, 80),
        "Resolving deltas" => (80, 15),
        "Updating files" => (95, 5),
        _ => return None,
    };
    Some((from + span * percent.min(100) / 100) as u8)
}

/// Whether a `gh repo clone` stderr line is progress chatter rather than an error.
fn progress_line(line: &str) -> bool {
    let line = line.trim();
    line.is_empty() || line.starts_with("Cloning into") || line.contains('%') || line.ends_with(", done.")
}

/// Reads git's progress from `stderr` (lines end in `\r` or `\n`), sending each new
/// percent, and returns the last few other lines for an error message.
fn read_progress(mut stderr: impl Read, percents: mpsc::Sender<u8>) -> String {
    let (mut buffer, mut line, mut tail, mut last) = ([0u8; 4096], Vec::new(), Vec::<String>::new(), None);
    let mut take = |line: &mut Vec<u8>, tail: &mut Vec<String>| {
        let text = String::from_utf8_lossy(line).trim().to_owned();
        line.clear();
        if let Some(percent) = clone_percent(&text) {
            if last != Some(percent) {
                last = Some(percent);
                let _ = percents.send(percent);
            }
        } else if !progress_line(&text) {
            tail.push(text.chars().take(300).collect());
            if tail.len() > 4 {
                tail.remove(0);
            }
        }
    };
    while let Ok(read) = stderr.read(&mut buffer) {
        if read == 0 {
            break;
        }
        for &byte in &buffer[..read] {
            if byte == b'\r' || byte == b'\n' {
                take(&mut line, &mut tail);
            } else if line.len() < 4096 {
                line.push(byte);
            }
        }
    }
    take(&mut line, &mut tail);
    tail.join("\n")
}

fn stop_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    // The clone owns a fresh process group, so this stops the git that gh runs too.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill.exe").creation_flags(0x08000000).args(["/PID", &child.id().to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// `gh repo clone` like [`github_hub::clone_to`], with git's `--progress` read as it
/// arrives so the viewer sees a percentage. Same timeout, stops the whole group. With
/// `lazy` the clone leaves the working tree empty (`--no-checkout`) for the caller to fill.
fn clone_with_progress(repo: &str, destination: &Path, timeout: Duration, lazy: bool, cancel: &Cancel, progress: impl FnMut(u8)) -> Result<()> {
    let repo = github_hub::valid_repo(repo)?;
    let parent = destination.parent().filter(|parent| parent.is_dir()).ok_or("Choose an existing folder to clone into.")?;
    let mut command = Command::new(crate::providers::tool_path("gh").unwrap_or_else(|| "gh".into()));
    command.current_dir(parent).args(["repo", "clone", &repo]).arg(destination).args(["--", "--progress"]);
    if lazy {
        command.arg("--no-checkout");
    }
    if let Ok(path) = crate::providers::executable_path() {
        command.env("PATH", path);
    }
    command.env("GH_PROMPT_DISABLED", "1").env("GH_NO_UPDATE_NOTIFIER", "1").env("GH_PAGER", "cat").env("NO_COLOR", "1").env("CLICOLOR", "0").env("GIT_TERMINAL_PROMPT", "0");
    crate::child_env::sanitize(&mut command);
    supervise(command, &repo, destination, timeout, cancel, progress)
}

/// Runs a clone `command` in its own process group, relaying its progress. A timeout or
/// `cancel` kills the group within 100 ms and removes the half-made `destination` (only when
/// it did not exist before).
fn supervise(mut command: Command, repo: &str, destination: &Path, timeout: Duration, cancel: &Cancel, mut progress: impl FnMut(u8)) -> Result<()> {
    check(cancel)?;
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x08000000);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    let existed = destination.exists();
    let mut child = command.spawn().map_err(|e| format!("Could not run the GitHub CLI: {e}"))?;
    let stderr = child.stderr.take().ok_or("Could not read the GitHub CLI.")?;
    let (sender, percents) = mpsc::channel();
    let reader = std::thread::spawn(move || read_progress(stderr, sender));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match percents.recv_timeout(Duration::from_millis(100)) {
            Ok(percent) => progress(percent),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            // The reader is done, so stderr closed: the clone is ending.
            Err(mpsc::RecvTimeoutError::Disconnected) => std::thread::sleep(Duration::from_millis(50)),
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        let stopped = if cancel.is_set() {
            Some(CANCELLED.to_owned())
        } else if Instant::now() >= deadline {
            Some(format!("Cloning {repo} took longer than {} minutes.", timeout.as_secs() / 60))
        } else {
            None
        };
        if let Some(reason) = stopped {
            stop_group(&mut child);
            let _ = reader.join();
            if !existed {
                let _ = std::fs::remove_dir_all(destination);
            }
            return Err(reason);
        }
    };
    let tail = reader.join().unwrap_or_default();
    percents.try_iter().for_each(&mut progress);
    if status.success() {
        return Ok(());
    }
    Err(if tail.is_empty() { format!("Could not clone {repo}.") } else { tail })
}

/// Whether a progress update is worth a frame: a new stage always, a new percent at most
/// every [`PROGRESS_EVERY`] (100 % always).
fn due(last: Option<&(String, Option<u8>, Instant)>, stage: &str, percent: Option<u8>, now: Instant) -> bool {
    match last {
        None => true,
        Some((old, _, _)) if old != stage => true,
        Some((_, old, _)) if *old == percent => false,
        Some((_, _, at)) => percent == Some(100) || now.duration_since(*at) >= PROGRESS_EVERY,
    }
}

/// Reports a start's stages to the viewer that asked for it, best effort: a lost frame
/// only leaves the viewer on the previous stage.
struct Progress {
    app: tauri::AppHandle,
    to: String,
    start: Option<String>,
    repo: String,
    last: Mutex<Option<(String, Option<u8>, Instant)>>,
}

impl Progress {
    fn report(&self, stage: &str, percent: Option<u8>, detail: Option<&str>) {
        let now = Instant::now();
        {
            let Ok(mut last) = self.last.lock() else { return };
            if !due(last.as_ref(), stage, percent, now) {
                return;
            }
            *last = Some((stage.to_owned(), percent, now));
        }
        let data = json!({"startId": self.start, "repo": self.repo, "stage": stage, "percent": percent, "detail": detail.map(|d| d.chars().take(300).collect::<String>())});
        let _ = super::socket::send_to_device(&self.app, &self.to, &json!({"type": "event", "name": PROGRESS_EVENT, "data": data}));
    }
}

/// A host's `task.progress` as the window's `remote://start-progress` payload, or None
/// when it is malformed. Only a host trusted here may send one (socket.rs checks).
pub(crate) fn progress_payload(from: &str, data: &Value) -> Option<Value> {
    let stage = data["stage"].as_str().filter(|stage| STAGES.contains(stage))?;
    let percent = data["percent"].as_u64().filter(|percent| *percent <= 100);
    let start = data["startId"].as_str().filter(|id| super::host::valid_id(id).is_ok());
    let repo = data["repo"].as_str().and_then(|repo| github_hub::valid_repo(repo).ok());
    let detail = data["detail"].as_str().filter(|_| stage == "error" || stage == "starting").map(|detail| detail.chars().take(300).collect::<String>());
    Some(json!({"deviceId": from, "startId": start, "repo": repo, "stage": stage, "percent": percent, "detail": detail}))
}

/// `task.progress` from a trusted host, on the viewer: shown by `src/remote-progress.ts`.
pub(crate) fn progress(app: &tauri::AppHandle, from: &str, data: &Value) {
    use tauri::Emitter;
    if let Some(payload) = progress_payload(from, data) {
        let _ = app.emit("remote://start-progress", payload);
    }
}

/// The project checking out `repo`, cloned into `~/PandaCode` when there is none (with an
/// empty working tree when `lazy`), and whether it was cloned just now.
fn project_for(state: &AppState, target: &Target, progress: &Progress, lazy: bool, cancel: &Cancel) -> Result<(Project, bool)> {
    let (projects, bot_projects) = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        (store.projects()?, crate::bots::project_ids(&store)?)
    };
    match target {
        Target::ProjectId(id) => {
            if bot_projects.iter().any(|bot_project| bot_project == id) {
                return Err("Bot workspaces cannot be used for remote tasks.".into());
            }
            find_project_id(projects, id).map(|project| (project, false)).ok_or_else(|| "Project not found.".into())
        }
        Target::Repo(repo) => {
            if let Some(project) = find_project(origins(projects), repo) {
                return Ok((project, false));
            }
            let home = crate::agent_usage_providers::home().ok_or("This computer has no home folder to clone into.")?;
            let destination = clone_path(&home, repo, Path::exists);
            std::fs::create_dir_all(home.join(CLONE_FOLDER)).map_err(|e| e.to_string())?;
            progress.report("downloading", None, None);
            clone_with_progress(repo, &destination, CLONE, lazy, cancel, |percent| progress.report("downloading", Some(percent), None))?;
            Ok((state.store.lock().map_err(|e| e.to_string())?.add_project(&destination)?, true))
        }
    }
}

/// Picks the viewer's branch when origin has it, else the default branch. An existing
/// checkout fetches first (`fetch`); a clone made a moment ago already has origin's refs.
pub(crate) fn pick_branch(root: &Path, wanted: Option<&str>, fetch: bool) -> Result<String> {
    if fetch {
        git(root, &["fetch", "--quiet", "origin"], FETCH).map_err(|e| format!("Could not fetch from GitHub: {e}"))?;
    }
    if let Some(branch) = wanted.filter(|branch| on_origin(root, branch)) {
        return Ok(branch.to_owned());
    }
    let head = git(root, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], GIT).unwrap_or_default();
    head.strip_prefix("origin/").map(str::to_owned).filter(|branch| valid_branch(branch).is_ok()).ok_or_else(|| "Could not find the repository's default branch.".into())
}

/// Why the main checkout can't take a remote task in place, if it can't. Only a clean,
/// idle checkout already on the requested branch runs one; any other gets a worktree.
pub(crate) fn in_place_refusal(host: &str, project: &str, current: &str, branch: &str, dirty: bool, busy: bool) -> Option<String> {
    let problem = if busy {
        format!("{host} has an agent working in {project}.")
    } else if dirty {
        format!("{host} has uncommitted changes in {project}.")
    } else if current != branch {
        let current = if current.is_empty() { "a detached HEAD" } else { current };
        format!("{host} has {project} on {current}, not {branch}.")
    } else {
        return None;
    };
    Some(problem)
}

/// Readies the main checkout for a task in place, fast-forwarded to origin when it can, or
/// returns why it can't (busy, dirty or on another branch) without touching it.
fn ready_in_place(root: &Path, project: &str, branch: &str, busy: bool) -> Result<Option<String>> {
    let current = git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"], GIT).unwrap_or_default();
    let dirty = !git(root, &["status", "--porcelain"], GIT)?.is_empty();
    if let Some(refusal) = in_place_refusal(&super::config::device_name(), project, &current, branch, dirty, busy) {
        return Ok(Some(refusal));
    }
    // A local branch that diverged keeps its own commits; the agent starts from them.
    let _ = git(root, &["merge", "--ff-only", "--quiet", &format!("origin/{branch}")], GIT);
    Ok(None)
}

/// The note a start that fell back from the main checkout to a worktree reports.
fn worktree_note(reason: &str) -> String {
    format!("Started in a worktree: {reason}")
}

/// Projects whose main checkout a remote start has claimed and not yet launched in.
static IN_PLACE: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// A remote start's claim on a project's main checkout, from the busy check until its agent
/// is registered (then [`busy_in_place`] sees the agent itself); dropping it releases it.
pub(crate) struct Reservation(String);

impl Drop for Reservation {
    fn drop(&mut self) {
        if let Ok(mut held) = IN_PLACE.lock() {
            held.retain(|id| *id != self.0);
        }
    }
}

/// Claims the project's main checkout unless `busy` (a local agent there) or another remote
/// start holds it, so two starts never both decide it is free.
fn reserve_in_place(project_id: &str, busy: impl FnOnce() -> Result<bool>) -> Result<Option<Reservation>> {
    let mut held = IN_PLACE.lock().map_err(|e| e.to_string())?;
    if held.iter().any(|id| id == project_id) || busy()? {
        return Ok(None);
    }
    held.push(project_id.to_owned());
    Ok(Some(Reservation(project_id.to_owned())))
}

/// Whether a local agent is running in the project's main checkout.
fn busy_in_place(state: &AppState, project_id: &str) -> Result<bool> {
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    let store = state.store.lock().map_err(|e| e.to_string())?;
    Ok(agents.keys().any(|id| store.session(id).is_ok_and(|task| task.project_id == project_id && task.worktree_path.is_none())))
}

/// Puts a fresh clone's checkout on `branch`; nobody's work is there yet. A clone starts on
/// origin's default branch at origin's commit, so that branch needs no switch and no merge,
/// and any other is made from origin's ref.
pub(crate) fn checkout(root: &Path, branch: &str) -> Result<()> {
    if git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"], GIT).is_ok_and(|current| current == branch) {
        return Ok(());
    }
    let local = git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], GIT).is_ok();
    let switched = if local { git(root, &["switch", branch], GIT) } else { git(root, &["switch", "--track", "-c", branch, &format!("origin/{branch}")], GIT) };
    switched.map(drop).map_err(|e| format!("Could not check out {branch}: {e}"))
}

/// Fills the working tree of a clone made with `--no-checkout` from its HEAD.
fn restore_checkout(root: &Path) -> Result<()> {
    git(root, &["reset", "--hard", "--quiet"], CHECKOUT).map(drop).map_err(|e| format!("Could not check out the repository: {e}"))
}

fn remote_worktree(root: &Path, branch: &str) -> Result<workspace::Worktree> {
    let name = format!("pandacode/remote-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    workspace::create_worktree_with(root, &name, Some(&format!("origin/{branch}")), false)
}

/// A worktree for a task on a `--no-checkout` clone, made while the clone's own working tree
/// is filled in: two separate checkouts in parallel, each with its own index, instead of one
/// after the other. Both finish before this returns, so the project is never left empty.
pub(crate) fn worktree_while_restoring(root: &Path, branch: &str) -> Result<workspace::Worktree> {
    std::thread::scope(|scope| {
        let main = scope.spawn(|| restore_checkout(root));
        let made = remote_worktree(root, branch);
        let restored = main.join().unwrap_or_else(|_| Err("Could not check out the repository.".into()));
        match (made, restored) {
            (Ok(made), Ok(())) => Ok(made),
            (made, restored) => {
                if let Ok(made) = &made {
                    discard(root, made);
                }
                Err(restored.err().or(made.err()).unwrap_or_default())
            }
        }
    })
}

/// Removes a worktree made for a start that did not go on, best effort.
fn discard(root: &Path, made: &workspace::Worktree) {
    let _ = workspace::remove_worktree(root, &made.path, Some(&made.branch), true);
}

/// The refusal for a harness `host` doesn't have, naming it as the app does when it knows it.
fn not_installed(provider: &str, host: &str, installed: bool) -> Result<()> {
    if installed {
        return Ok(());
    }
    let name = crate::providers::PROVIDERS.iter().find(|(id, _)| *id == provider).map_or(provider, |(_, name)| name);
    Err(format!("{name} is not installed on {host}."))
}

/// Refuses a harness this computer doesn't have. Only that harness is looked up, in the
/// folders the app searches; `providers::discover` would also run `--version` on all of them
/// (2-4 s) just to read a list this check ignores.
pub(crate) async fn require_installed(provider: &str) -> Result<()> {
    let id = provider.to_owned();
    let installed = tauri::async_runtime::spawn_blocking(move || crate::providers::PROVIDERS.iter().any(|(known, _)| *known == id) && crate::providers::executable(&id).is_some()).await.map_err(|e| e.to_string())?;
    not_installed(provider, &super::config::device_name(), installed)
}

/// Starts the task, reporting each stage to the viewer, and the failure as `error`.
pub(crate) async fn run(app: &tauri::AppHandle, from: &str, start: Start) -> Result<Value> {
    run_cancellable(app, from, start, Arc::default()).await
}

/// [`run`] that stops when `cancel` is set: it is checked between stages, and a running clone
/// is killed and its folder removed. Once the task exists it is too late to cancel. A cancelled
/// start fails with [`CANCELLED`] and sends no `error` stage; the canceller answers the viewer.
pub(crate) async fn run_cancellable(app: &tauri::AppHandle, from: &str, start: Start, cancel: Arc<Cancel>) -> Result<Value> {
    let progress = Arc::new(Progress { app: app.clone(), to: from.to_owned(), start: start.start_id.clone(), repo: match &start.target { Target::Repo(repo) => repo.clone(), Target::ProjectId(_) => String::new() }, last: Mutex::new(None) });
    let result = start_task(app, from, start, &progress, &cancel).await;
    if let Some(error) = result.as_ref().err().filter(|error| *error != CANCELLED) {
        progress.report("error", None, Some(error));
    }
    result
}

/// The checkout a start works in once the project is found or cloned: the branch to use, the
/// worktree made along the way (a worktree start on a fresh clone, or an in-place start whose
/// main checkout is busy, dirty or elsewhere), and the note saying why it fell back.
fn prepare(state: &AppState, project: &Project, cloned: bool, worktree: bool, wanted: Option<&str>, progress: &Progress, cancel: &Cancel) -> Result<Prepared> {
    check(cancel)?;
    progress.report("preparing", None, None);
    let root = PathBuf::from(&project.path);
    let branch = pick_branch(&root, wanted, !cloned)?;
    check(cancel)?;
    let made = match (worktree, cloned) {
        (true, true) => Some(worktree_while_restoring(&root, &branch)?),
        (false, true) => {
            checkout(&root, &branch)?;
            None
        }
        (false, false) => {
            let reserved = reserve_in_place(&project.id, || busy_in_place(state, &project.id))?;
            if let Some(reason) = ready_in_place(&root, &project.name, &branch, reserved.is_none())? {
                let made = remote_worktree(&root, &branch)?;
                return Ok((branch, Some(made), Some(worktree_note(&reason)), None));
            }
            return Ok((branch, None, None, reserved));
        }
        (true, false) => None,
    };
    Ok((branch, made, None, None))
}

/// The branch, any worktree already made, a fallback note, and the main checkout's
/// reservation for an in-place start (see [`prepare`]).
type Prepared = (String, Option<workspace::Worktree>, Option<String>, Option<Reservation>);

/// A worktree made for a start, removed when dropped unless [`Made::keep`] took it: every
/// failure, panic or cancel between making it and the task owning it cleans it up.
struct Made(PathBuf, Option<workspace::Worktree>);

impl Made {
    fn keep(mut self) -> Option<workspace::Worktree> {
        self.1.take()
    }
}

impl Drop for Made {
    fn drop(&mut self) {
        if let Some(made) = &self.1 {
            discard(&self.0, made);
        }
    }
}

/// Gives task `id` its worktree: `made`, or a new one on `branch`. A worktree made here or
/// handed in is removed again if the task can't take it.
fn attach(store: &Mutex<crate::storage::Store>, root: &Path, branch: &str, made: Option<workspace::Worktree>, id: &str) -> Result<workspace::Worktree> {
    let made = Made(root.to_owned(), Some(made.map_or_else(|| remote_worktree(root, branch), Ok)?));
    let checkout = made.1.as_ref().expect("just made");
    store.lock().map_err(|e| e.to_string())?.attach_worktree(id, &checkout.path, &checkout.branch)?;
    Ok(made.keep().expect("just made"))
}

async fn start_task(app: &tauri::AppHandle, from: &str, start: Start, progress: &Arc<Progress>, cancel: &Arc<Cancel>) -> Result<Value> {
    check(cancel)?;
    progress.report("finding", None, None);
    // Before any clone: the images must be ones this caller just sent.
    super::images::claim(app, from, &start.image_ids)?;
    require_installed(&start.provider).await?;
    check(cancel)?;
    let handle = app.clone();
    let (target, wanted, worktree, reporter, flag) = (start.target, start.branch.clone(), start.worktree, progress.clone(), cancel.clone());
    let (project, (branch, made, mut note, reserved)) = tauri::async_runtime::spawn_blocking(move || -> Result<(Project, Prepared)> {
        let state = handle.state::<AppState>();
        // A worktree start never uses the clone's own checkout, so a fresh clone defers it.
        let (project, cloned) = project_for(&state, &target, &reporter, worktree, &flag)?;
        let prepared = prepare(&state, &project, cloned, worktree, wanted.as_deref(), &reporter, &flag);
        if cloned && worktree && prepared.is_err() {
            let _ = restore_checkout(Path::new(&project.path));
        }
        prepared.map(|prepared| (project, prepared))
    })
    .await
    .map_err(|e| e.to_string())??;
    let root = PathBuf::from(&project.path);
    let made = Made(root.clone(), made);
    // From here the task is made, so a cancel arriving now is answered "too late".
    cancel.commit()?;
    let state = app.state::<AppState>();
    let created = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        crate::architect::profiles::create_user_task(&store, &project.id, &start.provider, &start.model, start.mode.as_deref(), None).and_then(|task| {
            if start.effort.is_some() {
                store.set_reasoning_effort(&task.id, start.effort.as_deref())?;
            }
            Ok(task)
        })
    };
    let task = created?;
    // A local run may have started in the main checkout since the reservation was taken.
    // ponytail: local runs don't consult the reservation, so a run starting between this check
    // and `send_message` registering the agent still shares it; gate local admission if it bites.
    if reserved.is_some() && busy_in_place(&state, &project.id).unwrap_or(true) {
        note = Some(worktree_note(&in_place_refusal(&super::config::device_name(), &project.name, "", "", false, true).unwrap_or_default()));
    }
    let worktree = worktree || made.1.is_some() || note.is_some();
    if worktree {
        let store = state.store.clone();
        let id = task.id.clone();
        let made = made.keep();
        let attached = tauri::async_runtime::spawn_blocking(move || attach(&store, &root, &branch, made, &id)).await.map_err(|e| e.to_string()).and_then(|attached| attached);
        if let Err(error) = attached {
            let _ = crate::task_deletion::delete_state(&state, &task.id);
            return Err(error);
        }
    }
    progress.report("starting", None, note.as_deref());
    // The caller mirrors the task from its first event.
    super::host::follow(app, from, &task.id);
    crate::send_message(app.clone(), state, task.id.clone(), start.prompt, Some(start.image_ids), None).await?;
    use tauri::Emitter;
    let _ = app.emit("sessions-changed", ());
    Ok(match note {
        Some(note) => json!({"sessionId": task.id, "worktree": true, "note": note}),
        None => json!({"sessionId": task.id}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: &str) -> Project {
        Project { id: id.into(), name: id.into(), path: format!("/p/{id}"), added_order: 0 }
    }

    #[test]
    fn a_project_is_found_by_its_origin() {
        let projects = vec![(project("a"), None), (project("b"), Some("orbit-labs/other".into())), (project("c"), Some("Orbit-Labs/Orbit".into()))];
        assert_eq!(find_project(projects.clone(), "orbit-labs/orbit").map(|p| p.id), Some("c".into()));
        assert!(find_project(projects, "orbit-labs/missing").is_none());
    }

    #[test]
    fn a_project_id_selects_its_registered_project() {
        let projects = vec![project("a"), project("b")];
        assert_eq!(find_project_id(projects.clone(), "b").map(|p| p.id), Some("b".into()));
        assert!(find_project_id(projects, "missing").is_none());
    }

    #[test]
    fn clones_take_the_first_free_folder() {
        let home = Path::new("/Users/me");
        assert_eq!(clone_path(home, "orbit-labs/orbit", |_| false), PathBuf::from("/Users/me/PandaCode/orbit"));
        let taken = [PathBuf::from("/Users/me/PandaCode/orbit"), PathBuf::from("/Users/me/PandaCode/orbit-2")];
        assert_eq!(clone_path(home, "orbit-labs/orbit", |path| taken.iter().any(|t| t == path)), PathBuf::from("/Users/me/PandaCode/orbit-3"));
    }

    #[test]
    fn only_a_clean_idle_checkout_on_the_branch_runs_in_place() {
        assert_eq!(in_place_refusal("Studio", "orbit", "main", "main", false, false), None);
        assert_eq!(in_place_refusal("Studio", "orbit", "main", "main", true, false).unwrap(), "Studio has uncommitted changes in orbit.");
        assert_eq!(in_place_refusal("Studio", "orbit", "dev", "main", false, false).unwrap(), "Studio has orbit on dev, not main.");
        assert_eq!(in_place_refusal("Studio", "orbit", "", "main", false, false).unwrap(), "Studio has orbit on a detached HEAD, not main.");
        assert_eq!(in_place_refusal("Studio", "orbit", "main", "main", true, true).unwrap(), "Studio has an agent working in orbit.");
        assert_eq!(worktree_note("Studio has an agent working in orbit."), "Started in a worktree: Studio has an agent working in orbit.");
        assert!(WORST_CASE <= Duration::from_secs(10 * 60));
    }

    #[test]
    fn start_requests_are_validated() {
        let ok = json!({"repo": "orbit-labs/orbit", "branch": "feature/x", "worktree": true, "prompt": " go ", "provider": "claude", "model": "sonnet", "effort": "high"});
        let start = parse(&ok).unwrap();
        assert_eq!(start.start_id, None);
        let mut with_id = ok.clone();
        with_id["startId"] = json!("3f2a-local");
        assert_eq!(parse(&with_id).unwrap().start_id.as_deref(), Some("3f2a-local"));
        with_id["startId"] = json!("has space");
        assert!(parse(&with_id).is_err());
        assert_eq!((start.target, start.branch.as_deref(), start.worktree, start.prompt.as_str(), start.mode), (Target::Repo("orbit-labs/orbit".into()), Some("feature/x"), true, "go", None));
        assert!(start.image_ids.is_empty());
        let image = uuid::Uuid::new_v4().to_string();
        let mut with_image = ok.clone();
        with_image["imageIds"] = json!([image]);
        assert_eq!(parse(&with_image).unwrap().image_ids, vec![image]);
        for (key, bad) in [("repo", json!("../etc")), ("branch", json!("--upload-pack=x")), ("branch", json!("a..b")), ("prompt", json!(" ")), ("provider", json!("a b")), ("model", Value::Null), ("imageIds", json!(["/etc/passwd"]))] {
            let mut params = ok.clone();
            params[key] = bad;
            assert!(parse(&params).is_err(), "{key}");
        }
    }

    #[test]
    fn clone_progress_is_read_from_git() {
        assert_eq!(clone_percent("Receiving objects:  50% (500/1000), 1.20 MiB | 2.00 MiB/s"), Some(40));
        assert_eq!(clone_percent("Receiving objects: 100% (1000/1000), 2.40 MiB | 2.00 MiB/s, done."), Some(80));
        assert_eq!(clone_percent("Resolving deltas: 100% (300/300), done."), Some(95));
        assert_eq!(clone_percent("Updating files:  60% (6/10)"), Some(98));
        assert_eq!(clone_percent("remote: Counting objects:  10% (1/10)"), None);
        assert_eq!(clone_percent("fatal: repository not found"), None);
        let stderr = b"Cloning into '/x'...\nremote: Enumerating objects: 9, done.\nReceiving objects:  10% (1/10)\rReceiving objects:  10% (1/10)\rReceiving objects: 100% (10/10), done.\nfatal: could not read from remote\n";
        let (sender, percents) = mpsc::channel();
        assert_eq!(read_progress(&stderr[..], sender), "fatal: could not read from remote");
        assert_eq!(percents.try_iter().collect::<Vec<_>>(), vec![8, 80]);
    }

    #[test]
    fn progress_frames_are_throttled_within_a_stage() {
        let now = Instant::now();
        let last = ("downloading".to_owned(), Some(10), now);
        assert!(due(None, "finding", None, now));
        assert!(due(Some(&last), "preparing", None, now));
        assert!(!due(Some(&last), "downloading", Some(10), now + Duration::from_secs(5)));
        assert!(!due(Some(&last), "downloading", Some(20), now + Duration::from_millis(100)));
        assert!(due(Some(&last), "downloading", Some(20), now + PROGRESS_EVERY));
        assert!(due(Some(&last), "downloading", Some(100), now));
    }

    #[test]
    fn progress_events_are_validated_on_the_viewer() {
        let payload = progress_payload("dev-studio", &json!({"startId": "s1", "repo": "orbit-labs/orbit", "stage": "downloading", "percent": 42, "detail": "ignored"})).unwrap();
        assert_eq!(payload, json!({"deviceId": "dev-studio", "startId": "s1", "repo": "orbit-labs/orbit", "stage": "downloading", "percent": 42, "detail": null}));
        let failed = progress_payload("dev-studio", &json!({"stage": "error", "percent": 500, "repo": "../x", "detail": "x".repeat(400)})).unwrap();
        assert_eq!((failed["percent"].is_null(), failed["repo"].is_null(), failed["detail"].as_str().map(str::len)), (true, true, Some(300)));
        let note = progress_payload("dev-studio", &json!({"stage": "starting", "detail": "Started in a worktree: Studio has uncommitted changes in orbit."})).unwrap();
        assert_eq!(note["detail"], "Started in a worktree: Studio has uncommitted changes in orbit.");
        assert!(progress_payload("dev-studio", &json!({"stage": "hacking"})).is_none());
        assert!(progress_payload("dev-studio", &json!({})).is_none());
    }

    #[test]
    fn start_requests_accept_either_a_repo_or_host_project_id() {
        let base = json!({"branch": "feature/x", "worktree": true, "prompt": " go ", "provider": "claude", "model": "sonnet"});
        let mut project = base.clone();
        project["projectId"] = json!("host-project-1");
        assert_eq!(parse(&project).unwrap().target, Target::ProjectId("host-project-1".into()));
        let mut both = project.clone();
        both["repo"] = json!("orbit-labs/orbit");
        assert!(parse(&both).is_err());
        assert!(parse(&base).is_err());
        project["projectId"] = json!("bad id");
        assert!(parse(&project).is_err());
    }

    fn git_in(dir: &Path, args: &[&str]) {
        assert!(Command::new("git").arg("-C").arg(dir).args(args).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t").output().unwrap().status.success(), "{args:?}");
    }

    fn temp_base(label: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("pandacode-start-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        base.canonicalize().unwrap()
    }

    #[test]
    fn the_origin_is_read_from_the_config_file_like_git_reads_it() {
        let repo = |config: &str| config_repo(config).unwrap();
        assert_eq!(repo("[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://github.com/Orbit-Labs/Orbit.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n"), Some("Orbit-Labs/Orbit".into()));
        assert_eq!(repo("[remote \"origin\"]\n\turl = git@github.com:orbit-labs/orbit.git\n"), Some("orbit-labs/orbit".into()));
        assert_eq!(repo("[REMOTE \"origin\"]\n\tURL=https://github.com/a/b\n"), Some("a/b".into()));
        assert_eq!(repo("[remote \"upstream\"]\n\turl = https://github.com/a/other\n[remote \"Origin\"]\n\turl = https://github.com/a/other\n"), None, "other remotes are not origin");
        assert_eq!(repo("[remote \"origin\"]\n\turl = https://github.com/a/first\n\turl = https://github.com/a/last\n"), Some("a/last".into()), "the last value wins");
        assert_eq!(repo("[remote \"origin\"]\n\turl = https://gitlab.com/a/b\n"), None, "not GitHub");
        assert_eq!(repo(""), None);
        // What the file alone can't answer is left to git.
        for hard in ["[include]\n\tpath = ../more\n[remote \"origin\"]\n\turl = https://github.com/a/b\n", "[includeIf \"gitdir:~/\"]\n\tpath = x\n", "[remote.origin]\n\turl = https://github.com/a/b\n", "[remote \"origin\"] url = https://github.com/a/b\n", "[remote \"origin\"]\n\turl = \"https://github.com/a/b\"\n", "[remote \"origin\"]\n\turl = https://github.com/a/b # mine\n", "[remote \"origin\"\n"] {
            assert_eq!(config_repo(hard), None, "{hard}");
        }
    }

    #[test]
    fn project_origins_match_git_for_checkouts_worktrees_and_odd_configs() {
        let base = temp_base("origins");
        let main = base.join("main");
        std::fs::create_dir_all(&main).unwrap();
        git_in(&main, &["init", "-q", "-b", "main"]);
        git_in(&main, &["remote", "add", "origin", "https://github.com/Orbit-Labs/Orbit.git"]);
        git_in(&main, &["commit", "-q", "--allow-empty", "-m", "one"]);
        let linked = base.join("linked");
        git_in(&main, &["worktree", "add", "-q", linked.to_str().unwrap()]);
        let included = base.join("included");
        std::fs::create_dir_all(&included).unwrap();
        git_in(&included, &["init", "-q"]);
        std::fs::write(included.join("more.conf"), "[remote \"origin\"]\n\turl = git@github.com:orbit-labs/included.git\n").unwrap();
        git_in(&included, &["config", "include.path", "../more.conf"]);
        let bare = base.join("empty");
        std::fs::create_dir_all(&bare).unwrap();
        git_in(&bare, &["init", "-q"]);
        let sub = main.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let missing = base.join("missing");
        let folders = [&main, &linked, &included, &bare, &sub, &missing];
        let projects: Vec<Project> = folders.iter().enumerate().map(|(n, path)| Project { id: n.to_string(), name: n.to_string(), path: path.to_string_lossy().into_owned(), added_order: n as i64 }).collect();
        assert_eq!(config_path(&main).as_deref(), Some(main.join(".git/config")).as_deref());
        assert!(config_path(&linked).is_some_and(|path| path == main.join(".git").join("config") || path.canonicalize().ok() == main.join(".git/config").canonicalize().ok()));
        assert_eq!(config_path(&sub), None);
        let found: Vec<Option<String>> = origins(projects).into_iter().map(|(_, origin)| origin).collect();
        let by_git: Vec<Option<String>> = folders.iter().map(|path| github_hub::project_repo(path)).collect();
        assert_eq!(found, by_git);
        assert_eq!(found[0].as_deref(), Some("Orbit-Labs/Orbit"));
        assert_eq!(found[1], found[0], "a linked worktree shares its main checkout's config");
        assert_eq!(found[2].as_deref(), Some("orbit-labs/included"), "an include goes through git");
        assert_eq!((found[3].clone(), found[4].as_deref(), found[5].clone()), (None, Some("Orbit-Labs/Orbit"), None));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_the_requested_harness_is_checked() {
        assert_eq!(not_installed("claude", "Studio", true), Ok(()));
        assert_eq!(not_installed("claude", "Studio", false), Err("Claude Code is not installed on Studio.".into()));
        assert_eq!(not_installed("nope", "Studio", false), Err("nope is not installed on Studio.".into()));
    }

    #[cfg(unix)]
    #[test]
    fn a_cancelled_clone_is_killed_and_its_half_made_folder_removed() {
        let base = temp_base("cancel");
        let destination = base.join("repo");
        let command = || {
            let mut command = Command::new("sh");
            // A clone that has made its folder and then hangs, with a child of its own like gh's git.
            command.arg("-c").arg(format!("mkdir -p {0}; echo partial > {0}/file; sleep 30 & wait", destination.display()));
            command
        };
        // Already cancelled: nothing runs.
        let cancel = Cancel::default();
        assert!(cancel.cancel());
        assert_eq!(supervise(command(), "a/b", &destination, Duration::from_secs(60), &cancel, drop), Err(CANCELLED.into()));
        assert!(!destination.exists());
        // Cancelled while it runs.
        let cancel = Arc::new(Cancel::default());
        let setter = cancel.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            setter.cancel();
        });
        let started = Instant::now();
        assert_eq!(supervise(command(), "a/b", &destination, Duration::from_secs(60), &cancel, drop), Err(CANCELLED.into()));
        canceller.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
        assert!(!destination.exists(), "the partial clone is removed");
        // A timeout stops it the same way, and a folder that was already there stays.
        std::fs::create_dir_all(&destination).unwrap();
        let error = supervise(command(), "a/b", &destination, Duration::from_millis(300), &Cancel::default(), drop).unwrap_err();
        assert!(error.starts_with("Cloning a/b took longer than"), "{error}");
        assert!(destination.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A fresh clone is not fetched again; a worktree start fills the lazy clone and the
    /// worktree together; a start on the default branch needs no switch.
    #[test]
    fn a_fresh_clone_needs_no_fetch_and_a_lazy_one_gets_both_checkouts() {
        let base = temp_base("lazy");
        let (origin, clone) = (base.join("origin"), base.join("clone"));
        std::fs::create_dir_all(&origin).unwrap();
        git_in(&origin, &["init", "-q", "-b", "main"]);
        std::fs::write(origin.join("a.txt"), "a").unwrap();
        git_in(&origin, &["add", "."]);
        git_in(&origin, &["commit", "-q", "-m", "one"]);
        git_in(&origin, &["branch", "feature"]);
        git_in(&base, &["clone", "-q", "--no-checkout", origin.to_str().unwrap(), "clone"]);
        assert!(!clone.join("a.txt").exists());
        git_in(&origin, &["commit", "-q", "--allow-empty", "-m", "two"]);
        assert_eq!(pick_branch(&clone, Some("feature"), false).unwrap(), "feature");
        assert_eq!(pick_branch(&clone, None, false).unwrap(), "main");
        let before = git(&clone, &["rev-parse", "origin/main"], GIT).unwrap();
        pick_branch(&clone, None, false).unwrap();
        assert_eq!(git(&clone, &["rev-parse", "origin/main"], GIT).unwrap(), before, "no fetch");
        pick_branch(&clone, None, true).unwrap();
        assert_ne!(git(&clone, &["rev-parse", "origin/main"], GIT).unwrap(), before, "fetch sees the new commit");
        let made = worktree_while_restoring(&clone, "feature").unwrap();
        assert_eq!(std::fs::read_to_string(clone.join("a.txt")).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(made.path.join("a.txt")).unwrap(), "a");
        assert!(made.branch.starts_with("pandacode/"));
        assert_eq!(git(&clone, &["status", "--porcelain"], GIT).unwrap(), "", "the main checkout is whole and clean");
        assert_eq!(git(&clone, &["branch", "--show-current"], GIT).unwrap(), "main");
        // The default branch is already checked out; another is made from origin's ref.
        checkout(&clone, "main").unwrap();
        checkout(&clone, "feature").unwrap();
        assert_eq!(git(&clone, &["branch", "--show-current"], GIT).unwrap(), "feature");
        discard(&clone, &made);
        assert!(!made.path.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A cancel before the start commits stops it; one after is refused, so the task it makes
    /// is never reported cancelled.
    #[test]
    fn a_cancel_after_the_task_is_being_made_is_too_late() {
        let early = Cancel::default();
        assert!(early.cancel() && early.cancel() && early.is_set());
        assert_eq!(early.commit(), Err(CANCELLED.into()));
        let late = Cancel::default();
        late.commit().unwrap();
        assert!(!late.cancel() && !late.is_set());
        assert_eq!(check(&late), Ok(()));
        late.commit().unwrap();
    }

    /// Concurrent starts for one project: exactly one gets the main checkout until it lets go,
    /// and a local agent there turns every one away.
    #[test]
    fn only_one_concurrent_start_reserves_the_main_checkout() {
        let id = format!("p-{}", uuid::Uuid::new_v4());
        let barrier = std::sync::Barrier::new(8);
        let won: Vec<Option<Reservation>> = std::thread::scope(|scope| {
            let tries: Vec<_> = (0..8).map(|_| scope.spawn(|| {
                barrier.wait();
                reserve_in_place(&id, || Ok(false)).unwrap()
            })).collect();
            tries.into_iter().map(|t| t.join().unwrap()).collect()
        });
        assert_eq!(won.iter().filter(|r| r.is_some()).count(), 1);
        assert!(reserve_in_place(&id, || Ok(false)).unwrap().is_none(), "held until dropped");
        drop(won);
        assert!(reserve_in_place(&id, || Ok(true)).unwrap().is_none(), "a local agent is there");
        assert!(reserve_in_place(&id, || Ok(false)).unwrap().is_some(), "released");
        assert!(reserve_in_place(&format!("{id}-other"), || Ok(false)).unwrap().is_some());
    }

    /// A worktree the task can't take (here: no such task) is removed, branch and all.
    #[test]
    fn a_worktree_the_task_cannot_take_is_removed() {
        let base = temp_base("attach");
        let (origin, clone) = (base.join("origin"), base.join("clone"));
        std::fs::create_dir_all(&origin).unwrap();
        git_in(&origin, &["init", "-q", "-b", "main"]);
        git_in(&origin, &["commit", "-q", "--allow-empty", "-m", "one"]);
        git_in(&base, &["clone", "-q", origin.to_str().unwrap(), "clone"]);
        let root = std::fs::canonicalize(&clone).unwrap();
        let store = Mutex::new(crate::storage::Store::open(Path::new(":memory:")).unwrap());
        let handed = remote_worktree(&root, "main").unwrap();
        let (path, branch) = (handed.path.clone(), handed.branch.clone());
        assert!(attach(&store, &root, "main", Some(handed), "missing").is_err());
        assert!(!path.exists());
        assert!(git(&root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], GIT).is_err(), "branch deleted");
        assert!(attach(&store, &root, "main", None, "missing").is_err());
        assert_eq!(git(&root, &["worktree", "list", "--porcelain"], GIT).unwrap().matches("worktree ").count(), 1, "only the main checkout");
        assert_eq!(git(&root, &["branch", "--list", "pandacode/*"], GIT).unwrap(), "");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Picks a pushed branch, falls back to origin's default, and checks it out.
    #[test]
    fn the_branch_comes_from_origin() {
        let base = std::env::temp_dir().join(format!("pandacode-start-{}", uuid::Uuid::new_v4()));
        let (origin, clone) = (base.join("origin"), base.join("clone"));
        std::fs::create_dir_all(&origin).unwrap();
        let run = |dir: &Path, args: &[&str]| assert!(Command::new("git").arg("-C").arg(dir).args(args).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t").output().unwrap().status.success(), "{args:?}");
        run(&origin, &["init", "-q", "-b", "main"]);
        run(&origin, &["commit", "-q", "--allow-empty", "-m", "one"]);
        run(&origin, &["branch", "feature"]);
        run(&base, &["clone", "-q", origin.to_str().unwrap(), "clone"]);
        assert_eq!(pick_branch(&clone, Some("feature"), true).unwrap(), "feature");
        assert_eq!(pick_branch(&clone, Some("unpushed"), true).unwrap(), "main");
        assert_eq!(pick_branch(&clone, None, true).unwrap(), "main");
        // An existing checkout on another branch, dirty or busy is never switched.
        assert!(ready_in_place(&clone, "orbit", "feature", false).unwrap().unwrap().contains("on main, not feature"));
        assert!(ready_in_place(&clone, "orbit", "main", true).unwrap().unwrap().contains("an agent working"));
        std::fs::write(clone.join("notes.txt"), "work").unwrap();
        assert!(ready_in_place(&clone, "orbit", "main", false).unwrap().unwrap().contains("uncommitted changes"));
        assert_eq!(git(&clone, &["branch", "--show-current"], GIT).unwrap(), "main");
        // The fallback worktree leaves the busy checkout's branch and files alone.
        let root = std::fs::canonicalize(&clone).unwrap();
        let made = remote_worktree(&root, "feature").unwrap();
        assert!(made.branch.starts_with("pandacode/remote-"));
        assert_eq!(std::fs::read_to_string(clone.join("notes.txt")).unwrap(), "work");
        assert_eq!(git(&clone, &["branch", "--show-current"], GIT).unwrap(), "main");
        assert_eq!(git(&made.path, &["rev-parse", "HEAD"], GIT).unwrap(), git(&clone, &["rev-parse", "origin/feature"], GIT).unwrap());
        assert!(!made.path.join("notes.txt").exists());
        discard(&root, &made);
        std::fs::remove_file(clone.join("notes.txt")).unwrap();
        // Clean, idle and on the branch: fast-forwarded and used in place.
        run(&origin, &["commit", "-q", "--allow-empty", "-m", "two"]);
        pick_branch(&clone, Some("main"), true).unwrap();
        assert_eq!(ready_in_place(&clone, "orbit", "main", false).unwrap(), None);
        assert_eq!(git(&clone, &["rev-parse", "HEAD"], GIT).unwrap(), git(&origin, &["rev-parse", "HEAD"], GIT).unwrap());
        checkout(&clone, "feature").unwrap();
        assert_eq!(git(&clone, &["branch", "--show-current"], GIT).unwrap(), "feature");
        let _ = std::fs::remove_dir_all(&base);
    }
}
