//! GitHub through the user's own `gh` CLI. PandaCode stores no tokens: every call
//! runs the signed-in CLI with a null stdin, bounded output, and a deadline, and
//! only ever from a project's checkout so the repository is the remote's.
use serde::{Deserialize, Serialize};
use std::{path::Path, process::Command, time::Duration};

use crate::workspace::{checked, run_process, tool_git_env, Capture, Trust};

pub(crate) const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
const BODY_LIMIT: usize = 4 * 1024;
const IMPORT_BODY_LIMIT: usize = 16 * 1024;
pub const MAX_REFERENCES: usize = 5;
pub(crate) const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub name_with_owner: String,
    pub default_branch: String,
    pub url: String,
}
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub installed: bool,
    pub version: String,
    pub authenticated: bool,
    pub login: Option<String>,
    pub repo: Option<Repository>,
    pub error: Option<String>,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub kind: String,
    pub number: i64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub author: String,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: i64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub url: String,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub updated_at: String,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub kind: String,
    pub number: i64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub author: String,
    pub body: String,
    pub labels: Vec<String>,
    pub truncated: bool,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkState {
    pub kind: String,
    pub number: i64,
    pub state: String,
    pub title: String,
    pub url: String,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: i64,
    pub url: String,
    pub title: String,
    pub state: String,
}
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IssueFilter {
    #[serde(default)]
    pub assigned_to_me: bool,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
}

/// `gh` as the user's shell finds it. Apps opened from Finder or the Dock inherit a
/// minimal PATH without Homebrew, so look where coding CLIs are found too, and pass that
/// PATH on for the `git` that `gh` runs.
fn gh_base(root: &Path) -> Command {
    let program = crate::providers::tool_path("gh").unwrap_or_else(|| "gh".into());
    let mut command = Command::new(program);
    command.current_dir(root);
    if let Ok(path) = crate::providers::executable_path() {
        command.env("PATH", path);
    }
    command
}
fn gh_command(root: &Path, args: &[&str]) -> Command {
    let mut command = gh_base(root);
    command
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_PAGER", "cat")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0");
    command
}
pub(crate) fn run_gh(root: &Path, args: &[&str], timeout: Duration) -> Result<Capture, String> {
    run_gh_as(root, args, timeout, Trust::Desktop)
}
/// `gh` with the call's `trust`: for an untrusted phone the `git` that `gh` runs in the
/// checkout gets the closed gate's overrides ([`tool_git_env`]); Desktop adds nothing.
fn gh_trusted_command(root: &Path, args: &[&str], trust: Trust) -> Command {
    let mut command = gh_command(root, args);
    command.envs(tool_git_env(trust));
    command
}
pub(crate) fn run_gh_as(root: &Path, args: &[&str], timeout: Duration, trust: Trust) -> Result<Capture, String> {
    checked(run_process(gh_trusted_command(root, args, trust), "GitHub CLI", OUTPUT_LIMIT, timeout)?)
}
pub(crate) fn json(capture: &Capture) -> Result<serde_json::Value, String> {
    if capture.truncated {
        return Err("The GitHub response was too large to read.".into());
    }
    serde_json::from_slice(&capture.bytes).map_err(|_| "GitHub returned an unexpected response.".into())
}
pub(crate) fn text(value: &serde_json::Value, key: &str) -> String {
    value.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string()
}
pub(crate) fn names(value: &serde_json::Value, key: &str, field: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|v| v.as_array())
        .map(|items| items.iter().filter_map(|item| item.get(field)?.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}
pub(crate) fn state_of(value: &serde_json::Value) -> String {
    let state = text(value, "state").to_ascii_lowercase();
    if state == "open" && value.get("isDraft").and_then(|v| v.as_bool()) == Some(true) {
        "draft".into()
    } else {
        state
    }
}
/// Cut at a character boundary and say so, so an excerpt never pretends to be whole.
pub(crate) fn excerpt(body: &str, limit: usize) -> (String, bool) {
    if body.len() <= limit {
        return (body.to_string(), false);
    }
    let mut end = limit;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    (body[..end].to_string(), true)
}
fn valid_query(query: &str) -> Result<String, String> {
    let query = query.trim();
    if query.len() > 200 || query.contains('\0') {
        return Err("Shorten the GitHub search.".into());
    }
    Ok(query.to_string())
}
pub(crate) fn flag(name: &str, value: &str) -> String {
    // The `--flag=value` form keeps user text out of the CLI's option parser.
    format!("--{name}={value}")
}
/// A spawn failure means the CLI is absent; anything else is reported as is.
fn start_failure(error: &str) -> String {
    if error.starts_with("Could not start") {
        "GitHub CLI (gh) is not installed.".into()
    } else {
        error.to_string()
    }
}

/// Whether `gh` exists, who is signed in, and which repository this checkout uses.
pub fn status(root: &Path) -> GithubStatus {
    let mut status = GithubStatus::default();
    let version = match run_gh(root, &["--version"], Duration::from_secs(10)) {
        Ok(output) => output,
        Err(error) => {
            status.error = Some(start_failure(&error));
            return status;
        }
    };
    status.installed = true;
    status.version = String::from_utf8_lossy(&version.bytes)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .trim_start_matches("gh version ")
        .split(' ')
        .next()
        .unwrap_or_default()
        .to_string();
    let mut command = gh_base(root);
    command
        .args(["auth", "status"])
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1");
    match run_process(command, "GitHub CLI", 64 * 1024, Duration::from_secs(20)) {
        Ok(output) => {
            let report = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout.bytes),
                String::from_utf8_lossy(&output.stderr.bytes)
            );
            status.authenticated = output.status.success();
            status.login = report.lines().find_map(|line| {
                let (_, rest) = line.split_once(" account ")?;
                rest.split_whitespace().next().map(str::to_string)
            });
            if !status.authenticated {
                status.error = Some("Sign in with `gh auth login` to connect GitHub.".into());
                return status;
            }
        }
        Err(error) => {
            status.error = Some(error);
            return status;
        }
    }
    match repository(root) {
        Ok(repo) => status.repo = Some(repo),
        Err(error) if error.is_empty() => {}
        Err(error) => status.error = Some(error),
    }
    status
}

/// The GitHub repository behind this checkout's remote; `Err("")` means none.
pub fn repository(root: &Path) -> Result<Repository, String> {
    repository_as(root, Trust::Desktop)
}
/// [`repository`] with the caller's trust (see [`run_gh_as`]).
pub(crate) fn repository_as(root: &Path, trust: Trust) -> Result<Repository, String> {
    let output = run_gh_as(
        root,
        &["repo", "view", "--json", "nameWithOwner,defaultBranchRef,url"],
        TIMEOUT,
        trust,
    )
    .map_err(|error| {
        let lower = error.to_ascii_lowercase();
        if ["no git remote", "not a git repository", "could not determine", "none of the git remotes", "unable to determine base repository"]
            .iter()
            .any(|marker| lower.contains(marker))
        {
            String::new()
        } else {
            error
        }
    })?;
    let value = json(&output)?;
    let name_with_owner = text(&value, "nameWithOwner");
    if name_with_owner.is_empty() {
        return Err(String::new());
    }
    Ok(Repository {
        name_with_owner,
        default_branch: value
            .get("defaultBranchRef")
            .map(|v| text(v, "name"))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "main".into()),
        url: text(&value, "url"),
    })
}

fn item(kind: &str, value: &serde_json::Value) -> Option<Item> {
    Some(Item {
        kind: kind.into(),
        number: value.get("number")?.as_i64()?,
        title: text(value, "title"),
        state: state_of(value),
        url: text(value, "url"),
        author: value.get("author").map(|a| text(a, "login")).unwrap_or_default(),
    })
}
pub(crate) fn view(root: &Path, kind: &str, number: i64, fields: &str) -> Result<serde_json::Value, String> {
    view_as(root, kind, number, fields, Trust::Desktop)
}
/// [`view`] with the caller's trust (see [`run_gh_as`]).
pub(crate) fn view_as(root: &Path, kind: &str, number: i64, fields: &str, trust: Trust) -> Result<serde_json::Value, String> {
    view_in_as(root, None, kind, number, fields, trust)
}
/// `gh issue|pr view`'s arguments; with `repo` (`owner/name`) pinned by `--repo=…`, so `gh`
/// never picks `upstream` or a `gh-resolved` remote of a fork checkout (Round 18).
fn view_args(repo: Option<&str>, kind: &str, number: i64, fields: &str) -> Vec<String> {
    let command = if kind == "pull" { "pr" } else { "issue" };
    let mut args = vec![command.to_owned(), "view".to_owned(), number.to_string(), "--json".to_owned(), fields.to_owned()];
    args.extend(repo.map(|repo| flag("repo", repo)));
    args
}
/// [`view_as`] in repository `repo` (`owner/name`, the project's `origin`) when given: the
/// phone's `github.item` and `github.startTask` pass it.
pub(crate) fn view_in_as(root: &Path, repo: Option<&str>, kind: &str, number: i64, fields: &str, trust: Trust) -> Result<serde_json::Value, String> {
    let args = view_args(repo, kind, number, fields);
    let value = json(&run_gh_as(root, &args.iter().map(String::as_str).collect::<Vec<_>>(), TIMEOUT, trust)?)?;
    // The REST-style issue lookup can answer for a pull request; keep the kinds honest.
    if kind == "issue" && text(&value, "url").contains("/pull/") {
        return Err("This number is a pull request.".into());
    }
    Ok(value)
}

/// Open issues and pull requests matching the picker's query.
pub fn search(root: &Path, query: &str, limit: usize) -> Result<Vec<Item>, String> {
    search_as(root, query, limit, Trust::Desktop)
}
/// [`search`] with the caller's trust: the phone's `github.search` passes
/// `Trust::phone(full_access)` so `gh`'s `git` runs with the hardened environment.
pub(crate) fn search_as(root: &Path, query: &str, limit: usize, trust: Trust) -> Result<Vec<Item>, String> {
    let query = valid_query(query)?;
    let limit = limit.clamp(1, 20).to_string();
    let mut items = Vec::new();
    if let Ok(number) = query.trim_start_matches('#').parse::<i64>() {
        if number > 0 {
            for kind in ["issue", "pull"] {
                if let Ok(value) = view_as(root, kind, number, "number,title,state,url,author,isDraft", trust) {
                    items.extend(item(kind, &value));
                }
            }
            if !items.is_empty() {
                return Ok(items);
            }
        }
    }
    for (kind, command) in [("issue", "issue"), ("pull", "pr")] {
        let mut args = vec![command, "list", "--state", "open", "--limit", &limit, "--json", "number,title,state,url,author,isDraft"];
        let search = flag("search", &query);
        if !query.is_empty() {
            args.push(&search);
        }
        let value = json(&run_gh_as(root, &args, TIMEOUT, trust)?)?;
        items.extend(value.as_array().into_iter().flatten().filter_map(|v| item(kind, v)));
    }
    Ok(items)
}

/// Open issues for the board import dialog.
pub fn issues(root: &Path, filter: &IssueFilter) -> Result<Vec<Issue>, String> {
    let mut args: Vec<String> = ["issue", "list", "--state", "open", "--limit", "50", "--json", "number,title,body,state,url,labels,assignees,updatedAt"]
        .into_iter()
        .map(str::to_string)
        .collect();
    if filter.assigned_to_me {
        args.push(flag("assignee", "@me"));
    }
    if let Some(label) = filter.label.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        if label.len() > 100 || label.contains('\0') {
            return Err("Shorten the label filter.".into());
        }
        args.push(flag("label", label));
    }
    if let Some(query) = filter.query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        args.push(flag("search", &valid_query(query)?));
    }
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let value = json(&run_gh(root, &borrowed, TIMEOUT)?)?;
    Ok(value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| {
            let (body, _) = excerpt(&text(v, "body"), IMPORT_BODY_LIMIT);
            Some(Issue {
                number: v.get("number")?.as_i64()?,
                title: text(v, "title"),
                body,
                state: state_of(v),
                url: text(v, "url"),
                labels: names(v, "labels", "name"),
                assignees: names(v, "assignees", "login"),
                updated_at: text(v, "updatedAt"),
            })
        })
        .collect())
}

/// Full references for `#123` mentions, resolved in parallel and bounded.
pub fn resolve(root: &Path, numbers: &[i64]) -> Result<Vec<Reference>, String> {
    let mut wanted: Vec<i64> = Vec::new();
    for number in numbers {
        if *number > 0 && !wanted.contains(number) {
            wanted.push(*number);
        }
        if wanted.len() == MAX_REFERENCES {
            break;
        }
    }
    let results: Vec<Option<Reference>> = std::thread::scope(|scope| {
        let handles: Vec<_> = wanted
            .iter()
            .map(|number| {
                let number = *number;
                scope.spawn(move || {
                    for kind in ["issue", "pull"] {
                        if let Ok(value) = view(root, kind, number, "number,title,state,url,author,body,labels,isDraft") {
                            let (body, truncated) = excerpt(&text(&value, "body"), BODY_LIMIT);
                            return Some(Reference {
                                kind: kind.into(),
                                number,
                                title: text(&value, "title"),
                                state: state_of(&value),
                                url: text(&value, "url"),
                                author: value.get("author").map(|a| text(a, "login")).unwrap_or_default(),
                                body,
                                labels: names(&value, "labels", "name"),
                                truncated,
                            });
                        }
                    }
                    None
                })
            })
            .collect();
        handles.into_iter().map(|handle| handle.join().unwrap_or(None)).collect()
    });
    Ok(results.into_iter().flatten().collect())
}

/// One GraphQL round trip for every linked number in a project.
pub fn link_states(root: &Path, repo: &Repository, links: &[(String, i64)]) -> Result<Vec<LinkState>, String> {
    let (owner, name) = repo
        .name_with_owner
        .split_once('/')
        .ok_or("The repository name is incomplete.")?;
    let mut numbers: Vec<i64> = links.iter().map(|(_, number)| *number).filter(|n| *n > 0).collect();
    numbers.sort_unstable();
    numbers.dedup();
    numbers.truncate(100);
    if numbers.is_empty() {
        return Ok(vec![]);
    }
    let fields = numbers
        .iter()
        .map(|number| format!("n{number}: issueOrPullRequest(number: {number}) {{ __typename ... on Issue {{ number title state url }} ... on PullRequest {{ number title state url isDraft }} }}"))
        .collect::<Vec<_>>()
        .join(" ");
    let query = format!("query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{ {fields} }} }}");
    let owner_flag = flag("raw-field", &format!("owner={owner}"));
    let name_flag = flag("raw-field", &format!("name={name}"));
    let query_flag = flag("raw-field", &format!("query={query}"));
    // One deleted or transferred number makes gh exit 1 while still returning every
    // other node, so the data is read before the exit status is judged.
    let output = run_process(gh_command(root, &["api", "graphql", &owner_flag, &name_flag, &query_flag]), "GitHub CLI", OUTPUT_LIMIT, TIMEOUT)?;
    let value = match json(&output.stdout) {
        Ok(value) if value.pointer("/data/repository").is_some() => value,
        _ => return checked(output).and_then(|capture| json(&capture)).map(|_| vec![]),
    };
    let repository = value.pointer("/data/repository").cloned().unwrap_or(serde_json::Value::Null);
    Ok(numbers
        .iter()
        .filter_map(|number| {
            let node = repository.get(format!("n{number}"))?;
            let kind = match text(node, "__typename").as_str() {
                "Issue" => "issue",
                "PullRequest" => "pull",
                _ => return None,
            };
            Some(LinkState {
                kind: kind.into(),
                number: *number,
                state: state_of(node),
                title: text(node, "title"),
                url: text(node, "url"),
            })
        })
        .collect())
}

/// `gh pr create`'s arguments; user text goes as `--flag=value`. `repo` (`owner/name`, the
/// phone's) pins the repository as `--repo=…` (Round 21); the desktop passes `None`.
fn pr_create_args(repo: Option<&str>, title: &str, body: &str, base: &str, head: &str, draft: bool) -> Vec<String> {
    let mut args = vec!["pr".to_owned(), "create".to_owned(), flag("title", title), flag("body", body), flag("base", base), flag("head", head)];
    args.extend(repo.map(|repo| flag("repo", repo)));
    if draft {
        args.push("--draft".to_owned());
    }
    args
}

/// The `--head` for `gh pr create`: the bare branch, unless the base `repo` is pinned (a phone)
/// and the branch was pushed to another repository (`push`, a fork's `origin`), where GitHub
/// needs `<pushOwner>:<branch>` to find it (Round 23).
fn pull_head(repo: Option<&str>, push: Option<&str>, head: &str) -> String {
    match (repo, push) {
        (Some(repo), Some(push)) if !repo.eq_ignore_ascii_case(push) => match push.split_once('/') {
            Some((owner, _)) => format!("{owner}:{head}"),
            None => head.to_owned(),
        },
        _ => head.to_owned(),
    }
}

/// The repository a pull request is opened in: none (gh's choice, as before) for the desktop;
/// for a phone the checkout's base repository as `gh` resolves it (Round 22,
/// [`crate::github_hub::base_repo`]: the `gh-resolved` remote, then `upstream`, then `origin`),
/// pinned with `--repo=…` and refused without one (Round 21).
pub(crate) fn pull_create_repo(root: &Path, trust: Trust) -> Result<Option<String>, String> {
    if trust == Trust::Desktop {
        return Ok(None);
    }
    crate::github_hub::base_repo(root).map(Some).ok_or_else(|| crate::github_pull::NO_GITHUB_REMOTE.to_owned())
}

/// Open a pull request (a draft with `draft`) for an already pushed branch, with the caller's
/// trust (see [`run_gh_as`]): the phone's `pull.create` must not let `gh` run the checkout's git
/// hooks or filters with desktop trust; the desktop passes `Trust::Desktop` (plain `run_gh`).
pub(crate) fn create_pull_request_as(root: &Path, title: &str, body: &str, base: &str, head: &str, draft: bool, trust: Trust) -> Result<PullRequest, String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 256 {
        return Err("Give the pull request a title of up to 256 characters.".into());
    }
    if body.len() > 64 * 1024 {
        return Err("Shorten the pull request description.".into());
    }
    for reference in [base, head] {
        if reference.is_empty() || reference.len() > 200 || reference.starts_with('-') || reference.contains("..") {
            return Err("Choose valid base and head branches.".into());
        }
    }
    let repo = pull_create_repo(root, trust)?;
    let head = pull_head(repo.as_deref(), crate::github_hub::push_repo(root).as_deref(), head);
    let args = pr_create_args(repo.as_deref(), title, body, base, &head, draft);
    let output = run_gh_as(root, &args.iter().map(String::as_str).collect::<Vec<_>>(), Duration::from_secs(60), trust)?;
    let url = String::from_utf8_lossy(&output.bytes)
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with("https://"))
        .ok_or("GitHub did not return the pull request URL.")?
        .to_string();
    let number = url
        .rsplit('/')
        .next()
        .and_then(|segment| segment.parse().ok())
        .ok_or("GitHub returned an unexpected pull request URL.")?;
    Ok(PullRequest {
        number,
        url,
        title: title.to_string(),
        state: if draft { "draft" } else { "open" }.into(),
    })
}

/// A pull request review's verdict, as `gh pr review` takes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReviewEvent {
    Approve,
    RequestChanges,
    Comment,
}

impl ReviewEvent {
    /// `approve`, `request_changes` or `comment` (the phone's `pull.review` `event`).
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "approve" => Some(Self::Approve),
            "request_changes" => Some(Self::RequestChanges),
            "comment" => Some(Self::Comment),
            _ => None,
        }
    }

    fn flag(self) -> &'static str {
        match self {
            Self::Approve => "--approve",
            Self::RequestChanges => "--request-changes",
            Self::Comment => "--comment",
        }
    }

    /// GitHub refuses a change request or a comment review without text.
    pub(crate) fn needs_body(self) -> bool {
        !matches!(self, Self::Approve)
    }
}

/// `gh pr review <number> --approve|--request-changes|--comment [--body=…]`: the body only as
/// `--body=value`, so review text never reaches the CLI's option parser.
/// `--repo=<repo>` pins the project's `origin` repository (Round 18).
fn pr_review_args(repo: &str, number: i64, event: ReviewEvent, body: &str) -> Vec<String> {
    let mut args = vec!["pr".to_owned(), "review".to_owned(), number.to_string(), flag("repo", repo), event.flag().to_owned()];
    if !body.is_empty() {
        args.push(flag("body", body));
    }
    args
}

/// Review pull request `number` with the caller's trust (see [`run_gh_as`]): the phone's
/// `pull.review` must not let `gh` run the checkout's git hooks or filters with desktop trust.
/// `repo` (`owner/name`) is the project's `origin`, passed as `--repo=…`.
pub(crate) fn review_pull_as(root: &Path, repo: &str, number: i64, event: ReviewEvent, body: &str, trust: Trust) -> Result<(), String> {
    let body = body.trim();
    if number <= 0 {
        return Err("Choose a pull request to review.".into());
    }
    if repo.trim().is_empty() {
        return Err("This project has no GitHub remote.".into());
    }
    if event.needs_body() && body.is_empty() {
        return Err("Write a comment for this review.".into());
    }
    let args = pr_review_args(repo, number, event, body);
    run_gh_as(root, &args.iter().map(String::as_str).collect::<Vec<_>>(), TIMEOUT, trust)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    fn env_of(command: &std::process::Command, key: &str) -> Option<String> {
        command.get_envs().find(|(k, _)| *k == key).and_then(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()))
    }

    #[test]
    fn phone_gh_calls_carry_the_hardened_git_env_and_desktop_calls_do_not() {
        use crate::workspace::Trust;
        let root = std::path::Path::new("/tmp");
        let desktop = super::gh_trusted_command(root, &["issue", "list"], Trust::Desktop);
        assert_eq!(env_of(&desktop, "GIT_CONFIG_COUNT"), None);
        let trusted_phone = super::gh_trusted_command(root, &["issue", "list"], Trust::phone(true));
        assert_eq!(env_of(&trusted_phone, "GIT_CONFIG_COUNT"), None, "Full access on keeps Desktop trust");
        let phone = super::gh_trusted_command(root, &["issue", "list"], Trust::phone(false));
        let count: usize = env_of(&phone, "GIT_CONFIG_COUNT").expect("hardened env").parse().unwrap();
        assert!(count > 0);
        for (key, value) in crate::workspace::tool_git_env(Trust::phone(false)) {
            assert_eq!(env_of(&phone, &key).as_deref(), Some(value.as_str()), "{key}");
        }
        assert_eq!(env_of(&phone, "GH_PROMPT_DISABLED").as_deref(), Some("1"), "keeps the base gh env");
    }

    #[test]
    fn a_phone_pull_request_runs_gh_with_the_phone_trust() {
        let source = include_str!("github.rs");
        let body = &source[source.find("pub(crate) fn create_pull_request_as(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("run_gh_as(root, &args.iter().map(String::as_str).collect::<Vec<_>>(), Duration::from_secs(60), trust)?"));
        assert!(!body.contains("run_gh(root"));
        let lib = include_str!("lib.rs");
        let push = &lib[lib.find("pub(crate) fn push_and_open_pull(").unwrap()..];
        let push = &push[..push.find("\n}\n").unwrap()];
        assert!(push.contains("github::create_pull_request_as(root, title, body, base, &status.branch, draft, trust)?"));
    }

    #[test]
    fn pr_review_keeps_user_text_in_flags_and_runs_with_the_phone_trust() {
        use super::ReviewEvent;
        let args = super::pr_review_args("o/r", 7, ReviewEvent::RequestChanges, "--approve");
        assert_eq!(args, ["pr", "review", "7", "--repo=o/r", "--request-changes", "--body=--approve"]);
        assert_eq!(super::pr_review_args("o/r", 7, ReviewEvent::Approve, ""), ["pr", "review", "7", "--repo=o/r", "--approve"]);
        assert_eq!(super::pr_review_args("o/r", 7, ReviewEvent::Comment, "hi").get(4).map(String::as_str), Some("--comment"));
        assert_eq!(ReviewEvent::parse("request_changes"), Some(ReviewEvent::RequestChanges));
        assert_eq!(ReviewEvent::parse("--approve"), None);
        assert!(ReviewEvent::Comment.needs_body() && !ReviewEvent::Approve.needs_body());
        let root = std::path::Path::new("/tmp");
        assert!(super::review_pull_as(root, "o/r", 7, ReviewEvent::Comment, "  ", crate::workspace::Trust::phone(false)).is_err());
        assert!(super::review_pull_as(root, "o/r", 0, ReviewEvent::Approve, "", crate::workspace::Trust::phone(false)).is_err());
        assert_eq!(super::review_pull_as(root, "", 7, ReviewEvent::Approve, "", crate::workspace::Trust::phone(false)).unwrap_err(), "This project has no GitHub remote.");
        let source = include_str!("github.rs");
        let body = &source[source.find("pub(crate) fn review_pull_as(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("run_gh_as(root, &args.iter().map(String::as_str).collect::<Vec<_>>(), TIMEOUT, trust)?"));
        assert!(!body.contains("run_gh(root"));
    }

    #[test]
    fn phone_views_pin_the_projects_repository() {
        let args = super::view_args(Some("o/r"), "pull", 5, "number,title");
        assert_eq!(args, ["pr", "view", "5", "--json", "number,title", "--repo=o/r"]);
        assert_eq!(super::view_args(Some("o/r"), "issue", 5, "url")[0], "issue");
        assert!(!super::view_args(None, "issue", 5, "url").iter().any(|arg| arg.starts_with("--repo")), "desktop views are unchanged");
    }

    /// Round 21: the phone's `pull.create` opens the pull request in the project's `origin`
    /// (`--repo=…`), and is refused without a GitHub origin; the desktop's `gh pr create` is unchanged.
    #[test]
    fn phone_pull_requests_open_in_the_projects_repository() {
        let args = super::pr_create_args(Some("me/fork"), "T", "", "main", "feature", false);
        assert!(args.contains(&"--repo=me/fork".to_owned()), "{args:?}");
        assert!(!super::pr_create_args(None, "T", "", "main", "feature", false).iter().any(|arg| arg.starts_with("--repo")), "desktop unchanged");
        let dir = std::env::temp_dir().join(format!("pandacode-pr-create-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(&dir).status().unwrap().success());
        assert_eq!(super::pull_create_repo(&dir, Trust::Desktop), Ok(None));
        assert_eq!(super::pull_create_repo(&dir, Trust::phone(true)).unwrap_err(), crate::github_pull::NO_GITHUB_REMOTE);
        // Refused before `gh` runs (no network or sign-in needed).
        assert_eq!(super::create_pull_request_as(&dir, "T", "", "main", "feature", false, Trust::phone(true)).unwrap_err(), crate::github_pull::NO_GITHUB_REMOTE);
        assert!(std::process::Command::new("git").args(["remote", "add", "origin", "https://github.com/me/fork.git"]).current_dir(&dir).status().unwrap().success());
        assert_eq!(super::pull_create_repo(&dir, Trust::phone(false)), Ok(Some("me/fork".into())));
        // Round 22: a fork checkout opens it where the desktop's `gh` would: `upstream`, unless
        // `gh repo set-default` marked another remote.
        assert!(std::process::Command::new("git").args(["remote", "add", "upstream", "git@github.com:up/stream.git"]).current_dir(&dir).status().unwrap().success());
        assert_eq!(super::pull_create_repo(&dir, Trust::phone(false)), Ok(Some("up/stream".into())));
        assert!(std::process::Command::new("git").args(["config", "remote.origin.gh-resolved", "base"]).current_dir(&dir).status().unwrap().success());
        assert_eq!(super::pull_create_repo(&dir, Trust::phone(false)), Ok(Some("me/fork".into())));
        let source = include_str!("github.rs");
        let body = &source[source.find("pub(crate) fn create_pull_request_as(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("let args = pr_create_args(repo.as_deref(),"));
        assert!(body.contains("pull_head(repo.as_deref(), crate::github_hub::push_repo(root).as_deref(), head)"));
        // `pull.create` checks before it pushes anything.
        let git = include_str!("remote/methods/git.rs");
        let open = &git[git.find("async fn open_pull(").unwrap()..];
        let open = &open[..open.find("\n}\n").unwrap()];
        assert!(open.find("github::pull_create_repo(").unwrap() < open.find("push_and_open_pull(").unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Round 23: a fork checkout pushes to its `origin`, so the phone's pull request names the
    /// head as `<owner>:<branch>`; a same-repository checkout and the desktop are unchanged.
    #[test]
    fn phone_pull_requests_from_a_fork_name_the_fork_head() {
        assert_eq!(super::pull_head(Some("up/stream"), Some("me/fork"), "feature"), "me:feature");
        assert_eq!(super::pull_head(Some("me/fork"), Some("me/fork"), "feature"), "feature", "same repository");
        assert_eq!(super::pull_head(Some("Me/Fork"), Some("me/fork"), "feature"), "feature", "names match case-insensitively");
        assert_eq!(super::pull_head(None, Some("me/fork"), "feature"), "feature", "desktop unchanged");
        assert_eq!(super::pull_head(Some("up/stream"), None, "feature"), "feature", "no GitHub push remote");
        let args = super::pr_create_args(Some("up/stream"), "T", "", "main", &super::pull_head(Some("up/stream"), Some("me/fork"), "feature"), false);
        assert!(args.contains(&"--head=me:feature".to_owned()) && args.contains(&"--repo=up/stream".to_owned()), "{args:?}");
        let dir = std::env::temp_dir().join(format!("pandacode-pr-fork-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&dir).status().unwrap().success());
        git(&["init", "-q"]);
        git(&["remote", "add", "origin", "https://github.com/me/fork.git"]);
        git(&["remote", "add", "upstream", "git@github.com:up/stream.git"]);
        let base = super::pull_create_repo(&dir, Trust::phone(false)).unwrap();
        assert_eq!(base.as_deref(), Some("up/stream"));
        assert_eq!(super::pull_head(base.as_deref(), crate::github_hub::push_repo(&dir).as_deref(), "feature"), "me:feature");
        git(&["remote", "remove", "upstream"]);
        let base = super::pull_create_repo(&dir, Trust::phone(false)).unwrap();
        assert_eq!(super::pull_head(base.as_deref(), crate::github_hub::push_repo(&dir).as_deref(), "feature"), "feature");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pr_create_marks_drafts_and_keeps_user_text_in_flags() {
        let args = super::pr_create_args(None, "-t", "--body", "main", "feature", true);
        assert_eq!(&args[..2], ["pr", "create"]);
        assert!(args.iter().skip(2).all(|arg| arg.starts_with("--")), "{args:?}");
        assert_eq!(args.last().map(String::as_str), Some("--draft"));
        assert!(!super::pr_create_args(None, "t", "", "main", "feature", false).contains(&"--draft".to_owned()));
    }

    #[cfg(unix)]
    #[test]
    fn gh_runs_with_the_tool_search_path_even_from_a_minimal_gui_path() {
        // Finder and the Dock start apps with PATH=/usr/bin:/bin; gh must still find Homebrew.
        let command = super::gh_command(std::path::Path::new("/"), &["--version"]);
        let path = command.get_envs().find(|(key, _)| *key == "PATH").and_then(|(_, value)| value).expect("gh gets a PATH");
        let dirs: Vec<_> = std::env::split_paths(path).collect();
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            assert!(dirs.contains(&std::path::PathBuf::from(dir)), "{dir} is searched");
        }
    }

    use super::*;

    #[test]
    fn excerpts_cut_on_character_boundaries_and_flag_truncation() {
        let body = "héllo wörld".repeat(500);
        let (short, truncated) = excerpt(&body, 4096);
        assert!(truncated);
        assert!(short.len() <= 4096);
        assert!(body.starts_with(&short));
        assert_eq!(excerpt("small", 4096), ("small".into(), false));
    }

    #[test]
    fn items_read_gh_json_and_lower_case_states() {
        let value: serde_json::Value = serde_json::from_str(r#"{"number":12,"title":"Login bug","state":"OPEN","url":"https://github.com/o/r/issues/12","author":{"login":"octocat"},"labels":[{"name":"bug"}]}"#).unwrap();
        let parsed = item("issue", &value).unwrap();
        assert_eq!(parsed.number, 12);
        assert_eq!(parsed.state, "open");
        assert_eq!(parsed.author, "octocat");
        assert_eq!(names(&value, "labels", "name"), vec!["bug"]);
        let draft: serde_json::Value = serde_json::from_str(r#"{"number":3,"state":"OPEN","isDraft":true,"url":"","title":""}"#).unwrap();
        assert_eq!(state_of(&draft), "draft");
        assert!(item("pull", &serde_json::json!({"title":"missing number"})).is_none());
    }

    #[test]
    fn user_text_travels_as_flag_values_and_is_bounded() {
        assert_eq!(flag("search", "-rf --exec"), "--search=-rf --exec");
        assert!(valid_query(&"x".repeat(201)).is_err());
        assert_eq!(valid_query("  login bug ").unwrap(), "login bug");
    }

    /// Read-only check against the real CLI; run with `cargo test -- --ignored github::` when gh is signed in.
    #[test]
    #[ignore]
    fn live_cli_shapes_match_the_parsers() {
        let root = std::env::current_dir().unwrap();
        let status = status(&root);
        assert!(status.installed && status.authenticated, "{status:?}");
        let repo = status.repo.expect("this checkout has a GitHub remote");
        assert!(!repo.default_branch.is_empty());
        let states = link_states(&root, &Repository { name_with_owner: "cli/cli".into(), default_branch: "trunk".into(), url: String::new() }, &[("issue".into(), 1), ("pull".into(), 999_999_999)]).unwrap();
        assert_eq!(states.len(), 1, "a missing number is skipped, not fatal: {states:?}");
        assert_eq!(states[0].number, 1);
        assert!(["issue", "pull"].contains(&states[0].kind.as_str()));
    }

    #[test]
    fn a_missing_cli_is_named_and_other_failures_pass_through() {
        assert_eq!(start_failure("Could not start GitHub CLI: No such file or directory"), "GitHub CLI (gh) is not installed.");
        assert_eq!(start_failure("GitHub CLI operation timed out. Check the repository before retrying."), "GitHub CLI operation timed out. Check the repository before retrying.");
    }
}
