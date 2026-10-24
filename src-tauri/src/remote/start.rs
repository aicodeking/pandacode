//! `task.start` on the host: use a local project or find (or clone) a GitHub repository,
//! check out the viewer's branch, then start an ordinary task there.
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
    pub target: Target,
    pub branch: Option<String>,
    pub worktree: bool,
    pub prompt: String,
    pub provider: String,
    pub model: String,
    pub mode: Option<String>,
    pub effort: Option<String>,
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
        target,
        branch,
        worktree: params["worktree"].as_bool().unwrap_or(false),
        prompt: text_param(params, "prompt")?,
        provider: name_param(params, "provider")?.ok_or("Missing provider.")?,
        model: name_param(params, "model")?.ok_or("Missing model.")?,
        mode: name_param(params, "mode")?,
        effort: name_param(params, "effort")?,
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

/// The project checking out `repo`, cloned into `~/PandaCode` when there is none, and
/// whether it was cloned just now.
fn project_for(state: &AppState, target: &Target) -> Result<(Project, bool)> {
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
    }
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

pub(crate) async fn run(app: &tauri::AppHandle, from: &str, start: Start) -> Result<Value> {
    require_installed(&start.provider).await?;
    let handle = app.clone();
    let (target, wanted, worktree) = (start.target, start.branch.clone(), start.worktree);
    let (project, branch) = tauri::async_runtime::spawn_blocking(move || -> Result<(Project, String)> {
        let state = handle.state::<AppState>();
        let (project, cloned) = project_for(&state, &target)?;
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
    crate::send_message(app.clone(), state, task.id.clone(), start.prompt, None, None).await?;
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
        assert_eq!(in_place_refusal("Studio", "orbit", "main", "main", true, false).unwrap(), "Studio has uncommitted changes in orbit. Start it in a Worktree instead.");
        assert_eq!(in_place_refusal("Studio", "orbit", "dev", "main", false, false).unwrap(), "Studio has orbit on dev, not main. Start it in a Worktree instead.");
        assert_eq!(in_place_refusal("Studio", "orbit", "", "main", false, false).unwrap(), "Studio has orbit on a detached HEAD, not main. Start it in a Worktree instead.");
        assert_eq!(in_place_refusal("Studio", "orbit", "main", "main", true, true).unwrap(), "Studio has an agent working in orbit. Start it in a Worktree instead.");
        assert!(WORST_CASE <= Duration::from_secs(10 * 60));
    }

    #[test]
    fn start_requests_are_validated() {
        let ok = json!({"repo": "orbit-labs/orbit", "branch": "feature/x", "worktree": true, "prompt": " go ", "provider": "claude", "model": "sonnet", "effort": "high"});
        let start = parse(&ok).unwrap();
        assert_eq!((start.target, start.branch.as_deref(), start.worktree, start.prompt.as_str(), start.mode), (Target::Repo("orbit-labs/orbit".into()), Some("feature/x"), true, "go", None));
        for (key, bad) in [("repo", json!("../etc")), ("branch", json!("--upload-pack=x")), ("branch", json!("a..b")), ("prompt", json!(" ")), ("provider", json!("a b")), ("model", Value::Null)] {
            let mut params = ok.clone();
            params[key] = bad;
            assert!(parse(&params).is_err(), "{key}");
        }
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
