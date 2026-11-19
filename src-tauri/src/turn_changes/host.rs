//! Explicit boundaries for shell/script writes that provider events cannot name.
use super::*;
use crate::providers::{ToolActivity, ToolHost};
use serde_json::{json, Value};

pub(crate) const TOOL: &str = "pandacode_track_files";

/// Whether a run's native edit tools wait for the user's approval before writing. A native
/// edit's baseline is taken when its tool event reaches PandaCode, which only a waiting edit
/// guarantees happens before the write: Claude-family harnesses in Standard mode (they ask
/// through PandaCode's permission prompt). Accept edits, Claude's auto review, Plan (whose
/// accepted plan continues without asking) and Full access never wait, nor does Codex (it
/// applies workspace edits in Standard too); other harnesses are treated as never waiting.
/// A user's own Claude Code allow rule for Edit/Write also skips the wait: `edits_wait_for_run`
/// checks for one before relying on this.
pub(crate) fn edits_wait_for_approval(provider: &str, mode: &str) -> bool {
    // Only Standard ("ask", launched as Claude's `default`) waits; every other mode, and any
    // mode this list does not know, is treated as never waiting (the handshake covers it).
    crate::providers::claude_family(provider) && mode == "ask"
}

/// `edits_wait_for_approval` for a run, unless the user's Claude Code settings may let its edits
/// through without asking (`claude_allows_edits`): then the full begin/complete handshake is
/// used for native edits too. Reads a few small settings files on each launch.
pub(crate) fn edits_wait_for_run(config: &crate::providers::RunConfig) -> bool {
    edits_wait_for_approval(&config.provider, &config.mode) && !claude_allows_edits(config)
}

/// Whether Claude Code may apply this run's edits without asking. GLM, MiMo and Alibaba launch
/// with `--setting-sources ""`, so no settings file applies to them. A task on a named connection
/// may use another Claude config folder, which is not followed: treated as allowing.
fn claude_allows_edits(config: &crate::providers::RunConfig) -> bool {
    if config.provider != "claude" {
        return false;
    }
    if crate::connections::for_task(&config.session_id, &config.provider).is_some() {
        return true;
    }
    if managed_settings_may_allow(MANAGED_SETTINGS.map(std::path::Path::new)) {
        return true;
    }
    match crate::agent_usage::claude_config_dir() {
        Some(dir) => edit_allow_rules(&dir, &config.cwd),
        None => true,
    }
}

/// Claude Code's managed (enterprise) policy file, which takes precedence over every other
/// settings file and may allow edits or set a permissive default mode.
#[cfg(target_os = "macos")]
const MANAGED_SETTINGS: Option<&str> = Some("/Library/Application Support/ClaudeCode/managed-settings.json");
#[cfg(target_os = "linux")]
const MANAGED_SETTINGS: Option<&str> = Some("/etc/claude-code/managed-settings.json");
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const MANAGED_SETTINGS: Option<&str> = None;

/// Whether a managed policy file may let edits through: any file there (or one whose presence
/// cannot be checked) counts, without parsing it, so the approval wait is only relied on when
/// no policy exists. ponytail: presence only; parse it like `file_allows_edits` if managed
/// installs that forbid edit rules become common.
fn managed_settings_may_allow(path: Option<&std::path::Path>) -> bool {
    match path.map(std::fs::symlink_metadata) {
        None => false,
        Some(Ok(_)) => true,
        Some(Err(error)) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

/// Settings files larger than this are not parsed (treated as holding an allow rule).
const SETTINGS_LIMIT: u64 = 256 * 1024;
/// The settings files Claude Code reads in its config folder and in a project's `.claude`.
const SETTINGS_FILES: [&str; 2] = ["settings.json", "settings.local.json"];
/// Claude Code's native edit tools: an allow rule for any of them, with or without a path
/// specifier (`Edit`, `Write(src/**)`, `Edit(*)`), lets some edits through unasked.
const EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// Best-effort, read-only check for an allow rule that lets native edits through without
/// asking, in `config_dir`'s and `project`'s `.claude` settings files (`permissions.allow`, or a
/// `permissions.defaultMode` other than `default`). Any unreadable, oversized or unexpected file
/// counts as holding one, so the wait is never relied on by mistake. Managed (enterprise)
/// settings are checked separately (`managed_settings_may_allow`). Limits: `--settings` flags, parent folders of `project` and the user's
/// environment are not read, so a rule there still lets a write beat its baseline; the
/// tracker then marks the turn partial. Nothing from a file's contents is ever logged.
pub(crate) fn edit_allow_rules(config_dir: &std::path::Path, project: &std::path::Path) -> bool {
    let project = project.join(".claude");
    let files = SETTINGS_FILES.iter().map(|name| config_dir.join(name)).chain(SETTINGS_FILES.iter().map(|name| project.join(name)));
    // Every file is checked, so each unreadable one is reported.
    files.map(|path| file_allows_edits(&path)).fold(false, |found, allows| found | allows)
}

fn file_allows_edits(path: &std::path::Path) -> bool {
    match read_settings(path) {
        Ok(None) => false,
        Ok(Some(settings)) => settings_allow_edits(&settings),
        Err(reason) => {
            eprintln!("PandaCode: a Claude Code settings file could not be checked for edit allow rules ({reason}); native edits use the tracking handshake.");
            true
        }
    }
}

/// The parsed file, `None` when it does not exist, or why it could not be read.
fn read_settings(path: &std::path::Path) -> std::result::Result<Option<Value>, &'static str> {
    use std::io::Read;
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("unreadable"),
    };
    if !meta.is_file() {
        return Err("not a file");
    }
    if meta.len() > SETTINGS_LIMIT {
        return Err("too large");
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path).and_then(|file| file.take(SETTINGS_LIMIT + 1).read_to_end(&mut bytes)).map_err(|_| "unreadable")?;
    if bytes.len() as u64 > SETTINGS_LIMIT {
        return Err("too large");
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| "not JSON")
}

/// Whether parsed settings may let an edit through unasked; any unexpected shape does.
fn settings_allow_edits(settings: &Value) -> bool {
    let Some(settings) = settings.as_object() else { return true };
    let Some(permissions) = settings.get("permissions") else { return false };
    let Some(permissions) = permissions.as_object() else { return true };
    if permissions.get("defaultMode").is_some_and(|mode| mode.as_str() != Some("default")) {
        return true;
    }
    match permissions.get("allow") {
        None => false,
        Some(Value::Array(rules)) => rules.iter().any(|rule| rule.as_str().is_none_or(edit_rule)),
        Some(_) => true,
    }
}

/// `Edit`, `Write(src/**)`, `*` …: a rule naming an edit tool (or every tool).
fn edit_rule(rule: &str) -> bool {
    let tool = rule.split('(').next().unwrap_or_default().trim();
    tool == "*" || EDIT_TOOLS.contains(&tool)
}

/// The tracking instruction, the same for every run: every edit batch, native tools included,
/// begins a capture first, which is correct whether or not native edits wait for approval.
/// It is part of the cached app instructions (Claude's `--append-system-prompt`), so it must
/// not depend on the run's mode, allow rules or connection: a different prefix would make the
/// harness rewrite the whole history's cache. Runs whose native edits wait for approval learn
/// from `turn_note` in the turn's own message that they may skip the native-edit handshake.
pub(crate) fn instruction() -> &'static str {
    "\n\nFile change tracking: when pandacode_track_files is available, before any file-edit batch (native editing tools, shell commands, or scripts), call pandacode_track_files with action begin and the exact project-relative paths you intend to modify (include both paths for a rename). After that batch finishes, call action complete with the returned captureId and only the paths you actually changed. Do not report files changed by other tasks or the user, and do not use Git status as ownership evidence. Always begin the capture before editing and await its result; provider notifications alone may arrive after a fast write."
}

/// One line added to the turn's message when `edits_wait` (`edits_wait_for_run`, for a run that
/// lists the tracking tool): native edit tools wait for approval, so their baseline is taken in
/// time and only shell or script edits need the handshake. In the message, not the cached
/// system prompt, so switching modes never rewrites the cache.
pub(crate) fn turn_note(edits_wait: bool) -> Option<&'static str> {
    edits_wait.then_some(EDITS_NOTE)
}

const EDITS_NOTE: &str = "\n\n(This turn your native edit tools are tracked automatically: call pandacode_track_files begin/complete only around shell commands or scripts that edit files.)";

/// Keep the catalog stable across resumed turns; control-only turns have no tracker.
pub(crate) fn with_host(
    base: Option<ToolHost>,
    tracker: Option<Arc<Mutex<Tracker>>>,
    stopped: Arc<AtomicBool>,
) -> ToolHost {
    let mut tools = base
        .as_ref()
        .map_or_else(Vec::new, |host| host.tools.clone());
    tools.push(json!({"type":"function","name":TOOL,
        "description":"Track this task's file edits (shell commands and scripts, and native edit tools unless the turn's message says they are tracked automatically). Before writing, begin a capture of exact project-relative paths; after, complete that capture with only paths actually changed. Does not edit files or authorize writes. Include source and destination of a rename. Do not report other tasks' or user edits.",
        "inputSchema":{"type":"object","properties":{
            "action":{"type":"string","enum":["begin","complete"]},
            "paths":{"type":"array","items":{"type":"string","minLength":1,"maxLength":4096},"maxItems":200},
            "captureId":{"type":"string","maxLength":256}},"required":["action","paths"],"additionalProperties":false}}));
    ToolHost {
        tools,
        approval_tools: base
            .as_ref()
            .map_or_else(Default::default, |host| host.approval_tools.clone()),
        handler: Arc::new(move |name, args| {
            let (base, tracker, stopped) = (base.clone(), tracker.clone(), stopped.clone());
            Box::pin(async move {
                if stopped.load(Ordering::SeqCst) {
                    return Err("Task has stopped.".into());
                }
                if name != TOOL {
                    return match base {
                        Some(base) => (base.handler)(name, args).await,
                        None => Err("Unknown PandaCode tool.".into()),
                    };
                }
                let tracker = tracker.ok_or("No file tracking is active for this turn.")?;
                tauri::async_runtime::spawn_blocking(move || {
                    if stopped.load(Ordering::SeqCst) {
                        return Err("Task has stopped.".into());
                    }
                    tracker
                        .lock()
                        .map_err(|_| "File tracking is unavailable.".to_string())?
                        .report(args)
                })
                .await
                .map_err(|_| "File tracking could not complete.".to_string())?
            })
        }),
    }
}

impl Tracker {
    fn report(&mut self, args: Value) -> Result<Value> {
        if !self.dirty_since_boundary {
            return Err("This turn has already completed.".into());
        }
        let paths = args["paths"]
            .as_array()
            .ok_or("Provide exact project-relative paths.")?;
        if paths.len() > CHANGE_FILES {
            return Err("Report at most 200 paths per batch.".into());
        }
        let paths: Vec<String> = paths.iter().map(|path| {
            let path = path.as_str().filter(|p| safe_relative(p)).ok_or("Every path must be relative to this task's folder, without parent traversal or .git.")?;
            self.relative_path(path).ok_or_else(|| "Every path must be relative to this task's folder, without parent traversal or .git.".to_string())
        }).collect::<Result<_>>()?;
        let action = args["action"].as_str().ok_or("Choose begin or complete.")?;
        let id = match action {
            "begin" if !paths.is_empty() => format!("reported:{}", storage::id()),
            "complete" => {
                let id = args["captureId"]
                    .as_str()
                    .filter(|id| id.starts_with("reported:"))
                    .ok_or("Provide this batch's captureId.")?;
                let pending = self
                    .pending
                    .get(id)
                    .ok_or("This capture is unavailable or already completed.")?;
                if paths.iter().any(|path| !pending.known.contains(path)) {
                    return Err("A completed path was not included when this batch began.".into());
                }
                id.to_string()
            }
            _ => return Err("Begin requires at least one path; choose begin or complete.".into()),
        };
        self.observe_tool(
            &id,
            &ToolActivity {
                id: id.clone(),
                name: TOOL.into(),
                status: if action == "begin" {
                    "running"
                } else {
                    "completed"
                }
                .into(),
                input: String::new(),
                output: String::new(),
                write_paths: Some(paths.clone()),
            },
        );
        if action == "begin"
            && !self.pending.get(&id).is_some_and(|pending| {
                paths
                    .iter()
                    .all(|path| pending.entries.contains_key(path) || pending.absent.contains(path))
            })
        {
            self.pending.remove(&id);
            return Err(
                "A baseline could not be captured for every path; this batch cannot be tracked."
                    .into(),
            );
        }
        Ok(json!({"captureId":id,"status":if action == "begin" {"started"} else {"completed"}}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_reported_path_spelling(begin_path: &str, complete_path: &str) {
        let f = crate::turn_changes::tests::Fixture::new(false);
        f.write("src/ours.txt", "before batch\n");
        let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
        let begun = tracker
            .report(json!({"action":"begin","paths":[begin_path]}))
            .unwrap();
        f.write("src/ours.txt", "before batch\nour edit\n");
        tracker
            .report(json!({"action":"complete","captureId":begun["captureId"],"paths":[complete_path]}))
            .unwrap();
        let captured = tracker.finish().unwrap();
        assert_eq!(captured.summary.files.len(), 1);
        assert_eq!(captured.summary.files[0].path, "src/ours.txt");
        assert_eq!((captured.summary.additions, captured.summary.deletions), (1, 0));
        assert!(!captured.summary.truncated);
        assert!(captured.details[0].patch.contains("+our edit"));
    }

    #[test]
    fn reported_paths_normalize_repeated_separators_at_begin_and_complete() {
        for (begin, complete) in [
            ("src//ours.txt", "src/ours.txt"),
            ("src/ours.txt", "src//ours.txt"),
            ("src//ours.txt", "src//ours.txt"),
        ] {
            assert_reported_path_spelling(begin, complete);
        }
    }

    #[cfg(windows)]
    #[test]
    fn reported_windows_paths_normalize_backslashes_at_begin_and_complete() {
        for (begin, complete) in [
            (r"src\ours.txt", "src/ours.txt"),
            ("src/ours.txt", r"src\ours.txt"),
            (r"src\ours.txt", r"src\ours.txt"),
        ] {
            assert_reported_path_spelling(begin, complete);
        }
    }

    #[tokio::test]
    async fn reported_shell_batch_is_scoped_frozen_and_cannot_be_reused_by_another_task() {
        let f = crate::turn_changes::tests::Fixture::new(false);
        f.write("ours.txt", "dirty before batch\n");
        let tracker = Arc::new(Mutex::new(Tracker::start(f.root.clone(), f.cache.clone())));
        let stopped = Arc::new(AtomicBool::new(false));
        let host = with_host(None, Some(tracker.clone()), stopped.clone());
        let begun = (host.handler)(TOOL.into(), json!({"action":"begin","paths":["ours.txt"]}))
            .await
            .unwrap();
        // A native edit within an acknowledged batch must not replace its
        // earlier baseline, even if the notification arrives after the write.
        f.write("ours.txt", "dirty before batch\nour script edit\n");
        let native = ToolActivity {
            id: "native".into(),
            name: "Write".into(),
            status: "running".into(),
            input: String::new(),
            output: String::new(),
            write_paths: Some(vec!["ours.txt".into()]),
        };
        tracker.lock().unwrap().observe_tool("native", &native);
        tracker.lock().unwrap().observe_tool(
            "native",
            &ToolActivity {
                status: "completed".into(),
                ..native
            },
        );
        f.write("external.txt", "someone else\n");
        let other = with_host(
            None,
            Some(Arc::new(Mutex::new(Tracker::start(
                f.root.clone(),
                f.cache.clone(),
            )))),
            stopped.clone(),
        );
        let completed =
            json!({"action":"complete","captureId":begun["captureId"],"paths":["ours.txt"]});
        assert!((other.handler)(TOOL.into(), completed.clone())
            .await
            .is_err());
        assert!((host.handler)(
            TOOL.into(),
            json!({"action":"complete","captureId":begun["captureId"],"paths":["external.txt"]})
        )
        .await
        .is_err());
        (host.handler)(TOOL.into(), completed.clone())
            .await
            .unwrap();
        assert!((host.handler)(TOOL.into(), completed).await.is_err());
        f.write("ours.txt", "later editor change\n");
        let captured = tracker.lock().unwrap().finish().unwrap();
        assert_eq!(captured.summary.files.len(), 1);
        assert_eq!(captured.summary.files[0].path, "ours.txt");
        assert_eq!(
            (captured.summary.additions, captured.summary.deletions),
            (1, 0)
        );
        assert!(captured.details[0].patch.contains("+our script edit"));
        assert!(!captured.details[0].patch.contains("later editor change"));
    }

    #[tokio::test]
    async fn report_tool_rejects_traversal_and_stopped_tasks_and_preserves_base_tools() {
        let f = crate::turn_changes::tests::Fixture::new(false);
        let tracker = Arc::new(Mutex::new(Tracker::start(f.root.clone(), f.cache.clone())));
        let stopped = Arc::new(AtomicBool::new(false));
        let base = ToolHost {
            tools: vec![],
            approval_tools: ["other".into()].into(),
            handler: Arc::new(|name, args| {
                Box::pin(async move { Ok(json!({"name":name,"args":args})) })
            }),
        };
        let host = with_host(Some(base), Some(tracker), stopped.clone());
        assert!(host.approval_tools.contains("other"));
        assert_eq!(
            (host.handler)("other".into(), json!({"hello":true}))
                .await
                .unwrap()["args"]["hello"],
            true
        );
        for path in ["../outside", "src/../outside", ".git/config", ".GIT/config", "src//.git/config", "/tmp/absolute"] {
            assert!(
                (host.handler)(TOOL.into(), json!({"action":"begin","paths":[path]}))
                    .await
                    .is_err()
            );
        }
        stopped.store(true, Ordering::SeqCst);
        assert!(
            (host.handler)(TOOL.into(), json!({"action":"begin","paths":["file.txt"]}))
                .await
                .is_err()
        );
    }

    fn native(id: &str, status: &str, paths: &[&str]) -> ToolActivity {
        ToolActivity {
            id: id.into(),
            name: "Edit".into(),
            status: status.into(),
            input: String::new(),
            output: String::new(),
            write_paths: Some(paths.iter().map(|p| (*p).into()).collect()),
        }
    }

    #[test]
    fn only_claude_standard_runs_wait_for_an_edit_approval() {
        // Standard is saved as "ask" (`storage::valid_mode`); Claude launches it as `default`.
        for provider in ["claude", "glm", "mimo", "alibaba"] {
            assert!(edits_wait_for_approval(provider, "ask"), "{provider}");
            for mode in ["auto", "review", "plan", "full"] {
                assert!(!edits_wait_for_approval(provider, mode), "{provider} {mode}");
            }
            // Only a mode known to wait counts: an unknown or empty one never does.
            for mode in ["standard", "default", ""] {
                assert!(!edits_wait_for_approval(provider, mode), "{provider} {mode:?}");
            }
        }
        // Codex applies workspace edits without asking even in Standard; ACP agents vary.
        for provider in ["codex", "kimi", "opencode", "pi", "grok", "devin", "zcode"] {
            assert!(!edits_wait_for_approval(provider, "ask"), "{provider}");
        }
    }

    #[test]
    fn instruction_is_one_wording_and_only_waiting_turns_get_the_note() {
        // The cached instruction always asks for the handshake around native edits too: correct
        // in Accept edits / Full access, where a write can land before its event arrives.
        let text = instruction();
        assert!(text.starts_with("\n\nFile change tracking:"));
        assert!(text.contains("native editing tools, shell commands, or scripts"));
        assert!(text.contains("captureId") && text.contains("begin") && text.contains("complete"));
        assert!(!text.contains("tracked automatically"));
        // Standard approvals: the turn's message says native edits are tracked automatically.
        for provider in ["claude", "glm", "mimo", "alibaba", "codex", "kimi", "opencode"] {
            for mode in ["ask", "auto", "review", "plan", "full"] {
                let note = turn_note(edits_wait_for_approval(provider, mode));
                let waits = matches!(provider, "claude" | "glm" | "mimo" | "alibaba") && mode == "ask";
                assert_eq!(note.is_some(), waits, "{provider} {mode}");
            }
        }
        let note = turn_note(true).unwrap();
        assert!(note.contains("tracked automatically") && note.contains("shell commands or scripts") && note.contains("pandacode_track_files"));
        assert!(note.starts_with("\n\n") && !note.trim().contains('\n'), "one line");
        assert!(note.len() < 200, "{} B", note.len());
        eprintln!("change tracking: system instruction {} B (every mode), per-turn note {} B (Standard only)", text.len(), note.len());
    }

    /// A temporary Claude config folder and project; removed on drop.
    struct Settings {
        base: std::path::PathBuf,
    }
    impl Settings {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("pandacode-claude-settings-{}", crate::storage::id()));
            std::fs::create_dir_all(base.join("config")).unwrap();
            std::fs::create_dir_all(base.join("project/.claude")).unwrap();
            Self { base }
        }
        fn user(&self, name: &str, text: impl AsRef<[u8]>) -> &Self {
            std::fs::write(self.base.join("config").join(name), text).unwrap();
            self
        }
        fn project(&self, name: &str, text: impl AsRef<[u8]>) -> &Self {
            std::fs::write(self.base.join("project/.claude").join(name), text).unwrap();
            self
        }
        fn allows(&self) -> bool {
            edit_allow_rules(&self.base.join("config"), &self.base.join("project"))
        }
    }
    impl Drop for Settings {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn a_managed_policy_file_means_the_approval_wait_is_not_relied_on() {
        let settings = Settings::new();
        let managed = settings.base.join("managed-settings.json");
        assert!(!managed_settings_may_allow(None));
        assert!(!managed_settings_may_allow(Some(&managed)), "absent");
        std::fs::write(&managed, "{}").unwrap();
        assert!(managed_settings_may_allow(Some(&managed)), "present, even without rules");
        std::fs::write(&managed, "not json").unwrap();
        assert!(managed_settings_may_allow(Some(&managed)), "unparseable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let locked = settings.base.join("locked");
            std::fs::create_dir(&locked).unwrap();
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
            let unreadable = managed_settings_may_allow(Some(&locked.join("managed-settings.json")));
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(unreadable, "presence cannot be checked");
        }
    }

    #[test]
    fn a_users_edit_allow_rule_means_the_approval_wait_is_not_relied_on() {
        // No settings, or settings without an edit rule: Standard edits wait for approval.
        assert!(!Settings::new().allows());
        assert!(!Settings::new().user("settings.json", r#"{"permissions":{"allow":["Bash(ls:*)","Read","mcp__x__y"],"deny":["Edit"]}}"#).allows());
        assert!(!Settings::new().user("settings.json", r#"{"model":"opus","permissions":{"defaultMode":"default"}}"#).allows());
        // An allow rule for any native edit tool, user or project level, skips the wait.
        for rule in ["Edit", "Write", "MultiEdit", "NotebookEdit", "Edit(*)", "Write(src/**)", " Edit ", "*"] {
            let text = format!(r#"{{"permissions":{{"allow":["Read",{}]}}}}"#, serde_json::json!(rule));
            for (user, name) in [(true, "settings.json"), (true, "settings.local.json"), (false, "settings.json"), (false, "settings.local.json")] {
                let settings = Settings::new();
                if user { settings.user(name, &text) } else { settings.project(name, &text) };
                assert!(settings.allows(), "{rule} in {name} (user {user})");
            }
        }
        // So does a default mode that never asks.
        assert!(Settings::new().user("settings.json", r#"{"permissions":{"defaultMode":"acceptEdits"}}"#).allows());
        // Anything unreadable or unexpected counts as an allow rule: the wait is never assumed.
        for text in ["not json", "", "[]", "null", r#"{"permissions":[]}"#, r#"{"permissions":{"allow":"Edit"}}"#, r#"{"permissions":{"allow":[{"tool":"Read"}]}}"#] {
            assert!(Settings::new().project("settings.local.json", text).allows(), "{text:?}");
        }
        let huge = format!(r#"{{"permissions":{{"allow":[]}},"pad":"{}"}}"#, "x".repeat(SETTINGS_LIMIT as usize));
        assert!(Settings::new().user("settings.json", huge).allows(), "oversized");
        let folder = Settings::new();
        std::fs::create_dir_all(folder.base.join("config/settings.json")).unwrap();
        assert!(folder.allows(), "a folder where a settings file belongs");
        // The run's message then carries no note: the cached handshake covers native edits too.
        let note = |allows: bool| turn_note(edits_wait_for_approval("claude", "ask") && !allows);
        assert!(note(false).is_some_and(|note| note.contains("tracked automatically")));
        assert!(note(true).is_none());
    }

    #[test]
    fn relays_without_setting_files_and_other_harnesses_skip_the_settings_check() {
        // GLM, MiMo and Alibaba load no settings files; other harnesses never wait in the first place.
        for provider in ["glm", "mimo", "alibaba", "codex"] {
            let config = crate::providers::RunConfig { provider: provider.into(), ..crate::providers::tests::config("claude") };
            assert!(!claude_allows_edits(&config), "{provider}");
        }
        for provider in ["glm", "mimo", "alibaba"] {
            let config = crate::providers::RunConfig { mode: "ask".into(), ..crate::providers::tests::config(provider) };
            assert!(edits_wait_for_run(&config), "{provider}");
        }
    }

    #[test]
    fn an_unchanged_write_after_this_tasks_own_earlier_edit_stays_clean() {
        // The tracker already holds this path's baseline from an earlier tool call this turn,
        // and the second write leaves the bytes that tool left: a real no-op, not a lost race.
        let f = crate::turn_changes::tests::Fixture::new(false);
        f.write("src/a.txt", "one\n");
        let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
        tracker.observe_tool("first", &native("first", "running", &["src/a.txt"]));
        f.write("src/a.txt", "one\ntwo\n");
        tracker.observe_tool("first", &native("first", "completed", &["src/a.txt"]));
        tracker.observe_tool("same", &native("same", "running", &["src/a.txt"]));
        f.write("src/a.txt", "one\ntwo\n");
        tracker.observe_tool("same", &native("same", "completed", &["src/a.txt"]));
        let captured = tracker.finish().unwrap();
        assert_eq!(captured.summary.files.len(), 1);
        assert_eq!((captured.summary.additions, captured.summary.deletions), (1, 0));
        assert!(!captured.summary.truncated, "{:?}", captured.summary.error);
        // A write that beat its baseline after such an edit is still flagged.
        let f = crate::turn_changes::tests::Fixture::new(false);
        f.write("src/a.txt", "one\n");
        let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
        tracker.observe_tool("first", &native("first", "running", &["src/a.txt"]));
        f.write("src/a.txt", "one\ntwo\n");
        tracker.observe_tool("first", &native("first", "completed", &["src/a.txt"]));
        f.write("src/a.txt", "one\ntwo\nthree\n");
        tracker.observe_tool("late", &native("late", "running", &["src/a.txt"]));
        tracker.observe_tool("late", &native("late", "completed", &["src/a.txt"]));
        assert!(tracker.finish().unwrap().summary.truncated, "a lost race is never silently clean");
    }

    /// Sets `path`'s modification time to `age` before now.
    fn modified_ago(f: &crate::turn_changes::tests::Fixture, path: &str, age: std::time::Duration) {
        let file = std::fs::File::options().write(true).open(f.root.join(path)).unwrap();
        file.set_modified(std::time::SystemTime::now() - age).unwrap();
    }

    #[test]
    fn a_native_write_to_a_file_modified_just_before_the_turn_is_flagged_partial() {
        // File systems keep coarse modification times (1–2 s on some), so a write landing in
        // this turn can read as just before it: when in doubt the turn is marked partial.
        let f = crate::turn_changes::tests::Fixture::new(false);
        f.write("src/a.txt", "one\n");
        modified_ago(&f, "src/a.txt", std::time::Duration::from_millis(500));
        let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
        tracker.observe_tool("noop", &native("noop", "running", &["src/a.txt"]));
        tracker.observe_tool("noop", &native("noop", "completed", &["src/a.txt"]));
        let captured = tracker.finish().unwrap();
        assert!(captured.summary.files.is_empty());
        assert!(captured.summary.truncated, "a modification time within the resolution slack is never trusted");
    }

    #[test]
    fn a_native_write_to_a_file_untouched_this_turn_stays_clean() {
        // The file's bytes predate the turn, and the tool left them alone: truly no change.
        let f = crate::turn_changes::tests::Fixture::new(false);
        f.write("src/a.txt", "one\n");
        modified_ago(&f, "src/a.txt", std::time::Duration::from_secs(3600));
        let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
        tracker.observe_tool("noop", &native("noop", "running", &["src/a.txt"]));
        tracker.observe_tool("noop", &native("noop", "completed", &["src/a.txt"]));
        let captured = tracker.finish().unwrap();
        assert!(captured.summary.files.is_empty());
        assert!(!captured.summary.truncated, "{:?}", captured.summary.error);
    }

    #[test]
    fn native_edit_tools_are_captured_without_a_handshake() {
        let f = crate::turn_changes::tests::Fixture::new(false);
        f.write("src/a.txt", "one\n");
        let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
        // The baseline is taken when the running event arrives, before the tool writes.
        tracker.observe_tool("edit", &native("edit", "running", &["src/a.txt"]));
        f.write("src/a.txt", "one\ntwo\n");
        tracker.observe_tool("edit", &native("edit", "completed", &["src/a.txt"]));
        let captured = tracker.finish().unwrap();
        assert_eq!(captured.summary.files.len(), 1);
        assert_eq!((captured.summary.additions, captured.summary.deletions), (1, 0));
        assert!(!captured.summary.truncated);
    }

    #[test]
    fn a_native_baseline_that_lost_the_race_is_flagged_never_silently_clean() {
        // A harness running without approvals may apply the edit before its event reaches
        // PandaCode; the baseline then already holds the new bytes. That must never read as
        // "no changes": the turn is marked partial so the user knows edits were omitted.
        let f = crate::turn_changes::tests::Fixture::new(false);
        f.write("src/a.txt", "one\n");
        let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
        f.write("src/a.txt", "one\ntwo\n");
        tracker.observe_tool("late", &native("late", "running", &["src/a.txt"]));
        tracker.observe_tool("late", &native("late", "completed", &["src/a.txt"]));
        let captured = tracker.finish().unwrap();
        assert!(captured.summary.files.is_empty());
        assert!(captured.summary.truncated);
        assert!(captured.summary.error.is_some());
    }

    #[test]
    fn an_explicit_capture_completed_without_changes_stays_clean() {
        // A shell batch that turned out to change nothing is not a lost race.
        let f = crate::turn_changes::tests::Fixture::new(false);
        f.write("a.txt", "one\n");
        let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
        let begun = tracker.report(json!({"action":"begin","paths":["a.txt"]})).unwrap();
        tracker.report(json!({"action":"complete","captureId":begun["captureId"],"paths":["a.txt"]})).unwrap();
        let captured = tracker.finish().unwrap();
        assert!(captured.summary.files.is_empty() && !captured.summary.truncated);
    }
}
