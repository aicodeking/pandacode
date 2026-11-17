//! Package providers use core conversation events and input, never raw AgentEvent/IPC authority.
use super::{AgentEvent, ModelInfo, ProviderInfo, ReasoningEffortInfo, RunConfig, RunInput, Sink};
use crate::extensions::{packages::Packages, runtime_provider_launch as launch, supervisor};
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
    // The user's warm-spare opt-ins (R0807) live in a file next to the grants; nothing starts from loading them.
    crate::providers::speed_adapter::configure(directory.as_deref());
    let _ = HOST.set(Host { packages: Arc::downgrade(packages), directory });
}
#[derive(Clone)]
struct Registration { definition: Value, version: String, digest: String, source: String }
fn registrations() -> Vec<Registration> {
    registrations_for(crate::headless::active())
}
fn registrations_for(workspace_only: bool) -> Vec<Registration> {
    HOST.get().and_then(|host| host.packages.upgrade()).and_then(|packages| packages.lock().ok().map(|packages| if workspace_only { packages.provider_registrations_for(true) } else { packages.provider_registrations() })).unwrap_or_default()
        .into_iter().map(|(definition, version, digest, source)| Registration { definition, version, digest, source }).collect()
}
fn resolve(id: &str) -> Result<Registration, String> {
    registrations().into_iter().find(|registration| registration.definition["id"] == id).ok_or_else(|| {
        // An installed `launch` provider whose executable content is not trusted gets its own explicit readiness error.
        let untrusted = crate::extensions::providers::extension_owner(id).and_then(|owner| HOST.get().and_then(|host| host.packages.upgrade()).and_then(|packages| packages.lock().ok().and_then(|packages| launch::facts(&packages, owner, id))));
        if untrusted.is_some_and(|facts| !facts.trusted) { launch::TRUST_REQUIRED.into() } else { crate::extensions::providers::PROVIDER_RECOVERY.into() }
    })
}
/// The packaged Node runtime of this target, if it is qualified.
fn node_runtime() -> Option<supervisor::Runtime> {
    let directory = HOST.get().and_then(|host| host.directory.clone());
    let mut runtime = directory.as_deref().and_then(|directory| supervisor::Runtime::packaged(directory).ok());
    if runtime.is_none() && cfg!(debug_assertions) { runtime = supervisor::Runtime::packaged(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")).ok(); }
    runtime
}
/// Where a declared harness's placeholders resolve for this package.
fn launch_places(owner: &str, provider: &str) -> launch::Places {
    let facts = HOST.get().and_then(|host| host.packages.upgrade()).and_then(|packages| packages.lock().ok().and_then(|packages| launch::facts(&packages, owner, provider)));
    launch::Places { node: node_runtime().map(|runtime| runtime.binary), package: facts.as_ref().and_then(|facts| facts.package.clone()), data: facts.and_then(|facts| facts.data) }
}
fn catalog(definition: &Value) -> Vec<ModelInfo> {
    // The models a service published with `panda.providers.update` (R0806) replace the manifest's until it stops.
    crate::extensions::runtime_provider_state::effective_models(definition["id"].as_str().unwrap_or_default(), definition).iter().map(|model| ModelInfo {
        id: model["id"].as_str().unwrap_or_default().into(), name: model["name"].as_str().unwrap_or_default().into(), description: String::new(),
        reasoning_efforts: model["efforts"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|effort| ReasoningEffortInfo { id: effort.into(), name: effort.into(), description: String::new() }).collect(),
        default_reasoning_effort: None, context_window: model["contextWindow"].as_u64(),
        speed_tiers: model["speedTiers"].as_array().into_iter().flatten().map(|tier| ReasoningEffortInfo { id: tier["id"].as_str().unwrap_or_default().into(), name: tier["name"].as_str().unwrap_or_default().into(), description: tier["description"].as_str().unwrap_or_default().into() }).collect(),
    }).collect()
}
/// What a warm spare needs (R0807), read and checked in one place: the provider is registered (so its package is
/// enabled and trusted, not in safe mode), declares `launch.warmSpare`, is ready, and its command resolves.
pub(crate) struct WarmContext { pub owner: String, pub digest: String, pub resolved: launch::Resolved, pub key: String }
/// Short and blocking (it reads the package list): call it off the async runtime, with no lock held.
pub(crate) fn warm_context(provider: &str, cwd: &std::path::Path) -> Result<WarmContext, String> {
    let registration = resolve(provider)?;
    let owner = crate::extensions::providers::extension_owner(provider).ok_or("InvalidIdentity")?;
    let spec = launch::declared(&registration.definition).ok_or("UnsupportedCapability: this provider declares no launch.")?;
    if spec["warmSpare"] != true { return Err("UnsupportedCapability: this harness does not declare warmSpare.".into()); }
    let packages = HOST.get().and_then(|host| host.packages.upgrade()).ok_or("HostUnavailable")?;
    let trusted = packages.lock().ok().and_then(|packages| launch::facts(&packages, owner, provider)).is_some_and(|facts| facts.trusted);
    if !trusted { return Err(launch::TRUST_REQUIRED.into()); }
    let metadata = metadata(&registration.definition);
    if metadata["readiness"]["state"] != "ready" { return Err(metadata["readiness"]["reason"].as_str().unwrap_or("Provider unavailable").into()); }
    let resolved = launch::resolve(spec, &launch_places(owner, provider))?;
    let key = crate::providers::speed_adapter::key(provider, &registration.digest, &resolved, cwd);
    Ok(WarmContext { owner: owner.to_owned(), digest: registration.digest.clone(), resolved, key })
}
pub(crate) fn discover() -> Vec<ProviderInfo> {
    discover_placement(crate::headless::active())
}
pub(crate) fn discover_workspace() -> Vec<ProviderInfo> { discover_placement(true) }
fn discover_placement(workspace_only: bool) -> Vec<ProviderInfo> {
    registrations_for(workspace_only).into_iter().map(|registration| {
        let metadata = metadata(&registration.definition);
        ProviderInfo { id: registration.definition["id"].as_str().unwrap_or_default().into(), name: registration.definition["name"].as_str().unwrap_or_default().into(), installed: cfg!(all(target_os = "windows", target_arch = "x86_64")) && metadata["readiness"]["state"] == "ready", path: None, version: registration.version, models: catalog(&registration.definition), metadata: Some(metadata) }
    }).collect()
}
/// Validated active descriptors only; no config contents, paths from CLI output or probing.
pub(crate) fn discovery_definitions() -> Vec<Value> {
    registrations().into_iter().map(|registration| registration.definition).collect()
}
fn metadata(definition: &Value) -> Value {
    // Published readiness, account and limits (R0806) come before the launch check, so an executable that cannot start still wins over a published `ready`.
    let base = crate::extensions::runtime_provider_state::apply_metadata(definition["id"].as_str().unwrap_or_default(), declared_metadata(definition));
    let id = definition["id"].as_str().unwrap_or_default();
    match (launch::declared(definition), crate::extensions::providers::extension_owner(id)) {
        (Some(_), Some(owner)) => launch::overlay(owner, definition, base, &launch_places(owner, id)),
        _ => base,
    }
}
fn declared_metadata(definition: &Value) -> Value {
    definition.get("metadata").cloned().unwrap_or_else(|| json!({"modes":["ask"],"authentication":"Authentication is managed by the trusted extension; no credentials are returned to PandaCode.","readiness":{"state":"ready","reason":"Ready through its trusted extension."},"usage":{"context":false,"limitsReason":"This extension does not expose account limits. Check its provider dashboard."}}))
}
pub(crate) fn limits_reason(id: &str) -> String {
    resolve(id).map(|registration| metadata(&registration.definition)["usage"]["limitsReason"].as_str().unwrap_or("Account limits are not exposed by this extension.").to_owned()).unwrap_or_else(|reason| reason)
}
fn validate_mode(definition: &Value, mode: &str) -> Result<(), String> {
    let metadata = metadata(definition);
    if metadata["readiness"]["state"] != "ready" { return Err(metadata["readiness"]["reason"].as_str().unwrap_or("Provider unavailable").into()); }
    if metadata["modes"].as_array().is_some_and(|modes| modes.iter().any(|id| id == mode)) { Ok(()) }
    else { Err("UnsupportedCapability: this extension does not support this permission mode. Choose a supported mode.".into()) }
}

#[cfg(test)]
mod metadata_tests {
    use super::*;
    #[test]
    fn provider_metadata_modes_readiness_and_legacy_defaults() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/fake-harness/extension.json")).unwrap();
        let mut definition = manifest["contributes"]["providers"][0].clone();
        assert!(validate_mode(&definition, "ask").is_ok());
        assert!(validate_mode(&definition, "plan").is_ok());
        assert!(validate_mode(&definition, "full").unwrap_err().contains("UnsupportedCapability"));
        definition["metadata"]["readiness"] = json!({"state":"signedOut","reason":"Sign in using this extension."});
        assert_eq!(validate_mode(&definition, "ask").unwrap_err(), "Sign in using this extension.");
        definition.as_object_mut().unwrap().remove("metadata");
        assert!(validate_mode(&definition, "ask").is_ok());
        assert!(validate_mode(&definition, "full").is_err());
        assert!(metadata(&definition)["usage"]["limitsReason"].as_str().unwrap().contains("does not expose"));
    }
    #[test]
    fn provider_metadata_rejects_foreign_icons_duplicate_modes_and_unknown_states() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/fake-harness/extension.json")).unwrap();
        for (field, invalid) in [("modes", json!(["ask", "ask"])), ("modes", json!(["review"])), ("icon", json!("another.package/mark")), ("readiness", json!({"state":"unknown","reason":"Unavailable"}))] {
            let mut invalid_manifest = manifest.clone();
            invalid_manifest["contributes"]["providers"][0]["metadata"][field] = invalid;
            assert_eq!(crate::extensions::contracts::validate_contract("packages", &json!([invalid_manifest]))["ok"], false);
        }
    }
}
pub(crate) fn models(id: &str) -> Result<Vec<ModelInfo>, String> { Ok(catalog(&resolve(id)?.definition)) }
/// The slash commands an active package provider's own package declares for it (`contributes.slashCommands`).
pub(crate) fn slash_commands(id: &str) -> Vec<Value> {
    HOST.get().and_then(|host| host.packages.upgrade()).and_then(|packages| packages.lock().ok().map(|packages| packages.provider_slash_commands(id))).unwrap_or_default()
}
pub(crate) fn require_available(id: &str) -> Result<(), String> {
    if crate::extensions::providers::extension_owner(id).is_some() { resolve(id).and_then(|registration| {
        let metadata = metadata(&registration.definition);
        if metadata["readiness"]["state"] == "ready" { Ok(()) } else { Err(metadata["readiness"]["reason"].as_str().unwrap_or("Provider unavailable").into()) }
    }) }
    else { crate::extensions::providers::require_builtin_execution(id) }
}
pub(crate) fn require_workspace(id: &str) -> Result<(), String> {
    if !registrations_for(true).iter().any(|registration| registration.definition["id"] == id) {
        return Err(crate::extensions::placement::MISSING.into());
    }
    require_available(id)
}
fn require_team_definition(definition: &Value) -> Result<(), String> {
    if metadata(definition)["teams"] == true { Ok(()) }
    else { Err("UnsupportedCapability: this extension provider does not support team tools".into()) }
}
pub(crate) fn require_teams(id: &str) -> Result<(), String> {
    require_available(id)?;
    require_team_definition(&resolve(id)?.definition)
}

/// Only core's role-scoped team tools are callable. Never expose arbitrary app tools
/// or bypass a ToolHost approval requirement through a package-asserted capability.
fn team_catalog(host: &super::ToolHost) -> Vec<Value> {
    host.tools.iter().filter(|tool| tool["type"] == "function" && tool["name"].as_str().is_some_and(|name| crate::architect::team_tool(name) && !host.approval_tools.contains(name))).cloned().collect()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TeamCall { name: String, arguments: Value }
async fn team_call(host: Option<&super::ToolHost>, params: Value) -> Result<Value, String> {
    if params.to_string().len() > 32768 { return Err("LimitExceeded".into()); }
    let call: TeamCall = serde_json::from_value(params).map_err(|_| "InvalidShape")?;
    let host = host.ok_or("UnsupportedCapability: team tools")?;
    if !call.arguments.is_object() || !team_catalog(host).iter().any(|tool| tool["name"] == call.name) { return Err("UnsupportedCapability: team tool".into()); }
    (host.handler)(call.name, call.arguments).await
}
pub(crate) fn validate_effort(id: &str, effort: Option<&str>) -> Result<(), String> {
    if effort.is_none() || models(id)?.iter().any(|model| model.reasoning_efforts.iter().any(|entry| Some(entry.id.as_str()) == effort)) { Ok(()) }
    else { Err("Unsupported provider effort".into()) }
}
pub(crate) fn stop(owner: Option<&str>) {
    // Disable, uninstall, trust loss, rollback and safe mode also end the package's warm spares (R0807).
    crate::providers::speed_adapter::discard_owner(owner);
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

pub(crate) async fn run(config: RunConfig, sink: Sink, mut input: tokio::sync::mpsc::UnboundedReceiver<RunInput>, host: Option<super::ToolHost>, harness: Arc<AtomicBool>) -> Result<(), String> {
    let registration = resolve(&config.provider)?;
    let packages = HOST.get().and_then(|host| host.packages.upgrade()).ok_or("HostUnavailable")?;
    let owner = crate::extensions::providers::extension_owner(&config.provider).ok_or("InvalidIdentity")?;
    let pin = crate::extensions::packages::pin_provider(&packages, owner, &registration.digest)?;
    if host.as_ref().is_some_and(|host| host.tools.iter().any(|tool| tool["name"].as_str().is_some_and(crate::architect::team_tool))) { require_team_definition(&registration.definition)?; }
    let host = host.filter(|_| require_team_definition(&registration.definition).is_ok());
    // A declared `launch` harness runs its own executable over ACP: no handler, no Node bootstrap, and a catalog that may start empty.
    let declared = launch::declared(&registration.definition).cloned();
    let runtime = if declared.is_some() { None } else { Some(node_runtime().ok_or("UnsupportedRuntime: this target's trusted provider runtime is not qualified")?) };
    if config.goal.is_some() || config.skill.is_some() || !config.images.is_empty() { return Err("UnsupportedCapability: goals, native skills or images".into()); }
    validate_mode(&registration.definition, &config.mode)?;
    let resolved = declared.as_ref().map(|spec| launch::resolve(spec, &launch_places(owner, &config.provider))).transpose()?;
    let models = catalog(&registration.definition);
    if declared.is_none() || !models.is_empty() {
        let model = models.iter().find(|model| model.id == config.model).ok_or("Unsupported provider model")?;
        if config.reasoning_effort.as_ref().is_some_and(|effort| !model.reasoning_efforts.iter().any(|entry| &entry.id == effort)) { return Err("Unsupported provider effort".into()); }
    }
    let selection = crate::providers::speed_adapter::selection(&config, &models);
    let cancel = Arc::new(AtomicBool::new(false));
    let key = uuid::Uuid::new_v4().to_string();
    {
        let mut runs = RUNS.lock().map_err(|_| "HostUnavailable")?;
        if runs.len() >= 8 { return Err("LimitExceeded: active provider runs".into()); }
        runs.insert(key.clone(), (crate::extensions::providers::extension_owner(&config.provider).unwrap().into(), cancel.clone()));
    }
    let mut lease = RunLease { key, cancel: cancel.clone(), pump: None };
    // Close disable/reload between source capture and registering the owned cancellation handle.
    if packages.lock().map_err(|_| "HostUnavailable")?.executable_source(owner)?.0 != registration.digest { return Err("StaleContext".into()); }
    let conversation = Arc::new(Conversation { sid: config.session_id.clone(), sink, pending: Mutex::default(), cancel: cancel.clone() });
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    let (rx, receiver) = if resolved.is_some() { (Some(rx), None) } else { (None, Some(Arc::new(tokio::sync::Mutex::new(rx)))) };
    let reader = conversation.clone();
    let pump = tokio::spawn(async move {
        while let Some(input) = input.recv().await {
            if matches!(input, RunInput::Stop) { reader.input(input); break; }
            // Never block Stop behind a full extension-input queue.
            if tx.try_send(input).is_err() { reader.cancel.store(true, Ordering::Release); break; }
        }
    });
    lease.pump = Some(pump.abort_handle());
    let context = json!({"provider":{"apiVersion":1,"id":config.provider,"version":registration.version,"digest":registration.digest,"model":config.model,"effort":config.reasoning_effort,"mode":config.mode,"resumeId":config.resume_id,"prompt":config.prompt,"instructions":config.instructions,"teamTools":host.as_ref().map(team_catalog).unwrap_or_default()}});
    let handler = conversation.clone();
    harness.store(true, Ordering::SeqCst);
    let result = if let (Some(resolved), Some(inputs)) = (resolved, rx) {
        // Every run of the package shares its one launch state; the service flag joins a declared background service.
        if let Some(facts) = packages.lock().ok().and_then(|packages| launch::facts(&packages, owner, &config.provider)) { launch::mark_service(owner, facts.service); }
        let (events, answers) = (handler.clone(), handler.clone());
        // An opted-in package may hold one initialized spare for exactly this launch (R0807); anything else starts cold, here.
        let spare_key = crate::providers::speed_adapter::key(&config.provider, &registration.digest, &resolved, &config.cwd);
        let adopted = crate::providers::speed_adapter::take(&config.session_id, owner, &spare_key);
        crate::providers::speed_adapter::record_launch(owner, &config.provider, &config.session_id, &selection, adopted.is_some());
        let meta = crate::providers::speed_adapter::meta(owner, &selection);
        launch::drive_adopted(owner, resolved, &config.cwd, &config.prompt, config.resume_id.as_deref(), move |value| events.event(value), move |value| answers.input(value), inputs, cancel.clone(), adopted.map(|spare| (spare.started, spare.reply)), Some(meta)).await
    } else {
    let runtime = runtime.expect("a handler provider has its runtime"); let receiver = receiver.expect("a handler provider has its receiver");
    supervisor::run_owned_async(&runtime, &registration.source, context, cancel.clone(), &config.cwd, Duration::from_secs(3600), move |method, params| {
        let conversation = handler.clone(); let receiver = receiver.clone(); let host = host.clone();
        async move {
            let result = match method.as_str() {
                "providerEvent" => conversation.event(params),
                "providerTeamTool" if !conversation.cancel.load(Ordering::Acquire) => team_call(host.as_ref(), params).await,
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
    }).await.map(|_| ()).map_err(str::to_owned)
    };
    pump.abort(); let _ = pump.await;
    let finished = conversation.finish();
    drop(pin);
    if let Ok(packages) = packages.lock() { let _ = packages.activation_finished(owner, &registration.digest, result.is_ok() && finished.is_ok()); }
    crate::extensions::packages::updates_changed();
    if cancel.load(Ordering::Acquire) { return Ok(()); }
    result?; finished
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn team_capability_is_opt_in_and_core_catalog_and_approval_rules_are_not_bypassable() {
        for definition in [json!({}), json!({"metadata":{"teams":false}})] { assert!(require_team_definition(&definition).unwrap_err().contains("UnsupportedCapability")); }
        assert!(require_team_definition(&json!({"metadata":{"teams":true}})).is_ok());
        let calls = Arc::new(Mutex::new(Vec::new())); let captured = calls.clone();
        let host = super::super::ToolHost { tools: vec![
            json!({"type":"function","name":"pandacode_list_workers"}),
            json!({"type":"function","name":"pandacode_cancel_worker"}),
            json!({"type":"function","name":"pandacode_open_browser"})],
            approval_tools: ["pandacode_cancel_worker".into()].into(),
            handler: Arc::new(move |name, _| { captured.lock().unwrap().push(name); Box::pin(async { Ok(json!({"workers":[]})) }) }) };
        assert_eq!(team_catalog(&host).len(), 1);
        assert_eq!(team_call(Some(&host), json!({"name":"pandacode_list_workers","arguments":{}})).await.unwrap(), json!({"workers":[]}));
        for request in [json!({"name":"pandacode_cancel_worker","arguments":{}}), json!({"name":"pandacode_open_browser","arguments":{}}), json!({"name":"pandacode_list_workers","arguments":{},"approved":true}), json!({"name":"pandacode_list_workers","arguments":null})] { assert!(team_call(Some(&host), request).await.is_err()); }
        assert!(team_call(None, json!({"name":"pandacode_list_workers","arguments":{}})).await.is_err());
        assert_eq!(*calls.lock().unwrap(), vec!["pandacode_list_workers"]);
        assert!(crate::architect::require_team_provider("sample.missing/recorded").unwrap_err().contains("History is preserved"));
        // Upstream 0.3.128 bridges team tools into ZCode through `session/create`, so every
        // built-in is a core team harness; anything outside the roster and not a package stays refused.
        for builtin in crate::providers::PROVIDERS.map(|(id, _)| id) { assert!(crate::architect::require_team_provider(builtin).is_ok(), "{builtin}"); }
        for unknown in ["not-a-provider", "panda.core/zcode", "sample.harness"] { assert!(crate::architect::require_team_provider(unknown).unwrap_err().contains("unsupported team tools"), "{unknown}"); }
    }
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
