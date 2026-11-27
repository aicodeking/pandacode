//! "Export debug session": one Markdown bundle with the task header, failures, tool calls,
//! changed files and the conversation. Every value is redacted before it is clipped or written,
//! and the whole bundle is bounded by [`LIMIT`].
use crate::{storage::Store, Result};
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

/// Refuse anything larger than this, like the plain task export.
const LIMIT: usize = 8 * 1024 * 1024;
/// How much of a tool's input the bundle keeps, after redaction.
const INPUT_CLIP: usize = 500;
/// How much of a tool's output the bundle keeps, after redaction.
const OUTPUT_CLIP: usize = 4000;
/// At most this many changed paths are listed.
const FILE_CAP: usize = 200;

pub(crate) struct Options {
    pub note: Option<String>,
    pub include_output: bool,
    pub include_changes: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            note: None,
            include_output: true,
            include_changes: true,
        }
    }
}

/// One `role='tool'` row parsed from its `tool_activity` JSON.
#[derive(Clone, Debug, PartialEq)]
struct ToolCall {
    name: String,
    status: String,
    input: String,
    output: String,
}

impl ToolCall {
    fn failed(&self) -> bool {
        self.status == "failed"
    }

    fn running(&self) -> bool {
        self.status == "running"
    }

    /// Output when there is one, else the input, else the status itself.
    fn problem_text(&self) -> String {
        if !self.output.trim().is_empty() {
            first_line(&self.output)
        } else if !self.input.trim().is_empty() {
            first_line(&self.input)
        } else {
            clean(&self.status)
        }
    }
}

/// Everything `render` needs, already collected from SQL so the rendering is testable alone.
#[derive(Default)]
struct Parts {
    title: String,
    /// Ordered `(key, value)` header lines.
    meta: Vec<(String, String)>,
    /// Raw `role='error'` bodies.
    errors: Vec<String>,
    tools: Vec<ToolCall>,
    /// Deduped changed paths, already capped at [`FILE_CAP`].
    files: Vec<String>,
    /// Paths beyond the cap.
    more_files: usize,
    /// Projected `(role, content)` pairs for the transcript.
    conversation: Vec<(String, String)>,
    task_running: bool,
}

/// Builds the debug bundle for one saved task. The store is locked by the caller.
pub(crate) fn build(store: &Store, session_id: &str, options: &Options) -> Result<String> {
    let task = store.session(session_id)?;
    let project = store.project(&task.project_id).ok();
    let folder = task
        .worktree_path
        .as_deref()
        .and_then(folder_name)
        .or_else(|| project.as_ref().and_then(|p| folder_name(&p.path)))
        .unwrap_or_else(|| "unknown".into());
    let task_running = matches!(task.status.as_str(), "running" | "waiting");
    let meta = vec![
        ("pandacode".into(), env!("CARGO_PKG_VERSION").into()),
        ("platform".into(), std::env::consts::OS.into()),
        ("architecture".into(), std::env::consts::ARCH.into()),
        ("harness".into(), task.provider.clone()),
        ("model".into(), task.model.clone()),
        (
            "reasoning effort".into(),
            task.reasoning_effort
                .clone()
                .unwrap_or_else(|| "default".into()),
        ),
        ("status".into(), task.status.clone()),
        ("created".into(), stamp(task.created_at)),
        ("updated".into(), stamp(task.updated_at)),
        ("project".into(), folder),
    ];
    let mut parts = Parts {
        title: task.title.clone(),
        meta,
        task_running,
        ..Parts::default()
    };

    let mut query = store
        .db
        .prepare("SELECT id,role,content FROM messages WHERE session_id=?1 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([session_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, role, content) = row.map_err(|e| e.to_string())?;
        if role == "tool" {
            if let Some(tool) = parse_tool(&content) {
                parts.tools.push(tool);
                // Never repeat the raw activity envelope in the transcript.
                continue;
            }
        }
        if role == "error" {
            parts.errors.push(content.clone());
        }
        let (role, content, _) = crate::architect::internal_turns::project_text(
            store,
            session_id,
            id,
            &role,
            &content,
        )?;
        parts.conversation.push((role, content));
    }

    let mut changes = store
        .db
        .prepare(
            "SELECT f.path FROM turn_changes t JOIN turn_change_files f ON f.change_id=t.id
             WHERE t.session_id=?1 ORDER BY t.message_id,f.path",
        )
        .map_err(|e| e.to_string())?;
    let paths = changes
        .query_map([session_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut seen = HashSet::new();
    for path in paths {
        let path = path.map_err(|e| e.to_string())?;
        if !seen.insert(path.clone()) {
            continue;
        }
        if parts.files.len() < FILE_CAP {
            parts.files.push(path);
        } else {
            parts.more_files += 1;
        }
    }

    render(&parts, options)
}

/// Pure rendering: no SQL, no filesystem. Every inserted string is redacted first.
fn render(parts: &Parts, options: &Options) -> Result<String> {
    let mut out = String::new();
    push(&mut out, &format!("# Debug: {}\n\n", clean(&parts.title)))?;
    for (key, value) in &parts.meta {
        push(&mut out, &format!("{}: {}\n", clean(key), clean(value)))?;
    }
    push(&mut out, "\n")?;

    let note = options
        .note
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    let error_lines: Vec<String> = parts
        .errors
        .iter()
        .map(|e| first_line(e))
        .filter(|line| !line.is_empty())
        .collect();
    let tool_failures: Vec<String> = parts
        .tools
        .iter()
        .filter(|t| t.failed() || (t.running() && !parts.task_running))
        .map(|t| format!("{}: {}", clean(&t.name), t.problem_text()))
        .collect();
    if note.is_some() || !error_lines.is_empty() || !tool_failures.is_empty() {
        push(&mut out, "## What went wrong\n\n")?;
        if let Some(note) = note {
            push(&mut out, &format!("{}\n\n", clean(note)))?;
        }
        for line in &error_lines {
            push(&mut out, &format!("- error: {line}\n"))?;
        }
        for line in &tool_failures {
            push(&mut out, &format!("- {line}\n"))?;
        }
        push(&mut out, "\n")?;
    }

    if options.include_output && !parts.tools.is_empty() {
        push(&mut out, "## Tool calls\n\n")?;
        for tool in &parts.tools {
            push(
                &mut out,
                &format!("### {} — {}\n\n", clean(&tool.name), clean(&tool.status)),
            )?;
            if !tool.input.trim().is_empty() {
                push(&mut out, "input:\n\n````text\n")?;
                push(&mut out, &clip(&tool.input, INPUT_CLIP))?;
                push(&mut out, "\n````\n\n")?;
            }
            if !tool.output.trim().is_empty() {
                push(&mut out, "output:\n\n````text\n")?;
                push(&mut out, &clip(&tool.output, OUTPUT_CLIP))?;
                push(&mut out, "\n````\n\n")?;
            }
        }
    }

    if options.include_changes && (!parts.files.is_empty() || parts.more_files > 0) {
        push(&mut out, "## Files changed\n\n")?;
        for file in &parts.files {
            push(&mut out, &format!("- {}\n", clean(file)))?;
        }
        if parts.more_files > 0 {
            push(
                &mut out,
                &format!("… and {} more\n", parts.more_files),
            )?;
        }
        push(&mut out, "\n")?;
    }

    if !parts.conversation.is_empty() {
        push(&mut out, "## Conversation\n\n")?;
        // One level below the sections: a `## role` line would read as another section.
        for (role, content) in &parts.conversation {
            push(
                &mut out,
                &format!("### {}\n\n{}\n\n", clean(role), clean(content)),
            )?;
        }
    }

    // A last pass covers anything the row-level clean calls could have joined together.
    let out = crate::remote::diagnostics::redact_text(&out);
    if out.len() > LIMIT {
        return Err("This debug bundle exceeds the 8 MiB export limit.".into());
    }
    Ok(out)
}

/// Appends, keeping the whole bundle under [`LIMIT`].
fn push(out: &mut String, text: &str) -> Result<()> {
    if out.len() + text.len() > LIMIT {
        return Err("This debug bundle exceeds the 8 MiB export limit.".into());
    }
    out.push_str(text);
    Ok(())
}

fn clean(text: &str) -> String {
    crate::remote::diagnostics::redact_text(text)
}

/// Redacts before clipping, never after.
fn clip(text: &str, max: usize) -> String {
    clip_chars(&clean(text), max)
}

fn clip_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

fn first_line(text: &str) -> String {
    let cleaned = clean(text);
    let line = cleaned
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim();
    clip_chars(line, INPUT_CLIP)
}

fn folder_name(path: &str) -> Option<String> {
    Path::new(path.trim_end_matches(['/', '\\']))
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
}

fn stamp(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|| ms.to_string())
}

/// Parses a `role='tool'` row, returning `None` for anything that is not a v1 tool activity.
fn parse_tool(content: &str) -> Option<ToolCall> {
    let value: Value = serde_json::from_str(content).ok()?;
    if value.get("type")?.as_str()? != "tool_activity" || value.get("version")?.as_i64()? != 1 {
        return None;
    }
    Some(ToolCall {
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_owned(),
        status: value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned(),
        input: stringify(value.get("input")),
        output: stringify(value.get("output")),
    })
}

fn stringify(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(title: &str) -> Parts {
        Parts {
            title: title.into(),
            ..Parts::default()
        }
    }

    fn tool(name: &str, status: &str, input: &str, output: &str) -> ToolCall {
        ToolCall {
            name: name.into(),
            status: status.into(),
            input: input.into(),
            output: output.into(),
        }
    }

    fn section<'a>(out: &'a str, heading: &str) -> &'a str {
        let start = out.find(heading).expect("section exists");
        let rest = &out[start + heading.len()..];
        match rest.find("\n## ") {
            Some(end) => &rest[..end],
            None => rest,
        }
    }

    #[test]
    fn redacts_secrets_in_tool_output_before_clipping() {
        let mut parts = parts("Secret test");
        parts.tools.push(tool(
            "bash",
            "completed",
            "",
            "token ghp_abcdefghijklmnopqrstuvwx sk-abcdefghijklmnopqrstuvwx \
             eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl",
        ));
        let out = render(&parts, &Options::default()).unwrap();
        assert!(out.contains("### bash — completed"), "{out}");
        for secret in [
            "ghp_abcdefghijklmnopqrstuvwx",
            "sk-abcdefghijklmnopqrstuvwx",
            "eyJhbGciOiJIUzI1NiJ9",
        ] {
            assert!(!out.contains(secret), "{secret} leaked: {out}");
        }
    }

    #[test]
    fn failed_tools_are_problems_but_running_ones_are_not_while_the_task_runs() {
        let mut parts = parts("Failures");
        parts.task_running = true;
        parts.tools.push(tool("grep", "failed", "", "no matches\nsecond line"));
        parts.tools.push(tool("sleep", "running", "", "still going"));
        let out = render(&parts, &Options::default()).unwrap();
        let problems = section(&out, "## What went wrong");
        assert!(problems.contains("- grep: no matches"), "{problems}");
        assert!(!problems.contains("sleep"), "{problems}");
        // A running tool on a stopped task is a problem too.
        parts.task_running = false;
        let stopped = render(&parts, &Options::default()).unwrap();
        assert!(
            section(&stopped, "## What went wrong").contains("- sleep: still going"),
            "{stopped}"
        );
    }

    #[test]
    fn tool_rows_render_by_name_and_never_as_raw_json() {
        let raw = r#"{"type":"tool_activity","version":1,"id":"t1","name":"read_file","status":"completed","input":{"path":"src/lib.rs"},"output":"done"}"#;
        let mut parts = parts("Tools");
        parts.tools.push(parse_tool(raw).expect("a v1 tool activity parses"));
        let out = render(&parts, &Options::default()).unwrap();
        assert!(out.contains("### read_file — completed"), "{out}");
        assert!(!out.contains("tool_activity"), "{out}");
        assert!(out.contains("````text"), "{out}");
    }

    #[test]
    fn include_flags_omit_sections() {
        let mut parts = parts("Flags");
        parts.tools.push(tool("bash", "completed", "echo hi", "hi"));
        parts.files.push("src/lib.rs".into());
        let out = render(
            &parts,
            &Options {
                note: None,
                include_output: false,
                include_changes: false,
            },
        )
        .unwrap();
        assert!(!out.contains("## Tool calls"), "{out}");
        assert!(!out.contains("## Files changed"), "{out}");
        let full = render(&parts, &Options::default()).unwrap();
        assert!(full.contains("## Tool calls") && full.contains("## Files changed"));
    }

    #[test]
    fn absolute_paths_never_appear_verbatim() {
        let mut parts = parts("Paths");
        parts.tools.push(tool(
            "edit",
            "completed",
            "writing /Users/someone/project/src/main.rs",
            "",
        ));
        parts.conversation.push((
            "assistant".into(),
            "Saved /Volumes/Storage/Development/secret/file.rs".into(),
        ));
        let out = render(&parts, &Options::default()).unwrap();
        for leaked in [
            "/Users/someone/project/src/main.rs",
            "/Volumes/Storage/Development/secret/file.rs",
        ] {
            assert!(!out.contains(leaked), "{leaked} leaked: {out}");
        }
        assert!(out.contains("[path]"), "{out}");
    }

    #[test]
    fn note_leads_the_problems_and_the_section_is_omitted_when_empty() {
        let mut failed = parts("Note");
        failed.errors.push("the harness stopped\nline two".into());
        let out = render(
            &failed,
            &Options {
                note: Some("It failed after the edit".into()),
                ..Options::default()
            },
        )
        .unwrap();
        let problems = section(&out, "## What went wrong");
        let note_at = problems.find("It failed after the edit").unwrap();
        let error_at = problems.find("- error: the harness stopped").unwrap();
        assert!(note_at < error_at, "{problems}");
        assert!(!problems.contains("line two"), "{problems}");

        let clean_parts = parts("Note");
        assert!(!render(&clean_parts, &Options::default())
            .unwrap()
            .contains("## What went wrong"));
    }

    #[test]
    fn files_are_capped_with_an_overflow_line() {
        let mut files = parts("Files");
        for n in 0..FILE_CAP {
            files.files.push(format!("src/file{n}.rs"));
        }
        files.more_files = 5;
        let out = render(&files, &Options::default()).unwrap();
        let files = section(&out, "## Files changed");
        assert_eq!(files.matches("- src/file").count(), FILE_CAP, "{files}");
        assert!(files.contains("… and 5 more"), "{files}");
    }

    #[test]
    fn non_tool_rows_stay_in_the_conversation() {
        assert!(parse_tool("Later activity").is_none());
        assert!(parse_tool(r#"{"type":"notice","version":1}"#).is_none());
        assert!(parse_tool(
            r#"{"type":"tool_activity","version":2,"name":"bash","status":"completed"}"#
        )
        .is_none());
    }

    #[test]
    fn conversation_roles_sit_below_the_section_headings() {
        let mut parts = parts("Levels");
        parts.conversation.push(("user".into(), "fix it".into()));
        parts.conversation.push(("assistant".into(), "on it".into()));
        let out = render(&parts, &Options::default()).unwrap();
        // `## role` would read as another section; roles are one level below.
        assert!(out.contains("## Conversation"), "{out}");
        assert!(out.contains("### user"), "{out}");
        assert!(out.contains("### assistant"), "{out}");
        assert!(!out.contains("\n## user"), "{out}");
    }
}
