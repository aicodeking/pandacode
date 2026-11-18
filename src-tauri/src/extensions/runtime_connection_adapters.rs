//! Declared connection requests and the JSON adapter (`connections.request`, runtime slice R0804).
//!
//! A trusted package declares a connection in its manifest: an address, a method, fixed headers, a way to attach a
//! credential (`bearer`, `header`, `query` or `none`) and an adapter (`json-summary`, or `json`, which hands the parsed
//! answer back). The package asks for it by name (`connections.status/start/poll/cancel`); the host builds the HTTP
//! request, attaches the credential, runs it and returns the answer. The package never names an address, a header or a
//! credential, and the credential is never returned (ADR-0006).
//!
//! Rules (docs/extensions/runtime-connection-adapters.md):
//! - Service only on the duplex channel. Every call is rechecked natively against the `connections.request` grant
//!   (`RuntimeGrants::begin`); revoke, narrowing, untrust, disable, a stale version and safe mode answer
//!   `PermissionDenied`, and a request in flight when the grant goes away ends as `PermissionDenied` without output.
//! - The address is the one the user saw at install. https, or http on a numeric loopback address (a fake service of a
//!   test, a local daemon); a query is part of the declared address. No user information, no fragment, no redirect
//!   following: the grant names the credential and the place it is sent together, so a redirect would send it elsewhere.
//! - `start` takes `body` (only for an operation that declares `"body": "json"`, at most 256 KiB) and `query` (at most 16
//!   pairs). A package secret named by the manifest is attached by the host; a held credential needs the `credentials.use`
//!   grant for that item (R0805): the host attaches it from its own store, writes the use (item, address, package) to the
//!   package's activity list and never returns the value.
//! - Bounded outcomes: `InvalidShape` (not JSON, a field the contract does not know), `LimitExceeded` (answer over
//!   `maxResponseBytes`, a body or query over its limit, too many requests), `Timeout`, `Cancelled`, `PermissionDenied`,
//!   `UnsupportedCapability` (an authentication, adapter or method this build does not run), `NotFound` (a credential
//!   PandaCode does not hold) and `HostUnavailable` (the transport failed). No remote text, header or transport
//!   diagnostic ever crosses; a credential found in a JSON answer is replaced by `[redacted]`.
use super::{runtime_grants::{RuntimeGrants, Target}, runtime_service_lifetime::runtime_held_credentials::{self as held_credentials, HeldUse}, runtime_private_secrets::PrivateSecrets};
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};

type Result<T> = std::result::Result<T, &'static str>;

/// The permission a package must hold.
pub const PERMISSION: &str = "connections.request";
/// Default and largest answer of the `json` adapter.
pub const DEFAULT_RESPONSE: usize = 256 * 1024;
pub const MAX_RESPONSE: usize = 1024 * 1024;
/// The `json-summary` adapter's answer limit (unchanged since the first connection slice).
pub const SUMMARY_RESPONSE: usize = 32 * 1024;
pub const MAX_BODY: usize = 256 * 1024;
pub const MAX_PAIRS: usize = 16;
const MAX_RUNNING: usize = 8;
const MAX_STORED: usize = 64;
const CODES: [&str; 14] = ["PermissionDenied", "UnsupportedCapability", "InvalidShape", "InvalidArguments", "LimitExceeded", "Timeout", "Cancelled", "NotFound", "HostUnavailable", "Conflict", "StaleContext", "UnsupportedRuntime", "InvalidId", "DuplicateId"];
const RESERVED: [&str; 14] = ["host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer", "expect", "proxy-authorization", "proxy-connection", "keep-alive", "cookie", "authorization", "content-type"];

/// An error text from the grants store, as one of the static codes (anything unknown is a refusal).
fn code(text: impl AsRef<str>) -> &'static str { CODES.iter().find(|known| **known == text.as_ref()).copied().unwrap_or("PermissionDenied") }

/// Who is calling. Only a background service uses the duplex channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller { Service, Panel }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Auth { None, Bearer, Header(String), Query(String) }
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source { Host, Secret(String), Held(String) }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Adapter { Summary, Json }

/// A declared operation, read from the manifest of the package that was granted.
#[derive(Clone, Debug)]
pub struct Plan {
    pub method: reqwest::Method,
    pub url: reqwest::Url,
    pub headers: Vec<(String, String)>,
    pub body_allowed: bool,
    pub auth: Auth,
    pub source: Source,
    pub adapter: Adapter,
    pub max_bytes: usize,
    pub timeout: Duration,
}
/// The request to send, without the credential.
#[derive(Clone, Debug)]
pub struct Prepared { pub method: reqwest::Method, pub url: reqwest::Url, pub headers: Vec<(String, String)>, pub body: Option<Vec<u8>> }

fn token(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
}
fn plain(text: &str) -> bool { text.len() <= 1024 && !text.chars().any(char::is_control) }
fn reserved(name: &str) -> bool { RESERVED.contains(&name.to_ascii_lowercase().as_str()) }

/// The address rules (G26): https, or http on a numeric loopback address; no user information, no fragment, a query
/// allowed. The older rule that refused a query, and `127.0.0.1` as the only loopback, had no recorded reason.
pub fn address(raw: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(raw).map_err(|_| "PermissionDenied")?;
    let host = url.host_str().unwrap_or("").trim_start_matches('[').trim_end_matches(']');
    let loopback = host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    if !(url.scheme() == "https" || url.scheme() == "http" && loopback) || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() { return Err("PermissionDenied"); }
    Ok(url)
}

/// Reads one declared operation. `command` is given by the activation flow that binds a connection to a command.
pub fn plan(manifest: &Value, command: Option<&Value>, connection: &str, operation: &str) -> Result<Plan> {
    if !manifest["permissions"].as_array().is_some_and(|values| values.iter().any(|value| value == PERMISSION)) { return Err("PermissionDenied"); }
    let descriptor = manifest["contributes"]["connections"].as_array().and_then(|items| items.iter().find(|item| item["id"] == connection && command.is_none_or(|command| &item["command"] == command))).ok_or("PermissionDenied")?;
    let declared = descriptor["operations"].as_array().and_then(|items| items.iter().find(|item| item["id"] == operation)).ok_or("PermissionDenied")?;
    let method = match declared["method"].as_str() { Some("GET") => reqwest::Method::GET, Some("POST") => reqwest::Method::POST, Some("PUT") => reqwest::Method::PUT, Some("PATCH") => reqwest::Method::PATCH, Some("DELETE") => reqwest::Method::DELETE, _ => return Err("UnsupportedCapability") };
    let auth = match descriptor["authentication"].as_str() {
        Some("bearer") => Auth::Bearer,
        Some("none") => Auth::None,
        Some("header") => Auth::Header(descriptor["headerName"].as_str().filter(|name| token(name) && !reserved(name)).ok_or("InvalidShape")?.to_owned()),
        Some("query") => Auth::Query(descriptor["queryName"].as_str().filter(|name| query_name(name)).ok_or("InvalidShape")?.to_owned()),
        _ => return Err("UnsupportedCapability"),
    };
    let adapter = match descriptor["adapter"].as_str() { Some("json-summary") => Adapter::Summary, Some("json") => Adapter::Json, _ => return Err("UnsupportedCapability") };
    let source = match descriptor.get("credential") {
        None | Some(Value::Null) => Source::Host,
        Some(Value::Object(map)) => match map.get("source").and_then(Value::as_str) {
            Some("host") if map.len() == 1 => Source::Host,
            Some("secret") if map.len() == 2 => Source::Secret(map.get("key").and_then(Value::as_str).filter(|key| !key.is_empty() && key.len() <= 64).ok_or("InvalidShape")?.to_owned()),
            Some("held") if map.len() == 2 => Source::Held(map.get("id").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 128 && plain(id)).ok_or("InvalidShape")?.to_owned()),
            _ => return Err("InvalidShape"),
        },
        _ => return Err("InvalidShape"),
    };
    let max_bytes = match adapter {
        Adapter::Summary => SUMMARY_RESPONSE,
        Adapter::Json => match descriptor.get("maxResponseBytes") { None => DEFAULT_RESPONSE, Some(value) => value.as_u64().filter(|bytes| (1..=MAX_RESPONSE as u64).contains(bytes)).ok_or("InvalidShape")? as usize },
    };
    let timeout = descriptor["timeoutMs"].as_u64().filter(|ms| (100..=30000).contains(ms)).ok_or("InvalidShape")?;
    let mut headers = Vec::new();
    if let Some(map) = declared.get("headers") {
        let map = map.as_object().filter(|map| map.len() <= MAX_PAIRS).ok_or("InvalidShape")?;
        for (name, value) in map {
            let value = value.as_str().filter(|value| plain(value)).ok_or("InvalidShape")?;
            if !token(name) || reserved(name) || matches!(&auth, Auth::Header(header) if header.eq_ignore_ascii_case(name)) { return Err("InvalidShape"); }
            headers.push((name.clone(), value.to_owned()));
        }
    }
    let body_allowed = match declared.get("body") { None => false, Some(value) if value == "json" => method != reqwest::Method::GET, _ => return Err("InvalidShape") };
    Ok(Plan { method, url: address(declared["url"].as_str().ok_or("InvalidShape")?)?, headers, body_allowed, auth, source, adapter, max_bytes, timeout: Duration::from_millis(timeout) })
}

fn query_name(name: &str) -> bool { (1..=64).contains(&name.len()) && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.~-".contains(&byte)) }

/// Checks what the package supplied with `start` against the declaration and builds the request without a credential.
pub fn prepare(plan: &Plan, body: Option<&Value>, query: Option<&Value>) -> Result<Prepared> {
    let body = match body { None | Some(Value::Null) => None, Some(_) if !plan.body_allowed => return Err("InvalidShape"), Some(value) => {
        let bytes = serde_json::to_vec(value).map_err(|_| "InvalidShape")?;
        if bytes.len() > MAX_BODY { return Err("LimitExceeded"); }
        Some(bytes)
    } };
    let mut url = plan.url.clone();
    if let Some(query) = query.filter(|query| !query.is_null()) {
        let pairs = query.as_object().ok_or("InvalidShape")?;
        if pairs.len() > MAX_PAIRS { return Err("LimitExceeded"); }
        let mut seen = Vec::new();
        for (name, value) in pairs {
            let value = value.as_str().filter(|value| plain(value)).ok_or("InvalidShape")?;
            if !query_name(name) || matches!(&plan.auth, Auth::Query(auth) if auth == name) { return Err("InvalidShape"); }
            seen.push((name.as_str(), value));
        }
        if !seen.is_empty() { let mut writer = url.query_pairs_mut(); for (name, value) in seen { writer.append_pair(name, value); } }
    }
    Ok(Prepared { method: plan.method.clone(), url, headers: plan.headers.clone(), body })
}

fn redact(value: &mut Value, secret: &str) {
    match value {
        Value::String(text) => if text.contains(secret) { *text = text.replace(secret, "[redacted]"); },
        Value::Array(items) => items.iter_mut().for_each(|item| redact(item, secret)),
        Value::Object(map) => {
            let mut next = Map::new();
            for (name, mut item) in std::mem::take(map) { redact(&mut item, secret); next.insert(if name.contains(secret) { name.replace(secret, "[redacted]") } else { name }, item); }
            *map = next;
        }
        _ => {}
    }
}

/// Only the adapter's projection crosses. `json-summary` is the original boolean and count; `json` is the parsed answer.
pub(super) fn project(adapter: Adapter, status: u16, bytes: &[u8], secret: Option<&str>) -> Result<Value> {
    let secret = secret.filter(|secret| !secret.is_empty());
    match adapter {
        Adapter::Summary => {
            let body: Value = serde_json::from_slice(bytes).map_err(|_| "InvalidShape")?;
            let accepted = body["accepted"].as_bool().ok_or("InvalidShape")?;
            let count = body["count"].as_u64().filter(|count| *count <= 1_000_000).ok_or("InvalidShape")?;
            let value = json!({"schemaVersion":1,"accepted":accepted,"count":count});
            if secret.is_some_and(|secret| value.to_string().contains(secret)) { return Err("PermissionDenied"); }
            Ok(value)
        }
        Adapter::Json => {
            let mut body: Value = if bytes.iter().all(u8::is_ascii_whitespace) { Value::Null } else { serde_json::from_slice(bytes).map_err(|_| "InvalidShape")? };
            if let Some(secret) = secret { redact(&mut body, secret); }
            Ok(json!({"schemaVersion":1,"status":status,"body":body}))
        }
    }
}

/// Runs one prepared request. `stopped` is the authority behind it (grant revoked, package stopped): it ends the
/// request as `PermissionDenied` before, during and after the answer, so no stale output survives it.
pub(super) async fn execute(plan: &Plan, prepared: Prepared, secret: Option<String>, cancel: Arc<AtomicBool>, stopped: Arc<dyn Fn() -> bool + Send + Sync>) -> Result<Value> {
    let (adapter, limit, timeout) = (plan.adapter, plan.max_bytes, plan.timeout);
    let auth = plan.auth.clone();
    let work = async {
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().build().map_err(|_| "HostUnavailable")?;
        let mut url = prepared.url.clone();
        if let (Auth::Query(name), Some(secret)) = (&auth, secret.as_deref()) { url.query_pairs_mut().append_pair(name, secret); }
        let mut request = client.request(prepared.method.clone(), url).header(reqwest::header::ACCEPT, "application/json");
        for (name, value) in &prepared.headers { request = request.header(name.as_str(), value.as_str()); }
        match (&auth, secret.as_deref()) {
            (Auth::Bearer, Some(secret)) => request = request.bearer_auth(secret),
            (Auth::Header(name), Some(secret)) => { let mut value = reqwest::header::HeaderValue::from_str(secret).map_err(|_| "InvalidShape")?; value.set_sensitive(true); request = request.header(name.as_str(), value); }
            _ => {}
        }
        if let Some(body) = prepared.body { request = request.header(reqwest::header::CONTENT_TYPE, "application/json").body(body); }
        let mut response = request.send().await.map_err(|_| "HostUnavailable")?;
        let status = response.status();
        if status.is_redirection() { return Err("PermissionDenied"); }
        if response.content_length().is_some_and(|size| size > limit as u64) { return Err("LimitExceeded"); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "HostUnavailable")? { if bytes.len() + chunk.len() > limit { return Err("LimitExceeded"); } bytes.extend_from_slice(&chunk); }
        // An error status of the json adapter still carries the answer the service asked for when it is JSON.
        if !status.is_success() && (adapter == Adapter::Summary || serde_json::from_slice::<Value>(&bytes).is_err()) { return Err("HostUnavailable"); }
        project(adapter, status.as_u16(), &bytes, secret.as_deref())
    };
    tokio::pin!(work);
    let deadline = tokio::time::sleep(timeout); tokio::pin!(deadline);
    loop {
        if stopped() { return Err("PermissionDenied"); }
        if cancel.load(Ordering::Acquire) { return Err("Cancelled"); }
        tokio::select! { biased;
            _ = &mut deadline => return Err("Timeout"),
            result = &mut work => {
                if stopped() { return Err("PermissionDenied"); }
                if cancel.load(Ordering::Acquire) { return Err("Cancelled"); }
                return result;
            },
            _ = tokio::time::sleep(Duration::from_millis(10)) => {},
        }
    }
}

struct Pending { owner: String, version: String, cancel: Arc<AtomicBool>, result: Option<Result<Value>> }
#[derive(Default)]
struct Registry { pending: BTreeMap<String, Pending>, order: Vec<String> }
impl Registry {
    fn dto(&self, id: &str) -> Value {
        let pending = &self.pending[id];
        let (state, value, error) = match &pending.result { None => ("running", Value::Null, None), Some(Ok(value)) => ("completed", value.clone(), None), Some(Err(code)) => ("failed", Value::Null, Some(*code)) };
        json!({"schemaVersion":1,"request":id,"state":state,"response":value,"error":error})
    }
    fn owned(&mut self, owner: &str, version: &str, id: &str) -> Result<&mut Pending> { self.pending.get_mut(id).filter(|pending| pending.owner == owner && pending.version == version).ok_or("PermissionDenied") }
    fn settle(&mut self, id: &str, result: Result<Value>) {
        if let Some(pending) = self.pending.get_mut(id) {
            if pending.result.is_none() { pending.result = Some(if pending.cancel.load(Ordering::Acquire) { Err("Cancelled") } else { result }); }
        }
    }
    fn make_room(&mut self, owner: &str) -> Result<()> {
        if self.pending.values().filter(|pending| pending.owner == owner && pending.result.is_none()).count() >= MAX_RUNNING { return Err("Conflict"); }
        if self.pending.len() >= MAX_STORED {
            let old = self.order.iter().find(|id| self.pending.get(*id).is_some_and(|pending| pending.result.is_some())).cloned().ok_or("LimitExceeded")?;
            self.pending.remove(&old); self.order.retain(|id| id != &old);
        }
        Ok(())
    }
}

/// Native owner of the requests started through the duplex channel. Managed as Tauri state.
#[derive(Default)]
pub struct ConnectionAdapters(Arc<Mutex<Registry>>, Option<Arc<HeldUse>>);

/// The app's one registry of started requests, with the host's own credential stores behind `source: "held"`.
pub fn shared() -> &'static ConnectionAdapters {
    static SHARED: std::sync::OnceLock<ConnectionAdapters> = std::sync::OnceLock::new();
    SHARED.get_or_init(|| ConnectionAdapters::with_held(held_credentials::shared()))
}

/// The duplex channel's entry (`runtime_service_lifetime::app_dispatch`): resolves the caller's installed package and,
/// when the request was made from a command invocation, the project that invocation captured. Answers the broker
/// envelope `{ok, value|error}`. Nothing here is chosen by the package.
pub fn serve(app: &tauri::AppHandle, owner: &str, handle: Option<&str>, method: &str, params: &Value) -> Value {
    use tauri::Manager;
    let result = (|| {
        let packages = app.state::<super::packages::ExtensionPackages>(); let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
        let snapshot = packages.snapshot();
        let manifest = snapshot.packages.iter().find(|package| package.manifest["id"] == owner).map(|package| package.manifest.clone()).ok_or("PermissionDenied")?;
        let version = manifest["version"].as_str().ok_or("PermissionDenied")?.to_owned();
        let project = match handle {
            None => None,
            Some(handle) => { let (bound, _, captured) = app.state::<super::context::ContextBroker>().local_binding(app, &snapshot, handle)?; if bound != owner { return Err("PermissionDenied"); } captured["projectId"].as_str().map(str::to_owned) }
        };
        drop(packages);
        shared().handle(&app.state::<RuntimeGrants>(), &app.state::<PrivateSecrets>(), owner, &version, Caller::Service, &manifest, project.as_deref(), method, params)
    })();
    match result { Ok(value) => json!({"ok":true,"value":value}), Err(code) => super::context::failure(code) }
}

/// The request object, with exactly the allowed fields.
fn fields<'a>(params: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>> {
    let map = params.as_object().ok_or("InvalidShape")?;
    if map.keys().any(|name| !allowed.contains(&name.as_str())) { return Err("InvalidShape"); }
    Ok(map)
}
fn text<'a>(map: &'a Map<String, Value>, name: &str) -> Result<&'a str> { map.get(name).and_then(Value::as_str).filter(|value| !value.is_empty() && value.len() <= 256).ok_or("InvalidShape") }

impl ConnectionAdapters {
    /// A registry that can attach held credentials (`credentials.use`): the stores and the activity list it is given.
    /// Without one, a held source is a credential PandaCode does not hold (`NotFound`).
    pub fn with_held(held: Arc<HeldUse>) -> Self { Self(Arc::default(), Some(held)) }

    /// The one entry of the dispatcher. `id` and `version` are the caller's identity, and `manifest` the manifest of
    /// that same installed package; none of them is read from `params`. `project` is the project captured by the
    /// command invocation the request was made from, when there is one.
    #[allow(clippy::too_many_arguments)]
    pub fn handle(&self, grants: &RuntimeGrants, secrets: &PrivateSecrets, id: &str, version: &str, caller: Caller, manifest: &Value, project: Option<&str>, method: &str, params: &Value) -> Result<Value> {
        let operation = match method { "connections.status" | "connections.start" | "connections.poll" | "connections.cancel" => method, _ => return Err("UnsupportedCapability") };
        if caller != Caller::Service { return Err("UnsupportedCapability"); }
        let target = project.map(Target::project).unwrap_or_default();
        let work = grants.begin(id, version, PERMISSION, &target).map_err(code)?;
        match operation {
            "connections.poll" | "connections.cancel" => {
                let map = fields(params, &["connection", "operation", "request"])?;
                let request = text(map, "request")?;
                let mut registry = self.0.lock().map_err(|_| "HostUnavailable")?;
                let pending = registry.owned(id, version, request)?;
                // A cancel is recognized before a late completion.
                if operation == "connections.cancel" && pending.result.is_none() { pending.cancel.store(true, Ordering::Release); pending.result = Some(Err("Cancelled")); }
                if work.is_cancelled() { return Err("PermissionDenied"); }
                Ok(registry.dto(request))
            }
            _ => {
                let map = fields(params, if operation == "connections.start" { &["connection", "operation", "credential", "body", "query"][..] } else { &["connection", "operation"][..] })?;
                let planned = plan(manifest, None, text(map, "connection")?, text(map, "operation")?)?;
                // A held credential needs the grant for that item, registered as work so a revoke or narrowing ends the request.
                let held_item = match (&planned.source, &planned.auth) { (Source::Held(item), auth) if *auth != Auth::None => Some(item.clone()), _ => None };
                let held_work = match &held_item { Some(item) => Some(grants.begin(id, version, held_credentials::PERMISSION, &Target::item(item)).map_err(code)?), None => None };
                // The credential comes from the host side only: a package secret it owns, or a credential PandaCode holds.
                let mut secret = match (&planned.auth, &planned.source) {
                    (Auth::None, _) => None,
                    (_, Source::Secret(key)) => Some(secrets.attach(id, key).ok_or("NotFound")?),
                    (_, Source::Host) | (_, Source::Held(_)) => None,
                };
                if operation == "connections.status" {
                    let held_here = held_item.as_ref().is_some_and(|item| self.1.as_ref().is_some_and(|held| held.has(item)));
                    let connected = matches!(planned.auth, Auth::None) || secret.is_some() || held_here;
                    return Ok(json!({"schemaVersion":1,"state":if connected {"connected"} else {"disconnected"},"credential":Value::Null}));
                }
                // Start options per credential source: a host handle only for `host`; never for the others.
                let handle = map.get("credential");
                match (&planned.auth, &planned.source, handle) {
                    (Auth::None, _, None) | (_, Source::Secret(_), None) | (_, Source::Held(_), None) | (_, Source::Host, Some(Value::String(_))) => {}
                    _ => return Err("InvalidShape"),
                }
                let prepared = prepare(&planned, map.get("body"), map.get("query"))?;
                // The use is written to the package's activity list (item, address, package; never the value) before the value leaves the store.
                if let Some(item) = &held_item {
                    let held = self.1.as_ref().ok_or("NotFound")?;
                    secret = Some(held.use_credential(id, version, item, &held_credentials::address_of(&planned.url))?);
                }
                if matches!((&planned.auth, &planned.source), (Auth::Bearer | Auth::Header(_) | Auth::Query(_), Source::Host)) { return Err("NotFound"); }
                let request_id = uuid::Uuid::new_v4().to_string();
                let cancel = Arc::new(AtomicBool::new(false));
                {
                    let mut registry = self.0.lock().map_err(|_| "HostUnavailable")?;
                    registry.make_room(id)?;
                    registry.pending.insert(request_id.clone(), Pending { owner: id.to_owned(), version: version.to_owned(), cancel: cancel.clone(), result: None });
                    registry.order.push(request_id.clone());
                }
                let registry = self.0.clone(); let finished = request_id.clone();
                let stopped: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || work.is_cancelled() || held_work.as_ref().is_some_and(|held| held.is_cancelled()));
                tauri::async_runtime::spawn(async move {
                    let result = execute(&planned, prepared, secret, cancel, stopped).await;
                    if let Ok(mut registry) = registry.lock() { registry.settle(&finished, result); }
                });
                Ok(self.0.lock().map_err(|_| "HostUnavailable")?.dto(&request_id))
            }
        }
    }

    /// Forgets the requests of a package (uninstall, disable, untrust). A running one is cancelled.
    pub fn forget(&self, owner: &str) {
        if let Ok(mut registry) = self.0.lock() {
            for pending in registry.pending.values().filter(|pending| pending.owner == owner) { pending.cancel.store(true, Ordering::Release); }
            registry.pending.retain(|_, pending| pending.owner != owner);
            let Registry { pending, order } = &mut *registry; order.retain(|id| pending.contains_key(id));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::runtime_grants::Scope;
    use std::{io::{BufRead, BufReader}, time::Instant};
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};

    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-connection-adapters/extension.json");
    const SOURCE: &str = include_str!("../../../tests/fixtures/extensions/runtime-connection-adapters/main.cjs");
    const A: &str = "sample.connection-adapters";
    const B: &str = "sample.other-package";
    /// Built from parts so this file never holds a realistic token; the tests look for it in every output.
    fn canary() -> String { ["canary", "credential", "r0804"].join("-") }
    struct Dir(std::path::PathBuf);
    impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-connection-adapters-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    #[derive(Clone, Debug)]
    struct Seen { method: String, target: String, headers: Vec<(String, String)>, body: String }
    impl Seen { fn header(&self, name: &str) -> Option<&str> { self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str()) } }
    /// A loopback API that records the requests it receives and answers by path.
    struct Api { port: u16, seen: Arc<Mutex<Vec<Seen>>>, task: tokio::task::JoinHandle<()> }
    impl Drop for Api { fn drop(&mut self) { self.task.abort(); } }
    impl Api {
        async fn start() -> Self {
            let _ = rustls::crypto::ring::default_provider().install_default();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let seen: Arc<Mutex<Vec<Seen>>> = Arc::default(); let record = seen.clone();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else { return };
                    let record = record.clone();
                    tokio::spawn(async move {
                        let mut bytes = Vec::new(); let mut chunk = [0u8; 4096];
                        let (head, mut body) = loop {
                            let count = socket.read(&mut chunk).await.unwrap_or(0);
                            if count == 0 { return; }
                            bytes.extend_from_slice(&chunk[..count]);
                            if let Some(at) = bytes.windows(4).position(|window| window == b"\r\n\r\n") { break (String::from_utf8_lossy(&bytes[..at]).to_string(), bytes[at + 4..].to_vec()); }
                        };
                        let mut lines = head.lines(); let first = lines.next().unwrap_or("").to_owned();
                        let headers: Vec<(String, String)> = lines.filter_map(|line| line.split_once(':').map(|(name, value)| (name.trim().to_owned(), value.trim().to_owned()))).collect();
                        let length = headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("content-length")).and_then(|(_, value)| value.parse::<usize>().ok()).unwrap_or(0);
                        while body.len() < length { let count = socket.read(&mut chunk).await.unwrap_or(0); if count == 0 { break; } body.extend_from_slice(&chunk[..count]); }
                        let mut parts = first.split(' '); let method = parts.next().unwrap_or("").to_owned(); let target = parts.next().unwrap_or("").to_owned();
                        let seen = Seen { method, target: target.clone(), headers, body: String::from_utf8_lossy(&body).to_string() };
                        let path = target.split('?').next().unwrap_or("").to_owned();
                        record.lock().unwrap().push(seen.clone());
                        let json = |status: &str, body: String| format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                        let reply = match path.as_str() {
                            "/usage" | "/report" | "/open" | "/query" | "/mirror" => {
                                let credential = seen.header("authorization").or(seen.header("x-api-key")).unwrap_or("");
                                json("200 OK", format!(r#"{{"ok":true,"method":{},"target":{},"echo":{},"credential":{}}}"#, serde_json::to_string(&seen.method).unwrap(), serde_json::to_string(&seen.target).unwrap(), if seen.body.is_empty() { "null".into() } else { seen.body.clone() }, serde_json::to_string(&if path == "/mirror" { credential } else { "" }).unwrap()))
                            }
                            "/summary" => json("200 OK", r#"{"accepted":true,"count":3,"extra":"ignored"}"#.into()),
                            "/text" => "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nnot json :(".to_string(),
                            "/missing" => json("404 Not Found", r#"{"error":"no such thing"}"#.into()),
                            "/large" => { let big = format!(r#"{{"blob":"{}"}}"#, "x".repeat(4096)); json("200 OK", big) }
                            "/chunked" => { let big = "y".repeat(5000); format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{big}\r\n0\r\n\r\n", big.len()) }
                            "/redirect" => "HTTP/1.1 302 Found\r\nLocation: https://elsewhere.example/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned(),
                            "/wait" => { tokio::time::sleep(Duration::from_secs(3)).await; json("200 OK", r#"{"late":true}"#.into()) }
                            _ => json("200 OK", "{}".into()),
                        };
                        let _ = socket.write_all(reply.as_bytes()).await; let _ = socket.shutdown().await;
                    });
                }
            });
            Self { port, seen, task }
        }
        fn requests(&self) -> Vec<Seen> { self.seen.lock().unwrap().clone() }
    }
    fn manifest(port: u16) -> Value { serde_json::from_str(&MANIFEST.replace("127.0.0.1:9", &format!("127.0.0.1:{port}"))).unwrap() }
    fn with(manifest: &mut Value, connection: &str, change: impl FnOnce(&mut Value)) {
        let items = manifest["contributes"]["connections"].as_array_mut().unwrap();
        change(items.iter_mut().find(|item| item["id"] == connection).unwrap());
    }

    /// A variant of the `open` connection that the schema would refuse to install, to prove the runtime refuses it too.
    fn add(manifest: &mut Value, name: &str, change: impl FnOnce(&mut Value)) {
        let items = manifest["contributes"]["connections"].as_array_mut().unwrap();
        let mut item = items.iter().find(|item| item["id"] == "sample.connection-adapters/open").unwrap().clone();
        item["id"] = json!(format!("sample.connection-adapters/{name}")); change(&mut item); items.push(item);
    }

    struct Rig { _dir: Dir, grants: RuntimeGrants, secrets: PrivateSecrets, adapters: ConnectionAdapters, manifest: Value }
    fn rig(manifest: Value) -> Rig {
        let dir = Dir::new();
        let grants = RuntimeGrants::open(&dir.0);
        for id in [A, B] {
            grants.register_package(id, "1.0.0", &["runtime.service", PERMISSION, "secrets.private", "credentials.use"], Some("digest")).unwrap();
            grants.trust(id, true).unwrap();
            grants.grant(id, PERMISSION, Scope::default()).unwrap();
        }
        let secrets = PrivateSecrets::open(&dir.0);
        grants.grant(A, "secrets.private", Scope::default()).unwrap();
        grants.grant(A, "credentials.use", Scope::default()).unwrap();
        secrets.handle(&grants, A, "1.0.0", crate::extensions::runtime_private_secrets::Caller::Service, "secrets.set", &json!({"key":"api-key","value":canary()})).unwrap();
        Rig { _dir: dir, grants, secrets, adapters: ConnectionAdapters::default(), manifest }
    }
    impl Rig {
        fn call(&self, id: &str, method: &str, params: Value) -> Result<Value> { self.adapters.handle(&self.grants, &self.secrets, id, "1.0.0", Caller::Service, &self.manifest, None, method, &params) }
        fn start(&self, connection: &str, operation: &str, extra: Value) -> Result<Value> {
            let mut params = json!({"connection":connection,"operation":operation});
            for (name, value) in extra.as_object().unwrap() { params[name] = value.clone(); }
            self.call(A, "connections.start", params)
        }
        async fn finish(&self, started: &Value) -> Value {
            let request = started["request"].as_str().unwrap().to_owned();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let polled = self.call(A, "connections.poll", json!({"connection":"x","operation":"y","request":request})).unwrap();
                if polled["state"] != "running" { return polled; }
                assert!(Instant::now() < deadline, "the request never finished");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
    const USAGE: &str = "sample.connection-adapters/usage";

    #[test]
    fn the_fixture_manifest_is_valid_and_declares_every_authentication_and_the_permission() {
        let manifest = manifest(4000);
        assert_eq!(manifest["id"], A);
        assert_eq!(crate::extensions::contracts::validate_contract("packages", &json!([manifest.clone()]))["ok"], true, "{}", crate::extensions::contracts::validate_contract("packages", &json!([manifest.clone()])));
        assert!(SOURCE.contains("panda.connections.start"));
        let kinds: Vec<_> = manifest["contributes"]["connections"].as_array().unwrap().iter().map(|item| item["authentication"].as_str().unwrap().to_owned()).collect();
        for kind in ["bearer", "header", "query", "none"] { assert!(kinds.iter().any(|item| item == kind), "{kind}"); }
        let first = plan(&manifest, None, USAGE, "get").unwrap();
        assert_eq!((first.method.as_str(), first.auth.clone(), first.adapter, first.max_bytes), ("GET", Auth::Header("x-api-key".into()), Adapter::Json, DEFAULT_RESPONSE));
    }

    #[test]
    fn address_rules_allow_a_query_and_numeric_loopback_and_still_refuse_user_information_fragments_and_plain_http() {
        for url in ["https://api.example.com/v1/usage", "https://api.example.com/v1/usage?window=5h&x=1", "http://127.0.0.1:4000/summary", "http://127.0.0.1:4000/summary?a=b", "http://127.0.0.2:4000/", "http://[::1]:4000/x"] { assert!(address(url).is_ok(), "{url}"); }
        for url in ["http://example.com/", "http://localhost:4000/", "http://127.0.0.1.evil.example/", "file:///etc/passwd", "https://user:pass@example.com/", "https://example.com/#secret", "ftp://example.com/", "not an address"] { assert_eq!(address(url).unwrap_err(), "PermissionDenied", "{url}"); }
    }

    #[tokio::test]
    async fn a_granted_get_and_post_reach_the_loopback_api_with_the_declared_method_headers_query_and_body() {
        let api = Api::start().await; let rig = rig(manifest(api.port));
        // GET, header authentication from a package secret, a declared query, a caller query and a fixed header.
        let started = rig.start(USAGE, "get", json!({"query":{"window":"5h"}})).unwrap();
        assert_eq!(started["state"], "running");
        let done = rig.finish(&started).await;
        assert_eq!(done["state"], "completed", "{done}");
        assert_eq!(done["response"]["status"], 200);
        assert_eq!(done["response"]["body"]["ok"], true);
        assert_eq!(done["response"]["body"]["method"], "GET");
        let seen = api.requests();
        assert_eq!((seen[0].method.as_str(), seen[0].target.as_str()), ("GET", "/usage?unit=percent&window=5h"));
        assert_eq!(seen[0].header("x-api-key"), Some(canary().as_str()));
        assert_eq!(seen[0].header("x-client"), Some("sample"));
        assert!(seen[0].header("authorization").is_none());
        // POST with a JSON body, bearer authentication, the content type set by the host.
        let body = json!({"range":{"from":"2026-01-01"},"tags":["a","b"],"n":3});
        let done = rig.finish(&rig.start("sample.connection-adapters/report", "send", json!({"body":body})).unwrap()).await;
        assert_eq!(done["state"], "completed", "{done}");
        assert_eq!(done["response"]["body"]["echo"], body, "the service sees what the API recorded");
        let seen = api.requests(); let post = seen.last().unwrap();
        assert_eq!((post.method.as_str(), post.target.as_str()), ("POST", "/report"));
        assert_eq!(post.header("authorization"), Some(format!("Bearer {}", canary()).as_str()));
        assert_eq!(post.header("content-type"), Some("application/json"));
        assert_eq!(serde_json::from_str::<Value>(&post.body).unwrap(), body);
        // Query authentication appends the credential to the address.
        let done = rig.finish(&rig.start("sample.connection-adapters/keyed", "get", json!({"query":{"page":"2"}})).unwrap()).await;
        assert_eq!(done["state"], "completed", "{done}");
        assert_eq!(api.requests().last().unwrap().target, format!("/query?page=2&key={}", canary()));
        // No authentication: no credential is sent, and a body-less POST-style operation works.
        let done = rig.finish(&rig.start("sample.connection-adapters/open", "get", json!({})).unwrap()).await;
        assert_eq!(done["state"], "completed", "{done}");
        let last = api.requests().last().unwrap().clone();
        assert!(last.header("authorization").is_none() && last.header("x-api-key").is_none() && !last.target.contains("key="));
        // The other methods are real methods.
        for (op, method) in [("put", "PUT"), ("patch", "PATCH"), ("delete", "DELETE")] {
            let done = rig.finish(&rig.start("sample.connection-adapters/methods", op, json!({"body":{"a":1}})).unwrap()).await;
            assert_eq!(done["state"], "completed", "{op}: {done}");
            assert_eq!(api.requests().last().unwrap().method, method);
        }
        // The credential itself never appears in what the service gets.
        assert!(!done.to_string().contains(&canary()));
    }

    #[tokio::test]
    async fn the_json_summary_adapter_keeps_its_projection_and_status_reports_the_source() {
        let api = Api::start().await; let rig = rig(manifest(api.port));
        let done = rig.finish(&rig.start("sample.connection-adapters/summary", "summary", json!({})).unwrap()).await;
        assert_eq!(done["response"], json!({"schemaVersion":1,"accepted":true,"count":3}));
        assert_eq!(rig.call(A, "connections.status", json!({"connection":USAGE,"operation":"get"})).unwrap(), json!({"schemaVersion":1,"state":"connected","credential":null}));
        assert_eq!(rig.call(A, "connections.status", json!({"connection":"sample.connection-adapters/open","operation":"get"})).unwrap()["state"], "connected");
        // B holds no such package secret: its request cannot be attached and says so.
        let mut other = manifest(api.port); other["id"] = json!(B);
        let borrowed = ConnectionAdapters::default();
        assert_eq!(borrowed.handle(&rig.grants, &rig.secrets, B, "1.0.0", Caller::Service, &other, None, "connections.status", &json!({"connection":USAGE,"operation":"get"})).unwrap_err(), "NotFound");
    }

    #[tokio::test]
    async fn invalid_json_oversized_answers_error_statuses_and_redirects_have_bounded_explicit_outcomes() {
        let api = Api::start().await; let mut declared = manifest(api.port);
        with(&mut declared, "sample.connection-adapters/limits", |item| item["maxResponseBytes"] = json!(1024));
        let rig = rig(declared);
        let outcome = |operation: &'static str| { let rig = &rig; async move { rig.finish(&rig.start("sample.connection-adapters/limits", operation, json!({})).unwrap()).await } };
        let invalid = outcome("text").await; assert_eq!((invalid["state"].as_str(), invalid["error"].as_str(), invalid["response"].is_null()), (Some("failed"), Some("InvalidShape"), true));
        let large = outcome("large").await; assert_eq!(large["error"], "LimitExceeded", "content-length over maxResponseBytes");
        let chunked = outcome("chunked").await; assert_eq!(chunked["error"], "LimitExceeded", "no length, over maxResponseBytes");
        let redirect = outcome("redirect").await; assert_eq!(redirect["error"], "PermissionDenied", "a redirect is never followed, so the credential is never sent elsewhere");
        let missing = outcome("missing").await;
        assert_eq!((missing["state"].as_str(), missing["response"]["status"].as_i64(), missing["response"]["body"]["error"].as_str()), (Some("completed"), Some(404), Some("no such thing")), "an error status that carries JSON reaches the service as its status");
        let summary = rig.finish(&rig.start("sample.connection-adapters/summary", "text", json!({})).unwrap()).await; assert_eq!(summary["error"], "InvalidShape");
        let summary = rig.finish(&rig.start("sample.connection-adapters/summary", "missing", json!({})).unwrap()).await; assert_eq!(summary["error"], "HostUnavailable", "the summary adapter keeps its original outcome");
        assert!(api.requests().iter().all(|seen| seen.header("authorization").is_some() || seen.target != "/redirect"));
    }

    #[tokio::test]
    async fn timeout_and_cancel_end_a_waiting_request_and_the_late_answer_is_dropped() {
        let api = Api::start().await; let rig = rig(manifest(api.port));
        let waited = Instant::now();
        let timed = rig.finish(&rig.start("sample.connection-adapters/slow", "wait", json!({})).unwrap()).await;
        assert_eq!(timed["error"], "Timeout"); assert!(waited.elapsed() < Duration::from_secs(2), "bounded by timeoutMs (500)");
        let started = rig.start("sample.connection-adapters/slow", "wait", json!({})).unwrap();
        let cancelled = rig.call(A, "connections.cancel", json!({"connection":"x","operation":"y","request":started["request"]})).unwrap();
        assert_eq!((cancelled["state"].as_str(), cancelled["error"].as_str()), (Some("failed"), Some("Cancelled")));
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert_eq!(rig.call(A, "connections.poll", json!({"connection":"x","operation":"y","request":started["request"]})).unwrap()["error"], "Cancelled", "a late answer never replaces a cancel");
        // Cancelling something finished returns the finished state; the request id is not guessable by another package.
        let done = rig.finish(&rig.start("sample.connection-adapters/open", "get", json!({})).unwrap()).await;
        assert_eq!(rig.call(A, "connections.cancel", json!({"connection":"x","operation":"y","request":done["request"]})).unwrap()["state"], "completed");
        assert_eq!(rig.call(B, "connections.poll", json!({"connection":"x","operation":"y","request":done["request"]})).unwrap_err(), "PermissionDenied");
        assert_eq!(rig.call(A, "connections.poll", json!({"connection":"x","operation":"y","request":"forged"})).unwrap_err(), "PermissionDenied");
    }

    #[tokio::test]
    async fn unsupported_operations_and_start_options_are_explicit() {
        let api = Api::start().await; let mut declared = manifest(api.port);
        for (name, change) in [("unsupported", ("authentication", json!("custom-signing"))), ("stream", ("adapter", json!("stream")))] { add(&mut declared, name, |item| item[change.0] = change.1); }
        add(&mut declared, "trace", |item| item["operations"][0]["method"] = json!("TRACE"));
        let rig = rig(declared);
        for (connection, operation, expected) in [("sample.connection-adapters/unsupported", "get", "UnsupportedCapability"), ("sample.connection-adapters/stream", "get", "UnsupportedCapability"), ("sample.connection-adapters/trace", "get", "UnsupportedCapability"),
            ("sample.connection-adapters/held", "get", "NotFound"), ("sample.connection-adapters/hosted", "get", "InvalidShape"),("sample.connection-adapters/usage", "undeclared", "PermissionDenied"), ("other.package/usage", "get", "PermissionDenied")] {
            assert_eq!(rig.start(connection, operation, json!({})).unwrap_err(), expected, "{connection} {operation}");
        }
        assert_eq!(rig.start("sample.connection-adapters/hosted", "get", json!({"credential":"opaque"})).unwrap_err(), "NotFound", "a host credential nobody entered is not held");
        assert_eq!(rig.call(A, "connections.connect", json!({})).unwrap_err(), "UnsupportedCapability");
        assert_eq!(rig.call(A, "connections.start", json!({"connection":USAGE,"operation":"get","url":"https://evil.example"})).unwrap_err(), "InvalidShape");
        assert_eq!(rig.call(A, "connections.start", json!({"connection":USAGE,"operation":"get","headers":{"x":"y"}})).unwrap_err(), "InvalidShape");
        assert_eq!(rig.call(A, "connections.start", json!({"connection":USAGE,"operation":"get","credential":"opaque"})).unwrap_err(), "InvalidShape", "a handle only goes with a host credential");
        assert_eq!(rig.start(USAGE, "get", json!({"body":{"a":1}})).unwrap_err(), "InvalidShape", "an operation that does not declare a body takes none");
        assert_eq!(rig.start("sample.connection-adapters/report", "send", json!({"body":{"big":"x".repeat(MAX_BODY)}})).unwrap_err(), "LimitExceeded");
        let many: Map<String, Value> = (0..=MAX_PAIRS).map(|index| (format!("k{index}"), json!("v"))).collect();
        assert_eq!(rig.start(USAGE, "get", json!({"query":many})).unwrap_err(), "LimitExceeded");
        assert_eq!(rig.start(USAGE, "get", json!({"query":{"a":1}})).unwrap_err(), "InvalidShape");
        assert_eq!(rig.start(USAGE, "get", json!({"query":{"bad name":"v"}})).unwrap_err(), "InvalidShape");
        assert_eq!(rig.start("sample.connection-adapters/keyed", "get", json!({"query":{"key":"mine"}})).unwrap_err(), "InvalidShape", "the package cannot set the parameter the credential uses");
        assert_eq!(rig.call(A, "connections.start", json!("nope")).unwrap_err(), "InvalidShape");
        assert!(api.requests().is_empty(), "no refused request reached the network");
        // A panel never uses the channel.
        assert_eq!(rig.adapters.handle(&rig.grants, &rig.secrets, A, "1.0.0", Caller::Panel, &rig.manifest, None, "connections.start", &json!({})).unwrap_err(), "UnsupportedCapability");
        // Manifest declarations that cannot be run safely are refused when read.
        let mut bad = manifest(api.port);
        with(&mut bad, USAGE, |item| { item["operations"][0]["headers"] = json!({"Authorization":"x"}); });
        assert_eq!(plan(&bad, None, USAGE, "get").unwrap_err(), "InvalidShape");
        let mut bad = manifest(api.port);
        with(&mut bad, USAGE, |item| { item["operations"][0]["headers"] = json!({"X-Api-Key":"x"}); });
        assert_eq!(plan(&bad, None, USAGE, "get").unwrap_err(), "InvalidShape", "a fixed header cannot shadow the credential header");
        let mut bad = manifest(api.port);
        with(&mut bad, USAGE, |item| { item["maxResponseBytes"] = json!(MAX_RESPONSE + 1); });
        assert_eq!(plan(&bad, None, USAGE, "get").unwrap_err(), "InvalidShape");
        let mut bad = manifest(api.port); bad["permissions"] = json!(["ui.contribute"]);
        assert_eq!(plan(&bad, None, USAGE, "get").unwrap_err(), "PermissionDenied");
    }

    #[tokio::test]
    async fn the_grant_is_checked_on_every_call_and_a_request_in_flight_loses_its_output_when_it_goes_away() {
        let api = Api::start().await; let rig = rig(manifest(api.port));
        let done = rig.finish(&rig.start("sample.connection-adapters/open", "get", json!({})).unwrap()).await;
        // Revoke: new calls and polls of an old request are refused before anything is shown.
        rig.grants.revoke(A, PERMISSION).unwrap();
        for method in ["connections.start", "connections.status", "connections.poll", "connections.cancel"] {
            assert_eq!(rig.call(A, method, json!({"connection":USAGE,"operation":"get","request":done["request"]})).unwrap_err(), "PermissionDenied", "{method}");
        }
        rig.grants.grant(A, PERMISSION, Scope::default()).unwrap();
        // A request running while the grant is revoked ends as PermissionDenied, whatever the API answers.
        let started = rig.start("sample.connection-adapters/slow", "wait", json!({})).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        rig.grants.revoke(A, PERMISSION).unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        rig.grants.grant(A, PERMISSION, Scope::default()).unwrap();
        let polled = rig.call(A, "connections.poll", json!({"connection":"x","operation":"y","request":started["request"]})).unwrap();
        assert_eq!((polled["state"].as_str(), polled["error"].as_str(), polled["response"].is_null()), (Some("failed"), Some("PermissionDenied"), true));
        // Untrust, archive (disable and safe mode) and a stale version refuse too; grants come back with the user's decision.
        rig.grants.archive(A, true).unwrap();
        assert_eq!(rig.start(USAGE, "get", json!({})).unwrap_err(), "PermissionDenied"); rig.grants.archive(A, false).unwrap();
        rig.grants.trust(A, false).unwrap();
        assert_eq!(rig.start(USAGE, "get", json!({})).unwrap_err(), "PermissionDenied"); rig.grants.trust(A, true).unwrap();
        assert_eq!(rig.adapters.handle(&rig.grants, &rig.secrets, A, "0.9.0", Caller::Service, &rig.manifest, None, "connections.start", &json!({"connection":USAGE,"operation":"get"})).unwrap_err(), "PermissionDenied");
        assert!(rig.start("sample.connection-adapters/open", "get", json!({})).is_ok());
        // A package that was never granted meets PermissionDenied however its manifest reads.
        assert_eq!(rig.adapters.handle(&rig.grants, &rig.secrets, "sample.unknown", "1.0.0", Caller::Service, &rig.manifest, None, "connections.start", &json!({"connection":USAGE,"operation":"get"})).unwrap_err(), "PermissionDenied");
    }

    #[tokio::test]
    async fn a_grant_narrowed_to_projects_follows_the_captured_project_and_forget_clears_a_package() {
        let api = Api::start().await; let rig = rig(manifest(api.port));
        rig.grants.grant(A, PERMISSION, Scope { projects: Some(["project-a".to_owned()].into()), ..Scope::default() }).unwrap();
        let params = json!({"connection":"sample.connection-adapters/open","operation":"get"});
        let call = |project: Option<&str>| rig.adapters.handle(&rig.grants, &rig.secrets, A, "1.0.0", Caller::Service, &rig.manifest, project, "connections.start", &params);
        assert!(call(Some("project-a")).is_ok());
        assert_eq!(call(Some("project-b")).unwrap_err(), "PermissionDenied");
        assert_eq!(call(None).unwrap_err(), "PermissionDenied", "a narrowed grant needs a project");
        rig.adapters.forget(A);
        assert!(rig.adapters.0.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn the_credential_never_appears_in_a_result_a_status_or_an_error_even_when_the_api_echoes_it() {
        let api = Api::start().await; let rig = rig(manifest(api.port));
        let done = rig.finish(&rig.start("sample.connection-adapters/mirror", "get", json!({})).unwrap()).await;
        assert_eq!(done["state"], "completed");
        assert_eq!(done["response"]["body"]["credential"], "Bearer [redacted]", "the API echoed the header and the host replaced the credential");
        assert!(!done.to_string().contains(&canary()));
        assert!(api.requests().last().unwrap().header("authorization").unwrap().contains(&canary()), "it was attached on the wire");
        let status = rig.call(A, "connections.status", json!({"connection":"sample.connection-adapters/mirror","operation":"get"})).unwrap();
        assert!(!status.to_string().contains(&canary()) && status["credential"].is_null());
        let mut errors = vec![];
        for (connection, operation, extra) in [("sample.connection-adapters/limits", "text", json!({})), ("sample.connection-adapters/mirror", "get", json!({"query":{"a":1}})), ("sample.connection-adapters/held", "get", json!({}))] {
            match rig.start(connection, operation, extra) { Ok(started) => errors.push(rig.finish(&started).await.to_string()), Err(error) => errors.push(error.to_owned()) }
        }
        assert!(errors.iter().all(|error| !error.contains(&canary())), "{errors:?}");
        // A summary answer that would carry the credential is refused, not returned.
        assert_eq!(project(Adapter::Summary, 200, br#"{"accepted":true,"count":3}"#, Some("true")).unwrap_err(), "PermissionDenied");
        let mut value = json!({"a":[canary()],"b":{canary():canary()}});
        redact(&mut value, &canary());
        assert!(!value.to_string().contains(&canary()), "{value}");
    }

    /// B3 (`tests/fixtures/extensions/backends/fake-cloud`), the shared fake cloud: real HTTP on numeric loopback.
    struct Cloud { child: std::process::Child, api: String, control: String }
    impl Drop for Cloud { fn drop(&mut self) { drop(self.child.stdin.take()); let _ = self.child.wait(); } }
    fn cloud() -> Cloud {
        use std::process::{Command, Stdio};
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/extensions/backends/fake-cloud/fake-cloud.mjs");
        let mut command = Command::new("node");
        command.arg(&script).args(["--identity-port", "0", "--api-port", "0"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x0800_0000); }
        let mut child = command.spawn().expect("node starts B3");
        let mut line = String::new(); BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let ready: Value = serde_json::from_str(line.trim()).expect("B3 ready line");
        let url = |name: &str| { let value = ready[name].as_str().unwrap().to_owned(); if value.starts_with("http") { value } else { format!("http://{value}") } };
        let (api, control) = (url("api"), url("control"));
        Cloud { child, api, control }
    }
    #[tokio::test]
    async fn the_shared_fake_cloud_receives_the_credential_header_and_answers_json_and_a_stream_is_not_json() {
        let backend = cloud();
        let mut declared = manifest(9);
        let base = backend.api.trim_end_matches('/').to_owned();
        with(&mut declared, "sample.connection-adapters/cloud", |item| {
            item["operations"][0]["url"] = json!(format!("{base}/v1/usage"));
            item["operations"][1]["url"] = json!(format!("{base}/v1/chat"));
        });
        let _ = rustls::crypto::ring::default_provider().install_default();
        let rig = rig(declared);
        let key = format!("tok-{}", canary());
        rig.secrets.handle(&rig.grants, A, "1.0.0", crate::extensions::runtime_private_secrets::Caller::Service, "secrets.set", &json!({"key":"api-key","value":key})).unwrap();
        let usage = rig.finish(&rig.start("sample.connection-adapters/cloud", "usage", json!({})).unwrap()).await;
        assert_eq!(usage["state"], "completed", "{usage}");
        assert!(usage["response"]["body"]["windows"].as_array().is_some_and(|windows| windows.len() == 2), "{usage}");
        let chat = rig.finish(&rig.start("sample.connection-adapters/cloud", "chat", json!({"body":{"model":"fixture","messages":[{"role":"user","content":"hello"}],"stream":true}})).unwrap()).await;
        assert_eq!((chat["state"].as_str(), chat["response"]["status"].as_i64()), (Some("completed"), Some(401)), "the chat route wants a bearer token, and its JSON answer reaches the service with its status: {chat}");
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let control = backend.control.trim_end_matches('/').to_owned();
        let log = http.get(format!("{control}/control/log")).send().await.unwrap().text().await.unwrap();
        assert!(log.contains("x-api-key") && log.contains(&key), "the fake cloud saw the header the host attached");
        assert!(log.contains("hello"), "and the JSON body of the POST");
        http.post(format!("{control}/control/fault")).header("content-type", "application/json").body(r#"{"kind":"garbage"}"#).send().await.unwrap();
        let garbage = rig.finish(&rig.start("sample.connection-adapters/cloud", "usage", json!({})).unwrap()).await;
        assert_eq!(garbage["error"], "InvalidShape", "an answer that is not JSON: {garbage}");
        assert!(!usage.to_string().contains(&key) && !chat.to_string().contains(&key));
    }

    struct FakeHeld(BTreeMap<String, String>);
    impl held_credentials::Held for FakeHeld { fn value(&self, item: &str) -> Option<String> { self.0.get(item).cloned() } }

    #[tokio::test]
    async fn a_held_credential_is_attached_by_the_host_recorded_without_its_value_and_denied_for_another_item_or_after_revoke() {
        let api = Api::start().await;
        let mut rig = rig(manifest(api.port));
        let files = held_credentials::Files::open(&rig._dir.0);
        let values = FakeHeld(BTreeMap::from([("provider:glm".to_owned(), canary())]));
        rig.adapters = ConnectionAdapters::with_held(Arc::new(HeldUse::new(Box::new(values), files.clone())));
        const HELD: &str = "sample.connection-adapters/held";
        let status = rig.call(A, "connections.status", json!({"connection":HELD,"operation":"get"})).unwrap();
        assert_eq!(status["state"], "connected");
        assert!(files.activity(A).is_empty(), "a status is not a use");
        let done = rig.finish(&rig.start(HELD, "get", json!({})).unwrap()).await;
        assert_eq!(done["state"], "completed", "{done}");
        assert_eq!(api.requests().last().unwrap().header("authorization"), Some(format!("Bearer {}", canary()).as_str()), "attached on the wire");
        assert!(!done.to_string().contains(&canary()) && !status.to_string().contains(&canary()));
        let entries = files.activity(A);
        assert_eq!(entries.len(), 1);
        assert_eq!((entries[0].item.as_str(), entries[0].package.as_str()), ("provider:glm", A));
        assert_eq!(entries[0].address.as_deref(), Some(format!("http://127.0.0.1:{}/open", api.port).as_str()));
        assert!(!serde_json::to_string(&entries).unwrap().contains(&canary()));
        // Another item in the grant: denied, nothing sent, nothing written.
        let sent = api.requests().len();
        rig.grants.narrow(A, "credentials.use", Scope { items: Some(["provider:other".to_owned()].into()), ..Scope::default() }).unwrap();
        assert_eq!(rig.start(HELD, "get", json!({})).unwrap_err(), "PermissionDenied");
        assert_eq!((api.requests().len(), files.activity(A).len()), (sent, 1));
        // Revoked: denied too, status included.
        rig.grants.revoke(A, "credentials.use").unwrap();
        assert_eq!(rig.start(HELD, "get", json!({})).unwrap_err(), "PermissionDenied");
        assert_eq!(rig.call(A, "connections.status", json!({"connection":HELD,"operation":"get"})).unwrap_err(), "PermissionDenied");
    }
}
