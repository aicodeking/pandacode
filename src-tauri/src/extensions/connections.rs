//! Opaque host-managed credentials. This API is not an OS sandbox for trusted code.
use super::{context::{self, ContextBroker}, packages::ExtensionPackages, runtime_connection_adapters::{self as adapters, Auth, Source}};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::{BTreeMap, VecDeque}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use tauri::Manager;

type Result<T> = std::result::Result<T, &'static str>;
const SERVICE: &str = "pandacode.extension-connections";
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Scope { owner: String, version: String, digest: String, project: String, handle: String, connection: String, operation: String }
struct Grant { credential: String, revoked: Arc<AtomicBool> }
struct Pending { scope: Scope, cancel: Arc<AtomicBool>, revoked: Arc<AtomicBool>, result: Option<Result<Value>> }
#[derive(Default)]
struct Registry { grants: BTreeMap<Scope, Grant>, pending: BTreeMap<String, Pending>, starts: VecDeque<Instant> }
#[derive(Default)]
pub struct ExtensionConnections(Arc<Mutex<Registry>>);
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Connect { connection: String, operation: String, secret: String },
    Revoke { connection: String, operation: String },
    Status { connection: String, operation: String },
    Start { connection: String, operation: String, #[serde(default)] credential: Option<String>, #[serde(default)] body: Option<Value>, #[serde(default)] query: Option<Value> },
    Poll { connection: String, operation: String, request: String },
    Cancel { connection: String, operation: String, request: String },
}
impl Request {
    fn resource(&self) -> (&str, &str) { match self {
        Self::Connect { connection, operation, .. } | Self::Revoke { connection, operation } | Self::Status { connection, operation } | Self::Start { connection, operation, .. } | Self::Poll { connection, operation, .. } | Self::Cancel { connection, operation, .. } => (connection, operation),
    } }
}
impl Registry {
    fn owned(&mut self, scope: &Scope, id: &str) -> Result<&mut Pending> { self.pending.get_mut(id).filter(|pending| &pending.scope == scope).ok_or("PermissionDenied") }
    fn admit(&mut self) -> Result<()> {
        let now = Instant::now();
        self.starts.retain(|start| now.duration_since(*start) < Duration::from_secs(60));
        if self.starts.len() >= 30 { return Err("LimitExceeded"); }
        self.starts.push_back(now); Ok(())
    }
    fn revoke(&mut self, scope: &Scope) {
        if let Some(grant) = self.grants.remove(scope) { grant.revoked.store(true, Ordering::Release); crate::secret_store::remove(SERVICE, &grant.credential); }
        // Remove even already completed output; no stale result can survive revocation.
        for pending in self.pending.values_mut().filter(|pending| &pending.scope == scope) { pending.revoked.store(true, Ordering::Release); pending.result = Some(Err("PermissionDenied")); }
    }
    fn stop(&mut self, owner: Option<&str>, handle: Option<&str>) {
        let scopes: Vec<_> = self.grants.keys().filter(|scope| owner.is_none_or(|owner| scope.owner == owner) && handle.is_none_or(|handle| scope.handle == handle)).cloned().collect();
        for scope in scopes { self.revoke(&scope); }
        // Requests that carry no host credential (a package secret, no authentication) have no grant to revoke.
        for pending in self.pending.values_mut().filter(|pending| owner.is_none_or(|owner| pending.scope.owner == owner) && handle.is_none_or(|handle| pending.scope.handle == handle)) {
            pending.revoked.store(true, Ordering::Release); pending.result = Some(Err("PermissionDenied"));
        }
    }
    fn settle(&mut self, id: &str, result: Result<Value>) {
        if let Some(pending) = self.pending.get_mut(id) {
            if pending.revoked.load(Ordering::Acquire) { pending.result = Some(Err("PermissionDenied")); }
            else if pending.cancel.load(Ordering::Acquire) { pending.result = Some(Err("Cancelled")); }
            else if pending.result.is_none() { pending.result = Some(result); }
        }
    }
}
impl ExtensionConnections { pub fn stop(&self, owner: Option<&str>, handle: Option<&str>) { if let Ok(mut state) = self.0.lock() { state.stop(owner, handle); } } }
fn status(grant: Option<&Grant>) -> Value { json!({"schemaVersion":1,"state":if grant.is_some() {"connected"} else {"disconnected"},"credential":grant.map(|grant| &grant.credential)}) }
fn dto(id: &str, pending: &Pending) -> Value {
    let (state, value, error) = match &pending.result { None => ("running", Value::Null, None), Some(Ok(value)) => ("completed", value.clone(), None), Some(Err(code)) => ("failed", Value::Null, Some(*code)) };
    json!({"schemaVersion":1,"request":id,"state":state,"response":value,"error":error})
}
/// The declared-address rules live with the adapters (R0804): https or numeric loopback http, a query allowed, no
/// user information, no fragment.
pub(super) fn endpoint(raw: &str) -> Result<reqwest::Url> { adapters::address(raw) }
/// What a host-entered credential can be used for: it needs an authentication that carries one.
fn supported(plan: &adapters::Plan) -> Result<()> {
    if plan.auth == Auth::None || plan.source != Source::Host { return Err("UnsupportedCapability"); }
    Ok(())
}
fn caller_policy(request: &Request, host_ui: bool) -> Result<()> {
    if !host_ui && matches!(request, Request::Connect { .. } | Request::Revoke { .. }) { Err("PermissionDenied") } else { Ok(()) }
}
pub(super) fn call(app: &tauri::AppHandle, handle: &str, raw: Value, host_ui: bool) -> Value {
    let result = (|| {
        if raw.to_string().len() > 8192 { return Err("LimitExceeded"); }
        let request: Request = serde_json::from_value(raw).map_err(|_| "InvalidShape")?;
        let cancelling = matches!(request, Request::Cancel { .. });
        caller_policy(&request, host_ui)?;
        let packages = app.state::<ExtensionPackages>(); let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
        let snapshot = packages.snapshot();
        let (owner, version, captured) = app.state::<ContextBroker>().local_binding(app, &snapshot, handle)?;
        let manifest = &snapshot.packages.iter().find(|package| package.manifest["id"] == owner).ok_or("PermissionDenied")?.manifest;
        let (connection, operation) = request.resource();
        let planned = adapters::plan(manifest, Some(&captured["commandId"]), connection, operation)?;
        let digest = packages.executable_source(&owner).map_err(|_| "PermissionDenied")?.0;
        let scope = Scope { owner, version, digest, project: captured["projectId"].as_str().unwrap_or("").into(), handle: handle.into(), connection: connection.into(), operation: operation.into() };
        let connections = app.state::<ExtensionConnections>(); let mut state = connections.0.try_lock().map_err(|_| "Timeout")?;
        match request {
            Request::Connect { secret, .. } => {
                supported(&planned)?;
                if state.grants.len() >= 128 && !state.grants.contains_key(&scope) { return Err("LimitExceeded"); }
                let credential = uuid::Uuid::new_v4().to_string();
                crate::secret_store::set(SERVICE, &credential, &secret).map_err(|_| "InvalidShape")?;
                state.revoke(&scope);
                state.grants.insert(scope.clone(), Grant { credential, revoked: Arc::new(AtomicBool::new(false)) });
                Ok(status(state.grants.get(&scope)))
            }
            Request::Revoke { .. } => { state.revoke(&scope); Ok(status(None)) }
            Request::Status { .. } => Ok(status(state.grants.get(&scope))),
            Request::Start { credential, body, query, .. } => {
                // The credential source decides what `start` takes (G26): a host handle only for `host`, nothing for the rest.
                let (handle, secret, revoked) = match (&planned.auth, &planned.source, credential) {
                    (Auth::None, _, None) => (None, None, Arc::new(AtomicBool::new(false))),
                    (_, Source::Host, Some(handle)) => {
                        let grant = state.grants.get(&scope).filter(|grant| grant.credential == handle).ok_or("PermissionDenied")?;
                        (Some(grant.credential.clone()), None, grant.revoked.clone())
                    }
                    (_, Source::Secret(key), None) => (None, Some(app.state::<super::runtime_private_secrets::PrivateSecrets>().attach(&scope.owner, key).ok_or("NotFound")?), Arc::new(AtomicBool::new(false))),
                    // A credential PandaCode holds is attached by R0805; until its resolver exists none is held.
                    (_, Source::Held(_), None) => return Err("NotFound"),
                    _ => return Err("InvalidShape"),
                };
                let secret = match (secret, handle) { (Some(secret), _) => Some(secret), (None, Some(handle)) => Some(crate::secret_store::get(SERVICE, &handle).ok_or("PermissionDenied")?), (None, None) => None };
                let prepared = adapters::prepare(&planned, body.as_ref(), query.as_ref())?;
                if state.pending.values().filter(|pending| pending.result.is_none()).count() >= 8 { return Err("Conflict"); }
                if state.pending.len() >= 64 { let old = state.pending.iter().find(|(_, pending)| pending.result.is_some()).map(|(id, _)| id.clone()).ok_or("LimitExceeded")?; state.pending.remove(&old); }
                state.admit()?;
                let id = uuid::Uuid::new_v4().to_string(); let cancel = Arc::new(AtomicBool::new(false));
                state.pending.insert(id.clone(), Pending { scope, cancel: cancel.clone(), revoked: revoked.clone(), result: None });
                let registry = connections.0.clone(); let request_id = id.clone();
                let stopped: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || revoked.load(Ordering::Acquire));
                tauri::async_runtime::spawn(async move {
                    let result = adapters::execute(&planned, prepared, secret, cancel, stopped).await;
                    if let Ok(mut registry) = registry.lock() { registry.settle(&request_id, result); }
                });
                Ok(dto(&id, state.pending.get(&id).ok_or("HostUnavailable")?))
            }
            Request::Poll { request, .. } | Request::Cancel { request, .. } => {
                let pending = state.owned(&scope, &request)?;
                // Cancellation is recognized before late transport completion.
                if cancelling && pending.result.is_none() { pending.cancel.store(true, Ordering::Release); pending.result = Some(Err("Cancelled")); }
                Ok(dto(&request, pending))
            }
        }
    })();
    match result { Ok(value) => json!({"ok":true,"value":value}), Err(code) => context::failure(code) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};
    const SECRET: &str = "DUMMY-T37-credential-never-return";
    fn scope(handle: &str) -> Scope { Scope { owner: "sample.fake-service".into(), version: "1.0.0".into(), digest: "digest".into(), project: "A".into(), handle: handle.into(), connection: "sample.fake-service/api".into(), operation: "summary".into() } }
    fn flag() -> Arc<AtomicBool> { Arc::new(AtomicBool::new(false)) }
    async fn server(response: Vec<u8>, wait: bool) -> (reqwest::Url, tokio::task::JoinHandle<String>, Arc<tokio::sync::Notify>) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = endpoint(&format!("http://{}/summary", listener.local_addr().unwrap())).unwrap();
        let received = Arc::new(tokio::sync::Notify::new()); let signal = received.clone();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap(); let mut bytes = vec![0; 8192]; let mut length = 0;
            loop { let count = socket.read(&mut bytes[length..]).await.unwrap(); length += count; if count == 0 || bytes[..length].windows(4).any(|window| window == b"\r\n\r\n") { break; } }
            let request = String::from_utf8(bytes[..length].to_vec()).unwrap(); signal.notify_one();
            if wait { tokio::time::sleep(Duration::from_secs(2)).await; }
            let _ = socket.write_all(&response).await; request
        });
        (url, task, received)
    }
    const RESPONSE_BYTES: usize = adapters::SUMMARY_RESPONSE;
    /// The original summary transport, now the shared executor with a bearer, json-summary plan.
    async fn transport(url: reqwest::Url, secret: String, timeout: Duration, cancel: Arc<AtomicBool>, revoked: Arc<AtomicBool>) -> Result<Value> {
        let manifest = json!({"permissions":["connections.request"],"contributes":{"connections":[{"id":"c","command":"c","authentication":"bearer","adapter":"json-summary","timeoutMs":100,"operations":[{"id":"o","method":"GET","url":url.as_str()}]}]}});
        let mut plan = adapters::plan(&manifest, None, "c", "o")?; plan.timeout = timeout;
        let prepared = adapters::prepare(&plan, None, None)?;
        adapters::execute(&plan, prepared, Some(secret), cancel, Arc::new(move || revoked.load(Ordering::Acquire))).await
    }
    fn sanitize(bytes: &[u8], secret: &str) -> Result<Value> { adapters::project(adapters::Adapter::Summary, 200, bytes, Some(secret)) }
    fn response(body: &str) -> Vec<u8> { format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes() }
    #[test]
    fn descriptors_and_endpoint_policy_reject_forged_operations_domains_and_authentication() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/fake-service/extension.json")).unwrap();
        assert_eq!(super::super::contracts::validate_contract("packages", &json!([manifest.clone()]))["ok"], true);
        assert!(adapters::plan(&manifest, Some(&json!("sample.fake-service/request")), "sample.fake-service/api", "summary").is_ok());
        // Unknown command, connection and operation stay refused: they name something the user never saw at install.
        for (command, connection, op) in [("other.extension/request", "sample.fake-service/api", "summary"), ("sample.fake-service/request", "other.extension/api", "summary"), ("sample.fake-service/request", "sample.fake-service/api", "undeclared")] { assert_eq!(adapters::plan(&manifest, Some(&json!(command)), connection, op).unwrap_err(), "PermissionDenied"); }
        let request: Request = serde_json::from_value(json!({"op":"connect","connection":"x","operation":"summary","secret":SECRET})).unwrap();
        assert_eq!(caller_policy(&request, false), Err("PermissionDenied")); assert!(caller_policy(&request, true).is_ok());
        // R0804: a query in the declared address and any numeric loopback are allowed (they had no recorded reason to be refused).
        for url in ["http://example.com/", "file:///etc/passwd", "https://user:pass@example.com/", "https://example.com/#secret", "http://127.0.0.1.evil.example/"] { assert!(endpoint(url).is_err(), "{url}"); }
        for url in ["https://example.com/v1/summary", "http://127.0.0.1:4000/summary", "https://example.com/?window=5h", "http://[::1]:4000/summary"] { assert!(endpoint(url).is_ok(), "{url}"); }
        for request in [json!({"op":"start","connection":"x","operation":"summary","credential":"opaque","url":"https://evil.example"}), json!({"op":"start","connection":"x","operation":"summary","credential":"opaque","headers":{"Authorization":SECRET}})] { assert!(serde_json::from_value::<Request>(request).is_err()); }
        let mut unknown = manifest.clone(); unknown["contributes"]["connections"][0]["authentication"] = json!("custom-signing");
        assert_eq!(adapters::plan(&unknown, None, "sample.fake-service/api", "summary").unwrap_err(), "UnsupportedCapability");
        let mut unknown = manifest.clone(); unknown["contributes"]["connections"][0]["authentication"] = json!("none");
        assert_eq!(supported(&adapters::plan(&unknown, None, "sample.fake-service/api", "summary").unwrap()), Err("UnsupportedCapability"), "a host credential needs an authentication that carries one");
        let mut bad = manifest.clone(); bad["contributes"]["connections"][0]["operations"][0]["url"] = json!("http://example.com/");
        assert_eq!(super::super::contracts::validate_contract("packages", &json!([bad]))["error"]["code"], "PermissionDenied");
        let mut bad = manifest; bad["contributes"]["connections"][0]["command"] = json!("sample.fake-service/missing");
        assert_eq!(super::super::contracts::validate_contract("packages", &json!([bad]))["error"]["code"], "PermissionDenied");
    }
    #[test]
    fn credentials_and_terminal_results_are_owned_and_revocation_is_irreversible() {
        let mut state = Registry::default(); let a = scope("A"); let b = scope("B"); let revoked = flag();
        crate::secret_store::set(SERVICE, "test-t37-opaque", SECRET).unwrap();
        state.grants.insert(a.clone(), Grant { credential: "test-t37-opaque".into(), revoked: revoked.clone() });
        state.grants.insert(b.clone(), Grant { credential: "test-t37-other".into(), revoked: flag() });
        state.pending.insert("opaque".into(), Pending { scope: a.clone(), cancel: flag(), revoked: revoked.clone(), result: None });
        assert_ne!(a, b);
        for field in ["owner", "version", "digest", "project", "connection", "operation"] {
            let mut forged = a.clone();
            match field { "owner" => forged.owner = "other.extension".into(), "version" => forged.version = "2.0.0".into(), "digest" => forged.digest = "changed".into(), "project" => forged.project = "B".into(), "connection" => forged.connection = "other.extension/api".into(), _ => forged.operation = "other".into() }
            assert!(state.owned(&forged, "opaque").is_err());
        }
        assert!(state.owned(&b, "opaque").is_err()); assert!(state.owned(&a, "forged").is_err());
        assert!(!status(state.grants.get(&a)).to_string().contains(SECRET));
        state.stop(Some("other.extension"), None); assert!(!revoked.load(Ordering::Acquire));
        state.stop(None, Some("A")); assert!(revoked.load(Ordering::Acquire)); assert!(state.grants.contains_key(&b)); assert!(crate::secret_store::get(SERVICE, "test-t37-opaque").is_none());
        state.settle("opaque", Ok(json!({"accepted":true,"count":1})));
        let dto = dto("opaque", &state.pending["opaque"]); assert_eq!(dto["error"], "PermissionDenied"); assert!(dto["response"].is_null()); assert!(!dto.to_string().contains(SECRET));
        for _ in 0..30 { state.admit().unwrap(); } assert_eq!(state.admit(), Err("LimitExceeded"));
    }
    #[tokio::test]
    async fn native_http_attaches_credential_but_projects_only_safe_summary_without_echo_headers_or_logs() {
        let body = json!({"accepted":true,"count":3,"token":SECRET,"error":SECRET}).to_string();
        let (url, task, _) = server(response(&body), false).await;
        let result = transport(url, SECRET.into(), Duration::from_secs(1), flag(), flag()).await.unwrap();
        let request = task.await.unwrap(); assert!(request.contains(&format!("Bearer {SECRET}")));
        assert_eq!(result, json!({"schemaVersion":1,"accepted":true,"count":3})); assert!(!result.to_string().contains(SECRET));
        assert!(sanitize(br#"{"accepted":true,"count":3}"#, "true").is_err());
        assert_eq!(sanitize(SECRET.as_bytes(), SECRET).unwrap_err(), "InvalidShape");
    }
    #[tokio::test]
    async fn native_http_redirect_error_chunked_and_content_length_limits_are_static_and_secret_free() {
        let redirect = format!("HTTP/1.1 302 Found\r\nLocation: https://evil.example/{SECRET}\r\nContent-Length: 0\r\n\r\n");
        let error = format!("HTTP/1.1 401 Unauthorized\r\nX-Secret: {SECRET}\r\nContent-Length: {}\r\n\r\n{SECRET}", SECRET.len());
        let oversized = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", RESPONSE_BYTES + 1);
        let large = "x".repeat(RESPONSE_BYTES + 1);
        let chunked = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{large}\r\n0\r\n\r\n", large.len());
        for (response, expected) in [(redirect, "PermissionDenied"), (error, "HostUnavailable"), (oversized, "LimitExceeded"), (chunked, "LimitExceeded")] {
            let (url, task, _) = server(response.into_bytes(), false).await;
            let error = transport(url, SECRET.into(), Duration::from_secs(1), flag(), flag()).await.unwrap_err();
            task.await.unwrap(); assert_eq!(error, expected); assert!(!context::failure(error).to_string().contains(SECRET));
        }
    }
    #[tokio::test]
    async fn native_http_timeout_cancellation_and_mid_request_revocation_drop_transport_and_suppress_output() {
        for expected in ["Timeout", "Cancelled", "PermissionDenied"] {
            let (url, task, received) = server(response(r#"{"accepted":true,"count":3}"#), true).await;
            let cancel = flag(); let revoked = flag(); let signal_cancel = cancel.clone(); let signal_revoke = revoked.clone();
            let signal = async move {
                received.notified().await;
                if expected == "Cancelled" { signal_cancel.store(true, Ordering::Release); }
                if expected == "PermissionDenied" { signal_revoke.store(true, Ordering::Release); }
            };
            let (result, ()) = tokio::join!(transport(url, SECRET.into(), Duration::from_millis(100), cancel, revoked), signal);
            task.abort(); let _ = task.await;
            assert_eq!(result.unwrap_err(), expected);
        }
    }
}
