//! A handshake spare's process: started and sent `initialize` (`start`), then read on both
//! pipes while it waits (`listen`) so a chatty harness never blocks, and handed back to the
//! adopting run with everything it printed (`settle`).
use super::*;

/// What an initializing or waiting spare wrote to stderr is kept for the adopting run, up to this much (the
/// latest part).
pub(in crate::providers) const EARLY_STDERR: usize = 8 * 1024;

pub(super) struct Reader {
    stop: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<Drained>,
}

struct Drained {
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    printed: Vec<u8>,
    errors: Vec<u8>,
    failed: Option<String>,
}

/// Keep reading a waiting spare's pipes, so an app-server that prints notifications (config
/// warnings, account or MCP status) never blocks on a full pipe. Its output is kept, in order,
/// for the adopting run, and the tail of its stderr (`EARLY_STDERR`) for the run's error
/// reports. Dropping the spare ends the reader with it.
pub(super) fn listen(child: &mut Child) -> Option<Reader> {
    let (mut stdout, mut stderr) = (child.stdout.take()?, child.stderr.take()?);
    let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let (mut printed, mut errors, mut failed, mut errors_open) = (Vec::new(), Vec::new(), None, true);
        let (mut out, mut err) = ([0u8; 8192], [0u8; 8192]);
        loop {
            // Reads are cancel-safe: stopping between them loses nothing.
            tokio::select! {
                _ = &mut stopped => break,
                read = stdout.read(&mut out), if failed.is_none() => match read {
                    Ok(count) if count > 0 => {
                        printed.extend_from_slice(&out[..count]);
                        if printed.len() > MAX_FRAME {
                            failed = Some("it printed too much".to_string());
                        }
                    }
                    _ => failed = Some("its process exited".to_string()),
                },
                read = stderr.read(&mut err), if errors_open => match read {
                    Ok(count) if count > 0 => {
                        errors.extend_from_slice(&err[..count]);
                        if errors.len() > EARLY_STDERR {
                            errors.drain(..errors.len() - EARLY_STDERR);
                        }
                    }
                    _ => errors_open = false,
                },
            }
        }
        Drained { stdout, stderr, printed, errors, failed }
    });
    Some(Reader { stop, task })
}

/// Stop the reader and give the adopting run the pipes and everything printed meanwhile.
pub(super) async fn settle(mut spare: Spare) -> Result<Spare, String> {
    let Some(reader) = spare.reader.take() else { return Ok(spare) };
    let _ = reader.stop.send(());
    let drained = reader.task.await.map_err(|e| format!("its reader failed: {e}"))?;
    spare.child.stdout = Some(drained.stdout);
    spare.child.stderr = Some(drained.stderr);
    // After what it wrote during initialize and while loading its thread, if any.
    spare.early_stderr.extend_from_slice(&drained.errors);
    let excess = spare.early_stderr.len().saturating_sub(EARLY_STDERR);
    spare.early_stderr.drain(..excess);
    if let Some(failed) = drained.failed {
        return Err(failed);
    }
    spare.pending.extend_from_slice(&drained.printed);
    Ok(spare)
}

/// Spawn the harness and send `initialize`; `on_spawn` runs once its process is running.
pub(super) async fn start(mut command: Command, cwd: &Path, request: &Value, on_spawn: impl FnOnce()) -> Result<(Child, ProcessGroup, Vec<u8>, Vec<u8>), String> {
    start_from(&mut command, cwd, request, on_spawn).await
}

/// `start` with a command the caller keeps (a send racing a stalled spare with its own launch).
pub(super) async fn start_from(command: &mut Command, cwd: &Path, request: &Value, on_spawn: impl FnOnce()) -> Result<(Child, ProcessGroup, Vec<u8>, Vec<u8>), String> {
    command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let child = command.spawn().map_err(|e| format!("Could not start it: {e}"))?;
    let group = ProcessGroup::register(child.id());
    on_spawn();
    let (child, pending, errors) = initialize(child, request).await?;
    Ok((child, group, pending, errors))
}

/// Send `initialize` and keep stdout plus a bounded stderr tail until the reply is complete.
/// ACP spares stop here; Codex may then preload a saved thread (`codex_preload.rs`).
pub(super) async fn initialize(mut child: Child, request: &Value) -> Result<(Child, Vec<u8>, Vec<u8>), String> {
    let mut stdin = child.stdin.take().ok_or("its input is unavailable")?;
    let mut stdout = child.stdout.take().ok_or("its output is unavailable")?;
    let mut stderr = child.stderr.take().ok_or("its errors are unavailable")?;
    let (mut pending, mut errors) = (Vec::new(), Vec::new());
    let result = tokio::time::timeout(INITIALIZE, async {
        let initialized = async {
            write_json(&mut stdin, request).await?;
            loop {
                if let Some(reply) = reply(&pending) {
                    return match reply.get("error") {
                        Some(error) => Err(format!("it refused initialize: {error}")),
                        None => Ok(()),
                    };
                }
                let mut buffer = [0u8; 8192];
                let count = stdout.read(&mut buffer).await.map_err(|e| format!("its output failed: {e}"))?;
                if count == 0 {
                    return Err("its process exited".to_string());
                }
                pending.extend_from_slice(&buffer[..count]);
                if pending.len() > MAX_FRAME {
                    return Err("it printed too much".into());
                }
            }
        };
        tokio::pin!(initialized);
        let (mut buffer, mut errors_open) = ([0u8; 8192], true);
        loop {
            // Drain even while sending initialize: startup logs can precede reading stdin.
            // The write/read future stays pinned; stderr reads are cancel-safe.
            tokio::select! {
                result = &mut initialized => return result,
                read = stderr.read(&mut buffer), if errors_open => match read {
                    Ok(count) if count > 0 => {
                        errors.extend_from_slice(&buffer[..count]);
                        let excess = errors.len().saturating_sub(EARLY_STDERR);
                        errors.drain(..excess);
                    }
                    _ => errors_open = false,
                },
            }
        }
    })
    .await;
    child.stdin = Some(stdin);
    child.stdout = Some(stdout);
    child.stderr = Some(stderr);
    result.map_err(|_| "it did not answer in time".to_string())??;
    Ok((child, pending, errors))
}

/// The reply to `initialize` among the complete lines printed so far.
pub(super) fn reply(pending: &[u8]) -> Option<Value> {
    let complete = pending.iter().rposition(|byte| *byte == b'\n').map_or(&pending[..0], |end| &pending[..end]);
    complete
        .split(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .find(|value| value["id"] == 1 && value.get("method").is_none())
}

/// Prints over a pipe's capacity before reading initialize, then closes stderr before
/// replying. The delay lets the reader observe stderr EOF while stdout is still pending.
#[cfg(all(test, unix))]
pub(super) fn startup_stderr_command(mode: &str) -> Command {
    let script = r#"dd if=/dev/zero bs=1048576 count=1 >&2 2>/dev/null
printf 'latest startup diagnostic\n' >&2
exec 2>&-
sleep 0.05
IFS= read -r line
printf '{"method":"configWarning","params":{}}\n'
case "$1" in
  refuse) printf '{"id":1,"error":{"message":"no"}}\n' ;;
  eof) exit 0 ;;
  *) printf '{"id":1,"result":{}}\n' ;;
esac
while IFS= read -r line; do
  case "$line" in
    *'"method":"thread/goal/get"'*)
      id=$(printf '%s' "$line" | sed -nE 's/.*"id":([0-9]+).*/\1/p')
      printf '{"id":%s,"result":{"goal":null}}\n' "$id" ;;
    *'"method":"thread/resume"'*) printf '{"id":2,"result":{"thread":{"id":"thread-1"}}}\n' ;;
  esac
done"#;
    let mut command = Command::new("sh");
    command.args(["-c", script, "startup-stderr", mode]);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for `codex app-server`: logs every line it is sent to `$1`, prints a
    /// notification, and answers `initialize` (or refuses it when `$2` is `refuse`).
    #[cfg(unix)]
    fn fake_codex(log: &Path, mode: &str) -> Command {
        let script = r#"while IFS= read -r line; do
  printf '%s\n' "$line" >> "$1"
  printf '{"method":"configWarning","params":{}}\n'
  if [ "$2" = refuse ]; then printf '{"id":1,"error":{"message":"no"}}\n'; else printf '{"id":1,"result":{"userAgent":"fake"}}\n'; fi
done"#;
        let mut command = Command::new("sh");
        command.args(["-c", script, "fake-codex"]).arg(log).arg(mode);
        command
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_codex_spare_is_sent_initialize_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("codex-warm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let log = dir.join("sent");
        let (mut child, _group, pending, _) = start(fake_codex(&log, "answer"), &dir, &codex_initialize(), || {}).await.expect("initialized");
        tokio::time::sleep(Duration::from_millis(200)).await;
        let sent = std::fs::read_to_string(&log).unwrap();
        assert_eq!(sent.lines().count(), 1, "{sent}");
        assert_eq!(serde_json::from_str::<Value>(sent.trim()).unwrap(), codex_initialize());
        // The adopting run replays the notification and the reply, in order.
        let printed = String::from_utf8(pending).unwrap();
        assert!(printed.starts_with("{\"method\":\"configWarning\""), "{printed}");
        assert!(printed.ends_with("{\"id\":1,\"result\":{\"userAgent\":\"fake\"}}\n"), "{printed}");
        assert!(child.stdin.is_some() && child.stdout.is_some() && child.stderr.is_some(), "the adopter can still talk to it");
        child.kill().await.unwrap();
        let refused = start(fake_codex(&dir.join("refused"), "refuse"), &dir, &codex_initialize(), || {}).await;
        assert!(refused.err().is_some_and(|error| error.contains("refused initialize")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// After `initialize`, prints `$2` notification lines to stdout and as many to stderr
    /// (far past a pipe's buffer), then creates `$1`.
    #[cfg(unix)]
    fn chatty_codex(done: &Path, lines: usize) -> Command {
        let script = r#"IFS= read -r line
printf '{"id":1,"result":{}}\n'
i=0
while [ "$i" -lt "$2" ]; do
  printf '{"method":"notice","params":{"i":%s,"pad":"................................"}}\n' "$i"
  printf 'warning %s ................................................\n' "$i" >&2
  i=$((i+1))
done
: > "$1"
while IFS= read -r line; do :; done"#;
        let mut command = Command::new("sh");
        command.args(["-c", script, "chatty-codex"]).arg(done).arg(lines.to_string());
        command
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_waiting_codex_spare_keeps_reading_a_chatty_app_server() {
        let dir = std::env::temp_dir().join(format!("codex-warm-chatty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let done = dir.join("done");
        let lines = 4000;
        let (mut child, group, pending, early_stderr) = start(chatty_codex(&done, lines), &dir, &codex_initialize(), || {}).await.expect("initialized");
        let reader = listen(&mut child);
        let spare = Spare { key: "k".into(), child, group, pending, born: std::time::Instant::now(), reader, early_stderr, provider: "codex".into(), thread: None };
        // Unread, the app-server would block on its first ~64 KiB and never get here.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !done.exists() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(done.exists(), "the spare's pipes were drained while it waited");
        let mut spare = settle(spare).await.expect("settled");
        assert!(spare.early_stderr.len() <= EARLY_STDERR);
        // The reader may stop before the last bytes: they stay in the pipes, after what it kept.
        let mut printed = spare.pending.clone();
        let last = format!("warning {} ", lines - 1);
        let mut errors = spare.early_stderr.clone();
        let (mut stdout, mut stderr) = (spare.child.stdout.take().unwrap(), spare.child.stderr.take().unwrap());
        let notices = |printed: &[u8]| String::from_utf8_lossy(printed).matches("\"method\":\"notice\"").count();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let (mut out, mut err) = ([0u8; 8192], [0u8; 8192]);
        while notices(&printed) < lines || !String::from_utf8_lossy(&errors).contains(&last) {
            tokio::select! {
                read = stdout.read(&mut out), if notices(&printed) < lines => printed.extend_from_slice(&out[..read.unwrap()]),
                read = stderr.read(&mut err) => errors.extend_from_slice(&err[..read.unwrap()]),
                _ = tokio::time::sleep_until(deadline) => break,
            }
        }
        let printed = String::from_utf8(printed).unwrap();
        assert!(printed.starts_with("{\"id\":1,\"result\":{}}\n"), "the reply comes first");
        assert_eq!(notices(printed.as_bytes()), lines, "nothing the adopter must see is lost");
        assert!(spare.child.stdin.is_some());
        // The tail of its stderr is kept for the adopting run's error reports.
        assert!(String::from_utf8_lossy(&errors).contains(&last), "{}", String::from_utf8_lossy(&errors));
        spare.child.kill().await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_stderr_is_drained_before_background_preparation_and_adoption() {
        let config = RunConfig { session_id: "startup-stderr-background".into(), resume_id: Some("thread-1".into()), ..crate::providers::tests::config("codex") };
        let prepare = async {
            let (mut child, group, mut pending, mut early_stderr) = start(startup_stderr_command("answer"), &config.cwd, &codex_initialize(), || {}).await?;
            let thread = super::super::super::codex_preload::preload(&mut child, &mut pending, &mut early_stderr, &config, Vec::new(), HashSet::new()).await?;
            let reader = listen(&mut child);
            Ok::<_, String>(Spare { key: "startup".into(), child, group, pending, born: std::time::Instant::now(), reader, early_stderr, provider: "codex".into(), thread })
        };
        let spare = tokio::time::timeout(Duration::from_secs(3), prepare).await.expect("startup stderr must not block initialize").expect("prepared");
        assert!(spare.thread.is_some(), "the prepared thread is retained");
        let thread_key = super::super::super::codex_preload::key_of(spare.thread.as_ref()).map(str::to_owned);
        state().spares.insert(config.session_id.clone(), spare);
        let mut adopted = take(&config.session_id, "startup", thread_key.as_deref(), None).await.unwrap().expect("adopted");
        adopted.child.kill().await.unwrap();
        warm::launch_settled(&config.session_id);
        assert_eq!(adopted.early_stderr.len(), EARLY_STDERR);
        assert!(adopted.early_stderr.ends_with(b"latest startup diagnostic\n"));
        let printed = String::from_utf8(adopted.pending).unwrap();
        assert!(printed.starts_with("{\"method\":\"configWarning\""));
        assert!(printed.contains("{\"id\":1,\"result\":{}}\n"));
        assert!(printed.ends_with("{\"id\":2,\"result\":{\"thread\":{\"id\":\"thread-1\"}}}\n"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_stderr_does_not_hide_failed_initialize_or_stdout_eof() {
        for (mode, expected) in [("refuse", "refused initialize"), ("eof", "its process exited")] {
            let result = tokio::time::timeout(Duration::from_secs(3), start(startup_stderr_command(mode), &std::env::temp_dir(), &codex_initialize(), || {})).await.expect("stderr EOF must not spin or stall initialization");
            assert!(result.err().is_some_and(|error| error.contains(expected)), "{mode}: expected {expected}");
        }
    }

    #[test]
    fn only_a_complete_reply_line_counts() {
        assert!(reply(b"{\"id\":1,\"result\":{}}").is_none(), "its newline has not arrived");
        assert!(reply(b"{\"id\":1,\"method\":\"x\"}\n").is_none(), "a server request with the same id");
        assert!(reply(b"{\"method\":\"n\"}\n{\"id\":1,\"result\":{}}\n{\"par").is_some());
    }
}
