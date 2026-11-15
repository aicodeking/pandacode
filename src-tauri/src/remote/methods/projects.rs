//! PandaConnect methods for the `projects` feature group: starting a projectless Chat
//! (`crate::chats`), cloning a GitHub repository as a new project, and the account's recent
//! repositories to pick one from. See `methods/mod.rs` and docs/remote-access.md, "Adding a method".
//!
//! The phone never names a folder: a clone always lands in `~/PandaCode/<name>` (as a remote
//! `task.start` clone does), and the only names it sends are a repository and a folder name.
//! A clone can take minutes, so `projects.clone` starts it in the background and answers at
//! once; the phone follows it with `projects.cloneStatus`, keeping its ordered request lane free.
use super::{name_param, text_param, Access, Ctx, Method, Reply, Run};
use crate::{github_hub, AppState, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// The longest a clone may run (as `github_hub::clone`).
const CLONE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long a finished clone's outcome is remembered for `projects.cloneStatus`.
const CLONE_MEMORY: Duration = Duration::from_secs(30 * 60);
/// Clones remembered at most; past it the oldest finished ones are forgotten.
const MAX_CLONES: usize = 32;
/// Clones running at once.
const MAX_RUNNING: usize = 3;
/// A repository description's longest form in `projects.recentRepos`.
const MAX_DESCRIPTION: usize = 200;
/// Repositories one `projects.recentRepos` lists.
const MAX_REPOS: usize = 100;
/// Where clones land in the home folder (as `remote::start`).
const CLONE_FOLDER: &str = "PandaCode";

/// `owner/name`, or a GitHub URL naming one (`https://github.com/owner/name[.git]`).
pub(crate) fn repo_param(params: &Value) -> Result<String> {
    let value = params.get("repo").and_then(Value::as_str).map(str::trim).ok_or("Missing repo.")?;
    if value.contains("://") || value.starts_with("git@") {
        return github_hub::repo_from_remote(value).ok_or_else(|| "Choose a GitHub repository (owner/name or its github.com link).".into());
    }
    github_hub::valid_repo(value)
}

/// The clone's folder name: letters, digits, `.`, `_`, `-`; never hidden, `..` or a path.
pub(crate) fn folder_param(params: &Value) -> Result<Option<String>> {
    let Some(value) = params.get("name").filter(|v| !v.is_null()) else { return Ok(None) };
    let name = value.as_str().map(str::trim).unwrap_or_default();
    let valid = (1..=100).contains(&name.len()) && !name.starts_with(['.', '-']) && !name.contains("..") && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if valid {
        Ok(Some(name.to_owned()))
    } else {
        Err("Folder names use letters, digits, '.', '_' and '-' (up to 100).".into())
    }
}

/// Names tried before a clone gives up on finding a free folder.
const MAX_CLONE_NAMES: usize = 1000;

/// `<home>/PandaCode/<name>`, or `<name>-2`, `-3`… : the first candidate `claim` takes
/// (`Ok(false)` means taken, so try the next).
fn clone_destination(home: &Path, repo: &str, name: Option<&str>, mut claim: impl FnMut(&Path) -> Result<bool>) -> Result<PathBuf> {
    let folder = name.unwrap_or_else(|| repo.rsplit('/').next().unwrap_or(repo));
    let parent = home.join(CLONE_FOLDER);
    for n in 1..=MAX_CLONE_NAMES {
        let path = parent.join(if n == 1 { folder.to_owned() } else { format!("{folder}-{n}") });
        if claim(&path)? {
            return Ok(path);
        }
    }
    Err(format!("Too many folders named {folder} in ~/{CLONE_FOLDER}; choose another name."))
}

/// Claims a clone's folder by creating it empty (`git clone` fills an empty folder), so two
/// clones that pick the same name at once (`a/x` and `b/x`) never share one: whoever creates
/// it first owns it, and the other moves on to the next name.
fn claim_folder(path: &Path) -> Result<bool> {
    match std::fs::create_dir(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(format!("Could not create {}: {error}", path.display())),
    }
}

// ---- projects.clone / projects.cloneStatus ----

#[derive(Debug, Clone, PartialEq)]
enum CloneState {
    Cloning,
    Done { project_id: String, existing: bool },
    Failed(String),
}

impl CloneState {
    fn reply(&self, repo: &str) -> Value {
        match self {
            Self::Cloning => json!({"repo": repo, "state": "cloning"}),
            Self::Done { project_id, existing } => json!({"repo": repo, "state": "done", "projectId": project_id, "existing": existing}),
            Self::Failed(error) => json!({"repo": repo, "state": "failed", "error": error}),
        }
    }
}

/// Clones by repository (lowercase: GitHub names ignore case) with when each last changed and
/// the devices that asked for it: only those see its outcome (Round 19).
#[derive(Default)]
struct Clones(HashMap<String, (CloneState, Instant, Vec<String>)>);

impl Clones {
    fn expire(&mut self, now: Instant) {
        self.0.retain(|_, (state, at, _)| *state == CloneState::Cloning || now.saturating_duration_since(*at) < CLONE_MEMORY);
        while self.0.len() > MAX_CLONES {
            let oldest = self.0.iter().filter(|(_, (state, _, _))| *state != CloneState::Cloning).min_by_key(|(_, (_, at, _))| *at).map(|(key, _)| key.clone());
            match oldest {
                Some(key) => self.0.remove(&key),
                None => break,
            };
        }
    }

    /// Claims `repo` for a new clone by `device`; the current state instead when one runs (the
    /// device then follows it too), or an error when too many do.
    fn begin(&mut self, repo: &str, device: &str, now: Instant) -> Result<Option<CloneState>> {
        self.expire(now);
        let key = repo.to_ascii_lowercase();
        if let Some((CloneState::Cloning, _, devices)) = self.0.get_mut(&key) {
            if !devices.iter().any(|d| d == device) {
                devices.push(device.to_owned());
            }
            return Ok(Some(CloneState::Cloning));
        }
        if self.0.values().filter(|(state, _, _)| *state == CloneState::Cloning).count() >= MAX_RUNNING {
            return Err("Other downloads are still running on this computer. Try again in a minute.".into());
        }
        self.0.insert(key, (CloneState::Cloning, now, vec![device.to_owned()]));
        Ok(None)
    }

    fn finish(&mut self, repo: &str, state: CloneState, now: Instant) {
        let entry = self.0.entry(repo.to_ascii_lowercase()).or_insert_with(|| (CloneState::Cloning, now, Vec::new()));
        entry.0 = state;
        entry.1 = now;
    }

    /// The clone's state for a device that asked for it; `None` for every other device.
    fn get(&mut self, repo: &str, device: &str, now: Instant) -> Option<CloneState> {
        self.expire(now);
        self.0.get(&repo.to_ascii_lowercase()).filter(|(_, _, devices)| devices.iter().any(|d| d == device)).map(|(state, _, _)| state.clone())
    }
}

static CLONES: Mutex<Option<Clones>> = Mutex::new(None);

fn with_clones<T>(f: impl FnOnce(&mut Clones) -> T) -> Result<T> {
    let mut guard = CLONES.lock().map_err(|e| e.to_string())?;
    Ok(f(guard.get_or_insert_with(Clones::default)))
}

/// Registered projects that are real repositories: no bot or chat folders.
fn repo_projects(projects: Vec<crate::storage::Project>, bots: &[String]) -> Vec<crate::storage::Project> {
    projects.into_iter().filter(|p| !bots.contains(&p.id) && !crate::chats::is_chat_folder(Path::new(&p.path))).collect()
}

/// The registered (non-bot) project whose origin is `repo`.
fn existing_project(state: &AppState, repo: &str) -> Result<Option<String>> {
    let (projects, bots) = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        (store.projects()?, crate::bots::project_ids(&store)?)
    };
    let projects = repo_projects(projects, &bots);
    Ok(super::super::start::find_project(super::super::start::origins(projects), repo).map(|p| p.id))
}

/// Longest clone error a phone gets.
const MAX_CLONE_ERROR: usize = 300;

/// A clone failure as a phone may see it (Round 19): `gh`'s usual failures as fixed sentences,
/// anything else with the home folder written as `~`, so no local path leaves this computer.
fn phone_clone_error(error: &str, home: Option<&Path>) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("timed out") || lower.contains("took too long") {
        return "The download took too long. Try again on a faster connection.".into();
    }
    if lower.contains("could not resolve to a repository") || lower.contains("not found") {
        return "That repository was not found, or this computer's GitHub account cannot reach it.".into();
    }
    if lower.contains("gh auth login") || lower.contains("authentication") || lower.contains("not logged") {
        return "Sign in to GitHub on this computer (gh auth login), then try again.".into();
    }
    if lower.contains("no space left") {
        return "This computer is out of disk space.".into();
    }
    let mut text = home_as_tilde(error, home);
    if text.len() > MAX_CLONE_ERROR {
        let mut end = MAX_CLONE_ERROR;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push('…');
    }
    text
}

/// `text` with the home folder (as given and resolved) written as `~`, so no local path leaves
/// this computer; shared by `projects.cloneStatus` and `cloud.machines` (Round 23).
pub(super) fn home_as_tilde(text: &str, home: Option<&Path>) -> String {
    let mut text = text.to_owned();
    if let Some(home) = home {
        let mut homes = vec![home.to_string_lossy().into_owned()];
        if let Ok(real) = home.canonicalize() {
            homes.push(real.to_string_lossy().into_owned());
        }
        homes.sort_by_key(|h| std::cmp::Reverse(h.len()));
        for home in homes.iter().filter(|h| h.len() > 1) {
            text = text.replace(home.as_str(), "~");
        }
    }
    text
}

/// Clones `repo` and registers it; runs on a blocking thread.
fn clone_now(app: &tauri::AppHandle, repo: &str, name: Option<&str>) -> Result<CloneState> {
    let state = app.state::<AppState>();
    if let Some(project_id) = existing_project(&state, repo)? {
        return Ok(CloneState::Done { project_id, existing: true });
    }
    let home = crate::agent_usage_providers::home().ok_or("This computer has no home folder to clone into.")?;
    std::fs::create_dir_all(home.join(CLONE_FOLDER)).map_err(|e| format!("Could not create ~/{CLONE_FOLDER}: {e}"))?;
    let destination = clone_destination(&home, repo, name, claim_folder)?;
    if let Err(error) = github_hub::clone_to(repo, &destination, CLONE_TIMEOUT) {
        // A failed clone leaves no half-made folder behind: this call created the folder
        // ([`claim_folder`]), so removing it never touches another clone's.
        let _ = std::fs::remove_dir_all(&destination);
        return Err(error);
    }
    let project = state.store.lock().map_err(|e| e.to_string())?.add_project(&destination)?;
    Ok(CloneState::Done { project_id: project.id, existing: false })
}

#[derive(Debug)]
struct CloneRepo {
    repo: String,
    name: Option<String>,
}

impl Run for CloneRepo {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            // Round 10: a fresh clone's own harness config would run unapproved in a phone's task.
            super::super::start::refuse_clone(crate::workspace::Trust::phone(ctx.full_access))?;
            let CloneRepo { repo, name } = *self;
            let device = ctx.from.to_owned();
            if let Some(state) = with_clones(|clones| clones.begin(&repo, &device, Instant::now()))?? {
                return Ok(state.reply(&repo));
            }
            let app = ctx.app.clone();
            let (job_repo, job_app) = (repo.clone(), app.clone());
            tauri::async_runtime::spawn(async move {
                let worker_repo = job_repo.clone();
                let outcome = tauri::async_runtime::spawn_blocking(move || clone_now(&job_app, &worker_repo, name.as_deref())).await.map_err(|e| e.to_string()).and_then(|r| r);
                let home = crate::agent_usage_providers::home();
                let state = outcome.unwrap_or_else(|error| CloneState::Failed(phone_clone_error(&error, home.as_deref())));
                if matches!(state, CloneState::Done { existing: false, .. }) {
                    let _ = app.emit("sessions-changed", ());
                }
                let _ = with_clones(|clones| clones.finish(&job_repo, state, Instant::now()));
            });
            Ok(CloneState::Cloning.reply(&repo))
        })
    }
}

fn parse_clone(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(CloneRepo { repo: repo_param(params)?, name: folder_param(params)? }))
}

#[derive(Debug)]
struct CloneStatus {
    repo: String,
}

impl Run for CloneStatus {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let state = with_clones(|clones| clones.get(&self.repo, ctx.from, Instant::now()))?;
            Ok(match state {
                Some(state) => state.reply(&self.repo),
                None => json!({"repo": self.repo, "state": "unknown"}),
            })
        })
    }
}

fn parse_clone_status(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(CloneStatus { repo: repo_param(params)? }))
}

// ---- projects.recentRepos ----

/// One repository as the phone lists it; `projectId` when this computer already has it.
fn repo_row(repo: &github_hub::HubRepo, have: &HashMap<String, String>) -> Value {
    json!({
        "repo": repo.name_with_owner,
        "description": super::bounded_text(&repo.description, MAX_DESCRIPTION),
        "private": repo.private,
        "fork": repo.fork,
        "archived": repo.archived,
        "pushedAt": repo.pushed_at,
        "language": repo.language,
        "projectId": have.get(&repo.name_with_owner.to_ascii_lowercase()),
    })
}

#[derive(Debug)]
struct RecentRepos;

impl Run for RecentRepos {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let store = ctx.state().store.clone();
            crate::blocking(move || {
                let (projects, bots) = {
                    let store = store.lock().map_err(|e| e.to_string())?;
                    (store.projects()?, crate::bots::project_ids(&store)?)
                };
                let projects = repo_projects(projects, &bots);
                let mut have = HashMap::new();
                for (project, origin) in super::super::start::origins(projects) {
                    if let Some(origin) = origin {
                        have.entry(origin.to_ascii_lowercase()).or_insert(project.id);
                    }
                }
                let repos = github_hub::repos()?;
                let mut rows: Vec<Value> = repos.iter().filter(|r| !r.archived).take(MAX_REPOS).map(|r| repo_row(r, &have)).collect();
                while json!({"repos": rows}).to_string().len() > super::PAGE_BUDGET - 1024 && !rows.is_empty() {
                    rows.pop();
                }
                Ok(json!({"repos": rows}))
            })
            .await
        })
    }
}

// ---- chat.start ----

#[derive(Debug)]
struct ChatStart {
    /// Required: the start runs once per (viewer, id) on the never-expiring Start lane.
    start_id: String,
    prompt: String,
    provider: String,
    model: String,
    mode: Option<String>,
    effort: Option<String>,
    image_ids: Vec<String>,
}

/// Without "Full access for remote tasks" a remote start may not ask for Full access, and gets
/// Ask when it names no mode (as `host::cap_mode` does for `task.start`).
fn capped_mode(mode: Option<String>, full_access: bool) -> Result<Option<String>> {
    match mode {
        _ if full_access => Ok(mode),
        Some(mode) if mode == "full" => Err(super::full_access_off()),
        Some(mode) => Ok(Some(mode)),
        None => Ok(Some("ask".into())),
    }
}

impl Run for ChatStart {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let start = *self;
            let (app, from, full_access) = (ctx.app.clone(), ctx.from.to_owned(), ctx.full_access);
            // Once per (viewer, startId), like `task.start`: a retry after a lost reply makes no
            // second chat, `task.startStatus` follows it and a panicked start still settles.
            let id = start.start_id.clone();
            super::super::host::start_keyed(ctx.from, &id, move |cancel| async move { start_chat(&app, &from, full_access, start, &cancel).await }).await
        })
    }
}

/// Makes the chat and sends its prompt. Nothing is made after a `task.cancelStart`.
async fn start_chat(app: &tauri::AppHandle, from: &str, full_access: bool, start: ChatStart, cancel: &super::super::start::Cancel) -> Result<Value> {
    let mode = capped_mode(start.mode, full_access)?;
    // Before anything is made: the images must be ones this caller just sent. Until the
    // prompt takes them, a failure gives them back so a retry finds them.
    super::super::images::claim(app, from, &start.image_ids)?;
    let made = async {
        super::super::start::require_installed(&start.provider).await?;
        // From here the chat is made, so a cancel arriving now is answered "too late".
        cancel.commit()?;
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let task = crate::chats::create(&store, &crate::chats::root(), &start.provider, &start.model, mode.as_deref(), full_access)?;
        if start.effort.is_some() {
            store.set_reasoning_effort(&task.id, start.effort.as_deref())?;
        }
        Ok::<_, String>(task)
    }
    .await;
    let task = match made {
        Ok(task) => task,
        Err(error) => {
            super::super::images::restore(app, from, &start.image_ids);
            return Err(error);
        }
    };
    let state = app.state::<AppState>();
    // The caller mirrors the chat from its first event.
    super::super::host::follow(app, from, &task.id);
    let _ = app.emit("sessions-changed", ());
    if let Err(error) = crate::send_message(app.clone(), state, task.id.clone(), start.prompt, Some(start.image_ids), None).await {
        // The chat is made: answer with it, so the phone can open it (Round 11).
        let _ = app.emit("sessions-changed", ());
        let mut reply = super::super::start::made_but_not_sent(&task.id, error);
        reply["projectId"] = json!(task.project_id);
        return Ok(reply);
    }
    Ok(json!({"sessionId": task.id, "projectId": task.project_id}))
}

fn parse_chat_start(params: &Value) -> Result<Box<dyn Run>> {
    let start_id = name_param(params, "startId")?.ok_or("Missing startId.")?;
    super::valid_id(&start_id).map_err(|_| "Invalid startId.")?;
    Ok(Box::new(ChatStart {
        start_id,
        prompt: text_param(params, "prompt")?,
        provider: name_param(params, "provider")?.ok_or("Missing provider.")?,
        model: name_param(params, "model")?.ok_or("Missing model.")?,
        mode: name_param(params, "mode")?,
        effort: name_param(params, "effort")?,
        image_ids: super::super::images::ids_param(params)?,
    }))
}

pub(crate) const METHODS: &[Method] = &[
    Method { name: "chat.start", access: Access::Full, read_only: false, parse: parse_chat_start },
    Method { name: "projects.clone", access: Access::Full, read_only: false, parse: parse_clone },
    Method { name: "projects.cloneStatus", access: Access::View, read_only: true, parse: parse_clone_status },
    // Full (Round 20): it lists every private repository, and only serves `projects.clone`.
    Method { name: "projects.recentRepos", access: Access::Full, read_only: true, parse: |_| Ok(Box::new(RecentRepos)) },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phone_clone_needs_the_full_access_switch() {
        let source = include_str!("projects.rs");
        let body = &source[source.find("impl Run for CloneRepo").unwrap()..];
        let refusal = body.find("refuse_clone(crate::workspace::Trust::phone(ctx.full_access))").expect("projects.clone checks the switch");
        assert!(refusal < body.find("clones.begin(").unwrap(), "refused before any clone is claimed");
        assert_eq!(
            super::super::super::start::refuse_clone(crate::workspace::Trust::phone(false)).unwrap_err(),
            "Turn on Full access for remote tasks on this computer to clone a repository from the phone."
        );
        assert!(super::super::super::start::refuse_clone(crate::workspace::Trust::phone(true)).is_ok());
        assert!(super::super::SWITCH_METHODS.contains(&"projects.clone"));
    }

    #[test]
    fn a_chat_start_that_fails_before_using_its_images_gives_them_back() {
        let source = include_str!("projects.rs");
        let body = &source[source.find("async fn start_chat").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let claim = body.find("images::claim(app, from, &start.image_ids)").unwrap();
        let restore = body.find("images::restore(app, from, &start.image_ids)").expect("restored on failure");
        assert!(claim < restore && restore < body.find("crate::send_message(").unwrap());
    }

    /// Round 11: a chat made before its message failed is answered (and remembered) with its
    /// session; recent repos never map a repository to a chat folder.
    #[test]
    fn a_failed_chat_message_keeps_the_chat_and_recent_repos_skip_chat_folders() {
        let source = include_str!("projects.rs");
        let body = &source[source.find("async fn start_chat").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(!body.contains("None).await?;"), "a send failure no longer drops the made chat");
        assert!(body.find("crate::send_message(").unwrap() < body.find("made_but_not_sent(&task.id, error)").unwrap());
        let recent = &source[source.find("impl Run for RecentRepos").unwrap()..];
        assert!(recent[..recent.find("\n}\n").unwrap()].contains("repo_projects(projects, &bots)"));
        let project = |id: &str, path: std::path::PathBuf| crate::storage::Project { id: id.into(), name: id.into(), path: path.to_string_lossy().into_owned(), added_order: 0, remote_device: None, remote_project: None };
        let chat = crate::chats::root().join("some-chat");
        let kept = repo_projects(
            vec![project("repo", std::env::temp_dir().join("pandacode-repo")), project("bot", std::env::temp_dir().join("pandacode-bot")), project("chat", chat)],
            &["bot".to_owned()],
        );
        assert_eq!(kept.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["repo"]);
    }

    fn parsed(name: &str, params: Value) -> Result<String> {
        super::super::parse(name, &params).expect("registered").map(|p| format!("{:?}", p.call))
    }

    #[test]
    fn methods_have_the_right_access() {
        for (name, access, read_only) in [
            ("chat.start", Access::Full, false),
            ("projects.clone", Access::Full, false),
            ("projects.cloneStatus", Access::View, true),
            ("projects.recentRepos", Access::Full, true),
        ] {
            let method = super::super::find(name).unwrap();
            assert_eq!((method.access, method.read_only), (access, read_only), "{name}");
        }
        assert_eq!(super::super::super::grants::method_access("projects.recentRepos"), "full", "a View or Control device never lists private repositories");
    }

    #[test]
    fn repos_are_owner_and_name_or_a_github_link_never_a_path() {
        let repo = |value: Value| repo_param(&json!({"repo": value}));
        assert_eq!(repo(json!("octo/hello")).unwrap(), "octo/hello");
        assert_eq!(repo(json!(" octo/hello ")).unwrap(), "octo/hello");
        assert_eq!(repo(json!("https://github.com/octo/hello.git")).unwrap(), "octo/hello");
        assert_eq!(repo(json!("https://github.com/octo/hello/")).unwrap(), "octo/hello");
        assert_eq!(repo(json!("git@github.com:octo/hello.git")).unwrap(), "octo/hello");
        for bad in ["/Users/me/code", "~/code", "../x", "octo", "octo/hello/extra", "-x/y", "octo/..", "https://gitlab.com/octo/hello", "file:///etc/passwd", "https://github.com/octo/hello/tree/main", "octo/he llo", ""] {
            assert!(repo(json!(bad)).is_err(), "{bad}");
        }
        assert!(repo(json!(3)).is_err());
        assert!(repo_param(&json!({})).is_err());
    }

    #[test]
    fn folder_names_are_single_safe_names() {
        let folder = |value: Value| folder_param(&json!({"name": value}));
        assert_eq!(folder(json!("my-app")).unwrap().as_deref(), Some("my-app"));
        assert_eq!(folder_param(&json!({})).unwrap(), None);
        assert_eq!(folder(Value::Null).unwrap(), None);
        for bad in ["", ".git", "..", "a/b", "a\\b", "-rf", "a..b", "x y", &"a".repeat(101)] {
            assert!(folder(json!(bad)).is_err(), "{bad}");
        }
        assert!(parsed("projects.clone", json!({"repo": "octo/hello", "name": "../../etc"})).is_err());
        assert!(parsed("projects.clone", json!({"repo": "octo/hello", "path": "/tmp"})).unwrap().contains("octo/hello"));
        assert!(parsed("projects.cloneStatus", json!({"repo": "nope"})).is_err());
    }

    #[test]
    fn clones_land_in_the_pandacode_folder_under_a_free_name() {
        let home = Path::new("/home/me");
        assert_eq!(clone_destination(home, "octo/hello", None, |_| Ok(true)).unwrap(), Path::new("/home/me/PandaCode/hello"));
        assert_eq!(clone_destination(home, "octo/hello", Some("site"), |_| Ok(true)).unwrap(), Path::new("/home/me/PandaCode/site"));
        let free = |path: &Path| Ok(!(path.ends_with("hello") || path.ends_with("hello-2")));
        assert_eq!(clone_destination(home, "octo/hello", None, free).unwrap(), Path::new("/home/me/PandaCode/hello-3"));
        assert!(clone_destination(home, "octo/hello", None, |_| Ok(false)).is_err(), "bounded");
        assert!(clone_destination(home, "octo/hello", None, |_| Err("disk".into())).is_err());
    }

    /// Round 7: clones of `a/x` and `b/x` started together each claim their own folder, and the
    /// one that fails removes only its own.
    #[test]
    fn concurrent_clones_of_the_same_name_claim_separate_folders() {
        let home = std::env::temp_dir().join(format!("pandacode-clone-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(home.join(CLONE_FOLDER)).unwrap();
        let first = clone_destination(&home, "a/x", None, claim_folder).unwrap();
        let second = clone_destination(&home, "b/x", None, claim_folder).unwrap();
        assert_eq!(first, home.join(CLONE_FOLDER).join("x"));
        assert_eq!(second, home.join(CLONE_FOLDER).join("x-2"));
        std::fs::write(first.join("README"), "a/x's clone").unwrap();
        // The second clone fails and cleans up what it created.
        std::fs::remove_dir_all(&second).unwrap();
        assert!(first.join("README").is_file(), "the other clone's folder is untouched");
        let source = include_str!("projects.rs");
        let clone_now = &source[source.find("fn clone_now(").unwrap()..];
        let clone_now = &clone_now[..clone_now.find("\n}\n").unwrap()];
        assert!(clone_now.contains("claim_folder)?") && !clone_now.contains("Path::exists"), "clone_now claims its folder");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_running_clone_is_joined_and_outcomes_are_remembered_for_a_while() {
        let now = Instant::now();
        let mut clones = Clones::default();
        assert_eq!(clones.begin("Octo/Hello", "d1", now).unwrap(), None);
        assert_eq!(clones.begin("octo/hello", "d1", now).unwrap(), Some(CloneState::Cloning));
        assert_eq!(clones.begin("a/one", "d1", now).unwrap(), None);
        assert_eq!(clones.begin("a/two", "d1", now).unwrap(), None);
        assert!(clones.begin("a/three", "d1", now).is_err(), "at most {MAX_RUNNING} at once");
        clones.finish("octo/hello", CloneState::Done { project_id: "p1".into(), existing: false }, now);
        assert_eq!(clones.get("OCTO/hello", "d1", now), Some(CloneState::Done { project_id: "p1".into(), existing: false }));
        assert_eq!(clones.get("octo/hello", "d1", now + CLONE_MEMORY + Duration::from_secs(1)), None);
        assert_eq!(clones.get("a/one", "d1", now + CLONE_MEMORY * 2), Some(CloneState::Cloning), "a running clone is never forgotten");
        // A failed clone may be tried again.
        clones.finish("a/one", CloneState::Failed("no".into()), now);
        assert_eq!(clones.begin("a/one", "d1", now).unwrap(), None);
        assert_eq!(CloneState::Failed("boom".into()).reply("a/b"), json!({"repo": "a/b", "state": "failed", "error": "boom"}));
    }

    /// Round 19: only the devices that asked for a clone see its outcome.
    #[test]
    fn a_clone_status_is_scoped_to_the_devices_that_asked() {
        let now = Instant::now();
        let mut clones = Clones::default();
        assert_eq!(clones.begin("octo/x", "d1", now).unwrap(), None);
        assert_eq!(clones.get("octo/x", "d2", now), None, "another phone never sees it");
        assert_eq!(clones.begin("octo/x", "d2", now).unwrap(), Some(CloneState::Cloning), "it joins the running clone");
        clones.finish("octo/x", CloneState::Failed("no".into()), now);
        for device in ["d1", "d2"] {
            assert_eq!(clones.get("octo/x", device, now), Some(CloneState::Failed("no".into())), "{device}");
        }
        assert_eq!(clones.get("octo/x", "d3", now), None);
    }

    /// Round 19: a clone failure never names a local path.
    #[test]
    fn clone_errors_hide_local_paths() {
        let home = Path::new("/Users/someone");
        let raw = "fatal: could not create work tree dir '/Users/someone/PandaCode/x': Permission denied";
        let shown = phone_clone_error(raw, Some(home));
        assert_eq!(shown, "fatal: could not create work tree dir '~/PandaCode/x': Permission denied");
        assert!(phone_clone_error("GraphQL: Could not resolve to a Repository with the name 'a/b'. /Users/someone/x", Some(home)).starts_with("That repository was not found"));
        assert!(phone_clone_error("gh timed out after 600s in /Users/someone/PandaCode", Some(home)).starts_with("The download took too long"));
        assert!(phone_clone_error("To get started with GitHub CLI, please run:  gh auth login", Some(home)).starts_with("Sign in to GitHub"));
        let long = phone_clone_error(&"é".repeat(400), Some(home));
        assert!(long.len() <= MAX_CLONE_ERROR + '…'.len_utf8() && long.ends_with('…'));
        // Every failure the phone sees goes through `phone_clone_error`.
        let source = include_str!("projects.rs");
        let code = &source[..source.find("#[cfg(test)]").unwrap()];
        assert_eq!(code.matches("CloneState::Failed(").count(), 1);
        assert!(code.contains("CloneState::Failed(phone_clone_error(&error, home.as_deref()))"));
    }

    #[test]
    fn chat_starts_are_validated_and_capped() {
        let ok = json!({"prompt": "Hi", "provider": "claude", "model": "default", "startId": "st-1"});
        assert!(parsed("chat.start", ok.clone()).is_ok());
        for (key, bad) in [("prompt", json!("  ")), ("provider", Value::Null), ("model", json!("")), ("startId", json!("a b")), ("startId", Value::Null), ("imageIds", json!("x"))] {
            let mut params = ok.clone();
            params[key] = bad;
            assert!(parsed("chat.start", params).is_err(), "{key}");
        }
        assert_eq!(capped_mode(None, false).unwrap().as_deref(), Some("ask"));
        assert!(capped_mode(Some("full".into()), false).is_err());
        assert_eq!(capped_mode(Some("full".into()), true).unwrap().as_deref(), Some("full"));
        assert_eq!(capped_mode(None, true).unwrap(), None);
    }

    #[test]
    fn repo_rows_carry_no_paths_and_mark_repos_already_here() {
        let repo = github_hub::HubRepo { name_with_owner: "Octo/Hello".into(), description: "d".repeat(500), private: true, fork: false, archived: false, pushed_at: "2026-01-01T00:00:00Z".into(), url: "https://github.com/Octo/Hello".into(), default_branch: "main".into(), open_issues: 0, language: "Rust".into() };
        let have = HashMap::from([("octo/hello".to_owned(), "p1".to_owned())]);
        let row = repo_row(&repo, &have);
        assert_eq!(row["projectId"], "p1");
        assert!(row["description"].as_str().unwrap().len() < 260);
        assert_eq!(repo_row(&repo, &HashMap::new())["projectId"], Value::Null);
    }

    /// chat.start goes through `host::start_keyed`: once per (viewer, startId), seen by
    /// `task.startStatus`, and settled even when the start panics.
    #[test]
    fn chat_starts_run_once_per_start_id_and_always_settle() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use super::super::super::host::{start_keyed as host, start_status_of as status};
        let viewer = format!("viewer-{}", uuid::Uuid::new_v4());
        let runs = Arc::new(AtomicUsize::new(0));
        let chat = |runs: Arc<AtomicUsize>| {
            move |_cancel| async move {
                runs.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"sessionId": "c1", "projectId": "chats"}))
            }
        };
        let (first, again) = tauri::async_runtime::block_on(async { (host(&viewer, "chat-1", chat(runs.clone())).await, host(&viewer, "chat-1", chat(runs.clone())).await) });
        assert_eq!(first, Ok(json!({"sessionId": "c1", "projectId": "chats"})));
        assert_eq!(again, first, "a retry after a lost reply makes no second chat");
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert_eq!(status(&viewer, "chat-1")["state"], "done");
        assert_eq!(status(&viewer, "chat-1")["sessionId"], "c1");
        let panicked = tauri::async_runtime::block_on(host(&viewer, "chat-2", |_cancel| async move {
            if true {
                panic!("the start broke");
            }
            Ok(Value::Null)
        }));
        assert!(panicked.is_err());
        assert_eq!(status(&viewer, "chat-2")["state"], "failed", "never left running");
    }
}
