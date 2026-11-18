//! Saving host buffers through bounded package hooks (runtime phase R9, slice R0902).
//!
//! The host owns the buffer of every open file (R0901, `runtime_document_editors`) and is the only writer. This module
//! is the one path every save takes, whoever asked: the user's save (`trigger: "user"`), an auto-save (`"auto"`) and a
//! panel's `document.save()` (`"package"`). It does, in this order:
//!
//! 1. **Checks.** A read-only file answers `ReadOnly` and a pending disk conflict `Conflict` before any package is
//!    asked; nothing is formatted for a save that will be refused.
//! 2. **`onWillSave`.** Every package mount of the file gets one call to deliver a pending edit and the host waits at
//!    most 1 s ([`WILL_SAVE_WAIT_MS`]). A callback that throws or is slow never blocks the save.
//! 3. **`save.before`.** For a text buffer, the attached `save.before` hooks whose `match.extensions` accepts the path
//!    and whose package holds `documents.editors` for the project are asked one after another in the user's package
//!    order (R0506 [`resolution::ask_member`]: each inside its `budgetMs`, at most 10 s, all inside 60 s; a package
//!    removed meanwhile is skipped, not failed). Each is given the text the earlier ones left, as
//!    `{ projectId, path, text, trigger }`, and may return `{ text }`. It can never refuse a save: a throw, a timeout,
//!    an invalid return (`InvalidShape`, `LimitExceeded` past 4 MiB) or an absent service leaves the text as it was.
//!    An answer after its budget is never applied (the package gets the late receipt).
//! 4. **One revision.** The transformed text replaces the buffer only if the buffer is still at the revision the chain
//!    started from. If the user typed meanwhile, the result is late: it is dropped (receipt `applied: false`,
//!    `Timeout`) and the newer buffer is what is saved. A transform can therefore never replace a newer revision.
//! 5. **Write.** [`DocumentEditors::save`] writes the buffer with the host's writer. The buffer is never discarded: a
//!    failed write keeps it dirty, edits made while writing stay dirty.
//! 6. **Events.** Each package mount hears, in revision order, the replacement the transform made (`reason: "format"`),
//!    replacements from disk changes and reverts, and `onDidSave({ revision })`. [`SaveFlow::drain`] merges the queue of
//!    R0901 with this module's events sorted by `(revision, replacement before save)`.
//!
//! A package disabled, uninstalled or whose grant is revoked is taken out by [`SaveFlow::package_gone`]: its hook is
//! removed, its mounts fall back to the built-in editor and the unsaved buffer stays the host's.
//!
//! Receipts follow R0506: one per non-empty return, in the order made. Audit entries name the package, project, path,
//! revision and size, never the content (ADR-0006). Everything here is for predictability and not losing work (ADR-0005).
use serde_json::{json, Value};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::Instant;

use crate::extensions::runtime_document_editors::{chunk_content, Chunk, Content, DocumentEditors, Mount, MAX_TEXT_BYTES, WILL_SAVE_WAIT_MS};
use crate::extensions::runtime_hook_context::{Ask, Names};
use crate::extensions::runtime_hook_registration::{HookRegistry, Occurrence, Target};
use crate::extensions::runtime_hook_resolution::{self as resolution, Asked, Late};

pub const EVENT: &str = "save.before";
pub const TRIGGERS: [&str; 3] = ["user", "auto", "package"];
const MAX_EVENTS: usize = 256;
const MAX_AUDIT: usize = 4_096;

/// The page callbacks of one mount: delivers the pending edit. The error is the panel's failure.
pub type WillSave = Arc<dyn Fn(&str) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;
/// `(owner, project)`: does the package hold `documents.editors` there now?
pub type Holds = Arc<dyn Fn(&str, &str) -> bool + Send + Sync>;
/// How the app (or a test) asks a service, names a package, reaches a panel and checks the grant.
#[derive(Clone)]
pub struct Env { pub ask: Ask, pub names: Names, pub will_save: WillSave, pub holds: Holds }

// ---------------------------------------------------------------------------------------------------------------
// One hook return
// ---------------------------------------------------------------------------------------------------------------

/// What one `save.before` return asks of the host.
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    /// Nothing returned (or `{}`): no receipt.
    Empty,
    /// `{ text }`.
    Applied(String),
    /// A non-empty return the host cannot use: `InvalidShape` or `LimitExceeded`.
    Refused(&'static str),
}
/// `{ text?: string }`, exactly, at most 4 MiB.
pub fn read_return(value: &Value) -> Step {
    match value {
        Value::Null => Step::Empty,
        Value::Object(map) if map.is_empty() => Step::Empty,
        Value::Object(map) => {
            if map.keys().any(|key| key != "text") { return Step::Refused("InvalidShape"); }
            match map.get("text") {
                None | Some(Value::Null) => Step::Empty,
                Some(Value::String(text)) if text.len() > MAX_TEXT_BYTES => Step::Refused("LimitExceeded"),
                Some(Value::String(text)) => Step::Applied(text.clone()),
                Some(_) => Step::Refused("InvalidShape"),
            }
        }
        _ => Step::Refused("InvalidShape"),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Events a package panel hears
// ---------------------------------------------------------------------------------------------------------------

/// What a package mount hears around a save, in revision order.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// `onDidReplace`: `reason` is `disk`, `revert` (R0901) or `format` (a `save.before` rewrite).
    Replace { reason: &'static str, revision: u64, chunks: Vec<Chunk> },
    /// `onDidSave({ revision })`.
    DidSave { revision: u64 },
}
impl Event {
    fn revision(&self) -> u64 { match self { Event::Replace { revision, .. } | Event::DidSave { revision } => *revision } }
    /// A replacement is heard before the save of the same revision.
    fn rank(&self) -> u8 { match self { Event::Replace { .. } => 0, Event::DidSave { .. } => 1 } }
    pub fn json(&self) -> Value {
        match self {
            Event::Replace { reason, revision, chunks } => json!({"type": "replace", "reason": reason, "revision": revision, "chunks": chunks.iter().map(Chunk::json).collect::<Vec<_>>()}),
            Event::DidSave { revision } => json!({"type": "didSave", "revision": revision}),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SaveAudit { pub action: String, pub owner: Option<String>, pub project_id: String, pub path: String, pub revision: u64, pub bytes: usize, pub detail: Option<String> }

/// The result of one save.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Saved {
    /// The revision the host wrote.
    pub revision: u64,
    /// A `save.before` transform changed the buffer before it was written.
    pub transformed: bool,
}
/// The panel's answer to `document.save()`.
pub fn answer(result: &Result<Saved, &'static str>) -> Value {
    match result { Ok(saved) => json!({"ok": true, "revision": saved.revision}), Err(code) => json!({"ok": false, "code": code}) }
}

struct Member { target: Target, step: Step, failure: Option<String> }
#[derive(Default)]
struct Inner { events: std::collections::BTreeMap<String, Vec<Event>>, audit: Vec<SaveAudit> }

/// The save path of every file the host writes.
#[derive(Default)]
pub struct SaveFlow { inner: Mutex<Inner> }

fn task_of(project: &str) -> String { format!("document:{project}") }
fn receipt(hook_id: &str, project: &str, applied: bool, code: Option<&str>) -> Value {
    let mut body = json!({"schemaVersion": 1, "hookId": hook_id, "event": EVENT, "taskId": task_of(project), "applied": applied});
    if let Some(code) = code { body["code"] = json!(code); }
    json!({"schemaVersion": 1, "receipt": body})
}

impl SaveFlow {
    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> { self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) }
    pub fn audit(&self) -> Vec<SaveAudit> { self.inner().audit.clone() }
    fn record(&self, action: &str, owner: Option<&str>, at: (&str, &str, u64), bytes: usize, detail: Option<&str>) {
        let mut inner = self.inner();
        if inner.audit.len() >= MAX_AUDIT { inner.audit.drain(..MAX_AUDIT / 2); }
        inner.audit.push(SaveAudit { action: action.into(), owner: owner.map(str::to_owned), project_id: at.0.to_owned(), path: at.1.to_owned(), revision: at.2, bytes, detail: detail.map(str::to_owned) });
    }
    fn push(&self, mount: &str, event: Event) {
        let mut inner = self.inner();
        let list = inner.events.entry(mount.to_owned()).or_default();
        if list.len() >= MAX_EVENTS { list.remove(0); }
        list.push(event);
    }
    fn package_mounts(editors: &DocumentEditors, env: &Env, project: &str, path: &str) -> Vec<Mount> {
        editors.mounts(project, path).into_iter().filter(|mount| mount.failure.is_none() && mount.owner.as_deref().is_some_and(|owner| (env.holds)(owner, project))).collect()
    }
    fn revision(editors: &DocumentEditors, project: &str, path: &str) -> u64 { editors.with_buffer(project, path, |buffer| buffer.revision).unwrap_or(0) }

    /// The events a package mount has not heard yet, in order: R0901's replacements (disk, revert) and this module's
    /// (format, saved), sorted by revision with a replacement before the save of the same revision.
    pub fn drain(&self, editors: &DocumentEditors, mount: &str) -> Vec<Value> {
        let mut list: Vec<Event> = editors.take_replaced(mount).into_iter().map(|replace| Event::Replace { reason: replace.reason, revision: replace.revision, chunks: replace.chunks }).collect();
        list.extend(self.inner().events.remove(mount).unwrap_or_default());
        list.sort_by_key(|event| (event.revision(), event.rank()));
        list.iter().map(Event::json).collect()
    }

    /// A package was disabled, uninstalled or lost its grant: its hook is removed (a save never asks it again), its
    /// mounts fall back to the built-in editor over the same buffer, and the unsaved changes stay the host's.
    pub fn package_gone(&self, editors: &DocumentEditors, registry: &HookRegistry, owner: &str) -> Vec<Mount> {
        registry.remove_owner(owner);
        resolution::streaks().forget(owner);
        editors.grants_changed()
    }

    /// `pandaView.document.save()` of a panel: the mount and its grant are checked now (a revoked grant falls the mount
    /// back and answers `PermissionDenied`), then the same path as every save with `trigger: "package"`.
    pub async fn save_from_panel(&self, editors: &DocumentEditors, registry: &HookRegistry, env: &Env, mount: &Mount, write: &(dyn Fn(&Content) -> bool + Sync)) -> Result<Saved, &'static str> {
        let live = editors.mounts(&mount.project_id, &mount.path).into_iter().find(|item| item.id == mount.id && item.failure.is_none()).ok_or("NotFound")?;
        let owner = live.owner.clone().ok_or("NotFound")?;
        if !(env.holds)(&owner, &live.project_id) { editors.grants_changed(); return Err("PermissionDenied"); }
        self.save(editors, registry, env, &live.project_id, &live.path, "package", write).await
    }

    /// The one save. See the module doc for the order of its steps.
    #[allow(clippy::too_many_arguments)]
    pub async fn save(&self, editors: &DocumentEditors, registry: &HookRegistry, env: &Env, project: &str, path: &str, trigger: &str, write: &(dyn Fn(&Content) -> bool + Sync)) -> Result<Saved, &'static str> {
        if !TRIGGERS.contains(&trigger) { return Err("InvalidShape"); }
        let (read_only, conflict) = editors.with_buffer(project, path, |buffer| (buffer.read_only, buffer.conflict.is_some())).ok_or("NotFound")?;
        if read_only { return Err("ReadOnly"); }
        if conflict { return Err("Conflict"); }

        // onWillSave: a failing or slow panel never blocks the save.
        for mount in Self::package_mounts(editors, env, project, path) {
            let owner = mount.owner.clone().unwrap_or_default();
            let outcome = match tokio::time::timeout(Duration::from_millis(WILL_SAVE_WAIT_MS), (env.will_save)(&mount.id)).await { Ok(Ok(())) => "ok", Ok(Err(_)) => "failed", Err(_) => "timeout" };
            self.record("will-save", Some(&owner), (project, path, Self::revision(editors, project, path)), 0, Some(outcome));
        }

        // save.before: only a text buffer has text to give.
        let (content, started_at) = editors.with_buffer(project, path, |buffer| buffer.snapshot()).ok_or("NotFound")?;
        let mut members: Vec<Member> = Vec::new();
        let mut current = String::new();
        let original = match &content { Content::Text(text) => Some(text.clone()), Content::Bytes(_) => None };
        if let Some(original) = &original {
            current = original.clone();
            self.chain(registry, env, project, path, trigger, &mut current, &mut members).await;
        }

        // One revision: the transform lands only on the buffer it was made for.
        let wanted = members.iter().any(|member| matches!(member.step, Step::Applied(_)));
        let mut landed: Option<u64> = None;
        if wanted {
            landed = editors.with_buffer(project, path, |buffer| {
                if buffer.revision != started_at || buffer.conflict.is_some() { return None; }
                buffer.edit(Content::Text(current.clone())).ok()
            }).flatten();
        }
        let transformed = landed.is_some() && original.as_deref() != Some(current.as_str());
        if let (true, Some(revision)) = (transformed, landed) {
            for mount in Self::package_mounts(editors, env, project, path) {
                self.push(&mount.id, Event::Replace { reason: "format", revision, chunks: chunk_content(&Content::Text(current.clone()), &format!("format-{}-{revision}", mount.id), revision) });
            }
        }
        for member in &members {
            let id = member.target.declaration.id.as_str();
            let owner = member.target.owner.as_str();
            let (applied, code): (bool, Option<&str>) = match &member.step {
                Step::Applied(_) if landed.is_some() => (true, None),
                Step::Applied(_) => (false, Some("Timeout")),
                Step::Refused(code) => (false, Some(code)),
                Step::Empty => continue,
            };
            self.record(EVENT, Some(owner), (project, path, landed.unwrap_or(started_at)), current.len(), Some(code.unwrap_or("applied")));
            let _ = registry.deliver_to(owner, receipt(id, project, applied, code));
        }

        // The host writes. A failed write keeps the buffer dirty; nothing the user typed is lost.
        let revision = editors.save(project, path, trigger, write)?;
        for mount in Self::package_mounts(editors, env, project, path) { self.push(&mount.id, Event::DidSave { revision }); }
        Ok(Saved { revision, transformed })
    }

    /// Asks the attached `save.before` hooks in order; each sees what the earlier ones left in `current`.
    #[allow(clippy::too_many_arguments)] // the chain state is threaded explicitly, as in the callers
    async fn chain(&self, registry: &HookRegistry, env: &Env, project: &str, path: &str, trigger: &str, current: &mut String, members: &mut Vec<Member>) {
        let mut occurrence = Occurrence { event: EVENT, project: project.to_owned(), harness: String::new(), run: String::new(), tool_kind: None, paths: vec![path.to_owned()], payload: json!({"projectId": project, "path": path, "text": *current, "trigger": trigger}) };
        let started = Instant::now();
        for target in registry.reach(&occurrence) {
            occurrence.payload["text"] = json!(*current);
            let frame = json!({"schemaVersion": 1, "hookId": target.declaration.id, "event": EVENT, "observeOnly": false, "payload": occurrence.payload});
            let late = Late { hook_id: target.declaration.id.clone(), event: EVENT.to_owned(), task: task_of(project), call: None };
            let (answer, reached) = match resolution::ask_member(registry, &env.ask, &target, &occurrence, frame, started, late).await {
                Asked::Removed => continue,
                Asked::Answered { answer, asked } => (answer, asked),
            };
            let step = match &answer { Ok(value) => read_return(value), Err(_) => Step::Empty };
            let refused = match &step { Step::Refused(code) => Some((*code).to_owned()), _ => None };
            let failure = resolution::failure_of(&answer, &[refused]);
            resolution::settle(&target, EVENT, &(env.names)(&target.owner), &task_of(project), failure.as_deref(), reached);
            if let Step::Applied(text) = &step { current.clone_from(text); }
            members.push(Member { target, step, failure });
        }
        // A package whose hook failed is only recorded; the text stays as the earlier members left it.
        for member in members.iter().filter(|member| member.failure.is_some()) {
            self.record("save.before-skipped", Some(&member.target.owner), (project, path, 0), 0, member.failure.as_deref());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::runtime_document_editors::{check, Entry, PERMISSION};
    use crate::extensions::runtime_hook_registration::{Declaration, Match};
    use std::sync::Mutex as StdMutex;
    use tokio::sync::oneshot;

    const SCENARIOS: &str = include_str!("../../../tests/fixtures/extensions/runtime-document-save/scenarios.json");
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-document-save/extension.json");
    const OWNER: &str = "sample.sqlfmt";

    fn expand(value: &Value) -> Value {
        match value {
            Value::String(text) => match text.strip_prefix("{pad:").and_then(|rest| rest.strip_suffix('}')).and_then(|count| count.parse::<usize>().ok()) { Some(count) => json!("x".repeat(count)), None => value.clone() },
            Value::Array(items) => Value::Array(items.iter().map(expand).collect()),
            Value::Object(fields) => Value::Object(fields.iter().map(|(key, value)| (key.clone(), expand(value))).collect()),
            other => other.clone(),
        }
    }
    fn editors_for(granted: Arc<StdMutex<bool>>) -> Arc<DocumentEditors> {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let entry = Entry { owner: OWNER.into(), version: "1.0.0".into(), package_name: "SQL formatter".into(), editors: check(&manifest).unwrap() };
        Arc::new(DocumentEditors::new(Arc::new(move || vec![entry.clone()]), Arc::new(move |_, _, permission, _| permission == PERMISSION && *granted.lock().unwrap())))
    }
    fn declaration(owner: &str, budget_ms: u64) -> Declaration {
        Declaration { id: format!("{owner}/save"), event: EVENT.into(), on_failure: "continue".into(), budget_ms, matcher: Match { extensions: Some([".sql".to_owned()].into()), ..Match::default() } }
    }
    fn registry_for(owners: &[String], delivered: Arc<StdMutex<Vec<Value>>>) -> Arc<HookRegistry> {
        let hub = Arc::new(HookRegistry::default());
        hub.set_gate(Arc::new(|_, _, _, _| true));
        hub.set_deliver(Arc::new(move |owner, frame| { delivered.lock().unwrap().push(json!({"owner": owner, "frame": frame})); Ok(()) }));
        for owner in owners { hub.register(owner, "1.0.0", &[declaration(owner, 100)], EVENT).unwrap(); }
        hub.set_order(owners.to_vec());
        hub
    }
    /// The stand-in service: records each frame it is given, then answers as scripted after `afterMs` of the paused clock.
    fn stand_in(members: Value, editors: Arc<DocumentEditors>, project: &'static str, path: String, frames: Arc<StdMutex<Vec<Value>>>) -> Ask {
        Arc::new(move |owner: &str, frame: Value| {
            let member = members.as_array().unwrap().iter().find(|member| member["owner"] == owner).unwrap().clone();
            frames.lock().unwrap().push(json!({"owner": owner, "text": frame["payload"]["text"], "trigger": frame["payload"]["trigger"]}));
            if let Some(typed) = member["answer"]["editsBuffer"].as_str() { editors.edit_builtin(project, &path, Content::Text(typed.to_owned())).unwrap(); }
            let (sender, receiver) = oneshot::channel();
            let answer = &member["answer"];
            let reply: std::result::Result<Value, String> = match answer["error"].as_str() { Some(code) => Err(code.to_owned()), None => Ok(expand(&answer["value"])) };
            let after = Duration::from_millis(answer["afterMs"].as_u64().unwrap_or(0));
            if answer["never"] == true { std::mem::forget(sender); return Ok(receiver); }
            tokio::spawn(async move { tokio::time::sleep(after).await; let _ = sender.send(reply); });
            Ok(receiver)
        })
    }
    /// A service that is not running: every ask answers `HostUnavailable`.
    fn no_service() -> Ask { Arc::new(|_owner: &str, _frame: Value| Err::<oneshot::Receiver<std::result::Result<Value, String>>, &'static str>("HostUnavailable")) }
    fn env_for(ask: Ask, will_save: &'static str, granted: Arc<StdMutex<bool>>) -> Env {
        Env {
            ask,
            names: Arc::new(|owner: &str| owner.to_owned()),
            will_save: Arc::new(move |_mount: &str| {
                let panel: Pin<Box<dyn Future<Output = Result<(), String>> + Send>> = Box::pin(async move {
                    match will_save { "slow" => { tokio::time::sleep(Duration::from_secs(5)).await; Ok(()) } "throw" => Err("boom".to_owned()), _ => Ok(()) }
                });
                panel
            }),
            holds: Arc::new(move |_, _| *granted.lock().unwrap()),
        }
    }
    fn text_of(editors: &DocumentEditors, project: &str, path: &str) -> (String, bool) {
        editors.with_buffer(project, path, |buffer| (match buffer.snapshot().0 { Content::Text(text) => text, Content::Bytes(_) => String::new() }, buffer.dirty)).unwrap()
    }
    fn kinds(events: &[Value]) -> Vec<String> {
        events.iter().map(|event| match event["type"].as_str().unwrap() { "replace" => format!("replace:{}", event["reason"].as_str().unwrap()), other => other.to_owned() }).collect()
    }

    #[test]
    fn the_fixture_package_is_valid() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        assert_eq!(check(&manifest).unwrap().len(), 1);
        assert_eq!(crate::extensions::contracts::validate_contract("packages", &json!([manifest]))["ok"], true);
    }

    #[test]
    fn returns_are_read_strictly() {
        assert_eq!(read_return(&Value::Null), Step::Empty);
        assert_eq!(read_return(&json!({})), Step::Empty);
        assert_eq!(read_return(&json!({"text": "a"})), Step::Applied("a".into()));
        assert_eq!(read_return(&json!({"text": 5})), Step::Refused("InvalidShape"));
        assert_eq!(read_return(&json!({"text": "a", "refuse": true})), Step::Refused("InvalidShape"));
        assert_eq!(read_return(&json!("a")), Step::Refused("InvalidShape"));
        assert_eq!(read_return(&json!({"text": "x".repeat(MAX_TEXT_BYTES + 1)})), Step::Refused("LimitExceeded"));
    }

    #[tokio::test(start_paused = true)]
    async fn scenarios_match_the_shared_cases() {
        let corpus: Value = serde_json::from_str(SCENARIOS).unwrap();
        for scenario in corpus["scenarios"].as_array().unwrap() {
            let label = scenario["id"].as_str().unwrap();
            let path = scenario["path"].as_str().unwrap_or("q.sql").to_owned();
            let granted = Arc::new(StdMutex::new(true));
            let editors = editors_for(granted.clone());
            let read_only = scenario["readOnly"] == true;
            editors.open("p1", &path, Content::Text(scenario["disk"].as_str().unwrap().into()), read_only);
            if scenario["buffer"] != scenario["disk"] { editors.edit_builtin("p1", &path, Content::Text(scenario["buffer"].as_str().unwrap().into())).unwrap(); }
            let mount = editors.mount("p1", &path, "sample.sqlfmt/sql", "window").unwrap();
            if let Some(theirs) = scenario["diskChange"].as_str() { editors.disk_changed("p1", &path, Content::Text(theirs.into())); }

            let owners: Vec<String> = scenario["members"].as_array().unwrap().iter().map(|member| member["owner"].as_str().unwrap().to_owned()).collect();
            let delivered = Arc::new(StdMutex::new(Vec::new()));
            let frames = Arc::new(StdMutex::new(Vec::new()));
            let hub = registry_for(&owners, delivered.clone());
            let ask = stand_in(scenario["members"].clone(), editors.clone(), "p1", path.clone(), frames.clone());
            let env = env_for(ask, match scenario["willSave"].as_str() { Some("slow") => "slow", Some("throw") => "throw", _ => "ok" }, granted);
            let written: StdMutex<Option<Content>> = StdMutex::new(None);
            let write = |content: &Content| { *written.lock().unwrap() = Some(content.clone()); true };
            let flow = SaveFlow::default();
            let trigger = scenario["trigger"].as_str().unwrap();
            let result = if scenario["via"] == "panel" { flow.save_from_panel(&editors, &hub, &env, &mount, &write).await } else { flow.save(&editors, &hub, &env, "p1", &path, trigger, &write).await };
            let during = delivered.lock().unwrap().len();
            tokio::time::sleep(Duration::from_millis(scenario["settleMs"].as_u64().unwrap_or(0))).await;

            let expect = &scenario["expect"];
            assert_eq!(json!(result.as_ref().err()), expect["error"], "{label}: error");
            let wrote = written.lock().unwrap().clone().map(|content| match content { Content::Text(text) => json!(text), Content::Bytes(_) => json!("bytes") }).unwrap_or(Value::Null);
            assert_eq!(wrote, expect["written"], "{label}: written");
            let (buffer, dirty) = text_of(&editors, "p1", &path);
            assert_eq!((json!(buffer), dirty), (expect["buffer"].clone(), expect["dirty"] == true), "{label}: buffer");
            assert_eq!(json!(frames.lock().unwrap().iter().map(|frame| frame["owner"].clone()).collect::<Vec<_>>()), expect["asked"], "{label}: asked");
            assert_eq!(json!(*frames.lock().unwrap()), expect["frames"], "{label}: frames");
            let all = delivered.lock().unwrap().clone();
            let shown = |items: &[Value]| -> Vec<Value> { items.iter().map(|item| json!({"owner": item["owner"], "applied": item["frame"]["receipt"]["applied"], "code": item["frame"]["receipt"].get("code").cloned().unwrap_or(Value::Null)})).collect() };
            assert_eq!(json!(shown(&all[..during])), expect["receipts"], "{label}: receipts");
            assert_eq!(json!(all[during..].iter().map(|item| item["owner"].clone()).collect::<Vec<_>>()), expect["late"], "{label}: late");
            assert!(all[during..].iter().all(|item| item["frame"]["receipt"]["applied"] == false && item["frame"]["receipt"]["code"] == "Timeout"), "{label}: late receipts are never applied");
            let outcomes: Vec<String> = flow.audit().into_iter().filter(|entry| entry.action == "will-save").filter_map(|entry| entry.detail).filter(|detail| detail != "ok").collect();
            assert_eq!(json!(outcomes), expect["willSave"], "{label}: willSave");
            let events = flow.drain(&editors, &mount.id);
            assert_eq!(json!(kinds(&events)), expect["events"], "{label}: events");
            assert!(flow.audit().iter().all(|entry| entry.bytes <= MAX_TEXT_BYTES + 1), "{label}: audit never carries content");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn replacements_and_saves_arrive_in_revision_order() {
        let granted = Arc::new(StdMutex::new(true));
        let editors = editors_for(granted.clone());
        editors.open("p1", "q.sql", Content::Text("a".into()), false);
        let mount = editors.mount("p1", "q.sql", "sample.sqlfmt/sql", "window").unwrap();
        let hub = registry_for(&[], Arc::default());
        let env = env_for(no_service(), "ok", granted);
        let flow = SaveFlow::default();
        editors.disk_changed("p1", "q.sql", Content::Text("b".into()));
        editors.edit_builtin("p1", "q.sql", Content::Text("c".into())).unwrap();
        flow.save(&editors, &hub, &env, "p1", "q.sql", "user", &|_: &Content| true).await.unwrap();
        editors.revert("p1", "q.sql").unwrap();
        let events = flow.drain(&editors, &mount.id);
        assert_eq!(kinds(&events), ["replace:disk", "didSave", "replace:revert"]);
        let revisions: Vec<u64> = events.iter().map(|event| event["revision"].as_u64().unwrap()).collect();
        assert!(revisions.windows(2).all(|pair| pair[0] <= pair[1]), "{revisions:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_write_keeps_the_buffer_and_a_removed_package_keeps_unsaved_changes() {
        let granted = Arc::new(StdMutex::new(true));
        let editors = editors_for(granted.clone());
        editors.open("p1", "q.sql", Content::Text("a".into()), false);
        let mount = editors.mount("p1", "q.sql", "sample.sqlfmt/sql", "window").unwrap();
        editors.edit_builtin("p1", "q.sql", Content::Text("mine".into())).unwrap();
        let hub = registry_for(&[OWNER.to_owned()], Arc::default());
        let env = env_for(no_service(), "ok", granted.clone());
        let flow = SaveFlow::default();
        assert_eq!(flow.save(&editors, &hub, &env, "p1", "q.sql", "user", &|_: &Content| false).await.unwrap_err(), "HostUnavailable");
        assert_eq!(text_of(&editors, "p1", "q.sql"), ("mine".to_owned(), true));
        // Disabled: the hook and the editor go, the unsaved text stays and the next save still works.
        *granted.lock().unwrap() = false;
        let fallback = flow.package_gone(&editors, &hub, OWNER);
        assert_eq!(fallback.len(), 1);
        assert_eq!((fallback[0].editor.as_str(), fallback[0].failure), ("builtin", Some("grant-revoked")));
        assert!(hub.attached(EVENT).is_empty());
        assert_eq!(flow.save_from_panel(&editors, &hub, &env, &mount, &|_: &Content| true).await.unwrap_err(), "NotFound");
        assert_eq!(text_of(&editors, "p1", "q.sql"), ("mine".to_owned(), true));
        let written = StdMutex::new(None);
        flow.save(&editors, &hub, &env, "p1", "q.sql", "user", &|content: &Content| { *written.lock().unwrap() = Some(content.clone()); true }).await.unwrap();
        assert_eq!(written.into_inner().unwrap(), Some(Content::Text("mine".into())));
    }
}
