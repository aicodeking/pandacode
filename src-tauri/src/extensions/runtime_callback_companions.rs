//! R0602: run-bound Claude SDK callbacks and structured Pi bridge messages.
//! Source profiles are deliberately distinct from installed qualification. No CLI/config discovery here.
use std::{collections::{BTreeMap, BTreeSet}, sync::{Arc, LazyLock, Mutex}};
use serde_json::{json, Value};
use super::runtime_companion_lifetime::{self as lifetime, Companions, InstalledApi, Lease, Profile, Evidence};
use super::runtime_hook_registration::{HookRegistry, Occurrence};
use super::runtime_hook_decisions::{self as decisions, Env, Outcome};
use super::runtime_hook_context as context;
use super::runtime_hook_payload as payloads;

pub const EVENTS: [(&str, &str); 6] = [
    ("PreToolUse", "tool.before"), ("PostToolUse", "tool.after"),
    ("UserPromptSubmit", "prompt.submit"), ("PreCompact", "compaction"),
    ("PostCompact", "compaction"), ("Stop", "turn.finish"),
];
/// Explicit GLM and MiMo aliases of the Claude initialize.hooks/hook_callback bridge.
/// This SDK-derived revision is NOT an installed Claude/GLM/MiMo or omp version.
pub fn profile(harness: &str) -> Option<Profile> {
    let (api, version) = match harness {
        "claude" | "glm" | "mimo" | "alibaba" => ("claude.initialize.hooks.v1", "sdk-derived"),
        "pi" | "omp" => ("pandacode.pi.structured.v1", "synthetic-bridge-v1"),
        _ => return None,
    };
    Some(Profile { id: format!("{harness}.callback.v1"), harness: harness.into(), versions: vec![version.into()], api: api.into(), protocol: 1, evidence: Evidence::SourceFeasible })
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Invocation { pub id: String, pub event: String, pub input: Value, pub call: String }
pub struct CallbackSession {
    lease: Lease, harness: String, closed: bool, pending: BTreeMap<String, Invocation>, seen: BTreeSet<String>,
}
static SESSIONS: LazyLock<Mutex<BTreeMap<String, Arc<Mutex<CallbackSession>>>>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));
pub fn active(task: &str) -> bool { SESSIONS.lock().is_ok_and(|sessions| sessions.contains_key(task)) }
fn session(task: &str) -> Option<Arc<Mutex<CallbackSession>>> { SESSIONS.lock().ok()?.get(task).cloned() }
struct CallbackResources { lease: Lease }
impl lifetime::Resources for CallbackResources {
    fn environment(&self) -> BTreeMap<String, String> { BTreeMap::new() }
    fn close(&mut self) -> Result<(), String> {
        let mut sessions = SESSIONS.lock().map_err(|_| "Callback cleanup pending.")?;
        if sessions.get(&self.lease.key.task_id).is_some_and(|session| session.lock().is_ok_and(|s| s.lease == self.lease)) { sessions.remove(&self.lease.key.task_id); }
        Ok(())
    }
}
/// Factory invoked ONLY after lifecycle negotiation, while its mutex is held. Never reenters it.
pub fn resources(manifest: &lifetime::Manifest, harness: &str) -> Result<Box<dyn lifetime::Resources>, String> {
    if profile(harness).as_ref().is_none_or(|profile| profile.id != manifest.profile) { return Err("UnsupportedCapability".into()); }
    let mut sessions = SESSIONS.lock().map_err(|_| "HostUnavailable")?;
    if sessions.contains_key(&manifest.lease.key.task_id) { return Err("Conflict".into()); }
    sessions.insert(manifest.lease.key.task_id.clone(), Arc::new(Mutex::new(CallbackSession { lease: manifest.lease.clone(), harness: harness.into(), closed: false, pending: BTreeMap::new(), seen: BTreeSet::new() })));
    Ok(Box::new(CallbackResources { lease: manifest.lease.clone() }))
}
pub fn registration(task: &str) -> Option<Value> {
    let host = lifetime::registry().lock().ok()?;
    let session = session(task)?;
    let result = session.lock().ok()?.registration(&host).ok(); result
}
pub fn receive(task: &str, frame: &Value) -> Option<(Lease, Invocation)> {
    let host = lifetime::registry().lock().ok()?;
    let session = session(task)?;
    let mut session = session.lock().ok()?;
    let invocation = session.receive(&host, frame).ok()?;
    Some((session.lease.clone(), invocation))
}
pub fn reply(lease: &Lease, id: &str, answer: Value) -> Option<Value> {
    let host = lifetime::registry().lock().ok()?;
    let session = session(&lease.key.task_id)?;
    let mut session = session.lock().ok()?;
    if &session.lease != lease { return None; }
    session.reply(&host, id, answer).ok()
}
impl CallbackSession {
    pub fn new(host: &Companions, lease: Lease, installed: &InstalledApi) -> Result<Self, &'static str> {
        if lifetime::negotiate(installed, profile(&installed.harness).as_ref()).code.is_some() { return Err("UnsupportedCapability"); }
        if !host.current(&lease.key, &lease) { return Err("StaleContext"); }
        Ok(Self { lease, harness: installed.harness.clone(), closed: false, pending: BTreeMap::new(), seen: BTreeSet::new() })
    }
    pub fn registration(&self, host: &Companions) -> Result<Value, &'static str> {
        if self.closed || !host.current(&self.lease.key, &self.lease) { return Err("StaleContext"); }
        if matches!(self.harness.as_str(), "pi" | "omp") { return Ok(json!({"protocol":1,"events":EVENTS.map(|(event,_)| event)})); }
        let hooks: serde_json::Map<String, Value> = EVENTS.iter().map(|(event, _)| (event.to_string(), json!([{"hookCallbackIds":[format!("pandacode:{event}")],"timeout":65}]))).collect();
        Ok(Value::Object(hooks))
    }
    /// Called on the owning stdio stream (or authenticated Pi transport), never on arbitrary webview input.
    /// Pi's structured bridge envelope is host-owned, not an invented Pi RPC request.
    pub fn receive(&mut self, host: &Companions, frame: &Value) -> Result<Invocation, &'static str> {
        if self.closed || !host.current(&self.lease.key, &self.lease) { return Err("StaleContext"); }
        payloads::frame_check(frame)?;
        let pi = matches!(self.harness.as_str(), "pi" | "omp");
        let (id, event, input) = if pi {
            if frame["protocol"] != 1 { return Err("UnsupportedCapability"); }
            (frame["id"].as_str(), frame["event"].as_str(), &frame["input"])
        } else {
            if frame["type"] != "control_request" || frame["request"]["subtype"] != "hook_callback" { return Err("InvalidShape"); }
            let request = &frame["request"];
            let callback = request["callback_id"].as_str().and_then(|id| id.strip_prefix("pandacode:"));
            if callback != request["input"]["hook_event_name"].as_str() { return Err("InvalidShape"); }
            (frame["request_id"].as_str(), callback, &request["input"])
        };
        let id = id.filter(|id| !id.is_empty() && id.len() <= 256).ok_or("InvalidShape")?;
        let event = event.filter(|event| EVENTS.iter().any(|(known,_)| known == event)).ok_or("UnsupportedCapability")?;
        if !input.is_object() { return Err("InvalidShape"); }
        if self.seen.len() >= 4096 || self.pending.len() >= 64 { return Err("LimitExceeded"); }
        if !self.seen.insert(id.into()) { return Err("Conflict"); }
        let call = input["tool_use_id"].as_str().or_else(|| frame["request"]["tool_use_id"].as_str()).filter(|id| !id.is_empty()).unwrap_or(id).to_owned();
        let invocation = Invocation { id: id.into(), event: event.into(), input: input.clone(), call };
        self.pending.insert(id.into(), invocation.clone()); Ok(invocation)
    }
    /// Recheck AFTER awaiting the host, and consume exactly one matching callback id.
    pub fn reply(&mut self, host: &Companions, id: &str, answer: Value) -> Result<Value, &'static str> {
        if self.closed || !host.current(&self.lease.key, &self.lease) { self.pending.clear(); return Err("StaleContext"); }
        payloads::frame_check(&answer)?;
        let invocation = self.pending.remove(id).ok_or("StaleContext")?;
        let output = translate(&invocation.event, &answer, matches!(self.harness.as_str(), "pi" | "omp"));
        Ok(if matches!(self.harness.as_str(), "pi" | "omp") { json!({"type":"extension_ui_response","id":id,"value":output.to_string()}) }
            else { json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":output}}) })
    }
    pub fn close(&mut self) { self.closed = true; self.pending.clear(); }
}

/// Translate only powers this event actually has. An empty answer preserves ordinary permissions.
pub fn translate(event: &str, answer: &Value, pi: bool) -> Value {
    let reason = answer["reason"].as_str().unwrap_or("Declined by an extension.");
    if pi {
        return match event {
            "PreToolUse" => match answer["decision"].as_str() {
                Some("deny") => json!({"block":true,"reason":reason}),
                Some("rewrite") => json!({"input":answer["input"]}),
                Some("ask") => json!({"ask":true,"reason":answer["reason"]}),
                Some("approve") => json!({"approved":true}), _ => json!({}),
            },
            "PostToolUse" if answer.get("output").is_some() => json!({"output":answer["output"]}),
            "UserPromptSubmit" if answer["context"].is_string() => json!({"context":answer["context"]}),
            "PreCompact" if answer["cancel"] == true => json!({"cancel":true}),
            "PreCompact" if answer["summary"].is_string() => json!({"summary":answer["summary"]}),
            _ => json!({}),
        };
    }
    match event {
        "PreToolUse" => {
            let decision = match answer["decision"].as_str() { Some("deny") => "deny", Some("ask") => "ask", Some("approve" | "rewrite") => "allow", _ => return json!({}) };
            let mut output = json!({"hookEventName":event,"permissionDecision":decision});
            if answer["reason"].is_string() { output["permissionDecisionReason"] = answer["reason"].clone(); }
            if answer["decision"] == "rewrite" && answer["input"].is_object() { output["updatedInput"] = answer["input"].clone(); }
            json!({"hookSpecificOutput":output})
        }
        "PostToolUse" if answer.get("output").is_some() => json!({"hookSpecificOutput":{"hookEventName":event,"updatedToolOutput":answer["output"]}}),
        "UserPromptSubmit" if answer["context"].is_string() => json!({"hookSpecificOutput":{"hookEventName":event,"additionalContext":answer["context"]}}),
        "PreCompact" if answer["cancel"] == true => json!({"continue":false,"stopReason":reason}),
        "PreCompact" if answer["instructions"].is_string() => json!({"hookSpecificOutput":{"hookEventName":event,"additionalContext":answer["instructions"]}}),
        _ => json!({}),
    }
}

/// Shared R5 resolver, with native grants/order/budgets/receipts. The caller rechecks its lease on reply.
pub(crate) async fn resolve(registry: &HookRegistry, env: &Env, task: &str, invocation: &Invocation) -> Result<Value, &'static str> {
    let facts = registry.run(task).ok_or("StaleContext")?;
    let input = &invocation.input;
    let event = EVENTS.iter().find(|(event,_)| *event == invocation.event).ok_or("UnsupportedCapability")?.1;
    let mut occurrence = HookRegistry::turn_occurrence(&facts, event, registry.since_compaction(task, facts.index));
    occurrence.payload["source"] = json!("companion");
    if event == "tool.before" || event == "tool.after" {
        let name = input["tool_name"].as_str().ok_or("InvalidShape")?;
        let recorded = payloads::record(task, Some(&facts.project_id), &invocation.call, &input["tool_input"])?;
        let base = HookRegistry::call_base(&facts, name, super::runtime_hook_registration::tool_kind(name), None, "companion", "everyCall");
        let mut payload = payloads::hook_call(&base, &recorded.call_id)?;
        let (kind, paths) = HookRegistry::complete(&mut payload, name);
        occurrence = Occurrence { event, project: facts.project_id.clone(), harness: facts.harness.clone(), run: facts.run["kind"].as_str().unwrap_or("task").into(), tool_kind: Some(kind.clone()), paths, payload };
        if event == "tool.before" {
            let can = if facts.mode == "plan" && !["read", "search", "fetch"].contains(&kind.as_str()) { vec!["deny", "ask"] } else { vec!["approve", "deny", "ask", "rewriteInput"] };
            occurrence.payload["can"] = json!(can);
            let (deciders, observers) = registry.reach(&occurrence).into_iter().partition(|target| (env.decides)(&target.owner, &target.version, &facts.project_id, &kind));
            registry.claim_before(task, &recorded.call_id, name);
            let _ = registry.targets(&occurrence);
            let chain = decisions::Chain { occurrence, deciders, observers, can, call: recorded.call_id, support: payloads::Support { deny_reason: payloads::DenyReason::Answer, rewrite_input: true } };
            let fold = decisions::run_chain(registry, env, &chain, task).await;
            return Ok(match fold.outcome() {
                Outcome::None => json!({}), Outcome::Ask(by) => json!({"decision":"ask","reason":by.reason}),
                Outcome::Deny(by) => json!({"decision":"deny","reason":by.reason}),
                Outcome::Approve { by, input: Some(input) } => json!({"decision":"rewrite","reason":by.reason,"input":input}),
                Outcome::Approve { by, input: None } => json!({"decision":"approve","reason":by.reason}),
            });
        }
        occurrence.payload["output"] = input["tool_response"].clone();
        occurrence.payload["status"] = json!("completed");
        let mut fold = context::ToolAfterFold::new(&["rewriteResult"], input["tool_response"].clone());
        context::drive(registry, &env.ask, &env.names, &occurrence, task, Some(&recorded.call_id), &mut fold).await;
        payloads::finish(task, &invocation.call);
        return Ok(fold.output.map(|output| json!({"output":output})).unwrap_or(json!({})));
    }
    // User prompt hooks already ran (including context composition) before provider send.
    // The run wrapper also owns turn.finish; do not dispatch either a second time.
    if event == "prompt.submit" || event == "turn.finish" { return Ok(json!({})); }
    if event == "compaction" && invocation.event == "PreCompact" {
        occurrence.payload["phase"] = json!("before");
        let can: &[&str] = if matches!(facts.harness.as_str(), "pi" | "omp") { &["cancel", "summary"] } else { &["cancel", "instructions"] };
        let mut fold = context::CompactionFold::new(can);
        context::drive(registry, &env.ask, &env.names, &occurrence, task, None, &mut fold).await;
        return Ok(json!({"cancel":fold.cancel.is_some(),"instructions":fold.instructions.iter().map(|(name,text)| format!("{name}: {text}")).collect::<Vec<_>>().join("\n"),"summary":fold.summaries.last().map(|(_,text)|text)}));
    }
    occurrence.payload["phase"] = json!("after");
    occurrence.payload["can"] = json!([]);
    registry.publish(&occurrence); Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Noop;
    impl lifetime::Resources for Noop {
        fn environment(&self) -> BTreeMap<String, String> { BTreeMap::new() }
        fn close(&mut self) -> Result<(), String> { Ok(()) }
    }
    #[test]
    fn callbacks_correlate_out_of_order_and_never_survive_close_or_revocation() {
        for harness in ["claude", "glm", "mimo", "pi", "omp"] {
            let profile = profile(harness).unwrap();
            let installed = InstalledApi { harness: harness.into(), version: profile.versions.first().cloned(), apis: vec![profile.api.clone()] };
            let key = lifetime::RunKey { task_id: "fixture".into(), run_id: "run".into() };
            let mut host = Companions::default();
            let lease = host.begin(key.clone(), &["sample.guard".into()], &installed, Some(&profile), |_| Ok(Box::new(Noop))).unwrap().lease;
            let mut session = CallbackSession::new(&host, lease, &installed).unwrap();
            let pi = matches!(harness, "pi" | "omp");
            let frame = |id: &str| if pi { json!({"protocol":1,"id":id,"event":"PreToolUse","input":{"tool_use_id":"call-a"}}) }
                else { json!({"type":"control_request","request_id":id,"request":{"subtype":"hook_callback","callback_id":"pandacode:PreToolUse","tool_use_id":"call-a","input":{"hook_event_name":"PreToolUse"}}}) };
            assert!(session.registration(&host).is_ok());
            assert_eq!(session.receive(&host, &frame("a")).unwrap().call, "call-a");
            session.receive(&host, &frame("b")).unwrap();
            assert!(session.reply(&host, "b", json!({"decision":"deny","reason":"guard"})).unwrap().to_string().contains("guard"));
            session.reply(&host, "a", json!({})).unwrap();
            assert_eq!(session.reply(&host, "a", json!({})).err(), Some("StaleContext"));
            assert_eq!(session.receive(&host, &frame("a")).err(), Some("Conflict"));
            session.receive(&host, &frame("late")).unwrap();
            host.end(&key, lifetime::StopReason::Revoked);
            assert_eq!(session.reply(&host, "late", json!({})).err(), Some("StaleContext"));
            session.close();
            assert_eq!(session.registration(&host).err(), Some("StaleContext"));
        }
    }
    #[test]
    fn sdk_and_bridge_provenance_never_qualifies_an_installed_version() {
        for harness in ["claude", "glm", "mimo", "pi", "omp"] {
            let installed = InstalledApi { harness: harness.into(), version: Some("unknown-installed".into()), apis: vec![profile(harness).unwrap().api] };
            assert_eq!(lifetime::negotiate(&installed, profile(harness).as_ref()).code.as_deref(), Some("UnsupportedCapability"));
        }
    }
    #[test]
    fn callback_output_cannot_invent_a_summary_or_rewrite_a_prompt() {
        assert_eq!(translate("PreCompact", &json!({"summary":"fake"}), false), json!({}));
        assert_eq!(translate("UserPromptSubmit", &json!({"prompt":"rewrite"}), false), json!({}));
        assert_eq!(translate("PreToolUse", &json!({"decision":"deny","reason":"guard"}), true), json!({"block":true,"reason":"guard"}));
    }
}
