//! PandaConnect methods for the `github` feature group: the desktop's GitHub view
//! (`src/github-hub.ts`, `github_hub.rs`) for one host project at a time. See
//! `methods/mod.rs` and docs/remote-access.md, "Adding a method".
//!
//! Reads (View): `github.repos` lists the host's projects with a GitHub remote (Round 22: the base repository, see below);
//! `github.issues`, `github.pulls` and `github.runs` list a project's open issues, open pull
//! requests and recent workflow runs (the desktop's tabs, 50 each); `github.item` reads one
//! issue, pull request or run (body, comments, checks or jobs), bounded to a page; and
//! `github.search` is the desktop's issue and pull request picker search.
//!
//! Actions (Full: they speak on GitHub or start work): `github.comment` comments on an issue
//! or pull request as the host's `gh` account, and `github.startTask` starts a task that
//! solves an issue the way the desktop's Solve button does (its prompt, title and issue link),
//! through the same flow as `task.start`. The desktop has no workflow re-run, so neither does
//! the phone. `pull.review` (Full) approves, requests changes on or comments on a task's
//! linked pull request (`gh pr review` through [`crate::github::review_pull_as`] with the
//! caller's trust); the desktop has no reply to a review comment thread, so neither does the
//! phone. Every `gh` call is bounded with a deadline (`crate::github::run_gh`, or
//! [`gh_in`] for one in the project's checkout); user text reaches `gh` only as `--flag=value`.
//! Every issue or pull request view, comment and review names the project's repository with
//! `--repo=…` ([`base_repo`], Round 18), so `gh` never picks one itself. Round 22: that is the
//! checkout's base repository as the desktop's `gh` resolves it (the `gh-resolved` remote, then
//! `upstream`, then `origin`; [`github_hub::base_repo`]), the same one `pull.create` and the
//! lists (`github.repos`, `github.issues`, `github.pulls`, `github.runs`, `github.search`) use;
//! without a GitHub remote they are refused.
//!
//! Trust (docs/remote-access.md, Round-9 gates): a `gh` run in the checkout runs `git` there
//! itself to find the repository, so with "Full access for remote tasks" off [`gh_in`] hands
//! that Git the closed gate's overrides as environment config ([`crate::workspace::tool_git_env`]:
//! no hooks, fsmonitor, `ext::`/`file://` transports, lazy fetch or auto maintenance).
//! `github.startTask` passes the caller's trust to `remote::start`, which refuses an untrusted
//! checkout before its first Git call. `github.comment` changes no checkout.
use super::{bounded_text, id_param, linked_pull, name_param, text_param, Access, Ctx, Method, Reply, Run, PAGE_BUDGET};
use crate::github::{flag, names, review_pull_as, run_gh_as, state_of, text, ReviewEvent, TIMEOUT};
use crate::github_hub;
use crate::workspace::{Capture, Trust};
use crate::{AppState, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// A body or a comment longer than this is cut (and marked) on the phone.
const BODY_LIMIT: usize = 24 * 1024;
const COMMENT_LIMIT: usize = 6 * 1024;
/// The newest comments an item shows.
const COMMENTS_SHOWN: usize = 30;
/// A run job's check-run summary on the phone.
const SUMMARY_LIMIT: usize = 2 * 1024;
/// GitHub refuses comments over 65,536 characters.
const MAX_COMMENT: usize = 65_536;
const MAX_QUERY: usize = 200;
const SEARCH_LIMIT: usize = 10;
const TITLE_LIMIT: usize = 120;

// ---- shared helpers ----

/// Bot and chat projects are not the phone's to browse or work in (as `files::resolve`).
fn hidden_project(bot_projects: &[String], project_id: &str, path: &std::path::Path) -> Option<&'static str> {
    if bot_projects.iter().any(|id| id == project_id) {
        Some("That project belongs to a bot.")
    } else if crate::chats::is_chat_folder(path) {
        Some("That project is a chat.")
    } else {
        None
    }
}

/// The project's checkout, where `gh` knows the repository. Bot and chat projects are refused.
async fn project_root(ctx: &Ctx<'_>, project_id: &str) -> Result<PathBuf> {
    project_root_in(ctx.app, project_id).await
}

async fn project_root_in(app: &tauri::AppHandle, project_id: &str) -> Result<PathBuf> {
    let store = app.state::<AppState>().store.clone();
    let id = project_id.to_owned();
    crate::blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        let root = store.workspace_root(&id, None)?;
        if let Some(refusal) = hidden_project(&crate::bots::project_ids(&store)?, &id, &root) {
            return Err(refusal.into());
        }
        Ok(root)
    })
    .await
}

/// The project's GitHub repository ([`base_repo`]).
async fn project_repo(ctx: &Ctx<'_>, project_id: &str) -> Result<String> {
    let root = project_root(ctx, project_id).await?;
    crate::blocking(move || base_repo(&root)).await
}

/// Round 18: the repository (`owner/name`) every phone `gh issue|pr view/comment/review` names
/// with `--repo=…`, so `gh` never picks one itself. Round 22: the checkout's base repository as
/// the desktop's `gh` resolves it ([`github_hub::base_repo`]), so a fork checkout acts where the
/// desktop does.
fn base_repo(root: &Path) -> Result<String> {
    github_hub::base_repo(root).ok_or_else(|| "This project has no GitHub remote.".to_string())
}

/// `gh issue|pr comment <number> --repo=<repo> --body=<body>`: user text only as `--flag=value`.
fn comment_args(repo: &str, pull: bool, number: i64, body: &str) -> Vec<String> {
    let command = if pull { "pr" } else { "issue" };
    vec![command.to_owned(), "comment".to_owned(), number.to_string(), flag("repo", repo), flag("body", body)]
}

/// `gh` in the project's checkout (`root`) through [`crate::github::run_gh_as`], with
/// [`workspace::tool_git_env`] for the `git` it runs there when `trust` is an untrusted phone.
fn gh_in(root: &Path, args: &[&str], trust: Trust) -> Result<Capture> {
    run_gh_as(root, args, TIMEOUT, trust)
}

/// `crate::github::view` in the project's repository (`--repo=…`, see [`base_repo`])
/// with the caller's trust.
fn view(root: &Path, kind: &str, number: i64, fields: &str, trust: Trust) -> Result<Value> {
    let repo = base_repo(root)?;
    crate::github::view_in_as(root, Some(&repo), kind, number, fields, trust)
}

fn positive(params: &Value, key: &str) -> Result<i64> {
    params[key].as_i64().filter(|n| *n > 0).ok_or_else(|| format!("Invalid {key}."))
}

/// At most `limit` bytes of `value`, cut on a character boundary; whether it was cut.
fn cut(value: &str, limit: usize) -> (String, bool) {
    crate::github::excerpt(value, limit)
}

/// Drops items from the end of `items` until `wrap(items)` serializes within the page budget.
fn fit(mut items: Vec<Value>, wrap: impl Fn(&[Value], bool) -> Value) -> Value {
    let mut truncated = false;
    loop {
        let reply = wrap(&items, truncated);
        if items.is_empty() || reply.to_string().len() <= PAGE_BUDGET {
            return reply;
        }
        items.pop();
        truncated = true;
    }
}

fn list_reply(key: &'static str) -> impl Fn(&[Value], bool) -> Value {
    move |items, truncated| json!({ key: items, "truncated": truncated })
}

// ---- github.repos ----

#[derive(Debug)]
struct Repos;

impl Run for Repos {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let store = ctx.state().store.clone();
            let (projects, bots) = crate::blocking(move || {
                let store = store.lock().map_err(|e| e.to_string())?;
                Ok((store.projects()?, crate::bots::project_ids(&store)?))
            })
            .await?;
            let repos = crate::blocking(move || {
                Ok(projects
                    .into_iter()
                    .filter(|project| hidden_project(&bots, &project.id, std::path::Path::new(&project.path)).is_none())
                    .filter_map(|project| {
                        let repo = github_hub::base_repo(std::path::Path::new(&project.path))?;
                        Some(json!({"projectId": project.id, "projectName": project.name, "repo": repo}))
                    })
                    .collect::<Vec<_>>())
            })
            .await?;
            Ok(fit(repos, list_reply("repos")))
        })
    }
}

// ---- github.issues / github.pulls / github.runs ----

#[derive(Debug, Clone, Copy, PartialEq)]
enum ListKind {
    Issues,
    Pulls,
    Runs,
}

#[derive(Debug)]
struct List {
    kind: ListKind,
    project_id: String,
}

impl Run for List {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let repo = project_repo(&ctx, &self.project_id).await?;
            let kind = self.kind;
            let items: Vec<Value> = crate::blocking(move || {
                let values = match kind {
                    ListKind::Issues => github_hub::issues(&repo)?.into_iter().map(|item| serde_json::to_value(item).unwrap_or_default()).collect(),
                    ListKind::Pulls => github_hub::pulls(&repo)?.into_iter().map(|item| serde_json::to_value(item).unwrap_or_default()).collect(),
                    ListKind::Runs => github_hub::runs(&repo)?.into_iter().map(|item| serde_json::to_value(item).unwrap_or_default()).collect(),
                };
                Ok(values)
            })
            .await?;
            Ok(fit(items, list_reply("items")))
        })
    }
}

fn parse_list(kind: ListKind) -> impl Fn(&Value) -> Result<Box<dyn Run>> {
    move |params| Ok(Box::new(List { kind, project_id: id_param(params, "projectId")? }))
}

// ---- github.item ----

#[derive(Debug, PartialEq)]
enum Item {
    Issue(i64),
    Pull(i64),
    Run(i64),
}

#[derive(Debug)]
struct ItemCall {
    project_id: String,
    item: Item,
}

fn parse_item(params: &Value) -> Result<Box<dyn Run>> {
    let project_id = id_param(params, "projectId")?;
    let item = match params["kind"].as_str() {
        Some("issue") => Item::Issue(positive(params, "number")?),
        Some("pull") => Item::Pull(positive(params, "number")?),
        Some("run") => Item::Run(positive(params, "runId")?),
        _ => return Err("Choose an issue, pull request or run.".into()),
    };
    Ok(Box::new(ItemCall { project_id, item }))
}

fn author_of(value: &Value) -> String {
    value.get("author").map(|author| text(author, "login")).unwrap_or_default()
}

/// The newest `COMMENTS_SHOWN` comments, oldest first, each bounded.
fn comments_of(value: &Value) -> (Vec<Value>, usize) {
    let all = value.get("comments").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let skip = all.len().saturating_sub(COMMENTS_SHOWN);
    let comments = all[skip..]
        .iter()
        .map(|comment| {
            let (body, truncated) = cut(&text(comment, "body"), COMMENT_LIMIT);
            json!({"author": author_of(comment), "body": body, "createdAt": text(comment, "createdAt"), "truncated": truncated})
        })
        .collect();
    (comments, skip)
}

/// One word for a pull request check (`statusCheckRollup` item): success, failure, pending or neutral.
fn check_state(check: &Value) -> &'static str {
    let outcome = format!("{}{}", text(check, "conclusion"), text(check, "state")).to_ascii_uppercase();
    if ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].iter().any(|bad| outcome.contains(bad)) {
        "failure"
    } else if outcome.is_empty() || ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING"].iter().any(|wait| outcome.contains(wait)) {
        "pending"
    } else if ["SUCCESS"].iter().any(|good| outcome.contains(good)) {
        "success"
    } else {
        "neutral"
    }
}

fn checks_of(value: &Value) -> Vec<Value> {
    value
        .get("statusCheckRollup")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|check| {
                    let name = [text(check, "name"), text(check, "context")].into_iter().find(|name| !name.is_empty()).unwrap_or_default();
                    let url = [text(check, "detailsUrl"), text(check, "targetUrl")].into_iter().find(|url| !url.is_empty()).unwrap_or_default();
                    json!({"name": name, "workflow": text(check, "workflowName"), "state": check_state(check), "url": url})
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The phone's view of an issue or a pull request from `gh issue|pr view --json`.
fn issue_detail(kind: &str, value: &Value) -> Value {
    let (body, truncated) = cut(&text(value, "body"), BODY_LIMIT);
    let (comments, earlier) = comments_of(value);
    let mut detail = json!({
        "kind": kind,
        "number": value.get("number").and_then(Value::as_i64).unwrap_or_default(),
        "title": text(value, "title"),
        "state": state_of(value),
        "url": text(value, "url"),
        "author": author_of(value),
        "createdAt": text(value, "createdAt"),
        "updatedAt": text(value, "updatedAt"),
        "body": body,
        "labels": names(value, "labels", "name"),
        "assignees": names(value, "assignees", "login"),
        "comments": comments,
        "earlierComments": earlier,
        "truncated": truncated,
    });
    if kind == "pull" {
        let state = if value.get("mergedAt").and_then(Value::as_str).is_some_and(|at| !at.is_empty()) { "merged".to_string() } else { state_of(value) };
        detail["state"] = json!(state);
        detail["head"] = json!(text(value, "headRefName"));
        detail["base"] = json!(text(value, "baseRefName"));
        detail["review"] = json!(text(value, "reviewDecision").to_ascii_lowercase());
        detail["additions"] = json!(value.get("additions").and_then(Value::as_i64).unwrap_or_default());
        detail["deletions"] = json!(value.get("deletions").and_then(Value::as_i64).unwrap_or_default());
        detail["checks"] = json!(checks_of(value));
    }
    fit_detail(detail)
}

/// Drops the oldest comments, then the checks, until the detail fits a page.
fn fit_detail(mut detail: Value) -> Value {
    while detail.to_string().len() > PAGE_BUDGET {
        let comments = detail["comments"].as_array_mut();
        match comments {
            Some(comments) if !comments.is_empty() => {
                comments.remove(0);
                let earlier = detail["earlierComments"].as_u64().unwrap_or_default() + 1;
                detail["earlierComments"] = json!(earlier);
            }
            _ => match detail["checks"].as_array_mut() {
                Some(checks) if !checks.is_empty() => {
                    checks.pop();
                    detail["truncated"] = json!(true);
                }
                _ => {
                    let (body, _) = cut(detail["body"].as_str().unwrap_or_default(), PAGE_BUDGET / 2);
                    detail["body"] = json!(body);
                    detail["truncated"] = json!(true);
                    return detail;
                }
            },
        }
    }
    detail
}

/// A run's jobs (latest attempt) and artifacts, with summaries cut for the phone and earlier
/// attempts reduced to their outcome.
fn run_detail(id: i64, details: github_hub::RunDetails) -> Value {
    let jobs: Vec<Value> = details
        .jobs
        .into_iter()
        .map(|job| {
            let (summary, _) = cut(&job.summary, SUMMARY_LIMIT);
            json!({"id": job.id, "name": job.name, "state": job.state, "startedAt": job.started_at, "completedAt": job.completed_at, "url": job.url,
                "steps": job.steps.into_iter().map(|step| json!({"name": step.name, "state": step.state, "startedAt": step.started_at, "completedAt": step.completed_at})).collect::<Vec<_>>(),
                "summary": summary})
        })
        .collect();
    let attempts: Vec<Value> = details.attempts.into_iter().map(|attempt| json!({"attempt": attempt.attempt, "state": attempt.state, "startedAt": attempt.started_at, "updatedAt": attempt.updated_at, "url": attempt.url})).collect();
    let artifacts: Vec<Value> = details.artifacts.into_iter().map(|artifact| json!({"name": artifact.name, "size": artifact.size, "expired": artifact.expired})).collect();
    fit(jobs, move |jobs, truncated| json!({"kind": "run", "runId": id, "jobs": jobs, "attempts": attempts, "artifacts": artifacts, "truncated": truncated}))
}

impl Run for ItemCall {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            match self.item {
                Item::Run(id) => {
                    let repo = project_repo(&ctx, &self.project_id).await?;
                    let details = crate::blocking(move || github_hub::run_details(&repo, id)).await?;
                    Ok(run_detail(id, details))
                }
                Item::Issue(number) => {
                    let (root, trust) = (project_root(&ctx, &self.project_id).await?, Trust::phone(ctx.full_access));
                    let value = crate::blocking(move || view(&root, "issue", number, "number,title,state,url,author,body,labels,assignees,comments,createdAt,updatedAt", trust)).await?;
                    Ok(issue_detail("issue", &value))
                }
                Item::Pull(number) => {
                    let (root, trust) = (project_root(&ctx, &self.project_id).await?, Trust::phone(ctx.full_access));
                    let fields = "number,title,state,isDraft,url,author,body,labels,assignees,comments,createdAt,updatedAt,mergedAt,headRefName,baseRefName,reviewDecision,statusCheckRollup,additions,deletions";
                    let value = crate::blocking(move || view(&root, "pull", number, fields, trust)).await?;
                    Ok(issue_detail("pull", &value))
                }
            }
        })
    }
}

// ---- github.search ----

#[derive(Debug)]
struct Search {
    project_id: String,
    query: String,
}

/// Round 17: search qualifiers that could take `github.search` (View) past the project's own
/// repository; `gh` adds `repo:<origin>`, and GitHub ORs a second one.
const SCOPE_QUALIFIERS: [&str; 4] = ["repo:", "org:", "user:", "owner:"];
/// Why a query with one of the [`SCOPE_QUALIFIERS`] is refused.
const SCOPE_REFUSED: &str = "Search this project only: leave out repo:, org:, user: and owner: filters.";

/// The first [`SCOPE_QUALIFIERS`] term in `query`, matched case-insensitively at the start of
/// a word, also when quoted (`"repo:a/b"`), negated (`-org:x`) or grouped (`(user:x`).
fn scope_qualifier(query: &str) -> Option<&'static str> {
    let words = query.to_lowercase().replace(['"', '\'', '(', ')', '`'], " ");
    words.split_whitespace().find_map(|word| {
        let word = word.trim_start_matches(['-', '+', '!', '~']);
        SCOPE_QUALIFIERS.into_iter().find(|qualifier| word.starts_with(qualifier))
    })
}

/// Whether a result's `url` belongs to `repo` (`owner/name`), case-insensitively.
fn in_repo(url: &str, repo: &str) -> bool {
    url.to_ascii_lowercase().strip_prefix("https://github.com/").and_then(|rest| rest.strip_prefix(&format!("{}/", repo.to_ascii_lowercase()))).is_some_and(|rest| rest.starts_with("issues/") || rest.starts_with("pull/"))
}

fn parse_search(params: &Value) -> Result<Box<dyn Run>> {
    let query = params["query"].as_str().map(str::trim).unwrap_or_default();
    if query.is_empty() || query.len() > MAX_QUERY || query.contains('\0') {
        return Err("Search with 1 to 200 characters.".into());
    }
    if scope_qualifier(query).is_some() {
        return Err(SCOPE_REFUSED.into());
    }
    Ok(Box::new(Search { project_id: id_param(params, "projectId")?, query: query.to_owned() }))
}

impl Run for Search {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (root, trust) = (project_root(&ctx, &self.project_id).await?, Trust::phone(ctx.full_access));
            let query = self.query;
            let items = crate::blocking(move || {
                // Only the project's own repository's results, whatever the query matched.
                let repo = github_hub::base_repo(&root).ok_or("This project has no GitHub remote.")?;
                let items = crate::github::search_as(&root, &query, SEARCH_LIMIT, trust)?;
                Ok(items.into_iter().filter(|item| in_repo(&item.url, &repo)).collect::<Vec<_>>())
            })
            .await?;
            let items = items.into_iter().map(|item| serde_json::to_value(item).unwrap_or_default()).collect();
            Ok(fit(items, list_reply("items")))
        })
    }
}

// ---- github.comment ----

#[derive(Debug)]
struct Comment {
    project_id: String,
    pull: bool,
    number: i64,
    body: String,
    /// A retry with the same id answers the first comment instead of posting twice (`once_per_action`).
    send_id: Option<String>,
}

fn parse_comment(params: &Value) -> Result<Box<dyn Run>> {
    let pull = match params["kind"].as_str() {
        Some("issue") | None => false,
        Some("pull") => true,
        _ => return Err("Comment on an issue or a pull request.".into()),
    };
    let body = text_param(params, "body")?;
    if body.chars().count() > MAX_COMMENT {
        return Err("GitHub comments are at most 65,536 characters.".into());
    }
    Ok(Box::new(Comment { project_id: id_param(params, "projectId")?, pull, number: positive(params, "number")?, body, send_id: super::send_id_param(params)? }))
}

impl Run for Comment {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (root, trust) = (project_root(&ctx, &self.project_id).await?, Trust::phone(ctx.full_access));
            let Comment { project_id, pull, number, body, send_id } = *self;
            let target = super::github_comment_target(&project_id, number);
            super::once_per_action(ctx.from, "github.comment", &target, send_id.as_deref(), async move {
                let url = crate::blocking(move || {
                    let args = comment_args(&base_repo(&root)?, pull, number, &body);
                    let capture = gh_in(&root, &args.iter().map(String::as_str).collect::<Vec<_>>(), trust)?;
                    Ok(String::from_utf8_lossy(&capture.bytes).lines().map(str::trim).find(|line| line.starts_with("https://")).unwrap_or_default().to_owned())
                })
                .await?;
                Ok(json!({"url": url}))
            })
            .await
        })
    }
}

// ---- pull.review ----

/// Room for `bounded_text`'s `[Truncated]` mark within GitHub's comment limit (bytes bound
/// characters from above, so the cut text is always under [`MAX_COMMENT`] characters).
const REVIEW_BODY: usize = MAX_COMMENT - "[Truncated]".len();

#[derive(Debug)]
struct Review {
    session_id: String,
    event: ReviewEvent,
    body: String,
    /// A retry with the same id answers the first review instead of reviewing twice (`once_per_action`).
    send_id: Option<String>,
}

fn parse_review(params: &Value) -> Result<Box<dyn Run>> {
    let event = params["event"].as_str().and_then(ReviewEvent::parse).ok_or("Approve, request changes or comment.")?;
    let body = match params.get("body").filter(|value| !value.is_null()) {
        None => String::new(),
        Some(value) => value.as_str().ok_or("Invalid body.")?.trim().to_owned(),
    };
    if event.needs_body() && body.is_empty() {
        return Err("Write a comment for this review.".into());
    }
    Ok(Box::new(Review { session_id: id_param(params, "sessionId")?, event, body: bounded_text(&body, REVIEW_BODY), send_id: super::send_id_param(params)? }))
}

impl Run for Review {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let Review { session_id, event, body, send_id } = *self;
            let trust = Trust::phone(ctx.full_access);
            super::once_per_action(ctx.from, "pull.review", &session_id, send_id.as_deref(), async {
                // The task's linked pull request, in the task's checkout, as `task.pull` reads it.
                let (root, number) = linked_pull(&ctx.state(), &session_id).await?;
                crate::blocking(move || review_pull_as(&root, &base_repo(&root)?, number, event, &body, trust)).await?;
                // The 30 s pull cache would otherwise show the timeline from before the review.
                super::invalidate_pull_cache(&session_id);
                Ok(json!({"number": number}))
            })
            .await
        })
    }
}

// ---- github.startTask ----

#[derive(Debug)]
struct StartTask {
    project_id: String,
    issue: i64,
    /// Required: the start runs once per (viewer, id) on the never-expiring Start lane.
    start_id: String,
    /// Validated `task.start` params (provider, model, mode, effort, worktree, startId).
    start: Value,
}

/// The desktop's Solve prompt (`issuePrompt('solve', …)` in src/github-hub-prompts.ts).
fn solve_prompt(number: i64, title: &str) -> String {
    format!("Fix issue #{number}: {title}. Work on a new branch, make the change, add or update tests and run them. When it's done, summarize what changed and offer to open a pull request that closes #{number}.")
}

/// The desktop's thread title for a solved issue (`threadTitle('issue', 'solve', …)`).
fn solve_title(number: i64, title: &str) -> String {
    format!("Fix #{number}: {title}").chars().take(TITLE_LIMIT).collect()
}

fn parse_start_task(params: &Value) -> Result<Box<dyn Run>> {
    let project_id = id_param(params, "projectId")?;
    let issue = positive(params, "issueNumber")?;
    let mut start = json!({
        "projectId": project_id,
        "prompt": "-",
        "provider": name_param(params, "provider")?.ok_or("Missing provider.")?,
        "model": name_param(params, "model")?.ok_or("Missing model.")?,
        "worktree": params["worktree"].as_bool().unwrap_or(false),
    });
    let start_id = name_param(params, "startId")?.ok_or("Missing startId.")?;
    super::valid_id(&start_id).map_err(|_| "Invalid startId.")?;
    start["startId"] = json!(start_id);
    for key in ["mode", "effort"] {
        if let Some(value) = name_param(params, key)? {
            start[key] = json!(value);
        }
    }
    // Validated now with a stand-in prompt: the real one needs the issue's title.
    super::super::start::parse(&start)?;
    Ok(Box::new(StartTask { project_id, issue, start_id, start }))
}

/// Without "Full access for remote tasks" a remote start may not ask for Full access, and
/// gets Ask when it names no mode (as `host::cap_mode` does for `task.start`).
fn capped_mode(mode: Option<String>, full_access: bool) -> Result<Option<String>> {
    match mode {
        _ if full_access => Ok(mode),
        Some(mode) if mode == "full" => Err(super::full_access_off()),
        Some(mode) => Ok(Some(mode)),
        None => Ok(Some("ask".into())),
    }
}

impl Run for StartTask {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let task = *self;
            let (app, from, full_access) = (ctx.app.clone(), ctx.from.to_owned(), ctx.full_access);
            // Once per (viewer, startId), like `task.start`: a retry after a lost reply starts no
            // second task, `task.startStatus` follows it and a panicked start still settles.
            let id = task.start_id.clone();
            super::super::host::start_keyed(ctx.from, &id, move |cancel| async move { solve_issue(&app, &from, full_access, task, cancel).await }).await
        })
    }
}

/// Starts a task on the issue's Solve prompt, then names and links it like the desktop's Solve.
async fn solve_issue(app: &tauri::AppHandle, from: &str, full_access: bool, task: StartTask, cancel: Arc<super::super::start::Cancel>) -> Result<Value> {
    let root = project_root_in(app, &task.project_id).await?;
    let number = task.issue;
    let trust = Trust::phone(full_access);
    let issue = crate::blocking(move || view(&root, "issue", number, "number,title,state,url", trust)).await?;
    let title = text(&issue, "title");
    let mut params = task.start;
    params["prompt"] = json!(solve_prompt(number, &title));
    let mut start = super::super::start::parse(&params)?;
    start.mode = capped_mode(start.mode.take(), full_access)?;
    // The saved default team only with the switch: its workers always run in full access.
    start.team = full_access;
    // Every Git call of the start (fetch, worktree, checkout) runs with the caller's trust.
    start.full_access = Some(full_access);
    let reply = super::super::start::run_cancellable(app, from, start, cancel).await?;
    // Named and linked like the desktop's Solve; the task already runs if this fails.
    if let Some(session_id) = reply["sessionId"].as_str().map(str::to_owned) {
        let link = crate::storage::TaskLink { kind: "issue".into(), number, url: text(&issue, "url"), title: title.clone(), state: "open".into(), checked_at: crate::storage::now() };
        let store = app.state::<AppState>().store.clone();
        let named = solve_title(number, &title);
        let saved = crate::blocking(move || {
            let store = store.lock().map_err(|e| e.to_string())?;
            store.set_task_link(&session_id, "issue", Some(&link))?;
            store.update(&session_id, Some(named), None, None, None)
        })
        .await;
        if let Err(error) = saved {
            eprintln!("github.startTask: could not name or link the task: {error}");
        }
        let _ = app.emit("sessions-changed", ());
    }
    Ok(reply)
}

pub(crate) const METHODS: &[Method] = &[
    Method { name: "github.repos", access: Access::View, read_only: true, parse: |_| Ok(Box::new(Repos)) },
    Method { name: "github.issues", access: Access::View, read_only: true, parse: |p| parse_list(ListKind::Issues)(p) },
    Method { name: "github.pulls", access: Access::View, read_only: true, parse: |p| parse_list(ListKind::Pulls)(p) },
    Method { name: "github.runs", access: Access::View, read_only: true, parse: |p| parse_list(ListKind::Runs)(p) },
    Method { name: "github.item", access: Access::View, read_only: true, parse: parse_item },
    Method { name: "github.search", access: Access::View, read_only: true, parse: parse_search },
    Method { name: "github.comment", access: Access::Full, read_only: false, parse: parse_comment },
    Method { name: "github.startTask", access: Access::Full, read_only: false, parse: parse_start_task },
    Method { name: "pull.review", access: Access::Full, read_only: false, parse: parse_review },
];

#[cfg(test)]
mod tests {
    use super::*;

    fn method(name: &str) -> &'static Method {
        METHODS.iter().find(|m| m.name == name).unwrap()
    }

    #[test]
    fn bot_and_chat_projects_are_hidden() {
        let bots = vec!["bot-project".to_owned()];
        assert!(hidden_project(&bots, "bot-project", std::path::Path::new("/tmp/anything")).is_some());
        assert!(hidden_project(&bots, "p1", &crate::chats::root().join("Chat 1")).is_some());
        assert_eq!(hidden_project(&bots, "p1", std::path::Path::new("/tmp/code/app")), None);
    }

    #[test]
    fn reads_are_view_and_actions_need_full_access() {
        for name in ["github.repos", "github.issues", "github.pulls", "github.runs", "github.item", "github.search"] {
            assert_eq!(method(name).access, Access::View, "{name}");
            assert!(method(name).read_only, "{name}");
        }
        for name in ["github.comment", "github.startTask"] {
            assert_eq!(method(name).access, Access::Full, "{name}");
            assert!(!method(name).read_only, "{name}");
        }
    }

    #[test]
    fn lists_and_items_need_a_project_and_a_positive_number() {
        assert!((method("github.issues").parse)(&json!({})).is_err());
        assert!((method("github.pulls").parse)(&json!({"projectId": "p 1"})).is_err());
        assert!((method("github.runs").parse)(&json!({"projectId": "p1"})).is_ok());
        assert!((method("github.item").parse)(&json!({"projectId": "p1", "kind": "issue", "number": 4})).is_ok());
        assert!((method("github.item").parse)(&json!({"projectId": "p1", "kind": "pull", "number": 0})).is_err());
        assert!((method("github.item").parse)(&json!({"projectId": "p1", "kind": "pull", "number": "4"})).is_err());
        assert!((method("github.item").parse)(&json!({"projectId": "p1", "kind": "run", "runId": 99})).is_ok());
        assert!((method("github.item").parse)(&json!({"projectId": "p1", "kind": "run", "number": 99})).is_err());
        assert!((method("github.item").parse)(&json!({"projectId": "p1", "kind": "commit", "number": 1})).is_err());
    }

    #[test]
    fn searches_and_comments_are_bounded() {
        assert!((method("github.search").parse)(&json!({"projectId": "p1", "query": "  "})).is_err());
        assert!((method("github.search").parse)(&json!({"projectId": "p1", "query": "x".repeat(201)})).is_err());
        assert!((method("github.search").parse)(&json!({"projectId": "p1", "query": "--repo=evil/x"})).is_ok(), "passed to gh as --search=…");
        assert!((method("github.comment").parse)(&json!({"projectId": "p1", "number": 3, "body": ""})).is_err());
        assert!((method("github.comment").parse)(&json!({"projectId": "p1", "number": 3, "kind": "commit", "body": "hi"})).is_err());
        assert!((method("github.comment").parse)(&json!({"projectId": "p1", "number": 3, "body": "x".repeat(MAX_COMMENT + 1)})).is_err());
        assert!((method("github.comment").parse)(&json!({"projectId": "p1", "number": 3, "kind": "pull", "body": "Looks good"})).is_ok());
        let keyed = (method("github.comment").parse)(&json!({"projectId": "p1", "number": 3, "body": "hi", "sendId": "abc-1"})).unwrap();
        assert!(format!("{keyed:?}").contains("send_id: Some(\"abc-1\")"));
        assert!((method("github.comment").parse)(&json!({"projectId": "p1", "number": 3, "body": "hi", "sendId": "a b"})).is_err());
    }

    #[test]
    fn github_search_stays_in_the_projects_repository() {
        let search = |query: &str| (method("github.search").parse)(&json!({"projectId": "p1", "query": query}));
        for query in ["repo:evil/x", "bug REPO:evil/x", "\"repo:evil/x\"", "bug \"Org:evil\"", "-user:someone", "(owner:evil OR x)", "x 'repo:a/b'"] {
            assert_eq!(search(query).unwrap_err(), SCOPE_REFUSED, "{query}");
        }
        for query in ["crash on start", "#12", "label:bug", "fix user login", "repository: crash", "author:me", "report:x", "is:open", "label:x Is:Issue"] {
            assert!(search(query).is_ok(), "{query}");
        }
        assert!(in_repo("https://github.com/orbit-labs/meadow/issues/4", "orbit-labs/meadow"));
        assert!(in_repo("https://github.com/Orbit-Labs/Meadow/pull/7", "orbit-labs/meadow"));
        for url in ["https://github.com/evil/meadow/issues/4", "https://github.com/orbit-labs/meadow-fork/pull/1", "https://github.com/orbit-labs/meadow", "http://github.com/orbit-labs/meadow/issues/4", "https://evil.com/orbit-labs/meadow/issues/4", ""] {
            assert!(!in_repo(url, "orbit-labs/meadow"), "{url}");
        }
        // The filter runs on every result, after `gh`.
        let source = include_str!("github.rs");
        let body = &source[source.find("impl Run for Search").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains(".filter(|item| in_repo(&item.url, &repo))"));
    }

    #[test]
    fn phone_gh_calls_pin_the_projects_repository() {
        assert_eq!(comment_args("o/r", true, 3, "--approve"), ["pr", "comment", "3", "--repo=o/r", "--body=--approve"]);
        assert_eq!(comment_args("o/r", false, 3, "hi")[0], "issue");
        // Every `gh` view, comment or review the phone runs names the base repository.
        let source = include_str!("github.rs");
        let code = &source[..source.find("#[cfg(test)]").unwrap()];
        let view = &code[code.find("fn view(root: &Path").unwrap()..];
        let view = &view[..view.find("\n}\n").unwrap()];
        assert!(view.contains("let repo = base_repo(root)?;") && view.contains("view_in_as(root, Some(&repo),"));
        assert!(!code.contains("crate::github::view_as("), "no unpinned view");
        assert!(!code.contains("\"comment\", &number"), "comments go through comment_args");
        assert!(code.contains("comment_args(&base_repo(&root)?, pull, number, &body)"));
        assert!(code.contains("review_pull_as(&root, &base_repo(&root)?, number, event, &body, trust)"));
        // The issue and pull views and the Solve lookup all go through `view`.
        assert_eq!(code.matches("crate::blocking(move || view(&root, ").count(), 3);
        // Every other `gh` run in the checkout is `gh_in`'s comment, and `search_as` filters by the base repository.
        assert_eq!(code.matches("gh_in(&root").count(), 1);
        assert_eq!(code.matches("run_gh_as(").count(), 1, "only gh_in itself");
        // `--repo=` reaches gh as one flag, ahead of user text, in both builders.
        let lib = include_str!("../../github.rs");
        let review = &lib[lib.find("fn pr_review_args(").unwrap()..];
        assert!(review[..review.find("\n}\n").unwrap()].contains("flag(\"repo\", repo)"));
        let views = &lib[lib.find("fn view_args(").unwrap()..];
        assert!(views[..views.find("\n}\n").unwrap()].contains("flag(\"repo\", repo)"));
    }

    #[test]
    fn reviews_need_full_access_and_are_validated_and_bounded() {
        let review = method("pull.review");
        // It speaks on GitHub as the user's `gh` account, like `github.comment`.
        assert_eq!(review.access, Access::Full);
        assert!(!review.read_only);
        let parse = review.parse;
        assert!(parse(&json!({"sessionId": "s1", "event": "approve"})).is_ok(), "an approval needs no text");
        assert!(parse(&json!({"sessionId": "s1", "event": "approve", "body": null})).is_ok());
        assert!(parse(&json!({"sessionId": "s1", "event": "comment"})).is_err());
        assert!(parse(&json!({"sessionId": "s1", "event": "request_changes", "body": "   "})).is_err());
        assert!(parse(&json!({"sessionId": "s1", "event": "--approve", "body": "x"})).is_err());
        assert!(parse(&json!({"sessionId": "s 1", "event": "approve"})).is_err());
        assert!(parse(&json!({"event": "approve"})).is_err());
        assert!(parse(&json!({"sessionId": "s1", "event": "comment", "body": 3})).is_err());
        assert!(parse(&json!({"sessionId": "s1", "event": "comment", "body": "hi", "sendId": "a b"})).is_err());
        let keyed = format!("{:?}", parse(&json!({"sessionId": "s1", "event": "comment", "body": "  hi  ", "sendId": "abc-1"})).unwrap());
        assert!(keyed.contains("send_id: Some(\"abc-1\")") && keyed.contains("body: \"hi\"") && keyed.contains("Comment"), "{keyed}");
        let long = format!("{:?}", parse(&json!({"sessionId": "s1", "event": "comment", "body": "é".repeat(MAX_COMMENT)})).unwrap());
        assert!(long.contains("[Truncated]"));
        assert!(long.len() < MAX_COMMENT + 200);
    }

    #[test]
    fn reviews_run_gh_through_the_trust_variant_once_per_send() {
        let source = include_str!("github.rs");
        let body = &source[source.find("impl Run for Review {").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("review_pull_as(&root, &base_repo(&root)?, number, event, &body, trust)"));
        assert!(body.contains("Trust::phone(ctx.full_access)"));
        assert!(body.contains("once_per_action(ctx.from, \"pull.review\", &session_id, send_id.as_deref()"));
        assert!(!body.contains("run_gh("));
    }

    #[test]
    fn start_task_validates_like_task_start() {
        let ok = json!({"projectId": "p1", "issueNumber": 12, "provider": "claude", "model": "default", "startId": "st-1"});
        assert!((method("github.startTask").parse)(&ok).is_ok());
        let parsed = format!("{:?}", (method("github.startTask").parse)(&ok).unwrap());
        assert!(parsed.contains("start_id: \"st-1\""), "{parsed}");
        for bad in [Value::Null, json!("a b"), json!(7)] {
            let mut params = ok.clone();
            params["startId"] = bad;
            assert!((method("github.startTask").parse)(&params).is_err(), "a start is deduped by its startId");
        }
        assert!((method("github.startTask").parse)(&json!({"projectId": "p1", "issueNumber": 12, "provider": "claude"})).is_err());
        assert!((method("github.startTask").parse)(&json!({"projectId": "p1", "issueNumber": -1, "provider": "claude", "model": "m"})).is_err());
        assert!((method("github.startTask").parse)(&json!({"projectId": "p1", "issueNumber": 1, "provider": "claude", "model": "m", "mode": "a b"})).is_err());
    }

    #[test]
    fn full_access_is_capped_without_the_host_setting() {
        assert!(capped_mode(Some("full".into()), false).is_err());
        assert_eq!(capped_mode(None, false).unwrap().as_deref(), Some("ask"));
        assert_eq!(capped_mode(Some("edit".into()), false).unwrap().as_deref(), Some("edit"));
        assert_eq!(capped_mode(Some("full".into()), true).unwrap().as_deref(), Some("full"));
        assert_eq!(capped_mode(None, true).unwrap(), None);
    }

    #[test]
    fn solve_matches_the_desktop_prompt_and_title() {
        assert!(solve_prompt(7, "Crash on start").starts_with("Fix issue #7: Crash on start. Work on a new branch"));
        assert!(solve_prompt(7, "x").ends_with("closes #7."));
        assert_eq!(solve_title(7, "Crash"), "Fix #7: Crash");
        assert_eq!(solve_title(7, &"é".repeat(300)).chars().count(), TITLE_LIMIT);
    }

    #[test]
    fn checks_fold_into_four_states() {
        assert_eq!(check_state(&json!({"conclusion": "SUCCESS", "status": "COMPLETED"})), "success");
        assert_eq!(check_state(&json!({"conclusion": "FAILURE"})), "failure");
        assert_eq!(check_state(&json!({"state": "PENDING"})), "pending");
        assert_eq!(check_state(&json!({})), "pending");
        assert_eq!(check_state(&json!({"conclusion": "SKIPPED"})), "neutral");
        let checks = checks_of(&json!({"statusCheckRollup": [{"name": "build", "conclusion": "SUCCESS", "detailsUrl": "https://x"}, {"context": "ci/legacy", "state": "ERROR", "targetUrl": "https://y"}]}));
        assert_eq!(checks[0]["name"], "build");
        assert_eq!(checks[1]["name"], "ci/legacy");
        assert_eq!(checks[1]["state"], "failure");
        assert_eq!(checks[1]["url"], "https://y");
    }

    #[test]
    fn items_keep_the_newest_comments_and_fit_a_page() {
        let comments: Vec<Value> = (0..40).map(|i| json!({"author": {"login": "a"}, "body": format!("c{i} {}", "x".repeat(10_000)), "createdAt": "2026-01-01T00:00:00Z"})).collect();
        let value = json!({"number": 5, "title": "T", "state": "OPEN", "url": "https://github.com/o/r/pull/5", "author": {"login": "me"}, "body": "y".repeat(40_000), "comments": comments,
            "headRefName": "fix", "baseRefName": "main", "mergedAt": "2026-01-02T00:00:00Z", "statusCheckRollup": [{"name": "ci", "conclusion": "SUCCESS"}]});
        let detail = issue_detail("pull", &value);
        assert!(detail.to_string().len() <= PAGE_BUDGET);
        assert_eq!(detail["state"], "merged");
        assert_eq!(detail["truncated"], true, "the body was cut");
        let shown = detail["comments"].as_array().unwrap();
        assert!(!shown.is_empty() && shown.len() <= COMMENTS_SHOWN);
        assert_eq!(shown.len() as u64 + detail["earlierComments"].as_u64().unwrap(), 40);
        assert!(shown.last().unwrap()["body"].as_str().unwrap().starts_with("c39 "), "newest last");
        assert_eq!(shown[0]["truncated"], true);
        assert_eq!(detail["checks"][0]["state"], "success");
        let issue = issue_detail("issue", &json!({"number": 1, "title": "I", "state": "OPEN"}));
        assert!(issue.get("checks").is_none());
        assert_eq!(issue["state"], "open");
    }

    #[test]
    fn lists_drop_items_past_the_page_budget() {
        let items: Vec<Value> = (0..400).map(|i| json!({"number": i, "title": "t".repeat(1000)})).collect();
        let reply = fit(items, list_reply("items"));
        assert!(reply.to_string().len() <= PAGE_BUDGET);
        assert_eq!(reply["truncated"], true);
        assert_eq!(fit(vec![json!(1)], list_reply("items"))["truncated"], false);
    }

    #[test]
    fn runs_cut_summaries_and_fit() {
        let job = |id: i64| github_hub::RunJob { id, name: "build".into(), state: "failed".into(), summary: "s".repeat(9000), ..Default::default() };
        let details = github_hub::RunDetails { jobs: (0..200).map(job).collect(), ..Default::default() };
        let reply = run_detail(9, details);
        assert!(reply.to_string().len() <= PAGE_BUDGET);
        assert_eq!(reply["runId"], 9);
        assert!(reply["jobs"][0]["summary"].as_str().unwrap().len() <= SUMMARY_LIMIT);
    }
}
