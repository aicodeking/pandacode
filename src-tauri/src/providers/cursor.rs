//! Cursor's CLI (`cursor-agent acp`) over the shared ACP transport. Cursor keeps
//! its own sign-in (`cursor-agent login`, or `CURSOR_API_KEY`); a signed-in CLI
//! opens sessions without `authenticate`. Its session modes are Agent, Plan and
//! Ask. With `parameterizedModelPicker` set, the model option lists base models
//! and each model's effort, context and speed arrive as separate options.
use super::*;
use crate::slash_commands::claude::Pipe;

/// Shown when the CLI has no stored sign-in.
pub(super) const SIGN_IN: &str = "Cursor is not signed in. Run `cursor-agent login` in a terminal, then send again.";
/// Cursor's own request for the whole catalog, every model with its options.
const LIST_MODELS: &str = "cursor/list_available_models";
/// The answer to Cursor's interactive-question tool, which PandaCode cannot show mid-turn.
const QUESTION_SKIPPED: &str = "PandaCode cannot show interactive questions. Ask the question in your reply instead, list the options, and wait for the user's answer.";
const PLAN_LIMIT: usize = 64 * 1024;
const STARTUP: Duration = Duration::from_secs(60);

pub(super) fn client_capabilities() -> Value {
    json!({"_meta":{"parameterizedModelPicker":true}})
}

fn initialize() -> Value {
    json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":client_capabilities(),"clientInfo":{"name":"pandacode","version":"0.1.0"}}})
}

pub(super) fn configure(command: &mut Command) {
    command.arg("acp");
}

/// The installer also links the CLI as `agent`, a name too generic to trust
/// unless it resolves into Cursor's own install.
pub(super) fn agent_alias() -> Option<PathBuf> {
    let path = launch::find("agent")?;
    let target = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
    target.to_string_lossy().contains("cursor-agent").then_some(path)
}

/// The Cursor session mode for a PandaCode approval mode. Agent mode applies
/// file edits without asking and asks before shell commands outside the user's
/// allowlist, so Standard and Accept edits share it; Full access approves
/// those requests here.
pub(super) fn mode_id(mode: &str) -> &'static str {
    if mode == "plan" { "plan" } else { "agent" }
}

/// Plan mode is read-only on Cursor's side; anything it still asks to run is declined.
pub(super) fn permission(mode: &str, kind: &str) -> Option<&'static str> {
    if mode != "plan" {
        return None;
    }
    Some(if matches!(kind, "read" | "search" | "fetch" | "think") { "allow_once" } else { "reject_once" })
}

fn levels(holder: &Value) -> impl Iterator<Item = &Value> {
    holder["configOptions"]
        .as_array()
        .into_iter()
        .flatten()
        .take(64)
        .filter(|option| option["type"] == "select" && option["category"] == "thought_level")
}

/// Some models list both a Thinking switch and an Effort level, both as
/// `thought_level`. The option offering `wanted` wins, then levels over the switch.
pub(super) fn effort_option<'a>(holder: &'a Value, wanted: Option<&str>) -> Option<&'a Value> {
    let switch = |option: &Value| acp::choices(option).iter().all(|choice| matches!(field(choice, "value"), "true" | "false"));
    let offers = |option: &Value| wanted.is_some_and(|wanted| acp::choices(option).iter().any(|choice| choice["value"] == wanted));
    levels(holder)
        .find(|option| offers(option))
        .or_else(|| levels(holder).find(|option| !switch(option)))
        .or_else(|| levels(holder).next())
}

/// Cursor names sizes `272k` or `1m`.
fn context_window(entry: &Value) -> Option<u64> {
    let option = entry["configOptions"].as_array()?.iter().take(64).find(|option| option["id"] == "context")?;
    let value = field(option, "currentValue").to_ascii_lowercase();
    let (number, scale) = if let Some(number) = value.strip_suffix('k') {
        (number, 1_000)
    } else {
        (value.strip_suffix('m')?, 1_000_000)
    };
    number.parse::<u64>().ok().map(|number| number * scale).filter(|tokens| *tokens > 0 && *tokens <= 1_000_000_000)
}

/// Cursor pads some labels with zero-width spaces.
fn label(value: Option<&str>, fallback: &str, limit: usize) -> String {
    model_text(value.map(|text| text.replace('\u{200b}', "")).as_deref(), fallback, limit).trim().to_owned()
}

/// Builds the picker catalog from a `cursor/list_available_models` result.
pub(super) fn catalog(listed: &Value) -> Vec<ModelInfo> {
    let mut models = vec![ModelInfo {
        description: "Use the model last chosen in Cursor".into(),
        ..ModelInfo::default_choice()
    }];
    for entry in listed["models"].as_array().into_iter().flatten().take(MODEL_CATALOG_LIMIT) {
        let id = field(entry, "value");
        if !valid_model_id(id) || id == "default" || models.iter().any(|model| model.id == id) {
            continue;
        }
        let effort = effort_option(entry, None);
        let reasoning_efforts: Vec<ReasoningEffortInfo> = effort
            .map(|option| {
                acp::choices(option)
                    .into_iter()
                    .take(16)
                    .filter_map(|choice| {
                        let value = field(choice, "value");
                        validate_reasoning_effort("cursor", Some(value)).ok()?;
                        Some(ReasoningEffortInfo { id: value.into(), name: label(choice["name"].as_str(), value, 80), description: String::new() })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let default_reasoning_effort = effort
            .and_then(|option| option["currentValue"].as_str())
            .filter(|value| reasoning_efforts.iter().any(|effort| effort.id == *value))
            .map(str::to_owned);
        models.push(ModelInfo {
            id: id.into(),
            name: label(entry["name"].as_str(), id, 160),
            description: String::new(),
            reasoning_efforts,
            default_reasoning_effort,
            context_window: context_window(entry),
        });
    }
    models
}

fn transport(pipe: &Pipe) -> String {
    if pipe.timed_out() {
        acp::ACP_STARTUP_TIMEOUT.into()
    } else {
        "Cursor's ACP server ended before it answered. Check the Cursor CLI installation and sign-in, then refresh.".into()
    }
}

/// An empty folder to start the CLI in: it indexes its workspace on start.
fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join("pandacode-cursor-discovery");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// One request lists every model with its options, so discovery opens no
/// session: nothing lands in Cursor's chat history and the CLI's saved model
/// stays as it was. No prompt is sent.
async fn list(path: &Path) -> Result<Value, String> {
    let mut command = super::provider_command("cursor", path)?;
    configure(&mut command);
    let cwd = scratch();
    let mut pipe = Pipe::spawn(command, &cwd, STARTUP)
        .map_err(|_| "Could not start Cursor's ACP server. Check the selected executable.".to_owned())?;
    let result = async {
        pipe.send(&initialize()).await.map_err(|_| transport(&pipe))?;
        loop {
            let frame = pipe.read().await.map_err(|_| transport(&pipe))?;
            if frame.get("method").is_some() {
                if frame.get("id").is_some() {
                    let _ = pipe.send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Metadata discovery does not execute requests"}})).await;
                }
                continue;
            }
            match frame["id"].as_u64() {
                Some(1) => {
                    if frame.get("error").is_some() {
                        return Err(acp::rpc_error(&frame, "initialize"));
                    }
                    if frame["result"]["protocolVersion"] != 1 {
                        return Err("This Cursor CLI does not support ACP protocol v1. Run `cursor-agent update`.".into());
                    }
                    pipe.send(&json!({"jsonrpc":"2.0","id":2,"method":LIST_MODELS,"params":{}})).await.map_err(|_| transport(&pipe))?;
                }
                Some(2) => {
                    if frame["error"]["code"] == -32000 {
                        return Err(SIGN_IN.into());
                    }
                    if frame.get("error").is_some() {
                        return Err(acp::rpc_error(&frame, "model list"));
                    }
                    return Ok(frame["result"].clone());
                }
                _ => {}
            }
        }
    }
    .await;
    pipe.finish().await;
    result.map_err(|error| super::diagnostics::failure(&error, pipe.diagnostic()))
}

pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    if let Some(models) = acp_catalog::get("cursor", path) {
        return Ok(models);
    }
    let _refresh = acp_catalog::refresh_lock("cursor", path).await;
    if let Some(models) = acp_catalog::get("cursor", path) {
        return Ok(models);
    }
    let discovery = acp_catalog::begin("cursor", path);
    let models = catalog(&list(path).await?);
    acp_catalog::store_models(discovery, models.clone());
    Ok(models)
}

impl Protocol {
    /// Cursor's own requests during a turn. A plan from Plan mode is shown as
    /// text and accepted (Cursor saves it under its own data folder); questions
    /// are skipped with a note so the agent asks in its reply. Anything else
    /// takes the shared unsupported-request answer.
    pub(super) fn cursor_request(&mut self, value: &Value, step: &mut Step) -> bool {
        if value["id"].is_null() {
            return false;
        }
        match field(value, "method") {
            "cursor/create_plan" => {
                let plan = value["params"]["plan"].as_str().unwrap_or_default();
                if !plan.trim().is_empty() {
                    self.kimi_message_id.clear();
                    let id = self.next_text_id();
                    self.text_delta(&id, None, &limited(plan, PLAN_LIMIT), step);
                }
                step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"accepted"}}}));
            }
            "cursor/ask_question" => {
                step.events.push(self.event("status", "Interactive question skipped; the agent asks in its reply", None));
                step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"skipped","reason":QUESTION_SKIPPED}}}));
            }
            _ => return false,
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "aa1e2638-6c14-4a30-8eb8-e7ad3e2238ce";

    /// Recorded from `cursor-agent acp` 2026.10.22.
    fn initialize_result() -> Value {
        json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,
            "agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true,"sse":true},"promptCapabilities":{"audio":false,"embeddedContext":false,"image":true},"sessionCapabilities":{"list":{}}},
            "authMethods":[{"id":"cursor_login","name":"Cursor Login","description":"Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in."}]}})
    }

    /// `session/new` with `parameterizedModelPicker`; model list shortened.
    fn session() -> Value {
        json!({"sessionId":SESSION,
            "modes":{"currentModeId":"agent","availableModes":[
                {"id":"agent","name":"Agent","description":"Full agent capabilities with tool access"},
                {"id":"plan","name":"Plan","description":"Read-only mode for planning and designing before implementation"},
                {"id":"ask","name":"Ask","description":"Q&A mode - no edits or command execution"}]},
            "configOptions":[
                {"id":"mode","name":"Mode","description":"Controls how the agent executes tasks","category":"mode","type":"select","currentValue":"agent","options":[
                    {"value":"agent","name":"Agent"},{"value":"plan","name":"Plan"},{"value":"ask","name":"Ask"}]},
                {"id":"model","name":"Model","category":"model","type":"select","currentValue":"composer-2.5","options":[
                    {"value":"auto-smart","name":"Auto"},{"value":"composer-2.5","name":"Composer 2.5"},
                    {"value":"claude-opus-5","name":"Claude Opus 5"},{"value":"gpt-5.5","name":"GPT-5.5"}]},
                {"id":"fast","name":"Fast","category":"model_config","type":"select","currentValue":"true","options":[{"value":"false","name":"Off"},{"value":"true","name":"Fast"}]}]})
    }

    /// The `session/set_config_option` answer after switching to Claude Opus 5.
    fn opus_options() -> Value {
        let mut options = session()["configOptions"].clone();
        options[1]["currentValue"] = json!("claude-opus-5");
        options[2] = json!({"id":"thinking","name":"Thinking","category":"thought_level","type":"select","currentValue":"true","options":[{"value":"false","name":"Off"},{"value":"true","name":"On"}]});
        options.as_array_mut().unwrap().extend([
            json!({"id":"context","name":"Context","category":"model_config","type":"select","currentValue":"300k","options":[{"value":"300k","name":"300K"},{"value":"1m","name":"1M"}]}),
            json!({"id":"effort","name":"Effort","category":"thought_level","type":"select","currentValue":"high","options":[
                {"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"xhigh","name":"Extra High"},{"value":"max","name":"Max"}]}),
        ]);
        json!({"configOptions":options})
    }

    /// `cursor/list_available_models`, shortened to models that cover each option shape.
    fn listed() -> Value {
        json!({"models":[
            {"value":"auto-smart","name":"Auto","configOptions":[{"id":"optimize_for","name":"Optimize For","category":"model_config","type":"select","currentValue":"balanced","options":[{"value":"intelligence","name":"Intelligence"},{"value":"balanced","name":"Balance"},{"value":"cost","name":"Cost"}]}]},
            {"value":"grok-4.7","name":"Grok 4.7","configOptions":[
                {"id":"context","name":"Context","category":"model_config","type":"select","currentValue":"256k","options":[{"value":"256k","name":"256K"},{"value":"500k","name":"500K"}]},
                {"id":"reasoning_effort","name":"Effort","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"xhigh","name":"Extra High"}]},
                {"id":"fast","name":"Fast","category":"model_config","type":"select","currentValue":"true","options":[{"value":"false","name":"Off"},{"value":"true","name":"Fast\u{200b}\u{200b}"}]}]},
            {"value":"claude-opus-5","name":"Claude Opus 5","configOptions":[
                {"id":"thinking","name":"Thinking","category":"thought_level","type":"select","currentValue":"true","options":[{"value":"false","name":"Off"},{"value":"true","name":"On"}]},
                {"id":"context","name":"Context","category":"model_config","type":"select","currentValue":"300k","options":[{"value":"300k","name":"300K"},{"value":"1m","name":"1M"}]},
                {"id":"effort","name":"Effort","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"xhigh","name":"Extra High"},{"value":"max","name":"Max"}]}]},
            {"value":"claude-haiku-4-5","name":"Claude Haiku 4.5","configOptions":[
                {"id":"thinking","name":"Thinking","category":"thought_level","type":"select","currentValue":"true","options":[{"value":"false","name":"Off"},{"value":"true","name":"On"}]}]},
            {"value":"gpt-5.5","name":"GPT-5.5","configOptions":[
                {"id":"context","name":"Context","category":"model_config","type":"select","currentValue":"272k","options":[{"value":"272k","name":"272K"},{"value":"1m","name":"1M"}]},
                {"id":"reasoning","name":"Reasoning","category":"thought_level","type":"select","currentValue":"medium","options":[{"value":"none","name":"None"},{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"extra-high","name":"Extra High"}]}]},
            {"value":"gemini-3.1-pro","name":"Gemini 3.1 Pro","configOptions":[]}]})
    }

    fn ready(mode: &str) -> (Protocol, Step) {
        let mut cfg = super::super::tests::config("cursor");
        cfg.mode = mode.into();
        let mut p = Protocol::new(cfg);
        let request = p.receive(initialize_result()).unwrap();
        assert_eq!(request.write[0]["method"], "session/new");
        let step = p.receive(json!({"jsonrpc":"2.0","id":2,"result":session()})).unwrap();
        (p, step)
    }

    fn update(update: Value) -> Value {
        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":SESSION,"update":update}})
    }

    #[test]
    fn initialize_asks_for_parameterized_models() {
        let p = Protocol::new(super::super::tests::config("cursor"));
        let request = p.initial();
        assert_eq!(request["method"], "initialize");
        assert_eq!(request["params"]["clientCapabilities"]["_meta"]["parameterizedModelPicker"], true);
        let mut command = Command::new("cursor-agent");
        configure(&mut command);
        assert_eq!(command.as_std().get_args().collect::<Vec<_>>(), ["acp"]);
    }

    #[test]
    fn modes_skip_unchanged_settings_and_plan_switches_to_cursors_plan_mode() {
        for mode in ["ask", "auto", "full"] {
            let (_, step) = ready(mode);
            assert_eq!(step.write[0]["method"], "session/prompt", "{mode}: Agent is already the session mode");
        }
        let (mut p, step) = ready("plan");
        assert_eq!(step.write[0]["method"], "session/set_config_option");
        assert_eq!(step.write[0]["params"]["configId"], "mode");
        assert_eq!(step.write[0]["params"]["value"], "plan");
        let prompt = p.receive(json!({"jsonrpc":"2.0","id":4,"result":{}})).unwrap();
        assert_eq!(prompt.write[0]["method"], "session/prompt");
        let text = prompt.write[0]["params"]["prompt"][0]["text"].as_str().unwrap();
        assert!(!text.contains(acp::READ_ONLY_PLAN_PREFIX), "Cursor's Plan mode is read-only on its own");
    }

    #[test]
    fn model_and_effort_follow_the_switched_models_options() {
        let mut cfg = super::super::tests::config("cursor");
        cfg.model = "claude-opus-5".into();
        cfg.reasoning_effort = Some("max".into());
        let mut p = Protocol::new(cfg);
        p.receive(initialize_result()).unwrap();
        let model = p.receive(json!({"jsonrpc":"2.0","id":2,"result":session()})).unwrap();
        assert_eq!(model.write[0]["params"]["configId"], "model");
        assert_eq!(model.write[0]["params"]["value"], "claude-opus-5");
        let effort = p.receive(json!({"jsonrpc":"2.0","id":5,"result":opus_options()})).unwrap();
        assert_eq!(effort.write[0]["params"]["configId"], "effort", "the Effort level, not the Thinking switch");
        assert_eq!(effort.write[0]["params"]["value"], "max");
        let prompt = p.receive(json!({"jsonrpc":"2.0","id":6,"result":{}})).unwrap();
        assert_eq!(prompt.write[0]["method"], "session/prompt");

        let mut cfg = super::super::tests::config("cursor");
        cfg.model = "claude-opus-5".into();
        cfg.reasoning_effort = Some("high".into());
        let mut p = Protocol::new(cfg);
        p.receive(initialize_result()).unwrap();
        p.receive(json!({"jsonrpc":"2.0","id":2,"result":session()})).unwrap();
        let prompt = p.receive(json!({"jsonrpc":"2.0","id":5,"result":opus_options()})).unwrap();
        assert_eq!(prompt.write[0]["method"], "session/prompt", "high is already the saved effort");

        let mut cfg = super::super::tests::config("cursor");
        cfg.model = "gpt-9".into();
        let mut p = Protocol::new(cfg);
        p.receive(initialize_result()).unwrap();
        let error = p.receive(json!({"jsonrpc":"2.0","id":2,"result":session()})).err().unwrap();
        assert!(error.contains("gpt-9"), "{error}");
    }

    #[test]
    fn catalog_lists_base_models_with_their_own_efforts_and_context() {
        let models = catalog(&listed());
        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, ["default", "auto-smart", "grok-4.7", "claude-opus-5", "claude-haiku-4-5", "gpt-5.5", "gemini-3.1-pro"]);
        assert!(models[1].reasoning_efforts.is_empty());
        let grok = &models[2];
        assert_eq!(grok.reasoning_efforts.iter().map(|effort| effort.id.as_str()).collect::<Vec<_>>(), ["low", "medium", "high", "xhigh"]);
        assert_eq!(grok.reasoning_efforts[3].name, "Extra High");
        assert_eq!(grok.default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(grok.context_window, Some(256_000));
        let opus = &models[3];
        assert_eq!(opus.reasoning_efforts.len(), 5, "Effort wins over the Thinking switch");
        assert_eq!(opus.reasoning_efforts[4].id, "max");
        let haiku = &models[4];
        assert_eq!(haiku.reasoning_efforts.iter().map(|effort| effort.name.as_str()).collect::<Vec<_>>(), ["Off", "On"]);
        assert_eq!(haiku.default_reasoning_effort.as_deref(), Some("true"));
        assert_eq!(models[5].reasoning_efforts[4].id, "extra-high");
        assert_eq!(models[5].context_window, Some(272_000));
        assert!(models[6].reasoning_efforts.is_empty() && models[6].context_window.is_none());
        assert_eq!(label(Some("Grok 4.7  High Fast\u{200b}\u{200b}"), "x", 80), "Grok 4.7  High Fast");
    }

    fn permission_request(kind: &str) -> Value {
        json!({"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":SESSION,
            "toolCall":{"toolCallId":"toolu_016CxdfTrftTivHXCWYqgCiF","title":"`printf 'hi\\n' > hello.txt && cat hello.txt`","kind":kind,"status":"pending",
                "content":[{"type":"content","content":{"type":"text","text":"Not in allowlist: cat, printf"}}]},
            "options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},{"optionId":"allow-always","name":"Allow always","kind":"allow_always"},{"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}})
    }

    #[test]
    fn recorded_permissions_ask_in_standard_approve_in_full_and_decline_in_plan() {
        let (mut p, _) = ready("ask");
        let step = p.receive(permission_request("execute")).unwrap();
        let approval = step.events.iter().find(|event| event.kind == "approval").expect("Standard asks");
        let id = approval.request_id.clone().unwrap();
        assert_eq!(p.approve(&id, true).unwrap()["result"]["outcome"]["optionId"], "allow-once");
        let (mut p, _) = ready("auto");
        assert!(p.receive(permission_request("execute")).unwrap().events.iter().any(|event| event.kind == "approval"));
        let (mut p, _) = ready("full");
        assert_eq!(p.receive(permission_request("execute")).unwrap().write[0]["result"]["outcome"]["optionId"], "allow-once");
        let (mut p, _) = ready("plan");
        let step = p.receive(permission_request("execute")).unwrap();
        assert_eq!(step.write[0]["result"]["outcome"]["optionId"], "reject-once");
        assert!(step.events.iter().any(|event| event.text.starts_with("Plan mode declined")));
        assert_eq!(p.receive(permission_request("search")).unwrap().write[0]["result"]["outcome"]["optionId"], "allow-once");
    }

    #[test]
    fn plans_show_as_text_and_questions_are_skipped_with_a_reason() {
        let (mut p, _) = ready("plan");
        p.receive(json!({"jsonrpc":"2.0","id":4,"result":{}})).unwrap();
        let plan = "# Add README.md\n\n- Create `README.md` with a title.";
        let step = p.receive(json!({"jsonrpc":"2.0","id":0,"method":"cursor/create_plan","params":{"toolCallId":"tool_701444ff","name":"Add README.md","overview":"Create a minimal README.md.","plan":plan,"todos":[{"id":"create-readme","content":"Create README.md","status":"pending"}],"isProject":false,"phases":[]}})).unwrap();
        assert!(step.events.iter().any(|event| event.kind == "text" && event.text == plan));
        assert_eq!(step.write[0]["id"], 0);
        assert_eq!(step.write[0]["result"]["outcome"]["outcome"], "accepted");
        let reply = p.receive(update(json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Plan ready."}}))).unwrap();
        assert!(reply.events.iter().any(|event| event.kind == "text" && event.text == "Plan ready."), "the reply is its own message");

        let step = p.receive(json!({"jsonrpc":"2.0","id":1,"method":"cursor/ask_question","params":{"toolCallId":"t","title":"Colour","questions":[{"id":"q","prompt":"Red or blue?","options":[{"id":"r","label":"Red"},{"id":"b","label":"Blue"}],"allowMultiple":false}]}})).unwrap();
        assert_eq!(step.write[0]["result"]["outcome"]["outcome"], "skipped");
        assert_eq!(step.write[0]["result"]["outcome"]["reason"], QUESTION_SKIPPED);
        let step = p.receive(json!({"jsonrpc":"2.0","id":2,"method":"cursor/update_todos","params":{"todos":[]}})).unwrap();
        assert_eq!(step.write[0]["error"]["code"], -32601);
    }

    #[test]
    fn recorded_turn_streams_tools_and_text_and_resume_loads_the_session() {
        let (mut p, _) = ready("full");
        let started = p.receive(update(json!({"sessionUpdate":"tool_call","toolCallId":"toolu_016CxdfTrftTivHXCWYqgCiF","title":"`printf 'hi\\n' > hello.txt && cat hello.txt`","kind":"execute","status":"pending","rawInput":{"command":"printf 'hi\\n' > hello.txt && cat hello.txt"}}))).unwrap();
        assert!(started.events.iter().any(|event| event.kind == "tool"));
        let done = p.receive(update(json!({"sessionUpdate":"tool_call_update","toolCallId":"toolu_016CxdfTrftTivHXCWYqgCiF","status":"completed","rawOutput":{"exitCode":0,"stdout":"hi\n","stderr":""}}))).unwrap();
        assert_eq!(done.events.iter().find_map(|event| event.tool.as_ref()).unwrap().status, "completed");
        let text = p.receive(update(json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}))).unwrap();
        assert!(text.events.iter().any(|event| event.kind == "text" && event.text == "done"));
        assert!(p.receive(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}})).unwrap().done);
        assert_eq!(p.cancel()["method"], "session/cancel");

        let mut cfg = super::super::tests::config("cursor");
        cfg.resume_id = Some(SESSION.into());
        let mut p = Protocol::new(cfg);
        let step = p.receive(initialize_result()).unwrap();
        assert_eq!(step.write[0]["method"], "session/load");
        assert_eq!(step.write[0]["params"]["sessionId"], SESSION);
        let replay = p.receive(update(json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Create a file"}}))).unwrap();
        assert!(replay.events.is_empty(), "history replayed by session/load stays out of the new turn");
    }

    #[test]
    fn signed_out_cli_names_the_sign_in_command() {
        let mut p = Protocol::new(super::super::tests::config("cursor"));
        p.receive(initialize_result()).unwrap();
        let error = p.receive(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required","data":{"message":"Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'."}}})).err().unwrap();
        assert_eq!(error, SIGN_IN);
    }

    #[tokio::test]
    #[ignore = "needs a signed-in Cursor CLI; metadata only, never sends a prompt"]
    async fn installed_cursor_lists_models() {
        widen_process_path();
        let path = executable("cursor").expect("Install the Cursor CLI first");
        let started = std::time::Instant::now();
        let models = models(&path).await.unwrap();
        eprintln!("{} models in {:?}", models.len(), started.elapsed());
        assert!(models.len() > 1, "{models:?}");
        assert!(models.iter().any(|model| !model.reasoning_efforts.is_empty()));
    }

    #[tokio::test]
    #[ignore = "needs a signed-in Cursor CLI; sends two short prompts"]
    async fn installed_cursor_runs_and_resumes_a_task() {
        widen_process_path();
        let cwd = std::env::temp_dir().join(format!("pandacode-cursor-live-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&cwd).unwrap();
        let turn = |prompt: &str, mode: &str, resume: Option<String>| {
            let mut config = super::super::tests::config("cursor");
            config.cwd = cwd.clone();
            config.prompt = prompt.into();
            config.mode = mode.into();
            config.model = "composer-2.5".into();
            config.resume_id = resume;
            let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::<AgentEvent>::new()));
            let seen = events.clone();
            let sink: Sink = std::sync::Arc::new(move |event| seen.lock().unwrap().push(event));
            let (input, receiver) = tokio::sync::mpsc::unbounded_channel::<RunInput>();
            async move {
                let _input = input;
                super::super::run(config, sink, receiver).await.expect("the turn should finish");
                let events = events.lock().unwrap().clone();
                events
            }
        };
        let text = |events: &[AgentEvent]| events.iter().filter(|e| e.kind == "text").map(|e| e.text.as_str()).collect::<String>();
        let first = turn("Reply with exactly the word PANDA and nothing else.", "full", None).await;
        let session = first.iter().find(|event| event.kind == "session").expect("a session id").text.clone();
        assert!(text(&first).contains("PANDA"), "{:?}", first.iter().map(|e| (&e.kind, &e.text)).collect::<Vec<_>>());
        let second = turn("Plan how to add a README.md here in three short lines. Do not create it.", "plan", Some(session)).await;
        assert!(!text(&second).contains("PANDA"), "the replayed history stays out of the new turn");
        assert!(!text(&second).trim().is_empty(), "{:?}", second.iter().map(|e| (&e.kind, &e.text)).collect::<Vec<_>>());
        assert!(std::fs::read_dir(&cwd).unwrap().next().is_none(), "Plan mode leaves the project untouched");
        let _ = std::fs::remove_dir_all(&cwd);
    }
}
