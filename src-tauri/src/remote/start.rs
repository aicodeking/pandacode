//! `task.start` on the host: find (or clone) the project for a GitHub repository, check
//! out the viewer's branch, then start an ordinary task there.
use super::host::{name_param, text_param};
use crate::{github_hub, storage::Project, workspace, AppState, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::Manager;

/// Worst case for a start: clone 6 min + fetch 90 s + 8 local git steps of 15 s ≈ 9.5 min.
/// The viewer waits longer ([`super::mirror`]'s `START_TIMEOUT`).
const CLONE: Duration = Duration::from_secs(6 * 60);
const FETCH: Duration = Duration::from_secs(90);
const GIT: Duration = Duration::from_secs(15);
pub(crate) const WORST_CASE: Duration = Duration::from_secs(6 * 60 + 90 + 8 * 15);
/// Clones land in `~/PandaCode/<name>`.
const CLONE_FOLDER: &str = "PandaCode";

#[derive(Debug, PartialEq)]
pub(crate) struct Start {
    pub repo: String,
    pub branch: Option<String>,
    pub worktree: bool,
    pub prompt: String,
    pub provider: String,
    pub model: String,
    pub mode: Option<String>,
    pub effort: Option<String>,
    /// The viewer's local mirror id: a repeated start with it returns the same task.
    pub start_id: Option<String>,
}

pub(crate) fn parse(params: &Value) -> Result<Start> {
    let branch = name_param(params, "branch")?;
    if let Some(branch) = &branch {
        valid_branch(branch)?;
    }
    Ok(Start {
        repo: github_hub::valid_repo(params["repo"].as_str().unwrap_or_default())?,
        branch,
        worktree: params["worktree"].as_bool().unwrap_or(false),
        prompt: text_param(params, "prompt")?,
        provider: name_param(params, "provider")?.ok_or("Missing provider.")?,
        model: name_param(params, "model")?.ok_or("Missing model.")?,
        mode: name_param(params, "mode")?,
        effort: name_param(params, "effort")?,
        start_id: params.get("startId").filter(|v| !v.is_null()).map(|_| super::host::id_param(params, "startId")).transpose()?,
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

/// The project checking out `repo`, cloned into `~/PandaCode` when there is none, and
/// whether it was cloned just now.
fn project_for(state: &AppState, repo: &str) -> Result<(Project, bool)> {
    let projects = state.store.lock().map_err(|e| e.to_string())?.projects()?;
    let origins = projects.into_iter().map(|project| {
        let origin = github_hub::project_repo(Path::new(&project.path));
        (project, origin)
    });
    if let Some(project) = find_project(origins.collect(), repo) {
        return Ok((project, false));
    }
    let home = crate::agent_usage_providers::home().ok_or("This computer has no home folder to clone into.")?;
    let destination = clone_path(&home, repo, Path::exists);
    std::fs::create_dir_all(home.join(CLONE_FOLDER)).map_err(|e| e.to_string())?;
    github_hub::clone_to(repo, &destination, CLONE)?;
    Ok((state.store.lock().map_err(|e| e.to_string())?.add_project(&destination)?, true))
}

/// Fetches and picks the viewer's branch when origin has it, else the default branch.
fn pick_branch(root: &Path, wanted: Option<&str>) -> Result<String> {
    git(root, &["fetch", "--quiet", "origin"], FETCH).map_err(|e| format!("Could not fetch from GitHub: {e}"))?;
    if let Some(branch) = wanted.filter(|branch| on_origin(root, branch)) {
        return Ok(branch.to_owned());
    }
    let head = git(root, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], GIT).unwrap_or_default();
    head.strip_prefix("origin/").map(str::to_owned).filter(|branch| valid_branch(branch).is_ok()).ok_or_else(|| "Could not find the repository's default branch.".into())
}

/// Why the main checkout can't take a remote task in place, if it can't. Only a clean,
/// idle checkout already on the requested branch runs one.
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
    Some(format!("{problem} Start it in a Worktree instead."))
}

/// Readies the main checkout for a task in place: refuses unless it is clean, idle and on
/// `branch`, then fast-forwards it to origin when it can.
fn ready_in_place(root: &Path, project: &str, branch: &str, busy: bool) -> Result<()> {
    let current = git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"], GIT).unwrap_or_default();
    let dirty = !git(root, &["status", "--porcelain"], GIT)?.is_empty();
    if let Some(refusal) = in_place_refusal(&super::config::device_name(), project, &current, branch, dirty, busy) {
        return Err(refusal);
    }
    // A local branch that diverged keeps its own commits; the agent starts from them.
    let _ = git(root, &["merge", "--ff-only", "--quiet", &format!("origin/{branch}")], GIT);
    Ok(())
}

/// Whether a local agent is running in the project's main checkout.
fn busy_in_place(state: &AppState, project_id: &str) -> Result<bool> {
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    let store = state.store.lock().map_err(|e| e.to_string())?;
    Ok(agents.keys().any(|id| store.session(id).is_ok_and(|task| task.project_id == project_id && task.worktree_path.is_none())))
}

/// Puts a fresh clone's checkout on `branch`; nobody's work is there yet.
fn checkout(root: &Path, branch: &str) -> Result<()> {
    let local = git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], GIT).is_ok();
    let switched = if local { git(root, &["switch", branch], GIT) } else { git(root, &["switch", "--track", "-c", branch, &format!("origin/{branch}")], GIT) };
    switched.map_err(|e| format!("Could not check out {branch}: {e}"))?;
    // A local branch that diverged keeps its own commits; the agent starts from them.
    let _ = git(root, &["merge", "--ff-only", "--quiet", &format!("origin/{branch}")], GIT);
    Ok(())
}

/// Refuses a harness this computer doesn't have.
pub(crate) async fn require_installed(provider: &str) -> Result<()> {
    let providers = tauri::async_runtime::spawn_blocking(crate::providers::discover).await.map_err(|e| e.to_string())?;
    if !providers.iter().any(|p| p.id == provider && p.installed) {
        let name = providers.iter().find(|p| p.id == provider).map_or(provider, |p| p.name.as_str());
        return Err(format!("{name} is not installed on {}.", super::config::device_name()));
    }
    Ok(())
}

/// Starts in progress here, by (caller, start id).
fn in_flight() -> std::sync::MutexGuard<'static, std::collections::HashSet<(String, String)>> {
    static STARTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<(String, String)>>> = std::sync::OnceLock::new();
    STARTS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// What this host knows of a start id. Read under the store lock with `in_flight` held, and
/// a start leaves `in_flight` only after its row is settled, so a lookup always sees one of
/// the two: never neither.
#[derive(Debug, PartialEq)]
enum Lookup {
    /// The prompt was accepted: the task is ready.
    Started(String),
    /// A start with this id is running here now.
    Starting,
    /// A start that never finished (this computer quit during it), now detached from the id.
    Stale(String),
    None,
}

fn lookup(db: &rusqlite::Connection, starts: &std::collections::HashSet<(String, String)>, from: &str, start_id: &str) -> Result<Lookup> {
    use rusqlite::OptionalExtension;
    if starts.contains(&(from.to_owned(), start_id.to_owned())) {
        return Ok(Lookup::Starting);
    }
    // A start cut off after its prompt was saved (a crash before `started` was written)
    // had begun its run: it counts as started, never discarded.
    let row: Option<(String, Option<String>, bool)> = db.query_row("SELECT id,remote_start_state,EXISTS(SELECT 1 FROM messages WHERE session_id=sessions.id AND role='user') FROM sessions WHERE remote_caller=?1 AND remote_start_id=?2", [from, start_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().map_err(|e| e.to_string())?;
    Ok(match row {
        Some((id, Some(state), _)) if state == "started" => Lookup::Started(id),
        Some((id, _, true)) => {
            db.execute("UPDATE sessions SET remote_start_state='started' WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
            Lookup::Started(id)
        }
        Some((id, _, false)) => {
            detach(db, &id)?;
            Lookup::Stale(id)
        }
        None => Lookup::None,
    })
}

/// Forgets a start id on its task, so nothing finds the task by it again.
fn detach(db: &rusqlite::Connection, id: &str) -> Result<()> {
    db.execute("UPDATE sessions SET remote_caller=NULL,remote_start_id=NULL,remote_start_state=NULL WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Deletes the task of a start that never finished.
fn discard(app: &tauri::AppHandle, id: &str) {
    if let Err(error) = crate::task_deletion::delete_state(&app.state::<AppState>(), id) {
        eprintln!("PandaCode Connect: could not remove a task that never started: {error}");
    }
}

/// `task.find`: the task `from` started with `start_id` (scoped to the caller) once its
/// prompt was accepted, or whether that start still runs here. A start cut off by a quit
/// here is removed and reads as missing, so the viewer fails it instead of adopting it.
pub(crate) fn find(app: &tauri::AppHandle, from: &str, start_id: &str) -> Result<Value> {
    let found = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        lookup(&store.db, &in_flight(), from, start_id)?
    };
    Ok(match found {
        Lookup::Started(id) => json!({"sessionId": id, "starting": false}),
        Lookup::Starting => json!({"sessionId": null, "starting": true}),
        Lookup::Stale(id) => {
            discard(app, &id);
            json!({"sessionId": null, "starting": false})
        }
        Lookup::None => json!({"sessionId": null, "starting": false}),
    })
}

/// Takes a start id for the length of one start, unless a start with it already finished
/// or still runs; a stale one is detached and started again.
fn claim_start(db: &rusqlite::Connection, from: &str, start_id: &str) -> Result<Lookup> {
    let mut starts = in_flight();
    let found = lookup(db, &starts, from, start_id)?;
    if matches!(found, Lookup::None | Lookup::Stale(_)) {
        starts.insert((from.to_owned(), start_id.to_owned()));
    }
    Ok(found)
}

/// Starts the task once per start id: a repeated `task.start` returns the task the first
/// one made once its prompt was accepted, `starting` while it runs, and starts nothing new.
pub(crate) async fn run(app: &tauri::AppHandle, from: &str, start: Start) -> Result<Value> {
    let Some(start_id) = start.start_id.clone() else { return run_once(app, from, start).await };
    let claimed = claim_start(&app.state::<AppState>().store.lock().map_err(|e| e.to_string())?.db, from, &start_id)?;
    match claimed {
        Lookup::Started(id) => return Ok(json!({"sessionId": id})),
        Lookup::Starting => return Ok(json!({"sessionId": null, "starting": true})),
        Lookup::Stale(id) => discard(app, &id),
        Lookup::None => {}
    }
    let result = run_once(app, from, start).await;
    if result.is_err() {
        // A row this start made but could not finish goes before the start leaves `in_flight`.
        let left = {
            let state = app.state::<AppState>();
            let store = state.store.lock().map_err(|e| e.to_string())?;
            let left = started_row(&store.db, from, &start_id)?;
            if let Some(id) = &left {
                detach(&store.db, id)?;
            }
            left
        };
        if let Some(id) = left {
            discard(app, &id);
        }
    }
    in_flight().remove(&(from.to_owned(), start_id));
    result
}

fn started_row(db: &rusqlite::Connection, from: &str, start_id: &str) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;
    db.query_row("SELECT id FROM sessions WHERE remote_caller=?1 AND remote_start_id=?2", [from, start_id], |r| r.get(0)).optional().map_err(|e| e.to_string())
}

async fn run_once(app: &tauri::AppHandle, from: &str, start: Start) -> Result<Value> {
    require_installed(&start.provider).await?;
    let handle = app.clone();
    let (repo, wanted, worktree) = (start.repo.clone(), start.branch.clone(), start.worktree);
    let (project, branch) = tauri::async_runtime::spawn_blocking(move || -> Result<(Project, String)> {
        let state = handle.state::<AppState>();
        let (project, cloned) = project_for(&state, &repo)?;
        let root = PathBuf::from(&project.path);
        let branch = pick_branch(&root, wanted.as_deref())?;
        if !worktree {
            if cloned {
                checkout(&root, &branch)?;
            } else {
                ready_in_place(&root, &project.name, &branch, busy_in_place(&state, &project.id)?)?;
            }
        }
        Ok((project, branch))
    })
    .await
    .map_err(|e| e.to_string())??;
    let state = app.state::<AppState>();
    let task = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let task = crate::architect::profiles::create_user_task(&store, &project.id, &start.provider, &start.model, start.mode.as_deref(), None)?;
        if start.effort.is_some() {
            store.set_reasoning_effort(&task.id, start.effort.as_deref())?;
        }
        if let Some(start_id) = &start.start_id {
            store.db.execute("UPDATE sessions SET remote_caller=?2,remote_start_id=?3,remote_start_state='starting' WHERE id=?1", rusqlite::params![task.id, from, start_id]).map_err(|e| e.to_string())?;
        }
        task
    };
    if worktree {
        let store = state.store.clone();
        let (id, root) = (task.id.clone(), PathBuf::from(&project.path));
        let attached = tauri::async_runtime::spawn_blocking(move || -> Result<()> {
            let name = format!("pandacode/remote-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
            let checkout = workspace::create_worktree_with(&root, &name, Some(&format!("origin/{branch}")), false)?;
            store.lock().map_err(|e| e.to_string())?.attach_worktree(&id, &checkout.path, &checkout.branch).map(|_| ())
        })
        .await
        .map_err(|e| e.to_string())?;
        if let Err(error) = attached {
            let _ = crate::task_deletion::delete_state(&state, &task.id);
            return Err(error);
        }
    }
    // The caller mirrors the task from its first event.
    super::host::follow(app, from, &task.id);
    crate::send_message(app.clone(), state.clone(), task.id.clone(), start.prompt, None, None).await?;
    // Ready: only now does `task.find` (or a repeated start) name the task.
    if start.start_id.is_some() {
        state.store.lock().map_err(|e| e.to_string())?.db.execute("UPDATE sessions SET remote_start_state='started' WHERE id=?1", [&task.id]).map_err(|e| e.to_string())?;
    }
    use tauri::Emitter;
    let _ = app.emit("sessions-changed", ());
    Ok(json!({"sessionId": task.id}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: &str) -> Project {
        Project { id: id.into(), name: id.into(), path: format!("/p/{id}") }
    }

    #[test]
    fn a_project_is_found_by_its_origin() {
        let projects = vec![(project("a"), None), (project("b"), Some("orbit-labs/other".into())), (project("c"), Some("Orbit-Labs/Orbit".into()))];
        assert_eq!(find_project(projects.clone(), "orbit-labs/orbit").map(|p| p.id), Some("c".into()));
        assert!(find_project(projects, "orbit-labs/missing").is_none());
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
        assert_eq!(in_place_refusal("Studio", "orbit", "main", "main", true, false).unwrap(), "Studio has uncommitted changes in orbit. Start it in a Worktree instead.");
        assert_eq!(in_place_refusal("Studio", "orbit", "dev", "main", false, false).unwrap(), "Studio has orbit on dev, not main. Start it in a Worktree instead.");
        assert_eq!(in_place_refusal("Studio", "orbit", "", "main", false, false).unwrap(), "Studio has orbit on a detached HEAD, not main. Start it in a Worktree instead.");
        assert_eq!(in_place_refusal("Studio", "orbit", "main", "main", true, true).unwrap(), "Studio has an agent working in orbit. Start it in a Worktree instead.");
        assert!(WORST_CASE <= Duration::from_secs(10 * 60));
    }

    #[test]
    fn a_start_id_names_its_task_only_once_the_prompt_was_accepted() {
        let store = crate::storage::Store::open(Path::new(":memory:")).unwrap();
        let start_id = uuid::Uuid::new_v4().to_string();
        let key = ("viewer".to_owned(), start_id.clone());
        assert_eq!(claim_start(&store.db, "viewer", &start_id), Ok(Lookup::None));
        assert_eq!(claim_start(&store.db, "viewer", &start_id), Ok(Lookup::Starting), "a second start waits for the first");
        // The row exists before the worktree and the prompt: still starting, not ready.
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store.create_session(&project.id, "claude", "sonnet", "ask").unwrap();
        store.db.execute("UPDATE sessions SET remote_caller='viewer',remote_start_id=?2,remote_start_state='starting' WHERE id=?1", [&task.id, &start_id]).unwrap();
        assert_eq!(lookup(&store.db, &in_flight(), "viewer", &start_id), Ok(Lookup::Starting));
        store.db.execute("UPDATE sessions SET remote_start_state='started' WHERE id=?1", [&task.id]).unwrap();
        in_flight().remove(&key);
        assert_eq!(claim_start(&store.db, "viewer", &start_id), Ok(Lookup::Started(task.id.clone())), "a repeated start returns the task");
        assert_eq!(lookup(&store.db, &in_flight(), "other", &start_id), Ok(Lookup::None), "scoped to the caller");
        let copy = store.create_session(&project.id, "claude", "sonnet", "ask").unwrap();
        assert!(store.db.execute("UPDATE sessions SET remote_caller='viewer',remote_start_id=?2 WHERE id=?1", [&copy.id, &start_id]).is_err(), "unique per caller");
        // A start cut off by a quit here (still starting, nothing in flight) is detached once
        // and then missing, so the viewer fails it rather than adopting a half-made task.
        store.db.execute("UPDATE sessions SET remote_start_state='starting' WHERE id=?1", [&task.id]).unwrap();
        assert_eq!(lookup(&store.db, &in_flight(), "viewer", &start_id), Ok(Lookup::Stale(task.id.clone())));
        assert_eq!(lookup(&store.db, &in_flight(), "viewer", &start_id), Ok(Lookup::None));
        // The host crashed after the prompt was saved but before `started`: its run began,
        // so the start is the task, not a stale one to discard.
        let saved = store.create_session(&project.id, "claude", "sonnet", "ask").unwrap();
        store.db.execute("UPDATE sessions SET remote_caller='viewer',remote_start_id='crashed',remote_start_state='starting' WHERE id=?1", [&saved.id]).unwrap();
        store.begin_task_turn(&saved.id, "go").unwrap();
        assert_eq!(lookup(&store.db, &in_flight(), "viewer", "crashed"), Ok(Lookup::Started(saved.id.clone())));
        assert_eq!(lookup(&store.db, &in_flight(), "viewer", "crashed"), Ok(Lookup::Started(saved.id.clone())));
        let mut params = json!({"repo": "orbit-labs/orbit", "prompt": "go", "provider": "claude", "model": "sonnet", "startId": start_id});
        assert_eq!(parse(&params).unwrap().start_id, Some(start_id));
        params["startId"] = json!("a b");
        assert!(parse(&params).is_err());
    }

    #[test]
    fn start_requests_are_validated() {
        let ok = json!({"repo": "orbit-labs/orbit", "branch": "feature/x", "worktree": true, "prompt": " go ", "provider": "claude", "model": "sonnet", "effort": "high"});
        let start = parse(&ok).unwrap();
        assert_eq!((start.repo.as_str(), start.branch.as_deref(), start.worktree, start.prompt.as_str(), start.mode), ("orbit-labs/orbit", Some("feature/x"), true, "go", None));
        for (key, bad) in [("repo", json!("../etc")), ("branch", json!("--upload-pack=x")), ("branch", json!("a..b")), ("prompt", json!(" ")), ("provider", json!("a b")), ("model", Value::Null)] {
            let mut params = ok.clone();
            params[key] = bad;
            assert!(parse(&params).is_err(), "{key}");
        }
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
        assert_eq!(pick_branch(&clone, Some("feature")).unwrap(), "feature");
        assert_eq!(pick_branch(&clone, Some("unpushed")).unwrap(), "main");
        assert_eq!(pick_branch(&clone, None).unwrap(), "main");
        // An existing checkout on another branch, dirty or busy is never switched.
        assert!(ready_in_place(&clone, "orbit", "feature", false).unwrap_err().contains("on main, not feature"));
        assert!(ready_in_place(&clone, "orbit", "main", true).unwrap_err().contains("an agent working"));
        std::fs::write(clone.join("notes.txt"), "work").unwrap();
        assert!(ready_in_place(&clone, "orbit", "main", false).unwrap_err().contains("uncommitted changes"));
        assert_eq!(git(&clone, &["branch", "--show-current"], GIT).unwrap(), "main");
        std::fs::remove_file(clone.join("notes.txt")).unwrap();
        // Clean, idle and on the branch: fast-forwarded and used in place.
        run(&origin, &["commit", "-q", "--allow-empty", "-m", "two"]);
        pick_branch(&clone, Some("main")).unwrap();
        ready_in_place(&clone, "orbit", "main", false).unwrap();
        assert_eq!(git(&clone, &["rev-parse", "HEAD"], GIT).unwrap(), git(&origin, &["rev-parse", "HEAD"], GIT).unwrap());
        checkout(&clone, "feature").unwrap();
        assert_eq!(git(&clone, &["branch", "--show-current"], GIT).unwrap(), "feature");
        let _ = std::fs::remove_dir_all(&base);
    }
}
