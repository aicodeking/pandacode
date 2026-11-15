//! A Codex spare that also loads the task's thread ahead (`thread/resume`, measured 0.3–5.3 s
//! on 0.167.0 with the user's MCP servers), so a send after a switch starts its turn at once.
//!
//! What `thread/resume` fixes and how a send that differs is still served:
//! - model, effort and permissions (`approvalPolicy`, `approvalsReviewer`, `sandbox`): the
//!   send's `turn/start` overrides them "for this turn and subsequent turns" (the app-server
//!   schema), so they are left out of the key. Without an effort, the thread's default effort
//!   depends on its model, so then the model is keyed too; whether a model or effort is chosen
//!   at all is always keyed.
//! - the MCP server carrying the run's host URL: the spare serves a placeholder at that URL,
//!   rebound to the run on adoption (as Claude's spares do); its tool catalog is keyed.
//! - the thread, folder, service tier and every other field: keyed, as the request itself.
//!
//! Not loaded ahead: a new thread (`thread/start` would create one the user may never use),
//! goal turns, a thread whose goal is active (the cold path pauses it first), and `/compact`
//! or `/review` sends (they run on the thread's own model).
use super::*;

/// A thread that has not loaded by then is not waited for.
pub(super) const LOAD: Duration = Duration::from_secs(20);
const SERVER: &str = "pandacode_architect";

/// The thread a spare loaded, for the send that adopts it.
pub(super) struct Preloaded {
    key: String,
    /// The requests the spare sent after `initialize`, in order: the adopting run builds the
    /// same ones while it replays the spare's output and must not send them again.
    pub(super) sent: Vec<String>,
    server: Option<mcp_host::Server>,
}

/// The tools a Codex run serves over its own MCP server (`split_jev_host`), as keyed: the
/// thread lists them when it loads.
pub(super) fn catalog(host: Option<&ToolHost>) -> Value {
    let Some(host) = host else { return Value::Null };
    let tools: Vec<_> = host.tools.iter().filter(|tool| tool["name"].as_str().is_some_and(per_run_mcp_tool)).collect();
    let mut protected: Vec<_> = host.approval_tools.iter().filter(|name| per_run_mcp_tool(name)).collect();
    protected.sort();
    // No catalog and an empty one serve nothing alike.
    if tools.is_empty() && protected.is_empty() {
        return Value::Null;
    }
    json!([tools, protected])
}

/// The thread load a send with this config would make, without what `turn/start` overrides,
/// with the catalog its MCP server serves. `None` when the send cannot use a loaded thread.
pub(super) fn thread_key(config: &RunConfig, catalog: &Value, server: bool) -> Option<String> {
    let command = config.prompt.split_whitespace().next().unwrap_or_default();
    let loads = config.provider == "codex" && config.resume_id.as_ref().is_some_and(|id| !id.is_empty()) && config.goal.is_none();
    if !loads || matches!(command, "/compact" | "/review") {
        return None;
    }
    // The run's own steps, from canned replies: no thread has a goal, and the load is built.
    let mut protocol = Protocol::new(RunConfig { prompt: String::new(), images: Vec::new(), skill: None, ..config.clone() });
    protocol.codex_mcp_servers = server.then(|| json!({SERVER: {}}));
    let bootstrap = protocol.receive(json!({"id":1,"result":{}})).ok()?;
    let preflight = bootstrap.write.iter().find(|request| request["method"] == "thread/goal/get")?["id"].clone();
    let load = protocol.receive(json!({"id":preflight,"result":{"goal":null}})).ok()?;
    let request = load.write.into_iter().find(|request| request["method"] == "thread/resume")?;
    Some(json!([normalized(request["params"].clone()), catalog]).to_string())
}

fn normalized(mut params: Value) -> Value {
    if let Some(params) = params.as_object_mut() {
        for overridden in ["approvalPolicy", "approvalsReviewer", "sandbox"] {
            params.remove(overridden);
        }
    }
    if params["config"].get("model_reasoning_effort").is_some() {
        params["config"]["model_reasoning_effort"] = json!("per turn");
        if params.get("model").is_some() {
            params["model"] = json!("per turn");
        }
    }
    // The address and token are the server's own; what it serves is in the catalog.
    if let Some(config) = params["config"].as_object_mut() {
        for (name, server) in config.iter_mut().filter(|(name, _)| name.starts_with("mcp_servers.")) {
            *server = json!(name);
        }
    }
    params
}

/// Load the task's thread in a spare that just answered `initialize` (its output so far is
/// `pending`): the same requests a cold send makes, from the same protocol. `Ok(None)` when
/// the task's next send cannot use a loaded thread; an error leaves the process unusable.
/// The tail of what it writes to stderr meanwhile goes in `errors`.
pub(super) async fn preload(child: &mut Child, pending: &mut Vec<u8>, errors: &mut Vec<u8>, config: &RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>) -> Result<Option<Preloaded>, String> {
    let Some(key) = expected(config, &tools, &approval_tools) else { return Ok(None) };
    let (_, served) = split_jev_host(Some(placeholder(tools, approval_tools)));
    let server = match served {
        Some(host) => Some(mcp_host::Server::start_with_approvals(host, config.session_id.clone(), Arc::new(|_| {}), &config.mode).await?),
        None => None,
    };
    let mut protocol = Protocol::new(config.clone());
    protocol.codex_mcp_servers = server.as_ref().map(mcp_host::Server::codex_config);
    let (mut stdin, mut stdout) = (child.stdin.take().ok_or("its input is unavailable")?, child.stdout.take().ok_or("its output is unavailable")?);
    let mut stderr = child.stderr.take().ok_or("its errors are unavailable")?;
    let pipes = Pipes { stdin: &mut stdin, stdout: &mut stdout, stderr: &mut stderr, errors };
    let loaded = tokio::time::timeout(LOAD, load(&mut protocol, pipes, pending)).await;
    child.stdin = Some(stdin);
    child.stdout = Some(stdout);
    child.stderr = Some(stderr);
    let sent = loaded.map_err(|_| "its thread did not load in time".to_string())??;
    Ok(Some(Preloaded { key, sent, server }))
}

/// The thread key a spare started with this catalog would load (`thread_key`).
pub(super) fn expected(config: &RunConfig, tools: &[Value], approval_tools: &HashSet<String>) -> Option<String> {
    let host = placeholder(tools.to_vec(), approval_tools.clone());
    let served = host.tools.iter().any(|tool| tool["name"].as_str().is_some_and(per_run_mcp_tool));
    thread_key(config, &catalog(Some(&host)), served)
}

/// Serves the catalog's listing until a run rebinds it.
fn placeholder(tools: Vec<Value>, approval_tools: HashSet<String>) -> ToolHost {
    ToolHost {
        tools,
        approval_tools,
        handler: Arc::new(|_, _| Box::pin(async { Err("This turn has not started yet.".to_string()) })),
    }
}

struct Pipes<'a> {
    stdin: &'a mut tokio::process::ChildStdin,
    stdout: &'a mut tokio::process::ChildStdout,
    stderr: &'a mut tokio::process::ChildStderr,
    errors: &'a mut Vec<u8>,
}

/// Feed what the spare prints to the protocol and send what it asks for, until the thread's
/// load is answered. That reply stays unread, for the adopting run. Its stderr is drained
/// meanwhile, so a harness logging while it loads its MCP servers never blocks on the pipe.
async fn load(protocol: &mut Protocol, pipes: Pipes<'_>, pending: &mut Vec<u8>) -> Result<Vec<String>, String> {
    let Pipes { stdin, stdout, stderr, errors } = pipes;
    let (mut sent, mut read, mut errors_open) = (Vec::new(), 0, true);
    loop {
        while let Some(end) = pending[read..].iter().position(|byte| *byte == b'\n') {
            let line = pending[read..read + end].to_vec();
            read += end + 1;
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let value: Value = serde_json::from_slice(&line).map_err(|e| format!("it printed invalid JSON: {e}"))?;
            if value["id"] == 2 && value.get("method").is_none() {
                return match value.get("error") {
                    Some(error) => Err(format!("it refused the thread: {error}")),
                    None => Ok(sent),
                };
            }
            for request in protocol.receive(value)?.write {
                let method = request["method"].as_str().unwrap_or("a reply").to_owned();
                // An active goal is paused first, and anything else waits for the send.
                if !matches!(method.as_str(), "initialized" | "thread/goal/get" | "thread/resume") {
                    return Err(format!("its thread needs {method} first"));
                }
                write_json(stdin, &request).await?;
                sent.push(method);
            }
        }
        let (mut buffer, mut drained) = ([0u8; 8192], [0u8; 8192]);
        // Both reads are cancel-safe.
        let count = tokio::select! {
            read = stdout.read(&mut buffer) => read.map_err(|e| format!("its output failed: {e}"))?,
            read = stderr.read(&mut drained), if errors_open => {
                match read {
                    Ok(count) if count > 0 => {
                        errors.extend_from_slice(&drained[..count]);
                        let excess = errors.len().saturating_sub(super::handshake_warm::EARLY_STDERR);
                        errors.drain(..excess);
                    }
                    _ => errors_open = false,
                }
                continue;
            }
        };
        if count == 0 {
            return Err("its process exited".into());
        }
        pending.extend_from_slice(&buffer[..count]);
        if pending.len() > MAX_FRAME {
            return Err("it printed too much".into());
        }
    }
}

/// The spare's thread, if this send would load exactly it: its MCP server rebound to the run
/// (`host` is the run's catalog), and the requests the replay must not send again.
pub(super) fn adopt(thread: Preloaded, config: &RunConfig, host: Option<ToolHost>, server: bool, sink: &Sink) -> Option<(Option<mcp_host::Server>, Vec<String>)> {
    if thread_key(config, &catalog(host.as_ref()), server).as_deref() != Some(&thread.key) {
        return None;
    }
    if let Some(spare) = &thread.server {
        let (_, served) = split_jev_host(host);
        spare.rebind(served?, config.session_id.clone(), sink.clone(), &config.mode).ok()?;
    }
    Some((thread.server, thread.sent))
}

/// The key a waiting spare's thread was loaded with (`None`: initialize only).
pub(super) fn key_of(thread: Option<&Preloaded>) -> Option<&str> {
    thread.map(|thread| thread.key.as_str())
}

#[cfg(all(test, unix))]
pub(super) fn preloaded_for_test(key: &str) -> Preloaded {
    Preloaded { key: key.into(), sent: Vec::new(), server: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::goal_state::GoalRequest;

    fn resumed(model: &str, effort: Option<&str>) -> RunConfig {
        RunConfig {
            session_id: "codex-preload".into(),
            resume_id: Some("thread-1".into()),
            model: model.into(),
            reasoning_effort: effort.map(str::to_owned),
            ..crate::providers::tests::config("codex")
        }
    }

    #[cfg(unix)]
    fn title_catalog() -> Vec<Value> {
        vec![json!({"type":"function","name":crate::session_titles::TOOL,"description":"Suggest a title.","inputSchema":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false}})]
    }

    #[test]
    fn a_loaded_thread_is_keyed_by_what_turn_start_cannot_override() {
        let none = Value::Null;
        let key = |config: &RunConfig| thread_key(config, &none, false);
        let base = key(&resumed("gpt-old", Some("low"))).expect("a saved thread loads ahead");
        // turn/start overrides model, effort and permissions.
        assert_eq!(key(&resumed("gpt-new", Some("high"))).unwrap(), base);
        assert_eq!(key(&RunConfig { mode: "full".into(), ..resumed("gpt-new", Some("high")) }).unwrap(), base);
        // Without an effort the thread's default effort follows its model: keyed.
        assert_ne!(key(&resumed("gpt-old", None)).unwrap(), base, "choosing an effort at all");
        assert_ne!(key(&resumed("gpt-old", None)), key(&resumed("gpt-new", None)));
        assert_ne!(key(&resumed("default", Some("low"))).unwrap(), base, "choosing a model at all");
        assert_ne!(key(&RunConfig { resume_id: Some("thread-2".into()), ..resumed("gpt-old", Some("low")) }).unwrap(), base);
        assert_ne!(key(&RunConfig { cwd: "/elsewhere".into(), ..resumed("gpt-old", Some("low")) }).unwrap(), base);
        assert_ne!(thread_key(&resumed("gpt-old", Some("low")), &json!(["other"]), true).unwrap(), base, "the MCP catalog");
        // Never loaded ahead: a new thread, a goal turn, a compaction or review.
        assert!(key(&RunConfig { resume_id: None, ..resumed("gpt-old", Some("low")) }).is_none());
        assert!(key(&RunConfig { goal: Some(GoalRequest::Get), ..resumed("gpt-old", Some("low")) }).is_none());
        assert!(key(&RunConfig { prompt: "/compact".into(), ..resumed("gpt-old", Some("low")) }).is_none());
        assert!(key(&resumed("gpt-old", Some("low"))).is_some_and(|key| !key.contains("pandacode")), "no address or token");
        assert!(key(&RunConfig { provider: "kimi".into(), ..resumed("gpt-old", Some("low")) }).is_none());
    }

    /// A Codex app-server that logs each request to `$1`. Its saved thread has an active goal
    /// when `$2` is `active`. Only `gpt-new` supports `high`.
    #[cfg(unix)]
    fn fake_codex(log: &Path, goal: &str) -> Command {
        let script = r#"while IFS= read -r line; do
  printf '%s\n' "$line" >> "$1"
  id=$(printf '%s' "$line" | sed -nE 's/^\{"id":([0-9]+).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{}}' ;;
    *'"method":"thread/goal/get"'*)
      if [ "$2" = active ]; then
        printf '{"id":%s,"result":{"goal":{"threadId":"thread-1","objective":"x","status":"active","tokensUsed":0,"timeUsedSeconds":0,"createdAt":0,"updatedAt":0}}}\n' "$id"
      else
        printf '{"id":%s,"result":{"goal":null}}\n' "$id"
      fi ;;
    *'"method":"thread/resume"'*) printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-1"},"model":"gpt-old","reasoningEffort":"low"}}' ;;
    *'"method":"model/list"'*) printf '%s\n' '{"id":6,"result":{"data":[{"model":"gpt-old","supportedReasoningEfforts":[{"reasoningEffort":"low"}]},{"model":"gpt-new","supportedReasoningEfforts":[{"reasoningEffort":"high"}]}],"nextCursor":null}}' ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{"id":3,"result":{"turn":{"id":"t1"}}}'
      printf '%s\n' '{"method":"item/completed","params":{"threadId":"thread-1","turnId":"t1","item":{"type":"agentMessage","id":"m","text":"warm reply"}}}'
      printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"t1","status":"completed"}}}'
      ;;
  esac
done"#;
        let mut command = Command::new("sh");
        command.args(["-c", script, "fake-codex"]).arg(log).arg(goal);
        command
    }

    #[cfg(unix)]
    fn methods(log: &Path) -> Vec<Value> {
        std::fs::read_to_string(log).unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    #[cfg(unix)]
    fn names(sent: &[Value]) -> Vec<&str> {
        sent.iter().map(|request| request["method"].as_str().unwrap_or_default()).collect()
    }

    /// A spare for `config` that answered `initialize` and loaded its thread.
    #[cfg(unix)]
    async fn spare(log: &Path, goal: &str, config: &RunConfig, tools: Vec<Value>) -> Result<(Child, ProcessGroup, Vec<u8>, Option<Preloaded>), String> {
        let (mut child, group, mut pending) = super::super::handshake_warm::start_for_test(fake_codex(log, goal), &config.cwd).await?;
        let thread = preload(&mut child, &mut pending, &mut Vec::new(), config, tools, HashSet::new()).await?;
        Ok((child, group, pending, thread))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_spare_loads_the_thread_as_a_send_would_and_stops_there() {
        let log = std::env::temp_dir().join(format!("codex-preload-{}", uuid::Uuid::new_v4()));
        let config = resumed("gpt-old", Some("low"));
        let (mut child, _group, pending, thread) = spare(&log, "none", &config, Vec::new()).await.unwrap();
        let thread = thread.expect("loaded");
        tokio::time::sleep(Duration::from_millis(100)).await;
        let sent = methods(&log);
        assert_eq!(names(&sent), ["initialize", "initialized", "thread/goal/get", "thread/resume"]);
        assert_eq!(thread.sent, ["initialized", "thread/goal/get", "thread/resume"]);
        assert_eq!(sent[3]["params"]["threadId"], "thread-1");
        assert_eq!(sent[3]["params"]["model"], "gpt-old");
        assert!(String::from_utf8(pending).unwrap().ends_with("\"reasoningEffort\":\"low\"}}\n"), "the load's reply is kept unread");
        child.kill().await.unwrap();
        // A thread whose goal is active is paused before a cold load: never loaded ahead.
        let paused = std::env::temp_dir().join(format!("codex-preload-goal-{}", uuid::Uuid::new_v4()));
        let refused = spare(&paused, "active", &config, Vec::new()).await;
        assert!(refused.err().is_some_and(|error| error.contains("thread/goal/set")));
        assert!(!names(&methods(&paused)).contains(&"thread/resume"));
        let _ = (std::fs::remove_file(&log), std::fs::remove_file(&paused));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_send_adopts_its_thread_rebinding_the_spares_mcp_server() {
        let log = std::env::temp_dir().join(format!("codex-preload-mcp-{}", uuid::Uuid::new_v4()));
        let config = resumed("gpt-old", Some("low"));
        let (mut child, _group, _pending, thread) = spare(&log, "none", &config, title_catalog()).await.unwrap();
        let thread = thread.expect("loaded");
        let url = |server: &mcp_host::Server| server.codex_config()[SERVER]["url"].clone();
        let loaded_with = methods(&log)[3]["params"]["config"][format!("mcp_servers.{SERVER}")]["url"].clone();
        assert_eq!(url(thread.server.as_ref().expect("a placeholder")), loaded_with);
        let sink: Sink = Arc::new(|_| {});
        let run = |tools: Vec<Value>| Some(placeholder(tools, HashSet::new()));
        let switched = RunConfig { session_id: "codex-preload-run".into(), ..resumed("gpt-new", Some("high")) };
        let (server, sent) = adopt(thread, &switched, run(title_catalog()), true, &sink).expect("same thread and catalog");
        assert_eq!(url(server.as_ref().unwrap()), loaded_with, "the run serves at the address the thread knows");
        assert_eq!(sent.len(), 3);
        child.kill().await.unwrap();
        // Another catalog, or no server for the run: the loaded thread lists other tools.
        let (mut child, _group, _pending, thread) = spare(&log, "none", &config, title_catalog()).await.unwrap();
        assert!(adopt(thread.unwrap(), &switched, run(Vec::new()), false, &sink).is_none());
        child.kill().await.unwrap();
        let _ = std::fs::remove_file(&log);
    }

    /// The whole send: the spare's thread is adopted, its replies replayed through the run's
    /// parser, and the turn carries today's model and effort.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_run_on_a_loaded_thread_sends_only_its_turn_with_todays_model() {
        let _serial = super::super::concurrent_process_tests::process_test_lock().lock().await;
        let log = std::env::temp_dir().join(format!("codex-preload-run-{}", uuid::Uuid::new_v4()));
        let loaded = RunConfig { session_id: "codex-preload-run".into(), ..resumed("gpt-old", Some("low")) };
        let (child, group, pending, thread) = spare(&log, "none", &loaded, Vec::new()).await.unwrap();
        super::super::handshake_warm::insert_preloaded_for_test(&loaded.session_id, &fake_codex(&log, "none"), &loaded.cwd, child, group, pending, thread);
        let config = RunConfig { prompt: "hi".into(), ..RunConfig { session_id: loaded.session_id.clone(), ..resumed("gpt-new", Some("high")) } };
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let sink: Sink = Arc::new(move |event: AgentEvent| seen.lock().unwrap().push(event));
        let (_input, receiver) = tokio::sync::mpsc::unbounded_channel();
        let run = run_process(config, sink, receiver, fake_codex(&log, "none"), Vec::new());
        tokio::time::timeout(Duration::from_secs(10), run).await.expect("the turn ends").expect("the turn succeeds");
        let sent = methods(&log);
        assert_eq!(names(&sent), ["initialize", "initialized", "thread/goal/get", "thread/resume", "model/list", "turn/start"], "one process, one load");
        let turn = &sent[5]["params"];
        assert_eq!((turn["model"].as_str(), turn["effort"].as_str(), turn["threadId"].as_str()), (Some("gpt-new"), Some("high"), Some("thread-1")));
        assert_eq!(turn["approvalPolicy"], "on-request", "permissions are the send's");
        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| event.kind == "session" && event.text == "thread-1"), "the replayed load is parsed as a cold one");
        assert!(events.iter().any(|event| event.text.contains("warm reply")));
        drop(events);
        let _ = std::fs::remove_file(&log);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_goal_turn_never_uses_a_loaded_thread() {
        let _serial = super::super::concurrent_process_tests::process_test_lock().lock().await;
        let log = std::env::temp_dir().join(format!("codex-preload-goal-run-{}", uuid::Uuid::new_v4()));
        let loaded = RunConfig { session_id: "codex-preload-goal".into(), ..resumed("gpt-old", Some("low")) };
        let (child, group, pending, thread) = spare(&log, "none", &loaded, Vec::new()).await.unwrap();
        super::super::handshake_warm::insert_preloaded_for_test(&loaded.session_id, &fake_codex(&log, "none"), &loaded.cwd, child, group, pending, thread);
        let config = RunConfig { goal: Some(GoalRequest::Get), ..loaded.clone() };
        let (_input, receiver) = tokio::sync::mpsc::unbounded_channel();
        let run = run_process(config, Arc::new(|_| {}), receiver, fake_codex(&log, "none"), Vec::new());
        let _ = tokio::time::timeout(Duration::from_secs(5), run).await;
        let sent = names(&methods(&log)).iter().map(|name| name.to_string()).collect::<Vec<_>>();
        assert_eq!(sent.iter().filter(|name| *name == "initialize").count(), 2, "the goal turn started its own process: {sent:?}");
        assert!(!super::super::handshake_warm::present(&loaded.session_id), "the loaded spare was dropped");
        let _ = std::fs::remove_file(&log);
    }
}
