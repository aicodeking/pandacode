//! Drafts and attachments without sending (`tasks.draft`, runtime phase R4, slice R0403).
//!
//! A trusted service edits the composer draft of a task with `panda.tasks.draft.get | set | insert | suggest | attach |
//! detach` and reads an attachment in pages with `panda.tasks.attachments.read`. Nothing here sends: the draft is the
//! user's text until the user sends it, and `suggest` is ghost text that never becomes the draft until the user accepts
//! it. A target is `{windowId}` (the draft of the task that window shows) or `{taskId}`.
//!
//! The permission `tasks.draft` is project scoped, covers every draft call (attachments included) and is rechecked
//! natively on every request. A package that holds it is never asked again per action (ADR-0005). Reading an
//! attachment's bytes is `tasks.transcript.read`, a different grant. The refusals are the frozen ones:
//! - no grant, a revoked grant, a disabled package or a project outside the narrowed scope: `PermissionDenied`, with the
//!   permission name in `path`; a package holding the permission for no project learns nothing about tasks and windows;
//! - an unknown task, window or attachment: `NotFound`;
//! - a draft that changed since the `revision` the package read, or a window that now shows another task: `StaleContext`;
//! - a text or path the call does not take: `InvalidShape`; a size bound: `LimitExceeded`;
//! - the user is composing with an input method (IME): `Busy`, so the composition stays intact (retry later).
//!
//! The draft lives in the main window (the composer, its undo history, the per-task drafts and the attachment bar), so
//! each call is two answered rounds with the window: `resolve` (which task, which project, the current text, attachments
//! and revision; nothing changes) and, after the grant is checked again against the resolved project, `apply` (the edit,
//! one step of the user's undo history, refused as `StaleContext` when the revision or the window's task moved on). A
//! revoke or a disable between the rounds creates no edit; a package that ends takes its ghost text off the screen.
//!
//! Rules for predictability and fault isolation, never for trust: eight rounds waiting for the window per package, a
//! 10 s bound on its answer, a 200,000 byte text and 256 KiB attachment pages. The state is pure (an injected world) so
//! the rules are deterministic to test; the app half (`serve`) only adds the grants file, the store and the window.
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, io::{Read, Seek, SeekFrom}, path::Path, sync::Mutex, time::Duration};
use tokio::sync::oneshot;

use super::runtime_tasks_start::{failure, Refusal};

/// The named permission for every draft call (project scoped).
pub const PERMISSION: &str = "tasks.draft";
/// Reading an attachment's bytes needs the transcript grant, not the draft one.
pub const READ_PERMISSION: &str = "tasks.transcript.read";
pub const TEXT_BYTES: usize = 200_000;
pub const PATH_CHARS: usize = 4096;
/// One attachment page: at most 256 KiB decoded.
pub const CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_WAITING: usize = 8;
pub const WAIT: Duration = Duration::from_secs(10);
const OPS: [&str; 6] = ["get", "set", "insert", "suggest", "attach", "detach"];
const MAX_REVISION: u64 = 1 << 53;
/// Refusal codes a window answer may carry; anything else is read as `InvalidShape`.
const WINDOW_CODES: [&str; 10] = ["NotFound", "Busy", "StaleContext", "InvalidShape", "LimitExceeded", "HostUnavailable", "UnsupportedCapability", "Revoked", "Conflict", "Timeout"];

fn ident(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control) }
fn denied(permission: &str) -> Refusal { Refusal { code: "PermissionDenied".into(), path: permission.into(), ids: vec![] } }

/// Whose draft: the task a window shows, or a task by id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target { Window(String), Task(String) }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Op { Get, Set { text: String, revision: Option<u64> }, Insert { text: String }, Suggest { text: String }, Attach { path: String }, Detach { attachment_id: String } }
impl Op {
    pub fn name(&self) -> &'static str {
        match self { Op::Get => "get", Op::Set { .. } => "set", Op::Insert { .. } => "insert", Op::Suggest { .. } => "suggest", Op::Attach { .. } => "attach", Op::Detach { .. } => "detach" }
    }
    /// `get` reads; every other call changes the draft or its ghost text.
    pub fn mutates(&self) -> bool { !matches!(self, Op::Get) }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request { pub target: Target, pub op: Op }

fn text_of(object: &Map<String, Value>, empty_ok: bool) -> Result<String, Refusal> {
    let text = object.get("text").and_then(Value::as_str).ok_or("InvalidShape")?;
    if text.contains('\0') || (!empty_ok && text.is_empty()) { return Err("InvalidShape".into()); }
    if text.len() > TEXT_BYTES { return Err("LimitExceeded".into()); }
    Ok(text.to_owned())
}

/// Reads a draft call: `{op, windowId | taskId, text?, revision?, path?, attachmentId?}`. Nothing is looked up here.
pub fn read_request(raw: &Value) -> Result<Request, Refusal> {
    let object = raw.as_object().ok_or("InvalidShape")?;
    let op = object.get("op").and_then(Value::as_str).filter(|op| OPS.contains(op)).ok_or("InvalidShape")?;
    let extra: &[&str] = match op { "set" => &["text", "revision"], "insert" | "suggest" => &["text"], "attach" => &["path"], "detach" => &["attachmentId"], _ => &[] };
    if object.keys().any(|key| !["op", "windowId", "taskId"].contains(&key.as_str()) && !extra.contains(&key.as_str())) { return Err("InvalidShape".into()); }
    let id = |key: &str| -> Result<Option<String>, Refusal> {
        match object.get(key) { None => Ok(None), Some(Value::String(text)) if ident(text) => Ok(Some(text.clone())), Some(_) => Err("InvalidShape".into()) }
    };
    let target = match (id("windowId")?, id("taskId")?) { (Some(window), None) => Target::Window(window), (None, Some(task)) => Target::Task(task), _ => return Err("InvalidShape".into()) };
    let op = match op {
        "get" => Op::Get,
        "set" => {
            let revision = match object.get("revision") { None | Some(Value::Null) => None, Some(value) => Some(value.as_u64().filter(|revision| *revision <= MAX_REVISION).ok_or("InvalidShape")?) };
            Op::Set { text: text_of(object, true)?, revision }
        }
        "insert" => Op::Insert { text: text_of(object, false)? },
        "suggest" => Op::Suggest { text: text_of(object, true)? },
        "attach" => {
            let path = object.get("path").and_then(Value::as_str).ok_or("InvalidShape")?;
            if path.is_empty() || path.contains('\0') { return Err("InvalidShape".into()); }
            if path.chars().count() > PATH_CHARS { return Err("LimitExceeded".into()); }
            Op::Attach { path: path.to_owned() }
        }
        _ => Op::Detach { attachment_id: id("attachmentId")?.ok_or("InvalidShape")? },
    };
    Ok(Request { target, op })
}

/// The grant for the resolved project. `holds` is "the package holds this permission for any project": without it the
/// answer is the permission itself whatever the target, so a refusal never says whether a task or a window exists.
pub fn gate(permission: &str, holds: bool, project: Option<&str>, granted: &dyn Fn(&str) -> bool) -> Result<String, Refusal> {
    if !holds { return Err(denied(permission)); }
    match project { None => Err("NotFound".into()), Some(project) if granted(project) => Ok(project.to_owned()), Some(_) => Err(denied(permission)) }
}

/// What the window resolved: the task whose draft the call reaches, its project and the draft as it is now.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved { pub task_id: String, pub project_id: String, pub revision: u64, pub text: String, pub attachments: Vec<Value> }

/// Reads the window's refusal; a code outside the frozen list is `InvalidShape`.
pub fn read_refusal(answer: &Value) -> Refusal {
    match answer["code"].as_str() { Some(code) if WINDOW_CODES.contains(&code) => Refusal::new(code), _ => Refusal::new("InvalidShape") }
}

/// Reads the answer of `resolve`: `{ok: true, taskId, projectId, revision, text, attachments: [{id, kind, name}]}`.
pub fn read_resolved(answer: &Value) -> Result<Resolved, Refusal> {
    if answer["ok"] != true { return Err(read_refusal(answer)); }
    let text_of = |key: &str| answer[key].as_str().filter(|value| ident(value)).map(str::to_owned);
    let (task_id, project_id) = (text_of("taskId").ok_or("InvalidShape")?, text_of("projectId").ok_or("InvalidShape")?);
    let revision = answer["revision"].as_u64().filter(|revision| *revision <= MAX_REVISION).ok_or("InvalidShape")?;
    let text = answer["text"].as_str().ok_or("InvalidShape")?.to_owned();
    let attachments = answer["attachments"].as_array().ok_or("InvalidShape")?.iter().filter_map(|item| {
        Some(json!({"id": item["id"].as_str().filter(|id| ident(id))?, "kind": item["kind"].as_str()?, "name": item["name"].as_str()?}))
    }).collect();
    Ok(Resolved { task_id, project_id, revision, text, attachments })
}

/// What `get` answers.
pub fn draft_value(resolved: &Resolved) -> Value { json!({"text": resolved.text, "attachments": resolved.attachments, "revision": resolved.revision}) }

/// The `apply` round for an operation, once the window has resolved the draft the call reaches.
pub fn apply_payload(request: &Request, resolved: &Resolved) -> Value {
    let mut payload = json!({"phase": "apply", "op": request.op.name(), "taskId": resolved.task_id, "revisionAtResolve": resolved.revision});
    if let Target::Window(window) = &request.target { payload["windowId"] = json!(window); }
    match &request.op {
        Op::Set { text, revision } => { payload["text"] = json!(text); if let Some(revision) = revision { payload["revision"] = json!(revision); } }
        Op::Insert { text } | Op::Suggest { text } => payload["text"] = json!(text),
        Op::Attach { path } => payload["path"] = json!(path),
        Op::Detach { attachment_id } => payload["attachmentId"] = json!(attachment_id),
        Op::Get => {}
    }
    payload
}

/// What `apply` answered: `attach` returns `{id}`, every other edit `null`.
pub fn read_applied(request: &Request, answer: &Value) -> Result<Value, Refusal> {
    if answer["ok"] != true { return Err(read_refusal(answer)); }
    match request.op {
        Op::Attach { .. } => Ok(json!({"id": answer["id"].as_str().filter(|id| ident(id)).ok_or("InvalidShape")?})),
        _ => Ok(Value::Null),
    }
}

// ---- Attachment pages ------------------------------------------------------------------------------------------------

/// `cursor` is a byte offset into the attachment; absent is the start.
pub fn read_cursor(object: &Map<String, Value>) -> Result<u64, Refusal> {
    match object.get("cursor") { None | Some(Value::Null) => Ok(0), Some(value) => value.as_u64().filter(|cursor| *cursor <= MAX_REVISION).ok_or_else(|| "InvalidShape".into()) }
}

/// A cursor past the end is `LimitExceeded`; an empty attachment has one empty page at 0.
pub fn check_cursor(total: u64, cursor: u64) -> Result<(), Refusal> {
    if cursor > total || (cursor == total && total > 0) { Err("LimitExceeded".into()) } else { Ok(()) }
}

/// One page: `data` is the bytes from `cursor` on, at most `CHUNK_BYTES`.
pub fn chunk(name: &str, mime: &str, total: u64, cursor: u64, data: &[u8]) -> Value {
    use base64::Engine;
    let data = &data[..data.len().min(CHUNK_BYTES)];
    let end = cursor + data.len() as u64;
    json!({"schemaVersion": 1, "mime": mime, "name": name, "bytes": total, "data": base64::engine::general_purpose::STANDARD.encode(data), "nextCursor": if end < total { json!(end) } else { Value::Null }})
}

/// The page of a file on disk at `cursor`; the whole file is never read into memory.
pub fn file_page(path: &Path, name: &str, mime: &str, cursor: u64) -> Result<Value, Refusal> {
    let mut file = std::fs::File::open(path).map_err(|_| Refusal::new("NotFound"))?;
    let meta = file.metadata().map_err(|_| Refusal::new("HostUnavailable"))?;
    if !meta.is_file() { return Err("NotFound".into()); }
    let total = meta.len();
    check_cursor(total, cursor)?;
    file.seek(SeekFrom::Start(cursor)).map_err(|_| Refusal::new("HostUnavailable"))?;
    let mut data = Vec::with_capacity(CHUNK_BYTES.min((total - cursor) as usize));
    file.take(CHUNK_BYTES as u64).read_to_end(&mut data).map_err(|_| Refusal::new("HostUnavailable"))?;
    Ok(chunk(name, mime, total, cursor, &data))
}

/// The page of bytes held in memory (a stored message attachment, or the text of a document or folder listing).
pub fn memory_page(name: &str, mime: &str, bytes: &[u8], cursor: u64) -> Result<Value, Refusal> {
    let total = bytes.len() as u64;
    check_cursor(total, cursor)?;
    Ok(chunk(name, mime, total, cursor, &bytes[cursor as usize..]))
}

// ---- Rounds waiting for the window -----------------------------------------------------------------------------------

struct Waiting { owner: String, sender: Option<oneshot::Sender<Value>> }
#[derive(Default)]
struct Slots { waiting: BTreeMap<String, Waiting>, serial: u64 }

/// The rounds that wait for the main window to answer (resolve, apply, attachment).
#[derive(Default)]
pub struct DraftSlots { inner: Mutex<Slots> }
impl DraftSlots {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Slots>, &'static str> { self.inner.lock().map_err(|_| "HostUnavailable") }
    /// A round waits: its id and the receiver the answer arrives on. A ninth one of the package is `LimitExceeded`.
    pub fn begin(&self, owner: &str) -> Result<(String, oneshot::Receiver<Value>), &'static str> {
        let mut slots = self.lock()?;
        if slots.waiting.values().filter(|waiting| waiting.owner == owner).count() >= MAX_WAITING { return Err("LimitExceeded"); }
        slots.serial += 1;
        let id = format!("{owner}#draft-{}", slots.serial);
        let (sender, receiver) = oneshot::channel();
        slots.waiting.insert(id.clone(), Waiting { owner: owner.to_owned(), sender: Some(sender) });
        Ok((id, receiver))
    }
    /// The window answers round `id`. An answer for a round that is gone (answered, timed out, ended) is `NotFound`.
    pub fn answer(&self, id: &str, answer: &Value) -> Result<(), &'static str> {
        let mut slots = self.lock()?;
        let mut waiting = slots.waiting.remove(id).ok_or("NotFound")?;
        if let Some(sender) = waiting.sender.take() { let _ = sender.send(answer.clone()); }
        Ok(())
    }
    /// The package's service ended: its waiting rounds resolve as revoked and change nothing.
    pub fn cancel_owner(&self, owner: &str) -> usize {
        let Ok(mut slots) = self.inner.lock() else { return 0 };
        let ids: Vec<String> = slots.waiting.iter().filter(|(_, waiting)| waiting.owner == owner).map(|(id, _)| id.clone()).collect();
        for id in &ids { if let Some(mut waiting) = slots.waiting.remove(id) { if let Some(sender) = waiting.sender.take() { let _ = sender.send(json!({"ok": false, "code": "Revoked"})); } } }
        ids.len()
    }
    pub fn forget(&self, id: &str) -> bool { self.inner.lock().is_ok_and(|mut slots| slots.waiting.remove(id).is_some()) }
    pub fn count(&self, owner: &str) -> usize { self.inner.lock().map_or(0, |slots| slots.waiting.values().filter(|waiting| waiting.owner == owner).count()) }
}

// ---- The app ---------------------------------------------------------------------------------------------------------

pub fn state(app: &tauri::AppHandle) -> Option<tauri::State<'_, DraftSlots>> { use tauri::Manager; app.try_state::<DraftSlots>() }

/// The enabled version of the package, or why it may not call.
fn version_of(app: &tauri::AppHandle, owner: &str) -> Result<String, &'static str> {
    use tauri::Manager;
    let packages = app.state::<crate::extensions::packages::ExtensionPackages>();
    let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
    super::runtime_service_lifetime::runtime_usage_resources::enabled_version(&packages, owner).ok_or("PermissionDenied")
}

fn holds(app: &tauri::AppHandle, owner: &str, version: &str, permission: &str) -> bool {
    use tauri::Manager;
    app.try_state::<super::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.projection()["packages"].as_array().into_iter().flatten().any(|package| {
        package["id"] == owner && package["version"] == version && package["authorized"] == true && package["grants"].as_array().into_iter().flatten().any(|grant| grant["permission"] == permission)
    }))
}

fn granted(app: &tauri::AppHandle, owner: &str, version: &str, permission: &str, project: &str) -> bool {
    use tauri::Manager;
    app.try_state::<super::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(owner, version, permission, &super::runtime_grants::Target::project(project)).is_ok())
}

/// The project of a task, a New task draft included.
fn project_of(app: &tauri::AppHandle, task: &str) -> Option<String> {
    use tauri::Manager;
    let state = app.try_state::<crate::AppState>()?;
    let store = state.store.try_lock().ok()?;
    store.db.query_row("SELECT project_id FROM sessions WHERE id=?1", [task], |row| row.get::<_, String>(0)).ok()
}

/// Removes the waiting round when its request is dropped (the service ended while it waited).
struct Guard { app: tauri::AppHandle, id: String }
impl Drop for Guard { fn drop(&mut self) { if let Some(slots) = state(&self.app) { slots.forget(&self.id); } } }

/// One round with the window: sends `payload` under a fresh id and waits for the answer.
async fn ask(app: &tauri::AppHandle, owner: &str, mut payload: Value) -> Result<Value, Refusal> {
    use tauri::Emitter;
    let Some(slots) = state(app) else { return Err("UnsupportedCapability".into()) };
    if crate::headless::active() { return Err("UnsupportedCapability".into()); }
    let (id, receiver) = slots.begin(owner).map_err(Refusal::new)?;
    let _guard = Guard { app: app.clone(), id: id.clone() };
    payload["id"] = json!(id);
    payload["owner"] = json!(owner);
    let _ = app.emit("extensions-runtime-draft", payload);
    let answer = match tokio::time::timeout(WAIT, receiver).await { Ok(Ok(answer)) => answer, Ok(Err(_)) => return Err("Revoked".into()), Err(_) => return Err("Timeout".into()) };
    if answer["code"] == "Revoked" { return Err("Revoked".into()); }
    Ok(answer)
}

fn target_fields(payload: &mut Value, target: &Target) {
    match target { Target::Window(window) => payload["windowId"] = json!(window), Target::Task(task) => payload["taskId"] = json!(task) }
}

/// Serves `tasksDraft` of the service of `request.owner`.
pub async fn serve(app: tauri::AppHandle, request: super::runtime_service_lifetime::DispatchRequest) -> Value {
    let owner = request.owner.clone();
    let version = { let app = app.clone(); let owner = owner.clone(); tauri::async_runtime::spawn_blocking(move || version_of(&app, &owner)).await.unwrap_or(Err("HostUnavailable")) };
    let version = match version { Ok(version) => version, Err("PermissionDenied") => return denied(PERMISSION).envelope(), Err(code) => return failure(code) };
    match run(&app, &owner, &version, &request.params).await { Ok(value) => json!({"ok": true, "value": value}), Err(refusal) => refusal.envelope() }
}

async fn run(app: &tauri::AppHandle, owner: &str, version: &str, params: &Value) -> Result<Value, Refusal> {
    let any = holds(app, owner, version, PERMISSION);
    if !any { return Err(denied(PERMISSION)); }
    let request = read_request(params)?;
    let check = |project: &str| granted(app, owner, version, PERMISSION, project);
    // A task by id is gated before the window hears about it: a task outside the grant is never even named to the window.
    let known = if let Target::Task(task) = &request.target {
        let project = { let app = app.clone(); let task = task.clone(); tauri::async_runtime::spawn_blocking(move || project_of(&app, &task)).await.unwrap_or(None) };
        Some(gate(PERMISSION, any, project.as_deref(), &check)?)
    } else { None };
    let mut resolve = json!({"phase": "resolve", "op": request.op.name()});
    target_fields(&mut resolve, &request.target);
    let resolved = read_resolved(&ask(app, owner, resolve).await?)?;
    // The project the window named is checked as well: a window shows any task, and the grant is the project's.
    let project = gate(PERMISSION, any, Some(&resolved.project_id), &check)?;
    if known.as_deref().is_some_and(|known| known != project) { return Err("StaleContext".into()); }
    if !request.op.mutates() { return Ok(draft_value(&resolved)); }
    // The permission is read again just before anything changes: a revoke, a narrowing or a disable in between edits nothing.
    use tauri::Manager;
    let work = app.try_state::<super::runtime_grants::RuntimeGrants>().ok_or("HostUnavailable")?.begin(owner, version, PERMISSION, &super::runtime_grants::Target::project(&project)).map_err(|_| denied(PERMISSION))?;
    if version_of(app, owner).is_err() || !check(&project) || work.is_cancelled() { return Err(denied(PERMISSION)); }
    let answer = ask(app, owner, apply_payload(&request, &resolved)).await?;
    read_applied(&request, &answer)
}

/// Serves `tasksAttachmentsRead`: a page of an attachment's bytes, under `tasks.transcript.read`.
pub async fn serve_attachment(app: tauri::AppHandle, request: super::runtime_service_lifetime::DispatchRequest) -> Value {
    let owner = request.owner.clone();
    let version = { let app = app.clone(); let owner = owner.clone(); tauri::async_runtime::spawn_blocking(move || version_of(&app, &owner)).await.unwrap_or(Err("HostUnavailable")) };
    let version = match version { Ok(version) => version, Err("PermissionDenied") => return denied(READ_PERMISSION).envelope(), Err(code) => return failure(code) };
    match read_attachment(&app, &owner, &version, &request.params).await { Ok(value) => json!({"ok": true, "value": value}), Err(refusal) => refusal.envelope() }
}

async fn read_attachment(app: &tauri::AppHandle, owner: &str, version: &str, params: &Value) -> Result<Value, Refusal> {
    use tauri::Manager;
    let any = holds(app, owner, version, READ_PERMISSION);
    if !any { return Err(denied(READ_PERMISSION)); }
    let object = params.as_object().ok_or("InvalidShape")?;
    if object.keys().any(|key| !["taskId", "attachmentId", "cursor"].contains(&key.as_str())) { return Err("InvalidShape".into()); }
    let id = |key: &str| object.get(key).and_then(Value::as_str).filter(|id| ident(id)).map(str::to_owned).ok_or_else(|| Refusal::new("InvalidShape"));
    let (task, attachment) = (id("taskId")?, id("attachmentId")?);
    let cursor = read_cursor(object)?;
    let check = |project: &str| granted(app, owner, version, READ_PERMISSION, project);
    let project = { let app = app.clone(); let task = task.clone(); tauri::async_runtime::spawn_blocking(move || project_of(&app, &task)).await.unwrap_or(None) };
    let project = gate(READ_PERMISSION, any, project.as_deref(), &check)?;
    let work = app.try_state::<super::runtime_grants::RuntimeGrants>().ok_or("HostUnavailable")?.begin(owner, version, READ_PERMISSION, &super::runtime_grants::Target::project(&project)).map_err(|_| denied(READ_PERMISSION))?;
    // A sent message's attachment is stored natively; a draft attachment is the window's.
    let stored = {
        let app = app.clone(); let (task, attachment) = (task.clone(), attachment.clone());
        tauri::async_runtime::spawn_blocking(move || -> Option<(String, String, Vec<u8>)> {
            let dir = app.path().app_data_dir().ok()?;
            let state = app.try_state::<crate::AppState>()?;
            let store = state.store.try_lock().ok()?;
            let loaded = crate::attachments::load_attachment(&store.db, &dir, &task, &attachment).ok()?;
            Some((loaded.metadata.name, loaded.metadata.mime, loaded.bytes))
        }).await.unwrap_or(None)
    };
    let page = if let Some((name, mime, bytes)) = stored { memory_page(&name, &mime, &bytes, cursor)? } else {
        let answer = ask(app, owner, json!({"phase": "attachment", "taskId": task, "attachmentId": attachment})).await?;
        if answer["ok"] != true { return Err(read_refusal(&answer)); }
        let name = answer["name"].as_str().unwrap_or("attachment").to_owned();
        let mime = answer["mime"].as_str().unwrap_or("application/octet-stream").to_owned();
        if let Some(path) = answer["path"].as_str() { file_page(Path::new(path), &name, &mime, cursor)? }
        else if let Some(text) = answer["text"].as_str() { memory_page(&name, &mime, text.as_bytes(), cursor)? }
        else { return Err("NotFound".into()); }
    };
    // Revocation or narrowing during the read wins over its result.
    if work.is_cancelled() || !check(&project) { return Err(denied(READ_PERMISSION)); }
    Ok(page)
}

/// The service of `owner` stopped (disable, revoke, uninstall, safe mode, crash, quit): its waiting rounds change nothing
/// and its ghost text leaves the screen.
pub fn service_stopped(app: &tauri::AppHandle, owner: &str) {
    use tauri::Emitter;
    if let Some(slots) = state(app) { slots.cancel_owner(owner); }
    let _ = app.emit("extensions-runtime-draft-end", json!({"owner": owner}));
}

/// A grant changed (revoke, narrowing): the window rechecks the ghost text it shows.
pub fn sweep_app(app: &tauri::AppHandle) { use tauri::Emitter; let _ = app.emit("extensions-runtime-draft-sweep", 0); }

/// The main window answers a round (`resolve`, `apply`, `attachment`).
#[tauri::command]
pub fn extensions_runtime_draft_answer(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String, answer: Value) -> Result<(), String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    let Some(slots) = state(&app) else { return Err("UnsupportedCapability".into()) };
    slots.answer(&id, &answer).map_err(str::to_owned)
}

/// The window asks whether each ghost text's package still holds `tasks.draft` for the project it shows: `[{owner, project}]`
/// in, `[bool]` out. A package that is disabled or gone is `false`.
#[tauri::command]
pub fn extensions_runtime_draft_allowed(app: tauri::AppHandle, ghosts: Vec<Value>) -> Vec<bool> {
    ghosts.iter().map(|ghost| {
        let (Some(owner), Some(project)) = (ghost["owner"].as_str(), ghost["project"].as_str()) else { return false };
        version_of(&app, owner).is_ok_and(|version| granted(&app, owner, &version, PERMISSION, project))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn code(result: Result<Request, Refusal>) -> String { result.unwrap_err().code }
    fn resolved() -> Resolved { Resolved { task_id: "t1".into(), project_id: "A".into(), revision: 7, text: "hello".into(), attachments: vec![json!({"id": "a1", "kind": "image", "name": "x.png"})] } }

    #[test]
    fn every_call_reads_its_target_and_fields_and_refuses_the_rest_as_invalid_shape() {
        assert_eq!(read_request(&json!({"op": "get", "windowId": "main"})).unwrap(), Request { target: Target::Window("main".into()), op: Op::Get });
        assert_eq!(read_request(&json!({"op": "set", "taskId": "t1", "text": "", "revision": 3})).unwrap().op, Op::Set { text: String::new(), revision: Some(3) });
        assert_eq!(read_request(&json!({"op": "insert", "taskId": "t1", "text": "x"})).unwrap().op, Op::Insert { text: "x".into() });
        assert_eq!(read_request(&json!({"op": "suggest", "windowId": "main", "text": ""})).unwrap().op, Op::Suggest { text: String::new() });
        assert_eq!(read_request(&json!({"op": "attach", "taskId": "t1", "path": "C:/a.png"})).unwrap().op, Op::Attach { path: "C:/a.png".into() });
        assert_eq!(read_request(&json!({"op": "detach", "taskId": "t1", "attachmentId": "a1"})).unwrap().op, Op::Detach { attachment_id: "a1".into() });
        for raw in [
            json!("x"), json!({}), json!({"op": "send", "taskId": "t1"}), json!({"op": "get"}), json!({"op": "get", "windowId": "w", "taskId": "t"}), json!({"op": "get", "taskId": "t1", "text": "x"}),
            json!({"op": "set", "taskId": "t1"}), json!({"op": "set", "taskId": "t1", "text": 3}), json!({"op": "set", "taskId": "t1", "text": "x", "revision": -1}), json!({"op": "set", "taskId": "t1", "text": "x", "send": true}),
            json!({"op": "insert", "taskId": "t1", "text": ""}), json!({"op": "set", "taskId": "t1", "text": "a\u{0}b"}), json!({"op": "attach", "taskId": "t1", "path": ""}), json!({"op": "detach", "taskId": "t1"}), json!({"op": "set", "taskId": "", "text": "x"}),
        ] { assert_eq!(code(read_request(&raw)), "InvalidShape", "{raw}"); }
        assert_eq!(code(read_request(&json!({"op": "set", "taskId": "t1", "text": "x".repeat(TEXT_BYTES + 1)}))), "LimitExceeded");
        assert_eq!(code(read_request(&json!({"op": "attach", "taskId": "t1", "path": "p".repeat(PATH_CHARS + 1)}))), "LimitExceeded");
        // A draft call never sends: there is no op, field or flag that does.
        assert_eq!(code(read_request(&json!({"op": "set", "taskId": "t1", "text": "x", "submit": true}))), "InvalidShape");
    }

    #[test]
    fn the_grant_answers_first_and_names_the_permission_and_an_unknown_target_is_not_found_only_to_a_holder() {
        let all = |_: &str| true;
        let only_b = |project: &str| project == "B";
        // A package that holds the permission for no project learns nothing about tasks and windows.
        let none = gate(PERMISSION, false, None, &all).unwrap_err();
        assert_eq!((none.code.as_str(), none.path.as_str()), ("PermissionDenied", "tasks.draft"));
        assert_eq!(gate(PERMISSION, false, Some("A"), &all).unwrap_err().code, "PermissionDenied");
        assert_eq!(gate(PERMISSION, true, None, &all).unwrap_err().code, "NotFound");
        assert_eq!(gate(PERMISSION, true, Some("A"), &only_b).unwrap_err().path, "tasks.draft");
        assert_eq!(gate(PERMISSION, true, Some("B"), &only_b).unwrap(), "B");
        assert_eq!(gate(READ_PERMISSION, true, Some("A"), &only_b).unwrap_err().path, "tasks.transcript.read");
    }

    #[test]
    fn the_windows_answers_become_the_draft_the_frozen_refusal_or_the_attachment_id() {
        let ok = json!({"ok": true, "taskId": "t1", "projectId": "A", "revision": 7, "text": "hello", "attachments": [{"id": "a1", "kind": "image", "name": "x.png"}, {"kind": "image"}]});
        assert_eq!(read_resolved(&ok).unwrap(), resolved());
        assert_eq!(draft_value(&resolved()), json!({"text": "hello", "attachments": [{"id": "a1", "kind": "image", "name": "x.png"}], "revision": 7}));
        for (answer, expected) in [(json!({"ok": false, "code": "Busy"}), "Busy"), (json!({"ok": false, "code": "StaleContext"}), "StaleContext"), (json!({"ok": false, "code": "NotFound"}), "NotFound"), (json!({"ok": false, "code": "Explode"}), "InvalidShape"), (json!({"ok": true, "taskId": "t1"}), "InvalidShape"), (json!(null), "InvalidShape")] {
            assert_eq!(read_resolved(&answer).unwrap_err().code, expected, "{answer}");
        }
        let attach = Request { target: Target::Task("t1".into()), op: Op::Attach { path: "C:/a.png".into() } };
        assert_eq!(read_applied(&attach, &json!({"ok": true, "id": "att-1"})).unwrap(), json!({"id": "att-1"}));
        assert_eq!(read_applied(&attach, &json!({"ok": true})).unwrap_err().code, "InvalidShape");
        let set = Request { target: Target::Task("t1".into()), op: Op::Set { text: "x".into(), revision: None } };
        assert_eq!(read_applied(&set, &json!({"ok": true})).unwrap(), Value::Null);
        assert_eq!(read_applied(&set, &json!({"ok": false, "code": "Busy"})).unwrap_err().code, "Busy");
    }

    #[test]
    fn the_apply_round_carries_the_resolved_task_the_revision_and_the_window_it_was_aimed_at() {
        let set = Request { target: Target::Window("main".into()), op: Op::Set { text: "new".into(), revision: Some(7) } };
        assert_eq!(apply_payload(&set, &resolved()), json!({"phase": "apply", "op": "set", "taskId": "t1", "revisionAtResolve": 7, "windowId": "main", "text": "new", "revision": 7}));
        let detach = Request { target: Target::Task("t1".into()), op: Op::Detach { attachment_id: "a1".into() } };
        assert_eq!(apply_payload(&detach, &resolved()), json!({"phase": "apply", "op": "detach", "taskId": "t1", "revisionAtResolve": 7, "attachmentId": "a1"}));
        assert!(Op::Get.name() == "get" && !Op::Get.mutates() && Op::Suggest { text: String::new() }.mutates());
    }

    #[test]
    fn attachments_are_read_in_256_kib_pages_by_byte_cursor_and_end_with_a_null_cursor() {
        let bytes: Vec<u8> = (0..CHUNK_BYTES * 2 + 10).map(|index| (index % 251) as u8).collect();
        let first = memory_page("x.png", "image/png", &bytes, 0).unwrap();
        assert_eq!((first["bytes"].clone(), first["nextCursor"].clone(), first["schemaVersion"].clone(), first["mime"].clone()), (json!(bytes.len()), json!(CHUNK_BYTES), json!(1), json!("image/png")));
        let decoded = base64::engine::general_purpose::STANDARD.decode(first["data"].as_str().unwrap()).unwrap();
        assert_eq!(decoded.len(), CHUNK_BYTES);
        assert_eq!(decoded[..], bytes[..CHUNK_BYTES]);
        let last = memory_page("x.png", "image/png", &bytes, (CHUNK_BYTES * 2) as u64).unwrap();
        assert_eq!((last["nextCursor"].clone(), base64::engine::general_purpose::STANDARD.decode(last["data"].as_str().unwrap()).unwrap().len()), (Value::Null, 10));
        assert_eq!(memory_page("x", "text/plain", &bytes, bytes.len() as u64).unwrap_err().code, "LimitExceeded");
        assert_eq!(memory_page("x", "text/plain", &bytes, bytes.len() as u64 + 1).unwrap_err().code, "LimitExceeded");
        assert_eq!(memory_page("empty", "text/plain", &[], 0).unwrap()["nextCursor"], Value::Null);
        assert_eq!(read_cursor(&json!({"cursor": 5}).as_object().unwrap().clone()).unwrap(), 5);
        assert_eq!(read_cursor(&json!({"cursor": -1}).as_object().unwrap().clone()).unwrap_err().code, "InvalidShape");
    }

    #[test]
    fn a_file_is_paged_from_disk_without_reading_it_whole() {
        let directory = std::env::temp_dir().join(format!("panda-draft-pages-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("big.bin");
        std::fs::write(&path, vec![7u8; CHUNK_BYTES + 5]).unwrap();
        let first = file_page(&path, "big.bin", "application/octet-stream", 0).unwrap();
        assert_eq!(first["nextCursor"], json!(CHUNK_BYTES));
        let second = file_page(&path, "big.bin", "application/octet-stream", CHUNK_BYTES as u64).unwrap();
        assert_eq!((second["nextCursor"].clone(), base64::engine::general_purpose::STANDARD.decode(second["data"].as_str().unwrap()).unwrap()), (Value::Null, vec![7u8; 5]));
        assert_eq!(file_page(&directory, "dir", "x/y", 0).unwrap_err().code, "NotFound");
        assert_eq!(file_page(&directory.join("gone"), "gone", "x/y", 0).unwrap_err().code, "NotFound");
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn waiting_rounds_are_bounded_per_package_answered_once_and_end_with_the_service() {
        let slots = DraftSlots::default();
        let mut open = vec![];
        for _ in 0..MAX_WAITING { open.push(slots.begin("sample.drafts").unwrap()); }
        assert_eq!(slots.begin("sample.drafts").err(), Some("LimitExceeded"));
        assert!(slots.begin("sample.other").is_ok());
        let (id, mut receiver) = open.remove(0);
        slots.answer(&id, &json!({"ok": true})).unwrap();
        assert_eq!(receiver.try_recv().unwrap(), json!({"ok": true}));
        assert_eq!(slots.answer(&id, &json!({"ok": true})).unwrap_err(), "NotFound");
        assert_eq!(slots.cancel_owner("sample.drafts"), MAX_WAITING - 1);
        for (_, mut receiver) in open { assert_eq!(receiver.try_recv().unwrap()["code"], "Revoked"); }
        assert_eq!((slots.count("sample.drafts"), slots.count("sample.other")), (0, 1));
    }
}
