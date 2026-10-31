//! Claude's installed command catalog; discovery never submits a user prompt.
use super::{Catalog, Invocation, SlashCommand};
use crate::providers::{executable, ProcessGroup};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::Instant,
};

const MAX_COMMANDS: usize = 512;
const DISCOVERY_FAILED: &str =
    "Claude Code commands could not be loaded. Check the installed CLI and try again.";

pub async fn discover(cwd: &Path) -> Result<Catalog, String> {
    discover_for("claude", cwd).await
}

pub async fn discover_for(provider: &str, cwd: &Path) -> Result<Catalog, String> {
    let path = executable(provider).ok_or("Install Claude Code to discover its commands.")?;
    discover_process(
        discovery_command(&path, provider)?,
        cwd,
        Duration::from_secs(20),
    )
    .await
}

fn discovery_command(path: &Path, provider: &str) -> Result<Command, String> {
    let mut command = crate::providers::provider_command(provider, path)?;
    command.env_remove("CLAUDECODE");
    crate::providers::claude_auth::configure(&mut command, provider);
    command.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-prompt-tool",
        "stdio",
        "--no-session-persistence",
    ]);
    if matches!(provider, "glm" | "mimo") {
        let mut args = if provider == "glm" {
            crate::providers::glm_arguments()
        } else {
            crate::providers::mimo_arguments()?
        };
        let mut settings: Value = serde_json::from_str(args.last().unwrap()).unwrap();
        settings["disableAllHooks"] = json!(true);
        *args.last_mut().unwrap() = settings.to_string();
        command.args(args);
        // Metadata initialization requires no account. In particular, never
        // forward the user's regular Claude credential to the Z.AI endpoint.
        for name in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ZAI_API_KEY",
            "MIMO_API_KEY",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
        ] {
            command.env_remove(name);
        }
    } else {
        command.args(["--settings", r#"{"disableAllHooks":true}"#]);
    }
    Ok(command)
}

async fn discover_process(
    command: Command,
    cwd: &Path,
    timeout: Duration,
) -> Result<Catalog, String> {
    let mut pipe = Pipe::spawn(command, cwd, timeout).map_err(|_| DISCOVERY_FAILED.to_owned())?;
    let result = async {
        pipe.send(&json!({"type":"control_request","request_id":"pandacode-commands","request":{"subtype":"initialize","hooks":null}})).await?;
        loop {
            let value = pipe.read().await?;
            if value["type"] == "control_request" {
                if let Some(id) = value.get("request_id").filter(|id| id.is_string()) {
                    pipe.send(&json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":"Command discovery does not execute requests"}})).await?;
                }
                continue;
            }
            if value["type"] != "control_response" || value["response"]["request_id"] != "pandacode-commands" {
                continue;
            }
            return parse_runtime(&value).ok_or(());
        }
    }.await;
    pipe.finish().await;
    result.map_err(|_| DISCOVERY_FAILED.to_owned())
}

/// Full replacements from initialization and the installed CLI's live updates.
pub fn parse_runtime(value: &Value) -> Option<Catalog> {
    let data = match (value["type"].as_str(), value["subtype"].as_str()) {
        (Some("control_response"), _) if value["response"]["subtype"] == "success" => {
            &value["response"]["response"]
        }
        (Some("system"), Some("init" | "commands_changed")) => value,
        _ => return None,
    };
    let entries = data
        .get("commands")
        .or_else(|| data.get("slash_commands"))?
        .as_array()?;
    let terminals: HashSet<String> = data["terminal_slash_commands"]
        .as_array()
        .into_iter()
        .flatten()
        .take(MAX_COMMANDS)
        .filter_map(|entry| command_name(entry.as_str()?))
        .collect();
    Some(parse_entries(entries, "claude", &terminals))
}

pub(super) fn parse_entries(
    entries: &[Value],
    provider: &str,
    terminals: &HashSet<String>,
) -> Catalog {
    let mut catalog = Catalog {
        commands: Vec::new(),
        warnings: Vec::new(),
    };
    let mut seen = HashSet::new();
    let mut limited = entries.len() > MAX_COMMANDS;
    for entry in entries.iter().take(MAX_COMMANDS) {
        if entry["userInvocable"] == false {
            continue;
        }
        let Some(name) = entry
            .as_str()
            .or_else(|| entry["name"].as_str())
            .and_then(command_name)
        else {
            continue;
        };
        let description = bounded_text(entry["description"].as_str().unwrap_or(""), 600);
        let hint = entry["argumentHint"]
            .as_str()
            .or_else(|| entry["input"]["hint"].as_str())
            .map(|text| bounded_text(text, 160))
            .filter(|text| !text.is_empty());
        let terminal =
            terminals.contains(&name) || (provider == "claude" && known_terminal_command(&name));
        let names = std::iter::once(Some(name.clone())).chain(
            entry["aliases"]
                .as_array()
                .into_iter()
                .flatten()
                .take(16)
                .map(|alias| alias.as_str().and_then(command_name)),
        );
        for spelling in names.flatten() {
            if !seen.insert(spelling.clone()) {
                continue;
            }
            if catalog.commands.len() == MAX_COMMANDS {
                limited = true;
                break;
            }
            let (kind, invocation, reason) = if terminal
                || terminals.contains(&spelling)
                || (provider == "claude" && known_terminal_command(&spelling))
            {
                match native_action(&name) {
                    Some(action) => ("action", Invocation::Action(action.into()), None),
                    None => (
                        "action",
                        Invocation::Action(format!("console:{}", spelling.trim_start_matches('/'))),
                        None,
                    ),
                }
            } else {
                ("prompt", Invocation::Native, None)
            };
            catalog.commands.push(SlashCommand {
                id: format!("{provider}:{spelling}"),
                name: spelling,
                description: description.clone(),
                argument_hint: hint.clone(),
                kind: kind.into(),
                source: if kind == "action" {
                    "PandaCode"
                } else {
                    provider
                }
                .into(),
                reason,
                invocation,
            });
        }
    }
    if limited {
        catalog
            .warnings
            .push("The command list was limited to 512 entries.".into());
    }
    catalog
}

fn native_action(name: &str) -> Option<&'static str> {
    match name {
        "/help" => Some("help"),
        "/model" => Some("model"),
        "/permissions" | "/permission" => Some("permissions"),
        "/clear" | "/new" => Some("new"),
        _ => None,
    }
}

// Claude 2.1.270's initialize/commands_changed strip terminalOriented from
// command metadata even though their command lists include these entries.
// The explicit system/init terminal list supplements this compatibility set.
fn known_terminal_command(name: &str) -> bool {
    matches!(
        name,
        "/help"
            | "/exit"
            | "/quit"
            | "/color"
            | "/statusline"
            | "/reload-plugins"
            | "/doctor"
            | "/checkup"
    )
}

fn command_name(value: &str) -> Option<String> {
    let value = value.strip_prefix('/').unwrap_or(value);
    if value.is_empty()
        || value.len() > 160
        || !value
            .chars()
            .all(|ch| ch.is_alphanumeric() || "_-.:?".contains(ch))
    {
        return None;
    }
    Some(format!("/{value}"))
}

fn bounded_text(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\t'))
        .take(limit)
        .collect()
}

/// Shared by these two discovery adapters, with no unbounded line buffers or
/// detached readers. Dropping a cancelled future kills descendants and reaps.
pub(crate) struct Pipe {
    child: Option<Child>,
    group: Option<ProcessGroup>,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    deadline: Instant,
    bytes: usize,
    frames: usize,
    stderr_task: tokio::task::JoinHandle<String>,
    diagnostic: String,
}

impl Pipe {
    pub(crate) fn spawn(mut command: Command, cwd: &Path, timeout: Duration) -> Result<Self, ()> {
        if !cwd.is_dir() {
            return Err(());
        }
        command
            .current_dir(crate::providers::external_path(cwd))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|_| ())?;
        let group = Some(ProcessGroup::register(child.id()));
        let stdin = child.stdin.take().ok_or(())?;
        let stdout = BufReader::new(child.stdout.take().ok_or(())?);
        let mut stderr = child.stderr.take().ok_or(())?;
        let stderr_task = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut tail = Vec::new();
            let mut buffer = [0; 2048];
            while let Ok(count) = stderr.read(&mut buffer).await {
                if count == 0 { break; }
                tail.extend_from_slice(&buffer[..count]);
                if tail.len() > 16 * 1024 { tail.drain(..tail.len() - 16 * 1024); }
            }
            String::from_utf8_lossy(&tail).trim().to_owned()
        });
        Ok(Self {
            child: Some(child),
            group,
            stdin,
            stdout,
            deadline: Instant::now() + timeout,
            bytes: 0,
            frames: 0,
            stderr_task,
            diagnostic: String::new(),
        })
    }

    pub(crate) async fn send(&mut self, message: &Value) -> Result<(), ()> {
        let mut bytes = serde_json::to_vec(message).map_err(|_| ())?;
        bytes.push(b'\n');
        tokio::time::timeout_at(self.deadline, self.stdin.write_all(&bytes))
            .await
            .map_err(|_| ())?
            .map_err(|_| ())
    }

    pub(crate) async fn read(&mut self) -> Result<Value, ()> {
        let deadline = self.deadline;
        tokio::time::timeout_at(deadline, self.read_frame())
            .await
            .map_err(|_| ())?
    }

    pub(crate) fn set_deadline_after(&mut self, duration: Duration) {
        self.deadline = Instant::now() + duration;
    }

    pub(crate) fn timed_out(&self) -> bool {
        Instant::now() >= self.deadline
    }

    pub(crate) fn diagnostic(&self) -> &str {
        &self.diagnostic
    }

    async fn read_frame(&mut self) -> Result<Value, ()> {
        let mut frame = Vec::new();
        loop {
            let available = self.stdout.fill_buf().await.map_err(|_| ())?;
            if available.is_empty() {
                return Err(());
            }
            let end = available.iter().position(|byte| *byte == b'\n');
            let consumed = end.map_or(available.len(), |index| index + 1);
            self.bytes += consumed;
            if self.bytes > 4 * 1024 * 1024 || frame.len() + consumed > 512 * 1024 {
                return Err(());
            }
            frame.extend_from_slice(&available[..consumed]);
            self.stdout.consume(consumed);
            if end.is_none() {
                continue;
            }
            self.frames += 1;
            if self.frames > 512 {
                return Err(());
            }
            if frame.iter().all(u8::is_ascii_whitespace) {
                frame.clear();
                continue;
            }
            return serde_json::from_slice(&frame).map_err(|_| ());
        }
    }

    pub(crate) async fn finish(&mut self) {
        self.group.take();
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
            if tokio::time::timeout(Duration::from_secs(1), child.wait())
                .await
                .is_ok()
            {
                self.child.take();
            }
        }
        self.diagnostic = tokio::time::timeout(Duration::from_millis(250), &mut self.stderr_task)
            .await.ok().and_then(Result::ok).unwrap_or_default();
        self.stderr_task.abort();
    }
}

impl Drop for Pipe {
    fn drop(&mut self) {
        self.stderr_task.abort();
        self.group.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = child.wait().await;
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glm_discovery_uses_selected_binary_without_inherited_credentials() {
        let path = Path::new(if cfg!(windows) {
            r"C:\Program Files\Claude\claude.exe"
        } else {
            "/opt/custom/claude"
        });
        let command = discovery_command(path, "glm").unwrap();
        assert_eq!(command.as_std().get_program(), path);
        let env: std::collections::HashMap<_, _> = command.as_std().get_envs().collect();
        for name in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ZAI_API_KEY",
        ] {
            assert_eq!(env[std::ffi::OsStr::new(name)], None);
        }
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|s| s.to_string_lossy())
            .collect();
        let source = args
            .iter()
            .position(|arg| *arg == "--setting-sources")
            .unwrap();
        assert!(args[source + 1].is_empty());
        let settings = args.iter().position(|arg| *arg == "--settings").unwrap();
        let settings: Value = serde_json::from_str(&args[settings + 1]).unwrap();
        assert_eq!(settings["disableAllHooks"], true);
        // MiMo shares the path but needs its cluster chosen first; nothing is guessed.
        assert!(discovery_command(path, "mimo")
            .err()
            .unwrap()
            .contains("cluster"));
    }

    #[test]
    fn initialization_and_live_updates_keep_aliases_and_real_metadata() {
        let catalog = parse_runtime(&json!({"type":"control_response","response":{"subtype":"success","response":{"commands":[
            {"name":"usage","description":"Show token usage","argumentHint":"[details]","aliases":["cost","stats"]},
            {"name":"my-plugin:review","description":"Review this project"}
        ],"credentials":{"secret":"do not forward"}}}})).unwrap();
        assert_eq!(catalog.commands.len(), 4);
        assert_eq!(catalog.commands[1].name, "/cost");
        assert_eq!(catalog.commands[1].description, "Show token usage");
        assert_eq!(
            catalog.commands[1].argument_hint.as_deref(),
            Some("[details]")
        );
        assert!(!serde_json::to_string(&catalog).unwrap().contains("secret"));
        let updated = parse_runtime(&json!({"type":"system","subtype":"commands_changed","commands":[{"name":"new-skill","description":"Added at runtime"}]})).unwrap();
        assert_eq!(updated.commands.len(), 1);
        assert_eq!(updated.commands[0].name, "/new-skill");
        assert!(
            parse_runtime(&json!({"type":"assistant","message":{"content":"/help"}})).is_none()
        );
    }

    #[test]
    fn terminal_metadata_is_respected_without_guessing_missing_commands() {
        let catalog = parse_runtime(&json!({"type":"system","subtype":"init","slash_commands":["help","exit","model","review"],"terminal_slash_commands":["help","exit","model"]})).unwrap();
        assert!(
            matches!(&catalog.commands[0].invocation, Invocation::Action(action) if action == "help")
        );
        assert!(matches!(
            catalog.commands[1].invocation,
            Invocation::Action(ref action) if action == "console:exit"
        ));
        assert!(
            matches!(&catalog.commands[2].invocation, Invocation::Action(action) if action == "model")
        );
        assert!(matches!(catalog.commands[3].invocation, Invocation::Native));
        assert_eq!(catalog.commands.len(), 4);
        assert!(
            parse_runtime(&json!({"type":"system","subtype":"init","slash_commands":[]}))
                .unwrap()
                .commands
                .is_empty()
        );
    }

    #[test]
    fn terminal_builtins_route_to_console_when_live_metadata_omits_terminal_tags() {
        let catalog = parse_runtime(
            &json!({"type":"system","subtype":"commands_changed","commands":[
                {"name":"exit","aliases":["quit"]},
                {"name":"doctor","aliases":["checkup"]},
                {"name":"reload-plugins"},
                {"name":"statusline"},
                {"name":"color"},
                {"name":"help"},
                {"name":"model"},
                {"name":"clear"},
                {"name":"compact"}
            ]}),
        )
        .unwrap();
        assert!(catalog.commands[..7]
            .iter()
            .all(|entry| matches!(&entry.invocation, Invocation::Action(action) if action.starts_with("console:"))));
        assert!(
            matches!(&catalog.commands[7].invocation, Invocation::Action(action) if action == "help")
        );
        assert!(catalog.commands[8..]
            .iter()
            .all(|entry| matches!(entry.invocation, Invocation::Native)));
    }

    #[test]
    fn rejects_path_names_and_bounds_untrusted_metadata() {
        let mut entries = vec![
            json!({"name":"/private/secret.md"}),
            json!({"name":"inject\nline"}),
        ];
        entries.extend((0..600).map(|i| json!({"name":format!("command-{i}"),"description":"é".repeat(1200),"argumentHint":"x".repeat(200),"aliases":["shared-alias"]})));
        let catalog = parse_entries(&entries, "claude", &HashSet::new());
        assert_eq!(catalog.commands.len(), 511);
        assert_eq!(catalog.commands[0].description.chars().count(), 600);
        assert_eq!(
            catalog.commands[0].argument_hint.as_ref().unwrap().len(),
            160
        );
        assert_eq!(
            catalog
                .commands
                .iter()
                .filter(|c| c.name == "/shared-alias")
                .count(),
            1
        );
        assert!(!catalog.warnings.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn discovery_sends_only_initialization_and_denies_reverse_requests() {
        let _serial = crate::providers::concurrent_process_tests::process_test_lock()
            .lock()
            .await;
        let mut command = Command::new("/bin/sh");
        command.args(["-c", r#"
            read -r init
            case "$init" in *'"subtype":"initialize"'*) ;; *) exit 1 ;; esac
            printf '%s\n' '{"type":"control_request","request_id":"reverse","request":{"subtype":"can_use_tool"}}'
            read -r denied
            case "$denied" in *'"subtype":"error"'*) ;; *) exit 2 ;; esac
            printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"another","response":{"commands":[{"name":"wrong"}]}}}'
            printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"pandacode-commands","response":{"commands":[{"name":"compact","description":"Compact history"}]}}}'
            read -r unexpected
        "#]);
        let catalog = discover_process(command, &std::env::temp_dir(), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(catalog.commands.len(), 1);
        assert_eq!(catalog.commands[0].name, "/compact");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_and_cancellation_kill_and_reap_the_process() {
        let _serial = crate::providers::concurrent_process_tests::process_test_lock()
            .lock()
            .await;
        for cancel in [false, true] {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "sleep 30"]);
            let mut pipe =
                Pipe::spawn(command, &std::env::temp_dir(), Duration::from_millis(30)).unwrap();
            let pid = pipe.child.as_ref().unwrap().id().unwrap();
            if cancel {
                let task = tokio::spawn(async move { pipe.read().await });
                tokio::task::yield_now().await;
                task.abort();
                let _ = task.await;
            } else {
                assert!(pipe.read().await.is_err());
                pipe.finish().await;
                drop(pipe);
            }
            tokio::time::timeout(Duration::from_secs(2), async {
                while unsafe { libc::kill(pid as i32, 0) } == 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn oversized_frames_fail_without_exposing_raw_output() {
        let _serial = crate::providers::concurrent_process_tests::process_test_lock()
            .lock()
            .await;
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "read -r init; head -c 600000 /dev/zero | tr '\\000' x",
        ]);
        let error = discover_process(command, &std::env::temp_dir(), Duration::from_secs(2))
            .await
            .err()
            .unwrap();
        assert_eq!(error, DISCOVERY_FAILED);
    }
}
