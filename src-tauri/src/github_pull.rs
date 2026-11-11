//! A task's pull request: the detail view in the inspector, its diff, the PR an
//! agent opened during a turn, and manual linking. Everything runs through the
//! signed-in `gh` from the task's checkout, like the rest of `github.rs`.
//!
//! Each entry point has an `_as` variant taking the caller's [`Trust`]: the desktop keeps
//! `Trust::Desktop` through the plain names, and every PandaConnect path passes
//! `Trust::phone(full_access)` so the `git` that `gh` runs in the checkout gets the hardened
//! environment while "Full access for remote tasks" is off (docs/remote-access.md, Round-9 gates).
//! The `_as` variants also take the repository to pin (`owner/name`, passed as `--repo=…`):
//! phone paths must give one ([`pinned_repo`]), so in a fork checkout `gh` never picks
//! `upstream` or a `gh-resolved` remote (Round 21); the desktop passes `None`.
use serde::Serialize;
use std::{path::Path, time::Duration};

use crate::github::{excerpt, flag, json, names, run_gh_as, state_of, text, view_in_as, Repository, TIMEOUT};
use crate::storage::TaskLink;
use crate::workspace::Trust;

const DETAIL_FIELDS: &str = "number,title,body,state,isDraft,url,author,baseRefName,headRefName,additions,deletions,changedFiles,createdAt,updatedAt,mergedAt,mergeable,reviewDecision,labels,statusCheckRollup,files,commits,comments,reviews";
const LINK_FIELDS: &str = "number,title,state,url,isDraft,headRefName,createdAt";
const BODY_LIMIT: usize = 64 * 1024;
const COMMENT_LIMIT: usize = 16 * 1024;
const MAX_COMMENTS: usize = 60;
const MAX_COMMITS: usize = 100;
/// A PR created this long before the turn's prompt still counts as the turn's.
const TURN_SLACK_MS: i64 = 60_000;
const MAX_CANDIDATES: usize = 3;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    /// success, failure, pending, skipped, or neutral.
    pub state: String,
    pub url: String,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullFile {
    pub path: String,
    pub additions: i64,
    pub deletions: i64,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub oid: String,
    pub headline: String,
    pub author: String,
    pub date: String,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    /// `comment` or `review`.
    pub kind: String,
    pub author: String,
    pub body: String,
    /// A review's verdict (approved, changes_requested, commented); empty for comments.
    pub state: String,
    pub created_at: String,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullDetail {
    pub number: i64,
    pub title: String,
    pub body: String,
    pub body_truncated: bool,
    pub state: String,
    pub url: String,
    pub author: String,
    pub base: String,
    pub head: String,
    pub additions: i64,
    pub deletions: i64,
    pub changed_files: i64,
    pub created_at: String,
    pub updated_at: String,
    pub merged_at: String,
    pub mergeable: String,
    pub review_decision: String,
    pub labels: Vec<String>,
    pub checks: Vec<Check>,
    pub files: Vec<PullFile>,
    pub commits: Vec<Commit>,
    pub timeline: Vec<Comment>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullDiff {
    pub patch: String,
    pub truncated: bool,
}

fn number(value: &serde_json::Value, key: &str) -> i64 {
    value.get(key).and_then(|v| v.as_i64()).unwrap_or_default()
}
fn login(value: &serde_json::Value) -> String {
    value.get("author").map(|author| text(author, "login")).unwrap_or_default()
}
fn items(value: &serde_json::Value, key: &str) -> Vec<serde_json::Value> {
    value.get(key).and_then(|v| v.as_array()).cloned().unwrap_or_default()
}
fn lower(value: &serde_json::Value, key: &str) -> String {
    text(value, key).to_ascii_lowercase()
}

/// Check runs and commit statuses folded into one small vocabulary.
fn check(value: &serde_json::Value) -> Check {
    if text(value, "__typename") == "StatusContext" {
        let state = match lower(value, "state").as_str() {
            "success" => "success",
            "failure" | "error" => "failure",
            _ => "pending",
        };
        return Check { name: text(value, "context"), state: state.into(), url: text(value, "targetUrl") };
    }
    let state = if lower(value, "status") != "completed" {
        "pending"
    } else {
        match lower(value, "conclusion").as_str() {
            "success" => "success",
            "failure" | "timed_out" | "cancelled" | "action_required" | "startup_failure" => "failure",
            "skipped" => "skipped",
            _ => "neutral",
        }
    };
    let (workflow, job) = (text(value, "workflowName"), text(value, "name"));
    let name = if workflow.is_empty() || workflow == job { job } else { format!("{workflow} / {job}") };
    Check { name, state: state.into(), url: text(value, "detailsUrl") }
}

fn comment(kind: &str, value: &serde_json::Value, date_key: &str) -> Comment {
    let (body, truncated) = excerpt(&text(value, "body"), COMMENT_LIMIT);
    Comment {
        kind: kind.into(),
        author: login(value),
        body: if truncated { format!("{body}\n\n[Comment truncated]") } else { body },
        state: if kind == "review" { lower(value, "state") } else { String::new() },
        created_at: text(value, date_key),
    }
}

/// Parse `gh pr view --json DETAIL_FIELDS`.
pub fn parse_detail(value: &serde_json::Value) -> Result<PullDetail, String> {
    let number = value.get("number").and_then(|v| v.as_i64()).ok_or("GitHub returned an unexpected pull request.")?;
    let (body, body_truncated) = excerpt(&text(value, "body"), BODY_LIMIT);
    let mut timeline: Vec<Comment> = items(value, "comments").iter().map(|c| comment("comment", c, "createdAt")).collect();
    // A review with neither text nor a verdict is a line-comment container; its lines live on GitHub.
    timeline.extend(
        items(value, "reviews")
            .iter()
            .map(|r| comment("review", r, "submittedAt"))
            .filter(|r| !r.body.trim().is_empty() || r.state != "commented"),
    );
    timeline.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let skip = timeline.len().saturating_sub(MAX_COMMENTS);
    let commits = items(value, "commits");
    let skip_commits = commits.len().saturating_sub(MAX_COMMITS);
    Ok(PullDetail {
        number,
        title: text(value, "title"),
        body,
        body_truncated,
        state: state_of(value),
        url: text(value, "url"),
        author: login(value),
        base: text(value, "baseRefName"),
        head: text(value, "headRefName"),
        additions: self::number(value, "additions"),
        deletions: self::number(value, "deletions"),
        changed_files: self::number(value, "changedFiles"),
        created_at: text(value, "createdAt"),
        updated_at: text(value, "updatedAt"),
        merged_at: text(value, "mergedAt"),
        mergeable: lower(value, "mergeable"),
        review_decision: lower(value, "reviewDecision"),
        labels: names(value, "labels", "name"),
        checks: items(value, "statusCheckRollup").iter().map(check).collect(),
        files: items(value, "files")
            .iter()
            .map(|f| PullFile { path: text(f, "path"), additions: self::number(f, "additions"), deletions: self::number(f, "deletions") })
            .collect(),
        commits: commits
            .iter()
            .skip(skip_commits)
            .map(|c| Commit {
                oid: text(c, "oid").chars().take(7).collect(),
                headline: text(c, "messageHeadline"),
                author: c
                    .get("authors")
                    .and_then(|a| a.as_array())
                    .and_then(|a| a.first())
                    .map(|a| Some(text(a, "login")).filter(|l| !l.is_empty()).unwrap_or_else(|| text(a, "name")))
                    .unwrap_or_default(),
                date: text(c, "committedDate"),
            })
            .collect(),
        timeline: timeline.into_iter().skip(skip).collect(),
    })
}

/// Refused when a phone's pull request call has no GitHub repository to pin.
pub(crate) const NO_GITHUB_REMOTE: &str = "This project has no GitHub remote.";

/// The repository (`owner/name`) a phone's pull request call pins with `--repo=…`: the one in
/// the task's pull request link when it names one, else the checkout's base repository as `gh`
/// resolves it (Round 22, [`crate::github_hub::base_repo`]: the `gh-resolved` remote, then
/// `upstream`, then `origin`; it runs no Git). Refused without either.
pub(crate) fn pinned_repo(root: &Path, link_url: Option<&str>) -> Result<String, String> {
    link_url.and_then(repo_of_pull_url).or_else(|| crate::github_hub::base_repo(root)).ok_or_else(|| NO_GITHUB_REMOTE.to_owned())
}

/// `owner/name` of a `https://github.com/owner/name/pull/12` URL.
fn repo_of_pull_url(url: &str) -> Option<String> {
    let (repo, rest) = url.trim().split_once("/pull/")?;
    let number = rest.split(['/', '#', '?']).next()?;
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    crate::github_hub::repo_from_remote(repo)
}

/// The repository to pass: a phone (any [`Trust::Phone`]) must name one, so no phone path can
/// leave `gh` to pick a remote; the desktop's `None` keeps its old behaviour.
fn pin(repo: Option<&str>, trust: Trust) -> Result<Option<&str>, String> {
    let repo = repo.map(str::trim).filter(|repo| !repo.is_empty());
    if repo.is_none() && trust != Trust::Desktop {
        return Err(NO_GITHUB_REMOTE.into());
    }
    Ok(repo)
}

/// `gh pr <command> <number> [extra…] [--repo=<repo>]`.
fn pr_args(command: &str, number: i64, extra: &[&str], repo: Option<&str>) -> Vec<String> {
    let mut args = vec!["pr".to_owned(), command.to_owned(), number.to_string()];
    args.extend(extra.iter().map(|arg| (*arg).to_owned()));
    args.extend(repo.map(|repo| flag("repo", repo)));
    args
}

fn gh_pr(root: &Path, args: &[String], timeout: Duration, trust: Trust) -> Result<crate::workspace::Capture, String> {
    run_gh_as(root, &args.iter().map(String::as_str).collect::<Vec<_>>(), timeout, trust)
}

pub fn detail(root: &Path, number: i64) -> Result<PullDetail, String> {
    detail_as(root, None, number, Trust::Desktop)
}

/// [`detail`] with the caller's trust, in repository `repo` (required for a phone).
pub(crate) fn detail_as(root: &Path, repo: Option<&str>, number: i64, trust: Trust) -> Result<PullDetail, String> {
    parse_detail(&view_in_as(root, pin(repo, trust)?, "pull", number, DETAIL_FIELDS, trust)?)
}

/// The PR's unified diff; a very large one is cut and flagged rather than refused.
pub fn diff(root: &Path, number: i64) -> Result<PullDiff, String> {
    diff_as(root, None, number, Trust::Desktop)
}

/// [`diff`] with the caller's trust, in repository `repo` (required for a phone).
pub(crate) fn diff_as(root: &Path, repo: Option<&str>, number: i64, trust: Trust) -> Result<PullDiff, String> {
    let args = pr_args("diff", number, &["--color=never"], pin(repo, trust)?);
    let output = gh_pr(root, &args, Duration::from_secs(60), trust)?;
    Ok(PullDiff { patch: String::from_utf8_lossy(&output.bytes).into_owned(), truncated: output.truncated })
}

/// Pull request numbers in `text` that point at this repository, in order of appearance.
pub fn pull_numbers(text: &str, name_with_owner: &str) -> Vec<i64> {
    let haystack = text.to_ascii_lowercase();
    let needle = format!("github.com/{}/pull/", name_with_owner.to_ascii_lowercase());
    let mut found = Vec::new();
    for (start, _) in haystack.match_indices(&needle) {
        // `notgithub.com/...` is someone else's host.
        if haystack[..start].chars().next_back().is_some_and(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
            continue;
        }
        let digits: String = haystack[start + needle.len()..].chars().take_while(char::is_ascii_digit).take(9).collect();
        if let Ok(number) = digits.parse::<i64>() {
            if number > 0 && !found.contains(&number) {
                found.push(number);
            }
        }
    }
    found
}

/// `12`, `#12`, or a pull request URL in this repository.
pub fn parse_reference(reference: &str, name_with_owner: &str) -> Result<i64, String> {
    let reference = reference.trim();
    let invalid = || "Enter a pull request number or its GitHub URL.".to_string();
    if let Ok(number) = reference.trim_start_matches('#').parse::<i64>() {
        return if number > 0 { Ok(number) } else { Err(invalid()) };
    }
    if !reference.contains("/pull/") {
        return Err(invalid());
    }
    pull_numbers(reference, name_with_owner)
        .first()
        .copied()
        .ok_or_else(|| format!("That pull request is not in {name_with_owner}."))
}

fn link_from(value: &serde_json::Value) -> Option<TaskLink> {
    Some(TaskLink {
        kind: "pull".into(),
        number: value.get("number")?.as_i64()?,
        url: text(value, "url"),
        title: text(value, "title"),
        state: state_of(value),
        checked_at: 0,
    })
}

fn epoch_ms(timestamp: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(timestamp).ok().map(|time| time.timestamp_millis())
}

/// Whether a PR mentioned in a turn is the turn's own work rather than a reference.
fn belongs_to_turn(value: &serde_json::Value, branch: &str, turn_started: i64) -> bool {
    let same_branch = !branch.is_empty() && text(value, "headRefName") == branch;
    let created_during_turn = epoch_ms(&text(value, "createdAt")).is_some_and(|at| at >= turn_started - TURN_SLACK_MS);
    same_branch || created_during_turn
}

/// The PR a turn opened: mentioned in its output (newest first), and either on the
/// checkout's branch or created after the turn began.
pub fn detect(root: &Path, repo: &Repository, turn: &[String], branch: &str, turn_started: i64) -> Result<Option<TaskLink>, String> {
    detect_as(root, repo, None, turn, branch, turn_started, Trust::Desktop)
}

/// [`detect`] with the caller's trust; each candidate is viewed in repository `pinned`
/// (required for a phone).
pub(crate) fn detect_as(root: &Path, repo: &Repository, pinned: Option<&str>, turn: &[String], branch: &str, turn_started: i64, trust: Trust) -> Result<Option<TaskLink>, String> {
    let pinned = pin(pinned, trust)?;
    let mut candidates: Vec<i64> = Vec::new();
    for message in turn {
        for number in pull_numbers(message, &repo.name_with_owner).into_iter().rev() {
            if !candidates.contains(&number) {
                candidates.push(number);
            }
        }
    }
    for number in candidates.into_iter().take(MAX_CANDIDATES) {
        let Ok(value) = view_in_as(root, pinned, "pull", number, LINK_FIELDS, trust) else { continue };
        if belongs_to_turn(&value, branch, turn_started) {
            return Ok(link_from(&value));
        }
    }
    Ok(None)
}

/// Round 22: the phone's [`detect_as`] over every GitHub repository of the checkout (`repos`,
/// from [`crate::github_hub::github_remotes`]): a pull request link in any of them is a
/// candidate, newest mention first, and each lookup is pinned to the repository in its URL.
/// Refused with no repository (no phone path leaves `gh` to pick one).
pub(crate) fn detect_in_as(root: &Path, repos: &[String], turn: &[String], branch: &str, turn_started: i64, trust: Trust) -> Result<Option<TaskLink>, String> {
    if repos.iter().all(|repo| repo.trim().is_empty()) {
        return Err(NO_GITHUB_REMOTE.into());
    }
    let mut candidates: Vec<(&str, i64)> = Vec::new();
    for message in turn {
        for (repo, number) in pull_refs(message, repos).into_iter().rev() {
            if !candidates.contains(&(repo, number)) {
                candidates.push((repo, number));
            }
        }
    }
    for (repo, number) in candidates.into_iter().take(MAX_CANDIDATES) {
        let Ok(value) = view_in_as(root, pin(Some(repo), trust)?, "pull", number, LINK_FIELDS, trust) else { continue };
        if belongs_to_turn(&value, branch, turn_started) {
            return Ok(link_from(&value));
        }
    }
    Ok(None)
}

/// Pull request links to any of `repos` in `text`, in order of appearance.
fn pull_refs<'a>(text: &str, repos: &'a [String]) -> Vec<(&'a str, i64)> {
    let haystack = text.to_ascii_lowercase();
    let mut found: Vec<(usize, &'a str, i64)> = Vec::new();
    for repo in repos.iter().map(|repo| repo.trim()).filter(|repo| !repo.is_empty()) {
        let needle = format!("github.com/{}/pull/", repo.to_ascii_lowercase());
        for (start, _) in haystack.match_indices(&needle) {
            if haystack[..start].chars().next_back().is_some_and(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
                continue;
            }
            let digits: String = haystack[start + needle.len()..].chars().take_while(char::is_ascii_digit).take(9).collect();
            if let Ok(number) = digits.parse::<i64>() {
                if number > 0 {
                    found.push((start, repo, number));
                }
            }
        }
    }
    found.sort_by_key(|(start, ..)| *start);
    found.into_iter().map(|(_, repo, number)| (repo, number)).collect()
}

/// Look a pull request up so a manual link carries its real title and state.
pub fn lookup(root: &Path, number: i64) -> Result<TaskLink, String> {
    lookup_as(root, None, number, Trust::Desktop)
}

/// [`lookup`] with the caller's trust, in repository `repo` (required for a phone).
pub(crate) fn lookup_as(root: &Path, repo: Option<&str>, number: i64, trust: Trust) -> Result<TaskLink, String> {
    let args = pr_args("view", number, &["--json", LINK_FIELDS], pin(repo, trust)?);
    let value = gh_pr(root, &args, TIMEOUT, trust)
        .map_err(|error| if error.to_ascii_lowercase().contains("could not resolve") { format!("Pull request #{number} was not found.") } else { error })?;
    link_from(&json(&value)?).ok_or_else(|| "GitHub returned an unexpected pull request.".into())
}

/// The `gh pr merge` flag for a merge method the user picked; anything else is refused.
pub fn merge_flag(method: &str) -> Result<&'static str, String> {
    match method {
        "squash" => Ok("--squash"),
        "merge" => Ok("--merge"),
        "rebase" => Ok("--rebase"),
        _ => Err("Choose squash, merge or rebase.".into()),
    }
}

/// Merge the pull request on GitHub, then read it back so the task's link shows it merged.
/// Local branches and worktrees are left alone; GitHub's branch settings decide the rest.
pub fn merge(root: &Path, number: i64, method: &str) -> Result<TaskLink, String> {
    merge_as(root, None, number, method, Trust::Desktop)
}

/// [`merge`] with the caller's trust. `gh pr merge` may run `git` in the checkout (it updates
/// the local branch when it can), so a phone with the switch off is refused first when the
/// checkout's config names a program or it has submodules, as for the phone's own merges.
/// `repo` (required for a phone) pins the repository for the merge and the read-back.
pub(crate) fn merge_as(root: &Path, repo: Option<&str>, number: i64, method: &str, trust: Trust) -> Result<TaskLink, String> {
    let method_flag = merge_flag(method)?;
    let repo = pin(repo, trust)?;
    crate::workspace::refuse_untrusted_programs(root, trust)?;
    gh_pr(root, &pr_args("merge", number, &[method_flag], repo), Duration::from_secs(60), trust)?;
    lookup_as(root, repo, number, trust)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A call's arguments: `rest` (after the opening parenthesis) up to its matching `)`.
    fn call_args(rest: &str) -> &str {
        let mut depth = 0usize;
        for (at, c) in rest.char_indices() {
            match c {
                '(' => depth += 1,
                ')' if depth == 0 => return &rest[..at],
                ')' => depth -= 1,
                _ => {}
            }
        }
        rest
    }

    /// Round 9: every PandaConnect path reaches a pull request with the phone's trust. The
    /// plain names keep `Trust::Desktop`, so `remote/` must call only the `_as` variants, and
    /// each of those calls must pass a trust.
    #[test]
    fn remote_code_reaches_pull_requests_only_with_a_trust() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = vec![src.join("remote/host.rs"), src.join("remote/start.rs")];
        for entry in std::fs::read_dir(src.join("remote/methods")).unwrap() {
            files.push(entry.unwrap().path());
        }
        let mut checked = 0;
        for file in files {
            let text = std::fs::read_to_string(&file).unwrap();
            let code = text.find("\n#[cfg(test)]\nmod tests {").map_or(text.as_str(), |end| &text[..end]);
            let name = file.display().to_string();
            for plain in ["detail", "diff", "detect", "lookup", "merge"] {
                assert!(!code.contains(&format!("github_pull::{plain}(")), "{name} calls github_pull::{plain} with the desktop's trust");
            }
            for variant in ["detail_as(", "diff_as(", "detect_as(", "lookup_as(", "merge_as(", "detect_in_as("] {
                let needle = format!("github_pull::{variant}");
                for (at, _) in code.match_indices(&needle) {
                    let args = call_args(&code[at + needle.len()..]);
                    assert!(args.to_ascii_lowercase().contains("trust"), "{name}: github_pull::{variant}{args}) passes no Trust");
                    assert!(!args.contains("Trust::Desktop"), "{name}: github_pull::{variant}{args}) passes the desktop's trust");
                    checked += 1;
                }
            }
        }
        assert!(checked >= 4, "the scan found the phone's pull request calls ({checked})");
    }

    #[test]
    fn a_merge_with_the_switch_off_refuses_a_checkout_that_names_a_program() {
        let dir = std::env::temp_dir().join(format!("pandacode-pull-merge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(&dir).status().unwrap().success());
        std::fs::write(dir.join(".gitmodules"), "[submodule \"x\"]\n\tpath = x\n\turl = https://example.com/x\n").unwrap();
        // Refused before `gh` runs at all, so this needs no network or sign-in.
        let refused = merge_as(&dir, Some("o/r"), 1, "squash", Trust::phone(false)).unwrap_err();
        assert!(refused.contains("submodules"), "{refused}");
        assert!(merge_as(&dir, Some("o/r"), 1, "bogus", Trust::phone(false)).unwrap_err().contains("squash"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Round 21: the phone's `task.pull`, `task.pullDiff`, `task.pullMerge` and
    /// `task.pullDetect` pin the repository: from the task's link, else the project's origin;
    /// without either they are refused before `gh` runs. The desktop's plain names are unchanged.
    #[test]
    fn phone_pull_requests_pin_the_repository() {
        assert_eq!(pr_args("diff", 4, &["--color=never"], Some("o/r")), ["pr", "diff", "4", "--color=never", "--repo=o/r"]);
        assert_eq!(pr_args("view", 4, &["--json", "url"], Some("o/r")), ["pr", "view", "4", "--json", "url", "--repo=o/r"]);
        assert_eq!(pr_args("merge", 4, &["--squash"], Some("o/r")), ["pr", "merge", "4", "--squash", "--repo=o/r"]);
        assert!(!pr_args("merge", 4, &["--squash"], None).iter().any(|arg| arg.starts_with("--repo")), "desktop calls are unchanged");
        assert_eq!(pin(None, Trust::Desktop), Ok(None));
        for trust in [Trust::phone(false), Trust::phone(true)] {
            assert_eq!(pin(None, trust).unwrap_err(), NO_GITHUB_REMOTE);
            assert_eq!(pin(Some("  "), trust).unwrap_err(), NO_GITHUB_REMOTE);
            assert_eq!(pin(Some("o/r"), trust), Ok(Some("o/r")));
        }
        // Refused before any `gh` (no network or sign-in needed).
        let dir = std::env::temp_dir().join(format!("pandacode-pull-pin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(diff_as(&dir, None, 1, Trust::phone(true)).unwrap_err(), NO_GITHUB_REMOTE);
        assert_eq!(detail_as(&dir, None, 1, Trust::phone(true)).unwrap_err(), NO_GITHUB_REMOTE);
        assert_eq!(lookup_as(&dir, None, 1, Trust::phone(true)).unwrap_err(), NO_GITHUB_REMOTE);
        assert_eq!(merge_as(&dir, None, 1, "squash", Trust::phone(true)).unwrap_err(), NO_GITHUB_REMOTE);
        let repo = Repository { name_with_owner: "o/r".into(), default_branch: String::new(), url: String::new() };
        assert_eq!(detect_as(&dir, &repo, None, &[], "", 0, Trust::phone(true)).unwrap_err(), NO_GITHUB_REMOTE);
        // The link's repository wins; then the project's origin; else refused.
        assert_eq!(pinned_repo(&dir, Some("https://github.com/up/stream/pull/12")), Ok("up/stream".into()));
        assert_eq!(pinned_repo(&dir, Some("https://example.com/x")).unwrap_err(), NO_GITHUB_REMOTE);
        assert_eq!(pinned_repo(&dir, None).unwrap_err(), NO_GITHUB_REMOTE);
        assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(&dir).status().unwrap().success());
        assert!(std::process::Command::new("git").args(["remote", "add", "origin", "git@github.com:me/fork.git"]).current_dir(&dir).status().unwrap().success());
        assert_eq!(pinned_repo(&dir, None), Ok("me/fork".into()));
        assert_eq!(pinned_repo(&dir, Some("https://github.com/me/fork/pull/x")), Ok("me/fork".into()), "a malformed link falls back to origin");
        assert_eq!(pinned_repo(&dir, Some("https://github.com/up/stream/pull/3#top")), Ok("up/stream".into()));
        // Round 22: a fork checkout pins what the desktop's `gh` resolves: `upstream`, unless a
        // `gh-resolved` remote says otherwise; the link's repository still wins.
        assert!(std::process::Command::new("git").args(["remote", "add", "upstream", "https://github.com/up/stream.git"]).current_dir(&dir).status().unwrap().success());
        assert_eq!(pinned_repo(&dir, None), Ok("up/stream".into()));
        assert_eq!(pinned_repo(&dir, Some("https://github.com/me/fork/pull/9")), Ok("me/fork".into()));
        assert!(std::process::Command::new("git").args(["config", "remote.origin.gh-resolved", "base"]).current_dir(&dir).status().unwrap().success());
        assert_eq!(pinned_repo(&dir, None), Ok("me/fork".into()));
        assert_eq!(detect_in_as(&dir, &[], &[], "", 0, Trust::phone(true)).unwrap_err(), NO_GITHUB_REMOTE);
        let repos = ["up/stream".to_owned(), "me/fork".to_owned()];
        let text = "Opened https://github.com/me/fork/pull/7, then https://github.com/Up/Stream/pull/12 and notgithub.com/up/stream/pull/5 or https://github.com/other/x/pull/3";
        assert_eq!(pull_refs(text, &repos), [("me/fork", 7), ("up/stream", 12)], "any remote's links, in order");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Round 21 source scan: every phone pull request call in `remote/` passes a pinned repo.
    #[test]
    fn remote_pull_request_calls_pass_a_pinned_repo() {
        let host = include_str!("remote/host.rs");
        let code = host.find("\n#[cfg(test)]\nmod tests {").map_or(host, |end| &host[..end]);
        let mut checked = 0;
        for variant in ["detail_as(", "diff_as(", "detect_as(", "lookup_as(", "merge_as("] {
            let needle = format!("github_pull::{variant}");
            for (at, _) in code.match_indices(&needle) {
                let args = call_args(&code[at + needle.len()..]);
                assert!(args.contains("Some(&repo)") || args.contains("Some(&pinned)"), "github_pull::{variant}{args}) pins no repository");
                checked += 1;
            }
        }
        assert!(checked >= 3, "{checked}");
        // Round 22: `task.pullDetect` looks in every GitHub remote, each lookup pinned to its URL's repo.
        let detect = &code[code.find("github_pull::detect_in_as(").expect("task.pullDetect")..];
        assert!(call_args(&detect["github_pull::detect_in_as(".len()..]).contains("&repos"));
        assert!(code.contains("github_hub::github_remotes(&root)"));
        assert!(code.matches("github_pull::pinned_repo(").count() >= 3, "the repo comes from the link or origin");
    }

    #[test]
    fn merge_accepts_only_known_methods() {
        assert_eq!(merge_flag("squash"), Ok("--squash"));
        assert_eq!(merge_flag("merge"), Ok("--merge"));
        assert_eq!(merge_flag("rebase"), Ok("--rebase"));
        assert!(merge_flag("--admin").is_err());
    }

    // Shaped like `gh pr view --json DETAIL_FIELDS` output.
    const RECORDED: &str = r#"{"number":42,"title":"Debounce search","body":"Reuses **one** index.","state":"OPEN","isDraft":false,"url":"https://github.com/o/r/pull/42","author":{"login":"octocat"},"baseRefName":"main","headRefName":"feat/debounce","additions":30,"deletions":4,"changedFiles":2,"createdAt":"2026-10-14T10:00:00Z","updatedAt":"2026-10-14T11:00:00Z","mergedAt":null,"mergeable":"MERGEABLE","reviewDecision":"APPROVED","labels":[{"name":"perf"}],
      "statusCheckRollup":[{"__typename":"CheckRun","name":"test","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","detailsUrl":"https://x/1"},{"__typename":"CheckRun","name":"lint","workflowName":"lint","status":"IN_PROGRESS","conclusion":"","detailsUrl":""},{"__typename":"StatusContext","context":"vercel","state":"FAILURE","targetUrl":"https://v"}],
      "files":[{"path":"src/a.ts","additions":20,"deletions":4},{"path":"src/b.ts","additions":10,"deletions":0}],
      "commits":[{"oid":"abcdef1234567","messageHeadline":"Debounce","authors":[{"login":"octocat","name":"Octo"}],"committedDate":"2026-10-14T09:59:00Z"}],
      "comments":[{"author":{"login":"mara"},"body":"Looks good","createdAt":"2026-10-14T10:30:00Z"}],
      "reviews":[{"author":{"login":"devon"},"body":"","state":"APPROVED","submittedAt":"2026-10-14T10:45:00Z"},{"author":{"login":"devon"},"body":"","state":"COMMENTED","submittedAt":"2026-10-14T10:20:00Z"}]}"#;

    #[test]
    fn details_parse_recorded_gh_json() {
        let detail = parse_detail(&serde_json::from_str(RECORDED).unwrap()).unwrap();
        assert_eq!((detail.number, detail.state.as_str(), detail.head.as_str(), detail.base.as_str()), (42, "open", "feat/debounce", "main"));
        assert_eq!((detail.additions, detail.deletions, detail.changed_files), (30, 4, 2));
        assert_eq!(detail.review_decision, "approved");
        assert_eq!(detail.labels, vec!["perf"]);
        assert_eq!(detail.checks.iter().map(|c| (c.name.as_str(), c.state.as_str())).collect::<Vec<_>>(), vec![("CI / test", "success"), ("lint", "pending"), ("vercel", "failure")]);
        assert_eq!(detail.commits[0].oid, "abcdef1");
        assert_eq!(detail.commits[0].author, "octocat");
        // The empty COMMENTED review is dropped; the rest sort by time.
        assert_eq!(detail.timeline.iter().map(|c| (c.kind.as_str(), c.author.as_str(), c.state.as_str())).collect::<Vec<_>>(), vec![("comment", "mara", ""), ("review", "devon", "approved")]);
        assert!(parse_detail(&serde_json::json!({"title":"no number"})).is_err());
    }

    #[test]
    fn pull_urls_match_only_this_repository() {
        let text = "Opened https://github.com/O/R/pull/12 (see also github.com/o/r/pull/7, https://github.com/o/other/pull/9, https://notgithub.com/o/r/pull/3, and https://github.com/o/r/pull/12 again)";
        assert_eq!(pull_numbers(text, "o/r"), vec![12, 7]);
        assert!(pull_numbers("https://github.com/o/r/pull/", "o/r").is_empty());
        assert!(pull_numbers("https://github.com/o/r/pulls", "o/r").is_empty());
    }

    #[test]
    fn references_accept_numbers_and_urls_of_this_repository() {
        assert_eq!(parse_reference(" #12 ", "o/r"), Ok(12));
        assert_eq!(parse_reference("12", "o/r"), Ok(12));
        assert_eq!(parse_reference("https://github.com/o/r/pull/34/files", "o/r"), Ok(34));
        assert!(parse_reference("https://github.com/o/x/pull/34", "o/r").unwrap_err().contains("not in o/r"));
        assert!(parse_reference("0", "o/r").is_err());
        assert!(parse_reference("feature branch", "o/r").is_err());
    }

    #[test]
    fn a_turn_owns_prs_on_its_branch_or_created_after_it_began() {
        let pr = |head: &str, created: &str| serde_json::json!({"headRefName": head, "createdAt": created});
        let start = epoch_ms("2026-10-14T10:00:00Z").unwrap();
        assert!(belongs_to_turn(&pr("feat/x", "2020-01-01T00:00:00Z"), "feat/x", start));
        assert!(belongs_to_turn(&pr("other", "2026-10-14T10:05:00Z"), "feat/x", start));
        assert!(belongs_to_turn(&pr("other", "2026-10-14T09:59:30Z"), "feat/x", start));
        assert!(!belongs_to_turn(&pr("other", "2026-10-13T10:00:00Z"), "feat/x", start));
        assert!(!belongs_to_turn(&pr("", "not a date"), "", start));
    }
}
