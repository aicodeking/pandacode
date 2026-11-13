//! Explicit, invocation-scoped public exports. No JS-object discovery or payload caller identity.
use super::{context::{self, ContextBroker}, packages::ExtensionPackages, runtime::ExtensionRuntime, supervisor};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};
use tauri::Manager;
type Result<T> = std::result::Result<T, &'static str>;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Grant { service: String, allow: bool },
    Start { service: String, version: String, method: String, input: Value },
    Poll { request: String },
    Dispose { request: String },
}
struct Call {
    owner: String, provider: String, handle: String, cancel: Arc<AtomicBool>,
    events: Vec<Value>, sequence: usize, output: Value, error: Option<&'static str>, done: bool,
}
#[derive(Default)]
pub(super) struct Registry {
    grants: BTreeSet<(String, String, String)>, calls: BTreeMap<String, Call>,
    #[cfg(test)]
    event_ready: Arc<tokio::sync::Notify>,
}
impl Registry {
    pub(super) fn stop(&mut self, owner: Option<&str>, handle: Option<&str>) {
        self.calls.retain(|_, call| {
            let affected = owner.is_none_or(|owner| owner == call.owner || owner == call.provider) && handle.is_none_or(|handle| handle == call.handle);
            if affected { call.cancel.store(true, Ordering::Release); }
            !affected
        });
        // Grants are bound to a captured invocation, never inherited by a new activation.
        self.grants.retain(|(consumer, binding, service)| !(owner.is_none_or(|owner| owner == consumer || service.starts_with(&format!("{owner}/"))) && handle.is_none_or(|handle| binding == handle)));
    }
}
fn dto(id: &str, call: &Call) -> Value { json!({"schemaVersion":1,"request":id,"state":if call.done {"settled"} else {"running"},"events":call.events,"output":if call.done {&call.output} else {&Value::Null},"error":call.error}) }
pub(super) fn payload(schema: &Value, value: &Value) -> Result<()> {
    if value.to_string().len() > 8192 { return Err("LimitExceeded"); }
    let valid = match schema["type"].as_str() {
        Some("null") => value.is_null(), Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(), Some("integer") => value.as_i64().is_some(), _ => false,
    };
    if valid { Ok(()) } else { Err("InvalidShape") }
}
fn export<'a>(consumer: &Value, provider: &'a Value, service: &str, version: &str, method: &str, input: &Value) -> Result<&'a Value> {
    if !consumer["permissions"].as_array().is_some_and(|p| p.contains(&json!("services.call"))) || consumer["dependencies"].get(provider["id"].as_str().ok_or("InvalidShape")?).is_none() { return Err("PermissionDenied"); }
    let descriptor = provider["contributes"]["services"].as_array().and_then(|items| items.iter().find(|item| item["id"] == service)).ok_or("NotFound")?;
    if descriptor["version"] != version { return Err("IncompatibleApi"); }
    let method = descriptor["methods"].as_array().and_then(|items| items.iter().find(|item| item["id"] == method)).ok_or("PermissionDenied")?;
    payload(&method["inputSchema"], input)?;
    Ok(method)
}
fn dependencies(available: &[Value], owner: &str) -> Result<()> {
    let mut pending = vec![owner.to_owned()]; let mut seen = BTreeSet::new(); let mut selected = vec![];
    while let Some(id) = pending.pop() {
        if !seen.insert(id.clone()) { continue; }
        let manifest = available.iter().find(|manifest| manifest["id"] == id).ok_or("NotFound")?;
        if let Some(deps) = manifest["dependencies"].as_object() { pending.extend(deps.keys().cloned()); }
        selected.push(manifest.clone());
    }
    let checked = super::contracts::validate_contract("packages", &json!(selected));
    if checked["ok"] == true { Ok(()) } else { Err(match checked["error"]["code"].as_str() { Some("DependencyCycle") => "DependencyCycle", _ => "IncompatibleDependency" }) }
}
pub(super) fn call(app: &tauri::AppHandle, handle: &str, raw: Value, host_ui: bool) -> Value {
    let result = (|| {
        if raw.to_string().len() > 10000 { return Err("LimitExceeded"); }
        let disposing = raw["op"] == "dispose";
        let request: Request = serde_json::from_value(raw).map_err(|_| "InvalidShape")?;
        let packages = app.state::<ExtensionPackages>(); let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
        let snapshot = packages.snapshot();
        let (owner, _, captured) = app.state::<ContextBroker>().runtime_binding(&snapshot, handle)?;
        let consumer = &snapshot.packages.iter().find(|p| p.manifest["id"] == owner).ok_or("PermissionDenied")?.manifest;
        // Reuse dependency/version/cycle validation; unrelated packages are not involved.
        let runtime = app.state::<ExtensionRuntime>(); let registry = runtime.services.clone();
        let mut state = registry.try_lock().map_err(|_| "Timeout")?;
        match request {
            Request::Grant { service, allow } => {
                if !host_ui || !consumer["permissions"].as_array().is_some_and(|p| p.contains(&json!("services.call"))) { return Err("PermissionDenied"); }
                if allow { if state.grants.len() >= 128 { return Err("LimitExceeded"); } state.grants.insert((owner, handle.into(), service)); }
                else { state.stop(Some(&owner), Some(handle)); }
                Ok(Value::Null)
            }
            Request::Poll { request } | Request::Dispose { request } => {
                let call = state.calls.get(&request).ok_or("Cancelled")?;
                if call.owner != owner || call.handle != handle { return Err("PermissionDenied"); }
                let value = dto(&request, call);
                if disposing { if let Some(call) = state.calls.remove(&request) { call.cancel.store(true, Ordering::Release); } return Ok(Value::Null); }
                // Poll drains a bounded per-call event subscription; no replay to another activation.
                if let Some(call) = state.calls.get_mut(&request) { call.events.clear(); }
                Ok(value)
            }
            Request::Start { service, version, method, input } => {
                if !state.grants.contains(&(owner.clone(), handle.into(), service.clone())) { return Err("PermissionDenied"); }
                let provider_id = service.split('/').next().ok_or("InvalidShape")?;
                let provider = snapshot.packages.iter().find(|p| p.manifest["id"] == provider_id && p.enabled).ok_or("NotFound")?;
                dependencies(&snapshot.packages.iter().filter(|p| p.enabled).map(|p| p.manifest.clone()).collect::<Vec<_>>(), &owner)?;
                let schema = export(consumer, &provider.manifest, &service, &version, &method, &input)?.clone();
                let (_, source) = packages.executable_source(provider_id).map_err(|_| "PermissionDenied")?;
                if state.calls.len() >= 32 || state.calls.values().filter(|call| !call.done).count() >= 8 || state.calls.values().filter(|call| call.owner == owner && !call.done).count() >= 4 { return Err("LimitExceeded"); }
                let path = app.path().resource_dir().map_err(|_| "UnsupportedRuntime")?.join("extension-runtime");
                let host = supervisor::Runtime::packaged(&path).or_else(|error| if cfg!(debug_assertions) { supervisor::Runtime::packaged(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")) } else { Err(error) })?;
                let id = uuid::Uuid::new_v4().to_string(); let cancel = Arc::new(AtomicBool::new(false));
                state.calls.insert(id.clone(), Call { owner: owner.clone(), provider: provider_id.into(), handle: handle.into(), cancel: cancel.clone(), events: vec![], sequence: 0, output: Value::Null, error: None, done: false });
                let context = json!({"service":{"id":service,"method":method,"input":input,"consumer":owner,"context":captured}});
                let result = dto(&id, &state.calls[&id]);
                drop(state);
                tauri::async_runtime::spawn(async move { execute(registry, id, host, source, context, cancel, schema).await; });
                Ok(result)
            }
        }
    })();
    match result { Ok(value) => json!({"ok":true,"value":value}), Err(code) => context::failure(code) }
}
async fn execute(registry: Arc<Mutex<Registry>>, id: String, runtime: supervisor::Runtime, source: String, context: Value, cancel: Arc<AtomicBool>, schema: Value) {
    let mut received = false;
    let mut fault = None;
    let result = supervisor::run(&runtime, &source, context, cancel.clone(), |method, value| {
        let result = (|| {
            if cancel.load(Ordering::Acquire) { return Err("Cancelled"); }
            let mut state = registry.try_lock().map_err(|_| "Timeout")?;
            let call = state.calls.get_mut(&id).ok_or("Cancelled")?;
            match method {
                "serviceEvent" => {
                    payload(&schema["eventSchema"], &value)?; if call.events.len() >= 32 { return Err("LimitExceeded"); }
                    call.sequence += 1; call.events.push(json!({"sequence":call.sequence,"value":value}));
                    #[cfg(test)]
                    state.event_ready.notify_one();
                }
                "serviceResult" if !received => { payload(&schema["outputSchema"], &value)?; call.output = value; received = true; }
                _ => return Err("UnsupportedCapability"),
            }
            Ok(())
        })();
        match result { Ok(()) => json!({"ok":true,"value":null}), Err(code) => { fault = Some(code); context::failure(code) } }
    }).await;
    if let Ok(mut state) = registry.lock() { if let Some(call) = state.calls.get_mut(&id) {
        call.done = true; call.error = fault.or(result.err()).or(if received { None } else { Some("HostUnavailable") });
        if call.error.is_some() { call.output = Value::Null; call.events.clear(); }
    } }
}

#[cfg(test)]
mod tests {
    use super::*;
    const PROVIDER: &str = include_str!("../../../examples/extensions/service-provider/package/extension.json");
    const CONSUMER: &str = include_str!("../../../examples/extensions/service-consumer/package/extension.json");
    fn pending(owner: &str, handle: &str) -> Call { Call { owner: owner.into(), provider: "sample.service-provider".into(), handle: handle.into(), cancel: Arc::new(AtomicBool::new(false)), events: vec![], sequence: 0, output: Value::Null, error: None, done: false } }
    #[test]
    fn explicit_exports_version_schema_and_payload_identity_are_checked() {
        let provider: Value = serde_json::from_str(PROVIDER).unwrap(); let consumer: Value = serde_json::from_str(CONSUMER).unwrap();
        let service = "sample.service-provider/greeting";
        assert!(export(&consumer, &provider, service, "1.0.0", "hello", &json!("PandaCode")).is_ok());
        for (version, method, input, expected) in [("2.0.0", "hello", json!("x"), "IncompatibleApi"), ("1.0.0", "privateMethod", json!("x"), "PermissionDenied"), ("1.0.0", "hello", json!(42), "InvalidShape")] { assert_eq!(export(&consumer, &provider, service, version, method, &input).unwrap_err(), expected); }
        assert!(serde_json::from_value::<Request>(json!({"op":"start","service":service,"version":"1.0.0","method":"hello","input":"x","consumer":"panda.core"})).is_err());
        let mut denied = consumer.clone(); denied["permissions"] = json!([]); assert_eq!(export(&denied, &provider, service, "1.0.0", "hello", &json!("x")).unwrap_err(), "PermissionDenied");
        let mut cycle = provider.clone(); cycle["dependencies"] = json!({"sample.service-consumer":"^1.0.0"});
        assert_eq!(super::super::contracts::validate_contract("packages", &json!([cycle, consumer]))["error"]["code"], "DependencyCycle");
        let consumer: Value = serde_json::from_str(CONSUMER).unwrap();
        assert_eq!(dependencies(std::slice::from_ref(&consumer), "sample.service-consumer"), Err("NotFound"));
        let mut unrelated = provider.clone(); unrelated["id"] = json!("other.unrelated"); unrelated["dependencies"] = json!({"other.missing":"^1.0.0"});
        assert!(dependencies(&[provider, consumer, unrelated], "sample.service-consumer").is_ok());
    }
    #[test]
    fn provider_reload_disposes_subscriptions_grants_and_old_activation_without_touching_unrelated() {
        let mut registry = Registry::default(); let old = pending("sample.service-consumer", "old"); let token = old.cancel.clone();
        registry.calls.insert("old-request".into(), old);
        let mut unrelated = pending("other.consumer", "other"); unrelated.provider = "other.provider".into(); let alive = unrelated.cancel.clone();
        registry.calls.insert("unrelated".into(), unrelated);
        registry.grants.insert(("sample.service-consumer".into(), "old".into(), "sample.service-provider/greeting".into()));
        registry.grants.insert(("other.consumer".into(), "other".into(), "other.provider/api".into()));
        registry.stop(Some("sample.service-provider"), None);
        assert!(token.load(Ordering::Acquire)); assert!(!alive.load(Ordering::Acquire)); assert_eq!(registry.calls.len(), 1); assert_eq!(registry.grants.len(), 1);
        registry.calls.insert("new-request".into(), pending("sample.service-consumer", "new"));
        assert!(!registry.calls.contains_key("old-request")); assert!(registry.calls["new-request"].output.is_null());
    }
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    #[tokio::test]
    async fn real_supervised_provider_and_consumer_exchange_and_schema_failure() {
        let runtime = supervisor::Runtime::packaged(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")).unwrap();
        let schema = serde_json::from_str::<Value>(PROVIDER).unwrap()["contributes"]["services"][0]["methods"][0].clone();
        let registry = Arc::new(Mutex::new(Registry::default()));
        let provider_source = include_str!("../../../examples/extensions/service-provider/package/main.cjs");
        let consumer_source = include_str!("../../../examples/extensions/service-consumer/package/main.cjs");
        let provider: Value = serde_json::from_str(PROVIDER).unwrap(); let consumer: Value = serde_json::from_str(CONSUMER).unwrap();
        let result = supervisor::run(&runtime, consumer_source, json!({"commandId":"sample.service-consumer/greet"}), Arc::new(AtomicBool::new(false)), |method, params| {
            if method == "dialog" { assert!(params["successMessage"].as_str().unwrap().contains("Hello PandaCode; Consumer sample.service-consumer; project A")); return json!({"ok":true,"value":null}); }
            assert_eq!(method, "services");
            match params["op"].as_str().unwrap() {
                "start" => {
                    export(&consumer, &provider, params["service"].as_str().unwrap(), params["version"].as_str().unwrap(), params["method"].as_str().unwrap(), &params["input"]).unwrap();
                    let call = pending("sample.service-consumer", "captured-A"); let cancel = call.cancel.clone();
                    let value = dto("call", &call); registry.lock().unwrap().calls.insert("call".into(), call);
                    let registry = registry.clone(); let runtime = runtime.clone(); let schema = schema.clone();
                    tokio::spawn(async move { execute(registry, "call".into(), runtime, provider_source.into(), json!({"service":{"id":"sample.service-provider/greeting","method":"hello","input":"PandaCode","consumer":"sample.service-consumer","context":{"projectId":"A"}}}), cancel, schema).await; });
                    json!({"ok":true,"value":value})
                }
                "poll" => { let mut state = registry.lock().unwrap(); let call = state.calls.get_mut("call").unwrap(); let value = dto("call", call); call.events.clear(); json!({"ok":true,"value":value}) }
                "dispose" => { registry.lock().unwrap().stop(Some("sample.service-consumer"), Some("captured-A")); json!({"ok":true,"value":null}) }
                _ => panic!("unexpected operation"),
            }
        }).await.unwrap();
        assert_eq!(result.len(), 1); assert!(registry.lock().unwrap().calls.is_empty());
        let call = pending("sample.service-consumer", "A"); let cancel = call.cancel.clone(); registry.lock().unwrap().calls.insert("bad".into(), call);
        execute(registry.clone(), "bad".into(), runtime, "exports.services={'sample.service-provider/greeting':{hello:()=>42}};".into(), json!({"service":{"id":"sample.service-provider/greeting","method":"hello","input":"x"}}), cancel, schema).await;
        { let state = registry.lock().unwrap(); assert_eq!(state.calls["bad"].error, Some("InvalidShape")); assert!(state.calls["bad"].output.is_null()); }
    }
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    #[tokio::test]
    async fn native_provider_reload_cancels_inflight_and_cannot_settle_the_new_activation() {
        let runtime = supervisor::Runtime::packaged(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")).unwrap();
        let schema = serde_json::from_str::<Value>(PROVIDER).unwrap()["contributes"]["services"][0]["methods"][0].clone();
        let registry = Arc::new(Mutex::new(Registry::default()));
        let call = pending("sample.service-consumer", "old"); let cancel = call.cancel.clone();
        let ready = { let mut state = registry.lock().unwrap(); state.calls.insert("old-request".into(), call); state.event_ready.clone() };
        let running = execute(registry.clone(), "old-request".into(), runtime, "exports.services={'sample.service-provider/greeting':{hello:async(input,call)=>{await call.emit('ready');return new Promise(()=>{});}}};".into(), json!({"service":{"id":"sample.service-provider/greeting","method":"hello","input":"x"}}), cancel.clone(), schema);
        let reload = async {
            tokio::time::timeout(std::time::Duration::from_secs(4), ready.notified()).await.expect("provider must reach event before reload");
            let mut state = registry.lock().unwrap(); state.stop(Some("sample.service-provider"), None);
            state.calls.insert("new-request".into(), pending("sample.service-consumer", "new"));
        };
        tokio::join!(running, reload);
        let state = registry.lock().unwrap(); assert!(cancel.load(Ordering::Acquire)); assert!(!state.calls.contains_key("old-request"));
        assert!(!state.calls["new-request"].done); assert!(state.calls["new-request"].output.is_null()); assert!(state.calls["new-request"].events.is_empty());
    }
}
