//! PandaConnect methods for the `git` feature group: the task's checkout status, staging,
//! committing and pushing, branches, the task's worktree, opening a pull request, and the
//! per-turn change summaries. See `methods/mod.rs` and docs/remote-access.md, "Adding a method".
//!
//! Every call is task-scoped: the checkout is the task's own (its worktree when it has one),
//! found through `task_root`/`workspace_task` (bot workspaces refused, Round 19), and the work is done by the desktop's own commands
//! in `lib.rs` (which run `git`/`gh` through `workspace::run_process`).
use super::super::host::{workspace_session_from, workspace_task};
use super::{allow_task_mode, id_param, name_param, path_param, task_root, Access, Ctx, Method, Reply, Run, PAGE_BUDGET};
use crate::workspace::Trust;
use crate::Result;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// Files one `git.stage` call may name.
const MAX_STAGE_PATHS: usize = 500;
/// A commit message's limit, as `workspace::git_commit` enforces.
const MAX_COMMIT_MESSAGE: usize = 16 * 1024;
/// A pull request title's limit, as `github::create_pull_request_as` enforces (characters).
const MAX_PULL_TITLE: usize = 256;
const MAX_PULL_BODY: usize = 64 * 1024;
/// A turn diff's patch budget, leaving room for the envelope.
const TURN_PATCH_BUDGET: usize = PAGE_BUDGET - 4 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const RUNNING: &str = "Wait for the agent to finish first.";

pub(crate) const METHODS: &[Method] = &[
    Method { name: "git.status", access: Access::View, read_only: true, parse: parse_status },
    Method { name: "git.stage", access: Access::Control, read_only: false, parse: parse_stage },
    Method { name: "git.discard", access: Access::Control, read_only: false, parse: parse_discard },
    Method { name: "git.commit", access: Access::Full, read_only: false, parse: parse_commit },
    Method { name: "git.push", access: Access::Full, read_only: false, parse: parse_push },
    Method { name: "git.branches", access: Access::View, read_only: true, parse: parse_branches },
    Method { name: "git.switchBranch", access: Access::Full, read_only: false, parse: parse_switch },
    Method { name: "worktree.status", access: Access::View, read_only: true, parse: parse_worktree_status },
    Method { name: "worktree.merge", access: Access::Full, read_only: false, parse: parse_worktree_merge },
    Method { name: "worktree.remove", access: Access::Full, read_only: false, parse: parse_worktree_remove },
    Method { name: "worktree.create", access: Access::Full, read_only: false, parse: parse_worktree_create },
    Method { name: "pull.create", access: Access::Full, read_only: false, parse: parse_pull_create },
    Method { name: "turn.summary", access: Access::View, read_only: true, parse: parse_turn_summary },
    Method { name: "turn.diff", access: Access::View, read_only: true, parse: parse_turn_diff },
];

// ---- params ----

fn session(params: &Value) -> Result<String> {
    id_param(params, "sessionId")
}

fn bool_param(params: &Value, key: &str) -> Result<bool> {
    match params.get(key).filter(|value| !value.is_null()) {
        None => Ok(false),
        Some(value) => value.as_bool().ok_or_else(|| format!("Invalid {key}.")),
    }
}

/// A local branch name: printable, never read as an option or a range.
fn branch_param(params: &Value, key: &str) -> Result<Option<String>> {
    let Some(branch) = name_param(params, key)? else { return Ok(None) };
    if branch.starts_with('-') || branch.contains("..") {
        return Err(format!("Invalid {key}."));
    }
    Ok(Some(branch))
}

/// Free text with a byte limit; trimmed; `required` refuses an empty value.
fn bounded_param(params: &Value, key: &str, max: usize, required: bool) -> Result<String> {
    let text = match params.get(key).filter(|value| !value.is_null()) {
        None => "",
        Some(value) => value.as_str().ok_or_else(|| format!("Invalid {key}."))?,
    };
    let text = text.trim();
    if text.contains('\0') || text.len() > max {
        return Err(format!("Invalid {key}."));
    }
    if required && text.is_empty() {
        return Err(format!("Missing {key}."));
    }
    Ok(text.to_owned())
}

/// The repository-relative files to stage; each passes `path_param` (no `..`, no `.git`).
fn paths_param(params: &Value) -> Result<Vec<String>> {
    let list = params.get("paths").and_then(Value::as_array).ok_or("Missing paths.")?;
    if list.is_empty() || list.len() > MAX_STAGE_PATHS {
        return Err(format!("Select 1 to {MAX_STAGE_PATHS} files."));
    }
    list.iter().map(|path| path_param(&json!({ "path": path }), "path")?.ok_or_else(|| "Invalid paths.".to_owned())).collect()
}

fn message_id_param(params: &Value) -> Result<i64> {
    params.get("messageId").and_then(Value::as_i64).filter(|id| *id > 0).ok_or_else(|| "Invalid messageId.".into())
}

// ---- shared ----

fn is_running(ctx: &Ctx<'_>, session_id: &str) -> Result<bool> {
    Ok(ctx.state().agents.lock().map_err(|e| e.to_string())?.contains_key(session_id))
}

/// Refuses while any agent works in `root` (`files.rs`' `running_in`), not only this task's.
async fn refuse_running_here(ctx: &Ctx<'_>, root: &Path) -> Result<()> {
    if super::files::running_in(ctx, root).await? {
        return Err(RUNNING.into());
    }
    Ok(())
}

// ---- one change at a time per checkout ----

/// A lock per checkout folder. git.commit, git.push, worktree.merge and worktree.remove run on
/// the Background lane (beside the Ordered one), so without it two calls could change one
/// checkout at once (an index.lock clash, a push of half a commit, a merge over a switch).
fn checkout_locks() -> &'static StdMutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>> {
    static LOCKS: OnceLock<StdMutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(Default::default)
}

/// Held while a call changes these checkouts; dropping it lets the next call in.
#[must_use]
struct CheckoutGuard(#[allow(dead_code)] Vec<OwnedMutexGuard<()>>);

/// The lock for each checkout in `roots`, sorted so two callers never wait on each other.
fn checkout_lock_list(mut roots: Vec<PathBuf>) -> Vec<Arc<AsyncMutex<()>>> {
    roots.sort();
    roots.dedup();
    let mut table = checkout_locks().lock().unwrap_or_else(|e| e.into_inner());
    table.retain(|_, lock| lock.strong_count() > 0);
    roots
        .into_iter()
        .map(|root| {
            if let Some(lock) = table.get(&root).and_then(Weak::upgrade) {
                return lock;
            }
            let lock = Arc::new(AsyncMutex::new(()));
            table.insert(root, Arc::downgrade(&lock));
            lock
        })
        .collect()
}

/// Waits for each checkout in `roots` in turn (sorted, so two callers never wait on each other).
async fn lock_checkouts(roots: Vec<PathBuf>) -> CheckoutGuard {
    let locks = checkout_lock_list(roots);
    let mut guards = Vec::with_capacity(locks.len());
    for lock in locks {
        guards.push(lock.lock_owned().await);
    }
    CheckoutGuard(guards)
}

/// Why an Ordered-lane git call is refused while a Background one holds the checkout.
const CHECKOUT_BUSY: &str = "Another git change is running on this checkout — try again in a moment.";

/// Takes each checkout in `roots` without waiting, or refuses with [`CHECKOUT_BUSY`]. For calls
/// on the Ordered lane: waiting there behind a background push or merge would hold up Stop.
fn try_lock_checkouts(roots: Vec<PathBuf>) -> Result<CheckoutGuard> {
    let locks = checkout_lock_list(roots);
    let mut guards = Vec::with_capacity(locks.len());
    for lock in locks {
        guards.push(lock.try_lock_owned().map_err(|_| CHECKOUT_BUSY.to_owned())?);
    }
    Ok(CheckoutGuard(guards))
}

/// The task's checkout (its worktree when it has one); with `project` the project's own
/// checkout too, for a worktree merge or removal that changes both.
async fn task_checkouts(ctx: &Ctx<'_>, session_id: &str, project_id: &str, project: bool) -> Result<Vec<PathBuf>> {
    let mut roots = Vec::new();
    match task_root(&ctx.state(), session_id).await {
        Ok(root) => roots.push(root),
        Err(error) if !project => return Err(error),
        Err(_) => {}
    }
    if project {
        let store = ctx.state().store.clone();
        let id = project_id.to_owned();
        roots.push(crate::blocking(move || store.lock().map_err(|e| e.to_string())?.workspace_root(&id, None)).await?);
    }
    Ok(roots)
}

/// Locks the task's checkouts ([`task_checkouts`]), waiting for any call holding them.
async fn lock_task_checkout(ctx: &Ctx<'_>, session_id: &str, project_id: &str, project: bool) -> Result<CheckoutGuard> {
    Ok(lock_checkouts(task_checkouts(ctx, session_id, project_id, project).await?).await)
}

/// Locks the task's own checkout without waiting ([`try_lock_checkouts`]).
async fn try_lock_task_checkout(ctx: &Ctx<'_>, session_id: &str, project_id: &str) -> Result<CheckoutGuard> {
    try_lock_checkouts(task_checkouts(ctx, session_id, project_id, false).await?)
}

/// The [`Trust`] every workspace Git helper gets for this phone call: hooks run and the
/// checkout's config is read as the desktop reads it only while the host's "Full access for
/// remote tasks" switch is on (docs/remote-access.md, Round-9 gates).
fn trust_of(ctx: &Ctx<'_>) -> Trust {
    Trust::phone(ctx.full_access)
}

/// Staging runs the checkout's clean filters and a branch switch its smudge filters, so with the
/// switch off they refuse a repository whose own config is not all on the allowlist
/// (`workspace::refuse_repo_config_programs`). Commits, pushes, merges and pull requests check
/// the same inside `workspace` / `push_and_open_pull` whenever hooks are skipped.
/// `action` names the request in the refusal ("stage files", "switch branches").
async fn refuse_config_programs(ctx: &Ctx<'_>, session_id: &str, action: &'static str) -> Result<()> {
    if !trust_of(ctx).untrusted() {
        return Ok(());
    }
    let root = task_root(&ctx.state(), session_id).await?;
    crate::blocking(move || crate::workspace::refuse_repo_config_programs_for(&root, action)).await
}

fn changed(ctx: &Ctx<'_>) {
    let _ = ctx.app.emit("sessions-changed", ());
}

/// A read-only Git call through `workspace::git_inspect`: hooks skipped and, with the switch
/// off, the checkout's filters, lazy fetches, credential helpers and askpass switched off.
fn git(root: &Path, args: &[&str], trust: Trust) -> Result<Option<String>> {
    let output = crate::workspace::git_inspect(root, args, 8192, GIT_TIMEOUT, trust)?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&crate::workspace::checked(output)?.bytes).trim().to_owned()))
}

/// The branch's upstream and how far apart they are, or None without an upstream.
fn upstream(root: &Path, trust: Trust) -> Result<Option<(String, u64, u64)>> {
    let Some(name) = git(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], trust)?.filter(|name| !name.is_empty()) else { return Ok(None) };
    let counts = git(root, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], trust)?.unwrap_or_default();
    let (ahead, behind) = parse_counts(&counts).unwrap_or((0, 0));
    Ok(Some((name, ahead, behind)))
}

fn parse_counts(text: &str) -> Option<(u64, u64)> {
    let mut parts = text.split_whitespace();
    let counts = (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?);
    parts.next().is_none().then_some(counts)
}

/// Splits porcelain entries into staged, unstaged and untracked lists.
fn classify(files: Vec<crate::workspace::GitFile>) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
    let (mut staged, mut unstaged, mut untracked) = (Vec::new(), Vec::new(), Vec::new());
    for file in files {
        if file.index == "?" {
            untracked.push(json!(file.path));
            continue;
        }
        if file.index != " " && file.index != "!" {
            let mut entry = json!({"path": file.path, "status": file.index});
            if let (Some(orig), "R" | "C") = (&file.orig_path, file.index.as_str()) {
                // A staged rename's source: discarding the new path restores it.
                entry["origPath"] = json!(orig);
            }
            staged.push(entry);
        }
        if file.working != " " && file.working != "!" {
            unstaged.push(json!({"path": file.path, "status": file.working}));
        }
    }
    (staged, unstaged, untracked)
}

/// Every list cut to a third of the page budget; `truncated` says so.
fn fit_lists(lists: [&mut Vec<Value>; 3]) -> bool {
    let mut truncated = false;
    for list in lists {
        let before = list.len();
        super::super::host::fit_list(list, PAGE_BUDGET / 3 - 2048);
        truncated |= list.len() < before;
    }
    truncated
}

fn link_json(link: &crate::storage::TaskLink) -> Value {
    json!({"number": link.number, "url": link.url, "title": link.title, "state": link.state})
}

// ---- git.status ----

#[derive(Debug, PartialEq)]
struct Status {
    session_id: String,
}

impl Run for Status {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let task = workspace_task(&ctx.state(), &self.session_id).await?;
            let root = task_root(&ctx.state(), &self.session_id).await?;
            let running = is_running(&ctx, &self.session_id)?;
            let trust = trust_of(&ctx);
            let mut reply = crate::blocking(move || {
                let status = status_for(&root, trust)?;
                if !status.is_repo {
                    return Ok(json!({"isRepo": false, "branch": "", "upstream": null, "ahead": 0, "behind": 0, "staged": [], "unstaged": [], "untracked": [], "truncated": false}));
                }
                let upstream = upstream(&root, trust)?;
                let (mut staged, mut unstaged, mut untracked) = classify(status.files);
                let truncated = fit_lists([&mut staged, &mut unstaged, &mut untracked]);
                let (name, ahead, behind) = upstream.map_or((None, 0, 0), |(name, ahead, behind)| (Some(name), ahead, behind));
                Ok(json!({
                    "isRepo": true, "branch": status.branch, "upstream": name, "ahead": ahead, "behind": behind,
                    "staged": staged, "unstaged": unstaged, "untracked": untracked, "truncated": truncated,
                }))
            })
            .await?;
            reply["running"] = json!(running);
            reply["title"] = json!(task.title);
            reply["worktree"] = json!(task.worktree_path.is_some());
            reply["pull"] = task.pull_request.as_ref().map_or(Value::Null, link_json);
            Ok(reply)
        })
    }
}

/// The checkout's status for a phone (`workspace::git_status` with the phone's [`Trust`]).
fn status_for(root: &Path, trust: Trust) -> Result<crate::workspace::GitStatus> {
    crate::workspace::git_status(root, trust)
}

fn parse_status(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Status { session_id: session(params)? }))
}

// ---- git.stage ----

#[derive(Debug, PartialEq)]
struct Stage {
    session_id: String,
    /// None: every file that can move the requested way.
    paths: Option<Vec<String>>,
    unstage: bool,
}

/// The files `git.stage {all}` moves: unstaged and untracked ones to stage, staged ones to unstage.
fn all_paths(files: Vec<crate::workspace::GitFile>, unstage: bool) -> Vec<String> {
    let mut paths: Vec<String> = files
        .into_iter()
        .filter(|file| if unstage { file.index != " " && file.index != "?" && file.index != "!" } else { file.index == "?" || (file.working != " " && file.working != "!") })
        .map(|file| file.path)
        .collect();
    paths.dedup();
    paths
}

impl Run for Stage {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let task = workspace_task(&ctx.state(), &self.session_id).await?;
            // Ordered lane: never queue behind a background commit or push.
            let _checkout = try_lock_task_checkout(&ctx, &self.session_id, &task.project_id).await?;
            // Before any status too: listing the files to stage can run the checkout's filters.
            refuse_config_programs(&ctx, &self.session_id, "stage files").await?;
            let Some(paths) = self.paths else {
                let root = task_root(&ctx.state(), &self.session_id).await?;
                let (unstage, trust) = (self.unstage, trust_of(&ctx));
                let (count, skipped) = crate::blocking(move || stage_all_in(&root, unstage, trust)).await?;
                return Ok(json!({"count": count, "skipped": skipped}));
            };
            let count = paths.len();
            crate::stage_files(&ctx.state(), &task.project_id, Some(&self.session_id), paths, !self.unstage, trust_of(&ctx)).await?;
            Ok(json!({"count": count}))
        })
    }
}

/// `git.stage {all}`: every file that can move, without the folder and gitlink rows Git
/// cannot stage one file at a time (counted as skipped), in chunks. Answers (moved, skipped).
fn stage_all_in(root: &Path, unstage: bool, trust: Trust) -> Result<(usize, usize)> {
    let listed = all_paths(crate::workspace::git_status_all(root, trust)?.files, unstage);
    let (paths, skipped) = crate::workspace::folder_free(root, listed);
    // Never a hard link into Git: the whole call is refused, naming the file.
    if !unstage {
        refuse_linked_in_all(root, &paths)?;
    }
    if paths.is_empty() {
        return Ok((0, skipped));
    }
    let count = paths.len();
    crate::workspace::git_stage_all(root, paths, !unstage, trust)?;
    Ok((count, skipped))
}

/// Refuses a `git.stage {all}` that would stage a hard-linked file, naming it
/// (`workspace::git_stage` refuses named ones with `HARD_LINK_REFUSED`).
fn refuse_linked_in_all(root: &Path, paths: &[String]) -> Result<()> {
    match paths.iter().find(|path| crate::workspace::hard_linked(&root.join(path))) {
        Some(path) => Err(crate::workspace::hard_link_refused_named(path, "stage")),
        None => Ok(()),
    }
}

fn parse_stage(params: &Value) -> Result<Box<dyn Run>> {
    let all = bool_param(params, "all")?;
    let paths = match (all, params.get("paths").filter(|value| !value.is_null())) {
        (true, None) => None,
        (false, Some(_)) => Some(paths_param(params)?),
        (true, Some(_)) => return Err("Use paths or all, not both.".into()),
        (false, None) => return Err("Missing paths.".into()),
    };
    Ok(Box::new(Stage { session_id: session(params)?, paths, unstage: bool_param(params, "unstage")? }))
}

// ---- git.discard ----

/// `git.discard { sessionId, paths, skipFolders? }`: restores tracked files from HEAD and deletes
/// the untracked files it names (`workspace::git_discard`). Idempotent: a retry finds nothing left
/// to discard. `skipFolders` (Discard all) leaves folder and gitlink rows out, counted in
/// `skipped`, instead of refusing the batch; without it a named folder is refused.
#[derive(Debug, PartialEq)]
struct Discard {
    session_id: String,
    paths: Vec<String>,
    skip_folders: bool,
}

impl Run for Discard {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let task = workspace_task(&ctx.state(), &self.session_id).await?;
            allow_task_mode(&task.mode, None, ctx.full_access)?;
            let root = task_root(&ctx.state(), &self.session_id).await?;
            // Any agent working in this checkout (another task sharing a main checkout too), as
            // `files.write` refuses.
            refuse_running_here(&ctx, &root).await?;
            // Ordered lane: never queue behind a background commit or push.
            let _checkout = try_lock_task_checkout(&ctx, &self.session_id, &task.project_id).await?;
            refuse_running_here(&ctx, &root).await?;
            let (paths, skip_folders, trust) = (self.paths, self.skip_folders, trust_of(&ctx));
            let (count, skipped) = crate::blocking(move || discard_batch_in(&root, paths, skip_folders, trust)).await?;
            changed(&ctx);
            Ok(json!({"count": count, "skipped": skipped}))
        })
    }
}

/// The phone's discard, always through the change gate with the phone's [`Trust`].
fn discard_in(root: &Path, paths: Vec<String>, trust: Trust) -> Result<usize> {
    crate::workspace::git_discard(root, paths, trust)
}

/// [`discard_in`], first leaving folder and gitlink rows out when `skip_folders`. Answers
/// (discarded, skipped).
fn discard_batch_in(root: &Path, paths: Vec<String>, skip_folders: bool, trust: Trust) -> Result<(usize, usize)> {
    let (paths, skipped) = if skip_folders { crate::workspace::folder_free(root, paths) } else { (paths, 0) };
    if paths.is_empty() {
        return Ok((0, skipped));
    }
    Ok((discard_in(root, paths, trust)?, skipped))
}

fn parse_discard(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Discard { session_id: session(params)?, paths: paths_param(params)?, skip_folders: bool_param(params, "skipFolders")? }))
}

// ---- git.commit ----

#[derive(Debug, PartialEq)]
struct Commit {
    session_id: String,
    message: String,
    push: bool,
    /// A retry with the same id answers the first commit (`once_per_action`).
    send_id: Option<String>,
}

impl Run for Commit {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (send_id, target) = (self.send_id.clone(), self.session_id.clone());
            super::once_per_action(ctx.from, "git.commit", &target, send_id.as_deref(), commit(ctx, *self)).await
        })
    }
}

/// `git.commit` itself.
async fn commit(ctx: Ctx<'_>, this: Commit) -> Result<Value> {
    let task = workspace_task(&ctx.state(), &this.session_id).await?;
    let root = task_root(&ctx.state(), &this.session_id).await?;
    // Any agent working in this checkout (another task sharing a main checkout too).
    refuse_running_here(&ctx, &root).await?;
    let _checkout = lock_task_checkout(&ctx, &this.session_id, &task.project_id, false).await?;
    // Again under the lock: an agent may have started while this call waited for it.
    refuse_running_here(&ctx, &root).await?;
    let trust = trust_of(&ctx);
    let commit_root = root.clone();
    let message = this.message;
    let output = crate::blocking(move || crate::workspace::git_commit(&commit_root, message, trust)).await?;
    let mut reply = json!({"output": super::bounded_text(&output, 4096), "pushed": false});
    if this.push {
        // The commit stands even when the push fails; the phone shows both.
        match crate::blocking(move || crate::workspace::git_push(&root, trust)).await {
            Ok(pushed) => {
                // The pull's "ahead" and checks are stale now: the Pull screen reads it again.
                super::invalidate_pull_cache(&this.session_id);
                reply["pushed"] = json!(true);
                reply["pushOutput"] = json!(super::bounded_text(&pushed, 4096));
            }
            Err(error) => reply["pushError"] = json!(error),
        }
    }
    changed(&ctx);
    Ok(reply)
}

fn parse_commit(params: &Value) -> Result<Box<dyn Run>> {
    let message = bounded_param(params, "message", MAX_COMMIT_MESSAGE, true).map_err(|_| "Write a commit message (up to 16 KB).".to_owned())?;
    Ok(Box::new(Commit { session_id: session(params)?, message, push: bool_param(params, "push")?, send_id: super::send_id_param(params)? }))
}

// ---- git.push ----

#[derive(Debug, PartialEq)]
struct Push {
    session_id: String,
}

impl Run for Push {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let task = workspace_task(&ctx.state(), &self.session_id).await?;
            let _checkout = lock_task_checkout(&ctx, &self.session_id, &task.project_id, false).await?;
            let trust = trust_of(&ctx);
            let root = task_root(&ctx.state(), &self.session_id).await?;
            let output = crate::blocking(move || crate::workspace::git_push(&root, trust)).await?;
            super::invalidate_pull_cache(&self.session_id);
            changed(&ctx);
            Ok(json!({"output": super::bounded_text(&output, 4096)}))
        })
    }
}

fn parse_push(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Push { session_id: session(params)? }))
}

// ---- git.branches / git.switchBranch ----

#[derive(Debug, PartialEq)]
struct Branches {
    session_id: String,
}

fn branches_reply(list: crate::workspace::BranchList, worktree: bool, running: bool) -> Result<Value> {
    let mut reply = serde_json::to_value(list).map_err(|e| e.to_string())?;
    reply["worktree"] = json!(worktree);
    reply["running"] = json!(running);
    Ok(reply)
}

impl Run for Branches {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let task = workspace_task(&ctx.state(), &self.session_id).await?;
            let running = is_running(&ctx, &self.session_id)?;
            let list = crate::task_branches(&ctx.state(), &task.project_id, Some(&self.session_id), trust_of(&ctx)).await?;
            branches_reply(list, task.worktree_path.is_some(), running)
        })
    }
}

fn parse_branches(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Branches { session_id: session(params)? }))
}

#[derive(Debug, PartialEq)]
struct SwitchBranch {
    session_id: String,
    branch: String,
}

impl Run for SwitchBranch {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let task = workspace_task(&ctx.state(), &self.session_id).await?;
            let root = task_root(&ctx.state(), &self.session_id).await?;
            // Any agent working in this checkout (another task sharing a main checkout too).
            refuse_running_here(&ctx, &root).await?;
            // Ordered lane: never queue behind a background commit, push or merge.
            let _checkout = try_lock_task_checkout(&ctx, &self.session_id, &task.project_id).await?;
            refuse_running_here(&ctx, &root).await?;
            // A checkout runs the repository's smudge filters.
            refuse_config_programs(&ctx, &self.session_id, "switch branches").await?;
            let list = crate::switch_branch(&ctx.state(), &task.project_id, Some(&self.session_id), self.branch, trust_of(&ctx)).await?;
            changed(&ctx);
            branches_reply(list, task.worktree_path.is_some(), false)
        })
    }
}

fn parse_switch(params: &Value) -> Result<Box<dyn Run>> {
    let branch = branch_param(params, "branch")?.ok_or("Missing branch.")?;
    Ok(Box::new(SwitchBranch { session_id: session(params)?, branch }))
}

// ---- worktree.* ----

#[derive(Debug, PartialEq)]
struct WorktreeStatus {
    session_id: String,
}

impl Run for WorktreeStatus {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let task = workspace_task(&ctx.state(), &self.session_id).await?;
            if task.worktree_path.is_none() {
                return Ok(json!({"worktree": false}));
            }
            let running = is_running(&ctx, &self.session_id)?;
            let status = crate::task_worktree_status(&ctx.state(), self.session_id, trust_of(&ctx)).await?;
            let mut reply = serde_json::to_value(status).map_err(|e| e.to_string())?;
            reply["worktree"] = json!(true);
            reply["running"] = json!(running);
            Ok(reply)
        })
    }
}

fn parse_worktree_status(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(WorktreeStatus { session_id: session(params)? }))
}

#[derive(Debug, PartialEq)]
struct WorktreeMerge {
    session_id: String,
}

impl Run for WorktreeMerge {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let task = workspace_task(&ctx.state(), &self.session_id).await?;
            if is_running(&ctx, &self.session_id)? {
                return Err("Wait for the agent to finish before merging its worktree.".into());
            }
            let _checkout = lock_task_checkout(&ctx, &self.session_id, &task.project_id, true).await?;
            // Again under the lock: an agent may have started while this call waited for it.
            if is_running(&ctx, &self.session_id)? {
                return Err("Wait for the agent to finish before merging its worktree.".into());
            }
            // The desktop's merge_worktree, with hooks only while the switch is on.
            let (store, session_id, trust) = (ctx.state().store.clone(), self.session_id.clone(), trust_of(&ctx));
            let merged = crate::blocking(move || crate::merge_task_worktree(&store, &session_id, trust)).await?;
            changed(&ctx);
            serde_json::to_value(merged).map_err(|e| e.to_string())
        })
    }
}

fn parse_worktree_merge(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(WorktreeMerge { session_id: session(params)? }))
}

#[derive(Debug, PartialEq)]
struct WorktreeRemove {
    session_id: String,
    delete_branch: bool,
}

impl Run for WorktreeRemove {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let task = workspace_task(&ctx.state(), &self.session_id).await?;
            let _checkout = lock_task_checkout(&ctx, &self.session_id, &task.project_id, true).await?;
            // `worktree remove` runs a status in the checkout and `branch -d` reads commits.
            let removed = crate::remove_task_worktree(&ctx.state(), self.session_id, self.delete_branch, trust_of(&ctx)).await?;
            changed(&ctx);
            serde_json::to_value(removed).map_err(|e| e.to_string())
        })
    }
}

fn parse_worktree_remove(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(WorktreeRemove { session_id: session(params)?, delete_branch: bool_param(params, "deleteBranch")? }))
}

/// `worktree.create`: gives a task that uses the main checkout its own worktree. An unstarted
/// task moves into it (the desktop's `attach_worktree`); one that already has a conversation
/// gets a new task in the worktree with its harness and model (`create_worktree`). The reply
/// names the task that now owns the worktree and whether it is the same one.
#[derive(Debug, PartialEq)]
struct WorktreeCreate {
    session_id: String,
    branch: Option<String>,
    /// A retry with the same id answers the first worktree instead of making another.
    send_id: Option<String>,
}

/// A branch suggestion from the task's issue or title, as the desktop's `suggestBranch`:
/// whole lowercase words joined by hyphens, up to 40 characters; `task-<id>` when none.
fn suggested_branch(task: &crate::storage::Session) -> String {
    let source = match &task.issue {
        Some(issue) => format!("{} {}", issue.number, issue.title),
        None if task.title != "New conversation" => task.title.clone(),
        None => String::new(),
    };
    let lower = source.to_lowercase();
    let words = lower.split(|c: char| !c.is_ascii_alphanumeric()).filter(|word| !word.is_empty());
    let mut slug = String::new();
    for word in words {
        if slug.is_empty() {
            slug = word.chars().take(40).collect();
        } else if slug.len() + 1 + word.len() > 40 {
            break;
        } else {
            slug = format!("{slug}-{word}");
        }
    }
    if slug.is_empty() {
        let short: String = task.id.chars().filter(char::is_ascii_alphanumeric).take(8).collect();
        format!("task-{short}")
    } else {
        slug
    }
}

/// Moves `session_id` into a new worktree when it has not started, else creates a worktree
/// task from it. Blocking; the caller holds the project's checkout lock.
fn create_task_worktree(store: &Arc<StdMutex<crate::storage::Store>>, session_id: &str, branch: &str, trust: Trust) -> Result<(crate::storage::Session, bool)> {
    let (source, root, attach) = {
        let store = store.lock().map_err(|e| e.to_string())?;
        let source = workspace_session_from(&store, session_id)?;
        if source.worktree_path.is_some() {
            return Err("This task already has a worktree.".into());
        }
        let root = store.workspace_root(&source.project_id, None)?;
        let attach = store.worktree_attachable(session_id)?;
        (source, root, attach)
    };
    // `git worktree add` never runs hooks here, but its checkout runs the repository's filters
    // (and a submodule's own config).
    crate::workspace::refuse_untrusted_programs_for(&root, trust, "create a worktree")?;
    let worktree = crate::workspace::create_worktree_for(&root, branch, None, false, trust)?;
    let store = store.lock().map_err(|e| e.to_string())?;
    if attach {
        let task = store.attach_worktree(&source.id, &worktree.path, &worktree.branch).map_err(|error| format!("Worktree created at {}, but the task could not be updated: {error}", worktree.path.display()))?;
        return Ok((task, true));
    }
    let transaction = store.db.unchecked_transaction().map_err(|e| e.to_string())?;
    let created = (|| {
        let mut source = source.clone();
        source.mode = crate::storage::DEFAULT_PERMISSION_MODE.into();
        let task = store.create_worktree_session_on(&source, &worktree.path, Some(&worktree.branch))?;
        // The default team's workers run in full access: only with the switch, as task.start.
        if !trust.untrusted() {
            crate::architect::profiles::apply_default(&store, &task.id)?;
        }
        store.session(&task.id)
    })()
    .map_err(|error| format!("Worktree created at {}, but the task could not be saved: {error}", worktree.path.display()))?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok((created, false))
}

impl Run for WorktreeCreate {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (send_id, target) = (self.send_id.clone(), self.session_id.clone());
            super::once_per_action(ctx.from, "worktree.create", &target, send_id.as_deref(), create_worktree(ctx, *self)).await
        })
    }
}

/// `worktree.create` itself.
async fn create_worktree(ctx: Ctx<'_>, this: WorktreeCreate) -> Result<Value> {
    let task = workspace_task(&ctx.state(), &this.session_id).await?;
    if task.worktree_path.is_some() {
        return Err("This task already has a worktree.".into());
    }
    if is_running(&ctx, &this.session_id)? {
        return Err("Stop the agent before moving this task into a worktree.".into());
    }
    let _checkout = lock_task_checkout(&ctx, &this.session_id, &task.project_id, true).await?;
    let branch = this.branch.clone().unwrap_or_else(|| suggested_branch(&task));
    let (store, session_id, trust) = (ctx.state().store.clone(), this.session_id.clone(), trust_of(&ctx));
    let (saved, moved) = crate::blocking(move || create_task_worktree(&store, &session_id, &branch, trust)).await?;
    changed(&ctx);
    // No `path`: the phone never reads it, and an absolute path names the user (Round 20).
    Ok(json!({ "sessionId": saved.id, "moved": moved, "branch": saved.worktree_branch }))
}

fn parse_worktree_create(params: &Value) -> Result<Box<dyn Run>> {
    let branch = branch_param(params, "branch")?;
    if let Some(branch) = &branch {
        crate::workspace::worktree_branch_name(branch).map_err(|_| "Use a branch name with letters, numbers, hyphens, underscores and slashes.".to_owned())?;
    }
    Ok(Box::new(WorktreeCreate { session_id: session(params)?, branch, send_id: super::send_id_param(params)? }))
}

// ---- pull.create ----

#[derive(Debug, PartialEq)]
struct PullCreate {
    session_id: String,
    title: String,
    body: String,
    base: Option<String>,
    draft: bool,
    /// A retry with the same id answers the first pull request instead of opening another.
    send_id: Option<String>,
}

impl Run for PullCreate {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (send_id, target) = (self.send_id.clone(), self.session_id.clone());
            super::once_per_action(ctx.from, "pull.create", &target, send_id.as_deref(), open_pull(ctx, *self)).await
        })
    }
}

/// `pull.create` itself.
async fn open_pull(ctx: Ctx<'_>, this: PullCreate) -> Result<Value> {
    let task = workspace_task(&ctx.state(), &this.session_id).await?;
    if task.pull_request.as_ref().is_some_and(|link| link.state == "open" || link.state == "draft") {
        return Err("This task already has an open pull request.".into());
    }
    let root = task_root(&ctx.state(), &this.session_id).await?;
    // Any agent working in this checkout (another task sharing a main checkout too).
    refuse_running_here(&ctx, &root).await?;
    // Opening a pull request pushes the task's branch from its checkout.
    let _checkout = lock_task_checkout(&ctx, &this.session_id, &task.project_id, false).await?;
    refuse_running_here(&ctx, &root).await?;
    let base = match this.base {
        Some(base) => base,
        None => {
            // Round 24: the default branch of the remote the pull request opens in (a fork's
            // `upstream`), else origin's as before.
            let (pin_root, trust) = (root.clone(), trust_of(&ctx));
            match crate::blocking(move || Ok(crate::workspace::pull_base_default(&pin_root, trust))).await? {
                Some(base) => base,
                None => {
                    // Through the phone's trust: sorting branches reads commits a partial clone fetches lazily.
                    let list = crate::task_branches(&ctx.state(), &task.project_id, Some(&this.session_id), trust_of(&ctx)).await?;
                    Some(list.default_branch).filter(|base| !base.is_empty()).ok_or("Choose a base branch.")?
                }
            }
        }
    };
    let trust = trust_of(&ctx);
    // Opened in the project's `origin` (`--repo=…`, Round 21): refused before anything is pushed.
    let pin_root = root.clone();
    crate::blocking(move || crate::github::pull_create_repo(&pin_root, trust)).await?;
    let (title, body, draft) = (this.title, this.body, this.draft);
    let link = crate::blocking(move || crate::push_and_open_pull(&root, &title, &body, &base, draft, trust)).await?;
    let store = ctx.state().store.clone();
    let session_id = this.session_id;
    let saved = link.clone();
    crate::blocking(move || store.lock().map_err(|e| e.to_string())?.set_task_link(&session_id, "pull", Some(&saved)).map(|_| ())).await?;
    changed(&ctx);
    Ok(json!({"pull": link_json(&link), "note": null}))
}

fn parse_pull_create(params: &Value) -> Result<Box<dyn Run>> {
    let title = bounded_param(params, "title", MAX_PULL_TITLE * 4, true).map_err(|_| "Give the pull request a title of up to 256 characters.".to_owned())?;
    if title.chars().count() > MAX_PULL_TITLE {
        return Err("Give the pull request a title of up to 256 characters.".into());
    }
    let body = bounded_param(params, "body", MAX_PULL_BODY, false).map_err(|_| "Shorten the pull request description.".to_owned())?;
    Ok(Box::new(PullCreate { session_id: session(params)?, title, body, base: branch_param(params, "base")?, draft: bool_param(params, "draft")?, send_id: super::send_id_param(params)? }))
}

// ---- turn.summary / turn.diff ----

/// The turn change id recorded for a message of this task.
fn turn_change_id(store: &crate::storage::Store, session_id: &str, message_id: i64) -> Result<String> {
    use rusqlite::OptionalExtension;
    store
        .db
        .query_row("SELECT id FROM turn_changes WHERE message_id=?1 AND session_id=?2", rusqlite::params![message_id, session_id], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "This message has no recorded changes.".into())
}

#[derive(Debug, PartialEq)]
struct TurnSummary {
    session_id: String,
    message_id: i64,
}

impl Run for TurnSummary {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        let store = ctx.state().store.clone();
        Box::pin(async move {
            crate::blocking(move || {
                let store = store.lock().map_err(|e| e.to_string())?;
                workspace_session_from(&store, &self.session_id)?;
                let id = turn_change_id(&store, &self.session_id, self.message_id)?;
                let summary = crate::turn_changes::summary(&store, &self.session_id, &id)?;
                let mut reply = serde_json::to_value(summary).map_err(|e| e.to_string())?;
                fit_summary(&mut reply);
                Ok(reply)
            })
            .await
        })
    }
}

/// Cuts a summary's file list to the page budget and marks it truncated.
fn fit_summary(reply: &mut Value) {
    if let Some(files) = reply["files"].as_array_mut() {
        let before = files.len();
        super::super::host::fit_list(files, PAGE_BUDGET - 4096);
        if files.len() < before {
            reply["truncated"] = json!(true);
        }
    }
}

fn parse_turn_summary(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(TurnSummary { session_id: session(params)?, message_id: message_id_param(params)? }))
}

#[derive(Debug, PartialEq)]
struct TurnDiff {
    session_id: String,
    message_id: i64,
    path: String,
}

/// Cuts a turn diff's patch to [`TURN_PATCH_BUDGET`].
fn fit_patch(reply: &mut Value) {
    let Some(patch) = reply["patch"].as_str() else { return };
    if patch.len() > TURN_PATCH_BUDGET {
        reply["patch"] = json!(super::bounded_text(patch, TURN_PATCH_BUDGET));
        reply["truncated"] = json!(true);
    }
}

/// Refuses a turn diff of a secret file (by its path or, for a rename, its old path) to a
/// device below Full, as `files.read` does: by name, and (when the checkout is there) by
/// where a symlink at that path resolves, as `files::is_secret` does.
fn allow_secret_diff(root: Option<&Path>, paths: &[Option<&str>], full: bool) -> Result<()> {
    let secret = |path: &str| {
        super::files::is_secret_path(Path::new(path)) || root.is_some_and(|root| root.join(path).canonicalize().is_ok_and(|resolved| super::files::is_secret_path(&resolved)))
    };
    if !full && paths.iter().flatten().any(|path| secret(path)) {
        return Err(super::files::SECRET_REFUSED.into());
    }
    Ok(())
}

/// Refuses a turn diff captured from a hard-linked file (`turn_changes` kept no patch for it).
fn allow_captured(detail: &crate::turn_changes::TurnChangeDiff) -> Result<()> {
    if detail.hard_linked() {
        return Err(super::files::HARD_LINK_REFUSED.into());
    }
    Ok(())
}

/// Refuses a turn diff of a file that is hard-linked in the checkout now, for every device,
/// as `files.read` and `task.diff` do (Round 12; `workspace::hard_linked`).
fn allow_unlinked(root: &Path, paths: &[Option<&str>]) -> Result<()> {
    if paths.iter().flatten().any(|path| crate::workspace::hard_linked(&root.join(path))) {
        return Err(super::files::HARD_LINK_REFUSED.into());
    }
    Ok(())
}

impl Run for TurnDiff {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        let store = ctx.state().store.clone();
        let full = super::files::device_has_full(&ctx);
        Box::pin(async move {
            allow_secret_diff(None, &[Some(&self.path)], full)?;
            // A saved turn diff stays readable when its checkout is gone (nothing to link then).
            let root = task_root(&ctx.state(), &self.session_id).await.ok();
            crate::blocking(move || {
                let detail = {
                    let store = store.lock().map_err(|e| e.to_string())?;
                    workspace_session_from(&store, &self.session_id)?;
                    let id = turn_change_id(&store, &self.session_id, self.message_id)?;
                    crate::turn_changes::detail(&store, &self.session_id, &id, &self.path)?
                };
                if let Some(root) = &root {
                    // Round 22: a project rooted at the home folder (or above) is Full-only.
                    super::files::allow_root(root, full)?;
                }
                allow_captured(&detail)?;
                allow_secret_diff(root.as_deref(), &[Some(&detail.path), detail.old_path.as_deref()], full)?;
                if let Some(root) = &root {
                    allow_unlinked(root, &[Some(&detail.path), detail.old_path.as_deref()])?;
                }
                let mut reply = serde_json::to_value(detail).map_err(|e| e.to_string())?;
                fit_patch(&mut reply);
                Ok(reply)
            })
            .await
        })
    }
}

fn parse_turn_diff(params: &Value) -> Result<Box<dyn Run>> {
    let path = path_param(params, "path")?.ok_or("Missing path.")?;
    Ok(Box::new(TurnDiff { session_id: session(params)?, message_id: message_id_param(params)?, path }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::GitFile;
    use std::process::Command;

    fn file(path: &str, index: &str, working: &str) -> GitFile {
        GitFile { path: path.into(), index: index.into(), working: working.into(), orig_path: None }
    }

    fn parse(name: &str, params: Value) -> Result<String> {
        let method = METHODS.iter().find(|m| m.name == name).unwrap();
        (method.parse)(&params).map(|call| format!("{call:?}"))
    }

    #[test]
    fn repository_hooks_run_only_with_the_full_access_switch_on() {
        assert_eq!(Trust::phone(true).hooks(), crate::workspace::Hooks::Run);
        assert_eq!(Trust::phone(false).hooks(), crate::workspace::Hooks::Skip);
        assert_eq!(Trust::Desktop.hooks(), crate::workspace::Hooks::Run);
    }

    #[test]
    fn scopes_match_the_risk_of_each_method() {
        let access = |name: &str| METHODS.iter().find(|m| m.name == name).unwrap();
        for name in ["git.status", "git.branches", "worktree.status", "turn.summary", "turn.diff"] {
            assert_eq!(access(name).access, Access::View, "{name}");
            assert!(access(name).read_only, "{name}");
        }
        assert_eq!(access("git.stage").access, Access::Control);
        assert_eq!(access("git.discard").access, Access::Control);
        assert!(!access("git.discard").read_only);
        for name in ["git.commit", "git.push", "git.switchBranch", "worktree.merge", "worktree.remove", "worktree.create", "pull.create"] {
            assert_eq!(access(name).access, Access::Full, "{name}");
            assert!(!access(name).read_only, "{name}");
        }
    }

    #[test]
    fn a_push_drops_the_cached_pull() {
        let source = include_str!("git.rs");
        let commit = &source[source.find("async fn commit(").unwrap()..source.find("fn parse_commit").unwrap()];
        assert!(commit.find("Ok(pushed)").unwrap() < commit.find("invalidate_pull_cache(&this.session_id)").unwrap(), "only after a push that worked");
        let push = &source[source.find("impl Run for Push").unwrap()..source.find("fn parse_push").unwrap()];
        assert!(push.find("git_push(").unwrap() < push.find("invalidate_pull_cache(&self.session_id)").unwrap());
    }

    #[test]
    fn every_method_needs_a_valid_session() {
        for method in METHODS {
            assert!((method.parse)(&json!({})).is_err(), "{}", method.name);
            assert!((method.parse)(&json!({"sessionId": "has space"})).is_err(), "{}", method.name);
        }
    }

    #[test]
    fn stage_takes_safe_paths_or_all() {
        assert!(parse("git.stage", json!({"sessionId": "s", "paths": ["src/a.rs", "b.md"]})).is_ok());
        assert!(parse("git.stage", json!({"sessionId": "s", "all": true, "unstage": true})).unwrap().contains("unstage: true"));
        for bad in [json!({"sessionId": "s"}), json!({"sessionId": "s", "paths": []}), json!({"sessionId": "s", "paths": ["../etc/passwd"]}), json!({"sessionId": "s", "paths": ["/abs"]}), json!({"sessionId": "s", "paths": [".git/config"]}), json!({"sessionId": "s", "paths": [3]}), json!({"sessionId": "s", "all": true, "paths": ["a"]}), json!({"sessionId": "s", "paths": ["a"], "unstage": "yes"})] {
            assert!(parse("git.stage", bad.clone()).is_err(), "{bad}");
        }
        let many: Vec<String> = (0..=MAX_STAGE_PATHS).map(|i| format!("f{i}")).collect();
        assert!(parse("git.stage", json!({"sessionId": "s", "paths": many})).is_err());
    }

    #[test]
    fn commit_refuses_an_empty_or_oversized_message() {
        assert!(parse("git.commit", json!({"sessionId": "s", "message": "  "})).is_err());
        assert!(parse("git.commit", json!({"sessionId": "s"})).is_err());
        assert!(parse("git.commit", json!({"sessionId": "s", "message": "x".repeat(MAX_COMMIT_MESSAGE + 1)})).is_err());
        assert!(parse("git.commit", json!({"sessionId": "s", "message": "a\0b"})).is_err());
        let ok = parse("git.commit", json!({"sessionId": "s", "message": "  Fix it \n", "push": true})).unwrap();
        assert!(ok.contains("message: \"Fix it\"") && ok.contains("push: true"), "{ok}");
    }

    #[test]
    fn branch_names_cannot_be_options_or_ranges() {
        assert!(parse("git.switchBranch", json!({"sessionId": "s", "branch": "feature/x"})).is_ok());
        for bad in ["-f", "--orphan=x", "a..b", "has space", ""] {
            assert!(parse("git.switchBranch", json!({"sessionId": "s", "branch": bad})).is_err(), "{bad}");
        }
        assert!(parse("git.switchBranch", json!({"sessionId": "s"})).is_err());
    }

    #[test]
    fn pull_create_validates_title_body_base_and_draft() {
        let ok = parse("pull.create", json!({"sessionId": "s", "title": "Add it", "body": "", "base": "main", "draft": true})).unwrap();
        assert!(ok.contains("draft: true") && ok.contains("Some(\"main\")"), "{ok}");
        assert!(parse("pull.create", json!({"sessionId": "s", "title": "Add it"})).unwrap().contains("base: None"));
        assert!(parse("pull.create", json!({"sessionId": "s", "title": "Add it", "sendId": "abc-1"})).unwrap().contains("send_id: Some(\"abc-1\")"));
        assert!(parse("pull.create", json!({"sessionId": "s", "title": "Add it", "sendId": "a b"})).is_err());
        assert!(parse("pull.create", json!({"sessionId": "s", "title": " "})).is_err());
        assert!(parse("pull.create", json!({"sessionId": "s", "title": "é".repeat(MAX_PULL_TITLE + 1)})).is_err());
        assert!(parse("pull.create", json!({"sessionId": "s", "title": "t", "body": "x".repeat(MAX_PULL_BODY + 1)})).is_err());
        assert!(parse("pull.create", json!({"sessionId": "s", "title": "t", "base": "--x"})).is_err());
        assert!(parse("pull.create", json!({"sessionId": "s", "title": "t", "draft": 1})).is_err());
    }

    #[test]
    fn turn_methods_need_a_message_and_a_safe_path() {
        assert!(parse("turn.summary", json!({"sessionId": "s", "messageId": 4})).is_ok());
        assert!(parse("turn.summary", json!({"sessionId": "s", "messageId": 0})).is_err());
        assert!(parse("turn.summary", json!({"sessionId": "s", "messageId": "4"})).is_err());
        assert!(parse("turn.diff", json!({"sessionId": "s", "messageId": 4, "path": "src/a.rs"})).is_ok());
        assert!(parse("turn.diff", json!({"sessionId": "s", "messageId": 4})).is_err());
        assert!(parse("turn.diff", json!({"sessionId": "s", "messageId": 4, "path": "../x"})).is_err());
    }

    #[test]
    fn classify_splits_staged_unstaged_and_untracked() {
        let (staged, unstaged, untracked) = classify(vec![file("a", "M", " "), file("b", " ", "M"), file("c", "M", "M"), file("d", "?", "?"), file("e", "A", " ")]);
        assert_eq!(staged, vec![json!({"path": "a", "status": "M"}), json!({"path": "c", "status": "M"}), json!({"path": "e", "status": "A"})]);
        assert_eq!(unstaged, vec![json!({"path": "b", "status": "M"}), json!({"path": "c", "status": "M"})]);
        assert_eq!(untracked, vec![json!("d")]);
    }

    #[test]
    fn all_paths_picks_the_files_that_can_move() {
        let files = || vec![file("a", "M", " "), file("b", " ", "M"), file("c", "M", "M"), file("d", "?", "?")];
        assert_eq!(all_paths(files(), false), ["b", "c", "d"]);
        assert_eq!(all_paths(files(), true), ["a", "c"]);
    }

    #[test]
    fn counts_parse_strictly() {
        assert_eq!(parse_counts("2\t3"), Some((2, 3)));
        assert_eq!(parse_counts("2"), None);
        assert_eq!(parse_counts("2 3 4"), None);
        assert_eq!(parse_counts("x 3"), None);
    }

    #[test]
    fn lists_and_patches_fit_the_page_budget() {
        let mut big: Vec<Value> = (0..20_000).map(|i| json!({"path": format!("src/file-{i}.rs"), "status": "M"})).collect();
        let (mut a, mut b) = (Vec::new(), vec![json!("x")]);
        assert!(fit_lists([&mut big, &mut a, &mut b]));
        assert!(json!(big).to_string().len() < PAGE_BUDGET / 3);
        let mut summary = json!({"files": (0..20_000).map(|i| json!({"path": format!("f{i}")})).collect::<Vec<_>>(), "truncated": false});
        fit_summary(&mut summary);
        assert_eq!(summary["truncated"], true);
        assert!(summary.to_string().len() <= PAGE_BUDGET);
        let mut diff = json!({"patch": "+".repeat(PAGE_BUDGET * 2), "truncated": false});
        fit_patch(&mut diff);
        assert_eq!(diff["truncated"], true);
        assert!(diff.to_string().len() <= PAGE_BUDGET);
    }

    #[test]
    fn changes_to_one_checkout_take_turns() {
        tauri::async_runtime::block_on(async {
            let root = std::env::temp_dir().join(format!("pandacode-lock-{}", uuid::Uuid::new_v4()));
            let other = root.with_extension("other");
            let first = lock_checkouts(vec![root.clone()]).await;
            // A second call on the same checkout waits; one on another checkout does not.
            let waiting = tokio::spawn(lock_checkouts(vec![root.clone()]));
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert!(!waiting.is_finished(), "a second change to one checkout waits for the first");
            let elsewhere = tokio::time::timeout(Duration::from_secs(1), lock_checkouts(vec![other.clone()])).await;
            assert!(elsewhere.is_ok(), "another checkout is free");
            // A merge holds both its worktree and the project checkout, in a fixed order.
            let both = tokio::time::timeout(Duration::from_millis(50), lock_checkouts(vec![other.clone(), root.clone()])).await;
            assert!(both.is_err(), "the merge waits too");
            drop(first);
            let second = tokio::time::timeout(Duration::from_secs(1), waiting).await.expect("it goes once the first is done").unwrap();
            drop(second);
            drop(elsewhere);
            let both = tokio::time::timeout(Duration::from_secs(1), lock_checkouts(vec![other.clone(), root.clone(), root.clone()])).await;
            assert_eq!(both.expect("free again").0.len(), 2, "one lock per checkout");
        });
        // Locks nobody holds are dropped from the table.
        drop(tauri::async_runtime::block_on(lock_checkouts(Vec::new())));
        assert!(checkout_locks().lock().unwrap().values().all(|lock| lock.strong_count() > 0));
    }

    #[test]
    fn turn_diffs_of_secret_files_need_full() {
        assert_eq!(allow_secret_diff(None, &[Some(".env")], false).unwrap_err(), super::super::files::SECRET_REFUSED);
        assert!(allow_secret_diff(None, &[Some("src/main.rs"), Some(".aws/credentials")], false).is_err(), "a rename from a secret");
        assert!(allow_secret_diff(None, &[Some("config/prod.tfvars"), None], false).is_err());
        assert!(allow_secret_diff(None, &[Some("src/main.rs"), None], false).is_ok());
        assert!(allow_secret_diff(None, &[Some(".env"), Some(".envrc")], true).is_ok());
        let source = include_str!("git.rs");
        let body = &source[source.find("impl Run for TurnDiff").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("allow_secret_diff(root.as_deref(), &[Some(&detail.path), detail.old_path.as_deref()], full)?"));
        assert!(body.contains("allow_captured(&detail)?"));
    }

    #[cfg(unix)]
    #[test]
    fn turn_diffs_resolve_symlinks_to_secrets() {
        let dir = std::env::temp_dir().join(format!("pandacode-turn-secret-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("repo")).unwrap();
        std::fs::write(dir.join("repo/.env"), "TOKEN=1").unwrap();
        std::os::unix::fs::symlink(".env", dir.join("repo/notes.txt")).unwrap();
        std::fs::write(dir.join("repo/plain.txt"), "x").unwrap();
        let root = dir.join("repo");
        assert_eq!(allow_secret_diff(Some(&root), &[Some("notes.txt")], false).unwrap_err(), super::super::files::SECRET_REFUSED);
        assert!(allow_secret_diff(Some(&root), &[Some("plain.txt"), Some("notes.txt")], false).is_err(), "a rename from a link too");
        assert!(allow_secret_diff(Some(&root), &[Some("notes.txt")], true).is_ok(), "Full reads it");
        assert!(allow_secret_diff(Some(&root), &[Some("plain.txt"), Some("gone.txt")], false).is_ok());
        assert!(allow_secret_diff(None, &[Some("notes.txt")], false).is_ok(), "no checkout: names only");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn turn_diffs_captured_from_hard_links_are_refused() {
        let detail = |error: Option<&str>| crate::turn_changes::TurnChangeDiff { path: "notes.txt".into(), old_path: None, patch: String::new(), binary: false, truncated: true, error: error.map(str::to_owned) };
        assert_eq!(allow_captured(&detail(Some(crate::turn_changes::HARD_LINKED_ERROR))).unwrap_err(), super::super::files::HARD_LINK_REFUSED);
        assert!(allow_captured(&detail(None)).is_ok());
        assert!(allow_captured(&detail(Some("Binary content changed. A text diff is unavailable."))).is_ok());
    }

    /// Unstage all after `git mv`: the index ends at HEAD for both paths, not a staged delete.
    #[test]
    fn unstage_all_resets_a_staged_rename() {
        let root = discard_repo();
        let git = |args: &[&str]| Command::new("git").args(args).current_dir(&root).output().unwrap();
        assert!(git(&["checkout", "--", "tracked.txt"]).status.success());
        std::fs::remove_file(root.join("new.txt")).unwrap();
        assert!(git(&["mv", "tracked.txt", "moved.txt"]).status.success());
        assert_eq!(stage_all_in(&root, true, Trust::phone(false)).unwrap(), (1, 0), "one row moves");
        let staged = git(&["diff", "--cached", "--name-only", "--no-renames"]);
        assert_eq!(String::from_utf8_lossy(&staged.stdout), "", "nothing staged");
        assert_eq!(String::from_utf8_lossy(&git(&["ls-files", "--cached"]).stdout), "tracked.txt\n");
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn ordered_git_calls_refuse_a_busy_checkout_instead_of_waiting() {
        let root = std::env::temp_dir().join(format!("pandacode-git-lock-{}", uuid::Uuid::new_v4().simple()));
        let held = try_lock_checkouts(vec![root.clone()]).unwrap();
        assert_eq!(try_lock_checkouts(vec![root.clone()]).err().unwrap(), CHECKOUT_BUSY);
        drop(held);
        assert!(try_lock_checkouts(vec![root.clone()]).is_ok(), "free again once released");
        // A background holder blocks the try-lock the same way.
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let background = runtime.block_on(lock_checkouts(vec![root.clone()]));
        assert!(try_lock_checkouts(vec![root.clone()]).is_err());
        drop(background);
        let source = include_str!("git.rs");
        for method in ["impl Run for Stage", "impl Run for SwitchBranch"] {
            let body = &source[source.find(method).unwrap()..];
            let body = &body[..body.find("\n}\n").unwrap()];
            assert!(body.contains("try_lock_task_checkout(&ctx"), "{method}");
            assert!(!body.contains("lock_task_checkout(&ctx, &self.session_id, &task.project_id, false).await"), "{method}");
        }
    }

    #[test]
    fn switch_off_git_refuses_unvetted_config_before_any_status() {
        let source = include_str!("git.rs");
        let body = |method: &str| {
            let body = &source[source.find(method).unwrap()..];
            body[..body.find("\n}\n").unwrap()].to_owned()
        };
        let stage = body("impl Run for Stage");
        let refusal = stage.find("refuse_config_programs(&ctx").expect("stage refuses");
        assert!(refusal < stage.find("stage_all_in(&root").unwrap(), "git.stage {{all}} refuses before its status, which skips submodules with the switch off");
        assert!(body("impl Run for SwitchBranch").contains("refuse_config_programs(&ctx"), "a branch switch runs smudge filters");
        assert!(body("impl Run for Status").contains("status_for(&root, trust)"));
        let lib = include_str!("../../lib.rs");
        let pull = &lib[lib.find("pub(crate) fn push_and_open_pull").unwrap()..];
        assert!(pull.find("refuse_untrusted_programs(root, trust)").unwrap() < pull.find("git_status(root, trust)").unwrap());
    }

    /// Round 7: git.commit and worktree.merge check for a running agent again once they hold
    /// the checkout lock, since an agent may start while they wait for it. Round 21: commit
    /// checks for any agent in the checkout.
    #[test]
    fn commit_and_merge_recheck_the_agent_after_the_checkout_lock() {
        let source = include_str!("git.rs");
        for (method, check) in [("async fn commit(", "refuse_running_here(&ctx, &root).await?"), ("impl Run for WorktreeMerge", "is_running(&ctx, &self.session_id)?")] {
            let body = &source[source.find(method).unwrap()..];
            let body = &body[..body.find("\n}\n").unwrap()];
            let lock = body.find("lock_task_checkout(&ctx").expect(method);
            assert!(body[lock..].contains(check), "{method} re-checks after the lock");
        }
    }

    #[test]
    fn a_pull_request_with_the_switch_off_refuses_before_its_status_runs_a_filter() {
        let root = repo();
        let marker = root.parent().unwrap().join("filter-ran");
        std::fs::write(root.join(".gitattributes"), "* filter=x\n").unwrap();
        assert!(Command::new("git").args(["config", "filter.x.clean", &format!("touch '{}'; cat", marker.display())]).current_dir(&root).output().unwrap().status.success());
        let refused = crate::push_and_open_pull(&root, "T", "", "main", false, Trust::phone(false)).unwrap_err();
        assert!(refused.contains("filter.x.clean") && refused.contains("Full access"), "{refused}");
        assert!(!marker.exists(), "no filter ran");
        // The phone's status view switches the filter off instead of refusing.
        let status = status_for(&root, Trust::phone(false)).unwrap();
        assert!(status.is_repo && !marker.exists());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    /// Round 8: the upstream lookup goes through `workspace::git_inspect`, never a raw Git
    /// command, so with the switch off it refuses a config that could run a program.
    #[test]
    fn upstream_goes_through_the_bounded_untrusted_runner() {
        let root = repo();
        assert!(upstream(&root, Trust::phone(false)).unwrap().is_none(), "no upstream yet");
        assert!(Command::new("git").args(["config", "core.sshCommand", "touch /tmp/never"]).current_dir(&root).output().unwrap().status.success());
        assert!(upstream(&root, Trust::phone(false)).unwrap_err().contains("core.sshcommand"));
        assert!(upstream(&root, Trust::phone(true)).unwrap().is_none(), "the switch on reads as the desktop does");
        let source = include_str!("git.rs");
        let body = &source[..source.find("\nmod tests {").unwrap()];
        assert!(!body.contains(concat!("Command::new(", "\"git\")")), "no raw Git command");
        let host = include_str!("../host.rs");
        let host = &host[..host.find("\nmod tests {").unwrap()];
        assert!(!host.contains(concat!("Command::new(", "\"git\")")), "no raw Git command in the host");
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn worktree_create_takes_an_optional_valid_branch() {
        assert!(parse("worktree.create", json!({"sessionId": "s"})).unwrap().contains("branch: None"));
        assert!(parse("worktree.create", json!({"sessionId": "s", "branch": "fix/login"})).unwrap().contains("Some(\"fix/login\")"));
        for bad in ["-f", "a..b", "has space", "", "dots.not.allowed", "x".repeat(121).as_str()] {
            assert!(parse("worktree.create", json!({"sessionId": "s", "branch": bad})).is_err(), "{bad}");
        }
        assert_eq!(super::super::lane_for("worktree.create"), Some(super::super::Lane::Background));
    }

    #[test]
    fn suggested_branches_follow_the_desktop() {
        let store = crate::storage::Store::open(Path::new(":memory:")).unwrap();
        let base = std::env::temp_dir().join(format!("pandacode-suggest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let project = store.add_project(&base).unwrap();
        let mut task = store.create_session(&project.id, "codex", "m", "full").unwrap();
        task.title = "Fix the Login: page, then ship it to everyone everywhere today".into();
        assert_eq!(suggested_branch(&task), "fix-the-login-page-then-ship-it-to");
        task.title = "New conversation".into();
        assert!(suggested_branch(&task).starts_with("task-"));
        let _ = std::fs::remove_dir_all(base);
    }

    fn repo() -> PathBuf {
        let base = std::env::temp_dir().join(format!("pandacode-wt-create-{}", uuid::Uuid::new_v4()));
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Tests"],
            vec!["config", "user.email", "tests@example.invalid"],
            vec!["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "Initial"],
        ] {
            assert!(Command::new("git").args(&args).current_dir(&root).output().unwrap().status.success(), "{args:?}");
        }
        root
    }

    #[test]
    fn worktree_create_moves_an_unstarted_task_and_branches_off_a_started_one() {
        let root = repo();
        let store = Arc::new(StdMutex::new(crate::storage::Store::open(Path::new(":memory:")).unwrap()));
        let (fresh, started) = {
            let store = store.lock().unwrap();
            let project = store.add_project(&root).unwrap();
            let fresh = store.create_session(&project.id, "codex", "m", "full").unwrap();
            let started = store.create_session(&project.id, "claude", "m2", "full").unwrap();
            store.message(&started.id, "user", "Already talking").unwrap();
            (fresh, started)
        };
        let (moved, same) = create_task_worktree(&store, &fresh.id, "fresh-one", Trust::phone(false)).unwrap();
        assert!(same);
        assert_eq!(moved.id, fresh.id);
        assert_eq!(moved.worktree_branch.as_deref(), Some("pandacode/fresh-one"));
        assert!(Path::new(moved.worktree_path.as_ref().unwrap()).is_dir());
        let again = create_task_worktree(&store, &fresh.id, "fresh-two", Trust::phone(false)).unwrap_err();
        assert!(again.contains("already has a worktree"), "{again}");

        let (created, same) = create_task_worktree(&store, &started.id, "started-one", Trust::Desktop).unwrap();
        assert!(!same);
        assert_ne!(created.id, started.id);
        assert_eq!(created.provider, "claude");
        assert_eq!(created.worktree_branch.as_deref(), Some("pandacode/started-one"));
        assert!(store.lock().unwrap().session(&started.id).unwrap().worktree_path.is_none(), "the source keeps the main checkout");

        let taken = create_task_worktree(&store, &started.id, "started-one", Trust::Desktop).unwrap_err();
        assert!(taken.contains("already exists"), "{taken}");
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn worktree_create_applies_the_default_team_only_with_the_switch() {
        let root = repo();
        let store = Arc::new(StdMutex::new(crate::storage::Store::open(Path::new(":memory:")).unwrap()));
        let (off, on) = {
            let store = store.lock().unwrap();
            let project = store.add_project(&root).unwrap();
            let library = json!({"enabled": true, "lastSetup": {"architect": {"provider": "codex", "model": "default", "reasoningEffort": null}, "config": {"auto": true, "workers": [], "catalog": [{"id": "a", "name": "A", "provider": "codex", "model": "default", "reasoningEffort": null}], "maxParallel": 0, "maxRounds": 8, "maxAssignments": 24, "workspace": "shared", "summaryLimit": 3072}}, "activeProfileId": null, "profiles": []});
            store.db.execute("INSERT OR REPLACE INTO architect_library(id,content) VALUES(1,?1)", [library.to_string()]).unwrap();
            let off = store.create_session(&project.id, "codex", "default", "full").unwrap();
            let on = store.create_session(&project.id, "codex", "default", "full").unwrap();
            for task in [&off, &on] {
                store.message(&task.id, "user", "Already talking").unwrap();
            }
            (off, on)
        };
        let leads_team = |sid: &str| -> bool { store.lock().unwrap().db.query_row("SELECT EXISTS(SELECT 1 FROM architect_teams WHERE session_id=?1)", [sid], |r| r.get(0)).unwrap() };
        let (created, _) = create_task_worktree(&store, &off.id, "switch-off", Trust::phone(false)).unwrap();
        assert!(!leads_team(&created.id), "no default team without full access for remote tasks");
        let (created, _) = create_task_worktree(&store, &on.id, "switch-on", Trust::phone(true)).unwrap();
        assert!(leads_team(&created.id), "the default team with the switch");
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn worktree_create_with_the_switch_off_refuses_a_repository_that_runs_programs() {
        let root = repo();
        assert!(Command::new("git").args(["config", "filter.x.smudge", "touch /tmp/never"]).current_dir(&root).output().unwrap().status.success());
        let store = Arc::new(StdMutex::new(crate::storage::Store::open(Path::new(":memory:")).unwrap()));
        let task = {
            let store = store.lock().unwrap();
            let project = store.add_project(&root).unwrap();
            store.create_session(&project.id, "codex", "m", "full").unwrap()
        };
        let refused = create_task_worktree(&store, &task.id, "filtered", Trust::phone(false)).unwrap_err();
        assert!(refused.contains("Full access"), "{refused}");
        assert!(store.lock().unwrap().session(&task.id).unwrap().worktree_path.is_none());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    /// Council review: `git.discard` refuses while any agent works in the checkout (another task
    /// on the same main checkout too), before and again after the checkout lock, as
    /// `files.write` does; never just this task's own agent.
    #[test]
    fn discard_refuses_while_any_agent_works_in_the_checkout() {
        let source = include_str!("git.rs");
        let body = &source[source.find("impl Run for Discard").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(!body.contains("refuse_running(&ctx"), "not only this task's agent");
        let lock = body.find("try_lock_task_checkout(&ctx").unwrap();
        assert!(body[..lock].contains("refuse_running_here(&ctx, &root).await?"), "before the lock");
        assert!(body[lock..].contains("refuse_running_here(&ctx, &root).await?"), "again under the lock");
        let here = &source[source.find("async fn refuse_running_here").unwrap()..];
        assert!(here[..here.find("\n}\n").unwrap()].contains("super::files::running_in(ctx, root)"), "the files.write check");
        let files = include_str!("files.rs");
        let refuse = &files[files.find("async fn refuse_running_in").unwrap()..];
        assert!(refuse[..refuse.find("\n}\n").unwrap()].contains("running_in(ctx, root)"), "one check for both");
    }

    /// Round 21: `git.switchBranch`, `git.commit` and `pull.create` change or push the checkout,
    /// so like `git.discard` they refuse while any agent works in it (another task on the same
    /// main checkout too), before and again after the checkout lock.
    #[test]
    fn checkout_changes_refuse_while_any_agent_works_in_the_checkout() {
        let source = include_str!("git.rs");
        for (method, lock) in [
            ("impl Run for SwitchBranch", "try_lock_task_checkout(&ctx"),
            ("async fn commit(", "lock_task_checkout(&ctx"),
            ("async fn open_pull(", "lock_task_checkout(&ctx"),
        ] {
            let body = &source[source.find(method).unwrap()..];
            let body = &body[..body.find("\n}\n").unwrap()];
            assert!(!body.contains("refuse_running(&ctx"), "{method}: not only this task's agent");
            let lock = body.find(lock).expect(method);
            assert!(body[..lock].contains("refuse_running_here(&ctx, &root).await?"), "{method}: before the lock");
            assert!(body[lock..].contains("refuse_running_here(&ctx, &root).await?"), "{method}: again under the lock");
        }
    }

    /// `git.stage {all}` refuses the whole call when it would stage a hard link, naming it;
    /// unstaging everything is unaffected.
    #[cfg(unix)]
    #[test]
    fn stage_all_refuses_a_hard_linked_file_by_name() {
        let root = discard_repo();
        let secret = root.parent().unwrap().join("id_rsa");
        std::fs::write(&secret, "key").unwrap();
        std::fs::hard_link(&secret, root.join("notes.txt")).unwrap();
        let paths = all_paths(status_for(&root, Trust::phone(false)).unwrap().files, false);
        assert!(paths.contains(&"notes.txt".to_string()) && paths.contains(&"new.txt".to_string()), "{paths:?}");
        assert_eq!(refuse_linked_in_all(&root, &paths).unwrap_err(), crate::workspace::hard_link_refused_named("notes.txt", "stage"));
        assert!(refuse_linked_in_all(&root, &["new.txt".into(), "tracked.txt".into()]).is_ok());
        // Before anything is staged.
        assert_eq!(stage_all_in(&root, false, Trust::phone(false)).unwrap_err(), crate::workspace::hard_link_refused_named("notes.txt", "stage"));
        assert!(status_for(&root, Trust::Desktop).unwrap().files.iter().all(|file| file.index == " " || file.index == "?"), "nothing staged");
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    /// An untracked nested repository (`sub/`) and a changed submodule pointer are skipped and
    /// counted, not a refusal of the whole `git.stage {all}`.
    #[test]
    fn stage_all_skips_folder_and_gitlink_rows() {
        let root = discard_repo();
        let git = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(&root).output().unwrap().status.success(), "{args:?}");
        // A gitlink in HEAD whose checkout now points elsewhere.
        let inner = root.join("module");
        std::fs::create_dir_all(&inner).unwrap();
        let inner_git = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(&inner).output().unwrap().status.success(), "{args:?}");
        inner_git(&["init", "-q"]);
        inner_git(&["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgSign=false", "commit", "-q", "--allow-empty", "-m", "one"]);
        git(&["add", "module"]);
        git(&["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "Module"]);
        inner_git(&["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgSign=false", "commit", "-q", "--allow-empty", "-m", "two"]);
        // An untracked nested repository.
        let nested = root.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(Command::new("git").args(["init", "-q"]).current_dir(&nested).output().unwrap().status.success());
        std::fs::write(nested.join("x.txt"), "x").unwrap();
        let listed = all_paths(status_for(&root, Trust::Desktop).unwrap().files, false);
        assert!(listed.contains(&"nested/".to_string()) && listed.contains(&"module".to_string()), "{listed:?}");
        assert_eq!(stage_all_in(&root, false, Trust::Desktop).unwrap(), (2, 2));
        let staged: Vec<String> = status_for(&root, Trust::Desktop).unwrap().files.into_iter().filter(|file| file.index != " " && file.index != "?").map(|file| file.path).collect();
        assert_eq!(staged, ["new.txt", "tracked.txt"]);
        assert_eq!(stage_all_in(&root, true, Trust::Desktop).unwrap(), (2, 0));
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    /// Discard all (`skipFolders`) leaves a nested repository's row alone; naming it alone is refused.
    #[test]
    fn discard_batch_skips_folder_rows_only_when_asked() {
        let root = discard_repo();
        std::fs::create_dir_all(root.join("nested")).unwrap();
        assert!(Command::new("git").args(["init", "-q"]).current_dir(root.join("nested")).output().unwrap().status.success());
        let batch = || vec!["nested/".to_string(), "tracked.txt".to_string(), "new.txt".to_string()];
        assert!(discard_batch_in(&root, batch(), false, Trust::phone(false)).is_err(), "a named folder is refused");
        assert_eq!(discard_batch_in(&root, batch(), true, Trust::phone(false)).unwrap(), (2, 1));
        assert!(root.join("nested/.git").exists() && !root.join("new.txt").exists());
        assert_eq!(discard_batch_in(&root, vec!["nested/".into()], true, Trust::phone(false)).unwrap(), (0, 1));
        let parsed = parse_discard(&json!({"sessionId": "s", "paths": ["a"], "skipFolders": true})).unwrap();
        assert!(format!("{parsed:?}").contains("skip_folders: true"));
        assert!(parse_discard(&json!({"sessionId": "s", "paths": ["a"], "skipFolders": "yes"})).is_err());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    /// More than 5,000 long-named files stage and unstage in chunks, never one command line.
    #[test]
    fn stage_all_moves_many_long_paths_in_chunks() {
        let root = discard_repo();
        let folder = root.join("a".repeat(120));
        std::fs::create_dir_all(&folder).unwrap();
        for index in 0..5_200 {
            std::fs::write(folder.join(format!("{}-{index:05}.txt", "b".repeat(100))), "x").unwrap();
        }
        assert_eq!(stage_all_in(&root, false, Trust::phone(false)).unwrap(), (5_202, 0));
        assert!(status_for(&root, Trust::Desktop).is_err(), "too many rows for a list");
        assert_eq!(stage_all_in(&root, true, Trust::phone(false)).unwrap(), (5_202, 0));
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn turn_diffs_of_hard_linked_files_are_refused() {
        let dir = std::env::temp_dir().join(format!("pandacode-turn-link-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("repo")).unwrap();
        std::fs::write(dir.join("id_rsa"), "key").unwrap();
        std::fs::hard_link(dir.join("id_rsa"), dir.join("repo/notes.txt")).unwrap();
        std::fs::write(dir.join("repo/plain.txt"), "x").unwrap();
        let root = dir.join("repo");
        assert_eq!(allow_unlinked(&root, &[Some("notes.txt")]).unwrap_err(), super::super::files::HARD_LINK_REFUSED);
        assert!(allow_unlinked(&root, &[Some("plain.txt"), Some("notes.txt")]).is_err(), "a rename's old path too");
        assert!(allow_unlinked(&root, &[Some("plain.txt"), None, Some("gone.txt")]).is_ok());
        let source = include_str!("git.rs");
        let body = &source[source.find("impl Run for TurnDiff").unwrap()..];
        assert!(body[..body.find("\n}\n").unwrap()].contains("allow_unlinked(root, &[Some(&detail.path), detail.old_path.as_deref()])?"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_staged_rename_carries_its_source() {
        let mut renamed = file("new.txt", "R", " ");
        renamed.orig_path = Some("old.txt".into());
        let (staged, _, _) = classify(vec![renamed, file("a", "M", " ")]);
        assert_eq!(staged, vec![json!({"path": "new.txt", "status": "R", "origPath": "old.txt"}), json!({"path": "a", "status": "M"})]);
    }

    #[test]
    fn discard_takes_safe_paths_only() {
        assert!(parse("git.discard", json!({"sessionId": "s", "paths": ["src/a.rs", "b.md"]})).is_ok());
        for bad in [json!({"sessionId": "s"}), json!({"sessionId": "s", "paths": []}), json!({"sessionId": "s", "paths": ["../etc/passwd"]}), json!({"sessionId": "s", "paths": ["/abs"]}), json!({"sessionId": "s", "paths": [".git/config"]}), json!({"sessionId": "s", "paths": ["a/../../b"]}), json!({"sessionId": "s", "paths": [3]}), json!({"sessionId": "s", "all": true})] {
            assert!(parse("git.discard", bad.clone()).is_err(), "{bad}");
        }
        let many: Vec<String> = (0..=MAX_STAGE_PATHS).map(|i| format!("f{i}")).collect();
        assert!(parse("git.discard", json!({"sessionId": "s", "paths": many})).is_err());
        assert_eq!(super::super::lane_for("git.discard"), None, "the ordered lane, like git.stage");
    }

    /// A real checkout: `tracked.txt` committed then edited, `new.txt` untracked.
    fn discard_repo() -> PathBuf {
        let root = repo();
        let git = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(&root).output().unwrap().status.success(), "{args:?}");
        std::fs::write(root.join("tracked.txt"), "one\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-m", "Tracked"]);
        std::fs::write(root.join("tracked.txt"), "two\n").unwrap();
        std::fs::write(root.join("new.txt"), "new\n").unwrap();
        root
    }

    #[test]
    fn discard_restores_tracked_files_and_removes_named_untracked_ones() {
        let root = discard_repo();
        assert_eq!(discard_in(&root, vec!["tracked.txt".into()], Trust::phone(false)).unwrap(), 1);
        assert_eq!(std::fs::read_to_string(root.join("tracked.txt")).unwrap(), "one\n");
        assert!(root.join("new.txt").exists(), "an untracked file stays unless it is named");
        discard_in(&root, vec!["new.txt".into()], Trust::phone(false)).unwrap();
        assert!(!root.join("new.txt").exists());
        // A retry is a no-op.
        assert_eq!(discard_in(&root, vec!["new.txt".into(), "tracked.txt".into()], Trust::phone(false)).unwrap(), 1);
        assert!(status_for(&root, Trust::Desktop).unwrap().files.is_empty());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn discard_refuses_a_path_outside_the_checkout() {
        let root = discard_repo();
        let outside = root.parent().unwrap().join("outside.txt");
        std::fs::write(&outside, "private").unwrap();
        assert!(parse("git.discard", json!({"sessionId": "s", "paths": ["../outside.txt"]})).is_err());
        assert!(discard_in(&root, vec!["../outside.txt".into()], Trust::phone(true)).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.parent().unwrap(), root.join("escape")).unwrap();
            assert!(discard_in(&root, vec!["escape/outside.txt".into()], Trust::phone(true)).is_err());
        }
        assert!(outside.exists());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn discard_with_the_switch_off_refuses_a_checkout_whose_config_runs_programs() {
        let root = discard_repo();
        let marker = root.parent().unwrap().join("smudge-ran");
        std::fs::write(root.join(".gitattributes"), "*.txt filter=x\n").unwrap();
        assert!(Command::new("git").args(["config", "filter.x.smudge", &format!("touch '{}'; cat", marker.display())]).current_dir(&root).output().unwrap().status.success());
        let refused = discard_in(&root, vec!["tracked.txt".into()], Trust::phone(false)).unwrap_err();
        assert!(refused.contains("filter.x.smudge") && refused.contains("discard changes"), "{refused}");
        assert!(!marker.exists(), "no filter ran");
        assert_eq!(std::fs::read_to_string(root.join("tracked.txt")).unwrap(), "two\n");
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    /// Round 24: with no base, `pull.create` asks the base remote's HEAD first, then origin's.
    #[test]
    fn pull_create_defaults_to_the_base_remotes_branch() {
        let source = include_str!("git.rs");
        let body = &source[source.find("async fn open_pull(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.find("crate::workspace::pull_base_default(&pin_root, trust)").unwrap() < body.find("crate::task_branches(").unwrap());
    }
}
