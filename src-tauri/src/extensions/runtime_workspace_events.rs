//! Ordered, scoped workspace events for background services (`events.workspace`, runtime phase R2, slice R0202).
//!
//! The app reports what happened (a task was created, a turn finished, a project closed, a window gained focus) with
//! `WorkspaceEvents::publish`. Each running service that holds the `events.workspace` grant and subscribed to the
//! kind gets its own bounded queue; `next_frame` turns the queue into the envelopes the service receives, in order.
//! Everything here is for predictability and fault isolation, never for trust:
//! - an envelope is `{schemaVersion: 1, kind, sequence, at, ...ids}` and carries ids only, never content;
//! - an event of a project outside the grant's `projects` is never queued (and is checked again when it leaves the
//!   queue, so a narrowed grant stops delivery at once);
//! - at most `QUEUE_LIMIT` events wait per service: on overflow the oldest are dropped and one `gap` event, carrying
//!   the count, tells the service to read the state again;
//! - `sequence` counts the envelopes of one service connection (gap markers included) and is assigned when an
//!   envelope leaves the queue, so a consumer sees every number exactly once, in order, and a jump never happens.
//!
//! The state is pure (no I/O, an injected clock) so ordering, bounds and cleanup are deterministic to test; the
//! process loop that writes the frames is in `runtime_service_lifetime.rs`, and `src/extensions/runtime-workspace-events.ts`
//! mirrors the rules for the browser preview.
use serde_json::{json, Map, Value};
use std::{collections::{BTreeMap, BTreeSet, VecDeque}, sync::{Arc, Mutex}};
use tokio::sync::Notify;

/// The permission a package must hold to receive workspace events.
pub const PERMISSION: &str = "events.workspace";
/// Events waiting per service before the oldest are dropped.
pub const QUEUE_LIMIT: usize = 256;
/// The thirteen workspace events; `gap` is the marker and is subscribed to like a kind.
pub const KINDS: [&str; 13] = [
    "task.created", "task.removed", "task.shown", "task.stopped", "task.idle", "task.compacted",
    "turn.started", "turn.finished", "turn.failed", "project.opened", "project.closed", "settings.changed", "app.focus",
];
pub const GAP: &str = "gap";

pub type Result<T> = std::result::Result<T, &'static str>;
/// `(package, version, project)`: may this package receive events of this project? `project: None` asks whether the
/// package holds the permission at all (for events that belong to no project, and for subscribing).
pub type Gate = Arc<dyn Fn(&str, &str, Option<&str>) -> bool + Send + Sync>;

/// `true` for one of the thirteen kinds or `gap`.
pub fn subscribable(kind: &str) -> bool { kind == GAP || KINDS.contains(&kind) }

fn identifier(value: &Value) -> bool { value.as_str().is_some_and(|text| !text.is_empty() && text.len() <= 128 && !text.chars().any(char::is_control)) }
fn starter(value: &Value) -> bool {
    matches!(value.as_str(), Some("user" | "bot" | "schedule" | "team"))
        || value.as_object().is_some_and(|object| object.len() == 1 && object.get("package").is_some_and(identifier))
}
fn by(value: &Value) -> bool { value.as_str() == Some("user") || value.as_object().is_some_and(|object| object.len() == 1 && object.get("package").is_some_and(identifier)) }
fn nullable(value: &Value) -> bool { value.is_null() || identifier(value) }

/// The fields of each kind, with the check of each. Every key must be present and no other may be.
type Check = fn(&Value) -> bool;
type Spec = &'static [(&'static str, Check)];
fn fields(kind: &str) -> Option<Spec> {
    const TASK: Spec =&[("taskId", identifier), ("projectId", identifier)];
    Some(match kind {
        "task.created" => &[("taskId", identifier), ("projectId", identifier), ("harness", identifier), ("startedBy", starter)],
        "task.removed" | "task.idle" | "task.compacted" => TASK,
        "task.shown" => &[("windowId", identifier), ("taskId", nullable), ("projectId", nullable)],
        "task.stopped" => &[("taskId", identifier), ("projectId", identifier), ("by", by)],
        "turn.started" | "turn.finished" | "turn.failed" => &[("taskId", identifier), ("projectId", identifier), ("index", |value| value.is_u64())],
        "project.opened" | "project.closed" => &[("projectId", identifier)],
        "settings.changed" => &[("page", identifier), ("revision", |value| value.is_u64())],
        "app.focus" => &[("focused", |value| value.is_boolean())],
        _ => return None,
    })
}

/// Checks what the app reports: `{kind, ...fields}` with exactly the fields of the kind, ids only. Answers the
/// kind and the project it belongs to (`None` for a project-less event).
pub fn validate(raw: &Value) -> Result<(String, Option<String>)> {
    let object = raw.as_object().ok_or("InvalidShape")?;
    let kind = object.get("kind").and_then(Value::as_str).ok_or("InvalidShape")?;
    let spec = fields(kind).ok_or("InvalidShape")?;
    if object.len() != spec.len() + 1 || !spec.iter().all(|(name, check)| object.get(*name).is_some_and(check)) { return Err("InvalidShape"); }
    Ok((kind.to_owned(), object.get("projectId").and_then(Value::as_str).map(str::to_owned)))
}

struct Queued { kind: String, project: Option<String>, at: u64, body: Map<String, Value> }
struct Subscription {
    version: String, generation: u64, kinds: BTreeSet<String>,
    queue: VecDeque<Queued>, dropped: u64, dropped_at: u64, next: u64, wake: Arc<Notify>,
}
#[derive(Default)]
struct Inner { services: BTreeMap<String, Subscription> }

/// What a delivery pass did, for the counters of the Running list and the tests.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Published { pub queued: usize, pub dropped: usize }

/// Every service's subscription and queue. Managed beside `ServiceLifetime`; a service exists here only while its
/// process runs.
#[derive(Default)]
pub struct WorkspaceEvents { inner: Mutex<Inner>, gate: Mutex<Option<Gate>> }

impl WorkspaceEvents {
    /// Installs the grant check. Without one nothing is delivered (fail closed for the gate, not a trust decision).
    pub fn set_gate(&self, gate: Gate) { if let Ok(mut slot) = self.gate.lock() { *slot = Some(gate); } }
    fn gate(&self) -> Option<Gate> { self.gate.lock().ok().and_then(|slot| slot.clone()) }

    /// A service process started: an empty subscription of this `generation`. A stale predecessor is replaced.
    pub fn attach(&self, owner: &str, version: &str, generation: u64) -> Arc<Notify> {
        let wake = Arc::new(Notify::new());
        if let Ok(mut inner) = self.inner.lock() {
            inner.services.insert(owner.to_owned(), Subscription { version: version.to_owned(), generation, kinds: BTreeSet::new(), queue: VecDeque::new(), dropped: 0, dropped_at: 0, next: 0, wake: wake.clone() });
        }
        wake
    }
    /// The service ended (stop, crash, disable, safe mode): no listener and no queued event stays. A newer
    /// generation of the same package is left alone.
    pub fn detach(&self, owner: &str, generation: u64) {
        if let Ok(mut inner) = self.inner.lock() { if inner.services.get(owner).is_some_and(|sub| sub.generation == generation) { inner.services.remove(owner); } }
    }
    /// Kinds `owner` listens to now.
    pub fn listeners(&self, owner: &str) -> usize { self.inner.lock().ok().and_then(|inner| inner.services.get(owner).map(|sub| sub.kinds.len())).unwrap_or(0) }
    pub fn pending(&self, owner: &str) -> usize { self.inner.lock().ok().and_then(|inner| inner.services.get(owner).map(|sub| sub.queue.len())).unwrap_or(0) }
    /// Services currently attached (zero once every service has stopped).
    pub fn attached(&self) -> usize { self.inner.lock().map(|inner| inner.services.len()).unwrap_or(0) }

    /// `events.on`: the service starts listening to `kind`. `PermissionDenied` without the grant, `InvalidShape` for
    /// a name that is not an event.
    pub fn subscribe(&self, owner: &str, kind: &str) -> Result<()> {
        if !subscribable(kind) { return Err("InvalidShape"); }
        let mut inner = self.inner.lock().map_err(|_| "HostUnavailable")?;
        let sub = inner.services.get_mut(owner).ok_or("HostUnavailable")?;
        if !self.gate().is_some_and(|gate| gate(owner, &sub.version, None)) { return Err("PermissionDenied"); }
        sub.kinds.insert(kind.to_owned());
        Ok(())
    }
    /// The last handler of `kind` was disposed. Events of that kind already queued are discarded.
    pub fn unsubscribe(&self, owner: &str, kind: &str) -> Result<()> {
        let mut inner = self.inner.lock().map_err(|_| "HostUnavailable")?;
        let sub = inner.services.get_mut(owner).ok_or("HostUnavailable")?;
        sub.kinds.remove(kind);
        sub.queue.retain(|queued| queued.kind != kind);
        Ok(())
    }

    /// Reports one event (`at` is unix milliseconds). It is queued for every service that listens to its kind and
    /// whose grant reaches its project; `only` limits it to one package (a package's own settings change).
    pub fn publish(&self, raw: &Value, only: Option<&str>, at: u64) -> Result<Published> {
        let (kind, project) = validate(raw)?;
        let body: Map<String, Value> = raw.as_object().into_iter().flatten().filter(|(name, _)| name.as_str() != "kind").map(|(name, value)| (name.clone(), value.clone())).collect();
        let gate = self.gate();
        let mut outcome = Published::default();
        let mut inner = self.inner.lock().map_err(|_| "HostUnavailable")?;
        for (owner, sub) in inner.services.iter_mut() {
            if only.is_some_and(|only| only != owner) || !sub.kinds.contains(&kind) { continue; }
            if !gate.as_ref().is_some_and(|gate| gate(owner, &sub.version, project.as_deref())) { continue; }
            if sub.queue.len() >= QUEUE_LIMIT {
                sub.queue.pop_front();
                sub.dropped += 1; sub.dropped_at = at; outcome.dropped += 1;
            }
            sub.queue.push_back(Queued { kind: kind.clone(), project: project.clone(), at, body: body.clone() });
            outcome.queued += 1;
            sub.wake.notify_one();
        }
        Ok(outcome)
    }

    /// The next envelope for `owner`, or `None` when nothing waits. A pending loss comes first, as one `gap`
    /// (when the service listens to `gap`), so the service reads the state again before the newer events.
    /// An event whose project the grant no longer reaches is discarded here.
    pub fn next_frame(&self, owner: &str) -> Option<Value> {
        let gate = self.gate();
        let mut inner = self.inner.lock().ok()?;
        let sub = inner.services.get_mut(owner)?;
        if sub.dropped > 0 {
            let (dropped, at) = (std::mem::take(&mut sub.dropped), sub.dropped_at);
            if sub.kinds.contains(GAP) { sub.next += 1; return Some(json!({"schemaVersion": 1, "kind": GAP, "sequence": sub.next, "at": at, "dropped": dropped})); }
        }
        while let Some(queued) = sub.queue.pop_front() {
            if !sub.kinds.contains(&queued.kind) || !gate.as_ref().is_some_and(|gate| gate(owner, &sub.version, queued.project.as_deref())) { continue; }
            sub.next += 1;
            let mut envelope = Map::new();
            envelope.insert("schemaVersion".into(), json!(1));
            envelope.insert("kind".into(), json!(queued.kind));
            envelope.insert("sequence".into(), json!(sub.next));
            envelope.insert("at".into(), json!(queued.at));
            envelope.extend(queued.body);
            return Some(Value::Object(envelope));
        }
        None
    }
}

/// The gate of the app: the grants file answers every question, natively, on every delivery. A project asks the
/// `events.workspace` grant for that project; no project asks whether the package holds the grant at all.
pub fn grants_gate(app: &tauri::AppHandle) -> Gate {
    use crate::extensions::runtime_grants::RuntimeGrants;
    use tauri::Manager;
    let app = app.clone();
    Arc::new(move |owner, version, project| app.try_state::<RuntimeGrants>().is_some_and(|grants| allowed(&grants, owner, version, project)))
}

/// One question of the gate against the grants file.
pub fn allowed(grants: &crate::extensions::runtime_grants::RuntimeGrants, owner: &str, version: &str, project: Option<&str>) -> bool {
    use crate::extensions::runtime_grants::Target;
    match project {
        Some(project) => grants.check(owner, version, PERMISSION, &Target::project(project)).is_ok(),
        None => grants.projection()["packages"].as_array().into_iter().flatten().any(|package| {
            package["id"] == owner && package["version"] == version && package["authorized"] == true
                && package["grants"].as_array().into_iter().flatten().any(|grant| grant["permission"] == PERMISSION)
        }),
    }
}

/// Reports one event from anywhere in the app (the agent event sink, project and window handlers). A malformed
/// event or a missing manager is dropped: a report never fails the thing that happened.
pub fn publish_app(app: &tauri::AppHandle, event: &Value, only: Option<&str>) {
    use tauri::Manager;
    if let Some(services) = app.try_state::<crate::extensions::runtime_service_lifetime::ServiceLifetime>() { let _ = services.events().publish(event, only, now_millis()); }
}

/// The project a task belongs to. Taken with the store's ordinary lock, never while the caller holds it.
fn project_of(app: &tauri::AppHandle, session_id: &str) -> Option<String> {
    use tauri::Manager;
    let state = app.try_state::<crate::AppState>()?;
    let store = state.store.lock().ok()?;
    store.session(session_id).ok().map(|task| task.project_id)
}
static TURNS: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());

/// The app's own reports. Each is one line at the place where the thing happens, and never fails it.
pub fn project_opened(app: &tauri::AppHandle, project_id: &str) { publish_app(app, &json!({"kind": "project.opened", "projectId": project_id}), None); }
pub fn project_closed(app: &tauri::AppHandle, project_id: &str) { publish_app(app, &json!({"kind": "project.closed", "projectId": project_id}), None); }
pub fn app_focus(app: &tauri::AppHandle, focused: bool) { publish_app(app, &json!({"kind": "app.focus", "focused": focused}), None); }
pub fn task_created(app: &tauri::AppHandle, task_id: &str, project_id: &str, harness: &str) {
    publish_app(app, &json!({"kind": "task.created", "taskId": task_id, "projectId": project_id, "harness": harness, "startedBy": "user"}), None);
}
pub fn task_removed(app: &tauri::AppHandle, task_id: &str, project_id: &str) { publish_app(app, &json!({"kind": "task.removed", "taskId": task_id, "projectId": project_id}), None); }
/// A window now shows `task_id` (or nothing); `project_id` is looked up for a task.
pub fn task_shown(app: &tauri::AppHandle, window_id: &str, task_id: Option<&str>) {
    let project = task_id.and_then(|task| project_of(app, task));
    publish_app(app, &json!({"kind": "task.shown", "windowId": window_id, "taskId": task_id, "projectId": project}), None);
}
pub fn task_compacted(app: &tauri::AppHandle, task_id: &str) {
    if let Some(project) = project_of(app, task_id) { publish_app(app, &json!({"kind": "task.compacted", "taskId": task_id, "projectId": project}), None); }
}
static COMPACTIONS: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
/// The agent event sink calls this for every event with a tool: a provider's completed "Compact context" step is the
/// host's record of a finished compaction, reported once per step however often the step updates.
pub fn observe_tool(app: &tauri::AppHandle, session_id: &str, tool_id: &str, name: &str, status: &str) {
    if name != "Compact context" || status != "completed" { return; }
    let first = COMPACTIONS.lock().is_ok_and(|mut seen| { if seen.len() > 1024 { seen.clear(); } seen.insert(format!("{session_id}/{tool_id}")) });
    if first { task_compacted(app, session_id); }
}

/// The window now shows `session_id` (the webview reports the visible task; main window only).
#[tauri::command]
pub fn extensions_workspace_task_shown(app: tauri::AppHandle, window: tauri::WebviewWindow, session_id: Option<String>) {
    if window.label() == "main" { task_shown(&app, window.label(), session_id.as_deref()); }
}
/// A run of `session_id` began: `turn.started` with the next index of that task.
pub fn turn_started(app: &tauri::AppHandle, session_id: &str) {
    let Some(project) = project_of(app, session_id) else { return };
    let index = TURNS.lock().ok().map_or(0, |mut turns| { let next = turns.entry(session_id.to_owned()).or_insert(0); *next += 1; *next });
    publish_app(app, &json!({"kind": "turn.started", "taskId": session_id, "projectId": project, "index": index}), None);
}
/// The run ended: `turn.finished` (then `task.idle`), `turn.failed`, or a stop by the user (`task.stopped`, then idle).
pub fn turn_ended(app: &tauri::AppHandle, session_id: &str, successful: bool, stopped: bool) {
    let Some(project) = project_of(app, session_id) else { return };
    let index = TURNS.lock().ok().map_or(0, |turns| turns.get(session_id).copied().unwrap_or(0));
    if stopped { publish_app(app, &json!({"kind": "task.stopped", "taskId": session_id, "projectId": project, "by": "user"}), None); }
    else if successful { publish_app(app, &json!({"kind": "turn.finished", "taskId": session_id, "projectId": project, "index": index}), None); }
    else { publish_app(app, &json!({"kind": "turn.failed", "taskId": session_id, "projectId": project, "index": index}), None); }
    publish_app(app, &json!({"kind": "task.idle", "taskId": session_id, "projectId": project}), None);
}
/// A task is gone: its turn counter goes with it.
pub fn forget_task(session_id: &str) { if let Ok(mut turns) = TURNS.lock() { turns.remove(session_id); } }

/// The host to service frame of one envelope: one way, ordered by the pipe, never answered.
pub fn event_frame(envelope: &Value) -> Value { json!({"event": envelope}) }

/// Unix milliseconds now.
pub fn now_millis() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64) }

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(allowed: &'static [&'static str]) -> Gate {
        Arc::new(move |_, _, project| project.is_none_or(|project| allowed.contains(&project)))
    }
    fn hub(allowed: &'static [&'static str], kinds: &[&str]) -> WorkspaceEvents {
        let hub = WorkspaceEvents::default();
        hub.set_gate(gate(allowed));
        hub.attach("sample.pkg", "1.0.0", 1);
        for kind in kinds { hub.subscribe("sample.pkg", kind).unwrap(); }
        hub
    }
    fn drain(hub: &WorkspaceEvents) -> Vec<Value> { std::iter::from_fn(|| hub.next_frame("sample.pkg")).collect() }
    fn turn(kind: &str, project: &str, index: u64) -> Value { json!({"kind": kind, "taskId": "t1", "projectId": project, "index": index}) }

    #[test]
    fn every_kind_has_an_exact_content_free_shape() {
        let good = [
            json!({"kind": "task.created", "taskId": "t", "projectId": "p", "harness": "claude", "startedBy": {"package": "a.b"}}),
            json!({"kind": "task.created", "taskId": "t", "projectId": "p", "harness": "claude", "startedBy": "schedule"}),
            json!({"kind": "task.removed", "taskId": "t", "projectId": "p"}),
            json!({"kind": "task.shown", "windowId": "w", "taskId": null, "projectId": null}),
            json!({"kind": "task.stopped", "taskId": "t", "projectId": "p", "by": "user"}),
            json!({"kind": "task.idle", "taskId": "t", "projectId": "p"}),
            json!({"kind": "task.compacted", "taskId": "t", "projectId": "p"}),
            turn("turn.started", "p", 1), turn("turn.finished", "p", 1), turn("turn.failed", "p", 2),
            json!({"kind": "project.opened", "projectId": "p"}), json!({"kind": "project.closed", "projectId": "p"}),
            json!({"kind": "settings.changed", "page": "main", "revision": 3}),
            json!({"kind": "app.focus", "focused": true}),
        ];
        assert_eq!(good.len(), KINDS.len() + 1);
        for event in &good { assert!(validate(event).is_ok(), "{event}"); }
        for bad in [
            json!(null), json!({}), json!({"kind": "gap", "dropped": 1}), json!({"kind": "task.created"}),
            json!({"kind": "task.removed", "taskId": "t", "projectId": "p", "title": "content"}),
            json!({"kind": "task.removed", "taskId": "t"}),
            json!({"kind": "task.removed", "taskId": "", "projectId": "p"}),
            json!({"kind": "task.removed", "taskId": "t", "projectId": "x".repeat(129)}),
            json!({"kind": "task.stopped", "taskId": "t", "projectId": "p", "by": "bot"}),
            json!({"kind": "task.created", "taskId": "t", "projectId": "p", "harness": "h", "startedBy": {"package": "a", "x": 1}}),
            turn("turn.started", "p", 1).as_object().map(|object| { let mut object = object.clone(); object.insert("index".into(), json!(-1)); Value::Object(object) }).unwrap(),
            json!({"kind": "app.focus", "focused": "yes"}),
            json!({"kind": "nope"}),
        ] { assert_eq!(validate(&bad), Err("InvalidShape"), "{bad}"); }
    }

    #[test]
    fn delivery_is_ordered_scoped_to_the_subscription_and_numbered_without_holes() {
        let hub = hub(&["A"], &["turn.started", "turn.finished", "app.focus"]);
        hub.publish(&turn("turn.started", "A", 1), None, 10).unwrap();
        // Not subscribed, and outside the grant: neither is queued.
        assert_eq!(hub.publish(&json!({"kind": "task.idle", "taskId": "t", "projectId": "A"}), None, 11).unwrap(), Published::default());
        assert_eq!(hub.publish(&turn("turn.finished", "B", 1), None, 12).unwrap(), Published::default());
        hub.publish(&json!({"kind": "app.focus", "focused": false}), None, 13).unwrap();
        hub.publish(&turn("turn.finished", "A", 1), None, 14).unwrap();
        let events = drain(&hub);
        assert_eq!(events.iter().map(|event| event["kind"].as_str().unwrap()).collect::<Vec<_>>(), ["turn.started", "app.focus", "turn.finished"]);
        assert_eq!(events.iter().map(|event| event["sequence"].as_u64().unwrap()).collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(events[0], json!({"schemaVersion": 1, "kind": "turn.started", "sequence": 1, "at": 10, "taskId": "t1", "projectId": "A", "index": 1}));
        assert!(hub.next_frame("sample.pkg").is_none());
        // A narrowed grant also stops what is already queued.
        hub.publish(&turn("turn.started", "A", 2), None, 20).unwrap();
        hub.set_gate(gate(&[]));
        assert!(drain(&hub).is_empty(), "queued events of a project the grant no longer reaches are discarded");
    }

    #[test]
    fn a_project_less_event_needs_only_the_permission_and_only_reaches_the_named_package() {
        let hub = hub(&[], &["app.focus", "settings.changed"]);
        hub.attach("other.pkg", "1.0.0", 1); hub.subscribe("other.pkg", "settings.changed").unwrap();
        hub.publish(&json!({"kind": "app.focus", "focused": true}), None, 1).unwrap();
        hub.publish(&json!({"kind": "settings.changed", "page": "main", "revision": 2}), Some("sample.pkg"), 2).unwrap();
        assert_eq!(drain(&hub).len(), 2);
        assert_eq!(hub.pending("other.pkg"), 0, "another package's settings change is not ours to see");
    }

    #[test]
    fn two_hundred_fifty_seven_events_drop_the_oldest_and_one_gap_comes_first() {
        let hub = hub(&["A"], &["turn.started", "gap"]);
        for index in 0..QUEUE_LIMIT as u64 { hub.publish(&turn("turn.started", "A", index), None, 100 + index).unwrap(); }
        assert_eq!(hub.pending("sample.pkg"), QUEUE_LIMIT);
        let over = hub.publish(&turn("turn.started", "A", 256), None, 400).unwrap();
        assert_eq!(over, Published { queued: 1, dropped: 1 });
        let events = drain(&hub);
        assert_eq!(events.len(), QUEUE_LIMIT + 1, "one gap and the 256 newest");
        assert_eq!(events[0], json!({"schemaVersion": 1, "kind": "gap", "sequence": 1, "at": 400, "dropped": 1}));
        assert_eq!(events[1]["index"], 1, "the oldest event (index 0) is the one that was dropped");
        assert_eq!(events.last().unwrap()["index"], 256);
        assert_eq!(events.last().unwrap()["sequence"], 257);
        // A further burst accumulates into one gap, and an empty queue then stays quiet.
        for index in 0..QUEUE_LIMIT as u64 + 40 { hub.publish(&turn("turn.started", "A", index), None, 500).unwrap(); }
        let again = drain(&hub);
        assert_eq!(again[0]["dropped"], 40); assert_eq!(again.iter().filter(|event| event["kind"] == "gap").count(), 1);
        assert!(hub.next_frame("sample.pkg").is_none());
    }

    #[test]
    fn without_a_gap_listener_the_loss_still_costs_no_event_and_no_sequence_number() {
        let hub = hub(&["A"], &["turn.started"]);
        for index in 0..QUEUE_LIMIT as u64 + 5 { hub.publish(&turn("turn.started", "A", index), None, 1).unwrap(); }
        let events = drain(&hub);
        assert_eq!(events.len(), QUEUE_LIMIT);
        assert!(events.iter().all(|event| event["kind"] == "turn.started"));
        assert_eq!(events[0]["sequence"], 1);
    }

    #[test]
    fn subscribing_needs_the_grant_and_a_real_kind_and_unsubscribing_leaves_nothing() {
        let hub = hub(&["A"], &["turn.started"]);
        assert_eq!(hub.subscribe("sample.pkg", "task.content"), Err("InvalidShape"));
        assert_eq!(hub.subscribe("ghost", "turn.started"), Err("HostUnavailable"));
        let denied = WorkspaceEvents::default(); denied.attach("sample.pkg", "1.0.0", 1);
        assert_eq!(denied.subscribe("sample.pkg", "turn.started"), Err("PermissionDenied"), "no gate, no delivery");
        denied.set_gate(Arc::new(|_, _, _| false));
        assert_eq!(denied.subscribe("sample.pkg", "turn.started"), Err("PermissionDenied"));
        hub.subscribe("sample.pkg", "app.focus").unwrap();
        assert_eq!(hub.listeners("sample.pkg"), 2);
        hub.publish(&turn("turn.started", "A", 1), None, 1).unwrap();
        hub.unsubscribe("sample.pkg", "turn.started").unwrap();
        assert_eq!((hub.listeners("sample.pkg"), hub.pending("sample.pkg")), (1, 0), "queued events of the dropped kind go too");
        assert_eq!(hub.publish(&turn("turn.started", "A", 2), None, 2).unwrap(), Published::default());
    }

    #[test]
    fn detach_leaves_zero_listeners_and_a_stale_generation_cannot_detach_its_successor() {
        let hub = hub(&["A"], &["turn.started"]);
        hub.publish(&turn("turn.started", "A", 1), None, 1).unwrap();
        hub.attach("sample.pkg", "1.0.0", 2); hub.subscribe("sample.pkg", "app.focus").unwrap();
        hub.detach("sample.pkg", 1);
        assert_eq!((hub.attached(), hub.listeners("sample.pkg")), (1, 1), "the old generation ended after the new one began");
        hub.detach("sample.pkg", 2);
        assert_eq!((hub.attached(), hub.listeners("sample.pkg"), hub.pending("sample.pkg")), (0, 0, 0));
        assert_eq!(hub.publish(&turn("turn.started", "A", 3), None, 3).unwrap(), Published::default(), "nothing is delivered to nobody");
        assert!(hub.next_frame("sample.pkg").is_none());
    }

    #[test]
    fn the_frame_is_one_way() {
        assert_eq!(event_frame(&json!({"kind": "app.focus"})), json!({"event": {"kind": "app.focus"}}));
    }
}
