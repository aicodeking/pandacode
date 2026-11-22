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
    edits_wait_for_run_using(config, claude_allows_edits)
}

fn edits_wait_for_run_using(
    config: &crate::providers::RunConfig,
    allows_edits: impl FnOnce(&crate::providers::RunConfig) -> bool,
) -> bool {
    edits_wait_for_approval(&config.provider, &config.mode) && !allows_edits(config)
}

/// Whether Claude Code may apply this run's edits without asking. GLM, MiMo and Alibaba launch
/// with `--setting-sources ""`, so user, project and local settings files do not apply to them,
/// but Claude Code still enforces enterprise `managed-settings.json`, and a named connection on
/// any Claude-family harness may pass `--allowedTools` or use another Claude config folder
/// (not followed: treated as allowing).
fn claude_allows_edits(config: &crate::providers::RunConfig) -> bool {
    claude_allows_edits_with(
        config,
        || crate::connections::for_task(&config.session_id, &config.provider).is_some(),
        host_managed_settings_may_allow,
        crate::agent_usage::claude_config_dir,
    )
}

fn claude_allows_edits_with(
    config: &crate::providers::RunConfig,
    has_connection: impl FnOnce() -> bool,
    managed_settings: impl FnOnce() -> bool,
    claude_config_dir: impl FnOnce() -> Option<std::path::PathBuf>,
) -> bool {
    if !crate::providers::claude_family(&config.provider) {
        return false;
    }
    if has_connection() {
        return true;
    }
    if managed_settings() {
        return true;
    }
    if config.provider != "claude" {
        return false;
    }
    match claude_config_dir() {
        Some(dir) => edit_allow_rules(&dir, &config.cwd),
        None => true,
    }
}

/// Explore must not bypass Claude's native read permissions, in any permission mode.
pub(crate) fn claude_restricts_reads(session_id: &str, provider: &str, cwd: &Path) -> bool {
    claude_restricts_reads_with(
        provider,
        cwd,
        || crate::connections::for_task(session_id, provider)
            .map(|connection| crate::connections::launch(&connection)).transpose(),
        host_managed_settings_restrict_reads,
        crate::agent_usage::claude_config_dir,
        dirs::home_dir,
    )
}

fn claude_restricts_reads_with(
    provider: &str,
    cwd: &Path,
    connection: impl FnOnce() -> std::result::Result<Option<crate::connections::Launch>, String>,
    managed_settings: impl FnOnce() -> bool,
    config_dir: impl FnOnce() -> Option<PathBuf>,
    home_dir: impl FnOnce() -> Option<PathBuf>,
) -> bool {
    if !crate::providers::claude_family(provider) {
        return false;
    }
    if managed_settings() {
        return true;
    }
    let connection = match connection() {
        Ok(connection) => connection,
        Err(_) => return true,
    };
    let mut overridden = None;
    if let Some(connection) = connection {
        if connection.args.iter().any(|arg| {
            let flag = arg.split('=').next().unwrap_or_default();
            matches!(flag, "--settings" | "--setting-sources" | "--disallowedTools" | "--disallowed-tools")
        }) {
            return true;
        }
        // Launch::apply uses the last value when a variable occurs more than once.
        for (name, value) in connection.env {
            if name == "CLAUDE_CONFIG_DIR" || (cfg!(windows) && name.eq_ignore_ascii_case("CLAUDE_CONFIG_DIR")) {
                if value.is_empty() {
                    return true;
                }
                overridden = Some(cwd.join(value));
            }
        }
    }
    // Relays disable user/project sources, but still obey managed policy and connection flags.
    if provider != "claude" {
        return false;
    }
    let Some(config_dir) = overridden.or_else(config_dir) else { return true };
    let home_settings = home_dir().map(|home| home.join(".claude"));
    read_deny_rules(&config_dir, cwd, home_settings.as_deref())
}

fn host_managed_settings_restrict_reads() -> bool {
    #[cfg(target_os = "macos")]
    {
        managed_settings_restrict_reads(Some(Path::new(
            "/Library/Application Support/ClaudeCode/managed-settings.json",
        )))
    }
    #[cfg(target_os = "linux")]
    {
        managed_settings_restrict_reads(Some(Path::new("/etc/claude-code/managed-settings.json")))
    }
    #[cfg(windows)]
    {
        windows_managed_settings_may_allow_with(
            std::env::var_os("PROGRAMDATA"),
            |path| if path.extension().is_some_and(|ext| ext == "d") {
                settings_drop_ins_restrict_reads(path)
            } else {
                file_restricts_reads(path)
            },
            windows_registry_policy_status,
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        true
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn managed_settings_restrict_reads(path: Option<&Path>) -> bool {
    path.is_none_or(|path| {
        file_restricts_reads(path) || settings_drop_ins_restrict_reads(&path.with_extension("d"))
    })
}

fn settings_drop_ins_restrict_reads(path: &Path) -> bool {
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && settings_path_absent(path) => return false,
        Err(_) => return read_settings_warning("unreadable managed settings directory"),
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => return read_settings_warning("unreadable managed settings entry"),
        };
        if entry.path().extension().is_some_and(|ext| ext == "json")
            && file_restricts_reads(&entry.path())
        {
            return true;
        }
    }
    false
}

/// User settings plus project/local settings from cwd through the nearest repository root.
/// Without a repository, only cwd is a project. An overridden user folder must not accidentally
/// load the original $HOME/.claude again while walking a repository rooted at home.
fn read_deny_rules(config_dir: &Path, cwd: &Path, home_settings: Option<&Path>) -> bool {
    if SETTINGS_FILES.iter().any(|name| file_restricts_reads(&config_dir.join(name))) {
        return true;
    }
    let mut root = cwd;
    for ancestor in cwd.ancestors() {
        match std::fs::symlink_metadata(ancestor.join(".git")) {
            Ok(_) => { root = ancestor; break; }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return read_settings_warning("unreadable project root"),
        }
    }
    for ancestor in cwd.ancestors() {
        let project = ancestor.join(".claude");
        if project != config_dir && home_settings != Some(project.as_path())
            && SETTINGS_FILES.iter().any(|name| file_restricts_reads(&project.join(name)))
        {
            return true;
        }
        if ancestor == root {
            break;
        }
    }
    false
}

fn read_settings_warning(reason: &str) -> bool {
    eprintln!("PandaCode: Claude Code settings could not be checked for read restrictions ({reason}); the local code explorer is withheld.");
    true
}

fn file_restricts_reads(path: &Path) -> bool {
    match read_settings(path) {
        Ok(None) => false,
        Ok(Some(settings)) => settings_restrict_reads(&settings),
        Err(reason) => read_settings_warning(reason),
    }
}

fn settings_restrict_reads(settings: &Value) -> bool {
    let Some(settings) = settings.as_object() else { return true };
    let Some(permissions) = settings.get("permissions") else { return false };
    let Some(permissions) = permissions.as_object() else { return true };
    ["deny", "ask"].into_iter().any(|kind| match permissions.get(kind) {
        None => false,
        Some(Value::Array(rules)) => rules.iter().any(|rule| rule.as_str().is_none_or(|rule| {
            matches!(rule.split('(').next().unwrap_or_default().trim(),
                "*" | "Read" | "Grep" | "Glob" | "mcp__pandacode_architect__pandacode_explore" | "mcp__pandacode_architect__*")
        })),
        Some(_) => true,
    })
}

/// A policy's presence (including an unreadable path or registry key) is enough to require
/// tracking. Policy contents need not be read, and unknown platforms never assume absence.
fn host_managed_settings_may_allow() -> bool {
    #[cfg(target_os = "macos")]
    {
        managed_settings_may_allow(Some(std::path::Path::new(
            "/Library/Application Support/ClaudeCode/managed-settings.json",
        )))
    }
    #[cfg(target_os = "linux")]
    {
        managed_settings_may_allow(Some(std::path::Path::new(
            "/etc/claude-code/managed-settings.json",
        )))
    }
    #[cfg(windows)]
    {
        windows_managed_settings_may_allow_with(
            std::env::var_os("PROGRAMDATA"),
            managed_path_may_allow,
            windows_registry_policy_status,
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        managed_settings_may_allow(None)
    }
}

/// macOS/Linux policy file and its sibling drop-in directory. An unknown location fails closed.
#[cfg(any(not(windows), test))]
fn managed_settings_may_allow(path: Option<&std::path::Path>) -> bool {
    path.is_none_or(|path| {
        managed_path_may_allow(path) || managed_path_may_allow(&path.with_extension("d"))
    })
}

fn managed_path_may_allow(path: &std::path::Path) -> bool {
    managed_path_may_allow_with(|| std::fs::symlink_metadata(path).map(|_| ()))
}

fn managed_path_may_allow_with(stat: impl FnOnce() -> std::io::Result<()>) -> bool {
    match stat() {
        Ok(()) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

/// Inject both probes so every platform can test Windows policy paths and registry failures.
#[cfg(any(windows, test))]
fn windows_managed_settings_may_allow_with(
    program_data: Option<std::ffi::OsString>,
    mut path_may_allow: impl FnMut(&std::path::Path) -> bool,
    mut registry_status: impl FnMut(u32, &str) -> i32,
) -> bool {
    let Some(program_data) = program_data.filter(|value| !value.is_empty()) else {
        return true;
    };
    let root = std::path::PathBuf::from(program_data).join("ClaudeCode");
    let paths = [
        root.join("managed-settings.json"),
        root.join("managed-settings.d"),
        std::path::PathBuf::from(r"C:\Program Files\ClaudeCode\managed-settings.json"),
    ];
    if paths.iter().any(|path| path_may_allow(path)) {
        return true;
    }
    // ERROR_FILE_NOT_FOUND alone proves absence. Success or any other error (including
    // access denied) requires the handshake.
    const HKEY_LOCAL_MACHINE: u32 = 0x8000_0002;
    const HKEY_CURRENT_USER: u32 = 0x8000_0001;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER]
        .into_iter()
        .any(|root| registry_status(root, r"SOFTWARE\Policies\ClaudeCode") != ERROR_FILE_NOT_FOUND)
}

#[cfg(windows)]
fn windows_registry_policy_status(root: u32, path: &str) -> i32 {
    use std::ffi::c_void;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            key: *mut c_void,
            subkey: *const u16,
            options: u32,
            access: u32,
            result: *mut *mut c_void,
        ) -> i32;
        fn RegCloseKey(key: *mut c_void) -> i32;
    }
    const KEY_READ: u32 = 0x20019;
    const ERROR_SUCCESS: i32 = 0;
    let path: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let mut key = std::ptr::null_mut();
    // SAFETY: predefined HKEY constants are sign-extended from a 32-bit LONG, as in winreg.h.
    // The UTF-16 path is NUL-terminated, and the output handle stays valid until closed here.
    // KEY_READ (0x20019) only opens existing keys and does not modify enterprise policy.
    unsafe {
        let status = RegOpenKeyExW(
            root as i32 as isize as *mut c_void,
            path.as_ptr(),
            0,
            KEY_READ,
            &mut key,
        );
        if status == ERROR_SUCCESS {
            RegCloseKey(key);
        }
        status
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
/// settings are checked separately (`host_managed_settings_may_allow`). Limits: `--settings` flags, parent folders of `project` and the user's
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

/// A dangling symlink is an unreadable policy, not proof that no settings exist.
fn settings_path_absent(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

/// The parsed file, `None` when it does not exist, or why it could not be read.
fn read_settings(path: &std::path::Path) -> std::result::Result<Option<Value>, &'static str> {
    use std::io::Read;
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && settings_path_absent(path) => return Ok(None),
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

    // Read-restriction tests use injected launch inputs, never the machine's own settings.
    fn read_launch(args: &[&str], env: &[(&str, &str)]) -> crate::connections::Launch {
        crate::connections::Launch {
            executable: None,
            args: args.iter().map(|arg| (*arg).into()).collect(),
            env: env.iter().map(|(key, value)| ((*key).into(), (*value).into())).collect(),
            secrets: vec![],
        }
    }

    fn restricts_reads(settings: &Settings, provider: &str, connection: Option<crate::connections::Launch>) -> bool {
        claude_restricts_reads_with(provider, &settings.base.join("project"), || Ok(connection),
            || false, || Some(settings.base.join("config")), || None)
    }

    #[test]
    fn claude_read_and_explore_denials_and_ask_rules_withhold_explore() {
        for kind in ["deny", "ask"] {
            for rule in ["Read(restricted/customer.csv)", "Grep(restricted/**)", "Glob(src/**)",
                "Read", "*", "mcp__pandacode_architect__pandacode_explore",
                "mcp__pandacode_architect__pandacode_explore(src/**)", "mcp__pandacode_architect__*", "  Read (file)  "] {
                for file in SETTINGS_FILES {
                    for user in [true, false] {
                        let settings = Settings::new();
                        let text = json!({"permissions":{kind:[rule]}}).to_string();
                        if user { settings.user(file, text); } else { settings.project(file, text); }
                        assert!(restricts_reads(&settings, "claude", None), "{kind} {rule} {file} user={user}");
                    }
                }
            }
        }
    }

    #[test]
    fn unrelated_permissions_and_absent_settings_leave_explore_available() {
        let settings = Settings::new();
        assert!(!restricts_reads(&settings, "claude", None));
        for value in [json!({}), json!({"permissions":{}}), json!({"permissions":{"deny":[],"ask":[]}}),
            json!({"permissions":{"deny":["Bash(rm *)","Write(.env)","Edit(src/**)","WebFetch"],
                "ask":["Bash","mcp__other__*"],"allow":["Read"],"defaultMode":"bypassPermissions"}})] {
            settings.user("settings.json", value.to_string());
            assert!(!restricts_reads(&settings, "claude", None), "{value}");
        }
    }

    #[test]
    fn malformed_read_permissions_fail_closed() {
        let settings = Settings::new();
        for value in [json!(null), json!([]), json!({"permissions":null}), json!({"permissions":[]}),
            json!({"permissions":{"deny":"Read"}}), json!({"permissions":{"ask":{}}}),
            json!({"permissions":{"deny":[false]}}), json!({"permissions":{"ask":[null]}})] {
            settings.user("settings.json", value.to_string());
            assert!(restricts_reads(&settings, "claude", None), "{value}");
        }
        settings.user("settings.json", "not JSON");
        assert!(restricts_reads(&settings, "claude", None));
        settings.user("settings.json", vec![b' '; SETTINGS_LIMIT as usize + 1]);
        assert!(restricts_reads(&settings, "claude", None));
        std::fs::remove_file(settings.base.join("config/settings.json")).unwrap();
        std::fs::create_dir(settings.base.join("config/settings.json")).unwrap();
        assert!(restricts_reads(&settings, "claude", None), "not a regular file");
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_read_settings_and_managed_drop_ins_fail_closed() {
        use std::os::unix::fs::PermissionsExt;
        let settings = Settings::new();
        let file = settings.base.join("config/settings.json");
        settings.user("settings.json", "{}");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        let restricted = restricts_reads(&settings, "claude", None);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(restricted);
        let drop_ins = settings.base.join("managed-settings.d");
        std::fs::create_dir(&drop_ins).unwrap();
        std::fs::set_permissions(&drop_ins, std::fs::Permissions::from_mode(0o000)).unwrap();
        let restricted = managed_settings_restrict_reads(Some(&settings.base.join("managed-settings.json")));
        std::fs::set_permissions(&drop_ins, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(restricted);
    }

    #[test]
    fn managed_read_rules_and_json_drop_ins_are_checked() {
        let settings = Settings::new();
        let managed = settings.base.join("managed-settings.json");
        assert!(managed_settings_restrict_reads(None), "unknown path");
        assert!(!managed_settings_restrict_reads(Some(&managed)), "absent policy");
        std::fs::write(&managed, r#"{"permissions":{"deny":["Write"]}}"#).unwrap();
        assert!(!managed_settings_restrict_reads(Some(&managed)), "unrelated policy");
        std::fs::write(&managed, r#"{"permissions":{"deny":["Read(secret)"]}}"#).unwrap();
        assert!(managed_settings_restrict_reads(Some(&managed)));
        std::fs::write(&managed, "{}").unwrap();
        let drop_ins = managed.with_extension("d");
        std::fs::create_dir(&drop_ins).unwrap();
        std::fs::write(drop_ins.join("ignored.txt"), "not json").unwrap();
        assert!(!managed_settings_restrict_reads(Some(&managed)));
        std::fs::write(drop_ins.join("reads.json"), r#"{"permissions":{"ask":["Read(file)"]}}"#).unwrap();
        assert!(managed_settings_restrict_reads(Some(&managed)));
        std::fs::write(drop_ins.join("reads.json"), "invalid JSON").unwrap();
        assert!(managed_settings_restrict_reads(Some(&managed)));
        std::fs::remove_file(drop_ins.join("reads.json")).unwrap();
        std::fs::create_dir(drop_ins.join("directory.json")).unwrap();
        assert!(managed_settings_restrict_reads(Some(&managed)), "JSON entry must be a file");
        std::fs::remove_dir_all(&drop_ins).unwrap();
        std::fs::write(&drop_ins, "not a directory").unwrap();
        assert!(managed_settings_restrict_reads(Some(&managed)));
    }

    #[cfg(unix)]
    #[test]
    fn dangling_claude_settings_and_managed_directory_links_fail_closed() {
        use std::os::unix::fs::symlink;
        let settings = Settings::new();
        symlink(settings.base.join("absent"), settings.base.join("config/settings.json")).unwrap();
        assert!(restricts_reads(&settings, "claude", None));
        symlink(settings.base.join("absent"), settings.base.join("managed-settings.d")).unwrap();
        assert!(managed_settings_restrict_reads(Some(&settings.base.join("managed-settings.json"))));
    }

    #[test]
    fn windows_managed_read_paths_and_registry_errors_fail_closed() {
        let settings = Settings::new();
        let program_data = settings.base.as_os_str().to_owned();
        let mut paths = Vec::new();
        let mut keys = Vec::new();
        assert!(!windows_managed_settings_may_allow_with(Some(program_data.clone()),
            |path| { paths.push(path.to_owned()); false },
            |root, path| { keys.push((root, path.to_owned())); 2 }));
        assert_eq!(paths, vec![settings.base.join("ClaudeCode/managed-settings.json"),
            settings.base.join("ClaudeCode/managed-settings.d"), PathBuf::from(r"C:\Program Files\ClaudeCode\managed-settings.json")]);
        assert_eq!(keys, vec![(0x8000_0002, r"SOFTWARE\Policies\ClaudeCode".into()),
            (0x8000_0001, r"SOFTWARE\Policies\ClaudeCode".into())]);
        for key in [0x8000_0002, 0x8000_0001] {
            for status in [0, 5, 3, -1] {
                assert!(windows_managed_settings_may_allow_with(Some(program_data.clone()), |_| false,
                    |root, _| if root == key { status } else { 2 }));
            }
        }
        for program_data in [None, Some(std::ffi::OsString::new())] {
            assert!(windows_managed_settings_may_allow_with(program_data, |_| panic!("no policy root"), |_, _| panic!("no policy root")));
        }
        let managed_dir = settings.base.join("ClaudeCode");
        std::fs::create_dir(&managed_dir).unwrap();
        let probe = |path: &Path| {
            // The Program Files fallback is outside this fixture; never inspect host policy.
            if !path.starts_with(&settings.base) { return false; }
            if path.extension().is_some_and(|ext| ext == "d") {
                settings_drop_ins_restrict_reads(path)
            } else { file_restricts_reads(path) }
        };
        std::fs::write(managed_dir.join("managed-settings.json"), "{}").unwrap();
        assert!(!windows_managed_settings_may_allow_with(Some(program_data.clone()), probe, |_, _| 2));
        std::fs::create_dir(managed_dir.join("managed-settings.d")).unwrap();
        std::fs::write(managed_dir.join("managed-settings.d/read.json"), r#"{"permissions":{"deny":["Read"]}}"#).unwrap();
        assert!(windows_managed_settings_may_allow_with(Some(program_data), probe, |_, _| 2));
    }

    #[test]
    fn relay_reads_ignore_user_and_project_rules_but_honor_managed_policy() {
        let settings = Settings::new();
        settings.user("settings.json", r#"{"permissions":{"deny":["Read"]}}"#)
            .project("settings.local.json", r#"{"permissions":{"ask":["Grep"]}}"#);
        for provider in ["glm", "mimo", "alibaba"] {
            assert!(!restricts_reads(&settings, provider, None), "{provider}");
            assert!(claude_restricts_reads_with(provider, &settings.base, || panic!("managed restriction"),
                || true, || panic!("relay config"), || panic!("relay home")));
            assert!(restricts_reads(&settings, provider, Some(read_launch(&["--settings=custom.json"], &[]))));
        }
    }

    #[test]
    fn claude_connections_resolve_config_and_reject_unfollowed_flags() {
        let settings = Settings::new();
        assert!(!restricts_reads(&settings, "claude", Some(read_launch(&[], &[("ANTHROPIC_BASE_URL", "https://example.invalid")]))));
        for provider in ["claude", "glm", "mimo", "alibaba"] {
            for flag in ["--settings", "--setting-sources", "--disallowedTools", "--disallowed-tools"] {
                for arg in [flag.to_owned(), format!("{flag}=value")] {
                    assert!(restricts_reads(&settings, provider, Some(read_launch(&[&arg], &[]))), "{provider} {arg}");
                }
            }
            assert!(restricts_reads(&settings, provider, Some(read_launch(&[], &[("CLAUDE_CONFIG_DIR", "")]))));
            assert!(claude_restricts_reads_with(provider, &settings.base, || Err("missing saved key".into()),
                || false, || panic!("bad connection"), || None));
        }
        let custom = settings.base.join("custom");
        std::fs::create_dir(&custom).unwrap();
        std::fs::write(custom.join("settings.local.json"), r#"{"permissions":{"deny":["Read"]}}"#).unwrap();
        let connection = || Some(read_launch(&[], &[("CLAUDE_CONFIG_DIR", custom.to_str().unwrap())]));
        assert!(restricts_reads(&settings, "claude", connection()));
        std::fs::create_dir(settings.base.join("project/relative-config")).unwrap();
        std::fs::write(settings.base.join("project/relative-config/settings.json"), r#"{"permissions":{"deny":["Read"]}}"#).unwrap();
        assert!(restricts_reads(&settings, "claude", Some(read_launch(&[], &[("CLAUDE_CONFIG_DIR", "relative-config")]))));
        #[cfg(windows)]
        assert!(restricts_reads(&settings, "claude", Some(read_launch(&[], &[("claude_config_dir", custom.to_str().unwrap())]))));
        assert!(!restricts_reads(&settings, "glm", connection()));
        settings.user("settings.json", r#"{"permissions":{"deny":["Read"]}}"#);
        std::fs::write(custom.join("settings.local.json"), "{}").unwrap();
        assert!(!claude_restricts_reads_with("claude", &settings.base.join("project"), || Ok(connection()),
            || false, || panic!("override wins"), || None));
        assert!(claude_restricts_reads_with("claude", &settings.base, || Ok(None), || false, || None, || None));
    }

    #[test]
    fn project_read_rules_stop_at_nearest_git_root_and_skip_overridden_home() {
        let settings = Settings::new();
        let project = settings.base.join("project");
        let nested = project.join("src/nested");
        std::fs::create_dir_all(&nested).unwrap();
        // Worktrees use a .git file, ordinary repositories use a directory.
        std::fs::write(project.join(".git"), "gitdir: elsewhere").unwrap();
        settings.project("settings.local.json", r#"{"permissions":{"deny":["Read"]}}"#);
        assert!(read_deny_rules(&settings.base.join("config"), &nested, None));
        std::fs::create_dir(nested.join(".git")).unwrap();
        assert!(!read_deny_rules(&settings.base.join("config"), &nested, None), "nearest root");
        std::fs::remove_dir(nested.join(".git")).unwrap();
        assert!(!read_deny_rules(&settings.base.join("config"), &nested, Some(&project.join(".claude"))), "overridden home config");
        assert!(read_deny_rules(&project.join(".claude"), &nested, Some(&project.join(".claude"))), "active home config");
        std::fs::remove_file(project.join(".git")).unwrap();
        assert!(!read_deny_rules(&settings.base.join("config"), &nested, None), "no repo: only cwd");
    }

    #[test]
    fn non_claude_harnesses_never_probe_claude_read_settings() {
        for provider in ["codex", "opencode", "kimi"] {
            assert!(!claude_restricts_reads_with(provider, Path::new("unused"),
                || panic!("non-Claude connection"), || panic!("non-Claude policy"),
                || panic!("non-Claude config"), || panic!("non-Claude home")));
        }
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
        assert!(managed_settings_may_allow(None), "unknown policy location fails closed");
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
    fn a_managed_drop_in_directory_requires_the_tracking_handshake() {
        let settings = Settings::new();
        let managed = settings.base.join("managed-settings.json");
        let drop_ins = settings.base.join("managed-settings.d");
        let config = crate::providers::RunConfig {
            mode: "ask".into(),
            ..crate::providers::tests::config("glm")
        };
        let waits = || {
            edits_wait_for_run_using(&config, |config| {
                claude_allows_edits_with(
                    config,
                    || false,
                    || managed_settings_may_allow(Some(&managed)),
                    || panic!("relay config"),
                )
            })
        };
        assert!(waits(), "no managed policy");
        std::fs::create_dir(&drop_ins).unwrap();
        assert!(
            !waits(),
            "even an empty drop-in directory requires the handshake"
        );
        std::fs::write(
            drop_ins.join("edits.json"),
            r#"{"permissions":{"allow":["Edit"]}}"#,
        )
        .unwrap();
        assert!(!waits(), "drop-in policy present");
    }

    #[test]
    fn managed_policy_stat_errors_fail_closed_on_every_platform() {
        for kind in [
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::NotADirectory,
            std::io::ErrorKind::Other,
        ] {
            let config = crate::providers::tests::config("glm");
            let allows = || managed_path_may_allow_with(|| Err(std::io::Error::from(kind)));
            assert!(
                claude_allows_edits_with(&config, || false, allows, || panic!("relay config")),
                "{kind:?}"
            );
        }
        assert!(!managed_path_may_allow_with(|| Err(
            std::io::ErrorKind::NotFound.into()
        )));
        assert!(managed_path_may_allow_with(|| Ok(())));
        assert!(windows_managed_settings_may_allow_with(
            Some(r"C:\ProgramData".into()),
            |_| managed_path_may_allow_with(|| Err(std::io::ErrorKind::PermissionDenied.into())),
            |_, _| panic!("unreadable policy path already requires tracking"),
        ));
    }

    #[test]
    fn windows_managed_policy_paths_and_registry_keys_are_checked_without_host_state() {
        let program_data = std::path::PathBuf::from(r"D:\Enterprise Data");
        let mut paths = Vec::new();
        let mut keys = Vec::new();
        assert!(!windows_managed_settings_may_allow_with(
            Some(program_data.clone().into_os_string()),
            |path| {
                paths.push(path.to_owned());
                false
            },
            |root, path| {
                keys.push((root, path.to_owned()));
                2
            },
        ));
        let root = program_data.join("ClaudeCode");
        assert_eq!(
            paths,
            [
                root.join("managed-settings.json"),
                root.join("managed-settings.d"),
                std::path::PathBuf::from(r"C:\Program Files\ClaudeCode\managed-settings.json"),
            ]
        );
        assert_eq!(
            keys,
            [
                (0x8000_0002, r"SOFTWARE\Policies\ClaudeCode".to_owned()),
                (0x8000_0001, r"SOFTWARE\Policies\ClaudeCode".to_owned()),
            ]
        );
        for present in &paths {
            assert!(
                windows_managed_settings_may_allow_with(
                    Some(program_data.clone().into_os_string()),
                    |path| path == present,
                    |_, _| 2,
                ),
                "{present:?}"
            );
        }
        for unknown in [None, Some(std::ffi::OsString::new())] {
            assert!(windows_managed_settings_may_allow_with(
                unknown,
                |_| panic!("unknown PROGRAMDATA must fail closed"),
                |_, _| panic!("unknown PROGRAMDATA must fail closed")
            ));
        }
    }

    #[test]
    fn windows_registry_presence_and_errors_require_native_edit_tracking() {
        for policy_root in [0x8000_0002, 0x8000_0001] {
            for status in [0, 5, 3, 87] {
                let config = crate::providers::RunConfig {
                    mode: "ask".into(),
                    ..crate::providers::tests::config("glm")
                };
                let allows = || {
                    windows_managed_settings_may_allow_with(
                        Some(r"C:\ProgramData".into()),
                        |_| false,
                        |root, _| if root == policy_root { status } else { 2 },
                    )
                };
                assert!(
                    !edits_wait_for_run_using(&config, |config| claude_allows_edits_with(
                        config,
                        || false,
                        allows,
                        || panic!("relay config"),
                    )),
                    "root {policy_root:#x}, status {status}"
                );
            }
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
        // Non-Claude-family harnesses never check Claude settings or wait for edit approval.
        let codex = crate::providers::RunConfig { provider: "codex".into(), ..crate::providers::tests::config("claude") };
        assert!(!claude_allows_edits(&codex));
        assert!(!edits_wait_for_run(&codex));
        // GLM, MiMo and Alibaba ignore user/project/local settings files, but still inherit
        // enterprise managed-settings.json if present on this host.
        let host_managed = host_managed_settings_may_allow();
        for provider in ["glm", "mimo", "alibaba"] {
            let config = crate::providers::RunConfig { mode: "ask".into(), ..crate::providers::tests::config(provider) };
            assert_eq!(claude_allows_edits(&config), host_managed, "{provider}");
            assert_eq!(edits_wait_for_run(&config), !host_managed, "{provider}");
        }
    }

    #[test]
    fn claude_family_relays_respect_connections_and_managed_settings_but_ignore_user_settings() {
        let with_allow_rule = Settings::new();
        with_allow_rule
            .user("settings.json", r#"{"permissions":{"allow":["Edit"]}}"#)
            .project("settings.json", r#"{"permissions":{"allow":["Write"]}}"#);
        let absent_managed = with_allow_rule.base.join("absent-managed-settings.json");
        let present_managed = with_allow_rule.base.join("managed-settings.json");
        std::fs::write(&present_managed, "{}").unwrap();

        let config_dir = with_allow_rule.base.join("config");
        let project_dir = with_allow_rule.base.join("project");

        for provider in ["glm", "mimo", "alibaba"] {
            let config = crate::providers::RunConfig {
                mode: "ask".into(),
                cwd: project_dir.clone(),
                ..crate::providers::tests::config(provider)
            };
            // Neither named connection nor managed settings: relays skip user/project settings
            // (and never query claude_config_dir), even when an Edit allow rule is present there.
            assert!(
                !claude_allows_edits_with(&config, || false, || managed_settings_may_allow(Some(&absent_managed)), || panic!("relays must not read claude_config_dir")),
                "{provider} without connection or managed settings"
            );
            assert!(
                edits_wait_for_run_using(&config, |c| claude_allows_edits_with(c, || false, || managed_settings_may_allow(Some(&absent_managed)), || Some(config_dir.clone()))),
                "{provider} waits when neither connection nor managed settings apply"
            );
            // A named connection may pass --allowedTools or another config folder: do not rely on the wait.
            assert!(
                claude_allows_edits_with(&config, || true, || managed_settings_may_allow(Some(&absent_managed)), || panic!("connection short-circuits before config dir")),
                "{provider} with named connection"
            );
            assert!(
                !edits_wait_for_run_using(&config, |c| claude_allows_edits_with(c, || true, || managed_settings_may_allow(Some(&absent_managed)), || None)),
                "{provider} does not wait with named connection"
            );
            // Enterprise managed-settings.json still applies even with --setting-sources "".
            assert!(
                claude_allows_edits_with(&config, || false, || managed_settings_may_allow(Some(&present_managed)), || panic!("managed settings short-circuit before config dir")),
                "{provider} with managed settings"
            );
            assert!(
                !edits_wait_for_run_using(&config, |c| claude_allows_edits_with(c, || false, || managed_settings_may_allow(Some(&present_managed)), || None)),
                "{provider} does not wait with managed settings"
            );
        }

        // Plain `claude` still checks claude_config_dir / project settings when no connection or
        // managed policy applies, and treats an unknown config dir as allowing.
        let claude = crate::providers::RunConfig {
            mode: "ask".into(),
            cwd: project_dir,
            ..crate::providers::tests::config("claude")
        };
        assert!(claude_allows_edits_with(&claude, || false, || managed_settings_may_allow(Some(&absent_managed)), || Some(config_dir.clone())));
        assert!(!edits_wait_for_run_using(&claude, |c| claude_allows_edits_with(c, || false, || managed_settings_may_allow(Some(&absent_managed)), || Some(config_dir.clone()))));
        assert!(claude_allows_edits_with(&claude, || false, || managed_settings_may_allow(Some(&absent_managed)), || None));
        let clean = Settings::new();
        let claude_clean = crate::providers::RunConfig {
            mode: "ask".into(),
            cwd: clean.base.join("project"),
            ..crate::providers::tests::config("claude")
        };
        assert!(!claude_allows_edits_with(&claude_clean, || false, || managed_settings_may_allow(Some(&absent_managed)), || Some(clean.base.join("config"))));
        assert!(edits_wait_for_run_using(&claude_clean, |c| claude_allows_edits_with(c, || false, || managed_settings_may_allow(Some(&absent_managed)), || Some(clean.base.join("config")))));

        // Non-Claude-family harnesses short-circuit before connection/managed/config checks.
        let codex = crate::providers::RunConfig {
            mode: "ask".into(),
            ..crate::providers::tests::config("codex")
        };
        assert!(!claude_allows_edits_with(
            &codex,
            || panic!("non-Claude harnesses must not check connections"),
            || panic!("non-Claude harnesses must not check managed settings"),
            || panic!("non-Claude harnesses must not check claude_config_dir"),
        ));
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
