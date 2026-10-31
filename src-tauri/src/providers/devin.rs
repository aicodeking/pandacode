//! Devin for Terminal (`devin acp`) over the shared ACP transport. Devin keeps
//! its own sign-in (`devin auth login`, or `WINDSURF_API_KEY`); PandaCode never
//! calls `authenticate`. Its session modes are Code (`accept-edits`), Plan and
//! Bypass Permissions, and every model carries its own `thought_level` choices,
//! which `session/new` reports only for the current model.
use super::*;
use crate::slash_commands::claude::Pipe;

/// Shown when Devin has no stored sign-in.
pub(super) const SIGN_IN: &str = "Devin is not signed in. Run `devin auth login` in a terminal, then send again.";
/// Devin Desktop's own terminals export this; with it set, `devin acp` ignores
/// the CLI sign-in and waits for the host to authenticate.
const HOST_CREDENTIALS: &str = "ACP_BACKEND";
/// Devin Desktop ships the CLI inside its app bundle.
const BUNDLED: &str = "Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin";
/// Account and mode commands stay with Devin's CLI and PandaCode's mode picker:
/// `/login` would put a key in the transcript and `/bypass` would widen approvals.
pub(crate) const HIDDEN_COMMANDS: [&str; 7] = ["login", "logout", "ask", "plan", "code", "bypass", "normal"];
/// Plan mode's exit request offers to implement with edits accepted or with
/// approvals bypassed; PandaCode only ever chooses the first.
pub(super) const IMPLEMENT_PLAN: &str = "plan_accept_edits";

/// Discovery opens a few short sessions in parallel: `session/new` lists every
/// model, but each model's efforts appear only after switching to it (about
/// 80 ms each). Two processes with four sessions each stay well inside the
/// pipe limits.
const PROCESSES: usize = 2;
const SESSIONS: usize = 4;
const STARTUP: Duration = Duration::from_secs(60);
const CLEANUP: Duration = Duration::from_secs(2);

pub(super) fn configure(command: &mut Command) {
    command.arg("acp");
    command.env_remove(HOST_CREDENTIALS);
}

/// The Devin session mode for a PandaCode approval mode. Devin's Code mode
/// already applies edits inside the project, so Standard and Accept edits share it.
pub(super) fn mode_id(mode: &str) -> &'static str {
    match mode {
        "plan" => "plan",
        "full" => "bypass",
        _ => "accept-edits",
    }
}

/// The CLI bundled with Devin Desktop, for installs without `devin` on PATH.
pub(super) fn bundled() -> Option<PathBuf> {
    let home = crate::agent_usage_providers::home();
    [Some(PathBuf::from("/Applications")), home.map(|home| home.join("Applications"))]
        .into_iter()
        .flatten()
        .map(|root| root.join(BUNDLED))
        .find(|path| cfg!(target_os = "macos") && path.is_file())
}

/// An empty folder for discovery sessions: Devin rescans its workspace on each
/// model switch, and the system temp folder can hold thousands of entries.
fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join("pandacode-devin-discovery");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn command(path: &Path) -> Result<Command, String> {
    let mut command = super::provider_command("devin", path)?;
    configure(&mut command);
    Ok(command)
}

fn initialize() -> Value {
    json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"pandacode","version":"0.1.0"}}})
}

fn session_error(frame: &Value) -> String {
    if frame["error"]["code"] == -32000 {
        SIGN_IN.into()
    } else {
        acp::rpc_error(frame, "session creation")
    }
}

fn transport(pipe: &Pipe) -> String {
    if pipe.timed_out() {
        acp::ACP_STARTUP_TIMEOUT.into()
    } else {
        "Devin's ACP server ended before it answered. Check the Devin installation and sign-in, then refresh.".into()
    }
}

/// One discovery process: `sessions` empty sessions, each switching through
/// its share of the models, then deleted so they never appear in `devin list`.
struct Probe {
    session: Value,
    efforts: HashMap<String, Value>,
}

async fn probe(path: &Path, slice: usize, slices: usize) -> Result<Probe, String> {
    let cwd = scratch();
    let mut pipe = Pipe::spawn(command(path)?, &cwd, STARTUP)
        .map_err(|_| "Could not start Devin's ACP server. Check the selected executable.".to_owned())?;
    let result = probe_frames(&mut pipe, &cwd, slice, slices).await;
    pipe.finish().await;
    result.map_err(|error| super::diagnostics::failure(&error, pipe.diagnostic()))
}

async fn probe_frames(pipe: &mut Pipe, cwd: &Path, slice: usize, slices: usize) -> Result<Probe, String> {
    const NEW: u64 = 10;
    const SET: u64 = 100;
    const DELETE: u64 = 9000;
    pipe.send(&initialize()).await.map_err(|_| transport(pipe))?;
    let mut sessions: Vec<String> = Vec::new();
    let mut first = Value::Null;
    let mut queues: Vec<Vec<String>> = Vec::new();
    let mut pending: HashMap<u64, (usize, String)> = HashMap::new();
    let mut efforts = HashMap::new();
    let mut next = SET;
    let mut deleting = 0;
    loop {
        let frame = match pipe.read().await {
            Ok(frame) => frame,
            Err(()) if deleting > 0 => break,
            Err(()) => return Err(transport(pipe)),
        };
        if frame.get("method").is_some() {
            if frame.get("id").is_some() {
                let _ = pipe.send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Metadata discovery does not execute requests"}})).await;
            }
            continue;
        }
        let Some(id) = frame["id"].as_u64() else { continue };
        match id {
            1 => {
                if frame.get("error").is_some() {
                    return Err(acp::rpc_error(&frame, "initialize"));
                }
                if frame["result"]["protocolVersion"] != 1 {
                    return Err("This Devin version does not support ACP protocol v1. Update Devin.".into());
                }
                for index in 0..SESSIONS as u64 {
                    pipe.send(&json!({"jsonrpc":"2.0","id":NEW + index,"method":"session/new","params":{"cwd":launch::external_path(cwd),"mcpServers":[]}})).await.map_err(|_| transport(pipe))?;
                }
            }
            id if (NEW..NEW + SESSIONS as u64).contains(&id) => {
                if frame.get("error").is_some() {
                    return Err(session_error(&frame));
                }
                let session = field(&frame["result"], "sessionId");
                if session.is_empty() || session.len() > 256 {
                    return Err("Devin did not return a session ID.".into());
                }
                sessions.push(session.into());
                if first.is_null() {
                    first = frame["result"].clone();
                }
                if sessions.len() == SESSIONS {
                    let ids: Vec<String> = acp::options(&first, "model")
                        .map(acp::choices)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|choice| field(choice, "value").to_owned())
                        .filter(|id| valid_model_id(id) && !is_fusion(id))
                        .enumerate()
                        .filter(|(index, _)| index % slices == slice)
                        .map(|(_, id)| id)
                        .collect();
                    queues = (0..SESSIONS).map(|lane| ids.iter().skip(lane).step_by(SESSIONS).cloned().collect()).collect();
                    for lane in 0..SESSIONS {
                        switch(pipe, &sessions, &mut queues, &mut pending, &mut next, lane).await?;
                    }
                }
            }
            id if id >= DELETE => {
                deleting -= 1;
                if deleting == 0 {
                    break;
                }
            }
            id => {
                let Some((lane, model)) = pending.remove(&id) else { continue };
                // A model the account cannot switch to keeps its name without efforts.
                if frame.get("result").is_some() {
                    let option = acp::options(&frame["result"], "thought_level").cloned().unwrap_or(Value::Null);
                    efforts.insert(model, option);
                }
                switch(pipe, &sessions, &mut queues, &mut pending, &mut next, lane).await?;
            }
        }
        if sessions.len() == SESSIONS && pending.is_empty() && deleting == 0 {
            for (index, session) in sessions.iter().enumerate() {
                pipe.send(&json!({"jsonrpc":"2.0","id":DELETE + index as u64,"method":"session/delete","params":{"sessionId":session}})).await.map_err(|_| transport(pipe))?;
            }
            deleting = sessions.len();
            pipe.set_deadline_after(CLEANUP);
        }
    }
    Ok(Probe { session: first, efforts })
}

async fn switch(
    pipe: &mut Pipe,
    sessions: &[String],
    queues: &mut [Vec<String>],
    pending: &mut HashMap<u64, (usize, String)>,
    next: &mut u64,
    lane: usize,
) -> Result<(), String> {
    if queues[lane].is_empty() {
        return Ok(());
    }
    let model = queues[lane].remove(0);
    *next += 1;
    pipe.send(&json!({"jsonrpc":"2.0","id":*next,"method":"session/set_config_option","params":{"sessionId":sessions[lane],"configId":"model","value":model}}))
        .await
        .map_err(|_| transport(pipe))?;
    pending.insert(*next, (lane, model));
    Ok(())
}

/// Fusion pairs two models and takes about a second to switch to, while its
/// efforts do not always match either model's, so discovery lists it without
/// efforts and a run keeps the effort Devin has saved for it.
fn is_fusion(id: &str) -> bool {
    id.starts_with("fusion-")
}

/// Models with their own efforts. No prompt is sent and no inference runs.
pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    if let Some(models) = acp_catalog::get("devin", path) {
        return Ok(models);
    }
    let _refresh = acp_catalog::refresh_lock("devin", path).await;
    if let Some(models) = acp_catalog::get("devin", path) {
        return Ok(models);
    }
    let discovery = acp_catalog::begin("devin", path);
    let results = futures_util::future::join_all((0..PROCESSES).map(|slice| probe(path, slice, PROCESSES))).await;
    let mut session = Value::Null;
    let mut efforts = HashMap::new();
    let mut failure = None;
    for result in results {
        match result {
            Ok(probe) => {
                if session.is_null() {
                    session = probe.session;
                }
                efforts.extend(probe.efforts);
            }
            Err(error) => failure = failure.or(Some(error)),
        }
    }
    if session.is_null() {
        return Err(failure.unwrap_or_else(|| "Devin did not list its models.".into()));
    }
    let models = catalog(&session, &efforts);
    acp_catalog::store_models(discovery, models.clone());
    Ok(models)
}

/// Builds the picker catalog from a `session/new` result and each model's
/// `thought_level` option (`Null` when it has none).
pub(super) fn catalog(session: &Value, efforts: &HashMap<String, Value>) -> Vec<ModelInfo> {
    let mut models = vec![ModelInfo {
        description: "Use the model set in Devin (agent.model, or your plan's default)".into(),
        ..ModelInfo::default_choice()
    }];
    let Some(option) = acp::options(session, "model") else { return models };
    let current = field(option, "currentValue");
    let current_effort = acp::options(session, "thought_level").cloned().unwrap_or(Value::Null);
    for choice in acp::choices(option) {
        let id = field(choice, "value");
        if !valid_model_id(id) {
            continue;
        }
        let effort = efforts.get(id).or((id == current).then_some(&current_effort)).unwrap_or(&Value::Null);
        let reasoning_efforts: Vec<ReasoningEffortInfo> = if effort.is_object() {
            acp::choices(effort)
                .into_iter()
                .take(16)
                .filter_map(|choice| {
                    let id = field(choice, "value");
                    validate_reasoning_effort("devin", Some(id)).ok()?;
                    Some(effort_info(id, None))
                })
                .collect()
        } else {
            Vec::new()
        };
        let default_reasoning_effort = effort["currentValue"]
            .as_str()
            .filter(|value| reasoning_efforts.iter().any(|effort| effort.id == *value))
            .map(str::to_owned);
        models.push(ModelInfo {
            id: id.into(),
            name: model_text(choice["name"].as_str(), id, 160),
            description: if choice["_meta"]["cognition.ai/supportsImages"] == false { "Text only".into() } else { String::new() },
            reasoning_efforts,
            default_reasoning_effort,
            context_window: None,
        });
    }
    models
}

/// The model a run will use does not take images; checked before the prompt.
pub(super) fn rejects_images(config: &Value, model: &str) -> bool {
    let Some(option) = acp::options(config, "model") else { return false };
    let target = if model.is_empty() || model == "default" { field(option, "currentValue") } else { model };
    acp::choices(option)
        .into_iter()
        .find(|choice| choice["value"] == target)
        .is_some_and(|choice| choice["_meta"]["cognition.ai/supportsImages"] == false)
}

/// Approval text for a permission request. Devin sends only the tool call ID
/// and, for shell commands, the command itself.
pub(super) fn approval_label(request: &Value, tool: Option<&ToolActivity>) -> String {
    let call = &request["params"]["toolCall"];
    if is_plan_exit(request) {
        return "Implement this plan? Devin switches to Code mode and applies edits.".into();
    }
    if let Some(command) = call["_meta"]["cognition.ai/editableCommand"].as_str().filter(|text| !text.trim().is_empty()) {
        return format!("Run `{}`?", model_text(Some(command), "a command", 300));
    }
    let title = call["title"].as_str().filter(|text| !text.is_empty()).or(tool.map(|tool| tool.name.as_str()));
    model_text(title, "Allow this Devin action?", 300)
}

/// Plan mode ends with an `exit_plan_mode` request that offers to implement.
pub(super) fn is_plan_exit(request: &Value) -> bool {
    request["params"]["options"]
        .as_array()
        .is_some_and(|options| options.iter().any(|option| option["optionId"] == IMPLEMENT_PLAN))
}

/// The option PandaCode answers with. Approving never chooses a standing grant
/// or a switch to bypass mode; the user approves this one action.
pub(super) fn decision(request: &Value, approved: bool) -> Value {
    let options = request["params"]["options"].as_array().map(Vec::as_slice).unwrap_or_default();
    let selected = if approved {
        options.iter().find(|option| option["optionId"] == IMPLEMENT_PLAN || option["optionId"] == "allow_once")
    } else {
        options.iter().find(|option| option["kind"] == "reject_once")
    };
    let outcome = selected
        .map(|option| json!({"outcome":"selected","optionId":option["optionId"]}))
        .unwrap_or_else(|| json!({"outcome":"cancelled"}));
    json!({"jsonrpc":"2.0","id":request["id"],"result":{"outcome":outcome}})
}

/// Usage from a subagent describes another context window, not the task's.
pub(super) fn subagent_usage(frame: &Value) -> bool {
    let update = &frame["params"]["update"];
    update["sessionUpdate"] == "usage_update" && update["_meta"].get("cognition.ai/subagent_context").is_some()
}

/// Commands for a project folder, from a session that is deleted afterwards.
pub(crate) async fn commands(path: &Path, cwd: &Path) -> Result<Option<Value>, String> {
    let mut pipe = Pipe::spawn(command(path)?, cwd, STARTUP)
        .map_err(|_| "Could not start Devin's ACP server. Check the selected executable.".to_owned())?;
    let result = async {
        pipe.send(&initialize()).await.map_err(|_| transport(&pipe))?;
        let mut session = String::new();
        let mut commands = None;
        loop {
            let frame = match pipe.read().await {
                Ok(frame) => frame,
                Err(()) if !session.is_empty() => break,
                Err(()) => return Err(transport(&pipe)),
            };
            if frame.get("method").is_some() && frame.get("id").is_some() {
                let _ = pipe.send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Command discovery does not execute requests"}})).await;
            } else if frame["id"] == 1 {
                pipe.send(&json!({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":launch::external_path(cwd),"mcpServers":[]}})).await.map_err(|_| transport(&pipe))?;
            } else if frame["id"] == 2 {
                if frame.get("error").is_some() {
                    return Err(session_error(&frame));
                }
                session = field(&frame["result"], "sessionId").to_owned();
                pipe.set_deadline_after(Duration::from_secs(1));
            } else if frame["method"] == "session/update" && frame["params"]["update"]["sessionUpdate"] == "available_commands_update" {
                commands = Some(frame);
            }
            if !session.is_empty() && commands.as_ref().is_some_and(|frame: &Value| frame["params"]["sessionId"] == session.as_str()) {
                break;
            }
        }
        if !session.is_empty() {
            pipe.set_deadline_after(CLEANUP);
            let _ = pipe.send(&json!({"jsonrpc":"2.0","id":3,"method":"session/delete","params":{"sessionId":session}})).await;
            while let Ok(frame) = pipe.read().await {
                if frame["id"] == 3 {
                    break;
                }
            }
        }
        Ok(commands.filter(|frame| frame["params"]["sessionId"] == session.as_str()))
    }
    .await;
    pipe.finish().await;
    result.map_err(|error| super::diagnostics::failure(&error, pipe.diagnostic()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Recorded from `devin acp` 3000.11.216 (`_meta` capability list shortened).
    const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":true},"sessionCapabilities":{"list":{},"delete":{},"additionalDirectories":{},"close":{}},"auth":{},"_meta":{"cognition.ai/midTurnPrompts":true}},"authMethods":[{"id":"devin-browser","name":"Log in with browser","description":"Sign in via your browser"}],"agentInfo":{"name":"affogato","title":"Devin Agent","version":"0.0.0-dev"}}}"#;

    fn option(id: &str, category: &str, current: &str, values: &[(&str, &str)]) -> Value {
        json!({"id":id,"name":id,"category":category,"type":"select","currentValue":current,
            "options":values.iter().map(|(value, name)| json!({"value":value,"name":name,"_meta":{"cognition.ai/supportsImages":*value != "glm-5-2"}})).collect::<Vec<_>>()})
    }

    /// Recorded `session/new` (models shortened from 112).
    fn session(mode: &str, model: &str, effort: &str) -> Value {
        json!({"sessionId":"garnet-sweater",
            "modes":{"currentModeId":mode,"availableModes":[{"id":"accept-edits","name":"Code"},{"id":"ask","name":"Ask"},{"id":"plan","name":"Plan"},{"id":"bypass","name":"Bypass Permissions"}]},
            "configOptions":[
                option("mode", "mode", mode, &[("accept-edits", "Code"), ("ask", "Ask"), ("plan", "Plan"), ("bypass", "Bypass Permissions")]),
                option("model", "model", model, &[("adaptive", "Adaptive"), ("swe-2-high", "SWE-2"), ("claude-opus-5-5-medium", "Claude Opus 5.5"), ("glm-5-2", "GLM-5.2 High")]),
                option("thought_level", "thought_level", effort, &[("medium", "Medium"), ("high", "High"), ("max", "Max")]),
                option("speed", "model_config", "standard", &[("standard", "Standard"), ("fast", "Fast")])],
            "_meta":{"cognition.ai/isLocked":false}})
    }

    fn started(cfg: RunConfig, result: Value) -> (Protocol, Vec<Value>) {
        let mut p = Protocol::new(cfg);
        let mut writes = p.receive(serde_json::from_str(INITIALIZE).unwrap()).unwrap().write;
        assert_eq!(writes[0]["method"], if p.remote_id.is_empty() { "session/new" } else { "session/load" });
        assert!(writes[0]["params"]["sessionId"].is_null() || writes[0]["params"]["sessionId"] == "garnet-sweater");
        writes.extend(p.receive(json!({"jsonrpc":"2.0","id":2,"result":result})).unwrap().write);
        (p, writes)
    }

    fn cfg(mode: &str, model: &str, effort: Option<&str>) -> RunConfig {
        let mut cfg = super::super::tests::config("devin");
        cfg.mode = mode.into();
        cfg.model = model.into();
        cfg.reasoning_effort = effort.map(str::to_owned);
        cfg
    }

    #[test]
    fn launch_uses_acp_and_drops_desktop_host_credentials() {
        let mut command = Command::new("devin");
        configure(&mut command);
        let std = command.as_std();
        assert_eq!(std.get_args().collect::<Vec<_>>(), ["acp"]);
        assert!(std.get_envs().any(|(name, value)| name == HOST_CREDENTIALS && value.is_none()));
    }

    #[test]
    fn modes_map_to_devin_session_modes_and_unchanged_settings_skip_round_trips() {
        // A fresh session is already in Code mode on the default model: prompt at once.
        let (_, writes) = started(cfg("ask", "default", None), session("accept-edits", "swe-2-high", "high"));
        assert_eq!(writes[1]["method"], "session/prompt");
        for (mode, expected) in [("plan", "plan"), ("full", "bypass"), ("auto", "accept-edits")] {
            let (mut p, writes) = started(cfg(mode, "default", None), session("ask", "swe-2-high", "high"));
            assert_eq!((writes[1]["params"]["configId"].clone(), writes[1]["params"]["value"].clone()), (json!("mode"), json!(expected)), "{mode}");
            let next = p.receive(json!({"jsonrpc":"2.0","id":4,"result":{}})).unwrap().write.remove(0);
            assert_eq!(next["method"], "session/prompt");
        }
    }

    #[test]
    fn a_resumed_task_sets_only_what_changed() {
        let mut resumed = cfg("ask", "claude-opus-5-5-medium", Some("max"));
        resumed.resume_id = Some("garnet-sweater".into());
        let mut p = Protocol::new(resumed);
        p.remote_id = "garnet-sweater".into();
        let writes = p.receive(serde_json::from_str(INITIALIZE).unwrap()).unwrap().write;
        assert_eq!(writes[0]["method"], "session/load");
        // Recorded load replay arrives before the response and is not shown again.
        let replay = p.receive(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"garnet-sweater","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"DONE"}}}})).unwrap();
        assert!(replay.events.iter().all(|event| event.kind != "text"));
        // Same model and effort: no settings round trip at all.
        let step = p.receive(json!({"jsonrpc":"2.0","id":2,"result":session("accept-edits", "claude-opus-5-5-medium", "max")})).unwrap();
        assert_eq!(step.write[0]["method"], "session/prompt");

        // A different model is set, then the effort its own options advertise.
        let (mut p, writes) = started(cfg("ask", "claude-opus-5-5-medium", Some("max")), session("accept-edits", "swe-2-high", "high"));
        assert_eq!((writes[1]["params"]["configId"].clone(), writes[1]["params"]["value"].clone()), (json!("model"), json!("claude-opus-5-5-medium")));
        let updated = session("accept-edits", "claude-opus-5-5-medium", "medium");
        let effort = p.receive(json!({"jsonrpc":"2.0","id":5,"result":{"configOptions":updated["configOptions"]}})).unwrap().write.remove(0);
        assert_eq!((effort["params"]["configId"].clone(), effort["params"]["value"].clone()), (json!("thought_level"), json!("max")));
        assert_eq!(p.receive(json!({"jsonrpc":"2.0","id":6,"result":{}})).unwrap().write[0]["method"], "session/prompt");
    }

    #[test]
    fn missing_sign_in_names_the_cli_command() {
        let mut p = Protocol::new(cfg("ask", "default", None));
        p.receive(serde_json::from_str(INITIALIZE).unwrap()).unwrap();
        // Recorded when `devin acp` has no usable credentials.
        let error = p.receive(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"ACP host has not authenticated. Call the `authenticate` ACP method with `meta.api_key` set to the user's API key (or invoke the browser auth method to start the PKCE browser flow) before opening a session."}})).err().unwrap();
        assert_eq!(error, SIGN_IN);
    }

    #[test]
    fn a_text_only_model_refuses_images_before_the_prompt() {
        let mut config = cfg("ask", "glm-5-2", None);
        config.images = vec![PathBuf::from("/tmp/shot.png")];
        let mut p = Protocol::new(config);
        p.image_blocks = vec![json!({"type":"image","mimeType":"image/png","data":"AA=="})];
        p.receive(serde_json::from_str(INITIALIZE).unwrap()).unwrap();
        let error = p.receive(json!({"jsonrpc":"2.0","id":2,"result":session("accept-edits", "swe-2-high", "high")})).err().unwrap();
        assert!(error.contains("does not accept images"));
    }

    /// Recorded exec permission request in Code mode.
    fn exec_request() -> Value {
        json!({"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"garnet-sweater",
            "toolCall":{"toolCallId":"exec:0#a9a2","_meta":{"cognition.ai/editableCommand":"python3 -c 'import os; os.remove(\"hello.txt\")'"}},
            "options":[{"optionId":"allow_once","name":"Allow","kind":"allow_once"},{"optionId":"allow_session","name":"Yes, allow `python3` commands (this session)","kind":"allow_always"},{"optionId":"allow_always","name":"Yes, always allow `python3` commands in `devin-probe`","kind":"allow_always"},{"optionId":"allow_always_global","name":"Yes, always allow `python3` commands in all projects","kind":"allow_always"},{"optionId":"switch_bypass","name":"Yes, switch to bypass mode","kind":"allow_always"},{"optionId":"reject_once","name":"Reject","kind":"reject_once"}]}})
    }

    /// Recorded `exit_plan_mode` request at the end of a Plan turn.
    fn plan_exit_request() -> Value {
        json!({"jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{"sessionId":"garnet-sweater",
            "toolCall":{"toolCallId":"exit_plan_mode:2#7c96"},
            "options":[{"optionId":"plan_accept_edits","name":"Yes, implement plan and accept edits","kind":"allow_once"},{"optionId":"plan_bypass","name":"Yes, implement plan and bypass permissions","kind":"allow_once"},{"optionId":"reject_once","name":"No, plan needs changes","kind":"reject_once"}]}})
    }

    fn ask(p: &mut Protocol, request: Value) -> (String, String) {
        let step = p.receive(request).unwrap();
        assert!(step.write.is_empty(), "the user decides");
        let event = step.events.into_iter().find(|event| event.kind == "approval").unwrap();
        (event.request_id.unwrap(), event.text)
    }

    #[test]
    fn approvals_grant_one_action_never_a_standing_rule_or_bypass() {
        let (mut p, _) = started(cfg("ask", "default", None), session("accept-edits", "swe-2-high", "high"));
        let (id, text) = ask(&mut p, exec_request());
        assert_eq!(text, "Run `python3 -c 'import os; os.remove(\"hello.txt\")'`?");
        assert_eq!(p.approve(&id, true).unwrap()["result"]["outcome"]["optionId"], "allow_once");
        let (id, _) = ask(&mut p, exec_request());
        assert_eq!(p.approve(&id, false).unwrap()["result"]["outcome"]["optionId"], "reject_once");

        let (mut p, _) = started(cfg("plan", "default", None), session("plan", "swe-2-high", "high"));
        let (id, text) = ask(&mut p, plan_exit_request());
        assert!(text.starts_with("Implement this plan?"));
        assert_eq!(p.approve(&id, true).unwrap()["result"]["outcome"]["optionId"], IMPLEMENT_PLAN);
        let (id, _) = ask(&mut p, plan_exit_request());
        assert_eq!(p.approve(&id, false).unwrap()["result"]["outcome"]["optionId"], "reject_once");
    }

    #[test]
    fn full_access_answers_commands_itself_but_still_asks_before_implementing_a_plan() {
        let (mut p, _) = started(cfg("full", "default", None), session("bypass", "swe-2-high", "high"));
        let step = p.receive(exec_request()).unwrap();
        assert_eq!(step.write[0]["result"]["outcome"]["optionId"], "allow_once");
        assert!(step.events.iter().all(|event| event.kind != "approval"));
        ask(&mut p, plan_exit_request());
    }

    #[test]
    fn subagent_usage_does_not_overwrite_the_task_context() {
        let (mut p, _) = started(cfg("ask", "default", None), session("accept-edits", "swe-2-high", "high"));
        let usage = |meta: Value| json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"garnet-sweater","update":{"sessionUpdate":"usage_update","used":21125,"size":262000,"_meta":meta}}});
        let root = p.receive(usage(json!({"cognition.ai/inputTokens":21057}))).unwrap();
        assert!(root.events.iter().any(|event| event.kind == "usage"));
        let child = p.receive(usage(json!({"cognition.ai/subagent_context":{"parentAgentId":"root"}}))).unwrap();
        assert!(child.events.is_empty() && child.write.is_empty());
    }

    #[test]
    fn a_steer_joins_the_running_turn() {
        let (mut p, _) = started(cfg("ask", "default", None), session("accept-edits", "swe-2-high", "high"));
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        let step = p.acp_steer("s1".into(), "Also add BRAVO".into(), tx);
        assert_eq!(rx.try_recv().unwrap().unwrap()["mode"], "live");
        assert_eq!(step.write[0]["method"], "session/prompt");
        let request = step.write[0]["id"].clone();
        // Recorded: both prompts answer at turn end, the steer's first-class answer only ends the run once.
        let first = p.receive(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}})).unwrap();
        assert!(!first.done);
        assert!(p.receive(json!({"jsonrpc":"2.0","id":request,"result":{"stopReason":"end_turn"}})).unwrap().done);
    }

    #[test]
    fn catalog_lists_every_model_with_its_own_efforts() {
        let mut efforts = HashMap::new();
        efforts.insert("claude-opus-5-5-medium".to_owned(), option("thought_level", "thought_level", "medium", &[("low", "Low"), ("medium", "Medium"), ("high", "High"), ("xhigh", "XHigh"), ("max", "Max")]));
        efforts.insert("adaptive".to_owned(), Value::Null);
        let models = catalog(&session("accept-edits", "swe-2-high", "high"), &efforts);
        let ids: Vec<_> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, ["default", "adaptive", "swe-2-high", "claude-opus-5-5-medium", "glm-5-2"]);
        assert!(models[1].reasoning_efforts.is_empty());
        // The current model's efforts come from session/new itself.
        assert_eq!(models[2].reasoning_efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["medium", "high", "max"]);
        assert_eq!(models[2].default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(models[3].reasoning_efforts.len(), 5);
        assert_eq!(models[3].reasoning_efforts[3].name, "Extra high");
        assert_eq!(models[3].default_reasoning_effort.as_deref(), Some("medium"));
        assert_eq!(models[4].description, "Text only");
        assert!(rejects_images(&session("accept-edits", "glm-5-2", "high"), "default"));
        assert!(!rejects_images(&session("accept-edits", "glm-5-2", "high"), "swe-2-high"));
    }

    /// Needs a signed-in Devin CLI. Sends two short prompts on Devin's default
    /// model through the real run pipeline: a new task, then a resumed follow-up,
    /// which must reuse the saved session settings without a settings round trip.
    #[tokio::test]
    #[ignore = "requires an installed, signed-in Devin CLI; sends two short prompts"]
    async fn installed_devin_runs_and_resumes_a_task() {
        let cwd = std::env::temp_dir().join(format!("pandacode-devin-live-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&cwd).unwrap();
        let turn = |prompt: &str, resume: Option<String>| {
            let mut config = super::super::tests::config("devin");
            config.cwd = cwd.clone();
            config.prompt = prompt.into();
            config.resume_id = resume;
            let events = Arc::new(Mutex::new(Vec::<AgentEvent>::new()));
            let seen = events.clone();
            let sink: Sink = Arc::new(move |event| seen.lock().unwrap().push(event));
            let (input, receiver) = tokio::sync::mpsc::unbounded_channel::<RunInput>();
            async move {
                // A closed input channel means Stop; hold it open for the turn.
                let _input = input;
                run(config, sink, receiver).await.expect("the turn should finish");
                let events = events.lock().unwrap().clone();
                events
            }
        };
        let text = |events: &[AgentEvent]| events.iter().filter(|e| e.kind == "text" || e.kind == "delta").map(|e| e.text.as_str()).collect::<String>();
        let first = turn("Reply with exactly the word PANDA and nothing else.", None).await;
        let session = first.iter().find(|event| event.kind == "session").expect("a session id").text.clone();
        assert!(text(&first).contains("PANDA"), "{:?}", first.iter().map(|e| (&e.kind, &e.text)).collect::<Vec<_>>());
        let second = turn("Reply with exactly the word BAMBOO and nothing else.", Some(session.clone())).await;
        assert!(text(&second).contains("BAMBOO"), "{:?}", second.iter().map(|e| (&e.kind, &e.text)).collect::<Vec<_>>());
        assert!(second.iter().all(|event| !event.text.starts_with("Applying")), "a resumed task on the same settings skips set_config_option");
        assert_eq!(second.iter().find(|event| event.kind == "session").unwrap().text, session);
        // Leave nothing in the user's Devin history.
        let path = executable("devin").unwrap();
        let mut pipe = Pipe::spawn(command(&path).unwrap(), &cwd, STARTUP).unwrap();
        pipe.send(&initialize()).await.unwrap();
        pipe.send(&json!({"jsonrpc":"2.0","id":2,"method":"session/delete","params":{"sessionId":session}})).await.unwrap();
        while let Ok(frame) = pipe.read().await {
            if frame["id"] == 2 {
                assert!(frame.get("error").is_none(), "{frame}");
                break;
            }
        }
        pipe.finish().await;
        let _ = std::fs::remove_dir_all(&cwd);
    }

    /// Needs Devin CLI installed and signed in with `devin auth login`. Opens and
    /// deletes empty sessions; sends no prompt.
    #[tokio::test]
    #[ignore = "requires an installed, signed-in Devin CLI"]
    async fn installed_devin_lists_models_with_efforts() {
        let path = executable("devin").expect("Install Devin CLI first");
        let started = std::time::Instant::now();
        let models = models(&path).await.expect("Devin ACP discovery should succeed");
        eprintln!("{} models in {:?}", models.len(), started.elapsed());
        assert!(models.len() > 2);
        assert!(models.iter().filter(|model| !model.reasoning_efforts.is_empty()).count() > 2);
        let commands = commands(&path, &std::env::temp_dir()).await.unwrap().expect("commands");
        assert_eq!(commands["method"], "session/update");
    }
}
