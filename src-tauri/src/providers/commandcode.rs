//! Command Code (`command-code acp`) over the shared ACP transport. The CLI keeps
//! its own login; a key saved in PandaCode (or `COMMAND_CODE_API_KEY`) authenticates
//! the same account and is passed only to that process.
use super::*;
use crate::provider_settings::COMMANDCODE_KEY;

/// Command Code serves ACP from its `acp` command.
pub(super) const ACP_ARGS: [&str; 1] = ["acp"];

/// Command Code's ACP session modes are its own permission modes, so PandaCode's
/// choice maps onto one of them.
pub(super) fn mode_id(mode: &str) -> &'static str {
    match mode {
        "plan" => "plan",
        "auto" => "auto-accept",
        "full" => "bypass",
        _ => "default",
    }
}

/// Shown when Command Code has neither a saved key nor a CLI login.
pub(super) const SIGN_IN: &str = "Command Code is not signed in. Run `command-code login` in a terminal, or save an API key in Settings → Agents, then send again.";

/// Command Code's `exit_plan_mode` approval rides on `session/request_permission`,
/// not on a tool call: the tool call is `kind: "other"`, and both offered options
/// are `kind: "allow_once"` ("Yes, auto-accept edits" and "Cancel"). That shape is
/// indistinguishable from a structured question by option kinds alone, so it must
/// be recognised here or the generic question handling cancels it before the user
/// ever sees a prompt. The CLI drops its own `exitPlanMode` marker over ACP, so the
/// remaining signals are the canonical question text it sends for this one prompt.
///
/// A header or a Yes/Cancel pair alone is not enough: a model's own
/// `ask_user_question` may reasonably be titled "Plan Review" and offer "Yes, …"
/// and "Cancel". Matching the CLI's exact question text keeps those on the generic
/// path; an unrecognised shape stays a cancel, so a real plan is never approved by
/// a request this code did not understand.
///
/// ACP carries no provenance for this prompt, so a model that reproduces the exact
/// header, question and labels is indistinguishable from the CLI asking — and that
/// question is a plan approval either way, so the approval answer is still correct.
const PLAN_QUESTIONS: [&str; 2] = [
    "Exit plan mode and begin implementation?",
    "Plan ready for review. Begin implementation?",
];

pub(super) fn is_plan_approval(request: &Value) -> bool {
    let call = &request["params"]["toolCall"];
    let question = call["rawInput"]["question"].as_str().unwrap_or_default();
    if !PLAN_QUESTIONS.contains(&question) {
        return false;
    }
    let title = call["title"].as_str().unwrap_or_default();
    if !title.starts_with("Exit Plan:") && !title.starts_with("Plan Review:") {
        return false;
    }
    // The CLI answers "auto-accept" for a "Yes, auto-accept…" label and "default" for
    // any other "Yes, …", and treats everything else as a cancel.
    let named = |prefix: &str| {
        request["params"]["options"]
            .as_array()
            .is_some_and(|options| {
                options.iter().any(|option| {
                    option["kind"] == "allow_once"
                        && option["name"]
                            .as_str()
                            .is_some_and(|name| name.starts_with(prefix))
                })
            })
    };
    named("Yes, ") && named("Cancel")
}

/// The answer to a plan-approval request. Both options are `allow_once`, so the
/// choice is made by name: approving takes the "Yes, …" option and declining takes
/// "Cancel". Anything unrecognised stays a cancel so a plan is never approved by a
/// request this code did not understand.
pub(super) fn plan_decision(request: &Value, approved: bool) -> Value {
    let options = request["params"]["options"].as_array();
    let selected = options.and_then(|options| {
        options.iter().find(|option| {
            option["name"].as_str().is_some_and(|name| {
                if approved {
                    name.starts_with("Yes, ")
                } else {
                    name.starts_with("Cancel")
                }
            })
        })
    });
    let outcome = selected
        .map(|option| json!({"outcome":"selected","optionId":option["optionId"]}))
        .unwrap_or_else(|| json!({"outcome":"cancelled"}));
    json!({"jsonrpc":"2.0","id":request["id"],"result":{"outcome":outcome}})
}

/// The key to hand Command Code: a saved key wins, then the app's environment. A
/// locked or unavailable secure store is not fatal here, because the CLI can use
/// the account from `command-code login` instead.
fn resolve_key(saved: Result<Option<String>, String>, environment: Option<String>) -> Option<String> {
    let environment = environment.filter(|key| !key.trim().is_empty());
    saved
        .ok()
        .flatten()
        .and_then(|key| crate::provider_settings::validate_key(&key).ok().map(str::to_owned))
        .or(environment)
}

/// Supplies the saved key when there is one; the CLI reads it ahead of its own
/// stored login. Returns the key so callers can redact it from failures.
pub(super) fn key_environment(command: &mut Command) -> Option<String> {
    let key = resolve_key(
        crate::provider_settings::commandcode_key(),
        std::env::var(COMMANDCODE_KEY.env).ok(),
    );
    if let Some(key) = &key {
        command.env(COMMANDCODE_KEY.env, key);
    }
    key
}

pub(super) fn redact(error: String, key: Option<&str>) -> String {
    key.map_or(error.clone(), |key| error.replace(key, "[redacted]"))
}

/// Command Code advertises its catalog as session config options, so discovery
/// opens an empty session (no prompt, no inference).
pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    if let Some(models) = acp_catalog::get("commandcode", path) { return Ok(models); }
    let _refresh = acp_catalog::refresh_lock("commandcode", path).await;
    if let Some(models) = acp_catalog::get("commandcode", path) { return Ok(models); }
    let discovery = acp_catalog::begin("commandcode", path);
    let mut command = super::provider_command("commandcode", path)?;
    command.args(ACP_ARGS);
    let key = key_environment(&mut command);
    let (metadata, _) = acp::inspect(command, &std::env::temp_dir(), false)
        .await
        .map_err(|error| redact(error, key.as_deref()))?;
    acp_catalog::store(discovery, &metadata);
    Ok(acp::parse_models_for("commandcode", &metadata))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_key_wins_and_a_locked_store_falls_back_to_the_cli_login() {
        let env = Some("cmd-env".to_owned());
        assert_eq!(resolve_key(Ok(Some(" cmd-saved ".into())), env.clone()).as_deref(), Some("cmd-saved"));
        assert_eq!(resolve_key(Ok(None), env.clone()).as_deref(), Some("cmd-env"));
        assert_eq!(resolve_key(Ok(None), None), None);
        assert_eq!(resolve_key(Ok(Some("  ".into())), env).as_deref(), Some("cmd-env"));
        assert_eq!(resolve_key(Ok(Some("bad\nkey".into())), None), None);
        assert_eq!(resolve_key(Err("locked".into()), None), None);
        assert_eq!(redact("failed with cmd-saved".into(), Some("cmd-saved")), "failed with [redacted]");
    }

    /// Recorded from `command-code acp` 1.87.1 `initialize` and `session/new`.
    fn ready(mode: &str, model: &str, effort: Option<&str>) -> (Protocol, Vec<Value>) {
        let mut cfg = super::super::tests::config("commandcode");
        cfg.mode = mode.into();
        cfg.model = model.into();
        cfg.reasoning_effort = effort.map(str::to_owned);
        let mut p = Protocol::new(cfg);
        let mut writes = Vec::new();
        writes.extend(p.receive(json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{"audio":false,"image":true,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":false},"sessionCapabilities":{"list":{},"resume":{},"close":{}}},"authMethods":[{"id":"command-code-cli","name":"Command Code CLI login"}],"agentInfo":{"name":"Command Code","version":"1.87.1"}}})).unwrap().write);
        assert_eq!(writes[0]["method"], "session/new");
        writes.extend(p.receive(json!({"jsonrpc":"2.0","id":2,"result":{"sessionId":"cc-1","modes":{"currentModeId":"default","availableModes":[
            {"id":"default","name":"Standard"},{"id":"auto-accept","name":"Accept Edits"},{"id":"plan","name":"Plan"},{"id":"dont-ask","name":"Don't Ask"},{"id":"bypass","name":"Bypass Permissions"}]},
            "configOptions":[
            {"id":"model","name":"Model","category":"model","type":"select","currentValue":"deepseek/deepseek-v4.1-flash","options":[
                {"value":"deepseek/deepseek-v4.1-flash","name":"DeepSeek V4.1 Flash","description":"fast hybrid-attention reasoning"},
                {"value":"claude-sonnet-5-5","name":"Claude Sonnet 5.5","description":"best combo of speed & intelligence"}]},
            {"id":"effort","name":"Effort","category":"thought_level","type":"select","currentValue":"max","options":[
                {"value":"off","name":"Off"},{"value":"low","name":"Low"},{"value":"high","name":"High"},{"value":"max","name":"Max"}]}]}})).unwrap().write);
        (p, writes)
    }

    /// Recorded from `command-code acp` 1.87.1 without a login or key.
    #[test]
    fn a_session_without_sign_in_names_the_login_command() {
        let mut p = Protocol::new(super::super::tests::config("commandcode"));
        p.receive(json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{},"authMethods":[{"id":"command-code-cli","name":"Command Code CLI login"}]}})).unwrap();
        let error = p.receive(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Not authenticated. Run `cmd login` in a terminal first."}})).err().unwrap();
        assert_eq!(error, SIGN_IN);
    }

    #[test]
    fn recorded_session_modes_map_onto_the_approval_choice() {
        for (mode, expected) in [("ask", "default"), ("auto", "auto-accept"), ("plan", "plan"), ("full", "bypass")] {
            let (mut p, writes) = ready(mode, "default", None);
            let set = &writes[1];
            assert_eq!((set["method"].clone(), set["params"]["modeId"].clone()), (json!("session/set_mode"), json!(expected)), "{mode}");
            let prompt = p.receive(json!({"jsonrpc":"2.0","id":4,"result":{}})).unwrap().write.remove(0);
            assert_eq!(prompt["method"], "session/prompt");
        }
    }

    #[test]
    fn recorded_catalog_becomes_models_with_the_current_models_efforts() {
        let (_, writes) = ready("ask", "default", None);
        assert!(writes.iter().all(|request| request["method"] != "session/set_config_option"), "a default model sets no model or effort");
        let metadata = json!({"sessionId":"cc-1","configOptions":[
            {"id":"model","name":"Model","category":"model","type":"select","currentValue":"deepseek/deepseek-v4.1-flash","options":[
                {"value":"deepseek/deepseek-v4.1-flash","name":"DeepSeek V4.1 Flash","description":"fast hybrid-attention reasoning"},
                {"value":"claude-sonnet-5-5","name":"Claude Sonnet 5.5","description":"best combo of speed & intelligence"}]},
            {"id":"effort","name":"Effort","category":"thought_level","type":"select","currentValue":"max","options":[
                {"value":"off","name":"Off"},{"value":"low","name":"Low"},{"value":"high","name":"High"},{"value":"max","name":"Max"}]}]});
        let models = acp::parse_models_for("commandcode", &metadata);
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["default", "deepseek/deepseek-v4.1-flash", "claude-sonnet-5-5"]);
        assert_eq!(models[1].name, "DeepSeek V4.1 Flash");
        assert_eq!(models[1].description, "fast hybrid-attention reasoning");
        assert_eq!(models[1].reasoning_efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["off", "low", "high", "max"]);
        assert_eq!(models[1].default_reasoning_effort.as_deref(), Some("max"));
        assert!(models[2].reasoning_efforts.is_empty(), "efforts belong to the current model only");
        for effort in ["off", "low", "high", "max"] {
            assert!(validate_reasoning_effort("commandcode", Some(effort)).is_ok());
        }
    }

    #[test]
    fn sets_the_selected_model_and_effort_before_prompting() {
        let (mut p, writes) = ready("ask", "claude-sonnet-5-5", Some("high"));
        assert_eq!(writes[1]["method"], "session/set_mode");
        let set = p.receive(json!({"jsonrpc":"2.0","id":4,"result":{}})).unwrap().write.remove(0);
        assert_eq!((set["id"].clone(), set["method"].clone()), (json!(5), json!("session/set_config_option")));
        assert_eq!((set["params"]["configId"].clone(), set["params"]["value"].clone()), (json!("model"), json!("claude-sonnet-5-5")));
        let set = p.receive(json!({"jsonrpc":"2.0","id":5,"result":{}})).unwrap().write.remove(0);
        assert_eq!((set["params"]["configId"].clone(), set["params"]["value"].clone()), (json!("effort"), json!("high")));
        let prompt = p.receive(json!({"jsonrpc":"2.0","id":6,"result":{}})).unwrap().write.remove(0);
        assert_eq!(prompt["method"], "session/prompt");
        assert!(!prompt["params"]["prompt"][0]["text"].as_str().unwrap().contains("Plan mode"));
    }

    fn permission(p: &mut Protocol) -> Step {
        p.receive(json!({"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"sessionId":"cc-1","toolCall":{"toolCallId":"c1","kind":"edit"},
            "options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},{"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}})).unwrap()
    }

    #[test]
    fn permissions_follow_the_task_mode() {
        let outcome = |step: &Step| step.write.first().map(|w| w["result"]["outcome"]["optionId"].clone());
        let (mut p, _) = ready("auto", "default", None);
        assert_eq!(outcome(&permission(&mut p)), Some(json!("allow-once")));
        let (mut p, _) = ready("full", "default", None);
        assert_eq!(outcome(&permission(&mut p)), Some(json!("allow-once")));
        let (mut p, _) = ready("ask", "default", None);
        let step = permission(&mut p);
        assert!(step.write.is_empty() && step.events.iter().any(|e| e.kind == "approval"));
    }

    /// The frame `command-code acp` 1.93.4 builds for `exit_plan_mode` in plan mode:
    /// `requestQuestion` joins header and question into the title and appends each
    /// option's description to its name. Both options are `allow_once`, so the generic
    /// question heuristic used to cancel it and the user never saw an approval prompt.
    fn plan_approval(p: &mut Protocol) -> Step {
        p.receive(json!({"jsonrpc":"2.0","id":11,"method":"session/request_permission","params":{"sessionId":"cc-1","toolCall":{"toolCallId":"question_1","title":"Exit Plan: Exit plan mode and begin implementation?","kind":"other","status":"pending","rawInput":{"question":"Exit plan mode and begin implementation?","options":["Yes, auto-accept edits","Cancel"]}},"options":[
            {"optionId":"option_0","name":"Yes, auto-accept edits: Exit plan mode and implement with accept edits (no permission prompts)","kind":"allow_once"},
            {"optionId":"option_1","name":"Cancel: Stay in plan mode — run /plans to annotate or edit the plan anytime","kind":"allow_once"}]}})).unwrap()
    }

    #[test]
    fn plan_approval_reaches_the_user_instead_of_being_cancelled() {
        let (mut p, _) = ready("plan", "default", None);
        let step = plan_approval(&mut p);
        assert!(step.write.is_empty(), "the request must wait for the user, not be answered: {:?}", step.write);
        let approval = step.events.iter().find(|e| e.kind == "approval").expect("an approval event");
        assert!(approval.request_id.is_some());
    }

    #[test]
    fn approval_answering_a_plan_exits_plan_mode_and_declining_keeps_it() {
        let approve = |approved: bool| {
            let (mut p, _) = ready("plan", "default", None);
            let id = plan_approval(&mut p)
                .events
                .iter()
                .find(|e| e.kind == "approval")
                .and_then(|e| e.request_id.clone())
                .expect("an approval request id");
            p.approve(&id, approved).expect("a decision")["result"]["outcome"].clone()
        };
        assert_eq!(approve(true), json!({"outcome":"selected","optionId":"option_0"}));
        assert_eq!(approve(false), json!({"outcome":"selected","optionId":"option_1"}));
    }

    #[test]
    fn a_plain_question_is_still_not_a_plan_approval() {
        let (mut p, _) = ready("plan", "default", None);
        let step = p.receive(json!({"jsonrpc":"2.0","id":12,"method":"session/request_permission","params":{"sessionId":"cc-1","toolCall":{"toolCallId":"question_1","title":"Host + DB: which droplet?","kind":"other"},"options":[
            {"optionId":"option_0","name":"It's a Plan VPS","kind":"allow_once"},
            {"optionId":"option_1","name":"A new droplet","kind":"allow_once"}]}})).unwrap();
        assert!(step.events.iter().all(|e| e.kind != "approval"));
        assert_eq!(step.write[0]["result"]["outcome"]["outcome"], json!("cancelled"));
    }

    /// `plan_review` (outside plan mode) uses the same prompt with the other header and
    /// question, so both canonical texts must be recognised.
    #[test]
    fn plan_review_is_also_an_approval() {
        let (mut p, _) = ready("ask", "default", None);
        let step = p.receive(json!({"jsonrpc":"2.0","id":15,"method":"session/request_permission","params":{"sessionId":"cc-1","toolCall":{"toolCallId":"question_2","title":"Plan Review: Plan ready for review. Begin implementation?","kind":"other","rawInput":{"question":"Plan ready for review. Begin implementation?","options":["Yes, auto-accept edits","Cancel"]}},"options":[
            {"optionId":"option_0","name":"Yes, auto-accept edits: Implement with accept edits (no permission prompts)","kind":"allow_once"},
            {"optionId":"option_1","name":"Cancel: Keep refining the plan — run /plans to annotate or edit it anytime","kind":"allow_once"}]}})).unwrap();
        assert!(step.write.is_empty(), "waits for the user: {:?}", step.write);
        assert!(step.events.iter().any(|e| e.kind == "approval"));
    }

    /// A model may title its own question "Plan Review", and may offer "Yes, …" and
    /// "Cancel" options. Neither alone, nor both together, may turn a real question into
    /// plan approval: the question text the CLI sends for plan approval is canonical.
    #[test]
    fn a_question_with_approval_like_header_and_labels_is_not_plan_approval() {
        let question = |title: &str, asked: &str, options: Value| {
            let (mut p, _) = ready("plan", "default", None);
            let step = p.receive(json!({"jsonrpc":"2.0","id":13,"method":"session/request_permission","params":{"sessionId":"cc-1","toolCall":{"toolCallId":"question_2","title":title,"kind":"other","rawInput":{"question":asked}},"options":options}})).unwrap();
            (step.events.iter().any(|e| e.kind == "approval"), step.write[0]["result"]["outcome"]["outcome"].clone())
        };
        let header_only = question("Plan Review: which section needs revision?", "which section needs revision?", json!([
            {"optionId":"option_0","name":"Architecture","kind":"allow_once"},
            {"optionId":"option_1","name":"Testing","kind":"allow_once"}]));
        assert_eq!(header_only, (false, json!("cancelled")));
        let label_only = question("Deploy target: where?", "where?", json!([
            {"optionId":"option_0","name":"Yes, auto-accept edits for this one","kind":"allow_once"},
            {"optionId":"option_1","name":"Cancel the deploy","kind":"allow_once"}]));
        assert_eq!(label_only, (false, json!("cancelled")));
        let header_and_labels = question("Plan Review: use PostgreSQL for storage?", "use PostgreSQL for storage?", json!([
            {"optionId":"option_0","name":"Yes, use PostgreSQL","kind":"allow_once"},
            {"optionId":"option_1","name":"Cancel: discuss another database","kind":"allow_once"}]));
        assert_eq!(header_and_labels, (false, json!("cancelled")));
    }

    /// Each signal is required on its own, so dropping any one keeps the generic path.
    #[test]
    fn a_plan_approval_needs_both_its_question_and_its_option_pair() {
        let request = |question: &str, options: Value| json!({"jsonrpc":"2.0","id":16,"method":"session/request_permission","params":{"sessionId":"cc-1","toolCall":{"toolCallId":"question_3","title":"Exit Plan: Exit plan mode and begin implementation?","kind":"other","rawInput":{"question":question}},"options":options}});
        let yes = json!({"optionId":"option_0","name":"Yes, auto-accept edits: go","kind":"allow_once"});
        let cancel = json!({"optionId":"option_1","name":"Cancel: stay","kind":"allow_once"});
        assert!(is_plan_approval(&request("Exit plan mode and begin implementation?", json!([yes, cancel]))));
        assert!(!is_plan_approval(&request("Exit plan mode and begin implementation?", json!([yes]))), "no cancel option");
        assert!(!is_plan_approval(&request("Exit plan mode and begin implementation?", json!([cancel]))), "no yes option");
        assert!(!is_plan_approval(&request("Something else entirely?", json!([yes, cancel]))), "not the canonical question");
        assert!(!is_plan_approval(&json!({"params":{"toolCall":{"title":"Exit Plan: Exit plan mode and begin implementation?"},"options":[yes, cancel]}})), "no question text");
        assert!(
            !is_plan_approval(&json!({"params":{"toolCall":{"title":"Host: Exit plan mode and begin implementation?","rawInput":{"question":"Exit plan mode and begin implementation?"}},"options":[yes.clone(), cancel.clone()]}})),
            "canonical question and options with the wrong header"
        );
        assert!(
            !is_plan_approval(&json!({"params":{"toolCall":{"rawInput":{"question":"Exit plan mode and begin implementation?"}},"options":[yes, cancel]}})),
            "canonical question and options with no header"
        );
    }

    /// `plan_decision` itself refuses to guess when the expected option is absent.
    #[test]
    fn plan_decision_cancels_when_the_expected_option_is_missing() {
        let request = json!({"jsonrpc":"2.0","id":17,"params":{"options":[
            {"optionId":"option_0","name":"Proceed","kind":"allow_once"},
            {"optionId":"option_1","name":"Back","kind":"allow_once"}]}});
        assert_eq!(plan_decision(&request, true)["result"]["outcome"]["outcome"], json!("cancelled"));
        assert_eq!(plan_decision(&request, false)["result"]["outcome"]["outcome"], json!("cancelled"));
    }

    #[test]
    fn a_resumed_session_keeps_its_saved_id() {
        let mut cfg = super::super::tests::config("commandcode");
        cfg.resume_id = Some("cc-saved".into());
        let mut p = Protocol::new(cfg);
        let request = p.receive(json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"sessionCapabilities":{"resume":{}}}}})).unwrap().write.remove(0);
        assert_eq!(request["method"], "session/resume");
        assert_eq!(request["params"]["sessionId"], "cc-saved");
        let saved = p.receive(json!({"jsonrpc":"2.0","id":2,"result":{"sessionId":"cc-saved"}})).unwrap().events;
        assert_eq!(saved.iter().find(|e| e.kind == "session").unwrap().text, "cc-saved");
    }

    #[tokio::test]
    #[ignore = "needs the Command Code CLI and a login; metadata only, never sends a prompt"]
    async fn live_command_code_lists_models() {
        super::super::widen_process_path(); // as the app does at startup
        let path = executable("commandcode").expect("Install Command Code first");
        let models = models(&path).await.unwrap();
        assert!(models.len() > 1, "{models:?}");
    }
}
