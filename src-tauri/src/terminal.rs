use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
#[cfg(unix)]
use std::os::fd::FromRawFd;
use std::{
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, LazyLock, Mutex,
    },
};
use tauri::{AppHandle, Emitter};

// Linux can keep a blocking PTY write asleep after its child exits. The writer
// must observe close independently, and its destructor must never send input.
#[cfg(any(target_os = "linux", all(test, unix)))]
struct LinuxPtyWriter {
    file: std::fs::File,
    closed: Arc<AtomicBool>,
}

#[cfg(any(target_os = "linux", all(test, unix)))]
impl LinuxPtyWriter {
    fn new(master: &dyn MasterPty, closed: Arc<AtomicBool>) -> Result<Self, String> {
        use std::os::fd::AsRawFd;
        // SAFETY: duplication produces an owned descriptor. Preserve the
        // original flags; O_NONBLOCK is shared with the separately owned reader.
        let fd = unsafe {
            libc::fcntl(
                master.as_raw_fd().ok_or("PTY descriptor unavailable")?,
                libc::F_DUPFD_CLOEXEC,
                0,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
        if flags < 0
            || unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(Self { file, closed })
    }
}

#[cfg(any(target_os = "linux", all(test, unix)))]
impl Write for LinuxPtyWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        use std::{io::ErrorKind, os::fd::AsRawFd};
        loop {
            if self.closed.load(Ordering::SeqCst) {
                return Err(std::io::Error::new(
                    ErrorKind::BrokenPipe,
                    "Terminal is closed.",
                ));
            }
            match self.file.write(bytes) {
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                result => return result,
            }
            let mut poll = libc::pollfd {
                fd: self.file.as_raw_fd(),
                events: libc::POLLOUT,
                revents: 0,
            };
            let result = unsafe { libc::poll(&mut poll, 1, 100) };
            if result < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() != ErrorKind::Interrupted {
                    return Err(error);
                }
            } else if poll.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                return Err(std::io::Error::new(
                    ErrorKind::BrokenPipe,
                    "Terminal is closed.",
                ));
            }
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub struct Terminal {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    #[cfg(not(unix))]
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    shell_pid: Option<u32>,
    shell_name: String,
    #[cfg(windows)]
    _job: Option<crate::providers::windows_job::Job>,
    closed: Arc<AtomicBool>,
    harness_session: Option<String>,
    run_script: bool,
}
impl Drop for Terminal {
    fn drop(&mut self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            #[cfg(windows)]
            drop(self._job.take());
            return;
        }
        #[cfg(windows)]
        if let Some(job) = self._job.take() {
            // Terminate descendants before dropping the ConPTY, whose close can
            // otherwise wait for a surviving process to release its output pipe.
            drop(job);
        } else if let Some(pid) = self.shell_pid {
            crate::providers::kill_group(pid);
        }
        #[cfg(unix)]
        unsafe {
            // Shells may ignore HUP, and foreground jobs have a separate process group.
            if let Some(group) = self.master.process_group_leader().filter(|pid| *pid > 1) {
                libc::kill(-group, libc::SIGKILL);
            }
            if let Some(pid) = self.shell_pid.filter(|pid| *pid > 1) {
                libc::kill(-(pid as i32), libc::SIGKILL);
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
        #[cfg(not(unix))]
        let _ = self.killer.kill();
    }
}
pub type Terminals = Arc<Mutex<HashMap<String, Terminal>>>;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalEvent {
    terminal_id: String,
    data: String,
    exit: bool,
    /// The output log's end offset after `data`, so a webview attaching to a running
    /// terminal can replay [`read_output`] and skip events it already replayed.
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<u64>,
}


/// Output a remote viewer polls (PandaConnect `terminal.read`), recorded next to the
/// webview's `terminal-event`. Each terminal keeps its last [`OUTPUT_LOG_BYTES`] at
/// monotonically increasing byte offsets; a log outlives its terminal so a viewer can read
/// the end of the output and the exit code, and only the newest [`KEPT_EXITED`] are kept.
pub const OUTPUT_LOG_BYTES: usize = 256 * 1024;
const KEPT_EXITED: usize = 8;

static OUTPUT_LOGS: LazyLock<Mutex<HashMap<String, OutputLog>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static OUTPUT_ORDER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
struct OutputLog {
    /// Always valid UTF-8: whole decoded chunks go in, eviction stops at a char boundary.
    bytes: VecDeque<u8>,
    /// The offset of `bytes[0]`.
    start: u64,
    capacity: usize,
    info: TerminalInfo,
}

/// What `terminal.list` shows for one terminal.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub title: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// `shell`, `script` (the project's run script) or `harness` (a harness console).
    pub kind: &'static str,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip)]
    order: u64,
}

/// One page of output after a viewer's offset.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputChunk {
    pub data: String,
    /// The offset to ask for next.
    pub next: u64,
    /// Bytes the viewer missed because they left the buffer before it asked.
    pub dropped: u64,
    /// True once the terminal ended and `data` reaches the end of its output.
    pub exited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

/// The bytes a char costs inside a JSON string.
fn json_cost(character: char) -> usize {
    match character {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
        c if (c as u32) < 0x20 => 6,
        c => c.len_utf8(),
    }
}

impl OutputLog {
    fn new(info: TerminalInfo, capacity: usize) -> Self {
        Self { bytes: VecDeque::new(), start: 0, capacity, info }
    }

    fn end(&self) -> u64 {
        self.start + self.bytes.len() as u64
    }

    fn push(&mut self, data: &str) {
        self.bytes.extend(data.as_bytes());
        if self.bytes.len() > self.capacity {
            let mut excess = self.bytes.len() - self.capacity;
            // Never leave a partial codepoint at the front.
            while self.bytes.get(excess).is_some_and(|byte| byte & 0xC0 == 0x80) {
                excess += 1;
            }
            self.bytes.drain(..excess);
            self.start += excess as u64;
        }
    }

    /// Output after `after`, at most `budget` bytes once JSON-escaped, cut at a char boundary.
    fn read(&self, after: u64, budget: usize) -> OutputChunk {
        let dropped = self.start.saturating_sub(after);
        // An offset past the end (a viewer from before a restart) resumes at the end.
        let mut index = (after.clamp(self.start, self.end()) - self.start) as usize;
        while self.bytes.get(index).is_some_and(|byte| byte & 0xC0 == 0x80) {
            index += 1;
        }
        let raw: Vec<u8> = self.bytes.range(index..).take(budget).copied().collect();
        let valid = match std::str::from_utf8(&raw) {
            Ok(text) => text.len(),
            Err(error) => error.valid_up_to(),
        };
        let text = std::str::from_utf8(&raw[..valid]).unwrap_or_default();
        let (mut cost, mut taken) = (0, 0);
        for character in text.chars() {
            cost += json_cost(character);
            if cost > budget {
                break;
            }
            taken += character.len_utf8();
        }
        let next = self.start + (index + taken) as u64;
        let exited = !self.info.running && next == self.end();
        OutputChunk {
            data: text[..taken].to_owned(),
            next,
            dropped,
            exited,
            exit_code: if exited { self.info.exit_code } else { None },
        }
    }
}

fn output_logs() -> std::sync::MutexGuard<'static, HashMap<String, OutputLog>> {
    OUTPUT_LOGS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn log_start(id: &str, cwd: &Path, title: String, kind: &'static str, session_id: Option<String>) {
    let info = TerminalInfo {
        id: id.to_owned(),
        title,
        cwd: cwd.to_string_lossy().into_owned(),
        session_id,
        kind,
        running: true,
        exit_code: None,
        order: OUTPUT_ORDER.fetch_add(1, Ordering::SeqCst),
    };
    output_logs().insert(id.to_owned(), OutputLog::new(info, OUTPUT_LOG_BYTES));
}

/// Appends output and returns the log's new end offset.
fn log_output(id: &str, data: &str) -> Option<u64> {
    output_logs().get_mut(id).map(|log| {
        log.push(data);
        log.end()
    })
}

fn log_exit(id: &str, exit_code: Option<i32>) {
    let mut logs = output_logs();
    if let Some(log) = logs.get_mut(id) {
        log.info.running = false;
        log.info.exit_code = exit_code;
    }
    prune_exited(&mut logs, KEPT_EXITED);
}

/// Drops all but the newest `keep` logs of ended terminals.
fn prune_exited(logs: &mut HashMap<String, OutputLog>, keep: usize) {
    let mut exited: Vec<(u64, String)> = logs
        .values()
        .filter(|log| !log.info.running)
        .map(|log| (log.info.order, log.info.id.clone()))
        .collect();
    if exited.len() <= keep {
        return;
    }
    exited.sort_unstable();
    for (_, id) in &exited[..exited.len() - keep] {
        logs.remove(id);
    }
}

/// Every terminal with output a viewer can read, newest first.
pub fn output_list() -> Vec<TerminalInfo> {
    let mut list: Vec<TerminalInfo> = output_logs().values().map(|log| log.info.clone()).collect();
    list.sort_unstable_by_key(|info| std::cmp::Reverse(info.order));
    list
}

/// Output of terminal `id` after offset `after`, at most `budget` bytes of JSON string.
pub fn read_output(id: &str, after: u64, budget: usize) -> Result<OutputChunk, String> {
    output_logs()
        .get(id)
        .map(|log| log.read(after, budget))
        .ok_or_else(|| "Terminal is closed.".into())
}

/// Records which task a terminal belongs to (set by whoever opened it for that task).
pub fn tag_output(id: &str, session_id: &str) {
    if let Some(log) = output_logs().get_mut(id) {
        log.info.session_id = Some(session_id.to_owned());
    }
}

fn emit_output(app: &AppHandle, id: &str, data: String) {
    let offset = log_output(id, &data);
    let _ = app.emit(
        "terminal-event",
        TerminalEvent {
            terminal_id: id.to_owned(),
            data,
            exit: false,
            offset,
        },
    );
}

pub fn start(
    app: AppHandle,
    terms: Terminals,
    root: &Path,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let cmd = shell_command(
        cfg!(windows),
        &|name| std::env::var_os(name),
        &crate::providers::executable,
    );
    start_command(app, terms, root, size(cols, rows), cmd, None, false)
}

pub fn start_script(
    app: AppHandle,
    terms: Terminals,
    root: &Path,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let cmd = crate::run_script::command(root)?;
    start_command(app, terms, root, size(cols, rows), cmd, None, true)
}

fn shell_command(
    windows: bool,
    env: &impl Fn(&str) -> Option<OsString>,
    find: &impl Fn(&str) -> Option<PathBuf>,
) -> CommandBuilder {
    if windows {
        // Git Bash may export /bin/bash in SHELL, which ConPTY cannot execute.
        // Use a native Windows shell and pass flags as argv, never a command string.
        let native = |path: &PathBuf| {
            path.extension().is_some_and(|extension| {
                extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("com")
            })
        };
        if let Some(shell) = find("pwsh")
            .filter(native)
            .or_else(|| find("powershell").filter(native))
        {
            let mut cmd = CommandBuilder::new(shell);
            cmd.arg("-NoLogo");
            return cmd;
        }
        let mut cmd = CommandBuilder::new(
            env("ComSpec")
                .filter(|path| !path.is_empty())
                .unwrap_or_else(|| "cmd.exe".into()),
        );
        cmd.arg("/D");
        return cmd;
    }
    let mut cmd = CommandBuilder::new(
        env("SHELL")
            .filter(|path| !path.is_empty())
            .unwrap_or_else(|| "/bin/sh".into()),
    );
    cmd.arg("-l");
    cmd
}

pub struct HarnessContext<'a> {
    pub session_id: &'a str,
    pub provider: &'a str,
    pub resume_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub reasoning_effort: Option<&'a str>,
    pub mode: &'a str,
}

pub fn start_harness(
    app: AppHandle,
    terms: Terminals,
    root: &Path,
    context: HarnessContext<'_>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let cmd = harness_command(&context, root)?;
    start_command(
        app,
        terms,
        root,
        size(cols, rows),
        cmd,
        Some(context.session_id.into()),
        false,
    )
}

/// Reads SQLite, skill settings and skill folders: `start_harness` runs only inside
/// `crate::blocking` (`task_controls::start_harness_terminal`), never on the async runtime.
fn harness_command(context: &HarnessContext<'_>, root: &Path) -> Result<CommandBuilder, String> {
    crate::skill_manager::begin_launch(context.session_id);
    // Unrecoverable switches never refuse a console: they deny or ask (`launch_disabled`).
    let disabled = crate::skill_manager::launch_disabled(
        context.provider,
        root,
        crate::skill_manager::disabled_for(context.session_id),
    );
    let args = harness_arguments_with_skills(context, &disabled)?;
    let executable = crate::providers::executable(context.provider)
        .ok_or("Install this harness before opening its console.")?;
    if context.provider == "hermes" && executable.file_stem().is_some_and(|s| s == "hermes-acp") {
        return Err("Hermes ACP server does not have an interactive console. Install the `hermes` CLI for terminal chat, or continue in PandaCode.".into());
    }
    let mut cmd = crate::providers::pty_command(&executable)?;
    crate::provider_settings::apply_environment(context.provider, &mut cmd);
    for name in crate::providers::claude_auth::removed_environment(context.provider) {
        cmd.env_remove(name);
    }
    cmd.args(args);
    let existing = |key: &str| {
        crate::provider_settings::environment(context.provider)
            .into_iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
            .or_else(|| std::env::var(key).ok())
            .unwrap_or_default()
    };
    if let Some((key, value)) =
        crate::skill_manager::console_environment(context.provider, &disabled, || {
            existing("HERMES_EPHEMERAL_SYSTEM_PROMPT")
        })
    {
        cmd.env(key, value);
    }
    if matches!(context.provider, "claude" | "glm" | "mimo") {
        cmd.env_remove("CLAUDECODE");
    }
    if matches!(context.provider, "glm" | "mimo") {
        let (arguments, environment) = if context.provider == "glm" {
            (
                crate::providers::glm_arguments(),
                crate::providers::glm_environment()?,
            )
        } else {
            (
                crate::providers::mimo_arguments()?,
                crate::providers::mimo_environment()?,
            )
        };
        cmd.args(arguments);
        for name in [
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ZAI_API_KEY",
            "MIMO_API_KEY",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
        ] {
            cmd.env_remove(name);
        }
        for (key, value) in environment {
            cmd.env(key, value);
        }
    }
    if context.provider == "devin" {
        // The REPL runs its agent as a `devin acp` child, which would otherwise
        // wait for host credentials when PandaCode starts inside Devin Desktop.
        cmd.env_remove("ACP_BACKEND");
    }
    if context.provider == "opencode" {
        let permission = Some(existing("OPENCODE_PERMISSION")).filter(|text| !text.is_empty());
        for (key, value) in
            opencode_console_environment(context.mode, &disabled, root, permission.as_deref())
        {
            cmd.env(key, value);
        }
    }
    Ok(cmd)
}

/// An OpenCode console's skill denies: merged into the inline configuration, and also through
/// `OPENCODE_PERMISSION` (merged by OpenCode after every config layer), keeping any rules the
/// provider environment already set there. An agent the denies can't reach is only logged:
/// consoles have no reminder channel, and the Skills page reports that folder's OpenCode modes
/// as asked/none.
fn opencode_console_environment(
    mode: &str,
    disabled: &BTreeSet<String>,
    root: &Path,
    permission: Option<&str>,
) -> Vec<(&'static str, String)> {
    let inline = crate::skill_manager::opencode_configuration_at(
        &crate::providers::opencode_configuration(mode),
        disabled,
        root,
    );
    let mut environment = vec![("OPENCODE_CONFIG_CONTENT", inline)];
    if let Some(permission) = crate::skill_manager::opencode_permission(permission, disabled) {
        environment.push(("OPENCODE_PERMISSION", permission));
    }
    environment
}

fn harness_arguments_with_skills(
    context: &HarnessContext<'_>,
    disabled: &BTreeSet<String>,
) -> Result<Vec<String>, String> {
    let mut args = harness_arguments(context)?;
    args.extend(crate::skill_manager::console_arguments(
        context.provider,
        disabled,
    ));
    Ok(args)
}

fn harness_arguments(context: &HarnessContext<'_>) -> Result<Vec<String>, String> {
    let provider = context.provider;
    let resume_id = context.resume_id;
    if provider == "antigravity" {
        return Err("Antigravity's ACP server does not have an interactive console. Use its synced commands in the composer, or open the agy CLI separately.".into());
    }
    if provider == "hermes" {
        if let Some(exe) = crate::providers::executable("hermes") {
            if exe.file_stem().is_some_and(|s| s == "hermes-acp") {
                return Err("Hermes ACP server does not have an interactive console. Install the `hermes` CLI for terminal chat, or continue in PandaCode.".into());
            }
        }
    }
    if !matches!(provider, "codex" | "claude" | "kimi" | "glm" | "opencode" | "grok" | "mimo" | "pi" | "omp" | "github-copilot" | "muse" | "cline" | "devin" | "hermes" | "cursor") {
        return Err("Choose a supported coding harness.".into());
    }
    if provider == "github-copilot" {
        if resume_id.is_some() {
            return Err("Copilot CLI's interactive console cannot resume an ACP task. Continue the task in PandaCode instead.".into());
        }
        if context.mode != "ask" {
            return Err("Copilot CLI's interactive console cannot enforce this task's approval mode. Use task chat instead.".into());
        }
        if context.reasoning_effort.is_some() {
            return Err("Copilot CLI's interactive console does not accept PandaCode reasoning overrides.".into());
        }
        let mut args = vec!["--no-auto-update".into()];
        if let Some(model) = context
            .model
            .filter(|model| !model.is_empty() && *model != "default")
        {
            if model.len() > 200 || model.chars().any(char::is_control) {
                return Err("Invalid harness model.".into());
            }
            args.push(format!("--model={model}"));
        }
        return Ok(args);
    }
    if resume_id.is_some_and(|id| {
        id.is_empty()
            || id.len() > 160
            || !id.as_bytes()[0].is_ascii_alphanumeric()
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    }) {
        return Err("This harness session cannot be resumed in a console.".into());
    }
    let mut args = Vec::new();
    if let Some(id) = resume_id {
        args.push(
            match provider {
                "codex" | "muse" => "resume",
                "claude" | "glm" | "mimo" | "grok" | "devin" | "hermes" | "cursor" => "--resume",
                "cline" => "--id",
                _ => "--session",
            }
            .into(),
        );
        args.push(id.into());
    }
    if !crate::storage::valid_permission_mode(context.mode) {
        return Err("Choose a supported permission mode.".into());
    }
    match provider {
        "pi" | "omp" => {
            if context.mode != "full" { return Err("Pi console requires Full access. Use task chat for approval modes.".into()); }
        }
        "codex" => {
            let (sandbox, approval) = match context.mode {
                "plan" => ("read-only", "never"),
                "full" => ("danger-full-access", "never"),
                _ => ("workspace-write", "on-request"),
            };
            args.extend([
                "--sandbox".into(),
                sandbox.into(),
                "--ask-for-approval".into(),
                approval.into(),
            ]);
            if context.mode == "auto" {
                args.push("--approve-for-me".into());
            }
        }
        "claude" | "glm" | "mimo" => {
            let mode = match context.mode {
                "plan" => "plan",
                "full" => "bypassPermissions",
                "auto" => "acceptEdits",
                "review" => "auto",
                _ => "default",
            };
            args.extend(["--permission-mode".into(), mode.into()]);
            if context.mode == "full" {
                args.push("--allow-dangerously-skip-permissions".into());
            }
        }
        "muse" => {
            // The TUI's flags: approval policy plus the same sandbox posture as task runs.
            let approval = match context.mode {
                "auto" => "on-request",
                "full" => "never",
                _ => "untrusted",
            };
            args.extend(["--approval-mode".into(), approval.into()]);
            if context.mode == "full" {
                args.push("--disable-approval".into());
            }
            args.extend(crate::providers::muse_sandbox_args(context.mode).iter().map(|arg| (*arg).into()));
            // After `resume <id>` too: Muse takes options only after its subcommand.
            args.extend(crate::providers::privacy::muse_arguments().iter().map(|arg| (*arg).into()));
        }
        "opencode" => {
            args.extend([
                "--agent".into(),
                if context.mode == "plan" {
                    "plan"
                } else {
                    "build"
                }
                .into(),
            ]);
        }
        "grok" => {
            // The TUI has a native plan mode; ACP turns approximate it instead.
            let mode = if context.mode == "plan" {
                "plan"
            } else {
                crate::providers::grok_permission_mode(context.mode)
            };
            args.extend(["--no-auto-update".into(), "--permission-mode".into(), mode.into()]);
        }
        "devin" => {
            // The REPL's permission modes have no Plan; ACP tasks get Devin's own Plan mode.
            let mode = match context.mode {
                "plan" => return Err("Devin's console cannot start in Plan mode. Use task chat, or type /plan in the console.".into()),
                "full" => "dangerous",
                _ => "accept-edits",
            };
            args.extend(["--permission-mode".into(), mode.into()]);
        }
        "hermes" => {
            if context.mode == "full" {
                args.push("--yolo".into());
            }
        }
        "cursor" => match context.mode {
            "plan" => args.push("--plan".into()),
            "full" => args.push("--force".into()),
            _ => {}
        },
        "cline" => {
            args.push("-i".into());
            if context.mode == "plan" {
                args.push("--plan".into());
            } else if context.mode == "full" {
                args.extend(["--auto-approve".into(), "true".into()]);
            } else {
                // Cline CLI defaults --auto-approve to true unless explicitly turned off.
                // For approval modes (ask, review, auto), enforce manual tool confirmation.
                args.extend(["--auto-approve".into(), "false".into()]);
            }
        }
        _ => {
            match context.mode {
                "plan" => args.push("--plan".into()),
                // Kimi's names differ: YOLO uses automatic review; auto bypasses it.
                "auto" => args.push("--yolo".into()),
                "full" => args.push("--auto".into()),
                _ => {}
            }
        }
    }
    if let Some(model) = context
        .model
        .filter(|model| !model.is_empty() && *model != "default")
    {
        if model.len() > 200 || model.chars().any(char::is_control) {
            return Err("Invalid harness model.".into());
        }
        args.extend(["--model".into(), model.into()]);
    } else if provider == "glm" {
        args.extend(["--model".into(), "glm-5.3".into()]);
    } else if provider == "mimo" {
        args.extend(["--model".into(), "mimo-v2.6-pro".into()]);
    }
    if let Some(effort) = context.reasoning_effort {
        crate::providers::validate_reasoning_effort(provider, Some(effort))?;
        match provider {
            "codex" => args.extend([
                "--config".into(),
                format!("model_reasoning_effort=\"{effort}\""),
            ]),
            "claude" | "glm" | "mimo" => args.extend(["--effort".into(), effort.into()]),
            "grok" => args.extend(["--reasoning-effort".into(), effort.into()]),
            "pi" | "omp" | "cline" => args.extend(["--thinking".into(), effort.into()]),
            "muse" => args.extend(["--reasoning-effort".into(), effort.into()]),
            // The Kimi TUI restores its persisted thinking setting; Cursor's
            // effort parameter is named per model, so its CLI keeps the saved one.
            _ => {}
        }
    }
    // Never pass a slash command as a positional prompt, invoke a shell, or alter
    // the harness's approval policy. TUI input is supplied by the user after launch.
    Ok(args)
}

pub fn harness_running(terms: &Terminals, session_id: &str) -> Result<bool, String> {
    let terms = terms
        .lock()
        .map_err(|_| "Terminal registry is unavailable")?;
    Ok(terms.values().any(|terminal| {
        terminal.harness_session.as_deref() == Some(session_id)
            && !terminal.closed.load(Ordering::SeqCst)
    }))
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalActivity {
    pub running: bool,
    pub process_names: Vec<String>,
    pub uncertain: bool,
}

#[derive(Debug)]
struct TerminalProcess {
    pid: u32,
    parent: u32,
    name: String,
    exited: bool,
}

fn process_name(command: &str) -> String {
    command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .trim_start_matches('-')
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect()
}

/// Closing is the only time we inspect processes. Never hold the terminal
/// registry while querying the OS, so output, input, and resizing stay responsive.
pub fn activity(terms: &Terminals, id: &str) -> Result<TerminalActivity, String> {
    let (pid, shell_name, managed_command, closed) = {
        let terms = terms
            .lock()
            .map_err(|_| "Terminal registry is unavailable")?;
        let Some(terminal) = terms.get(id) else {
            return Ok(TerminalActivity::default());
        };
        (
            terminal.shell_pid,
            terminal.shell_name.clone(),
            terminal.harness_session.is_some() || terminal.run_script,
            terminal.closed.clone(),
        )
    };
    if closed.load(Ordering::SeqCst) {
        return Ok(TerminalActivity::default());
    }
    if managed_command {
        return Ok(TerminalActivity {
            running: true,
            process_names: vec![shell_name],
            uncertain: false,
        });
    }
    let result = pid
        .and_then(|pid| {
            process_snapshot()
                .ok()
                .map(|processes| activity_from_processes(pid, &shell_name, &processes))
        })
        .unwrap_or(TerminalActivity {
            uncertain: true,
            ..TerminalActivity::default()
        });
    // The terminal may have exited or been closed while the snapshot was taken.
    Ok(if closed.load(Ordering::SeqCst) {
        TerminalActivity::default()
    } else {
        result
    })
}

fn activity_from_processes(
    pid: u32,
    shell_name: &str,
    processes: &[TerminalProcess],
) -> TerminalActivity {
    let Some(root) = processes.iter().find(|process| process.pid == pid) else {
        return TerminalActivity::default();
    };
    let mut children: HashMap<u32, Vec<&TerminalProcess>> = HashMap::new();
    for process in processes {
        children.entry(process.parent).or_default().push(process);
    }
    let mut names = BTreeSet::new();
    // An `exec server` replaces the shell without adding a descendant.
    if !root.exited && !root.name.eq_ignore_ascii_case(shell_name) {
        names.insert(root.name.clone());
    }
    let mut pending = vec![pid];
    let mut visited = HashSet::from([pid]);
    while let Some(parent) = pending.pop() {
        for process in children.get(&parent).into_iter().flatten() {
            if !visited.insert(process.pid) {
                continue;
            }
            pending.push(process.pid);
            // ConPTY's host belongs to the terminal itself, not a user's job.
            let console_host = cfg!(windows)
                && matches!(
                    process.name.to_ascii_lowercase().as_str(),
                    "conhost.exe" | "openconsole.exe"
                );
            if !process.exited && !console_host {
                names.insert(process.name.clone());
            }
        }
    }
    TerminalActivity {
        running: !names.is_empty(),
        process_names: names.into_iter().take(8).collect(),
        uncertain: false,
    }
}

#[cfg(unix)]
fn process_snapshot() -> Result<Vec<TerminalProcess>, String> {
    let mut command = std::process::Command::new("/bin/ps");
    // `comm` supplies executable names only: arguments may contain credentials.
    command
        .args(["-A", "-o", "pid=,ppid=,stat=,comm="])
        .env("LC_ALL", "C");
    let output = crate::workspace::run_process(
        command,
        "Terminal activity",
        2 * 1024 * 1024,
        std::time::Duration::from_secs(2),
    )?;
    if !output.status.success() || output.stdout.truncated {
        return Err("Process snapshot is unavailable".into());
    }
    parse_unix_processes(&String::from_utf8_lossy(&output.stdout.bytes))
}

#[cfg(any(unix, test))]
fn parse_unix_processes(text: &str) -> Result<Vec<TerminalProcess>, String> {
    fn word<'a>(line: &mut &'a str) -> Option<&'a str> {
        *line = line.trim_start();
        let end = line.find(char::is_whitespace)?;
        let result = &line[..end];
        *line = &line[end..];
        Some(result)
    }
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|mut line| {
            let pid = word(&mut line)
                .and_then(|value| value.parse().ok())
                .ok_or("Invalid process ID")?;
            let parent = word(&mut line)
                .and_then(|value| value.parse().ok())
                .ok_or("Invalid parent process ID")?;
            let exited = word(&mut line)
                .ok_or("Invalid process state")?
                .starts_with('Z');
            let name = process_name(line.trim());
            if name.is_empty() {
                return Err("Missing process name".into());
            }
            Ok(TerminalProcess {
                pid,
                parent,
                name,
                exited,
            })
        })
        .collect()
}

#[cfg(windows)]
fn process_snapshot() -> Result<Vec<TerminalProcess>, String> {
    let system = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    let mut command =
        std::process::Command::new(system.join("System32/WindowsPowerShell/v1.0/powershell.exe"));
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name)"]);
    let output = crate::workspace::run_process(
        command,
        "Terminal activity",
        2 * 1024 * 1024,
        std::time::Duration::from_secs(3),
    )?;
    if !output.status.success() || output.stdout.truncated {
        return Err("Process snapshot is unavailable".into());
    }
    parse_windows_processes(&String::from_utf8_lossy(&output.stdout.bytes))
}

#[cfg(any(windows, test))]
fn parse_windows_processes(text: &str) -> Result<Vec<TerminalProcess>, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Process {
        process_id: u32,
        parent_process_id: u32,
        name: String,
    }
    let processes: Vec<Process> = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|_| "Invalid process snapshot")?;
    Ok(processes
        .into_iter()
        .map(|process| TerminalProcess {
            pid: process.process_id,
            parent: process.parent_process_id,
            name: process_name(&process.name),
            exited: false,
        })
        .collect())
}

#[cfg(not(any(unix, windows)))]
fn process_snapshot() -> Result<Vec<TerminalProcess>, String> {
    Err("Process inspection is unavailable".into())
}

// Shell tabs are created on demand per task; only duplicate harness sessions are blocked.
fn check_start<'a>(
    terminals: impl Iterator<Item = (Option<&'a str>, bool)>,
    harness_session: Option<&str>,
) -> Result<(), String> {
    for (session, closed) in terminals {
        if harness_session.is_some() && session == harness_session && !closed {
            return Err("This task already has an open harness console.".into());
        }
    }
    Ok(())
}

fn start_command(
    app: AppHandle,
    terms: Terminals,
    root: &Path,
    pty_size: PtySize,
    mut cmd: CommandBuilder,
    harness_session: Option<String>,
    run_script: bool,
) -> Result<String, String> {
    crate::child_env::sanitize(&mut cmd);
    let mut registry = terms.lock().map_err(|e| e.to_string())?;
    check_start(
        registry.values().map(|terminal| {
            (terminal.harness_session.as_deref(), terminal.closed.load(Ordering::SeqCst))
        }),
        harness_session.as_deref(),
    )?;
    let pty = native_pty_system()
        .openpty(pty_size)
        .map_err(|e| e.to_string())?;
    cmd.cwd(root);
    cmd.env("TERM", "xterm-256color");
    // Allocate handles before spawning, so an allocation error cannot orphan a shell.
    #[cfg(unix)]
    let (mut reader, reader_fd) = {
        let fd = unsafe {
            libc::fcntl(
                pty.master.as_raw_fd().ok_or("PTY descriptor unavailable")?,
                libc::F_DUPFD_CLOEXEC,
                0,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let reader = unsafe { std::fs::File::from_raw_fd(fd) };
        (Box::new(reader) as Box<dyn Read + Send>, fd)
    };
    #[cfg(not(unix))]
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let closed = Arc::new(AtomicBool::new(false));
    #[cfg(target_os = "linux")]
    let writer: Box<dyn Write + Send> =
        Box::new(LinuxPtyWriter::new(pty.master.as_ref(), closed.clone())?);
    #[cfg(not(target_os = "linux"))]
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let writer = Arc::new(Mutex::new(writer));
    let shell_name = cmd.get_argv().first().map(|name| process_name(&name.to_string_lossy())).unwrap_or_default();
    let title = if run_script { "Run script".to_owned() } else { shell_name.clone() };
    let mut child = pty
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Cannot start terminal: {e}"))?;
    #[cfg(windows)]
    let job = child
        .process_id()
        .and_then(crate::providers::windows_job::Job::attach);
    #[cfg(not(unix))]
    let killer = child.clone_killer();
    let shell_pid = child.process_id();
    let reader_closed = closed.clone();
    drop(pty.slave);
    let id = crate::storage::id();
    let log_session = harness_session.clone();
    registry.insert(
        id.clone(),
        Terminal {
            master: pty.master,
            writer,
            #[cfg(not(unix))]
            killer,
            shell_pid,
            shell_name,
            #[cfg(windows)]
            _job: job,
            closed,
            harness_session,
            run_script,
        },
    );
    drop(registry);
    let kind = if log_session.is_some() {
        "harness"
    } else if run_script {
        "script"
    } else {
        "shell"
    };
    log_start(&id, root, title, kind, log_session);
    let tid = id.clone();
    let registry = terms.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        loop {
            // ClosePseudoConsole may block while unread output remains on older
            // Windows. Keep draining there until EOF, even after UI closure.
            #[cfg(not(windows))]
            if reader_closed.load(Ordering::SeqCst) {
                break;
            }
            #[cfg(unix)]
            {
                // Poll an owned descriptor so close can stop the reader even if a
                // descendant keeps the slave descriptor open without producing output.
                let mut poll = libc::pollfd {
                    fd: reader_fd,
                    events: libc::POLLIN,
                    revents: 0,
                };
                let result = unsafe { libc::poll(&mut poll, 1, 100) };
                if result == 0 {
                    continue;
                }
                if result < 0 {
                    if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    break;
                }
            }
            match reader.read(&mut buf) {
                #[cfg(target_os = "linux")]
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    continue
                }
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if reader_closed.load(Ordering::SeqCst) {
                        pending.clear();
                        continue;
                    }
                    pending.extend_from_slice(&buf[..n]);
                    // Preserve UTF-8 codepoints split across PTY reads.
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) => e.valid_up_to(),
                    };
                    if valid > 0 {
                        let data = String::from_utf8_lossy(&pending[..valid]).to_string();
                        pending.drain(..valid);
                        emit_output(&app, &tid, data);
                    }
                    if pending.len() > 4 {
                        let data = String::from_utf8_lossy(&pending).to_string();
                        pending.clear();
                        emit_output(&app, &tid, data);
                    }
                }
            }
        }
        drop(reader);
        let status = child.wait();
        log_exit(&tid, status.ok().map(|status| status.exit_code() as i32));
        // The shell is reaped; do not signal a potentially reused process ID.
        reader_closed.store(true, Ordering::SeqCst);
        let terminal = registry.lock().ok().and_then(|mut m| m.remove(&tid));
        drop(terminal);
        let _ = app.emit(
            "terminal-event",
            TerminalEvent {
                terminal_id: tid,
                data: String::new(),
                exit: true,
                offset: None,
            },
        );
    });
    Ok(id)
}
fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.clamp(10, 500),
        rows: rows.clamp(2, 200),
        pixel_width: 0,
        pixel_height: 0,
    }
}
pub fn write(terms: &Terminals, id: &str, data: &str) -> Result<(), String> {
    if data.len() > 64 * 1024 {
        return Err("Terminal input exceeds 64 KiB.".into());
    }
    let writer = {
        let terms = terms.lock().map_err(|e| e.to_string())?;
        terms.get(id).ok_or("Terminal is closed.")?.writer.clone()
    };
    let mut writer = writer.lock().map_err(|e| e.to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}
pub fn resize(terms: &Terminals, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let terms = terms.lock().map_err(|e| e.to_string())?;
    terms
        .get(id)
        .ok_or("Terminal is closed.")?
        .master
        .resize(size(cols, rows))
        .map_err(|e| e.to_string())
}
pub fn close(terms: &Terminals, id: &str) -> Result<(), String> {
    output_logs().remove(id);
    let terminal = terms.lock().map_err(|e| e.to_string())?.remove(id);
    drop(terminal);
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};

    #[test]
    fn skill_manager_console_enforces_claude_family_and_uses_advisory_channels() {
        let disabled = BTreeSet::from(["writer:edit".into()]);
        for provider in ["claude", "glm", "mimo"] {
            let context = HarnessContext {
                session_id: "fixture",
                provider,
                resume_id: Some("existing"),
                model: None,
                reasoning_effort: None,
                mode: "ask",
            };
            let args = harness_arguments_with_skills(&context, &disabled).unwrap();
            assert_eq!(
                args.iter()
                    .filter(|a| a.starts_with("--disallowedTools"))
                    .collect::<Vec<_>>(),
                ["--disallowedTools=Skill(writer:edit)"]
            );
            assert!(args.windows(2).any(|a| a == ["--resume", "existing"]));
        }
        for (provider, flag) in [
            ("pi", "--append-system-prompt"),
            ("omp", "--append-system-prompt"),
            ("grok", "--rules"),
        ] {
            let args = crate::skill_manager::console_arguments(provider, &disabled);
            assert_eq!(args[0], flag);
            assert!(args[1].contains("Do not use these skills in this session: writer:edit."));
        }
        assert!(crate::skill_manager::console_arguments("kimi", &disabled).is_empty());
        assert!(crate::skill_manager::console_arguments("claude", &BTreeSet::new()).is_empty());
    }

    #[test]
    fn skill_manager_console_overrides_and_missing_channels_are_explicit() {
        let disabled = BTreeSet::from(["review".into()]);
        let context = HarnessContext {
            session_id: "fixture",
            provider: "codex",
            resume_id: None,
            model: None,
            reasoning_effort: None,
            mode: "ask",
        };
        let args = harness_arguments_with_skills(&context, &disabled).unwrap();
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-c" && pair[1].starts_with("skills.config=")));
        for id in [
            "kimi",
            "antigravity",
            "deepseek",
            "commandcode",
            "kilo",
            "zcode",
        ] {
            assert!(crate::skill_manager::console_arguments(id, &disabled).is_empty());
        }
    }

    #[test]
    fn skill_manager_unrecoverable_settings_open_every_console_with_denies_or_the_off_reminder() {
        let all = BTreeSet::from(["*".to_string()]);
        // Codex: a deny for every skill installed for it, never a refusal.
        let codex = crate::skill_manager::launch_disabled_with("codex", all.clone(), || {
            BTreeSet::from(["review".into()])
        });
        let context = HarnessContext {
            session_id: "fixture",
            provider: "codex",
            resume_id: None,
            model: None,
            reasoning_effort: None,
            mode: "ask",
        };
        let args = harness_arguments_with_skills(&context, &codex).unwrap();
        assert!(
            args.windows(2).any(|pair| pair[0] == "-c"
                && pair[1].contains("review")
                && pair[1].contains("enabled=false")),
            "{args:?}"
        );
        // Claude family: the all-skills tool deny.
        let context = HarnessContext {
            session_id: "fixture",
            provider: "claude",
            resume_id: None,
            model: None,
            reasoning_effort: None,
            mode: "ask",
        };
        assert!(harness_arguments_with_skills(&context, &all)
            .unwrap()
            .iter()
            .any(|arg| arg == "--disallowedTools=Skill"));
        // Ask-only consoles carry the reminder that skills are temporarily off.
        let context = HarnessContext {
            session_id: "fixture",
            provider: "pi",
            resume_id: None,
            model: None,
            reasoning_effort: None,
            mode: "full",
        };
        let args = harness_arguments_with_skills(&context, &all).unwrap();
        assert!(
            args.iter()
                .any(|arg| arg.starts_with("Skills are temporarily off")),
            "{args:?}"
        );
    }

    #[test]
    fn skill_manager_consoles_never_start_a_turn_the_user_did_not_type() {
        let disabled = BTreeSet::from(["review".into(), "Friendly skill".into()]);
        for provider in ["devin", "github-copilot", "opencode"] {
            let context = HarnessContext {
                session_id: "fixture",
                provider,
                resume_id: None,
                model: None,
                reasoning_effort: None,
                mode: "ask",
            };
            let plain = harness_arguments(&context).unwrap();
            assert_eq!(
                harness_arguments_with_skills(&context, &disabled).unwrap(),
                plain,
                "{provider}"
            );
            assert!(
                crate::skill_manager::console_arguments(provider, &disabled).is_empty(),
                "{provider}"
            );
        }
    }

    #[test]
    fn harness_console_uses_literal_resume_arguments_and_never_a_prompt() {
        for (provider, flag) in [
            ("codex", "resume"),
            ("claude", "--resume"),
            ("kimi", "--session"),
            ("glm", "--resume"),
            ("opencode", "--session"),
            ("cline", "--id"),
        ] {
            let context = HarnessContext {
                session_id: "task",
                provider,
                resume_id: Some("session_123"),
                model: Some("example-model"),
                reasoning_effort: None,
                mode: "ask",
            };
            let args = harness_arguments(&context).unwrap();
            assert_eq!(&args[..2], &[flag, "session_123"]);
            assert!(!args
                .iter()
                .any(|arg| arg == "-p" || arg == "--prompt" || arg.starts_with('/')));
            assert!(args
                .windows(2)
                .any(|args| args == ["--model", "example-model"]));
        }
        for id in ["--last", "id\n/prompt", "id; echo bad", "../rollout"] {
            let context = HarnessContext {
                session_id: "task",
                provider: "codex",
                resume_id: Some(id),
                model: None,
                reasoning_effort: None,
                mode: "ask",
            };
            assert!(harness_arguments(&context).is_err());
        }
    }
    #[test]
    fn pi_console_requires_full_access_and_takes_thinking_and_resume() {
        let context = HarnessContext {
            session_id: "task",
            provider: "pi",
            resume_id: Some("01a15ba3-9096-76db-bd69-35168c0ecfa9"),
            model: Some("anthropic/sonnet"),
            reasoning_effort: Some("xhigh"),
            mode: "full",
        };
        let args = harness_arguments(&context).unwrap();
        // The TUI may offer to fork a session from another folder, so it takes `--session`.
        assert_eq!(&args[..2], &["--session", "01a15ba3-9096-76db-bd69-35168c0ecfa9"]);
        assert!(args.windows(2).any(|args| args == ["--model", "anthropic/sonnet"]));
        assert!(args.windows(2).any(|args| args == ["--thinking", "xhigh"]));
        for mode in ["ask", "auto", "plan"] {
            assert!(harness_arguments(&HarnessContext { mode, ..context }).unwrap_err().contains("Full access"));
        }
        assert!(harness_arguments(&HarnessContext { reasoning_effort: Some("max"), ..context }).is_err());
    }

    #[test]
    fn muse_console_resumes_with_the_task_mode_model_and_effort() {
        let context = HarnessContext {
            session_id: "task",
            provider: "muse",
            resume_id: Some("01a16681-4036-7383-ab96-9dd8865524d8"),
            model: Some("muse-spark-1.3"),
            reasoning_effort: Some("low"),
            mode: "plan",
        };
        let args = harness_arguments(&context).unwrap();
        assert_eq!(&args[..2], &["resume", "01a16681-4036-7383-ab96-9dd8865524d8"]);
        for pair in [["--approval-mode", "untrusted"], ["--model", "muse-spark-1.3"], ["--reasoning-effort", "low"]] {
            assert!(args.windows(2).any(|args| args == pair), "{args:?}");
        }
        assert!(args.contains(&"--disable-write".to_owned()) && args.contains(&"--disable-shell".to_owned()));
        // The telemetry opt-out follows `resume <id>`: Muse takes options only after it.
        crate::providers::privacy::FORCE.with(|force| force.set(Some(true)));
        let private = harness_arguments(&context).unwrap();
        crate::providers::privacy::FORCE.with(|force| force.set(None));
        assert_eq!(&private[..2], &["resume", "01a16681-4036-7383-ab96-9dd8865524d8"]);
        let at = private.windows(2).position(|pair| pair == ["-c", "telemetry.enabled=false"]).expect("opt-out");
        assert!(at >= 2);
        assert_eq!([&private[..at], &private[at + 2..]].concat(), args);
        let full = harness_arguments(&HarnessContext { mode: "full", resume_id: None, ..context }).unwrap();
        assert!(full.contains(&"--disable-approval".to_owned()) && full.contains(&"--disable-sandbox".to_owned()));
    }

    #[test]
    fn cline_console_sets_tui_mode_effort_and_resume() {
        let context = HarnessContext {
            session_id: "task",
            provider: "cline",
            resume_id: None,
            model: Some("anthropic/claude-sonnet-5.5"),
            reasoning_effort: Some("high"),
            mode: "plan",
        };
        let args = harness_arguments(&context).unwrap();
        assert_eq!(
            args,
            [
                "-i",
                "--plan",
                "--model",
                "anthropic/claude-sonnet-5.5",
                "--thinking",
                "high"
            ]
        );

        let full_context = HarnessContext {
            session_id: "task",
            provider: "cline",
            resume_id: Some("1792719287191_NBdt7_cli"),
            model: None,
            reasoning_effort: None,
            mode: "full",
        };
        let full_args = harness_arguments(&full_context).unwrap();
        assert_eq!(
            full_args,
            ["--id", "1792719287191_NBdt7_cli", "-i", "--auto-approve", "true"]
        );

        let ask_context = HarnessContext {
            session_id: "task",
            provider: "cline",
            resume_id: None,
            model: None,
            reasoning_effort: None,
            mode: "ask",
        };
        let ask_args = harness_arguments(&ask_context).unwrap();
        assert_eq!(ask_args, ["-i", "--auto-approve", "false"]);
    }

    #[test]
    fn hermes_console_uses_resume_and_yolo_and_model() {
        let context = HarnessContext {
            session_id: "task",
            provider: "hermes",
            resume_id: Some("session-123"),
            model: Some("nous/hermes-3-llama-3.1-405b"),
            reasoning_effort: None,
            mode: "full",
        };
        let args = harness_arguments(&context).unwrap();
        assert_eq!(args, ["--resume", "session-123", "--yolo", "--model", "nous/hermes-3-llama-3.1-405b"]);
    }

    #[test]
    fn cursor_console_resumes_with_its_mode_and_model() {
        let context = HarnessContext {
            session_id: "task",
            provider: "cursor",
            resume_id: Some("aa1e2638-6c14-4a30-8eb8-e7ad3e2238ce"),
            model: Some("gpt-5.5"),
            reasoning_effort: Some("high"),
            mode: "plan",
        };
        let args = harness_arguments(&context).unwrap();
        assert_eq!(args, ["--resume", "aa1e2638-6c14-4a30-8eb8-e7ad3e2238ce", "--plan", "--model", "gpt-5.5"]);
        let full = harness_arguments(&HarnessContext { resume_id: None, model: None, reasoning_effort: None, mode: "full", ..context }).unwrap();
        assert_eq!(full, ["--force"]);
        let standard = harness_arguments(&HarnessContext { resume_id: None, model: None, reasoning_effort: None, mode: "ask", ..context }).unwrap();
        assert!(standard.is_empty());
    }

    #[test]
    fn copilot_console_uses_the_direct_cli_only_when_task_controls_are_not_needed() {
        let context = HarnessContext {
            session_id: "task",
            provider: "github-copilot",
            resume_id: None,
            model: Some("default"),
            reasoning_effort: None,
            mode: "ask",
        };
        assert_eq!(harness_arguments(&context).unwrap(), ["--no-auto-update"]);
        let selected_model = harness_arguments(&HarnessContext {
            model: Some("claude-sonnet-4.5"),
            ..context
        })
        .unwrap();
        assert_eq!(selected_model, ["--no-auto-update", "--model=claude-sonnet-4.5"]);
        for mode in ["auto", "plan", "full"] {
            assert!(harness_arguments(&HarnessContext { mode, ..context })
                .unwrap_err()
                .contains("cannot enforce"));
        }
        assert!(harness_arguments(&HarnessContext {
            resume_id: Some("copilot-session"),
            ..context
        })
        .unwrap_err()
        .contains("cannot resume"));
    }

    #[test]
    fn harness_console_explicitly_preserves_restricted_permissions() {
        let context = HarnessContext {
            session_id: "task",
            provider: "codex",
            resume_id: None,
            model: None,
            reasoning_effort: Some("high"),
            mode: "plan",
        };
        let args = harness_arguments(&context).unwrap();
        assert!(args
            .windows(2)
            .any(|args| args == ["--sandbox", "read-only"]));
        assert!(args
            .windows(2)
            .any(|args| args == ["--ask-for-approval", "never"]));
        assert!(!args.iter().any(|arg| arg.contains("danger")));
        let context = HarnessContext {
            provider: "claude",
            mode: "ask",
            reasoning_effort: None,
            ..context
        };
        let args = harness_arguments(&context).unwrap();
        assert!(args
            .windows(2)
            .any(|args| args == ["--permission-mode", "default"]));
        assert!(!args.iter().any(|arg| arg.contains("danger")));
    }

    #[test]
    fn new_harness_consoles_preserve_modes_and_reject_acp_only_binary() {
        let context = HarnessContext {
            session_id: "task",
            provider: "opencode",
            resume_id: None,
            model: Some("provider/model"),
            reasoning_effort: None,
            mode: "plan",
        };
        let args = harness_arguments(&context).unwrap();
        assert!(args.windows(2).any(|args| args == ["--agent", "plan"]));
        assert!(!args.iter().any(|arg| arg == "--auto"));
        let args = harness_arguments(&HarnessContext {
            provider: "glm",
            mode: "ask",
            ..context
        })
        .unwrap();
        assert!(args
            .windows(2)
            .any(|args| args == ["--permission-mode", "default"]));
        assert!(harness_arguments(&HarnessContext {
            provider: "antigravity",
            ..context
        })
        .unwrap_err()
        .contains("ACP server"));
        // Grok Build's TUI resumes by ID and takes its native permission modes.
        let args = harness_arguments(&HarnessContext {
            provider: "grok",
            resume_id: Some("01a0c6e4-07e8-7751-a18f-902b23e7446c"),
            model: Some("grok-4.7"),
            reasoning_effort: Some("low"),
            mode: "plan",
            ..context
        })
        .unwrap();
        assert_eq!(
            args,
            [
                "--resume",
                "01a0c6e4-07e8-7751-a18f-902b23e7446c",
                "--no-auto-update",
                "--permission-mode",
                "plan",
                "--model",
                "grok-4.7",
                "--reasoning-effort",
                "low"
            ]
        );
        let full = harness_arguments(&HarnessContext { provider: "grok", mode: "full", ..context }).unwrap();
        assert!(full.windows(2).any(|args| args == ["--permission-mode", "bypassPermissions"]));
        // MiMo is Claude Code underneath: Claude flags, MiMo default model.
        let mimo = harness_arguments(&HarnessContext {
            provider: "mimo",
            model: None,
            mode: "auto",
            ..context
        })
        .unwrap();
        assert_eq!(mimo, ["--permission-mode", "acceptEdits", "--model", "mimo-v2.6-pro"]);
        // Approve for me is Claude Code's auto mode, as in task runs.
        for provider in ["claude", "glm", "mimo"] {
            let review = harness_arguments(&HarnessContext { provider, mode: "review", ..context }).unwrap();
            assert!(review.windows(2).any(|args| args == ["--permission-mode", "auto"]), "{provider}");
        }
    }

    struct TestShell {
        terms: Terminals,
        id: String,
        pid: u32,
        exited: mpsc::Receiver<()>,
    }
    impl Drop for TestShell {
        fn drop(&mut self) {
            // Failed assertions must not leave their intentionally stubborn shell running.
            unsafe {
                libc::kill(-(self.pid as i32), libc::SIGKILL);
            }
        }
    }

    fn shell(script: &str) -> TestShell {
        let pty = native_pty_system().openpty(size(80, 24)).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", script]);
        let mut child = pty.slave.spawn_command(command).unwrap();
        let pid = child.process_id().unwrap();
        drop(pty.slave);
        let mut reader = pty.master.try_clone_reader().unwrap();
        let closed = Arc::new(AtomicBool::new(false));
        #[cfg(target_os = "linux")]
        let writer: Box<dyn Write + Send> =
            Box::new(LinuxPtyWriter::new(pty.master.as_ref(), closed.clone()).unwrap());
        #[cfg(not(target_os = "linux"))]
        let writer = pty.master.take_writer().unwrap();
        let writer = Arc::new(Mutex::new(writer));
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (exit_tx, exited) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut buf = [0; 8192];
            let mut ready = false;
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                        ) =>
                    {
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(_) => break,
                };
                if !ready && String::from_utf8_lossy(&buf[..n]).contains("ready") {
                    ready = true;
                    let _ = ready_tx.send(());
                }
            }
            let _ = child.wait();
            let _ = exit_tx.send(());
        });
        let id = "terminal-under-test".to_string();
        let terms = Arc::new(Mutex::new(HashMap::from([(
            id.clone(),
            Terminal {
                master: pty.master,
                writer,
                shell_pid: Some(pid),
                shell_name: "sh".into(),
                closed,
                harness_session: None,
                run_script: false,
            },
        )])));
        ready_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("Shell did not become ready");
        TestShell {
            terms,
            id,
            pid,
            exited,
        }
    }

    #[test]
    fn terminal_activity_distinguishes_idle_shells_from_foreground_background_and_exec_jobs() {
        for (script, busy) in [
            ("printf ready; read line", false),
            ("sleep 30 & printf ready; read line", true),
            ("printf ready; sleep 30; :", true),
            ("printf ready; exec sleep 30", true),
        ] {
            let shell = shell(script);
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            let result = loop {
                let result = activity(&shell.terms, &shell.id).unwrap();
                if result.running == busy || std::time::Instant::now() >= deadline {
                    break result;
                }
                std::thread::sleep(Duration::from_millis(10));
            };
            assert_eq!(result.running, busy, "{script}: {result:?}");
            assert!(!result.uncertain, "{script}: {result:?}");
            if busy {
                assert!(result.process_names.iter().any(|name| name == "sleep"));
            }
            close(&shell.terms, &shell.id).unwrap();
            shell.exited.recv_timeout(Duration::from_secs(3)).unwrap();
            let result = activity(&shell.terms, &shell.id).unwrap();
            assert!(!result.running && !result.uncertain);
        }
    }

    #[test]
    fn terminal_activity_treats_an_open_harness_console_as_busy() {
        let shell = shell("printf ready; read line");
        shell.terms.lock().unwrap().get_mut(&shell.id).unwrap().harness_session = Some("task".into());
        let result = activity(&shell.terms, &shell.id).unwrap();
        assert!(result.running);
        assert!(!result.uncertain);
        close(&shell.terms, &shell.id).unwrap();
        shell.exited.recv_timeout(Duration::from_secs(3)).unwrap();
    }

    #[test]
    fn terminal_activity_treats_a_run_script_as_busy_even_between_child_processes() {
        let shell = shell("printf ready; read line");
        shell.terms.lock().unwrap().get_mut(&shell.id).unwrap().run_script = true;
        let result = activity(&shell.terms, &shell.id).unwrap();
        assert!(result.running);
        assert!(!result.uncertain);
        close(&shell.terms, &shell.id).unwrap();
        shell.exited.recv_timeout(Duration::from_secs(3)).unwrap();
    }

    #[test]
    fn terminal_activity_protects_a_live_terminal_when_process_identity_is_unknown() {
        let shell = shell("printf ready; read line");
        shell.terms.lock().unwrap().get_mut(&shell.id).unwrap().shell_pid = None;
        let result = activity(&shell.terms, &shell.id).unwrap();
        // Restore ownership before any assertions so fixture cleanup remains reliable.
        shell.terms.lock().unwrap().get_mut(&shell.id).unwrap().shell_pid = Some(shell.pid);
        assert!(result.uncertain);
        assert!(!result.running);
        close(&shell.terms, &shell.id).unwrap();
        shell.exited.recv_timeout(Duration::from_secs(3)).unwrap();
    }

    #[test]
    fn close_reaps_a_shell_that_ignores_hangup() {
        let shell = shell("trap '' HUP; printf ready; while :; do sleep 1; done");
        close(&shell.terms, &shell.id).unwrap();
        assert!(
            shell.exited.recv_timeout(Duration::from_secs(2)).is_ok(),
            "Shell ignoring SIGHUP survived terminal close"
        );
    }

    #[test]
    fn task_deletion_requires_harness_to_close_but_preserves_ordinary_shells() {
        let shell = shell("printf ready; exec sleep 30");
        let (mut state, project) = crate::concurrent_task_tests::test_state();
        let sid = state.store.lock().unwrap()
            .create_session(&project, "codex", "default", "ask").unwrap().id;
        Arc::get_mut(&mut state).unwrap().terminals = shell.terms.clone();
        shell.terms.lock().unwrap().get_mut(&shell.id).unwrap().harness_session = Some(sid.clone());
        assert!(crate::task_deletion::delete_state(&state, &sid).unwrap_err().contains("harness"));
        shell.terms.lock().unwrap().get_mut(&shell.id).unwrap().harness_session = None;
        assert!(crate::task_deletion::delete_state(&state, &sid).is_ok());
        assert!(shell.terms.lock().unwrap().contains_key(&shell.id));
        close(&shell.terms, &shell.id).unwrap();
        shell.exited.recv_timeout(Duration::from_secs(3)).unwrap();
    }

    #[test]
    fn close_is_not_blocked_by_a_full_terminal_input_buffer() {
        let shell =
            shell("trap '' HUP; stty -echo -icanon; printf ready; while :; do sleep 1; done");
        let terms = shell.terms.clone();
        let id = shell.id.clone();
        let (write_tx, write_rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let _ = write_tx.send(write(&terms, &id, &"x".repeat(64 * 1024)));
        });
        assert!(
            write_rx.recv_timeout(Duration::from_millis(150)).is_err(),
            "The test needs a blocked PTY writer"
        );
        let terms = shell.terms.clone();
        let id = shell.id.clone();
        let (close_tx, close_rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let _ = close_tx.send(close(&terms, &id));
        });
        close_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("Blocked writer prevented closing terminal")
            .unwrap();
        let write_result = write_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("Writer stayed blocked after close");
        if cfg!(target_os = "linux") {
            assert!(
                write_result.is_err(),
                "Closed terminal accepted pending input"
            );
        }
        assert!(
            shell.exited.recv_timeout(Duration::from_secs(2)).is_ok(),
            "Closed terminal left a reader or child alive"
        );
    }

    #[test]
    fn linux_writer_cancels_even_while_slave_remains_open_and_never_writes_on_drop() {
        let pty = native_pty_system().openpty(size(80, 24)).unwrap();
        let fd = pty.master.as_raw_fd().unwrap();
        let mut termios = std::mem::MaybeUninit::<libc::termios>::uninit();
        // SAFETY: get attributes initializes termios before use; setting raw mode
        // makes unconsumed input fill the PTY instead of being line-buffered.
        unsafe {
            assert_eq!(libc::tcgetattr(fd, termios.as_mut_ptr()), 0);
            let mut termios = termios.assume_init();
            libc::cfmakeraw(&mut termios);
            assert_eq!(libc::tcsetattr(fd, libc::TCSANOW, &termios), 0);
        }
        let closed = Arc::new(AtomicBool::new(false));
        let mut writer = LinuxPtyWriter::new(pty.master.as_ref(), closed.clone()).unwrap();
        let (tx, rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let result = writer.write_all(&vec![b'x'; 64 * 1024]);
            drop(writer);
            let _ = tx.send(result);
        });
        assert!(
            rx.recv_timeout(Duration::from_millis(150)).is_err(),
            "The fixture needs a full PTY input buffer"
        );
        closed.store(true, Ordering::SeqCst);
        let error = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("Closed writer or its destructor remained blocked")
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
        drop(pty.slave);
    }
}

#[cfg(test)]
mod platform_tests {
    use super::*;

    #[test]
    fn terminal_activity_parses_process_names_without_arguments_and_tracks_nested_jobs() {
        let snapshot = parse_unix_processes("  10 1 S+ /bin/zsh\n 12 10 S bash\n 13 12 S /Program Files/worker name\n 14 10 Z old-job\n 15 100 S unrelated\n").unwrap();
        let activity = activity_from_processes(10, "zsh", &snapshot);
        assert!(activity.running && !activity.uncertain);
        assert_eq!(activity.process_names, ["bash", "worker name"]);
        assert!(!activity_from_processes(999, "zsh", &snapshot).running);
        assert!(parse_unix_processes("10 missing fields").is_err());
        let idle = parse_unix_processes("10 1 S /bin/zsh\n14 10 Z zombie\n").unwrap();
        assert!(!activity_from_processes(10, "zsh", &idle).running);
    }

    #[test]
    fn terminal_activity_reads_windows_cim_processes_and_preserves_name_spaces() {
        let snapshot = parse_windows_processes(r#"[{"ProcessId":10,"ParentProcessId":1,"Name":"pwsh.exe"},{"ProcessId":20,"ParentProcessId":10,"Name":"node.exe"},{"ProcessId":30,"ParentProcessId":20,"Name":"worker app.exe"}]"#).unwrap();
        let activity = activity_from_processes(10, "pwsh.exe", &snapshot);
        assert!(activity.running && !activity.uncertain);
        assert_eq!(activity.process_names, ["node.exe", "worker app.exe"]);
        assert!(parse_windows_processes("not json").is_err());
        assert_eq!(
            process_name("C:\\Program Files\\PowerShell\\pwsh.exe"),
            "pwsh.exe"
        );
        assert_eq!(process_name("-zsh"), "zsh");
        assert_eq!(
            serde_json::to_value(activity).unwrap()["processNames"][0],
            "node.exe"
        );
    }

    #[test]
    fn opencode_console_denies_switched_off_skills_through_inline_config_and_permission() {
        let root = std::env::temp_dir();
        let disabled = BTreeSet::from(["review".to_string()]);
        let environment: std::collections::BTreeMap<_, _> =
            opencode_console_environment("default", &disabled, &root, Some(r#"{"bash":"ask"}"#))
                .into_iter()
                .collect();
        let inline: serde_json::Value =
            serde_json::from_str(&environment["OPENCODE_CONFIG_CONTENT"]).unwrap();
        assert_eq!(inline["permission"]["skill"]["review"], "deny");
        assert_eq!(inline["permission"]["skill"]["review *"], "deny");
        // The provider's own OPENCODE_PERMISSION rules are kept; the denies end the skill map.
        assert_eq!(
            environment["OPENCODE_PERMISSION"],
            r#"{"bash":"ask","skill":{"review":"deny","review *":"deny"},"skill *":{"review":"deny","review *":"deny"}}"#
        );
        // Nothing switched off: no OPENCODE_PERMISSION is added.
        let environment = opencode_console_environment("default", &BTreeSet::new(), &root, None);
        assert_eq!(environment.len(), 1);
        assert_eq!(environment[0].0, "OPENCODE_CONFIG_CONTENT");
    }

    #[test]
    fn terminals_have_no_global_cap_but_reject_duplicate_harness_sessions() {
        let sessions = (0..12)
            .map(|index| format!("task-{index}"))
            .collect::<Vec<_>>();
        let consoles = sessions
            .iter()
            .map(|session| (Some(session.as_str()), false))
            .collect::<Vec<_>>();
        assert!(super::check_start(consoles.iter().copied(), Some("next-task")).is_ok());
        assert!(super::check_start(consoles.iter().copied(), None).is_ok());
        assert!(super::check_start(consoles.iter().copied(), Some("task-0")).is_err());
        let full = consoles
            .iter()
            .copied()
            .chain(std::iter::repeat_n((None, false), 32));
        assert!(super::check_start(full.clone(), Some("next-task")).is_ok());
        assert!(super::check_start(full, None).is_ok());
        assert!(super::check_start([(Some("task-0"), true)].into_iter(), Some("task-0")).is_ok());
    }

    #[test]
    fn windows_terminal_ignores_unix_shell_and_prefers_powershell() {
        let env = |name: &str| (name == "SHELL").then(|| "/bin/bash".into());
        let find = |name: &str| {
            (name == "pwsh").then(|| PathBuf::from("C:/Program Files/PowerShell/7/pwsh.exe"))
        };
        let cmd = shell_command(true, &env, &find);
        assert_eq!(
            cmd.get_argv(),
            &vec![
                OsString::from("C:/Program Files/PowerShell/7/pwsh.exe"),
                OsString::from("-NoLogo")
            ]
        );
        let find = |name: &str| {
            (name == "powershell")
                .then(|| PathBuf::from("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"))
        };
        assert_eq!(
            shell_command(true, &env, &find).get_argv()[0],
            "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
        );
        let find = |name: &str| {
            Some(PathBuf::from(if name == "pwsh" {
                "C:/tools/pwsh.cmd"
            } else {
                "C:/Windows/powershell.exe"
            }))
        };
        assert_eq!(
            shell_command(true, &env, &find).get_argv()[0],
            "C:/Windows/powershell.exe"
        );
    }

    #[test]
    fn terminal_uses_windows_command_processor_and_preserves_unix_login_shell() {
        let env = |name: &str| (name == "ComSpec").then(|| "C:/Windows/System32/cmd.exe".into());
        assert_eq!(
            shell_command(true, &env, &|_| None).get_argv(),
            &vec![
                OsString::from("C:/Windows/System32/cmd.exe"),
                OsString::from("/D")
            ]
        );
        let env = |name: &str| (name == "SHELL").then(|| "/bin/zsh".into());
        assert_eq!(
            shell_command(false, &env, &|_| None).get_argv(),
            &vec![OsString::from("/bin/zsh"), OsString::from("-l")]
        );
        assert_eq!(
            shell_command(false, &|_| Some(OsString::new()), &|_| None).get_argv()[0],
            "/bin/sh"
        );
    }
}

#[cfg(test)]
mod output_tests {
    use super::*;

    fn info(id: &str, order: u64) -> TerminalInfo {
        TerminalInfo {
            id: id.into(),
            title: "zsh".into(),
            cwd: "/tmp".into(),
            session_id: None,
            kind: "shell",
            running: true,
            exit_code: None,
            order,
        }
    }

    #[test]
    fn terminal_output_reads_pages_at_increasing_offsets() {
        let mut log = OutputLog::new(info("a", 0), 64);
        log.push("hello ");
        log.push("world");
        let first = log.read(0, 1024);
        assert_eq!((first.data.as_str(), first.next, first.dropped, first.exited), ("hello world", 11, 0, false));
        assert_eq!(log.read(first.next, 1024).data, "");
        let page = log.read(0, 5);
        assert_eq!((page.data.as_str(), page.next), ("hello", 5));
        assert_eq!(log.read(page.next, 1024).data, " world");
        // An offset from before a restart resumes at the end.
        assert_eq!(log.read(999, 1024).next, 11);
    }

    #[test]
    fn terminal_output_evicts_the_oldest_bytes_and_reports_what_was_missed() {
        let mut log = OutputLog::new(info("a", 0), 8);
        log.push("0123456789");
        assert_eq!(log.start, 2);
        let chunk = log.read(0, 1024);
        assert_eq!((chunk.data.as_str(), chunk.dropped, chunk.next), ("23456789", 2, 10));
        log.push("ab");
        assert_eq!(log.read(10, 1024).data, "ab");
        assert_eq!(log.read(10, 1024).dropped, 0);
    }

    #[test]
    fn terminal_output_never_splits_a_codepoint() {
        // Eviction drops the rest of a codepoint it cut into.
        let mut log = OutputLog::new(info("a", 0), 5);
        log.push("aé€b"); // 1 + 2 + 3 + 1 bytes
        let chunk = log.read(0, 1024);
        assert!(chunk.data == "€b" && chunk.next == 7, "{chunk:?}");
        // Pages end before a codepoint that does not fit, and a mid-codepoint offset skips ahead.
        let mut log = OutputLog::new(info("a", 0), 64);
        log.push("é€");
        let page = log.read(0, 4);
        assert_eq!((page.data.as_str(), page.next), ("é", 2));
        assert_eq!(log.read(1, 1024).data, "€");
        assert_eq!(log.read(3, 1024), OutputChunk { data: String::new(), next: 5, dropped: 0, exited: false, exit_code: None });
    }

    #[test]
    fn terminal_output_budget_counts_json_escapes() {
        let mut log = OutputLog::new(info("a", 0), 64);
        log.push("\u{1b}[1mA");
        // ESC costs six bytes once escaped, so a seven-byte budget takes it and "[" only.
        let page = log.read(0, 7);
        assert_eq!((page.data.as_str(), page.next), ("\u{1b}[", 2));
        let json = serde_json::to_string(&log.read(0, 1024).data).unwrap();
        assert!(json.len() - 2 <= 1024);
    }

    #[test]
    fn terminal_output_reports_the_exit_only_after_the_last_byte() {
        let mut log = OutputLog::new(info("a", 0), 64);
        log.push("bye");
        log.info.running = false;
        log.info.exit_code = Some(3);
        let partial = log.read(0, 2);
        assert!(!partial.exited && partial.exit_code.is_none());
        let last = log.read(partial.next, 1024);
        assert!(last.exited && last.exit_code == Some(3) && last.data == "e");
        let json = serde_json::to_value(&last).unwrap();
        assert_eq!(json["exitCode"], 3);
        assert_eq!(json["next"], 3);
    }

    #[test]
    fn terminal_output_keeps_only_the_newest_exited_logs() {
        let mut logs = HashMap::new();
        for order in 0..5u64 {
            let mut log = OutputLog::new(info(&format!("t{order}"), order), 8);
            log.info.running = order == 0;
            logs.insert(log.info.id.clone(), log);
        }
        prune_exited(&mut logs, 2);
        let mut kept: Vec<_> = logs.keys().cloned().collect();
        kept.sort();
        assert_eq!(kept, ["t0", "t3", "t4"]);
    }

    #[test]
    fn terminal_output_list_and_read_use_the_shared_registry() {
        let id = "output-registry-test";
        log_start(id, Path::new("/work"), "zsh".into(), "shell", None);
        assert_eq!(log_output(id, "ls\r\n"), Some(4));
        assert_eq!(log_output("output-registry-missing", "x"), None);
        tag_output(id, "session-1");
        let listed = output_list().into_iter().find(|info| info.id == id).unwrap();
        assert_eq!(listed.session_id.as_deref(), Some("session-1"));
        assert!(listed.running);
        let value = serde_json::to_value(&listed).unwrap();
        assert_eq!(value["cwd"], "/work");
        assert!(value.get("order").is_none() && value.get("exitCode").is_none());
        assert_eq!(read_output(id, 0, 1024).unwrap().data, "ls\r\n");
        output_logs().remove(id);
        assert!(read_output(id, 0, 1024).is_err());
    }
}
