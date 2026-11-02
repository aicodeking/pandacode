//! GitHub through the user's own `gh` CLI. PandaCode stores no tokens: every call
//! runs the signed-in CLI with a null stdin, bounded output, and a deadline, and
//! only ever from a project's checkout so the repository is the remote's.
use serde::{Deserialize, Serialize};
use std::{path::Path, process::Command, time::Duration};

use crate::workspace::{checked, run_process, Capture};

pub(crate) const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
const BODY_LIMIT: usize = 4 * 1024;
const IMPORT_BODY_LIMIT: usize = 16 * 1024;
pub const MAX_REFERENCES: usize = 5;
pub(crate) const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub name_with_owner: String,
    pub default_branch: String,
    pub url: String,
}
#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub installed: bool,
    pub version: String,
    pub authenticated: bool,
    pub login: Option<String>,
    pub repo: Option<Repository>,
    pub error: Option<String>,
    /// Every account signed in to the user's gh, so a project can pin one.
    #[serde(default)]
    pub accounts: Vec<crate::github_accounts::Account>,
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
fn gh_command(root: &Path, args: &[&str], token: Option<&str>) -> Command {
    let mut command = gh_base(root);
    command
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_PAGER", "cat")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0");
    // A pinned project's token rides as GH_TOKEN, so gh acts as that account; without
    // one gh stays on its own active account.
    if let Some(token) = token {
        command.env("GH_TOKEN", token);
    }
    command
}
pub(crate) fn run_gh(root: &Path, args: &[&str], timeout: Duration) -> Result<Capture, String> {
    run_gh_token(root, None, args, timeout)
}
pub(crate) fn run_gh_token(root: &Path, token: Option<&str>, args: &[&str], timeout: Duration) -> Result<Capture, String> {
    checked(run_process(gh_command(root, args, token), "GitHub CLI", OUTPUT_LIMIT, timeout)?)
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

/// `gh auth status`'s report, merged from both streams (gh writes it to stderr).
/// Ok even when gh exits non-zero, so the accounts it listed still parse.
pub fn auth_report(root: &Path) -> Result<String, String> {
    Ok(auth_probe(root)?.0)
}
fn auth_probe(root: &Path) -> Result<(String, bool), String> {
    let mut command = gh_base(root);
    command
        .args(["auth", "status"])
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1");
    let output = run_process(command, "GitHub CLI", 64 * 1024, Duration::from_secs(20))?;
    let report = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout.bytes),
        String::from_utf8_lossy(&output.stderr.bytes)
    );
    Ok((report, output.status.success()))
}

/// Whether `gh` exists, who is signed in, and which repository this checkout uses.
/// `token` pins the account the repository check runs as; the identity probe stays
/// token-free, since listing accounts works the same for every one of them.
pub fn status(root: &Path, token: Option<&str>) -> GithubStatus {
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
    let (report, success) = match auth_probe(root) {
        Ok(probe) => probe,
        Err(error) => {
            status.error = Some(error);
            return status;
        }
    };
    status.authenticated = success;
    status.accounts = crate::github_accounts::parse_status(&report);
    status.login = status
        .accounts
        .iter()
        .find(|account| account.active)
        .or_else(|| status.accounts.first())
        .map(|account| account.login.clone())
        .or_else(|| {
            report.lines().find_map(|line| {
                let (_, rest) = line.split_once(" account ")?;
                rest.split_whitespace().next().map(str::to_string)
            })
        });
    if !status.authenticated {
        status.error = Some("Sign in with `gh auth login` to connect GitHub.".into());
        return status;
    }
    match repository(root, token) {
        Ok(repo) => status.repo = Some(repo),
        Err(error) if error.is_empty() => {}
        Err(error) => status.error = Some(error),
    }
    status
}

/// The GitHub repository behind this checkout's remote; `Err("")` means none.
pub fn repository(root: &Path, token: Option<&str>) -> Result<Repository, String> {
    let output = run_gh_token(
        root,
        token,
        &["repo", "view", "--json", "nameWithOwner,defaultBranchRef,url"],
        TIMEOUT,
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
pub(crate) fn view(root: &Path, token: Option<&str>, kind: &str, number: i64, fields: &str) -> Result<serde_json::Value, String> {
    let command = if kind == "pull" { "pr" } else { "issue" };
    let value = json(&run_gh_token(root, token, &[command, "view", &number.to_string(), "--json", fields], TIMEOUT)?)?;
    // The REST-style issue lookup can answer for a pull request; keep the kinds honest.
    if kind == "issue" && text(&value, "url").contains("/pull/") {
        return Err("This number is a pull request.".into());
    }
    Ok(value)
}

/// Open issues and pull requests matching the picker's query.
pub fn search(root: &Path, token: Option<&str>, query: &str, limit: usize) -> Result<Vec<Item>, String> {
    let query = valid_query(query)?;
    let limit = limit.clamp(1, 20).to_string();
    let mut items = Vec::new();
    if let Ok(number) = query.trim_start_matches('#').parse::<i64>() {
        if number > 0 {
            for kind in ["issue", "pull"] {
                if let Ok(value) = view(root, token, kind, number, "number,title,state,url,author,isDraft") {
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
        let value = json(&run_gh_token(root, token, &args, TIMEOUT)?)?;
        items.extend(value.as_array().into_iter().flatten().filter_map(|v| item(kind, v)));
    }
    Ok(items)
}

/// Open issues for the board import dialog.
pub fn issues(root: &Path, token: Option<&str>, filter: &IssueFilter) -> Result<Vec<Issue>, String> {
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
    let value = json(&run_gh_token(root, token, &borrowed, TIMEOUT)?)?;
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
pub fn resolve(root: &Path, token: Option<&str>, numbers: &[i64]) -> Result<Vec<Reference>, String> {
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
                        if let Ok(value) = view(root, token, kind, number, "number,title,state,url,author,body,labels,isDraft") {
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
pub fn link_states(root: &Path, token: Option<&str>, repo: &Repository, links: &[(String, i64)]) -> Result<Vec<LinkState>, String> {
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
    let output = run_process(gh_command(root, &["api", "graphql", &owner_flag, &name_flag, &query_flag], token), "GitHub CLI", OUTPUT_LIMIT, TIMEOUT)?;
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

/// Open a pull request for an already pushed branch.
pub fn create_pull_request(root: &Path, token: Option<&str>, title: &str, body: &str, base: &str, head: &str) -> Result<PullRequest, String> {
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
    let output = run_gh_token(
        root,
        token,
        &["pr", "create", &flag("title", title), &flag("body", body), &flag("base", base), &flag("head", head)],
        Duration::from_secs(60),
    )?;
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
        state: "open".into(),
    })
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn gh_runs_with_the_tool_search_path_even_from_a_minimal_gui_path() {
        // Finder and the Dock start apps with PATH=/usr/bin:/bin; gh must still find Homebrew.
        let command = super::gh_command(std::path::Path::new("/"), &["--version"], None);
        let path = command.get_envs().find(|(key, _)| *key == "PATH").and_then(|(_, value)| value).expect("gh gets a PATH");
        let dirs: Vec<_> = std::env::split_paths(path).collect();
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            assert!(dirs.contains(&std::path::PathBuf::from(dir)), "{dir} is searched");
        }
    }

    #[test]
    fn gh_command_passes_a_pinned_token_as_gh_token_only_when_given() {
        let with = gh_command(std::path::Path::new("/"), &["--version"], Some("gho_pinned"));
        let value = with.get_envs().find(|(key, _)| *key == "GH_TOKEN").and_then(|(_, value)| value).expect("a pinned account's token rides as GH_TOKEN");
        assert_eq!(value, std::ffi::OsStr::new("gho_pinned"));
        let without = gh_command(std::path::Path::new("/"), &["--version"], None);
        assert!(without.get_envs().find(|(key, _)| *key == "GH_TOKEN").is_none(), "no token leaves gh on its own active account");
    }

    #[test]
    fn github_status_keeps_old_payloads_valid_and_serializes_accounts_camel_case() {
        let status = GithubStatus {
            installed: true,
            version: "2.40.0".into(),
            authenticated: true,
            login: Some("alice".into()),
            repo: None,
            error: None,
            accounts: vec![
                crate::github_accounts::Account { login: "alice".into(), host: "github.com".into(), active: true },
                crate::github_accounts::Account { login: "corp-user".into(), host: "ghe.acme.dev".into(), active: false },
            ],
        };
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(value["accounts"][0]["login"], "alice");
        assert_eq!(value["accounts"][0]["host"], "github.com");
        assert_eq!(value["accounts"][0]["active"], true);
        assert_eq!(value["accounts"][1]["active"], false);
        let back: GithubStatus = serde_json::from_value(value).unwrap();
        assert_eq!(back.accounts, status.accounts);
        let old: GithubStatus = serde_json::from_str(
            r#"{"installed":true,"version":"2.39.1","authenticated":true,"login":"alice","repo":null,"error":null}"#,
        )
        .unwrap();
        assert!(old.accounts.is_empty(), "payloads saved before accounts exist still parse");
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
    let status = status(&root, None);
    assert!(status.installed && status.authenticated, "{status:?}");
    let repo = status.repo.expect("this checkout has a GitHub remote");
    assert!(!repo.default_branch.is_empty());
    let states = link_states(&root, None, &Repository { name_with_owner: "cli/cli".into(), default_branch: "trunk".into(), url: String::new() }, &[("issue".into(), 1), ("pull".into(), 999_999_999)]).unwrap();
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
