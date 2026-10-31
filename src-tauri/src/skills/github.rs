//! Import a skill or rule from a GitHub repository path through the user's `gh` login.
use base64::Engine;
use std::time::Duration;

use super::{Files, MAX_BYTES, MAX_FILES};

const TIMEOUT: Duration = Duration::from_secs(30);

pub(super) fn valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let ok = |part: Option<&str>| part.is_some_and(|p| !p.is_empty() && !p.starts_with(['.', '-']) && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)));
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}
pub(super) fn valid_path(path: &str) -> bool {
    path.split('/').all(|part| !part.is_empty() && part != "." && part != ".." && part.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_. ".contains(&b)))
}
pub(super) fn valid_ref(git_ref: &str) -> bool {
    !git_ref.is_empty() && !git_ref.starts_with('-') && !git_ref.contains("..") && git_ref.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./".contains(&b))
}

pub(super) fn api(endpoint: &str) -> Result<serde_json::Value, String> {
    let home = crate::agent_usage_providers::home().unwrap_or_else(std::env::temp_dir);
    let capture = crate::github::run_gh(&home, &["api", endpoint], TIMEOUT)?;
    crate::github::json(&capture)
}

/// `owner/name`, a path inside it (empty for the root), and an optional branch, tag or commit.
/// Returns the files under that path (relative to it), and the commit they came from.
pub fn fetch(repo: &str, path: &str, git_ref: Option<&str>) -> Result<(Files, String), String> {
    let path = path.trim_matches('/');
    if !valid_repo(repo) {
        return Err("Enter the repository as owner/name.".into());
    }
    if !path.is_empty() && !valid_path(path) {
        return Err("That repository path is not valid.".into());
    }
    let git_ref = git_ref.map(str::trim).filter(|r| !r.is_empty());
    if git_ref.is_some_and(|r| !valid_ref(r)) {
        return Err("That branch, tag or commit is not valid.".into());
    }
    let commit = api(&format!("repos/{repo}/commits/{}", git_ref.unwrap_or("HEAD")))?["sha"]
        .as_str()
        .ok_or("GitHub did not return a commit for that ref.")?
        .to_string();
    let mut files = Vec::new();
    let mut total = 0;
    let mut pending = vec![path.to_string()];
    while let Some(current) = pending.pop() {
        let value = api(&format!("repos/{repo}/contents/{current}?ref={commit}"))?;
        let entries = match value {
            serde_json::Value::Array(entries) => entries,
            single => vec![single],
        };
        for entry in entries {
            let entry_path = entry["path"].as_str().unwrap_or_default().to_string();
            let name = entry["name"].as_str().unwrap_or_default();
            if name.starts_with('.') || !valid_path(&entry_path) {
                continue;
            }
            match entry["type"].as_str() {
                Some("dir") => pending.push(entry_path),
                Some("file") => {
                    if files.len() >= MAX_FILES {
                        return Err(format!("That path holds more than {MAX_FILES} files."));
                    }
                    let content = match entry["content"].as_str() {
                        Some(content) => content.to_string(),
                        None => api(&format!("repos/{repo}/contents/{entry_path}?ref={commit}"))?["content"].as_str().unwrap_or_default().to_string(),
                    };
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(content.replace(['\n', '\r'], ""))
                        .map_err(|_| format!("GitHub returned unreadable content for {entry_path}."))?;
                    total += bytes.len();
                    if total > MAX_BYTES {
                        return Err("That path is larger than 1 MB.".into());
                    }
                    // A single-file import keeps its own name; a folder keeps its layout.
                    let relative = if entry_path == path { name.to_string() } else { entry_path[path.len()..].trim_start_matches('/').to_string() };
                    files.push((relative, bytes));
                }
                _ => {}
            }
        }
    }
    if files.is_empty() {
        return Err("Nothing to import at that path.".into());
    }
    Ok((files, commit))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_repository_input() {
        assert!(valid_repo("anthropics/skills"));
        assert!(!valid_repo("anthropics"));
        assert!(!valid_repo("-x/skills"));
        assert!(!valid_repo("a/b/c"));
        assert!(valid_path("skills/pdf"));
        assert!(!valid_path("skills/../secrets"));
        assert!(valid_ref("v1.2.0") && valid_ref("feature/x"));
        assert!(!valid_ref("--output=x") && !valid_ref("a..b"));
    }
}
