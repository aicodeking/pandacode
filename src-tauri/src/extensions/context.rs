//! Host-owned, read-only captured context. No extension identity or core storage DTO crosses IPC.
use super::{contracts, packages::{ExtensionPackages, Snapshot}};
use super::inventory;
use super::project_reads;
use crate::storage::Store;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}, time::{Duration, Instant}};
use tauri::Manager;

const DEADLINE: Duration = Duration::from_secs(2);
const LIFETIME: Duration = Duration::from_secs(300);
const MAX_HANDLES: usize = 64;
const MAX_GRANTS: usize = 256;
pub const MAX_RESULT: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Capture { id: String, version: String, context: Value },
    Consent { handle: String, capability: String, allow: bool },
    Query { handle: String, resource: String, limit: u32, cursor: Option<u32>, revision: Option<String> },
    Subscribe { handle: String, resource: String, limit: u32, #[serde(rename = "requestId")] request_id: Option<String> },
    Events { handle: String, subscription: String, cursor: String },
    Unsubscribe { handle: String, subscription: String },
    Release { handle: String },
    ReadConsent { handle: String, capability: String, path: String, allow: bool },
    Read { handle: String, resource: String, path: String, cursor: Option<u32>, revision: Option<String> },
    CancelRead { handle: String },
}
#[derive(Clone)]
struct Invocation { id: String, version: String, owner: String, context: Value, expires: Instant }
#[derive(Default)]
struct Broker { handles: BTreeMap<String, Invocation>, grants: BTreeSet<(String, String, String, String)>, subscriptions: BTreeMap<String, Subscription>, journal: inventory::Journal, read_grants: BTreeMap<(String, String, String, String, String), project_reads::Authority>, cancellations: CancelTokens }
struct Subscription { handle: String, resource: String, limit: u32, request_id: Option<String>, offset: u64, cursor: String, sequence: u64, snapshot: Value }
type CancelTokens = Arc<Mutex<BTreeMap<String, Arc<AtomicU64>>>>;
pub struct ContextBroker { broker: Mutex<Broker>, busy: Arc<AtomicBool>, cancellations: CancelTokens, missed_jobs: AtomicBool }
impl Default for ContextBroker {
    fn default() -> Self {
        let broker = Broker::default(); let cancellations = broker.cancellations.clone();
        Self { broker: Mutex::new(broker), busy: Arc::new(AtomicBool::new(false)), cancellations, missed_jobs: AtomicBool::new(false) }
    }
}
/// Called only by the existing owned-agent lifecycle. Text/data/tool payloads never enter the stream.
pub fn record_job(app: &tauri::AppHandle, id: &str, kind: &str, status: &str) {
    app.state::<ContextBroker>().record_job(id, kind, status);
}
impl ContextBroker {
    pub(super) fn local_binding(&self, app: &tauri::AppHandle, snapshot: &Snapshot, handle: &str) -> Result<(String, String, Value), &'static str> {
        let binding = self.runtime_binding(snapshot, handle)?;
        let state = app.state::<crate::AppState>();
        let store = state.store.try_lock().map_err(|_| "Timeout")?;
        super::placement::local_context(&store, &binding.2)?;
        Ok(binding)
    }
    pub(super) fn storage_binding(&self, snapshot: &Snapshot, handle: &str) -> Result<(String, String, Value), &'static str> {
        let broker = self.broker.try_lock().map_err(|_| "Timeout")?;
        let invocation = broker.handles.get(handle).filter(|invocation| invocation.expires > Instant::now()).ok_or("StaleContext")?;
        let manifest = owner(snapshot, &invocation.id, &invocation.version, &invocation.context)?;
        if manifest["id"] != invocation.owner { return Err("PermissionDenied"); }
        Ok((invocation.owner.clone(), invocation.version.clone(), invocation.context.clone()))
    }
    #[cfg(all(test, feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    pub(super) fn test_call(&self, snapshot: &Snapshot, store: &Store, request: Value) -> Value {
        envelope(self.broker.lock().unwrap().execute_guarded("main", snapshot, store, request, Instant::now() + DEADLINE, None))
    }
    #[cfg(all(test, feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    pub(super) fn test_counts(&self) -> (usize, usize) { let broker = self.broker.lock().unwrap(); (broker.handles.len(), broker.subscriptions.len()) }
    pub(super) fn runtime_binding(&self, snapshot: &Snapshot, handle: &str) -> Result<(String, String, Value), &'static str> {
        let broker = self.broker.try_lock().map_err(|_| "Timeout")?;
        let invocation = broker.handles.get(handle).filter(|invocation| invocation.expires > Instant::now()).ok_or("StaleContext")?;
        let manifest = owner(snapshot, &invocation.id, &invocation.version, &invocation.context)?;
        let contributes = &manifest["contributes"];
        let command_id = if matches!(invocation.context["surfaceId"].as_str(), Some("panda.commands" | "panda.shortcuts")) || view_command(contributes, &invocation.id, &invocation.context) { json!(invocation.id) } else {
            contributes["menus"].as_array().into_iter().flatten().find_map(|menu| {
                if menu["location"] != invocation.context["surfaceId"] { return None; }
                if let Some(items) = menu["items"].as_array() { leaf(items, &invocation.id, &invocation.context).map(|item| item["command"].clone()) }
                else { (menu["id"] == invocation.id).then(|| menu["command"].clone()) }
            }).ok_or("PermissionDenied")?
        };
        if !contributes["commands"].as_array().into_iter().flatten().any(|command| command["id"] == command_id && command["action"]["kind"] == "runCommand") || !manifest["runtime"]["activationEvents"].as_array().is_some_and(|events| events.contains(&command_id)) { return Err("PermissionDenied"); }
        let mut context = invocation.context.clone(); context["commandId"] = command_id;
        Ok((invocation.owner.clone(), invocation.version.clone(), context))
    }
    pub(super) fn runtime_call(&self, snapshot: &Snapshot, store: &Store, handle: &str, mut request: Value) -> Value {
        // Only the supervisor supplies this handle. Packages cannot consent, recapture or select identity.
        if !matches!(request["op"].as_str(), Some("query" | "subscribe" | "events" | "unsubscribe")) || request.get("handle").is_some() { return failure("PermissionDenied"); }
        request["handle"] = json!(handle);
        let Ok(mut broker) = self.broker.try_lock() else { return failure("Timeout"); };
        self.reconcile_job_gap(&mut broker);
        envelope(broker.execute_guarded("main", snapshot, store, request, Instant::now() + DEADLINE, None))
    }
    pub(super) fn runtime_release(&self, handle: &str) {
        if let Ok(mut broker) = self.broker.lock() {
            broker.handles.remove(handle); broker.subscriptions.retain(|_, stream| stream.handle != handle);
            if let Ok(mut tokens) = broker.cancellations.lock() { tokens.remove(handle); }
        }
    }
    fn record_job(&self, id: &str, kind: &str, status: &str) {
        // This is on the core agent emission path. A slow extension read must never stall it.
        if let Ok(mut broker) = self.broker.try_lock() {
            self.reconcile_job_gap(&mut broker);
            if broker.subscriptions.values().any(|stream| stream.resource == "jobs") { broker.journal.record(id, kind, status); }
        } else {
            self.missed_jobs.store(true, Ordering::Release);
        }
    }
    fn reconcile_job_gap(&self, broker: &mut Broker) {
        if self.missed_jobs.swap(false, Ordering::AcqRel) { broker.journal.gap(); }
    }
}
pub fn invalidate(app: &tauri::AppHandle, owner: Option<&str>) {
    if let Ok(mut broker) = app.state::<ContextBroker>().broker.lock() {
        broker.invalidate(owner);
    }
}
type Reply = Result<Value, &'static str>;
pub fn failure(code: &str) -> Value { json!({"ok":false,"error":{"schemaVersion":1,"code":code,"path":"$","ids":[]}}) }
fn envelope(value: Reply) -> Value {
    match value {
        Ok(value) => { let reply = json!({"ok":true,"value":value}); if reply.to_string().len() <= MAX_RESULT { reply } else { failure("LimitExceeded") } }
        Err(code) => failure(code),
    }
}
fn allowed(item: &Value, context: &Value) -> bool {
    ["visible", "enabled"].iter().all(|key| item.get(key).is_none_or(|value| contracts::evaluate_condition(value, context)["value"] == true))
}
fn leaf<'a>(items: &'a [Value], id: &str, context: &Value) -> Option<&'a Value> {
    for item in items.iter().filter(|item| allowed(item, context)) {
        if item["id"] == id && !matches!(item["kind"].as_str(), Some("submenu" | "separator")) { return Some(item); }
        if let Some(found) = item["items"].as_array().and_then(|items| leaf(items, id, context)) { return Some(found); }
    }
    None
}
fn view_command(contributes: &Value, id: &str, context: &Value) -> bool {
    contributes["views"].as_array().into_iter().flatten().any(|view| view["id"] == context["surfaceId"] && view["toolbar"].as_array().into_iter().flatten().any(|item| item["command"] == id))
}
/// Declarative authentication: identity comes from the installed command, not JS fields.
fn owner(snapshot: &Snapshot, id: &str, version: &str, context: &Value) -> Reply {
    if snapshot.safe_mode || context["windowId"] != "main" || id.len() > 160 || version.len() > 32 { return Err("PermissionDenied"); }
    if contracts::validate_contract("context", context)["ok"] != true { return Err("InvalidShape"); }
    let enabled: Vec<_> = snapshot.packages.iter().filter(|package| package.enabled).map(|package| package.manifest.clone()).collect();
    if contracts::validate_contract("packages", &json!(enabled))["ok"] != true { return Err("PermissionDenied"); }
    for manifest in &enabled {
        if manifest["version"] != version { continue; }
        let contributes = &manifest["contributes"];
        let command_id = if matches!(context["surfaceId"].as_str(), Some("panda.commands" | "panda.shortcuts")) || view_command(contributes, id, context) { Some(json!(id)) } else {
            contributes["menus"].as_array().into_iter().flatten().filter(|menu| menu["location"] == context["surfaceId"] && allowed(menu, context) && !matches!(menu["presentation"].as_str(), Some("status" | "badge"))).find_map(|menu| {
                if let Some(items) = menu["items"].as_array() { leaf(items, id, context).map(|item| item["command"].clone()) }
                else { (menu["id"] == id).then(|| menu["command"].clone()) }
            })
        };
        if contributes["commands"].as_array().into_iter().flatten().any(|command| Some(&command["id"]) == command_id.as_ref() && matches!(command["action"]["kind"].as_str(), Some("showProjectContext" | "runCommand")) && allowed(command, context)) {
            return Ok(manifest.clone());
        }
    }
    Err("PermissionDenied")
}
fn project_id(context: &Value) -> &str { context["projectId"].as_str().unwrap_or("") }
fn read_root(store: &Store, invocation: &Invocation) -> Result<String, &'static str> {
    store.db.query_row("SELECT CASE WHEN length(path)<=4096 THEN path ELSE NULL END FROM projects WHERE id=?1", [project_id(&invocation.context)], |row| row.get::<_, Option<String>>(0))
        .optional().map_err(|_| "HostUnavailable")?.ok_or("NotFound")?.ok_or("LimitExceeded")
}
fn cancel_read(tokens: &CancelTokens, handle: &str) -> Reply {
    if handle.len() > 64 { return Err("LimitExceeded"); }
    let tokens = tokens.try_lock().map_err(|_| "Timeout")?;
    let token = tokens.get(handle).ok_or("StaleContext")?;
    token.fetch_add(1, Ordering::AcqRel); Ok(Value::Null)
}
fn revision(store: &Store) -> Result<String, &'static str> {
    let external: i64 = store.db.query_row("PRAGMA data_version", [], |row| row.get(0)).map_err(|_| "HostUnavailable")?;
    Ok(format!("{external}:{}", store.db.total_changes()))
}
fn summaries(store: &Store, invocation: &Invocation, resource: &str, limit: u32, cursor: u32, expected: Option<&str>) -> Reply {
    let project = project_id(&invocation.context);
    let mut current = revision(store)?;
    if project.is_empty() { return Ok(json!({"schemaVersion":1,"state":"NoProject","revision":current,"items":[],"nextCursor":null})); }
    // The caller holds the Store lock. Select ONLY allowed columns and detect external writes below.
    let name: Option<String> = store.db.query_row("SELECT CASE WHEN length(name)<=256 THEN name ELSE NULL END FROM projects WHERE id=?1", [project], |row| row.get(0)).optional().map_err(|_| "HostUnavailable")?.ok_or("NotFound")?;
    let name = name.ok_or("LimitExceeded")?;
    let database_revision = current.clone();
    let mut items = Vec::new();
    let mut next = None;
    match resource {
        "projects" => { if cursor != 0 { return Err("InvalidShape"); } items.push(json!({"id":project,"name":name})); }
        "tasks" => {
            let mut statement = store.db.prepare("SELECT CASE WHEN length(id)<=256 THEN id ELSE NULL END, CASE WHEN length(status)<=64 THEN status ELSE NULL END FROM sessions WHERE project_id=?1 AND draft=0 ORDER BY id LIMIT ?2 OFFSET ?3").map_err(|_| "HostUnavailable")?;
            let rows = statement.query_map(rusqlite::params![project, limit + 1, cursor], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?))).map_err(|_| "HostUnavailable")?;
            for row in rows {
                let (id, status) = row.map_err(|_| "HostUnavailable")?;
                let (id, status) = (id.ok_or("LimitExceeded")?, status.ok_or("LimitExceeded")?);
                if items.len() == limit as usize { next = Some(cursor + limit); break; }
                items.push(json!({"id":id,"projectId":project,"status":status}));
            }
        }
        "harnesses" | "connections" | "jobs" => {
            let all = inventory::items(store, project, resource)?;
            use std::hash::{Hash, Hasher};
            let mut hash = std::hash::DefaultHasher::new(); serde_json::to_vec(&all).map_err(|_| "HostUnavailable")?.hash(&mut hash);
            current = format!("{current}:{:x}", hash.finish());
            items = all.iter().skip(cursor as usize).take(limit as usize).cloned().collect();
            if (cursor as usize) + items.len() < all.len() { next = Some(cursor + limit); }
        }
        _ => return Err("UnsupportedCapability"),
    }
    if expected.is_some_and(|expected| expected != current) { return Err("StaleContext"); }
    // External writers may change the DB despite this process's Store lock. Never mix revisions.
    if revision(store)? != database_revision { return Err("StaleContext"); }
    Ok(json!({"schemaVersion":1,"state":"Ready","revision":current,"items":items,"nextCursor":next}))
}
impl Broker {
    fn invalidate(&mut self, owner: Option<&str>) {
        self.handles.retain(|_, invocation| owner.is_some_and(|owner| invocation.owner != owner));
        self.grants.retain(|(extension, _, _, _)| owner.is_some_and(|owner| extension != owner));
        self.subscriptions.retain(|_, subscription| self.handles.contains_key(&subscription.handle));
        self.read_grants.retain(|(extension, _, _, _, _), _| owner.is_some_and(|owner| extension != owner));
        if let Ok(mut tokens) = self.cancellations.lock() { tokens.retain(|handle, token| { let keep = self.handles.contains_key(handle); if !keep { token.fetch_add(1, Ordering::AcqRel); } keep }); }
    }
    #[cfg(test)]
    fn execute(&mut self, label: &str, snapshot: &Snapshot, store: &Store, raw: Value, deadline: Instant) -> Reply {
        self.execute_guarded(label, snapshot, store, raw, deadline, None)
    }
    fn execute_guarded(&mut self, label: &str, snapshot: &Snapshot, store: &Store, raw: Value, deadline: Instant, cancellation: Option<(Arc<AtomicU64>, u64)>) -> Reply {
        if label != "main" { return Err("PermissionDenied"); }
        if raw.to_string().len() > 8192 { return Err("LimitExceeded"); }
        let request: Request = serde_json::from_value(raw).map_err(|_| "InvalidShape")?;
        self.handles.retain(|_, invocation| invocation.expires > Instant::now());
        if let Ok(mut tokens) = self.cancellations.lock() { tokens.retain(|handle, _| self.handles.contains_key(handle)); }
        self.subscriptions.retain(|_, subscription| self.handles.contains_key(&subscription.handle));
        if Instant::now() >= deadline { return Err("Timeout"); }
        if let Request::Capture { id, version, context } = request {
            let manifest = owner(snapshot, &id, &version, &context)?;
            // No forged project/task pair or local execution against a mirror's history container.
            super::placement::local_context(store, &context)?;
            if self.handles.len() >= MAX_HANDLES { return Err("LimitExceeded"); }
            let handle = uuid::Uuid::new_v4().to_string();
            let owner = manifest["id"].as_str().ok_or("PermissionDenied")?.to_owned();
            self.handles.insert(handle.clone(), Invocation { id, version, owner: owner.clone(), context, expires: Instant::now() + LIFETIME });
            self.cancellations.lock().map_err(|_| "HostUnavailable")?.insert(handle.clone(), Arc::new(AtomicU64::new(0)));
            return Ok(json!({"schemaVersion":1,"handle":handle,"owner":owner}));
        }
        let handle = match &request { Request::Consent { handle, .. } | Request::Query { handle, .. } | Request::Subscribe { handle, .. } | Request::Events { handle, .. } | Request::Unsubscribe { handle, .. } | Request::ReadConsent { handle, .. } | Request::Read { handle, .. } | Request::CancelRead { handle } | Request::Release { handle } => handle, _ => unreachable!() };
        if handle.len() > 64 { return Err("LimitExceeded"); }
        if matches!(request, Request::Release { .. }) { self.handles.remove(handle); self.subscriptions.retain(|_, subscription| &subscription.handle != handle); self.cancellations.lock().map_err(|_| "HostUnavailable")?.remove(handle); return Ok(Value::Null); }
        let invocation = self.handles.get(handle).ok_or("StaleContext")?.clone();
        super::placement::local_context(store, &invocation.context)?;
        let manifest = owner(snapshot, &invocation.id, &invocation.version, &invocation.context)?;
        if manifest["id"] != invocation.owner { return Err("PermissionDenied"); }
        let key = |capability: &str| (invocation.owner.clone(), invocation.version.clone(), project_id(&invocation.context).to_owned(), capability.to_owned());
        let read_handle = handle.clone();
        match request {
            Request::CancelRead { .. } => {
                cancel_read(&self.cancellations, &read_handle)
            }
            Request::ReadConsent { capability, path, allow, .. } => {
                if !project_reads::CAPABILITIES.contains(&capability.as_str()) || !manifest["permissions"].as_array().is_some_and(|permissions| permissions.iter().any(|item| item == &capability)) { return Err("PermissionDenied"); }
                project_reads::resource_path(&path, capability == "projects.git.read")?;
                let key = (invocation.owner.clone(), invocation.version.clone(), project_id(&invocation.context).to_owned(), capability, path);
                if allow {
                    if self.read_grants.len() >= MAX_GRANTS && !self.read_grants.contains_key(&key) { return Err("LimitExceeded"); }
                    let root = read_root(store, &invocation)?;
                    self.read_grants.insert(key, project_reads::Authority::grant(std::path::Path::new(&root))?);
                } else { self.read_grants.remove(&key); }
                Ok(Value::Null)
            }
            Request::Read { resource, path, cursor, revision, .. } => {
                let capability = match resource.as_str() { "metadata" => "projects.files.metadata", "file" => "projects.files.read", "git" => "projects.git.read", _ => return Err("UnsupportedCapability") };
                if !manifest["permissions"].as_array().is_some_and(|permissions| permissions.iter().any(|item| item == capability)) { return Err("PermissionDenied"); }
                let key = (invocation.owner.clone(), invocation.version.clone(), project_id(&invocation.context).to_owned(), capability.to_owned(), path.clone());
                let authority = self.read_grants.get(&key).ok_or("PermissionDenied")?;
                let root = read_root(store, &invocation)?;
                let token = self.cancellations.lock().map_err(|_| "HostUnavailable")?.get(&read_handle).cloned().ok_or("StaleContext")?;
                let (token, generation) = cancellation.unwrap_or_else(|| { let generation = token.load(Ordering::Acquire); (token, generation) });
                let result = project_reads::query(authority, std::path::Path::new(&root), &resource, &path, (cursor.unwrap_or(0), revision.as_deref()), deadline, || token.load(Ordering::Acquire) != generation)?;
                if read_root(store, &invocation)? != root { return Err("StaleContext"); }
                Ok(result)
            }
            Request::Consent { capability, allow, .. } => {
                if !["projects.summary", "tasks.summary", "harnesses.inventory", "connections.summary", "jobs.summary"].contains(&capability.as_str()) || !manifest["permissions"].as_array().is_some_and(|permissions| permissions.iter().any(|item| item == &capability)) { return Err("PermissionDenied"); }
                if allow {
                    if self.grants.len() >= MAX_GRANTS && !self.grants.contains(&key(&capability)) { return Err("LimitExceeded"); }
                    self.grants.insert(key(&capability));
                } else {
                    self.grants.remove(&key(&capability));
                    self.subscriptions.retain(|_, subscription| !(inventory::capability(&subscription.resource) == Some(capability.as_str()) && self.handles.get(&subscription.handle).is_some_and(|other| key(&capability) == (other.owner.clone(), other.version.clone(), project_id(&other.context).to_owned(), capability.clone()))));
                }
                Ok(Value::Null)
            }
            Request::Query { resource, limit, cursor, revision, .. } => {
                if limit == 0 || limit > 50 || cursor.unwrap_or(0) > 10000 || revision.as_ref().is_some_and(|value| value.len() > 64) { return Err("LimitExceeded"); }
                let capability = inventory::capability(&resource).ok_or("UnsupportedCapability")?;
                if !manifest["permissions"].as_array().is_some_and(|permissions| permissions.iter().any(|item| item == capability)) || !self.grants.contains(&key(capability)) { return Err("PermissionDenied"); }
                summaries(store, &invocation, &resource, limit, cursor.unwrap_or(0), revision.as_deref())
            }
            Request::Subscribe { handle, resource, limit, request_id } => {
                let capability = inventory::capability(&resource).ok_or("UnsupportedCapability")?;
                if !manifest["permissions"].as_array().is_some_and(|permissions| permissions.iter().any(|item| item == capability)) || !self.grants.contains(&key(capability)) { return Err("PermissionDenied"); }
                if limit == 0 || limit > 50 || request_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 64) { return Err("LimitExceeded"); }
                let page = summaries(store, &invocation, &resource, limit, 0, None)?;
                // A committed subscribe reply can be lost. Retry the same owned request as an
                // explicit snapshot resync, not another unreachable subscription consuming the cap.
                if let Some((id, stream)) = self.subscriptions.iter_mut().find(|(_, stream)| stream.handle == handle && request_id.is_some() && stream.request_id == request_id) {
                    if stream.resource != resource || stream.limit != limit { return Err("InvalidShape"); }
                    stream.snapshot = page.clone(); stream.offset = self.journal.cursor; stream.cursor = uuid::Uuid::new_v4().to_string();
                    return Ok(json!({"schemaVersion":1,"subscription":id,"cursor":stream.cursor,"snapshot":page,"events":[],"resync":true}));
                }
                if self.subscriptions.len() >= 64 || self.subscriptions.values().filter(|stream| stream.handle == handle).count() >= 5 { return Err("LimitExceeded"); }
                let subscription = uuid::Uuid::new_v4().to_string(); let cursor = uuid::Uuid::new_v4().to_string();
                self.subscriptions.insert(subscription.clone(), Subscription { handle, resource, limit, request_id, offset: self.journal.cursor, cursor: cursor.clone(), sequence: 0, snapshot: page.clone() });
                Ok(json!({"schemaVersion":1,"subscription":subscription,"cursor":cursor,"snapshot":page,"events":[],"resync":false}))
            }
            Request::Unsubscribe { handle, subscription } => {
                if subscription.len() > 64 { return Err("LimitExceeded"); }
                if self.subscriptions.get(&subscription).is_some_and(|stream| stream.handle != handle) { return Err("PermissionDenied"); }
                self.subscriptions.remove(&subscription); Ok(Value::Null)
            }
            Request::Events { handle, subscription, cursor } => {
                if subscription.len() > 64 || cursor.len() > 64 { return Err("LimitExceeded"); }
                let stream = self.subscriptions.get(&subscription).ok_or("StaleContext")?;
                if stream.handle != handle { return Err("PermissionDenied"); }
                let capability = inventory::capability(&stream.resource).ok_or("UnsupportedCapability")?;
                if !manifest["permissions"].as_array().is_some_and(|permissions| permissions.iter().any(|item| item == capability)) || !self.grants.contains(&key(capability)) { self.subscriptions.remove(&subscription); return Err("PermissionDenied"); }
                let page = match summaries(store, &invocation, &stream.resource, stream.limit, 0, None) {
                    Ok(page) => page,
                    Err(error) => {
                        if error == "NotFound" {
                            self.subscriptions.retain(|_, stream| self.handles.get(&stream.handle).is_some_and(|other| project_id(&other.context) != project_id(&invocation.context)));
                        } else { self.subscriptions.remove(&subscription); }
                        return Err(error);
                    }
                };
                let (gap, mut events) = if stream.resource == "jobs" { self.journal.read(store, project_id(&invocation.context), stream.offset)? } else { (false, Vec::new()) };
                let resync = gap || cursor != stream.cursor || serde_json::to_vec(&events).map_err(|_| "HostUnavailable")?.len() > 24 * 1024;
                let stream = self.subscriptions.get_mut(&subscription).ok_or("StaleContext")?;
                if resync { events.clear(); }
                for event in &mut events { stream.sequence += 1; event["sequence"] = json!(stream.sequence); event["revision"] = json!(format!("event:{}", stream.sequence)); }
                // SQLite revisions are conservative. Compare public items/state to avoid unrelated refreshes.
                let changed = page["items"] != stream.snapshot["items"] || page["state"] != stream.snapshot["state"] || page["nextCursor"] != stream.snapshot["nextCursor"];
                stream.snapshot = page.clone(); stream.offset = self.journal.cursor; stream.cursor = uuid::Uuid::new_v4().to_string();
                Ok(json!({"schemaVersion":1,"cursor":stream.cursor,"snapshot":if changed || resync {page} else {Value::Null},"events":events,"resync":resync}))
            }
            _ => unreachable!(),
        }
    }
}

/// Single admitted worker bounds queued work even if a filesystem/SQLite operation outlives timeout.
#[tauri::command]
pub async fn extensions_context(window: tauri::WebviewWindow, app: tauri::AppHandle, request: Value) -> Value {
    if window.label() != "main" { return failure("PermissionDenied"); }
    let state = app.state::<ContextBroker>();
    // Cancellation bypasses the single-worker admission and all database/package locks. The opaque
    // captured handle is main-window-bound; cancellation never grants data or controls a core job.
    if request["op"] == "cancelRead" {
        return envelope((|| {
            let Request::CancelRead { handle } = serde_json::from_value(request).map_err(|_| "InvalidShape")? else { return Err("InvalidShape"); };
            cancel_read(&state.cancellations, &handle)
        })());
    }
    let cancellation = if request["op"] == "read" {
        let Some(handle) = request["handle"].as_str() else { return failure("InvalidShape"); };
        let Ok(tokens) = state.cancellations.try_lock() else { return failure("Timeout"); };
        let Some(token) = tokens.get(handle).cloned() else { return failure("StaleContext"); };
        let generation = token.load(Ordering::Acquire); Some((token, generation))
    } else { None };
    if state.busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return failure("Timeout"); }
    struct Permit(Arc<AtomicBool>);
    impl Drop for Permit { fn drop(&mut self) { self.0.store(false, Ordering::Release); } }
    let permit = Permit(state.busy.clone());
    let deadline = Instant::now() + DEADLINE;
    let work = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let delivery = cancellation.clone();
        let result = (|| {
            let packages = app.state::<ExtensionPackages>();
            let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
            let snapshot = packages.snapshot();
            let state = app.state::<crate::AppState>();
            let store = state.store.try_lock().map_err(|_| "Timeout")?;
            let state = app.state::<ContextBroker>();
            let mut broker = state.broker.try_lock().map_err(|_| "Timeout")?;
            state.reconcile_job_gap(&mut broker);
            let release = (request["op"] == "release").then(|| request["handle"].as_str().map(str::to_owned)).flatten();
            let result = broker.execute_guarded("main", &snapshot, &store, request, deadline, cancellation);
            if result.is_ok() { if let Some(handle) = release { packages.storage_dispose(None, Some(&handle)); app.state::<super::jobs::ExtensionJobs>().stop(None, Some(&handle)); app.state::<super::connections::ExtensionConnections>().stop(None, Some(&handle)); if let Ok(mut services) = app.state::<super::runtime::ExtensionRuntime>().services.lock() { services.stop(None, Some(&handle)); } } }
            result
        })();
        if delivery.is_some_and(|(token, generation)| token.load(Ordering::Acquire) != generation) { failure("Cancelled") }
        else if Instant::now() >= deadline { failure("Timeout") } else { envelope(result) }
    });
    bounded_reply(DEADLINE, work).await
}
async fn bounded_reply<E>(duration: Duration, work: impl std::future::Future<Output = Result<Value, E>>) -> Value {
    match tokio::time::timeout(duration, work).await { Ok(Ok(value)) => value, Ok(Err(_)) => failure("HostUnavailable"), Err(_) => failure("Timeout") }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn view_toolbar_capture_and_runtime_binding_require_declared_owner_version_command_and_window() {
        let mut manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/project-summary/extension.json")).unwrap();
        let command = manifest["contributes"]["commands"][0]["id"].as_str().unwrap().to_owned();
        manifest["contributes"]["views"] = json!([{"id":"sample.project-summary/panel","title":"Summary","text":"","toolbar":[{"command":command}]}]);
        let mut snapshot = super::super::packages::context_test_snapshot(manifest);
        let context = json!({"schemaVersion":1,"windowId":"main","surfaceId":"sample.project-summary/panel","revision":1,"projectId":"A"});
        assert!(owner(&snapshot, &command, "1.0.0", &context).is_ok());
        assert!(owner(&snapshot, &command, "9.0.0", &context).is_err());
        for (key, forged) in [("windowId", "tray"), ("surfaceId", "sample.project-summary/missing")] {
            let mut invalid = context.clone(); invalid[key] = json!(forged);
            assert!(owner(&snapshot, &command, "1.0.0", &invalid).is_err());
        }
        assert!(owner(&snapshot, "other.extension/command", "1.0.0", &context).is_err());
        let broker = ContextBroker::default();
        broker.broker.lock().unwrap().handles.insert("view-handle".into(), Invocation { id: command.clone(), version:"1.0.0".into(), owner:"sample.project-summary".into(), context:context.clone(), expires:Instant::now() + LIFETIME });
        assert_eq!(broker.runtime_binding(&snapshot, "view-handle").unwrap().2["commandId"], command);
        snapshot.packages[0].enabled = false;
        assert!(broker.runtime_binding(&snapshot, "view-handle").is_err());
        assert!(owner(&snapshot, &command, "1.0.0", &context).is_err());
    }
    fn fixture() -> (Broker, Snapshot, Store) {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        store.db.execute("INSERT INTO projects(id,name,path) VALUES ('A','Alpha','/private/credential-root'),('B','Beta','/private/other')", []).unwrap();
        for (id, project) in [("a1", "A"), ("a2", "A"), ("b1", "B")] {
            store.db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at) VALUES (?1,?2,'TRANSCRIPT_SENTINEL','claude','test','ask','pending',1,1)", [id, project]).unwrap();
        }
        let manifest = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/project-context/extension.json")).unwrap();
        (Broker::default(), super::super::packages::context_test_snapshot(manifest), store)
    }
    fn call(broker: &mut Broker, snapshot: &Snapshot, store: &Store, request: Value) -> Value {
        envelope(broker.execute("main", snapshot, store, request, Instant::now() + DEADLINE))
    }
    fn capture(broker: &mut Broker, snapshot: &Snapshot, store: &Store, project: Option<&str>) -> String {
        let mut context = json!({"schemaVersion":1,"windowId":"main","surfaceId":"panda.workspace.header.actions","revision":1});
        if let Some(project) = project { context["projectId"] = json!(project); }
        let value = call(broker, snapshot, store, json!({"op":"capture","id":"sample.project-context/header","version":"1.0.0","context":context}));
        value["value"]["handle"].as_str().unwrap().to_owned()
    }
    fn consent(broker: &mut Broker, snapshot: &Snapshot, store: &Store, handle: &str, capability: &str, allow: bool) {
        assert_eq!(call(broker, snapshot, store, json!({"op":"consent","handle":handle,"capability":capability,"allow":allow}))["ok"], true);
    }
    fn query(handle: &str, resource: &str) -> Value { json!({"op":"query","handle":handle,"resource":resource,"limit":1}) }
    #[test]
    fn remote_mirror_context_never_reads_or_runs_against_viewer_project() {
        let (mut broker, snapshot, store) = fixture();
        store.db.execute("UPDATE sessions SET remote_device='host-a',remote_session='host-task' WHERE id='a1'", []).unwrap();
        let context = json!({"schemaVersion":1,"windowId":"main","surfaceId":"panda.workspace.header.actions","revision":1,"projectId":"A","sessionId":"a1"});
        let result = call(&mut broker, &snapshot, &store, json!({"op":"capture","id":"sample.project-context/header","version":"1.0.0","context":context}));
        assert_eq!(result["error"]["code"], "UnsupportedCapability");
        assert!(broker.handles.is_empty());
        assert!(broker.grants.is_empty());
    }
    #[test]
    fn local_handle_cannot_survive_session_becoming_a_remote_mirror() {
        let (mut broker, snapshot, store) = fixture();
        let context = json!({"schemaVersion":1,"windowId":"main","surfaceId":"panda.workspace.header.actions","revision":1,"projectId":"A","sessionId":"a1"});
        let result = call(&mut broker, &snapshot, &store, json!({"op":"capture","id":"sample.project-context/header","version":"1.0.0","context":context}));
        let handle = result["value"]["handle"].as_str().unwrap();
        consent(&mut broker, &snapshot, &store, handle, "projects.summary", true);
        store.db.execute("UPDATE sessions SET remote_device='host-a',remote_session='host-task' WHERE id='a1'", []).unwrap();
        assert_eq!(call(&mut broker, &snapshot, &store, query(handle, "project"))["error"]["code"], "UnsupportedCapability");
    }
    #[test]
    fn core_job_producer_never_waits_for_a_busy_extension_query() {
        let state = Arc::new(ContextBroker::default());
        let (sent, received) = std::sync::mpsc::channel();
        let busy = state.broker.lock().unwrap();
        let producer_state = state.clone();
        let producer = std::thread::spawn(move || {
            producer_state.record_job("a1", "terminal", "completed");
            sent.send(()).unwrap();
        });
        let completed = received.recv_timeout(Duration::from_millis(100)).is_ok();
        // Always release and join, including on regression, rather than strand a test thread.
        drop(busy); producer.join().unwrap();
        assert!(completed, "extension query lock must not stall core agent emission");
    }
    #[test]
    fn contended_terminal_event_forces_authorized_snapshot_resync_for_both_projects() {
        let (broker, snapshot, store) = fixture();
        let state = ContextBroker { broker: Mutex::new(broker), ..ContextBroker::default() };
        let mut broker = state.broker.lock().unwrap();
        let a = capture(&mut broker, &snapshot, &store, Some("A"));
        let b = capture(&mut broker, &snapshot, &store, Some("B"));
        let mut polls = Vec::new();
        for handle in [&a, &b] {
            consent(&mut broker, &snapshot, &store, handle, "jobs.summary", true);
            let stream = call(&mut broker, &snapshot, &store, json!({"op":"subscribe","handle":handle,"resource":"jobs","limit":10}))["value"].clone();
            polls.push(json!({"op":"events","handle":handle,"subscription":stream["subscription"],"cursor":stream["cursor"]}));
        }
        state.record_job("a1", "terminal", "completed");
        store.db.execute("UPDATE sessions SET status='completed' WHERE id='a1'", []).unwrap();
        state.reconcile_job_gap(&mut broker);
        for (poll, expected) in polls.into_iter().zip(["a1", "b1"]) {
            let reply = call(&mut broker, &snapshot, &store, poll);
            assert_eq!(reply["value"]["resync"], true);
            assert_eq!(reply["value"]["events"], json!([]));
            assert_eq!(reply["value"]["snapshot"]["items"][0]["id"], expected);
        }
        assert!(!state.missed_jobs.load(Ordering::Acquire));
    }
    #[test]
    fn independent_observers_release_only_their_stream_and_leave_workspace_job_running() {
        for close_first in [0, 1] {
            let (mut broker, snapshot, store) = fixture();
            store.db.execute("UPDATE sessions SET status='running',provider='sample.fake-harness/recorded' WHERE id='a1'", []).unwrap();
            let handles = [capture(&mut broker, &snapshot, &store, Some("A")), capture(&mut broker, &snapshot, &store, Some("A"))];
            let mut streams = Vec::new();
            for handle in &handles {
                consent(&mut broker, &snapshot, &store, handle, "jobs.summary", true);
                streams.push(call(&mut broker, &snapshot, &store, json!({"op":"subscribe","handle":handle,"resource":"jobs","limit":10}))["value"].clone());
            }
            assert_ne!(streams[0]["subscription"], streams[1]["subscription"]);
            assert_eq!(broker.subscriptions.len(), 2);
            call(&mut broker, &snapshot, &store, json!({"op":"release","handle":handles[close_first]}));
            assert_eq!(broker.subscriptions.len(), 1);
            let status: String = store.db.query_row("SELECT status FROM sessions WHERE id='a1'", [], |row| row.get(0)).unwrap();
            assert_eq!(status, "running");
            store.db.execute("UPDATE sessions SET status='completed' WHERE id='a1'", []).unwrap();
            broker.journal.record("a1", "terminal", "completed");
            let survivor = 1 - close_first;
            let reply = call(&mut broker, &snapshot, &store, json!({"op":"events","handle":handles[survivor],"subscription":streams[survivor]["subscription"],"cursor":streams[survivor]["cursor"]}));
            assert_eq!(reply["value"]["snapshot"]["items"][0]["status"], "completed");
            assert_eq!(call(&mut broker, &snapshot, &store, query(&handles[close_first], "jobs"))["error"]["code"], "StaleContext");
        }
    }
    #[test]
    fn subscribe_retries_are_handle_scoped_bounded_authorized_and_resync_after_lost_reply() {
        let (mut broker, snapshot, store) = fixture();
        let a = capture(&mut broker, &snapshot, &store, Some("A"));
        let b = capture(&mut broker, &snapshot, &store, Some("B"));
        for handle in [&a, &b] { consent(&mut broker, &snapshot, &store, handle, "jobs.summary", true); }
        let request = |handle: &str| json!({"op":"subscribe","handle":handle,"resource":"jobs","limit":10,"requestId":"retry-token"});
        let first = call(&mut broker, &snapshot, &store, request(&a))["value"].clone();
        for _ in 0..4 { assert_eq!(call(&mut broker, &snapshot, &store, json!({"op":"subscribe","handle":a,"resource":"jobs","limit":10}))["ok"], true); }
        store.db.execute("UPDATE sessions SET status='completed' WHERE id='a1'", []).unwrap();
        let retry = call(&mut broker, &snapshot, &store, request(&a))["value"].clone();
        assert_eq!(retry["subscription"], first["subscription"]); assert_ne!(retry["cursor"], first["cursor"]);
        assert_eq!(retry["resync"], true); assert_eq!(retry["snapshot"]["items"][0]["status"], "completed"); assert_eq!(broker.subscriptions.len(), 5);
        let other = call(&mut broker, &snapshot, &store, request(&b))["value"].clone();
        assert_ne!(other["subscription"], first["subscription"]); assert_eq!(other["snapshot"]["items"][0]["id"], "b1");
        let mut changed = request(&a); changed["limit"] = json!(1);
        assert_eq!(call(&mut broker, &snapshot, &store, changed)["error"]["code"], "InvalidShape");
        let mut oversized = request(&a); oversized["requestId"] = json!("s".repeat(65));
        assert_eq!(call(&mut broker, &snapshot, &store, oversized)["error"]["code"], "LimitExceeded");
        consent(&mut broker, &snapshot, &store, &a, "jobs.summary", false);
        assert_eq!(call(&mut broker, &snapshot, &store, request(&a))["error"]["code"], "PermissionDenied");
        assert_eq!(broker.subscriptions.len(), 1);
    }
    #[test]
    fn read_cancel_endpoint_does_not_wait_for_the_busy_broker_or_admit_another_worker() {
        let state = ContextBroker::default(); let token = Arc::new(AtomicU64::new(0));
        state.cancellations.lock().unwrap().insert("opaque".into(), token.clone());
        let _busy_broker = state.broker.lock().unwrap(); state.busy.store(true, Ordering::Release);
        assert_eq!(cancel_read(&state.cancellations, "opaque").unwrap(), Value::Null);
        assert_eq!(token.load(Ordering::Acquire), 1); assert!(state.busy.load(Ordering::Acquire));
        assert_eq!(cancel_read(&state.cancellations, "other").unwrap_err(), "StaleContext");
    }
    #[test]
    fn project_reads_require_declared_exact_resource_consent_captured_project_and_cancel_generation() {
        let (mut broker, _, store) = fixture();
        let root = std::env::temp_dir().join(format!("panda-broker-reads-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap(); std::fs::write(root.join("readme.txt"), "A authorized").unwrap();
        store.db.execute("UPDATE projects SET path=?1 WHERE id='A'", [root.to_str().unwrap()]).unwrap();
        let manifest = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/project-reads/extension.json")).unwrap();
        let mut snapshot = super::super::packages::context_test_snapshot(manifest);
        let context = |project: &str| json!({"schemaVersion":1,"windowId":"main","surfaceId":"panda.workspace.header.actions","revision":1,"projectId":project});
        let mut capture = |project: &str| call(&mut broker, &snapshot, &store, json!({"op":"capture","id":"sample.project-reads/header","version":"1.0.0","context":context(project)}))["value"]["handle"].as_str().unwrap().to_owned();
        let a = capture("A"); let b = capture("B");
        let read = |handle: &str, resource: &str, path: &str| json!({"op":"read","handle":handle,"resource":resource,"path":path});
        consent(&mut broker, &snapshot, &store, &a, "projects.summary", true);
        assert_eq!(call(&mut broker, &snapshot, &store, read(&a, "file", "readme.txt"))["error"]["code"], "PermissionDenied");
        let grant = |capability: &str, path: &str, allow: bool| json!({"op":"readConsent","handle":a,"capability":capability,"path":path,"allow":allow});
        assert_eq!(call(&mut broker, &snapshot, &store, grant("projects.files.metadata", "readme.txt", true))["ok"], true);
        assert_eq!(call(&mut broker, &snapshot, &store, read(&a, "metadata", "readme.txt"))["value"]["items"][0]["bytes"], 12);
        assert_eq!(call(&mut broker, &snapshot, &store, read(&a, "file", "readme.txt"))["error"]["code"], "PermissionDenied");
        assert_eq!(call(&mut broker, &snapshot, &store, grant("projects.files.read", "readme.txt", true))["ok"], true);
        assert_eq!(call(&mut broker, &snapshot, &store, read(&a, "file", "readme.txt"))["value"]["content"], "A authorized");
        assert_eq!(broker.execute("tray", &snapshot, &store, read(&a, "file", "readme.txt"), Instant::now() + DEADLINE).unwrap_err(), "PermissionDenied");
        let mut forged = read(&a, "file", "readme.txt"); forged["projectId"] = json!("B");
        assert_eq!(call(&mut broker, &snapshot, &store, forged)["error"]["code"], "InvalidShape");
        assert_eq!(call(&mut broker, &snapshot, &store, json!({"op":"write","handle":a,"path":"readme.txt","content":"mutation"}))["error"]["code"], "InvalidShape");
        for request in [read(&b, "file", "readme.txt"), read(&a, "file", "other.txt"), read(&a, "git", ".")] { assert_eq!(call(&mut broker, &snapshot, &store, request)["error"]["code"], "PermissionDenied"); }
        let token = broker.cancellations.lock().unwrap()[&a].clone(); let generation = token.load(Ordering::Acquire);
        assert_eq!(call(&mut broker, &snapshot, &store, json!({"op":"cancelRead","handle":a}))["ok"], true);
        assert_eq!(broker.execute_guarded("main", &snapshot, &store, read(&a, "file", "readme.txt"), Instant::now() + DEADLINE, Some((token, generation))).unwrap_err(), "Cancelled");
        // Cancellation is per request generation, not a permanent revocation or a core task stop.
        assert_eq!(call(&mut broker, &snapshot, &store, read(&a, "file", "readme.txt"))["ok"], true);
        call(&mut broker, &snapshot, &store, grant("projects.files.read", "readme.txt", false));
        assert_eq!(call(&mut broker, &snapshot, &store, read(&a, "file", "readme.txt"))["error"]["code"], "PermissionDenied");
        snapshot.packages[0].manifest["permissions"] = json!(["ui.contribute", "projects.summary"]);
        assert_eq!(call(&mut broker, &snapshot, &store, grant("projects.files.read", "readme.txt", true))["error"]["code"], "PermissionDenied");
        broker.invalidate(None); assert!(broker.read_grants.is_empty()); assert!(broker.cancellations.lock().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn inventory_stream_snapshot_cursor_scope_terminal_gap_reconnect_and_disposal() {
        let (mut broker, snapshot, store) = fixture();
        let a = capture(&mut broker, &snapshot, &store, Some("A")); let b = capture(&mut broker, &snapshot, &store, Some("B"));
        for handle in [&a, &b] { consent(&mut broker, &snapshot, &store, handle, "jobs.summary", true); }
        let subscribe = |handle: &str| json!({"op":"subscribe","handle":handle,"resource":"jobs","limit":10});
        let stream = call(&mut broker, &snapshot, &store, subscribe(&a))["value"].clone();
        let other = call(&mut broker, &snapshot, &store, subscribe(&b))["value"].clone();
        assert_eq!(stream["snapshot"]["items"].as_array().unwrap().len(), 2);
        assert_eq!(stream["snapshot"]["items"][0]["kind"], "agentTask");
        let mut poll = json!({"op":"events","handle":a,"subscription":stream["subscription"],"cursor":stream["cursor"]});
        let mut stolen = poll.clone(); stolen["handle"] = json!(b);
        assert_eq!(call(&mut broker, &snapshot, &store, stolen)["error"]["code"], "PermissionDenied");
        broker.journal.record("b1", "terminal", "completed");
        broker.journal.record("a1", "progress", "running"); broker.journal.record("a1", "terminal", "failed");
        let first = call(&mut broker, &snapshot, &store, poll.clone())["value"].clone();
        assert_eq!(first["events"], json!([{"sequence":1,"revision":"event:1","id":"a1","kind":"progress","status":"running"},{"sequence":2,"revision":"event:2","id":"a1","kind":"terminal","status":"failed"}]));
        assert_eq!(first["resync"], false);
        let b_events = call(&mut broker, &snapshot, &store, json!({"op":"events","handle":b,"subscription":other["subscription"],"cursor":other["cursor"]}));
        assert_eq!(b_events["value"]["events"], json!([{"sequence":1,"revision":"event:1","id":"b1","kind":"terminal","status":"completed"}]));
        // A lost reply/reconnect cannot silently skip lifecycle events: explicit full resync.
        let reconnect = call(&mut broker, &snapshot, &store, poll.clone())["value"].clone();
        assert_eq!(reconnect["resync"], true); assert!(reconnect["snapshot"].is_object()); poll["cursor"] = reconnect["cursor"].clone();
        for _ in 0..140 { broker.journal.record("a2", "terminal", "completed"); }
        let gap = call(&mut broker, &snapshot, &store, poll.clone())["value"].clone(); assert_eq!(gap["resync"], true); assert_eq!(gap["events"], json!([]));
        poll["cursor"] = gap["cursor"].clone();
        broker.journal.record("a1", "progress", "running"); broker.journal.record("a1", "progress", "running");
        assert_eq!(call(&mut broker, &snapshot, &store, poll.clone())["value"]["resync"], true);
        consent(&mut broker, &snapshot, &store, &a, "jobs.summary", false); assert_eq!(broker.subscriptions.len(), 1);
        assert_eq!(call(&mut broker, &snapshot, &store, poll)["error"]["code"], "StaleContext");
        consent(&mut broker, &snapshot, &store, &a, "jobs.summary", true); let _ = call(&mut broker, &snapshot, &store, subscribe(&a));
        broker.invalidate(Some("sample.project-context")); assert!(broker.subscriptions.is_empty());
    }
    #[test]
    fn oversized_event_batch_resyncs_instead_of_dropping_terminal_events_at_the_reply_limit() {
        let (mut broker, snapshot, store) = fixture();
        let a = capture(&mut broker, &snapshot, &store, Some("A")); consent(&mut broker, &snapshot, &store, &a, "jobs.summary", true);
        let id = "a".repeat(256);
        store.db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at) VALUES (?1,'A','SECRET','claude','test','ask','running',1,1)", [&id]).unwrap();
        let stream = call(&mut broker, &snapshot, &store, json!({"op":"subscribe","handle":a,"resource":"jobs","limit":50}))["value"].clone();
        for _ in 0..100 { broker.journal.record(&id, "terminal", "completed"); }
        let reply = call(&mut broker, &snapshot, &store, json!({"op":"events","handle":a,"subscription":stream["subscription"],"cursor":stream["cursor"]}));
        assert_eq!(reply["ok"], true); assert_eq!(reply["value"]["resync"], true); assert!(reply["value"]["snapshot"].is_object()); assert_eq!(reply["value"]["events"], json!([])); assert!(reply.to_string().len() < MAX_RESULT);
    }
    #[test]
    fn inventory_read_only_dtos_window_denial_project_removal_and_subscription_bounds() {
        let (mut broker, snapshot, store) = fixture();
        let a = capture(&mut broker, &snapshot, &store, Some("A"));
        for (resource, capability) in [("harnesses", "harnesses.inventory"), ("connections", "connections.summary"), ("jobs", "jobs.summary")] {
            assert_eq!(call(&mut broker, &snapshot, &store, query(&a, resource))["error"]["code"], "PermissionDenied");
            consent(&mut broker, &snapshot, &store, &a, capability, true);
            let result = call(&mut broker, &snapshot, &store, query(&a, resource)); assert_eq!(result["ok"], true);
            for secret in ["private", "TRANSCRIPT", "path", "secret_env", "pid", "token"] { assert!(!result.to_string().contains(secret)); }
        }
        let subscribe = json!({"op":"subscribe","handle":a,"resource":"jobs","limit":10});
        for _ in 0..5 { assert_eq!(call(&mut broker, &snapshot, &store, subscribe.clone())["ok"], true); }
        assert_eq!(call(&mut broker, &snapshot, &store, subscribe.clone())["error"]["code"], "LimitExceeded");
        let id = broker.subscriptions.keys().next().unwrap().clone(); let cursor = broker.subscriptions[&id].cursor.clone();
        let poll = json!({"op":"events","handle":a,"subscription":id,"cursor":cursor});
        assert_eq!(broker.execute("second-window", &snapshot, &store, poll.clone(), Instant::now() + DEADLINE).unwrap_err(), "PermissionDenied");
        store.db.execute("DELETE FROM projects WHERE id='A'", []).unwrap();
        assert_eq!(call(&mut broker, &snapshot, &store, poll)["error"]["code"], "NotFound");
        assert!(broker.subscriptions.is_empty());
        call(&mut broker, &snapshot, &store, json!({"op":"release","handle":a})); assert!(broker.subscriptions.is_empty());
    }
    #[tokio::test]
    async fn stalled_native_worker_finishes_with_the_same_non_echoing_timeout_envelope() {
        let reply = bounded_reply(Duration::from_millis(10), std::future::pending::<Result<Value, ()>>()).await;
        assert_eq!(reply, failure("Timeout"));
        assert_eq!(bounded_reply(DEADLINE, std::future::ready(Err::<Value, _>("/private/SECRET"))).await, failure("HostUnavailable"));
    }
    #[test]
    fn captured_a_never_retargets_b_and_summary_dtos_are_paginated_and_redacted() {
        let (mut broker, snapshot, store) = fixture();
        let a = capture(&mut broker, &snapshot, &store, Some("A"));
        let b = capture(&mut broker, &snapshot, &store, Some("B"));
        consent(&mut broker, &snapshot, &store, &a, "projects.summary", true);
        consent(&mut broker, &snapshot, &store, &a, "tasks.summary", true);
        let project = call(&mut broker, &snapshot, &store, query(&a, "projects"));
        assert_eq!(project["value"]["items"], json!([{"id":"A","name":"Alpha"}]));
        let first = call(&mut broker, &snapshot, &store, query(&a, "tasks"));
        assert_eq!(first["value"]["items"], json!([{"id":"a1","projectId":"A","status":"pending"}]));
        assert_eq!(first["value"]["schemaVersion"], 1); assert_eq!(first["value"]["nextCursor"], 1);
        let mut next = query(&a, "tasks"); next["cursor"] = json!(1); next["revision"] = first["value"]["revision"].clone();
        assert_eq!(call(&mut broker, &snapshot, &store, next.clone())["value"]["items"][0]["id"], "a2");
        assert_eq!(call(&mut broker, &snapshot, &store, query(&b, "tasks"))["error"]["code"], "PermissionDenied");
        for text in [project.to_string(), first.to_string()] { for secret in ["private", "credential", "TRANSCRIPT", "title", "path", "model"] { assert!(!text.contains(secret), "{secret}"); } }
        store.db.execute("UPDATE sessions SET status='completed' WHERE id='a1'", []).unwrap();
        assert_eq!(call(&mut broker, &snapshot, &store, next)["error"]["code"], "StaleContext");
        store.db.execute("DELETE FROM projects WHERE id='A'", []).unwrap();
        assert_eq!(call(&mut broker, &snapshot, &store, query(&a, "projects"))["error"]["code"], "NotFound");
    }
    #[test]
    fn native_identity_scope_revocation_and_lifecycle_fail_closed() {
        let (mut broker, mut snapshot, store) = fixture();
        let a = capture(&mut broker, &snapshot, &store, Some("A"));
        let request = query(&a, "projects");
        assert_eq!(call(&mut broker, &snapshot, &store, request.clone())["error"]["code"], "PermissionDenied");
        consent(&mut broker, &snapshot, &store, &a, "projects.summary", true);
        for label in ["tray", "launcher", "agents-dock", "main-forged", ""] { assert_eq!(broker.execute(label, &snapshot, &store, request.clone(), Instant::now() + DEADLINE).unwrap_err(), "PermissionDenied"); }
        for key in ["extensionId", "windowId", "projectId", "sessionId", "context"] {
            let mut forged = request.clone(); forged[key] = json!("B"); assert_eq!(call(&mut broker, &snapshot, &store, forged)["error"]["code"], "InvalidShape");
        }
        let forged = json!({"op":"capture","id":"sample.project-context/header","version":"1.0.0","context":{"schemaVersion":1,"windowId":"main","surfaceId":"panda.workspace.header.actions","revision":1,"projectId":"B","sessionId":"a1"}});
        assert_eq!(call(&mut broker, &snapshot, &store, forged)["error"]["code"], "PermissionDenied");
        consent(&mut broker, &snapshot, &store, &a, "projects.summary", false);
        assert_eq!(call(&mut broker, &snapshot, &store, request.clone())["error"]["code"], "PermissionDenied");
        consent(&mut broker, &snapshot, &store, &a, "projects.summary", true);
        snapshot.packages[0].enabled = false;
        assert_eq!(call(&mut broker, &snapshot, &store, request.clone())["error"]["code"], "PermissionDenied");
        snapshot.packages[0].enabled = true; snapshot.packages[0].manifest["version"] = json!("2.0.0");
        assert_eq!(call(&mut broker, &snapshot, &store, request)["error"]["code"], "PermissionDenied");
    }
    #[test]
    fn disabling_invalidates_old_handles_and_consent_without_affecting_other_owners() {
        let (mut broker, snapshot, store) = fixture();
        let handle = capture(&mut broker, &snapshot, &store, Some("A"));
        consent(&mut broker, &snapshot, &store, &handle, "projects.summary", true);
        broker.invalidate(Some("another.owner"));
        assert_eq!(call(&mut broker, &snapshot, &store, query(&handle, "projects"))["ok"], true);
        broker.invalidate(Some("sample.project-context"));
        assert_eq!(call(&mut broker, &snapshot, &store, query(&handle, "projects"))["error"]["code"], "StaleContext");
        let handle = capture(&mut broker, &snapshot, &store, Some("A"));
        assert_eq!(call(&mut broker, &snapshot, &store, query(&handle, "projects"))["error"]["code"], "PermissionDenied");
        consent(&mut broker, &snapshot, &store, &handle, "projects.summary", true);
        broker.invalidate(None); assert!(broker.handles.is_empty()); assert!(broker.grants.is_empty());
    }
    #[test]
    fn no_project_limits_expiry_timeout_and_errors_have_fixed_bounded_envelopes() {
        let (mut broker, snapshot, store) = fixture();
        let none = capture(&mut broker, &snapshot, &store, None);
        consent(&mut broker, &snapshot, &store, &none, "projects.summary", true);
        assert_eq!(call(&mut broker, &snapshot, &store, query(&none, "projects"))["value"]["state"], "NoProject");
        let a = capture(&mut broker, &snapshot, &store, Some("A"));
        consent(&mut broker, &snapshot, &store, &a, "projects.summary", true);
        let mut oversized = query(&a, "projects"); oversized["limit"] = json!(51);
        assert_eq!(call(&mut broker, &snapshot, &store, oversized)["error"]["code"], "LimitExceeded");
        store.db.execute("UPDATE projects SET name=?1 WHERE id='A'", ["S".repeat(257)]).unwrap();
        assert_eq!(call(&mut broker, &snapshot, &store, query(&a, "projects"))["error"]["code"], "LimitExceeded");
        let timeout = envelope(broker.execute("main", &snapshot, &store, query(&a, "projects"), Instant::now() - Duration::from_secs(1)));
        assert_eq!(timeout, failure("Timeout")); assert!(timeout.to_string().len() < 128);
        assert_eq!(envelope(Ok(json!("credential-root".repeat(MAX_RESULT)))), failure("LimitExceeded"));
        broker.handles.get_mut(&a).unwrap().expires = Instant::now() - Duration::from_secs(1);
        assert_eq!(call(&mut broker, &snapshot, &store, query(&a, "projects"))["error"]["code"], "StaleContext");
        for _ in 0..MAX_HANDLES { let _ = capture(&mut broker, &snapshot, &store, None); if broker.handles.len() == MAX_HANDLES { break; } }
        assert_eq!(broker.handles.len(), MAX_HANDLES);
    }
}
