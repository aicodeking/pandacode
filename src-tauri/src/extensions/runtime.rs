//! Explicitly trusted, lazily invoked runtime. No runtime/package download or OS sandbox claim.
use super::{context::{self, ContextBroker}, packages::ExtensionPackages, supervisor};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet, VecDeque}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};
use tauri::Manager;

struct Active { owner: String, cancel: Arc<AtomicBool> }
#[derive(Default)]
pub struct ExtensionRuntime { active: Mutex<BTreeMap<String, Active>>, quarantine: Mutex<BTreeSet<(String, String)>>, cancelled: Mutex<VecDeque<String>> }
impl ExtensionRuntime {
    fn cancel(&self, request_id: String) {
        // Same lock order as admission: cancel-before-start cannot be lost between capture and spawn.
        if let Ok(active) = self.active.lock() {
            if let Some(entry) = active.get(&request_id) { entry.cancel.store(true, Ordering::Release); }
            else if let Ok(mut cancelled) = self.cancelled.lock() { if cancelled.len() >= 128 { cancelled.pop_front(); } cancelled.push_back(request_id); }
        }
    }
    fn finish<T>(&self, request_id: &str, owner: String, digest: String, result: &Result<T, &'static str>) {
        if let Ok(mut active) = self.active.lock() { active.remove(request_id); }
        if result.as_ref().is_err_and(|code| !["Cancelled", "UnsupportedRuntime"].contains(code)) {
            if let Ok(mut quarantine) = self.quarantine.lock() { quarantine.insert((owner, digest)); }
        }
    }
    pub fn stop(&self, owner: Option<&str>) {
        if let Ok(active) = self.active.lock() { for entry in active.values().filter(|entry| owner.is_none_or(|owner| owner == entry.owner)) { entry.cancel.store(true, Ordering::Release); } }
    }
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Activate { handle: String, #[serde(rename = "requestId")] request_id: String },
    Cancel { #[serde(rename = "requestId")] request_id: String },
    Trust { id: String, digest: String, allow: bool },
}
fn ok(value: Value) -> Value { json!({"ok":true,"value":value}) }
pub fn stop(app: &tauri::AppHandle, owner: Option<&str>) { app.state::<ExtensionRuntime>().stop(owner); }
pub fn retry(app: &tauri::AppHandle, owner: &str) {
    if let Ok(mut quarantine) = app.state::<ExtensionRuntime>().quarantine.lock() { quarantine.retain(|(id, _)| id != owner); }
}

#[tauri::command]
pub async fn extensions_runtime(window: tauri::WebviewWindow, app: tauri::AppHandle, request: Value) -> Value {
    if window.label() != "main" { return context::failure("PermissionDenied"); }
    if request.to_string().len() > 8192 { return context::failure("LimitExceeded"); }
    let request: Request = match serde_json::from_value(request) { Ok(value) => value, Err(_) => return context::failure("InvalidShape") };
    match request {
        Request::Cancel { request_id } => {
            if uuid::Uuid::parse_str(&request_id).is_err() { return context::failure("InvalidShape"); }
            let state = app.state::<ExtensionRuntime>();
            state.cancel(request_id);
            ok(Value::Null)
        }
        Request::Trust { id, digest, allow } => {
            let result = (|| {
                let packages = app.state::<ExtensionPackages>(); let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
                packages.trust(&id, &digest, allow).map_err(|_| "StaleContext")?;
                serde_json::to_value(packages.snapshot()).map_err(|_| "HostUnavailable")
            })();
            if !allow { stop(&app, Some(&id)); context::invalidate(&app, Some(&id)); }
            super::windows::changed(&app);
            match result { Ok(value) => ok(value), Err(code) => context::failure(code) }
        }
        Request::Activate { handle, request_id } => {
            if handle.len() > 64 || uuid::Uuid::parse_str(&request_id).is_err() { return context::failure("InvalidShape"); }
            let admitted = (|| {
                let packages = app.state::<ExtensionPackages>(); let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
                let snapshot = packages.snapshot();
                let (owner, version, captured) = app.state::<ContextBroker>().runtime_binding(&snapshot, &handle)?;
                let (digest, source) = packages.executable_source(&owner).map_err(|_| "PermissionDenied")?;
                let state = app.state::<ExtensionRuntime>();
                if state.quarantine.lock().map_err(|_| "HostUnavailable")?.contains(&(owner.clone(), digest.clone())) { return Err("HostUnavailable"); }
                let mut active = state.active.lock().map_err(|_| "HostUnavailable")?;
                if state.cancelled.lock().map_err(|_| "HostUnavailable")?.contains(&request_id) { return Err("Cancelled"); }
                if active.len() >= 8 || active.contains_key(&request_id) || active.values().any(|entry| entry.owner == owner) { return Err("Conflict"); }
                let cancel = Arc::new(AtomicBool::new(false));
                active.insert(request_id.clone(), Active { owner: owner.clone(), cancel: cancel.clone() });
                Ok((owner, version, digest, source, captured, cancel))
            })();
            let (owner, version, digest, source, captured, cancel) = match admitted { Ok(value) => value, Err(code) => return context::failure(code) };
            let directory = app.path().resource_dir().ok().map(|path| path.join("extension-runtime"));
            let mut runtime = directory.as_deref().and_then(|path| supervisor::Runtime::packaged(path).ok());
            // Explicit checkout-local developer packaging, never PATH or a package-controlled path.
            if cfg!(debug_assertions) && runtime.is_none() { runtime = supervisor::Runtime::packaged(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")).ok(); }
            let result = if let Some(runtime) = runtime {
                supervisor::run(&runtime, &source, captured, cancel.clone(), |method, params| {
                    let result = (|| {
                        if cancel.load(Ordering::Acquire) { return Err("Cancelled"); }
                        let packages = app.state::<ExtensionPackages>(); let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
                        let snapshot = packages.snapshot();
                        let broker = app.state::<ContextBroker>();
                        broker.runtime_binding(&snapshot, &handle)?;
                        if packages.executable_source(&owner).map_err(|_| "PermissionDenied")?.0 != digest { return Err("StaleContext"); }
                        if method == "dialog" {
                            let checked = super::contracts::validate_contract("command", &json!({"schemaVersion":1,"owner":{"extensionId":owner,"version":version,"activationId":request_id},"definition":{"id":format!("{owner}/dialog"),"title":"Dialog","action":{"kind":"showDialog","dialog":params}},"capability":"ui.contribute","contexts":["project"],"inputSchema":{"type":"null"},"outputSchema":{"type":"null"}}));
                            return if checked["ok"] == true { Ok(ok(Value::Null)) } else { Err("InvalidShape") };
                        }
                        let state = app.state::<crate::AppState>(); let store = state.store.try_lock().map_err(|_| "Timeout")?;
                        Ok(broker.runtime_call(&snapshot, &store, &handle, params))
                    })();
                    match result { Ok(value) => value, Err(code) => context::failure(code) }
                }).await
            } else { Err("UnsupportedRuntime") };
            // Commit pending UI only if the same trusted/declared invocation still exists.
            let result = result.and_then(|dialogs| {
                if cancel.load(Ordering::Acquire) { return Err("Cancelled"); }
                let packages = app.state::<ExtensionPackages>(); let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
                app.state::<ContextBroker>().runtime_binding(&packages.snapshot(), &handle)?;
                if packages.executable_source(&owner).map_err(|_| "PermissionDenied")?.0 != digest { return Err("StaleContext"); }
                Ok(dialogs)
            });
            app.state::<ContextBroker>().runtime_release(&handle);
            let state = app.state::<ExtensionRuntime>();
            state.finish(&request_id, owner, digest, &result);
            match result { Ok(dialogs) => ok(json!({"schemaVersion":1,"dialogs":dialogs})), Err(code) => context::failure(code) }
        }
    }
}

// Legacy top-level entrypoint descriptors are deliberately not reinterpreted as trusted code.
pub(super) fn unsupported_reason() -> &'static str {
    reason_for(std::env::consts::OS)
}

fn reason_for(os: &str) -> &'static str {
    match os {
        "windows" => "Declarative-only: this legacy entrypoint shape is not qualified; use the reviewed trusted runtime descriptor.",
        "macos" => "Declarative-only: macOS trusted runtime packaging and native execution are not qualified.",
        "linux" => "Declarative-only: Linux trusted runtime packaging and native execution are not qualified.",
        _ => "Declarative-only: no executable runtime qualification exists for this target.",
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn quarantine_cancellation_and_stopping_are_owned_not_core_global() {
        use super::*;
        let state = ExtensionRuntime::default();
        let a = Arc::new(AtomicBool::new(false)); let b = Arc::new(AtomicBool::new(false));
        state.active.lock().unwrap().insert("a".into(), Active { owner: "sample.a".into(), cancel: a.clone() });
        state.active.lock().unwrap().insert("b".into(), Active { owner: "sample.b".into(), cancel: b.clone() });
        state.stop(Some("sample.a")); assert!(a.load(Ordering::Acquire)); assert!(!b.load(Ordering::Acquire));
        state.finish::<()>("a", "sample.a".into(), "digest-a".into(), &Err("Timeout"));
        assert!(state.quarantine.lock().unwrap().contains(&("sample.a".into(), "digest-a".into())));
        assert!(state.active.lock().unwrap().contains_key("b"));
        state.finish::<()>("b", "sample.b".into(), "digest-b".into(), &Err("Cancelled"));
        assert!(!state.quarantine.lock().unwrap().contains(&("sample.b".into(), "digest-b".into())));
        assert!(state.active.lock().unwrap().is_empty());
        state.cancel("cancel-before-start".into());
        assert!(state.cancelled.lock().unwrap().contains(&"cancel-before-start".to_owned()));
    }
    #[test]
    fn legacy_entrypoint_remains_unsupported_with_a_specific_reason() {
        for os in ["windows", "macos", "linux", "unknown"] {
            let reason = super::reason_for(os);
            assert!(reason.starts_with("Declarative-only:"));
            assert!(reason.contains("not qualified") || reason.contains("no executable runtime"));
        }
    }
}
