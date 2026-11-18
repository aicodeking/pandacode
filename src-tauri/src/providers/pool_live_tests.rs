//! Live smoke tests for account pools (ignored): does the real CLI resume a session
//! from a file it did not write in that place? They use the user's own logged-in
//! CLIs and config, never touch credentials, and send two tiny prompts each.
//! The Claude test removes its transcripts afterwards; the Codex test moves its rollout back but
//! leaves that short thread in the user's Codex history (Codex indexes it on its own).
//! Run: `cargo test --lib pool_live -- --ignored --nocapture`.

use std::path::{Path, PathBuf};
use std::process::Command;

fn word(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos();
    format!("{prefix}-{}", (nanos ^ std::process::id()) % 100_000)
}

/// A fresh, canonical temp folder (the CLIs key sessions by the resolved cwd).
fn temp_cwd(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pandacode-pool-live-{tag}-{}", word("d")));
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

fn run(program: &Path, cwd: &Path, args: &[&str]) -> String {
    let output = Command::new(program).args(args).current_dir(cwd).stdin(std::process::Stdio::null()).output().expect("run CLI");
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    println!("$ {} {}\nexit: {}\nstdout: {stdout}\nstderr: {}", program.display(), args.join(" "), output.status, String::from_utf8_lossy(&output.stderr));
    assert!(output.status.success(), "CLI failed");
    stdout
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").expect("HOME"))
}

/// Removes paths (and moves a file back) when the test ends, pass or fail.
#[derive(Default)]
struct Cleanup {
    remove: Vec<PathBuf>,
    restore: Option<(PathBuf, PathBuf)>,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some((from, to)) = &self.restore {
            let _ = std::fs::rename(from, to);
        }
        for path in &self.remove {
            let _ = if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
        }
    }
}

/// Claude Code's project folder name for a cwd: every non-alphanumeric becomes `-`
/// (not only `/` and `.`; macOS temp paths hold `_`).
fn claude_slug(cwd: &Path) -> String {
    cwd.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

#[test]
#[ignore = "live: sends two tiny prompts with the user's Claude Code login"]
fn claude_resumes_a_session_copied_into_another_project_folder() {
    let Some(claude) = super::executable("claude") else {
        eprintln!("skipped: Claude Code is not installed");
        return;
    };
    let projects = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".claude")).join("projects");
    let (x, y) = (temp_cwd("x"), temp_cwd("y"));
    let (from_dir, to_dir) = (projects.join(claude_slug(&x)), projects.join(claude_slug(&y)));
    let _cleanup = Cleanup { remove: vec![from_dir.clone(), to_dir.clone(), x.clone(), y.clone()], restore: None };
    let secret = word("PELICAN");

    let first = run(&claude, &x, &["-p", "--model", "haiku", "--output-format", "json", &format!("Remember the word {secret}. Reply OK.")]);
    let first: serde_json::Value = serde_json::from_str(first.trim()).expect("JSON result");
    let id = first["session_id"].as_str().expect("session_id").to_string();
    let source = from_dir.join(format!("{id}.jsonl"));
    assert!(source.is_file(), "no transcript at {}", source.display());
    std::fs::create_dir_all(&to_dir).unwrap();
    std::fs::rename(&source, to_dir.join(format!("{id}.jsonl"))).unwrap();
    let _ = std::fs::remove_dir_all(&from_dir);

    let second = run(&claude, &y, &["-p", "--model", "haiku", "--output-format", "json", "--resume", &id, "What word did I ask you to remember? Reply with just the word."]);
    let second: serde_json::Value = serde_json::from_str(second.trim()).expect("JSON result");
    let reply = second["result"].as_str().unwrap_or_default();
    println!("RESUMED REPLY: {reply}");
    assert!(reply.contains(&secret), "Claude did not recall {secret}: {reply}");
}

/// Codex's rollout file for a thread id, searched under `sessions/`.
fn codex_rollout(dir: &Path, id: &str) -> Option<PathBuf> {
    let suffix = format!("-{id}.jsonl");
    let mut stack = vec![dir.to_path_buf()];
    while let Some(folder) = stack.pop() {
        for entry in std::fs::read_dir(&folder).ok()?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if entry.file_name().to_string_lossy().ends_with(&suffix) {
                return Some(path);
            }
        }
    }
    None
}

/// The thread id and the agent's final text from `codex exec --json` events.
fn codex_events(stdout: &str) -> (Option<String>, String) {
    let mut thread = None;
    let mut text = String::new();
    for event in stdout.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()) {
        if let Some(id) = event["thread_id"].as_str() {
            thread = Some(id.to_string());
        }
        if event["type"] == "item.completed" && event["item"]["type"] == "agent_message" {
            text.push_str(event["item"]["text"].as_str().unwrap_or_default());
        }
    }
    (thread, text)
}

// ponytail: model is a fixed cheap slug from the local models cache; change it when the catalog moves.
const CODEX_MODEL: &str = "gpt-5.6-luna";

#[test]
#[ignore = "live: sends two tiny prompts with the user's Codex login"]
fn codex_resumes_a_rollout_found_by_scanning() {
    let Some(codex) = super::executable("codex") else {
        eprintln!("skipped: Codex is not installed");
        return;
    };
    let sessions = std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".codex")).join("sessions");
    let cwd = temp_cwd("codex");
    let mut cleanup = Cleanup { remove: vec![cwd.clone()], restore: None };
    let secret = word("HERON");
    let base = ["exec", "--skip-git-repo-check", "-m", CODEX_MODEL, "-c", "model_reasoning_effort=\"low\"", "--json"];

    let prompt = format!("Remember the word {secret}. Reply OK.");
    let first = run(&codex, &cwd, &[&base[..], &[&prompt]].concat());
    let id = codex_events(&first).0.expect("thread id");
    let rollout = codex_rollout(&sessions, &id).expect("rollout file");
    let stale = sessions.join("2020/01/01");
    let created = !stale.exists();
    std::fs::create_dir_all(&stale).unwrap();
    let moved = stale.join(rollout.file_name().unwrap());
    std::fs::rename(&rollout, &moved).unwrap();
    println!("moved {} -> {}", rollout.display(), moved.display());
    cleanup.restore = Some((moved, rollout));
    if created {
        cleanup.remove.push(sessions.join("2020"));
    }

    let ask = "What word did I ask you to remember? Reply with just the word.";
    let second = run(&codex, &cwd, &["exec", "resume", "--skip-git-repo-check", "-m", CODEX_MODEL, "-c", "model_reasoning_effort=\"low\"", "--json", &id, ask]);
    let reply = codex_events(&second).1;
    println!("RESUMED REPLY: {reply}");
    assert!(reply.contains(&secret), "Codex did not recall {secret}: {reply}");
}
