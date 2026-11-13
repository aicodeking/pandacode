//! The GitHub view: the signed-in account's repositories and each repository's open pull
//! requests and issues, read by `owner/name` so a repository needs no local checkout to
//! browse. Local projects are matched to repositories by their `origin` remote, and a
//! repository can be cloned into a folder the user picks. Everything goes through `gh`
//! with bounded output and a deadline (`workspace::run_process`); user text reaches `gh`
//! only as validated arguments.
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use crate::github::{json, names, run_gh, state_of, text, TIMEOUT};

const LIST_LIMIT: &str = "50";
const CLONE_TIMEOUT: Duration = Duration::from_secs(600);
/// How much of a job's check-run summary the view shows.
const SUMMARY_LIMIT: usize = 8 * 1024;
/// How many earlier attempts of a re-run are read.
const ATTEMPTS_LIMIT: i64 = 5;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubRepo {
    pub name_with_owner: String,
    pub description: String,
    pub private: bool,
    pub fork: bool,
    pub archived: bool,
    pub pushed_at: String,
    pub url: String,
    pub default_branch: String,
    pub open_issues: i64,
    pub language: String,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubPull {
    pub number: i64,
    pub title: String,
    pub author: String,
    pub state: String,
    pub head: String,
    pub base: String,
    pub updated_at: String,
    pub url: String,
    pub review: String,
    pub checks: String,
    pub additions: i64,
    pub deletions: i64,
    pub labels: Vec<String>,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubIssue {
    pub number: i64,
    pub title: String,
    pub author: String,
    pub updated_at: String,
    pub url: String,
    pub comments: i64,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubRun {
    pub id: i64,
    pub workflow: String,
    pub title: String,
    pub branch: String,
    pub event: String,
    /// queued, in_progress, passed, failed, not_started or cancelled (`run_state`).
    pub state: String,
    pub created_at: String,
    pub started_at: String,
    pub updated_at: String,
    pub url: String,
    /// How many times the run was attempted; re-runs count up from 1.
    pub attempt: i64,
    /// Pull requests in this repository the run's head belongs to (empty for forks).
    pub pulls: Vec<i64>,
}
/// A run's jobs and uploaded artifacts, read when its row is expanded, and its earlier
/// attempts (newest first) when it was re-run.
#[derive(Debug, Serialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunDetails {
    pub jobs: Vec<RunJob>,
    pub artifacts: Vec<RunArtifact>,
    pub attempts: Vec<RunAttempt>,
}
#[derive(Debug, Serialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunJob {
    pub id: i64,
    pub name: String,
    pub state: String,
    pub started_at: String,
    pub completed_at: String,
    pub url: String,
    pub steps: Vec<RunStep>,
    /// The job's check-run summary and text (Markdown), at most `SUMMARY_LIMIT` bytes.
    pub summary: String,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunStep {
    pub name: String,
    pub state: String,
    pub started_at: String,
    pub completed_at: String,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunAttempt {
    pub attempt: i64,
    pub state: String,
    pub started_at: String,
    pub updated_at: String,
    pub url: String,
    pub jobs: Vec<RunJob>,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunArtifact {
    pub name: String,
    pub size: i64,
    pub expired: bool,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRepo {
    pub project_id: String,
    pub repo: String,
}

/// `owner/name` as GitHub allows it, never an option or a path.
pub fn valid_repo(value: &str) -> Result<String, String> {
    let value = value.trim();
    let part = |s: &str| !s.is_empty() && s.len() <= 100 && !s.starts_with(['-', '.']) && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    match value.split_once('/') {
        Some((owner, name)) if part(owner) && part(name) && !name.contains('/') && name != ".." => Ok(value.to_string()),
        _ => Err("Choose a GitHub repository (owner/name).".into()),
    }
}

/// The `owner/name` a GitHub remote URL points at, for HTTPS, SSH and scp-style remotes.
pub fn repo_from_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let path = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| url.strip_prefix("https://github.com/"))
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("git://github.com/"))?;
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    valid_repo(path).ok()
}

fn account_root() -> PathBuf {
    crate::agent_usage_providers::home().unwrap_or_else(std::env::temp_dir)
}

fn repo_of(value: &serde_json::Value) -> HubRepo {
    HubRepo {
        name_with_owner: text(value, "full_name"),
        description: text(value, "description"),
        private: value.get("private").and_then(|v| v.as_bool()).unwrap_or(false),
        fork: value.get("fork").and_then(|v| v.as_bool()).unwrap_or(false),
        archived: value.get("archived").and_then(|v| v.as_bool()).unwrap_or(false),
        pushed_at: text(value, "pushed_at"),
        url: text(value, "html_url"),
        default_branch: text(value, "default_branch"),
        open_issues: value.get("open_issues_count").and_then(|v| v.as_i64()).unwrap_or(0),
        language: text(value, "language"),
    }
}

/// Repositories the account owns, collaborates on or reaches through an organization,
/// most recently pushed first.
pub fn repos() -> Result<Vec<HubRepo>, String> {
    let capture = run_gh(&account_root(), &["api", "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member"], TIMEOUT)?;
    let value = json(&capture)?;
    let items = value.as_array().ok_or("GitHub returned an unexpected response.")?;
    Ok(items.iter().map(repo_of).filter(|repo| valid_repo(&repo.name_with_owner).is_ok()).collect())
}

/// One word for a pull request's checks: passing, failing, pending or none.
pub fn checks_summary(rollup: Option<&serde_json::Value>) -> String {
    let Some(items) = rollup.and_then(|v| v.as_array()) else { return "none".into() };
    if items.is_empty() {
        return "none".into();
    }
    let outcome = |item: &serde_json::Value| text(item, "conclusion").to_ascii_uppercase() + &text(item, "state").to_ascii_uppercase();
    let outcomes: Vec<String> = items.iter().map(outcome).collect();
    if outcomes.iter().any(|o| ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].iter().any(|bad| o.contains(bad))) {
        "failing".into()
    } else if outcomes.iter().any(|o| o.is_empty() || ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED"].iter().any(|wait| o.contains(wait))) {
        "pending".into()
    } else {
        "passing".into()
    }
}

fn author(value: &serde_json::Value) -> String {
    value.get("author").map(|author| text(author, "login")).unwrap_or_default()
}

pub fn pulls(repo: &str) -> Result<Vec<HubPull>, String> {
    let repo = valid_repo(repo)?;
    let fields = "number,title,author,state,isDraft,headRefName,baseRefName,updatedAt,url,reviewDecision,statusCheckRollup,additions,deletions,labels";
    let capture = run_gh(&account_root(), &["pr", "list", &format!("--repo={repo}"), "--state=open", &format!("--limit={LIST_LIMIT}"), &format!("--json={fields}")], TIMEOUT)?;
    let value = json(&capture)?;
    let items = value.as_array().ok_or("GitHub returned an unexpected response.")?;
    Ok(items
        .iter()
        .map(|item| HubPull {
            number: item.get("number").and_then(|v| v.as_i64()).unwrap_or_default(),
            title: text(item, "title"),
            author: author(item),
            state: state_of(item),
            head: text(item, "headRefName"),
            base: text(item, "baseRefName"),
            updated_at: text(item, "updatedAt"),
            url: text(item, "url"),
            review: text(item, "reviewDecision").to_ascii_lowercase(),
            checks: checks_summary(item.get("statusCheckRollup")),
            additions: item.get("additions").and_then(|v| v.as_i64()).unwrap_or_default(),
            deletions: item.get("deletions").and_then(|v| v.as_i64()).unwrap_or_default(),
            labels: names(item, "labels", "name"),
        })
        .collect())
}

pub fn issues(repo: &str) -> Result<Vec<HubIssue>, String> {
    let repo = valid_repo(repo)?;
    let capture = run_gh(&account_root(), &["issue", "list", &format!("--repo={repo}"), "--state=open", &format!("--limit={LIST_LIMIT}"), "--json=number,title,author,updatedAt,url,comments,labels,assignees"], TIMEOUT)?;
    let value = json(&capture)?;
    let items = value.as_array().ok_or("GitHub returned an unexpected response.")?;
    Ok(items
        .iter()
        .map(|item| HubIssue {
            number: item.get("number").and_then(|v| v.as_i64()).unwrap_or_default(),
            title: text(item, "title"),
            author: author(item),
            updated_at: text(item, "updatedAt"),
            url: text(item, "url"),
            comments: item.get("comments").and_then(|v| v.as_array()).map_or(0, |c| c.len() as i64),
            labels: names(item, "labels", "name"),
            assignees: names(item, "assignees", "login"),
        })
        .collect())
}

/// One word for a workflow run or job from its status and conclusion. A run that never
/// started (an invalid workflow file, a missing runner) is `not_started`, not a failure to fix in code.
pub fn run_state(status: &str, conclusion: &str) -> String {
    match (status.to_ascii_lowercase().as_str(), conclusion.to_ascii_lowercase().as_str()) {
        ("completed", "success" | "neutral" | "skipped") => "passed",
        ("completed", "cancelled") => "cancelled",
        ("completed", "startup_failure") => "not_started",
        ("completed", _) => "failed",
        ("in_progress", _) => "in_progress",
        _ => "queued",
    }
    .into()
}

fn number(value: &serde_json::Value, key: &str) -> i64 {
    value.get(key).and_then(|v| v.as_i64()).unwrap_or_default()
}
fn list<'a>(value: &'a serde_json::Value, key: &str) -> &'a [serde_json::Value] {
    value.get(key).and_then(|v| v.as_array()).map_or(&[], |items| items.as_slice())
}

/// Runs from the REST `actions/runs` response.
pub fn runs_of(value: &serde_json::Value) -> Vec<HubRun> {
    list(value, "workflow_runs")
        .iter()
        .map(|item| HubRun {
            id: number(item, "id"),
            workflow: text(item, "name"),
            title: text(item, "display_title"),
            branch: text(item, "head_branch"),
            event: text(item, "event"),
            state: run_state(&text(item, "status"), &text(item, "conclusion")),
            created_at: text(item, "created_at"),
            started_at: text(item, "run_started_at"),
            updated_at: text(item, "updated_at"),
            url: text(item, "html_url"),
            attempt: number(item, "run_attempt").max(1),
            pulls: list(item, "pull_requests").iter().map(|pull| number(pull, "number")).filter(|n| *n > 0).collect(),
        })
        .collect()
}

/// The repository's most recent workflow runs, newest first.
pub fn runs(repo: &str) -> Result<Vec<HubRun>, String> {
    let repo = valid_repo(repo)?;
    let capture = run_gh(&account_root(), &["api", &format!("repos/{repo}/actions/runs?per_page={LIST_LIMIT}")], TIMEOUT)?;
    Ok(runs_of(&json(&capture)?))
}

/// At most `limit` bytes of `value`, cut on a character boundary and marked when cut.
fn bounded(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n\n…", &value[..end])
}

/// Check-run summaries by id from the REST `check-runs` response: `output.summary` and `output.text`.
pub fn summaries_of(value: &serde_json::Value) -> std::collections::HashMap<i64, String> {
    list(value, "check_runs")
        .iter()
        .filter_map(|check| {
            let output = check.get("output")?;
            let parts: Vec<String> = [text(output, "summary"), text(output, "text")].into_iter().filter(|part| !part.trim().is_empty()).collect();
            (!parts.is_empty()).then(|| (number(check, "id"), bounded(&parts.join("\n\n"), SUMMARY_LIMIT)))
        })
        .collect()
}

fn job_of(job: &serde_json::Value, summaries: &std::collections::HashMap<i64, String>) -> RunJob {
    let id = number(job, "id");
    RunJob {
        id,
        name: text(job, "name"),
        state: run_state(&text(job, "status"), &text(job, "conclusion")),
        started_at: text(job, "started_at"),
        completed_at: text(job, "completed_at"),
        url: text(job, "html_url"),
        steps: list(job, "steps")
            .iter()
            .map(|step| RunStep { name: text(step, "name"), state: run_state(&text(step, "status"), &text(step, "conclusion")), started_at: text(step, "started_at"), completed_at: text(step, "completed_at") })
            .collect(),
        summary: summaries.get(&id).cloned().unwrap_or_default(),
    }
}

/// Jobs (latest attempt) and artifacts from the REST `jobs` and `artifacts` responses.
#[cfg(test)]
pub fn details_of(jobs: &serde_json::Value, artifacts: &serde_json::Value) -> RunDetails {
    details_with(jobs, artifacts, &Default::default())
}
fn details_with(jobs: &serde_json::Value, artifacts: &serde_json::Value, summaries: &std::collections::HashMap<i64, String>) -> RunDetails {
    RunDetails {
        jobs: list(jobs, "jobs").iter().map(|job| job_of(job, summaries)).collect(),
        artifacts: list(artifacts, "artifacts")
            .iter()
            .map(|artifact| RunArtifact { name: text(artifact, "name"), size: number(artifact, "size_in_bytes"), expired: artifact.get("expired").and_then(|v| v.as_bool()).unwrap_or(false) })
            .collect(),
        attempts: Vec::new(),
    }
}

/// An earlier attempt from the REST `runs/{id}/attempts/{n}` response, with its jobs picked
/// from a `filter=all` jobs response.
pub fn attempt_of(run: &serde_json::Value, attempt: i64, all_jobs: &serde_json::Value, summaries: &std::collections::HashMap<i64, String>) -> RunAttempt {
    let url = text(run, "html_url");
    RunAttempt {
        attempt,
        state: run_state(&text(run, "status"), &text(run, "conclusion")),
        started_at: text(run, "run_started_at"),
        updated_at: text(run, "updated_at"),
        url: if url.is_empty() || url.contains("/attempts/") { url } else { format!("{url}/attempts/{attempt}") },
        jobs: list(all_jobs, "jobs").iter().filter(|job| number(job, "run_attempt") == attempt).map(|job| job_of(job, summaries)).collect(),
    }
}

pub fn run_details(repo: &str, id: i64) -> Result<RunDetails, String> {
    let repo = valid_repo(repo)?;
    if id <= 0 {
        return Err("Choose a workflow run.".into());
    }
    let root = account_root();
    let api = |path: String| run_gh(&root, &["api", &path], TIMEOUT).and_then(|capture| json(&capture));
    let jobs = api(format!("repos/{repo}/actions/runs/{id}/jobs?per_page=100"))?;
    let artifacts = api(format!("repos/{repo}/actions/runs/{id}/artifacts?per_page=100"))?;
    // Summaries are extra: one check-runs read for the commit, skipped if it fails.
    let sha = list(&jobs, "jobs").first().map(|job| text(job, "head_sha")).filter(|sha| !sha.is_empty() && sha.chars().all(|c| c.is_ascii_hexdigit()));
    let summaries = sha.and_then(|sha| api(format!("repos/{repo}/commits/{sha}/check-runs?filter=all&per_page=100")).ok()).map(|value| summaries_of(&value)).unwrap_or_default();
    let mut details = details_with(&jobs, &artifacts, &summaries);
    let latest = list(&jobs, "jobs").iter().map(|job| number(job, "run_attempt")).max().unwrap_or(1);
    if latest > 1 {
        let all_jobs = api(format!("repos/{repo}/actions/runs/{id}/jobs?filter=all&per_page=100")).unwrap_or_default();
        details.attempts = (1.max(latest - ATTEMPTS_LIMIT)..latest)
            .rev()
            .filter_map(|attempt| api(format!("repos/{repo}/actions/runs/{id}/attempts/{attempt}")).ok().map(|run| attempt_of(&run, attempt, &all_jobs, &summaries)))
            .collect();
    }
    Ok(details)
}

/// The GitHub repository behind a local project, from its `origin` remote.
///
/// Round 17: read straight from the repository's config file, never by running `git`, so a
/// phone's call (`projects.list`, `github.*`, starts) cannot reach anything the checkout's
/// config could make Git do, and needs no `Trust` (docs/remote-access.md, Round 17).
pub fn project_repo(root: &Path) -> Option<String> {
    let path = git_common_dir(root)?.join("config");
    repo_from_remote(&origin_url(&read_bounded(&path)?)?)
}

/// The repository `gh` itself acts on in the checkout at (or above) `root`, so a phone's pull
/// requests and GitHub lists match the desktop's `gh` in a fork checkout (Round 22): the remote
/// marked `gh-resolved` (`gh repo set-default`), then `upstream`, then `origin`. Like
/// [`project_repo`] it only reads the config file and runs nothing.
pub fn base_repo(root: &Path) -> Option<String> {
    base_of(&remotes(&checkout_config(root)?))
}

/// Every GitHub repository the checkout's remotes name, [`base_repo`]'s first, without
/// repeats; read like [`base_repo`]. `task.pullDetect` accepts pull request links in any of them.
pub fn github_remotes(root: &Path) -> Vec<String> {
    let Some(config) = checkout_config(root) else { return Vec::new() };
    let remotes = remotes(&config);
    let mut repos: Vec<String> = base_of(&remotes).into_iter().collect();
    for repo in remotes.iter().filter_map(|remote| remote.url.as_deref().and_then(repo_from_remote)) {
        if !repos.contains(&repo) {
            repos.push(repo);
        }
    }
    repos
}

/// The GitHub repository `workspace::git_push` pushes the branch to: the `origin` remote, else
/// the first remote by name (`git remote` lists them sorted). Read like [`base_repo`]; a phone's
/// `pull.create` names the head as `<owner>:<branch>` when it differs from the base (Round 23).
pub fn push_repo(root: &Path) -> Option<String> {
    push_of(&remotes(&checkout_config(root)?))
}

/// Round 24: Git pushes to the remote's last `pushurl` when it has one, so the head owner comes
/// from it before `url`.
fn push_of(remotes: &[Remote]) -> Option<String> {
    let remote = remotes.iter().find(|remote| remote.name == "origin").or_else(|| remotes.iter().min_by(|a, b| a.name.cmp(&b.name)))?;
    remote.push_url.as_deref().or(remote.url.as_deref()).and_then(repo_from_remote)
}

/// The name of the remote [`base_repo`] resolved, so its `refs/remotes/<name>/HEAD` names the
/// default branch of the repository a pull request opens in (Round 24). A `gh-resolved`
/// `owner/name` maps to the remote whose URL names that repository; None when none does.
pub fn base_remote(root: &Path) -> Option<String> {
    let remotes = remotes(&checkout_config(root)?);
    let repo = base_of(&remotes)?;
    let url_repo = |remote: &&Remote| remote.url.as_deref().and_then(repo_from_remote);
    let same = |remote: &&Remote| url_repo(remote).is_some_and(|found| found.eq_ignore_ascii_case(&repo));
    remotes.iter().find(|remote| remote.resolved.is_some() && same(remote))
        .or_else(|| ["upstream", "origin"].iter().find_map(|name| remotes.iter().find(|remote| remote.name == *name && same(remote))))
        .or_else(|| remotes.iter().find(same))
        .map(|remote| remote.name.clone())
}

fn checkout_config(root: &Path) -> Option<String> {
    read_bounded(&git_common_dir(root)?.join("config"))
}

/// One `[remote "<name>"]` of a Git config: its last `url`, `pushurl` and `gh-resolved` values.
#[derive(Debug, Default, PartialEq)]
struct Remote {
    name: String,
    url: Option<String>,
    push_url: Option<String>,
    resolved: Option<String>,
}

/// `gh`'s choice among `remotes`: a `gh-resolved` remote (`base` means its own URL's
/// repository, any other value names `owner/name` or `github.com/owner/name`), then
/// `upstream`, then `origin`; only GitHub repositories count.
fn base_of(remotes: &[Remote]) -> Option<String> {
    let url_repo = |remote: &Remote| remote.url.as_deref().and_then(repo_from_remote);
    let resolved = remotes.iter().find_map(|remote| {
        let value = remote.resolved.as_deref()?.trim();
        if value.is_empty() {
            return None;
        }
        if value == "base" {
            return url_repo(remote);
        }
        valid_repo(value.strip_prefix("github.com/").unwrap_or(value)).ok()
    });
    resolved.or_else(|| ["upstream", "origin"].iter().find_map(|name| remotes.iter().find(|remote| remote.name == *name).and_then(url_repo)))
}

/// The remotes of a Git config file's text, in order of first appearance, read as
/// [`origin_url`] reads `origin` (no includes; the last value of a key wins).
fn remotes(config: &str) -> Vec<Remote> {
    let mut remotes: Vec<Remote> = Vec::new();
    let mut current: Option<usize> = None;
    let mut lines = config.lines();
    while let Some(raw) = lines.next() {
        let mut line = raw.trim_start();
        if let Some(header) = line.strip_prefix('[') {
            let Some((header, rest)) = header.split_once(']') else { continue };
            current = section_remote(header.trim()).map(|name| match remotes.iter().position(|remote| remote.name == name) {
                Some(at) => at,
                None => {
                    remotes.push(Remote { name, ..Remote::default() });
                    remotes.len() - 1
                }
            });
            line = rest.trim_start();
            if line.is_empty() || line.starts_with(['#', ';']) {
                continue;
            }
        }
        let Some(at) = current else { continue };
        let Some((name, _)) = line.split_once('=') else { continue };
        let name = name.trim();
        if name.eq_ignore_ascii_case("url") {
            remotes[at].url = key_value(line, "url", &mut lines);
        } else if name.eq_ignore_ascii_case("pushurl") {
            remotes[at].push_url = key_value(line, "pushurl", &mut lines);
        } else if name.eq_ignore_ascii_case("gh-resolved") {
            remotes[at].resolved = key_value(line, "gh-resolved", &mut lines);
        }
    }
    remotes
}

/// The remote a section header names: `remote "<name>"` (exact subsection) or the old
/// lowercased `remote.<name>` form.
fn section_remote(header: &str) -> Option<String> {
    if let Some((name, sub)) = header.split_once(char::is_whitespace) {
        let sub = sub.trim();
        return (name.eq_ignore_ascii_case("remote") && sub.len() >= 2 && sub.starts_with('"') && sub.ends_with('"')).then(|| unescape_sub(&sub[1..sub.len() - 1]));
    }
    let (name, sub) = header.split_once('.')?;
    (name.eq_ignore_ascii_case("remote") && !sub.is_empty()).then(|| sub.to_ascii_lowercase())
}

/// Largest Git config or `.git` file [`project_repo`] reads.
const CONFIG_LIMIT: u64 = 256 * 1024;

/// A small text file, read without following a symlink at its last component; `None` when
/// missing, a symlink, not a file or over [`CONFIG_LIMIT`].
fn read_bounded(path: &Path) -> Option<String> {
    use std::io::Read;
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > CONFIG_LIMIT {
        return None;
    }
    let mut text = String::new();
    std::fs::File::open(path).ok()?.take(CONFIG_LIMIT).read_to_string(&mut text).ok()?;
    Some(text)
}

/// The Git directory holding the shared config for the checkout at (or above) `root`, as Git
/// finds it: a `.git` folder, or a `.git` file's `gitdir:` (a linked worktree's own folder,
/// whose `commondir` names the main one).
fn git_common_dir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.ancestors().map(|dir| dir.join(".git")).find(|dot_git| std::fs::symlink_metadata(dot_git).is_ok())?;
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let pointer = read_bounded(&dot_git)?;
    let target = pointer.lines().find_map(|line| line.strip_prefix("gitdir:")).map(str::trim).filter(|t| !t.is_empty())?;
    let git_dir = dot_git.parent()?.join(target);
    match read_bounded(&git_dir.join("commondir")) {
        Some(common) if !common.trim().is_empty() => Some(git_dir.join(common.trim())),
        _ => Some(git_dir),
    }
}

/// `remote.origin.url` from a Git config file's text, the last value winning as with
/// `git config --get`: section names and keys match case-insensitively, the subsection exactly
/// (`[remote "origin"]`), or lowercased in the old `[remote.origin]` form. Round 20: `[include]`
/// and `[includeIf]` files are never read, so the checkout's config cannot point the phone's
/// lookup at another file on this computer.
fn origin_url(config: &str) -> Option<String> {
    let mut url = None;
    let mut origin = false;
    let mut lines = config.lines();
    while let Some(raw) = lines.next() {
        let mut line = raw.trim_start();
        if let Some(header) = line.strip_prefix('[') {
            let Some((header, rest)) = header.split_once(']') else { continue };
            origin = section_is_origin(header.trim());
            line = rest.trim_start();
            if line.is_empty() || line.starts_with(['#', ';']) {
                continue;
            }
        }
        if !origin {
            continue;
        }
        if let Some(value) = key_value(line, "url", &mut lines) {
            url = Some(value);
        }
    }
    url
}

fn section_is_origin(header: &str) -> bool {
    if let Some((name, sub)) = header.split_once(char::is_whitespace) {
        let sub = sub.trim();
        return name.eq_ignore_ascii_case("remote") && sub.len() >= 2 && sub.starts_with('"') && sub.ends_with('"') && unescape_sub(&sub[1..sub.len() - 1]) == "origin";
    }
    header.eq_ignore_ascii_case("remote.origin")
}

fn unescape_sub(sub: &str) -> String {
    let mut out = String::new();
    let mut chars = sub.chars();
    while let Some(c) = chars.next() {
        out.push(if c == '\\' { chars.next().unwrap_or('\\') } else { c });
    }
    out
}

/// The value of a `<key> = ...` line (continuations joined), `None` for any other key.
fn key_value<'a>(line: &str, key: &str, rest: &mut impl Iterator<Item = &'a str>) -> Option<String> {
    let (name, value) = line.split_once('=')?;
    if !name.trim().eq_ignore_ascii_case(key) {
        return None;
    }
    let mut value = value.to_string();
    while value.ends_with('\\') && !value.ends_with("\\\\") {
        value.pop();
        value.push_str(rest.next().unwrap_or_default());
    }
    Some(config_value(&value))
}

/// A config value as Git reads it: quotes removed, `\\`, `\"`, `\n`, `\t` escapes, a comment
/// (`#`/`;` outside quotes) dropped, outer whitespace trimmed.
fn config_value(raw: &str) -> String {
    let (mut out, mut quoted, mut chars) = (String::new(), false, raw.trim().chars());
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '#' | ';' if !quoted => break,
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => {}
            },
            _ => out.push(c),
        }
    }
    out.trim().to_string()
}

/// Where a clone of `repo` lands inside `parent`, refusing anything that already exists.
pub fn clone_destination(parent: &Path, repo: &str) -> Result<PathBuf, String> {
    let repo = valid_repo(repo)?;
    if !parent.is_absolute() || !parent.is_dir() {
        return Err("Choose an existing folder to clone into.".into());
    }
    let name = repo.split_once('/').map(|(_, name)| name).unwrap_or(&repo);
    let destination = parent.join(name);
    if destination.exists() {
        return Err(format!("{} already exists. Open it as a project instead, or choose another folder.", destination.display()));
    }
    Ok(destination)
}

pub fn clone(repo: &str, parent: &Path) -> Result<PathBuf, String> {
    let destination = clone_destination(parent, repo)?;
    clone_to(repo, &destination, CLONE_TIMEOUT)?;
    Ok(destination)
}

/// Clones `repo` into `destination`, whose parent must exist and which must not.
pub fn clone_to(repo: &str, destination: &Path, timeout: Duration) -> Result<(), String> {
    let repo = valid_repo(repo)?;
    let parent = destination.parent().filter(|parent| parent.is_dir()).ok_or("Choose an existing folder to clone into.")?;
    let target = destination.to_string_lossy().to_string();
    run_gh(parent, &["repo", "clone", &repo, &target], timeout)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Live: lists the signed-in account's repositories. Run it with a Finder-like
    /// environment (`env -i HOME=$HOME PATH=/usr/bin:/bin <test binary> --ignored`) to
    /// check that `gh` is found without the shell's PATH.
    #[test]
    #[ignore]
    fn live_lists_repositories_from_a_minimal_path() {
        let list = repos().expect("gh lists repositories");
        assert!(!list.is_empty());
        assert!(list.iter().all(|repo| valid_repo(&repo.name_with_owner).is_ok()));
    }

    #[test]
    fn repositories_must_be_owner_and_name() {
        assert_eq!(valid_repo(" orbit-labs/orbit ").unwrap(), "orbit-labs/orbit");
        assert!(valid_repo("orbit").is_err());
        assert!(valid_repo("--repo=x/y").is_err());
        assert!(valid_repo("owner/../etc").is_err());
        assert!(valid_repo("owner/name/extra").is_err());
        assert!(valid_repo("owner/.hidden").is_err());
        assert!(valid_repo("own er/name").is_err());
    }

    #[test]
    fn remotes_name_their_repository() {
        for url in ["git@github.com:orbit-labs/orbit.git", "https://github.com/orbit-labs/orbit", "https://github.com/orbit-labs/orbit.git/", "ssh://git@github.com/orbit-labs/orbit.git"] {
            assert_eq!(repo_from_remote(url).as_deref(), Some("orbit-labs/orbit"), "{url}");
        }
        assert_eq!(repo_from_remote("https://gitlab.com/orbit-labs/orbit.git"), None);
        assert_eq!(repo_from_remote("git@github.com:orbit-labs"), None);
    }

    #[test]
    fn checks_fold_into_one_word() {
        assert_eq!(checks_summary(None), "none");
        assert_eq!(checks_summary(Some(&json!([]))), "none");
        assert_eq!(checks_summary(Some(&json!([{ "conclusion": "SUCCESS" }, { "state": "SUCCESS" }]))), "passing");
        assert_eq!(checks_summary(Some(&json!([{ "conclusion": "SUCCESS" }, { "status": "IN_PROGRESS", "conclusion": "" }]))), "pending");
        assert_eq!(checks_summary(Some(&json!([{ "conclusion": "FAILURE" }, { "state": "PENDING" }]))), "failing");
    }

    #[test]
    fn runs_fold_into_one_state() {
        assert_eq!(run_state("completed", "success"), "passed");
        assert_eq!(run_state("completed", "skipped"), "passed");
        assert_eq!(run_state("completed", "failure"), "failed");
        assert_eq!(run_state("completed", "startup_failure"), "not_started");
        assert_eq!(run_state("completed", "cancelled"), "cancelled");
        assert_eq!(run_state("in_progress", ""), "in_progress");
        assert_eq!(run_state("queued", ""), "queued");
        assert_eq!(run_state("waiting", ""), "queued");
    }

    #[test]
    fn runs_carry_their_pull_requests_attempts_and_timing() {
        let value = json!({ "total_count": 2, "workflow_runs": [
            { "id": 9087, "name": "CI", "display_title": "Fix contrast", "head_branch": "devon/contrast", "event": "pull_request", "status": "completed", "conclusion": "failure",
              "created_at": "2026-10-20T10:00:00Z", "run_started_at": "2026-10-20T10:01:00Z", "updated_at": "2026-10-20T10:05:30Z", "html_url": "https://github.com/o/r/actions/runs/9087",
              "run_attempt": 2, "pull_requests": [{ "number": 124, "head": { "ref": "devon/contrast" } }] },
            { "id": 9001, "name": ".github/workflows/bad.yml", "display_title": "push", "head_branch": "main", "event": "push", "status": "completed", "conclusion": "startup_failure", "pull_requests": [] }
        ]});
        let runs = runs_of(&value);
        assert_eq!(runs.len(), 2);
        assert_eq!((runs[0].attempt, runs[0].pulls.clone(), runs[0].state.as_str(), runs[0].started_at.as_str()), (2, vec![124], "failed", "2026-10-20T10:01:00Z"));
        assert_eq!((runs[1].attempt, runs[1].pulls.len(), runs[1].state.as_str()), (1, 0, "not_started"));
        assert!(runs_of(&json!({})).is_empty());
    }

    #[test]
    fn run_details_list_jobs_and_artifacts() {
        let jobs = json!({ "jobs": [{ "name": "test", "status": "completed", "conclusion": "success", "started_at": "a", "completed_at": "b", "html_url": "u" }, { "name": "lint", "status": "in_progress", "conclusion": null }] });
        let artifacts = json!({ "artifacts": [{ "name": "coverage", "size_in_bytes": 2048, "expired": false }, { "name": "old", "size_in_bytes": 1, "expired": true }] });
        let details = details_of(&jobs, &artifacts);
        assert_eq!(details.jobs.iter().map(|job| (job.name.as_str(), job.state.as_str())).collect::<Vec<_>>(), [("test", "passed"), ("lint", "in_progress")]);
        assert_eq!(details.artifacts[0], RunArtifact { name: "coverage".into(), size: 2048, expired: false });
        assert!(details.artifacts[1].expired);
        assert_eq!(details_of(&json!({}), &json!({})), RunDetails::default());
        assert!(details.jobs[1].steps.is_empty() && details.jobs[1].summary.is_empty());
        assert!(run_details("orbit-labs/orbit", 0).is_err());
        assert!(run_details("--x", 1).is_err());
    }

    #[test]
    fn jobs_carry_steps_summaries_and_earlier_attempts() {
        let jobs = json!({ "jobs": [
            { "id": 7, "run_attempt": 1, "name": "test", "status": "completed", "conclusion": "failure", "steps": [
                { "name": "Checkout", "status": "completed", "conclusion": "success", "started_at": "a", "completed_at": "b" },
                { "name": "Run tests", "status": "completed", "conclusion": "failure" },
                { "name": "Upload", "status": "completed", "conclusion": "skipped" } ] },
            { "id": 9, "run_attempt": 2, "name": "test", "status": "completed", "conclusion": "success" } ] });
        let checks = json!({ "check_runs": [
            { "id": 7, "output": { "summary": "**2 failed**", "text": "details" } },
            { "id": 9, "output": { "summary": null, "text": "" } },
            { "id": 11, "output": { "summary": "x".repeat(SUMMARY_LIMIT + 10) } } ] });
        let summaries = summaries_of(&checks);
        assert_eq!(summaries.get(&7).map(String::as_str), Some("**2 failed**\n\ndetails"));
        assert!(!summaries.contains_key(&9));
        assert!(summaries[&11].len() <= SUMMARY_LIMIT + 8 && summaries[&11].ends_with('…'));
        assert_eq!(bounded("héllo", 2), "h\n\n…");
        let run = json!({ "status": "completed", "conclusion": "failure", "run_started_at": "s", "updated_at": "u", "html_url": "https://github.com/o/r/actions/runs/5" });
        let attempt = attempt_of(&run, 1, &jobs, &summaries);
        assert_eq!((attempt.attempt, attempt.state.as_str(), attempt.url.as_str()), (1, "failed", "https://github.com/o/r/actions/runs/5/attempts/1"));
        assert_eq!(attempt.jobs.len(), 1);
        assert_eq!(attempt.jobs[0].steps.iter().map(|step| step.state.as_str()).collect::<Vec<_>>(), ["passed", "failed", "passed"]);
        assert_eq!(attempt.jobs[0].summary, "**2 failed**\n\ndetails");
    }

    #[test]
    fn clones_never_overwrite() {
        let parent = std::env::temp_dir().join(format!("pandacode-clone-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(parent.join("orbit")).unwrap();
        assert!(clone_destination(&parent, "orbit-labs/orbit").unwrap_err().contains("already exists"));
        assert_eq!(clone_destination(&parent, "orbit-labs/meadow").unwrap(), parent.join("meadow"));
        assert!(clone_destination(Path::new("relative"), "orbit-labs/meadow").is_err());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn origin_url_reads_git_config_syntax_like_git() {
        let config = "[core]\n\turl = https://github.com/no/core\n[remote \"upstream\"]\n\turl = https://github.com/no/upstream\n[Remote \"origin\"]\n\tURL = \"git@github.com:orbit-labs/meadow.git\" ; comment\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch \"main\"]\n\turl = https://github.com/no/branch\n";
        assert_eq!(origin_url(config).as_deref(), Some("git@github.com:orbit-labs/meadow.git"));
        assert_eq!(origin_url("[remote \"origin\"]\n url = https://github.com/a/one\n url = https://github.com/a/two\n").as_deref(), Some("https://github.com/a/two"));
        assert_eq!(origin_url("[remote.origin]\nurl=https://github.com/a/old # c\n").as_deref(), Some("https://github.com/a/old"));
        assert_eq!(origin_url("[remote \"Origin\"]\nurl = https://github.com/a/b\n"), None, "subsections are case-sensitive");
        assert_eq!(origin_url("[remote \"origin\"] url = https://github.com/a/inline\n").as_deref(), Some("https://github.com/a/inline"));
        assert_eq!(origin_url("[remote \"origin\"]\nurl = https://github.com/a/\\\nsplit\n").as_deref(), Some("https://github.com/a/split"));
        assert_eq!(origin_url("[remote \"origin\"]\nfetch = x\n"), None);
    }

    /// Round 22: the base repository follows `gh`: a `gh-resolved` remote, then `upstream`,
    /// then `origin`.
    #[test]
    fn push_repo_is_origin_then_the_first_remote_by_name() {
        let fork = "[remote \"upstream\"]\n\turl = https://github.com/up/stream.git\n[remote \"origin\"]\n\turl = git@github.com:me/fork.git\n";
        assert_eq!(push_of(&remotes(fork)).as_deref(), Some("me/fork"));
        let named = "[remote \"zed\"]\n\turl = https://github.com/z/z\n[remote \"alpha\"]\n\turl = https://github.com/a/a\n";
        assert_eq!(push_of(&remotes(named)).as_deref(), Some("a/a"), "git remote sorts names");
        assert_eq!(push_of(&remotes("[remote \"origin\"]\n\turl = https://gitlab.com/x/y\n")), None);
        assert_eq!(push_of(&remotes("")), None);
    }

    /// Round 24: the head owner comes from the last `pushurl` when the remote has one.
    #[test]
    fn push_repo_prefers_the_push_url() {
        let split = "[remote \"origin\"]\n\turl = https://github.com/up/stream.git\n\tpushurl = git@github.com:me/old.git\n\tPushURL = git@github.com:me/fork.git\n";
        assert_eq!(push_of(&remotes(split)).as_deref(), Some("me/fork"), "the last pushurl wins");
        assert_eq!(remotes(split)[0].url.as_deref(), Some("https://github.com/up/stream.git"), "url is kept apart");
        let plain = "[remote \"origin\"]\n\turl = git@github.com:me/fork.git\n";
        assert_eq!(push_of(&remotes(plain)).as_deref(), Some("me/fork"), "url without a pushurl");
        let elsewhere = "[remote \"origin\"]\n\turl = https://github.com/me/fork\n\tpushurl = https://gitlab.com/me/fork\n";
        assert_eq!(push_of(&remotes(elsewhere)), None, "a pushurl off GitHub names no head owner");
    }

    /// Round 24: the remote whose HEAD names a pull request's default base.
    #[test]
    fn base_remote_names_the_remote_base_repo_resolved() {
        let base = std::env::temp_dir().join(format!("pandacode-hub-remote-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(base.join(".git")).unwrap();
        let fork = "[remote \"origin\"]\n\turl = git@github.com:me/fork.git\n[remote \"upstream\"]\n\turl = https://github.com/up/stream.git\n";
        std::fs::write(base.join(".git/config"), fork).unwrap();
        assert_eq!(base_remote(&base).as_deref(), Some("upstream"));
        std::fs::write(base.join(".git/config"), format!("{fork}[remote \"origin\"]\n\tgh-resolved = base\n")).unwrap();
        assert_eq!(base_remote(&base).as_deref(), Some("origin"));
        std::fs::write(base.join(".git/config"), "[remote \"mine\"]\n\turl = https://github.com/me/fork\n\tgh-resolved = up/stream\n[remote \"theirs\"]\n\turl = https://github.com/Up/Stream\n").unwrap();
        assert_eq!(base_remote(&base).as_deref(), Some("theirs"), "a gh-resolved owner/name maps to its remote");
        std::fs::write(base.join(".git/config"), "[remote \"mine\"]\n\turl = https://github.com/me/fork\n\tgh-resolved = other/repo\n").unwrap();
        assert_eq!(base_remote(&base), None, "no remote names that repository");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn base_repo_follows_gh_resolved_then_upstream_then_origin() {
        let fork = "[remote \"origin\"]\n\turl = git@github.com:me/fork.git\n[remote \"upstream\"]\n\turl = https://github.com/up/stream.git\n";
        assert_eq!(base_of(&remotes(fork)).as_deref(), Some("up/stream"), "upstream before origin");
        assert_eq!(base_of(&remotes("[remote \"origin\"]\n\turl = git@github.com:me/fork.git\n")).as_deref(), Some("me/fork"));
        let resolved = format!("{fork}[remote \"origin\"]\n\tgh-resolved = base\n");
        assert_eq!(base_of(&remotes(&resolved)).as_deref(), Some("me/fork"), "gh repo set-default wins");
        let named = "[remote \"mine\"]\n\turl = https://github.com/me/fork\n\tgh-resolved = other/repo\n[remote \"upstream\"]\n\turl = https://github.com/up/stream\n";
        assert_eq!(base_of(&remotes(named)).as_deref(), Some("other/repo"), "a gh-resolved owner/name");
        let hosted = "[remote.mine]\n\turl = https://github.com/me/fork\n\tGH-Resolved = github.com/other/hosted\n";
        assert_eq!(base_of(&remotes(hosted)).as_deref(), Some("other/hosted"));
        let not_github = "[remote \"upstream\"]\n\turl = https://gitlab.com/up/stream\n\tgh-resolved = base\n[remote \"origin\"]\n\turl = https://github.com/me/fork\n";
        assert_eq!(base_of(&remotes(not_github)).as_deref(), Some("me/fork"), "only GitHub remotes count");
        assert_eq!(base_of(&remotes("[remote \"Upstream\"]\n\turl = https://github.com/up/stream\n")), None, "names match exactly");
        assert_eq!(base_of(&remotes("[core]\n\tgh-resolved = base\n\turl = https://github.com/no/core\n")), None);
        let base = std::env::temp_dir().join(format!("pandacode-hub-base-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(base.join(".git")).unwrap();
        std::fs::write(base.join(".git/config"), format!("{fork}[remote \"backup\"]\n\turl = https://github.com/me/backup\n[remote \"gitlab\"]\n\turl = https://gitlab.com/x/y\n")).unwrap();
        assert_eq!(base_repo(&base).as_deref(), Some("up/stream"));
        assert_eq!(project_repo(&base).as_deref(), Some("me/fork"), "project_repo still names origin");
        assert_eq!(github_remotes(&base), ["up/stream", "me/fork", "me/backup"]);
        std::fs::write(base.join(".git/config"), resolved).unwrap();
        assert_eq!(base_repo(&base).as_deref(), Some("me/fork"));
        assert_eq!(github_remotes(&base), ["me/fork", "up/stream"]);
        assert_eq!(base_repo(&base.join("missing")), base_repo(&base), "found from inside the checkout");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn project_repo_reads_checkouts_and_linked_worktrees_without_git() {
        let base = std::env::temp_dir().join(format!("pandacode-hub-repo-{}", uuid::Uuid::new_v4().simple()));
        let main = base.join("main");
        std::fs::create_dir_all(main.join(".git/worktrees/feature")).unwrap();
        std::fs::create_dir_all(main.join("packages/app")).unwrap();
        std::fs::write(main.join(".git/config"), "[remote \"origin\"]\n\turl = https://github.com/orbit-labs/meadow.git\n").unwrap();
        assert_eq!(project_repo(&main).as_deref(), Some("orbit-labs/meadow"));
        assert_eq!(project_repo(&main.join("packages/app")).as_deref(), Some("orbit-labs/meadow"), "a project inside the checkout");
        let linked = base.join("linked");
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::write(linked.join(".git"), format!("gitdir: {}\n", main.join(".git/worktrees/feature").display())).unwrap();
        std::fs::write(main.join(".git/worktrees/feature/commondir"), "../..\n").unwrap();
        assert_eq!(project_repo(&linked).as_deref(), Some("orbit-labs/meadow"));
        // Round 20: `[include]` / `[includeIf]` files are never read.
        let included = base.join("included");
        std::fs::create_dir_all(included.join(".git")).unwrap();
        std::fs::write(included.join("more.conf"), "[remote \"origin\"]\n\turl = git@github.com:orbit-labs/included.git\n").unwrap();
        std::fs::write(included.join(".git/config"), "[remote \"origin\"]\n\turl = https://github.com/orbit-labs/before\n[include]\n\tpath = ../more.conf\n[includeIf \"gitdir:/\"]\n\tpath = ../more.conf\n").unwrap();
        assert_eq!(project_repo(&included).as_deref(), Some("orbit-labs/before"), "includes are not followed");
        std::fs::write(included.join(".git/config"), "[include]\n\tpath = ../more.conf\n").unwrap();
        assert_eq!(project_repo(&included), None, "an origin only in an included file is not found");
        #[cfg(unix)]
        {
            let elsewhere = base.join("elsewhere-config");
            std::fs::write(&elsewhere, "[remote \"origin\"]\n\turl = https://github.com/someone/else\n").unwrap();
            std::fs::remove_file(main.join(".git/config")).unwrap();
            std::os::unix::fs::symlink(&elsewhere, main.join(".git/config")).unwrap();
            assert_eq!(project_repo(&main), None, "a symlinked config is not followed");
        }
        std::fs::remove_dir_all(base).unwrap();
    }

    /// Round 17: `project_repo` is called from PandaConnect (`remote/`) without a `Trust`, so
    /// it must never run Git (or anything): this module spawns only `gh`.
    #[test]
    fn project_repo_never_runs_a_program() {
        let source = include_str!("github_hub.rs");
        let code = &source[..source.find("#[cfg(test)]\nmod tests").unwrap()];
        for forbidden in ["Command::new", "run_process(", "workspace::run_git", "git_inspect("] {
            assert!(!code.contains(forbidden), "github_hub.rs calls {forbidden}");
        }
        for function in ["pub fn project_repo(", "pub fn base_repo(", "pub fn github_remotes(", "fn checkout_config("] {
            let body = &code[code.find(function).unwrap()..];
            let body = &body[..body.find("\n}\n").unwrap()];
            assert!(!body.contains("run_gh"), "{function} runs nothing");
        }
        assert!(!code.contains("include_path") && !code.contains("INCLUDE_DEPTH"), "Round 20: includes are not followed");
    }

}
