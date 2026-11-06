//! A task's pull request: the detail view in the inspector, its diff, the PR an
//! agent opened during a turn, and manual linking. Everything runs through the
//! signed-in `gh` from the task's checkout, like the rest of `github.rs`.
use serde::Serialize;
use std::{path::Path, time::Duration};

use crate::github::{excerpt, json, names, run_gh, state_of, text, view, Repository, TIMEOUT};
use crate::storage::TaskLink;

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

pub fn detail(root: &Path, number: i64) -> Result<PullDetail, String> {
    parse_detail(&view(root, "pull", number, DETAIL_FIELDS)?)
}

/// The PR's unified diff; a very large one is cut and flagged rather than refused.
pub fn diff(root: &Path, number: i64) -> Result<PullDiff, String> {
    let output = run_gh(root, &["pr", "diff", &number.to_string(), "--color=never"], Duration::from_secs(60))?;
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
    let mut candidates: Vec<i64> = Vec::new();
    for message in turn {
        for number in pull_numbers(message, &repo.name_with_owner).into_iter().rev() {
            if !candidates.contains(&number) {
                candidates.push(number);
            }
        }
    }
    for number in candidates.into_iter().take(MAX_CANDIDATES) {
        let Ok(value) = view(root, "pull", number, LINK_FIELDS) else { continue };
        if belongs_to_turn(&value, branch, turn_started) {
            return Ok(link_from(&value));
        }
    }
    Ok(None)
}

/// The turn's candidate PRs for one repository, newest first, each read in the
/// LINK_FIELDS shape; candidates gh cannot resolve are skipped.
pub(crate) fn turn_candidates(root: &Path, name_with_owner: &str, turn: &[String]) -> Vec<serde_json::Value> {
    let mut numbers: Vec<i64> = Vec::new();
    for message in turn {
        for number in pull_numbers(message, name_with_owner).into_iter().rev() {
            if !numbers.contains(&number) {
                numbers.push(number);
            }
        }
    }
    numbers
        .into_iter()
        .take(MAX_CANDIDATES)
        .filter_map(|number| view(root, "pull", number, LINK_FIELDS).ok())
        .collect()
}

/// One repository's detection input: its task_links repo key, the checkout's
/// branch, and the turn's candidate PRs in the LINK_FIELDS shape.
pub struct DetectRepo {
    pub repo: String,
    pub branch: String,
    pub pulls: Vec<serde_json::Value>,
}

/// Per-repository PR detection: each repository links its first candidate that
/// is on the checkout's branch or was created during the turn, under its own
/// repo key; an open link in `open_repo_keys` shields only that repository's key.
pub fn detect_links(repos: &[DetectRepo], turn_started: i64, open_repo_keys: &[&str]) -> Vec<(String, TaskLink)> {
    let mut links = Vec::new();
    for entry in repos {
        if open_repo_keys.contains(&entry.repo.as_str()) {
            continue;
        }
        for value in &entry.pulls {
            if !belongs_to_turn(value, &entry.branch, turn_started) {
                continue;
            }
            if let Some(link) = link_from(value) {
                links.push((entry.repo.clone(), link));
                break;
            }
        }
    }
    links
}

/// Look a pull request up so a manual link carries its real title and state.
pub fn lookup(root: &Path, number: i64) -> Result<TaskLink, String> {
    let value = run_gh(root, &["pr", "view", &number.to_string(), "--json", LINK_FIELDS], TIMEOUT)
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
    let flag = merge_flag(method)?;
    run_gh(root, &["pr", "merge", &number.to_string(), flag], Duration::from_secs(60))?;
    lookup(root, number)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    // `gh pr view --json number,title,state,url,isDraft,headRefName,createdAt` shapes.
    fn candidate(number: i64, head: &str, created: &str) -> serde_json::Value {
        serde_json::json!({
            "number": number,
            "title": format!("PR {number}"),
            "state": "OPEN",
            "url": format!("https://github.com/o/r/pull/{number}"),
            "isDraft": false,
            "headRefName": head,
            "createdAt": created,
        })
    }
    fn detected(links: Vec<(String, TaskLink)>) -> Vec<(String, i64)> {
        links.into_iter().map(|(repo, link)| (repo, link.number)).collect()
    }

    /// PR detection links every repository that owns one: the primary keeps the
    /// legacy '' key while an additional repository links under its own, and each
    /// link carries the PR's real shape.
    #[test]
    fn detection_links_every_repository_that_owns_a_pr() {
        let start = epoch_ms("2026-10-14T10:00:00Z").unwrap();
        let links = detect_links(
            &[
                DetectRepo {
                    repo: String::new(),
                    branch: "task/primary".into(),
                    pulls: vec![candidate(11, "task/primary", "2020-01-01T00:00:00Z")],
                },
                DetectRepo {
                    repo: "o/lib".into(),
                    branch: "task/lib".into(),
                    pulls: vec![candidate(7, "unrelated", "2026-10-14T10:05:00Z")],
                },
            ],
            start,
            &[],
        );
        assert_eq!(
            detected(links.clone()),
            vec![(String::new(), 11), ("o/lib".into(), 7)],
            "each repository links under its own key, the primary first"
        );
        assert_eq!(
            (
                links[0].1.kind.as_str(),
                links[0].1.url.as_str(),
                links[0].1.title.as_str(),
                links[0].1.state.as_str(),
                links[0].1.checked_at
            ),
            ("pull", "https://github.com/o/r/pull/11", "PR 11", "open", 0)
        );
    }

    /// An open link shields only its own repo key: an open primary link stops only
    /// the primary's replacement, never the additional repositories' (and the
    /// other way around).
    #[test]
    fn an_open_link_shields_only_its_own_repo_key() {
        let start = epoch_ms("2026-10-14T10:00:00Z").unwrap();
        let matching = |repo: &str, number: i64| DetectRepo {
            repo: repo.into(),
            branch: "task/x".into(),
            pulls: vec![candidate(number, "task/x", "2020-01-01T00:00:00Z")],
        };
        assert_eq!(
            detected(detect_links(&[matching("", 11), matching("o/lib", 7)], start, &[""])),
            vec![("o/lib".into(), 7)],
            "an open primary link stops only the primary's replacement"
        );
        assert_eq!(
            detected(detect_links(&[matching("", 11), matching("o/lib", 7)], start, &["o/lib"])),
            vec![(String::new(), 11)],
            "an open additional link stops only that repository's replacement"
        );
    }

    /// A PR belongs to the repository whose task branch it is on: the same PR
    /// mentioned for two repositories links only the one whose branch matches.
    #[test]
    fn a_pr_belongs_to_the_repository_whose_branch_it_is_on() {
        let start = epoch_ms("2026-10-14T10:00:00Z").unwrap();
        let pulls = vec![candidate(5, "task/lib", "2020-01-01T00:00:00Z")];
        assert_eq!(
            detected(detect_links(
                &[
                    DetectRepo { repo: String::new(), branch: "task/primary".into(), pulls: pulls.clone() },
                    DetectRepo { repo: "o/lib".into(), branch: "task/lib".into(), pulls },
                ],
                start,
                &[],
            )),
            vec![("o/lib".into(), 5)]
        );
    }

    /// Within one repository the first candidate that belongs to the turn wins.
    #[test]
    fn each_repository_links_its_first_matching_candidate() {
        let start = epoch_ms("2026-10-14T10:00:00Z").unwrap();
        assert_eq!(
            detected(detect_links(
                &[DetectRepo {
                    repo: "o/lib".into(),
                    branch: "task/lib".into(),
                    pulls: vec![
                        candidate(9, "someone-elses-branch", "2020-01-01T00:00:00Z"),
                        candidate(8, "task/lib", "2020-01-01T00:00:00Z"),
                    ],
                }],
                start,
                &[],
            )),
            vec![("o/lib".into(), 8)]
        );
    }

    /// A turn that owns no PR anywhere links nothing.
    #[test]
    fn turns_without_their_own_prs_link_nothing() {
        let start = epoch_ms("2026-10-14T10:00:00Z").unwrap();
        assert!(detect_links(
            &[DetectRepo {
                repo: "o/lib".into(),
                branch: "task/lib".into(),
                pulls: vec![candidate(9, "someone-elses-branch", "2026-10-13T10:00:00Z")],
            }],
            start,
            &[],
        )
        .is_empty());
    }
}
