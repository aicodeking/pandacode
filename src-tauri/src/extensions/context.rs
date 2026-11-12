//! Host-owned, read-only captured context. No extension identity or core storage DTO crosses IPC.
use super::{contracts, packages::{ExtensionPackages, Snapshot}};
use super::inventory;
use crate::storage::Store;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
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
    Subscribe { handle: String, resource: String, limit: u32 },
    Events { handle: String, subscription: String, cursor: String },
    Unsubscribe { handle: String, subscription: String },
    Release { handle: String },
}
#[derive(Clone)]
struct Invocation { id: String, version: String, owner: String, context: Value, expires: Instant }
#[derive(Default)]
struct Broker { handles: BTreeMap<String, Invocation>, grants: BTreeSet<(String, String, String, String)>, subscriptions: BTreeMap<String, Subscription>, journal: inventory::Journal }
struct Subscription { handle: String, resource: String, limit: u32, offset: u64, cursor: String, sequence: u64, snapshot: Value }
#[derive(Default)]
pub struct ContextBroker { broker: Mutex<Broker>, busy: Arc<AtomicBool> }
/// Called only by the existing owned-agent lifecycle. Text/data/tool payloads never enter the stream.
pub fn record_job(app: &tauri::AppHandle, id: &str, kind: &str, status: &str) {
    if let Ok(mut broker) = app.state::<ContextBroker>().broker.lock() {
        if broker.subscriptions.values().any(|stream| stream.resource == "jobs") { broker.journal.record(id, kind, status); }
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
/// Declarative authentication: identity comes from the installed command, not JS fields.
fn owner(snapshot: &Snapshot, id: &str, version: &str, context: &Value) -> Reply {
    if snapshot.safe_mode || context["windowId"] != "main" || id.len() > 160 || version.len() > 32 { return Err("PermissionDenied"); }
    if contracts::validate_contract("context", context)["ok"] != true { return Err("InvalidShape"); }
    let enabled: Vec<_> = snapshot.packages.iter().filter(|package| package.enabled).map(|package| package.manifest.clone()).collect();
    if contracts::validate_contract("packages", &json!(enabled))["ok"] != true { return Err("PermissionDenied"); }
    for manifest in &enabled {
        if manifest["version"] != version { continue; }
        let contributes = &manifest["contributes"];
        let command_id = if matches!(context["surfaceId"].as_str(), Some("panda.commands" | "panda.shortcuts")) { Some(json!(id)) } else {
            contributes["menus"].as_array().into_iter().flatten().filter(|menu| menu["location"] == context["surfaceId"] && allowed(menu, context) && !matches!(menu["presentation"].as_str(), Some("status" | "badge"))).find_map(|menu| {
                if let Some(items) = menu["items"].as_array() { leaf(items, id, context).map(|item| item["command"].clone()) }
                else { (menu["id"] == id).then(|| menu["command"].clone()) }
            })
        };
        if contributes["commands"].as_array().into_iter().flatten().any(|command| Some(&command["id"]) == command_id.as_ref() && command["action"]["kind"] == "showProjectContext" && allowed(command, context)) {
            return Ok(manifest.clone());
        }
    }
    Err("PermissionDenied")
}
fn project_id(context: &Value) -> &str { context["projectId"].as_str().unwrap_or("") }
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
    }
    fn execute(&mut self, label: &str, snapshot: &Snapshot, store: &Store, raw: Value, deadline: Instant) -> Reply {
        if label != "main" { return Err("PermissionDenied"); }
        if raw.to_string().len() > 8192 { return Err("LimitExceeded"); }
        let request: Request = serde_json::from_value(raw).map_err(|_| "InvalidShape")?;
        self.handles.retain(|_, invocation| invocation.expires > Instant::now());
        self.subscriptions.retain(|_, subscription| self.handles.contains_key(&subscription.handle));
        if Instant::now() >= deadline { return Err("Timeout"); }
        if let Request::Capture { id, version, context } = request {
            let manifest = owner(snapshot, &id, &version, &context)?;
            // No forged project/task pair, even before consent. A projectless task is null context.
            if let Some(session) = context["sessionId"].as_str() {
                let actual: String = store.db.query_row("SELECT project_id FROM sessions WHERE id=?1", [session], |row| row.get(0)).optional().map_err(|_| "HostUnavailable")?.ok_or("NotFound")?;
                if actual != project_id(&context) { return Err("PermissionDenied"); }
            }
            if self.handles.len() >= MAX_HANDLES { return Err("LimitExceeded"); }
            let handle = uuid::Uuid::new_v4().to_string();
            let owner = manifest["id"].as_str().ok_or("PermissionDenied")?.to_owned();
            self.handles.insert(handle.clone(), Invocation { id, version, owner: owner.clone(), context, expires: Instant::now() + LIFETIME });
            return Ok(json!({"schemaVersion":1,"handle":handle,"owner":owner}));
        }
        let handle = match &request { Request::Consent { handle, .. } | Request::Query { handle, .. } | Request::Subscribe { handle, .. } | Request::Events { handle, .. } | Request::Unsubscribe { handle, .. } | Request::Release { handle } => handle, _ => unreachable!() };
        if handle.len() > 64 { return Err("LimitExceeded"); }
        if matches!(request, Request::Release { .. }) { self.handles.remove(handle); self.subscriptions.retain(|_, subscription| &subscription.handle != handle); return Ok(Value::Null); }
        let invocation = self.handles.get(handle).ok_or("StaleContext")?.clone();
        let manifest = owner(snapshot, &invocation.id, &invocation.version, &invocation.context)?;
        if manifest["id"] != invocation.owner { return Err("PermissionDenied"); }
        let key = |capability: &str| (invocation.owner.clone(), invocation.version.clone(), project_id(&invocation.context).to_owned(), capability.to_owned());
        match request {
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
            Request::Subscribe { handle, resource, limit } => {
                let capability = inventory::capability(&resource).ok_or("UnsupportedCapability")?;
                if !manifest["permissions"].as_array().is_some_and(|permissions| permissions.iter().any(|item| item == capability)) || !self.grants.contains(&key(capability)) { return Err("PermissionDenied"); }
                if limit == 0 || limit > 50 || self.subscriptions.len() >= 64 || self.subscriptions.values().filter(|subscription| subscription.handle == handle).count() >= 5 { return Err("LimitExceeded"); }
                let page = summaries(store, &invocation, &resource, limit, 0, None)?;
                let subscription = uuid::Uuid::new_v4().to_string(); let cursor = uuid::Uuid::new_v4().to_string();
                self.subscriptions.insert(subscription.clone(), Subscription { handle, resource, limit, offset: self.journal.cursor, cursor: cursor.clone(), sequence: 0, snapshot: page.clone() });
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
    if state.busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return failure("Timeout"); }
    struct Permit(Arc<AtomicBool>);
    impl Drop for Permit { fn drop(&mut self) { self.0.store(false, Ordering::Release); } }
    let permit = Permit(state.busy.clone());
    let deadline = Instant::now() + DEADLINE;
    let work = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let result = (|| {
            let packages = app.state::<ExtensionPackages>();
            let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
            let snapshot = packages.snapshot();
            let state = app.state::<crate::AppState>();
            let store = state.store.try_lock().map_err(|_| "Timeout")?;
            let broker = app.state::<ContextBroker>();
            let mut broker = broker.broker.try_lock().map_err(|_| "Timeout")?;
            broker.execute("main", &snapshot, &store, request, deadline)
        })();
        if Instant::now() >= deadline { failure("Timeout") } else { envelope(result) }
    });
    bounded_reply(DEADLINE, work).await
}
async fn bounded_reply<E>(duration: Duration, work: impl std::future::Future<Output = Result<Value, E>>) -> Value {
    match tokio::time::timeout(duration, work).await { Ok(Ok(value)) => value, Ok(Err(_)) => failure("HostUnavailable"), Err(_) => failure("Timeout") }
}

#[cfg(test)]
mod tests {
    use super::*;
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
