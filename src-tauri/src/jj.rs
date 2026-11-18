//! Jujutsu (jj) support for a task's checkout: the working-copy change, its files and
//! diff, describe/new/commit, and a short log. Every call runs the user's `jj` through
//! `workspace::run_process` from the checkout; mirrors never get here because
//! `Store::workspace_root` refuses them. User text only ever travels as `--message=<text>`
//! or inside a quoted fileset after `--`, so it can never become an option or a revset.
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use crate::workspace::{checked, run_process};

const TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT_LIMIT: usize = 1024 * 1024;
const DIFF_LIMIT: usize = 256 * 1024;
const TRUNCATED: &str = "\n\n[Diff truncated at 256 KiB]\n";
const MAX_LOG: usize = 200;
const MAX_MESSAGE: usize = 64 * 1024;
/// Fields end in NUL, which no description, name or id can contain, so a record of
/// `FIELDS` values parses whatever newlines a description holds.
const TEMPLATE: &str = concat!(
    r#"change_id.short(12) ++ "\0" ++ commit_id.short(12) ++ "\0" ++ description ++ "\0" ++ "#,
    r#"local_bookmarks.map(|b| b.name()).join(",") ++ "\0" ++ author.name() ++ "\0" ++ "#,
    r#"committer.timestamp().ago() ++ "\0" ++ if(conflict, "1", "0") ++ "\0" ++ "#,
    r#"if(empty, "1", "0") ++ "\0" ++ if(current_working_copy, "1", "0") ++ "\0""#
);
const FIELDS: usize = 9;

#[derive(Debug, Serialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub change_id: String,
    pub commit_id: String,
    pub description: String,
    pub bookmarks: Vec<String>,
    pub author: String,
    /// Relative, as jj prints it ("3 minutes ago").
    pub when: String,
    pub conflict: bool,
    pub empty: bool,
    /// The working-copy change (`@`).
    pub current: bool,
}
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JjFile {
    /// M, A, D, R (renamed) or C (copied).
    pub status: String,
    /// Path from the repository root; a rename's new path.
    pub path: String,
}
#[derive(Debug, Serialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct JjStatus {
    pub is_repo: bool,
    /// The jj repo shares its folder with a Git checkout, so Git tools still work.
    pub colocated: bool,
    pub change: Option<Change>,
    pub files: Vec<JjFile>,
}

/// The folder holding `.jj`, at the checkout or any ancestor.
pub fn repo_root(root: &Path) -> Option<PathBuf> {
    root.ancestors().find(|dir| dir.join(".jj").is_dir()).map(Path::to_path_buf)
}

pub fn status(root: &Path) -> Result<JjStatus, String> {
    status_with(root, repo_root(root), &[])
}

/// Global options for a phone's read-only jj call with the host's Full access switch off:
/// no working-copy snapshot (it would write a commit, through the repository's signing
/// program and fsmonitor), signing dropped, no watchman, no pager.
pub const UNTRUSTED_ARGS: [&str; 7] =
    ["--ignore-working-copy", "--config", "signing.behavior=drop", "--config", "fsmonitor.backend=none", "--config", "ui.paginate=never"];

/// [`status`] for a phone with the switch off: [`UNTRUSTED_ARGS`], and only a `.jj` in
/// `root` itself counts (never one in a parent folder outside the project).
pub fn status_untrusted(root: &Path) -> Result<JjStatus, String> {
    let repo = root.join(".jj").is_dir().then(|| root.to_path_buf());
    status_with(root, repo, &UNTRUSTED_ARGS)
}

fn status_with(root: &Path, repo: Option<PathBuf>, extra: &[&str]) -> Result<JjStatus, String> {
    let Some(repo) = repo else { return Ok(JjStatus::default()) };
    let mut changes = parse_log(&run(root, &status_args(extra, &["log", "--no-graph", "-r", "@", "-T", TEMPLATE]))?)?;
    let files = parse_summary(&run(root, &status_args(extra, &["diff", "--summary", "-r", "@"]))?);
    Ok(JjStatus { is_repo: true, colocated: repo.join(".git").exists(), change: changes.pop(), files })
}

/// `extra` global options before a subcommand.
fn status_args<'a>(extra: &[&'a str], subcommand: &[&'a str]) -> Vec<&'a str> {
    extra.iter().chain(subcommand).copied().collect()
}

pub fn diff(root: &Path, path: Option<&str>) -> Result<String, String> {
    require(root)?;
    let mut args = vec!["diff".to_string(), "--git".into(), "-r".into(), "@".into()];
    if let Some(path) = path {
        args.push("--".into());
        args.push(fileset(path)?);
    }
    let output = checked(run_process(command(root, &args), "jj", DIFF_LIMIT, TIMEOUT)?)?;
    let mut text = String::from_utf8_lossy(&output.bytes).into_owned();
    if output.truncated {
        let mut end = DIFF_LIMIT.saturating_sub(TRUNCATED.len()).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str(TRUNCATED);
    }
    Ok(text)
}

pub fn describe(root: &Path, message: &str) -> Result<JjStatus, String> {
    require(root)?;
    run(root, &["describe", &message_flag(message)?])?;
    status(root)
}

pub fn new_change(root: &Path) -> Result<JjStatus, String> {
    require(root)?;
    run(root, &["new"])?;
    status(root)
}

/// `jj commit`: describe the working-copy change, then start a new empty one on top.
pub fn commit(root: &Path, message: &str) -> Result<JjStatus, String> {
    require(root)?;
    if message.trim().is_empty() {
        return Err("Write a description before committing.".into());
    }
    run(root, &["commit", &message_flag(message)?])?;
    status(root)
}

/// The last `limit` changes of the repository's default log revset.
pub fn log(root: &Path, limit: usize) -> Result<Vec<Change>, String> {
    require(root)?;
    let limit = limit.clamp(1, MAX_LOG).to_string();
    parse_log(&run(root, &["log", "--no-graph", "--limit", &limit, "-T", TEMPLATE])?)
}

fn require(root: &Path) -> Result<(), String> {
    repo_root(root).map(|_| ()).ok_or_else(|| "This folder is not a Jujutsu repository.".into())
}

fn message_flag(message: &str) -> Result<String, String> {
    if message.len() > MAX_MESSAGE || message.contains('\0') {
        return Err("That description cannot be saved.".into());
    }
    Ok(format!("--message={message}"))
}

/// One path from the repository root as a quoted fileset, so `|`, `~` or `(` in a
/// file name stay part of the name.
fn fileset(path: &str) -> Result<String, String> {
    let bad = path.is_empty()
        || path.contains('\0')
        || path.starts_with('/')
        || Path::new(path).components().any(|part| matches!(part, std::path::Component::ParentDir));
    if bad {
        return Err("Path must stay inside the repository.".into());
    }
    Ok(format!("root-file:\"{}\"", path.replace('\\', "\\\\").replace('"', "\\\"")))
}

fn command(root: &Path, args: &[impl AsRef<std::ffi::OsStr>]) -> Command {
    let mut command = Command::new("jj");
    command
        .current_dir(root)
        .args(["--no-pager", "--color=never"])
        .args(args)
        // Never open an editor or pager behind the app's back.
        .env("JJ_EDITOR", "true")
        .env("NO_COLOR", "1");
    command
}

fn run(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = run_process(command(root, args), "jj", OUTPUT_LIMIT, TIMEOUT).map_err(|error| {
        if error.starts_with("Could not start jj") {
            "Jujutsu (jj) is not installed or not on PATH.".to_string()
        } else {
            error
        }
    })?;
    let capture = checked(output)?;
    if capture.truncated {
        return Err("jj returned more output than PandaCode reads.".into());
    }
    Ok(String::from_utf8_lossy(&capture.bytes).into_owned())
}

fn parse_log(output: &str) -> Result<Vec<Change>, String> {
    let fields: Vec<&str> = output.split('\0').collect();
    // Each record ends in NUL, so the split leaves one trailing remainder (a newline at most).
    let records = &fields[..fields.len() - 1];
    if !records.len().is_multiple_of(FIELDS) || !fields[fields.len() - 1].trim().is_empty() {
        return Err("jj returned an unexpected log.".into());
    }
    Ok(records
        .chunks(FIELDS)
        .map(|f| Change {
            change_id: f[0].into(),
            commit_id: f[1].into(),
            description: f[2].trim_end().into(),
            bookmarks: f[3].split(',').filter(|b| !b.is_empty()).map(str::to_string).collect(),
            author: f[4].into(),
            when: f[5].into(),
            conflict: f[6] == "1",
            empty: f[7] == "1",
            current: f[8] == "1",
        })
        .collect())
}

/// `jj diff --summary` lines: `M src/a.rs`, or `R src/{old.rs => new.rs}` for a rename.
fn parse_summary(output: &str) -> Vec<JjFile> {
    output
        .lines()
        .filter_map(|line| {
            let (status, path) = line.split_once(' ')?;
            (status.len() == 1).then(|| JjFile { status: status.into(), path: renamed_to(path) })
        })
        .collect()
}

fn renamed_to(path: &str) -> String {
    let (Some(open), Some(close)) = (path.find('{'), path.rfind('}')) else { return path.into() };
    let Some((_, to)) = path[open + 1..close].split_once(" => ") else { return path.into() };
    // `{ => b}/x` and `a/{x => }/y` leave doubled or leading slashes behind.
    format!("{}{}{}", &path[..open], to, &path[close + 1..]).replace("//", "/").trim_start_matches('/').into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_records_with_multiline_descriptions() {
        let output = "kntqzsqtwlyn\x00a1b2c3d4e5f6\x00Add search\n\nWith a body line.\n\x00main,feature\x00Ada\x003 minutes ago\x000\x000\x001\x00\
                      zzzzzzzzzzzz\x00000000000000\x00\x00\x00\x00\x000\x001\x000\x00";
        let changes = parse_log(output).unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].description, "Add search\n\nWith a body line.");
        assert_eq!(changes[0].bookmarks, ["main", "feature"]);
        assert!(changes[0].current && !changes[0].empty && !changes[0].conflict);
        assert_eq!(changes[0].when, "3 minutes ago");
        assert!(changes[1].bookmarks.is_empty() && changes[1].empty && !changes[1].current);
        assert_eq!(parse_log("").unwrap(), []);
        assert!(parse_log("only\0two\0").is_err());
    }

    #[test]
    fn parses_summary_lines_and_renames() {
        let files = parse_summary("M src/main.rs\nA docs/new file.md\nD old.txt\nR src/{a.rs => b.rs}\nR {x => y}/z.rs\nC lib/{ => sub}/c.rs\n");
        let paths: Vec<_> = files.iter().map(|f| (f.status.as_str(), f.path.as_str())).collect();
        assert_eq!(
            paths,
            [("M", "src/main.rs"), ("A", "docs/new file.md"), ("D", "old.txt"), ("R", "src/b.rs"), ("R", "y/z.rs"), ("C", "lib/sub/c.rs")]
        );
        assert!(parse_summary("Working copy changes:\n").is_empty());
    }

    #[test]
    fn user_text_never_becomes_an_option_or_revset() {
        assert_eq!(message_flag("-r root()").unwrap(), "--message=-r root()");
        assert!(message_flag("a\0b").is_err());
        assert_eq!(fileset("a \"b\"|c").unwrap(), r#"root-file:"a \"b\"|c""#);
        assert!(fileset("../x").is_err() && fileset("/etc/passwd").is_err() && fileset("").is_err());
    }

    /// Round 8: a phone's jj status with the switch off never snapshots the working copy,
    /// signs, or looks for `.jj` above the folder it was given.
    #[test]
    fn untrusted_status_skips_the_working_copy_signing_and_parent_repos() {
        let args = status_args(&UNTRUSTED_ARGS, &["log", "-r", "@"]);
        assert_eq!(args[0], "--ignore-working-copy");
        let pairs: Vec<_> = args.windows(2).filter(|w| w[0] == "--config").map(|w| w[1]).collect();
        assert!(pairs.contains(&"signing.behavior=drop") && pairs.contains(&"fsmonitor.backend=none"), "{args:?}");
        assert_eq!(&args[UNTRUSTED_ARGS.len()..], ["log", "-r", "@"]);
        let command = command(Path::new("/tmp"), &args);
        let all: Vec<_> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(all.starts_with(&["--no-pager".into(), "--color=never".into(), "--ignore-working-copy".into()]), "{all:?}");
        let base = std::env::temp_dir().join(format!("pandacode-jj-parent-{}", uuid::Uuid::new_v4()));
        let nested = base.join("project");
        std::fs::create_dir_all(base.join(".jj")).unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        // The parent's `.jj` is outside the project: no jj runs at all.
        assert_eq!(status_untrusted(&nested).unwrap(), JjStatus::default());
        assert!(repo_root(&nested).is_some(), "the desktop still finds it");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn detects_repo_root_and_colocation() {
        let base = std::env::temp_dir().join(format!("pandacode-jj-{}", uuid::Uuid::new_v4()));
        let nested = base.join("src/deep");
        std::fs::create_dir_all(&nested).unwrap();
        assert_ne!(repo_root(&nested).as_deref(), Some(base.as_path()));
        std::fs::create_dir(base.join(".jj")).unwrap();
        assert_eq!(repo_root(&nested).unwrap(), base);
        assert!(!base.join(".git").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Needs `jj` on PATH: `cargo test jj::tests::live -- --ignored`.
    #[test]
    #[ignore]
    fn live_round_trip() {
        let base = std::env::temp_dir().join(format!("pandacode-jj-live-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        run(&base, &["git", "init"]).unwrap();
        std::fs::write(base.join("a b.txt"), "hello\n").unwrap();
        let state = status(&base).unwrap();
        assert!(state.is_repo && state.files.iter().any(|f| f.path == "a b.txt" && f.status == "A"));
        assert!(diff(&base, Some("a b.txt")).unwrap().contains("+hello"));
        let state = commit(&base, "-r root() first").unwrap();
        assert!(state.files.is_empty() && state.change.unwrap().empty);
        assert_eq!(log(&base, 5).unwrap()[1].description, "-r root() first");
        let _ = std::fs::remove_dir_all(&base);
    }
}
