//! Package providers use core conversation events and input, never raw AgentEvent/IPC authority.
use super::{AgentEvent, ModelInfo, ProviderInfo, ReasoningEffortInfo, RunConfig, RunInput, Sink};
use crate::extensions::{packages::Packages, supervisor};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::{Arc, Mutex, OnceLock, Weak, atomic::{AtomicBool, Ordering}}, time::Duration};

struct Host { packages: Weak<Mutex<Packages>>, directory: Option<PathBuf> }
static HOST: OnceLock<Host> = OnceLock::new();
type Runs = BTreeMap<String, (String, Arc<AtomicBool>)>;
static RUNS: Mutex<Runs> = Mutex::new(BTreeMap::new());
struct RunLease { key: String, cancel: Arc<AtomicBool>, pump: Option<tokio::task::AbortHandle> }
impl Drop for RunLease {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        if let Some(pump) = &self.pump { pump.abort(); }
        if let Ok(mut runs) = RUNS.lock() { runs.remove(&self.key); }
    }
}
pub(crate) fn configure(packages: &Arc<Mutex<Packages>>, directory: Option<PathBuf>) {
    let _ = HOST.set(Host { packages: Arc::downgrade(packages), directory });
}
#[derive(Clone)]
struct Registration { definition: Value, version: String, digest: String, source: String }
fn registrations() -> Vec<Registration> {
    HOST.get().and_then(|host| host.packages.upgrade()).and_then(|packages| packages.lock().ok().map(|packages| packages.provider_registrations())).unwrap_or_default()
        .into_iter().map(|(definition, version, digest, source)| Registration { definition, version, digest, source }).collect()
}
fn resolve(id: &str) -> Result<Registration, String> {
    registrations().into_iter().find(|registration| registration.definition["id"] == id).ok_or_else(|| crate::extensions::providers::PROVIDER_RECOVERY.into())
}
fn catalog(definition: &Value) -> Vec<ModelInfo> {
    definition["models"].as_array().into_iter().flatten().map(|model| ModelInfo {
        id: model["id"].as_str().unwrap_or_default().into(), name: model["name"].as_str().unwrap_or_default().into(), description: String::new(),
        reasoning_efforts: model["efforts"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|effort| ReasoningEffortInfo { id: effort.into(), name: effort.into(), description: String::new() }).collect(),
        default_reasoning_effort: None, context_window: model["contextWindow"].as_u64(),
    }).collect()
}
pub(crate) fn discover() -> Vec<ProviderInfo> {
    registrations().into_iter().map(|registration| ProviderInfo { id: registration.definition["id"].as_str().unwrap_or_default().into(), name: registration.definition["name"].as_str().unwrap_or_default().into(), installed: cfg!(all(target_os = "windows", target_arch = "x86_64")), path: None, version: registration.version, models: catalog(&registration.definition) }).collect()
}
pub(crate) fn models(id: &str) -> Result<Vec<ModelInfo>, String> { Ok(catalog(&resolve(id)?.definition)) }
pub(crate) fn require_available(id: &str) -> Result<(), String> {
    if crate::extensions::providers::extension_owner(id).is_some() { resolve(id).map(|_| ()) }
    else { crate::extensions::providers::require_builtin_execution(id) }
}
pub(crate) fn validate_effort(id: &str, effort: Option<&str>) -> Result<(), String> {
    if effort.is_none() || models(id)?.iter().any(|model| model.reasoning_efforts.iter().any(|entry| Some(entry.id.as_str()) == effort)) { Ok(()) }
    else { Err("Unsupported provider effort".into()) }
}
pub(crate) fn stop(owner: Option<&str>) {
    if let Ok(runs) = RUNS.lock() { for (id, cancel) in runs.values() { if owner.is_none_or(|owner| owner == id) { cancel.store(true, Ordering::Release); } } }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Event {
    Text { text: String }, Thinking { text: String }, Session { id: String },
    Tool { tool: super::ToolActivity }, Approval { text: String }, Question { questions: Value },
    Usage { #[serde(rename = "usedTokens")] used_tokens: u64, #[serde(rename = "contextWindow")] context_window: Option<u64> },
}
#[derive(Default)]
struct Pending { approval: Option<String>, question: Option<(String, Value)>, session: bool }
struct Conversation { sid: String, sink: Sink, pending: Mutex<Pending>, cancel: Arc<AtomicBool> }
impl Conversation {
    fn emit(&self, kind: &str, text: String, request_id: Option<String>, data: Option<Value>, tool: Option<super::ToolActivity>) {
        (self.sink)(AgentEvent { session_id: self.sid.clone(), kind: kind.into(), text, request_id, data, tool });
    }
    fn event(&self, value: Value) -> Result<Value, String> {
        if self.cancel.load(Ordering::Acquire) { return Err("Cancelled".into()); }
        if value.to_string().len() > 32768 { return Err("LimitExceeded".into()); }
        let event: Event = serde_json::from_value(value).map_err(|_| "InvalidShape")?;
        let mut pending = self.pending.lock().map_err(|_| "HostUnavailable")?;
        match event {
            Event::Text { text } => self.emit("text", text, None, None, None),
            Event::Thinking { text } => self.emit("thinking", text, None, None, None),
            Event::Session { id } => {
                if pending.session || id.is_empty() || id.len() > 200 || id.chars().any(char::is_control) { return Err("InvalidSession".into()); }
                pending.session = true; self.emit("session", id, None, None, None);
            }
            Event::Tool { tool } => {
                if !["running", "completed", "failed"].contains(&tool.status.as_str()) || tool.id.is_empty() || tool.id.len() > 200 || tool.name.len() > 200 { return Err("InvalidTool".into()); }
                self.emit("tool", String::new(), None, None, Some(tool));
            }
            Event::Usage { used_tokens, context_window } => {
                if used_tokens > 1_000_000_000 || context_window.is_some_and(|window| window == 0 || window > 1_000_000_000) { return Err("InvalidUsage".into()); }
                self.emit("usage", String::new(), None, Some(json!({"usedTokens":used_tokens,"contextWindow":context_window})), None);
            }
            Event::Approval { text } => {
                if pending.approval.is_some() || pending.question.is_some() { return Err("Conflict".into()); }
                let id = uuid::Uuid::new_v4().to_string(); pending.approval = Some(id.clone());
                self.emit("approval", text, Some(id), None, None);
            }
            Event::Question { questions } => {
                if pending.approval.is_some() || pending.question.is_some() { return Err("Conflict".into()); }
                let request = json!({"method":"item/tool/requestUserInput","params":{"questions":questions}});
                let data = super::host_inputs::normalize(&request)?;
                let id = uuid::Uuid::new_v4().to_string(); pending.question = Some((id.clone(), request));
                self.emit("input_request", String::new(), Some(id), Some(data), None);
            }
        }
        Ok(Value::Null)
    }
    fn input(&self, input: RunInput) -> Option<Value> {
        let mut pending = self.pending.lock().ok()?;
        match input {
            RunInput::Stop => { self.cancel.store(true, Ordering::Release); None }
            RunInput::Approval { request_id, approved } => {
                if pending.approval.as_deref() != Some(&request_id) { return None; }
                pending.approval = None;
                self.emit("approval_cancelled", String::new(), Some(request_id), None, None);
                Some(json!({"kind":"approval","approved":approved}))
            }
            RunInput::UserInput { request_id, response, reply } => {
                let result = pending.question.as_ref().filter(|(id, _)| id == &request_id).ok_or_else(|| "Stale input request".to_owned()).and_then(|(_, request)| super::host_inputs::answer(request, response));
                if let Some(reply) = reply { let _ = reply.send(result.as_ref().map(|_| ()).map_err(Clone::clone)); }
                match result {
                    Ok(response) => { pending.question = None; self.emit("input_cancelled", String::new(), Some(request_id), None, None); Some(json!({"kind":"question","response":response})) }
                    Err(_) => None,
                }
            }
            RunInput::Steer { id, text, reply } => {
                // No acknowledgement of consumption before the adapter reads core input.
                let _ = reply.send(Ok(json!({"steered":true,"id":id,"mode":"live"})));
                self.emit("steer", text.clone(), None, Some(json!({"id":id,"status":"delivered","mode":"live"})), None);
                Some(json!({"kind":"steer","id":id,"text":text}))
            }
            RunInput::Goal { reply, .. } => { let _ = reply.send(Err("UnsupportedCapability: goals".into())); None }
            RunInput::CodexRequest { reply, .. } => { let _ = reply.send(Err("UnsupportedCapability: Codex request".into())); None }
        }
    }
    fn finish(&self) -> Result<(), String> {
        let mut pending = self.pending.lock().map_err(|_| "HostUnavailable")?;
        let incomplete = pending.approval.is_some() || pending.question.is_some();
        if let Some(id) = pending.approval.take() { self.emit("approval_cancelled", String::new(), Some(id), None, None); }
        if let Some((id, _)) = pending.question.take() { self.emit("input_cancelled", String::new(), Some(id), None, None); }
        if (incomplete || !pending.session) && !self.cancel.load(Ordering::Acquire) { Err("Provider completed without an initialized session or with unanswered core requests".into()) } else { Ok(()) }
    }
}

pub(crate) async fn run(config: RunConfig, sink: Sink, mut input: tokio::sync::mpsc::UnboundedReceiver<RunInput>) -> Result<(), String> {
    let registration = resolve(&config.provider)?;
    let directory = HOST.get().and_then(|host| host.directory.clone());
    let mut runtime = directory.as_deref().and_then(|directory| supervisor::Runtime::packaged(directory).ok());
    if runtime.is_none() && cfg!(debug_assertions) { runtime = supervisor::Runtime::packaged(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")).ok(); }
    let runtime = runtime.ok_or("UnsupportedRuntime: this target's trusted provider runtime is not qualified")?;
    if config.goal.is_some() || config.skill.is_some() || !config.images.is_empty() { return Err("UnsupportedCapability: goals, native skills or images".into()); }
    if !crate::storage::valid_permission_mode(&config.mode) || config.mode == "review" { return Err("Unsupported provider permission mode".into()); }
    let models = catalog(&registration.definition);
    let model = models.iter().find(|model| model.id == config.model).ok_or("Unsupported provider model")?;
    if config.reasoning_effort.as_ref().is_some_and(|effort| !model.reasoning_efforts.iter().any(|entry| &entry.id == effort)) { return Err("Unsupported provider effort".into()); }
    let cancel = Arc::new(AtomicBool::new(false));
    let key = uuid::Uuid::new_v4().to_string();
    {
        let mut runs = RUNS.lock().map_err(|_| "HostUnavailable")?;
        if runs.len() >= 8 { return Err("LimitExceeded: active provider runs".into()); }
        runs.insert(key.clone(), (crate::extensions::providers::extension_owner(&config.provider).unwrap().into(), cancel.clone()));
    }
    let mut lease = RunLease { key, cancel: cancel.clone(), pump: None };
    // Close disable/reload between source capture and registering the owned cancellation handle.
    if resolve(&config.provider)?.digest != registration.digest { return Err("StaleContext".into()); }
    let conversation = Arc::new(Conversation { sid: config.session_id.clone(), sink, pending: Mutex::default(), cancel: cancel.clone() });
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    let receiver = Arc::new(tokio::sync::Mutex::new(rx));
    let reader = conversation.clone();
    let pump = tokio::spawn(async move {
        while let Some(input) = input.recv().await {
            if matches!(input, RunInput::Stop) { reader.input(input); break; }
            // Never block Stop behind a full extension-input queue.
            if tx.try_send(input).is_err() { reader.cancel.store(true, Ordering::Release); break; }
        }
    });
    lease.pump = Some(pump.abort_handle());
    let context = json!({"provider":{"apiVersion":1,"id":config.provider,"version":registration.version,"digest":registration.digest,"model":config.model,"effort":config.reasoning_effort,"mode":config.mode,"resumeId":config.resume_id,"prompt":config.prompt,"instructions":config.instructions}});
    let handler = conversation.clone();
    let result = supervisor::run_owned_async(&runtime, &registration.source, context, cancel.clone(), &config.cwd, Duration::from_secs(3600), move |method, params| {
        let conversation = handler.clone(); let receiver = receiver.clone();
        async move {
            let result = match method.as_str() {
                "providerEvent" => conversation.event(params),
                "providerInput" if params.is_null() => {
                    let mut receiver = receiver.lock().await;
                    loop {
                        match receiver.recv().await {
                            Some(input) => if let Some(value) = conversation.input(input) { break Ok(value); },
                            None => break Err("HostUnavailable".into()),
                        }
                    }
                }
                _ => Err("PermissionDenied".into()),
            };
            match result { Ok(value) => json!({"ok":true,"value":value}), Err(code) => json!({"ok":false,"error":{"code":code}}) }
        }
    }).await.map_err(str::to_owned);
    pump.abort(); let _ = pump.await;
    let finished = conversation.finish();
    if cancel.load(Ordering::Acquire) { return Ok(()); }
    result?; finished
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dynamic_harness_core_owns_pending_completion_identity_and_cancellation() {
        let events = Arc::new(Mutex::new(Vec::new())); let captured = events.clone();
        let conversation = Conversation { sid: "host-session".into(), sink: Arc::new(move |event| captured.lock().unwrap().push(event)), pending: Mutex::default(), cancel: Arc::new(AtomicBool::new(false)) };
        for forged in [json!({"kind":"done"}), json!({"kind":"approval_cancelled","requestId":"forged"}), json!({"kind":"text","text":"forged","sessionId":"other"}), json!({"kind":"approval","text":"approve","approved":true}), json!({"kind":"stop","ignored":true})] {
            assert!(conversation.event(forged).is_err());
        }
        assert!(events.lock().unwrap().is_empty());
        conversation.event(json!({"kind":"session","id":"native-resume"})).unwrap();
        assert!(conversation.event(json!({"kind":"session","id":"replaced"})).is_err());
        conversation.event(json!({"kind":"approval","text":"Allow?"})).unwrap();
        let id = events.lock().unwrap().last().unwrap().request_id.clone().unwrap();
        assert!(conversation.input(RunInput::Approval { request_id: "forged".into(), approved: true }).is_none());
        assert!(conversation.pending.lock().unwrap().approval.is_some());
        assert_eq!(conversation.input(RunInput::Approval { request_id: id.clone(), approved: false }).unwrap()["approved"], false);
        assert!(conversation.input(RunInput::Approval { request_id: id, approved: true }).is_none());
        conversation.event(json!({"kind":"approval","text":"Pending"})).unwrap();
        assert!(conversation.finish().is_err());
        conversation.input(RunInput::Stop);
        assert!(conversation.event(json!({"kind":"text","text":"late"})).is_err());
        assert!(events.lock().unwrap().iter().all(|event| event.session_id == "host-session" && event.kind != "done"));
    }
}
