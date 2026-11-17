//! Messages, notes and the revisioned queue for background services (`tasks.message`, runtime phase R4, slice R0402).
//!
//! A trusted service talks to a task the way the user does: `panda.tasks.message(taskId, {text, attachments?, delivery?})`
//! sends to an idle task as a new turn, queues behind a running one, or (`delivery: 'steer'`) injects into the running
//! turn where the harness takes that. `panda.tasks.note(taskId, {text, forModel?})` adds a labelled line to the transcript
//! that starts no turn; with `forModel: true` (which also needs `harness.hooks.context`) the note is kept and rides the
//! next message of that task as labelled context. `panda.tasks.queue.*` lists, edits, removes, reorders, sends and resumes
//! the queued follow-ups. One permission, `tasks.message` (project scoped), covers all of it and is rechecked on every
//! request, twice (admission, then again once the task's send lock is held). A package that holds it is never asked
//! again per action (ADR-0005).
//!
//! Frozen refusals (the grant always answers first, so nothing about a task is revealed without it):
//! - no grant, revoked, disabled package, project outside the narrowed scope: `PermissionDenied` with the permission in
//!   `path` (`harness.hooks.context` for a `forModel` note);
//! - an unknown task or queue entry (including one that was sent or removed meanwhile, or belongs to another task):
//!   `NotFound`; a stale `revision`, or a reorder that does not name exactly the queue's entries: `StaleContext`;
//! - `delivery: 'steer'` on a harness (or a team) that cannot steer, or with attachments: `UnsupportedCapability`, and
//!   nothing is queued in its place, so the package knows the message did not land;
//! - a shape the call does not take: `InvalidShape`; a size or count bound: `LimitExceeded`.
//!
//! Delivery is exactly once: a send takes the task's send lock, looks at whether the agent runs, and then does exactly
//! one of send, queue or steer. A queued entry leaves the queue only through the queue's own `take` (the run-end drain,
//! the headless drain, or `sendNow`), which deletes it in the same statement that returns it.
//!
//! Attribution (file-backed, independent of SQLite): queue entries a package added carry its name (`task-message-origins.json`,
//! shown as a chip on the queue row; an edit by another package does not take the entry over), and every message a
//! package sent or steered, and every note, leaves a labelled line in the transcript. Next-send `forModel` notes live in
//! `task-notes.json` until the next message of the task takes them: [`take_context`] is the one reader (R0504 reads it
//! during `prompt.submit`; this module's own send path reads it for the messages it sends).
//!
//! The rules that remain are for predictability and fault isolation, never for trust: bounded text, 16 attachments, 20
//! pending notes per task, a ledger of at most 5,000 entries. The state is pure (an injected world) so the rules are
//! deterministic to test; the app half only adds the grants file, the store, the agents and the window.
use serde_json::{json, Map, Value};
use std::{collections::{BTreeMap, HashMap, VecDeque}, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock, Weak}};

use super::runtime_tasks_start::{failure, Refusal};

pub const PERMISSION: &str = "tasks.message";
pub const CONTEXT_PERMISSION: &str = "harness.hooks.context";
pub const TEXT_BYTES: usize = 200_000;
pub const NOTE_BYTES: usize = 16_000;
pub const MAX_ATTACHMENTS: usize = 16;
pub const MAX_NOTES_PER_TASK: usize = 20;
pub const MAX_LEDGER: usize = 5_000;
/// A queued text longer than this is cut in `queue.list` (`truncated: true`); the entry itself is whole.
pub const VIEW_CHARS: usize = 20_000;
const MESSAGE_KEYS: [&str; 3] = ["text", "attachments", "delivery"];
const OPS: [&str; 6] = ["list", "update", "remove", "reorder", "sendNow", "resume"];

fn ident(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control) }
fn ok(value: Value) -> Value { json!({"ok": true, "value": value}) }
fn invalid() -> Refusal { Refusal::new("InvalidShape") }
pub fn denied(permission: &str) -> Refusal { Refusal { code: "PermissionDenied".into(), path: permission.into(), ids: vec![] } }
fn unsupported(path: &str) -> Refusal { Refusal { code: "UnsupportedCapability".into(), path: path.into(), ids: vec![] } }

/// How a message wants to travel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery { Auto, Queue, Steer }

/// What the app answers about the world; tests give fixed answers.
pub struct World<'a> {
    /// The project a task belongs to (`None`: no such task).
    pub project_of: &'a dyn Fn(&str) -> Option<String>,
    /// The package holds `permission` for `project` now (the grants file, narrowing included).
    pub granted: &'a dyn Fn(&str, &str) -> bool,
    /// The package holds `permission` for at least one project (so an unknown task may answer `NotFound`).
    pub holds_any: &'a dyn Fn(&str) -> bool,
}

/// A validated `tasks.message` request.
#[derive(Clone, Debug, PartialEq)]
pub struct Message { pub task_id: String, pub project_id: String, pub text: String, pub attachments: Vec<String>, pub delivery: Delivery }
/// A validated `tasks.note` request.
#[derive(Clone, Debug, PartialEq)]
pub struct Note { pub task_id: String, pub project_id: String, pub text: String, pub for_model: bool }
/// One queue operation.
#[derive(Clone, Debug, PartialEq)]
pub enum QueueOp { List, Update { entry: String, text: String, revision: Option<u64> }, Remove { entry: String }, Reorder { entries: Vec<String> }, SendNow { entry: String }, Resume }
#[derive(Clone, Debug, PartialEq)]
pub struct Queue { pub task_id: String, pub project_id: String, pub op: QueueOp }

/// The grant answers first: shape of the task id, the project the task is in, then the permission for that project.
fn scope(world: &World, raw: &Map<String, Value>, permission: &str) -> Result<(String, String), Refusal> {
    let task = raw.get("taskId").and_then(Value::as_str).filter(|id| ident(id)).ok_or_else(invalid)?.to_owned();
    match (world.project_of)(&task) {
        // An unknown task is `NotFound` only to a package that holds the permission somewhere; otherwise the grant answers.
        None => Err(if (world.holds_any)(permission) { Refusal::new("NotFound") } else { denied(permission) }),
        Some(project) if (world.granted)(permission, &project) => Ok((task, project)),
        Some(_) => Err(denied(permission)),
    }
}
fn only_keys(object: &Map<String, Value>, allowed: &[&str]) -> Result<(), Refusal> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) { Err(invalid()) } else { Ok(()) }
}

/// Reads `{taskId, message: {text, attachments?, delivery?}}` and checks it.
pub fn admit_message(world: &World, raw: &Value) -> Result<Message, Refusal> {
    let object = raw.as_object().ok_or_else(invalid)?;
    let (task_id, project_id) = scope(world, object, PERMISSION)?;
    only_keys(object, &["taskId", "message"])?;
    let message = object.get("message").and_then(Value::as_object).ok_or_else(invalid)?;
    only_keys(message, &MESSAGE_KEYS)?;
    let text = match message.get("text") { Some(Value::String(text)) => text.clone(), None | Some(Value::Null) => String::new(), Some(_) => return Err(invalid()) };
    if text.len() > TEXT_BYTES { return Err(Refusal::new("LimitExceeded")); }
    let attachments = match message.get("attachments") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(items)) => {
            if items.len() > MAX_ATTACHMENTS { return Err(Refusal::new("LimitExceeded")); }
            items.iter().map(|item| item.as_str().filter(|id| ident(id)).map(str::to_owned).ok_or_else(invalid)).collect::<Result<Vec<_>, _>>()?
        }
        Some(_) => return Err(invalid()),
    };
    if text.trim().is_empty() && attachments.is_empty() { return Err(invalid()); }
    let delivery = match message.get("delivery") {
        None | Some(Value::Null) => Delivery::Auto,
        Some(Value::String(kind)) if kind == "queue" => Delivery::Queue,
        Some(Value::String(kind)) if kind == "steer" => Delivery::Steer,
        Some(_) => return Err(invalid()),
    };
    Ok(Message { task_id, project_id, text, attachments, delivery })
}

/// Reads `{taskId, note: {text, forModel?}}` and checks it. A `forModel` note needs `harness.hooks.context` too, and that
/// grant is checked before the rest of the shape, as the first one is.
pub fn admit_note(world: &World, raw: &Value) -> Result<Note, Refusal> {
    let object = raw.as_object().ok_or_else(invalid)?;
    let (task_id, project_id) = scope(world, object, PERMISSION)?;
    let wants_context = object.get("note").and_then(|note| note.get("forModel")) == Some(&Value::Bool(true));
    if wants_context && !(world.granted)(CONTEXT_PERMISSION, &project_id) { return Err(denied(CONTEXT_PERMISSION)); }
    only_keys(object, &["taskId", "note"])?;
    let note = object.get("note").and_then(Value::as_object).ok_or_else(invalid)?;
    only_keys(note, &["text", "forModel"])?;
    let text = note.get("text").and_then(Value::as_str).ok_or_else(invalid)?;
    if text.trim().is_empty() { return Err(invalid()); }
    if text.len() > NOTE_BYTES { return Err(Refusal::new("LimitExceeded")); }
    let for_model = match note.get("forModel") { None | Some(Value::Null) => false, Some(Value::Bool(flag)) => *flag, Some(_) => return Err(invalid()) };
    Ok(Note { task_id, project_id, text: text.to_owned(), for_model })
}

/// Reads `{op, taskId, entryId?, change?, entryIds?}` and checks it.
pub fn admit_queue(world: &World, raw: &Value) -> Result<Queue, Refusal> {
    let object = raw.as_object().ok_or_else(invalid)?;
    let (task_id, project_id) = scope(world, object, PERMISSION)?;
    only_keys(object, &["op", "taskId", "entryId", "change", "entryIds"])?;
    let op = object.get("op").and_then(Value::as_str).filter(|op| OPS.contains(op)).ok_or_else(invalid)?;
    let entry = || object.get("entryId").and_then(Value::as_str).filter(|id| ident(id)).map(str::to_owned).ok_or_else(invalid);
    let op = match op {
        "list" => QueueOp::List,
        "resume" => QueueOp::Resume,
        "remove" => QueueOp::Remove { entry: entry()? },
        "sendNow" => QueueOp::SendNow { entry: entry()? },
        "update" => {
            let entry = entry()?;
            let change = object.get("change").and_then(Value::as_object).ok_or_else(invalid)?;
            only_keys(change, &["text", "revision"])?;
            let text = change.get("text").and_then(Value::as_str).ok_or_else(invalid)?;
            if text.trim().is_empty() { return Err(invalid()); }
            if text.len() > TEXT_BYTES { return Err(Refusal::new("LimitExceeded")); }
            let revision = match change.get("revision") { None | Some(Value::Null) => None, Some(value) => Some(value.as_u64().ok_or_else(invalid)?) };
            QueueOp::Update { entry, text: text.to_owned(), revision }
        }
        _ => {
            let ids = object.get("entryIds").and_then(Value::as_array).ok_or_else(invalid)?;
            let entries = ids.iter().map(|id| id.as_str().filter(|id| ident(id)).map(str::to_owned).ok_or_else(invalid)).collect::<Result<Vec<_>, _>>()?;
            let mut sorted = entries.clone();
            sorted.sort();
            sorted.dedup();
            if sorted.len() != entries.len() { return Err(invalid()); }
            QueueOp::Reorder { entries }
        }
    };
    Ok(Queue { task_id, project_id, op })
}

/// Where a message goes: decided once, under the task's send lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plan { Send, Queue, Steer }

/// Idle: a new turn (a steer with nothing to steer is a plain send; an explicit `queue` queues and the drain sends it).
/// Busy: queue, or steer where the harness takes it. A steer the harness or team cannot take is `UnsupportedCapability`
/// and never silently becomes a queue entry.
pub fn plan(busy: bool, delivery: Delivery, steerable: bool, attachments: bool) -> Result<Plan, Refusal> {
    match (busy, delivery) {
        (false, Delivery::Queue) => Ok(Plan::Queue),
        (false, _) => Ok(Plan::Send),
        (true, Delivery::Auto | Delivery::Queue) => Ok(Plan::Queue),
        (true, Delivery::Steer) if !steerable => Err(unsupported("delivery")),
        (true, Delivery::Steer) if attachments => Err(unsupported("attachments")),
        (true, Delivery::Steer) => Ok(Plan::Steer),
    }
}

/// How a failed steer reads: the agent ended meanwhile (so the message is sent as a turn), the harness cannot steer, or
/// the harness did not take it now.
#[derive(Debug, PartialEq, Eq)]
pub enum SteerFailure { Idle, Refused(Refusal) }
pub fn steer_failure(error: &str) -> SteerFailure {
    let error = error.to_lowercase();
    if error.contains("is not running") { SteerFailure::Idle }
    else if error.contains("cannot be steered") { SteerFailure::Refused(unsupported("delivery")) }
    else if error.contains("skill") { SteerFailure::Refused(invalid()) }
    else if error.contains("under 16 mib") { SteerFailure::Refused(Refusal::new("LimitExceeded")) }
    else { SteerFailure::Refused(Refusal::new("HostUnavailable")) }
}

/// Maps the text of a failed queue operation to the frozen code. Nothing of the text reaches the package.
pub fn queue_code(error: &str) -> &'static str {
    let error = error.to_lowercase();
    if error.contains("queue changed") { "StaleContext" }
    else if error.contains("already sent or removed") || error.contains("not found") || error.contains("does not exist") { "NotFound" }
    else if error.contains("up to") || error.contains("too large") || error.contains("under 16 mib") { "LimitExceeded" }
    else if error.contains("write a message") || error.contains("invalid") || error.contains("skill") || error.contains("switched off") { "InvalidShape" }
    else { super::runtime_tasks_start::code_of(&error) }
}

// ---- Queue revision ------------------------------------------------------------------------------------------------

/// The revision of a task's queue: a content hash of the ids, order, texts, attachment counts and edit times, so every
/// change by anyone (the user, an agent, a phone, a package) moves it and no counter has to be kept in step. FNV-1a over
/// the UTF-8 bytes, masked to 53 bits so the number is exact in JavaScript.
pub fn revision(entries: &[crate::message_queue::QueuedMessage]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| { for byte in bytes { hash ^= u64::from(*byte); hash = hash.wrapping_mul(0x0000_0100_0000_01b3); } };
    for entry in entries {
        let attachments = entry.attachments.as_array().map_or(0, Vec::len);
        feed(format!("{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}", entry.id, entry.position, attachments, entry.updated_at).as_bytes());
        feed(entry.text.as_bytes());
        feed(b"\x1e");
    }
    hash & ((1u64 << 53) - 1)
}

// ---- Notes for the model ---------------------------------------------------------------------------------------------

/// One note waiting for the task's next message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingNote { pub id: String, pub owner: String, pub package: String, pub text: String, pub at: u64 }

/// The labelled block a message carries for its pending notes.
pub fn render_context(notes: &[PendingNote]) -> String {
    let mut block = String::from("Notes added by extensions for this message (not written by the user):");
    for note in notes { block.push_str(&format!("\n- [{}] {}", note.package, note.text.trim().replace('\n', "\n  "))); }
    block
}
/// A typed slash command is the harness's own syntax: it never gets a block in front of it (the notes wait for the next
/// message that is not one).
pub fn carries_context(text: &str) -> bool { !text.trim_start().starts_with('/') }

// ---- The ledgers -----------------------------------------------------------------------------------------------------

/// Who put a queue entry there, and who changed it last.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryOrigin { pub task_id: String, pub owner: String, pub package: String, pub at: u64, pub changed_by: Option<String> }

#[derive(Default)]
struct Ledger { entries: BTreeMap<String, EntryOrigin>, order: VecDeque<String>, revision: u64 }
#[derive(Default)]
struct Notes { tasks: BTreeMap<String, Vec<PendingNote>>, serial: u64 }

/// Attribution of queue entries and the next-send notes. Persisted next to the grants so the labels and pending notes
/// survive a restart; independent of SQLite.
pub struct TaskMessages { ledger: Mutex<Ledger>, notes: Mutex<Notes>, directory: Option<PathBuf> }
impl Default for TaskMessages { fn default() -> Self { Self { ledger: Mutex::new(Ledger::default()), notes: Mutex::new(Notes::default()), directory: None } } }

fn write_atomic(file: &Path, value: &Value) {
    let temporary = file.with_extension("json.tmp");
    if std::fs::write(&temporary, value.to_string()).is_ok() { let _ = std::fs::rename(&temporary, file); }
}

impl TaskMessages {
    /// Opens (or starts) the ledgers in `dir`; an unreadable file starts empty and is replaced on the next write.
    pub fn open(dir: &Path) -> Self {
        let mut ledger = Ledger::default();
        if let Ok(text) = std::fs::read_to_string(dir.join("task-message-origins.json")) {
            if let Ok(Value::Object(rows)) = serde_json::from_str::<Value>(&text).map(|value| value["entries"].clone()) {
                let mut rows: Vec<(String, EntryOrigin)> = rows.iter().filter_map(|(id, row)| Some((id.clone(), EntryOrigin { task_id: row["taskId"].as_str()?.to_owned(), owner: row["owner"].as_str()?.to_owned(), package: row["package"].as_str()?.to_owned(), at: row["at"].as_u64().unwrap_or(0), changed_by: row["changedBy"].as_str().map(str::to_owned) }))).collect();
                rows.sort_by_key(|(_, origin)| origin.at);
                for (id, origin) in rows { ledger.order.push_back(id.clone()); ledger.entries.insert(id, origin); }
            }
        }
        let mut notes = Notes::default();
        if let Ok(text) = std::fs::read_to_string(dir.join("task-notes.json")) {
            if let Ok(Value::Object(tasks)) = serde_json::from_str::<Value>(&text).map(|value| value["tasks"].clone()) {
                for (task, rows) in tasks {
                    let rows: Vec<PendingNote> = rows.as_array().into_iter().flatten().filter_map(|row| Some(PendingNote { id: row["id"].as_str()?.to_owned(), owner: row["owner"].as_str()?.to_owned(), package: row["package"].as_str()?.to_owned(), text: row["text"].as_str()?.to_owned(), at: row["at"].as_u64().unwrap_or(0) })).take(MAX_NOTES_PER_TASK).collect();
                    notes.serial += rows.len() as u64;
                    if !rows.is_empty() { notes.tasks.insert(task, rows); }
                }
            }
        }
        Self { ledger: Mutex::new(ledger), notes: Mutex::new(notes), directory: Some(dir.to_path_buf()) }
    }
    fn save_ledger(&self, ledger: &Ledger) {
        let Some(directory) = &self.directory else { return };
        let entries: Map<String, Value> = ledger.order.iter().filter_map(|id| ledger.entries.get(id).map(|origin| (id.clone(), json!({"taskId": origin.task_id, "owner": origin.owner, "package": origin.package, "at": origin.at, "changedBy": origin.changed_by})))).collect();
        write_atomic(&directory.join("task-message-origins.json"), &json!({"schemaVersion": 1, "entries": entries}));
    }
    fn save_notes(&self, notes: &Notes) {
        let Some(directory) = &self.directory else { return };
        let tasks: Map<String, Value> = notes.tasks.iter().map(|(task, rows)| (task.clone(), Value::Array(rows.iter().map(|note| json!({"id": note.id, "owner": note.owner, "package": note.package, "text": note.text, "at": note.at})).collect()))).collect();
        write_atomic(&directory.join("task-notes.json"), &json!({"schemaVersion": 1, "tasks": tasks}));
    }

    /// Labels a queue entry a package added. A second record of the same entry keeps the first.
    pub fn record_entry(&self, entry: &str, origin: EntryOrigin) {
        let Ok(mut ledger) = self.ledger.lock() else { return };
        if ledger.entries.contains_key(entry) { return; }
        ledger.entries.insert(entry.to_owned(), origin);
        ledger.order.push_back(entry.to_owned());
        while ledger.order.len() > MAX_LEDGER { if let Some(oldest) = ledger.order.pop_front() { ledger.entries.remove(&oldest); } }
        ledger.revision += 1;
        self.save_ledger(&ledger);
    }
    /// A package edited an entry: the creator's label stays, the editor is named beside it. Only labelled entries change.
    pub fn changed_entry(&self, entry: &str, package: &str) {
        let Ok(mut ledger) = self.ledger.lock() else { return };
        let Some(origin) = ledger.entries.get_mut(entry) else { return };
        if origin.package == package { return; }
        origin.changed_by = Some(package.to_owned());
        ledger.revision += 1;
        self.save_ledger(&ledger);
    }
    pub fn forget_entry(&self, entry: &str) -> bool {
        let Ok(mut ledger) = self.ledger.lock() else { return false };
        if ledger.entries.remove(entry).is_none() { return false; }
        ledger.order.retain(|id| id != entry);
        ledger.revision += 1;
        self.save_ledger(&ledger);
        true
    }
    pub fn entry(&self, entry: &str) -> Option<EntryOrigin> { self.ledger.lock().ok().and_then(|ledger| ledger.entries.get(entry).cloned()) }
    pub fn revision_of_ledger(&self) -> u64 { self.ledger.lock().map_or(0, |ledger| ledger.revision) }
    /// What the interface reads: entry id to `{owner, package, changedBy?}`, and the revision that moves with every record.
    pub fn snapshot(&self) -> Value {
        let Ok(ledger) = self.ledger.lock() else { return json!({"revision": 0, "entries": {}}) };
        let entries: Map<String, Value> = ledger.entries.iter().map(|(id, origin)| (id.clone(), json!({"taskId": origin.task_id, "owner": origin.owner, "package": origin.package, "changedBy": origin.changed_by}))).collect();
        json!({"revision": ledger.revision, "entries": entries})
    }

    /// Keeps a `forModel` note for the task's next message. More than 20 waiting is `LimitExceeded`.
    pub fn add_note(&self, task: &str, owner: &str, package: &str, text: &str, at: u64) -> Result<String, &'static str> {
        let mut notes = self.notes.lock().map_err(|_| "HostUnavailable")?;
        if notes.tasks.get(task).is_some_and(|rows| rows.len() >= MAX_NOTES_PER_TASK) { return Err("LimitExceeded"); }
        notes.serial += 1;
        let id = format!("note-{}", notes.serial);
        notes.tasks.entry(task.to_owned()).or_default().push(PendingNote { id: id.clone(), owner: owner.to_owned(), package: package.to_owned(), text: text.to_owned(), at });
        self.save_notes(&notes);
        Ok(id)
    }
    /// The one reader: removes and returns the task's waiting notes, oldest first. Taking is atomic, so two senders never
    /// both carry the same note.
    pub fn take_notes(&self, task: &str) -> Vec<PendingNote> {
        let Ok(mut notes) = self.notes.lock() else { return vec![] };
        let taken = notes.tasks.remove(task).unwrap_or_default();
        if !taken.is_empty() { self.save_notes(&notes); }
        taken
    }
    /// Puts taken notes back at the front when the message they were to ride never saved.
    pub fn restore_notes(&self, task: &str, taken: Vec<PendingNote>) {
        if taken.is_empty() { return; }
        let Ok(mut notes) = self.notes.lock() else { return };
        let rows = notes.tasks.entry(task.to_owned()).or_default();
        let later = std::mem::take(rows);
        rows.extend(taken);
        rows.extend(later);
        rows.truncate(MAX_NOTES_PER_TASK);
        self.save_notes(&notes);
    }
    pub fn pending_notes(&self, task: &str) -> usize { self.notes.lock().map_or(0, |notes| notes.tasks.get(task).map_or(0, Vec::len)) }
    /// A deleted task loses its labels and its waiting notes.
    pub fn forget_task(&self, task: &str) -> bool {
        let mut changed = false;
        if let Ok(mut ledger) = self.ledger.lock() {
            let gone: Vec<String> = ledger.entries.iter().filter(|(_, origin)| origin.task_id == task).map(|(id, _)| id.clone()).collect();
            if !gone.is_empty() { for id in &gone { ledger.entries.remove(id); } ledger.order.retain(|id| !gone.contains(id)); ledger.revision += 1; self.save_ledger(&ledger); changed = true; }
        }
        if let Ok(mut notes) = self.notes.lock() { if notes.tasks.remove(task).is_some() { self.save_notes(&notes); } }
        changed
    }
}

/// The labelled notes of the task's next message, as one block, taken so no other sender carries them. R0504 reads this
/// during `prompt.submit`; give them back with [`restore_context`] when the message never saved. A text that is a typed
/// slash command takes nothing.
pub fn take_context(app: &tauri::AppHandle, task: &str, text: &str) -> Option<(String, Vec<PendingNote>)> {
    if !carries_context(text) { return None; }
    let notes = messages(app)?.take_notes(task);
    if notes.is_empty() { None } else { Some((render_context(&notes), notes)) }
}
pub fn restore_context(app: &tauri::AppHandle, task: &str, notes: Vec<PendingNote>) { if let Some(store) = messages(app) { store.restore_notes(task, notes); } }

// ---- Sent entries as the window sees them -----------------------------------------------------------------------------

fn entry_view(entry: &crate::message_queue::QueuedMessage, index: usize, origin: Option<EntryOrigin>) -> Value {
    let truncated = entry.text.chars().count() > VIEW_CHARS;
    let mut view = json!({
        "id": entry.id, "position": index, "text": if truncated { entry.text.chars().take(VIEW_CHARS).collect::<String>() } else { entry.text.clone() },
        "truncated": truncated, "attachments": entry.attachments.as_array().map_or(0, Vec::len), "createdAt": entry.created_at, "updatedAt": entry.updated_at,
    });
    if let Some(origin) = origin { view["package"] = json!(origin.package); if let Some(changed) = origin.changed_by { view["changedBy"] = json!(changed); } }
    view
}
/// `queue.list`'s answer: the revision and the entries in the order they will be sent.
pub fn queue_view(entries: &[crate::message_queue::QueuedMessage], origin: &dyn Fn(&str) -> Option<EntryOrigin>) -> Value {
    json!({"revision": revision(entries), "entries": entries.iter().enumerate().map(|(index, entry)| entry_view(entry, index, origin(&entry.id))).collect::<Vec<_>>()})
}

// ---- The app ---------------------------------------------------------------------------------------------------------

pub fn messages(app: &tauri::AppHandle) -> Option<tauri::State<'_, TaskMessages>> { use tauri::Manager; app.try_state::<TaskMessages>() }
fn origins_changed(app: &tauri::AppHandle) { use tauri::Emitter; let _ = app.emit("extensions-runtime-message-origins", messages(app).map_or(0, |ledger| ledger.revision_of_ledger())); }

struct Caller { owner: String, version: String, name: String }

fn caller(app: &tauri::AppHandle, owner: &str) -> Result<Caller, &'static str> {
    use tauri::Manager;
    let packages = app.state::<crate::extensions::packages::ExtensionPackages>();
    let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
    let version = super::runtime_service_lifetime::runtime_usage_resources::enabled_version(&packages, owner).ok_or("PermissionDenied")?;
    let snapshot = serde_json::to_value(packages.snapshot()).unwrap_or(Value::Null);
    let name = snapshot["packages"].as_array().into_iter().flatten().find(|package| package["manifest"]["id"] == owner).and_then(|package| package["manifest"]["name"].as_str().filter(|name| !name.trim().is_empty()).map(str::to_owned)).unwrap_or_else(|| owner.to_owned());
    Ok(Caller { owner: owner.to_owned(), version, name })
}

fn held(app: &tauri::AppHandle, caller: &Caller, permission: &str, project: &str) -> bool {
    use tauri::Manager;
    app.try_state::<super::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(&caller.owner, &caller.version, permission, &super::runtime_grants::Target::project(project)).is_ok())
}

fn with_world<T>(app: &tauri::AppHandle, caller: &Caller, run: impl FnOnce(&World) -> Result<T, Refusal>) -> Result<T, Refusal> {
    use tauri::Manager;
    let project_of = |task: &str| app.try_state::<crate::AppState>().and_then(|state| state.store.lock().ok().and_then(|store| store.session(task).ok().map(|task| task.project_id)));
    let granted = |permission: &str, project: &str| held(app, caller, permission, project);
    let holds_any = |permission: &str| app.try_state::<crate::AppState>().is_some_and(|state| state.store.lock().is_ok_and(|store| store.projects().is_ok_and(|projects| projects.iter().any(|project| held(app, caller, permission, &project.id)))));
    run(&World { project_of: &project_of, granted: &granted, holds_any: &holds_any })
}

/// One send lock per task for this module's senders: the busy check and the send (which returns once the turn starts) are
/// one step, so two calls never both see the task idle.
fn send_locks() -> &'static Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>> { static LOCKS: OnceLock<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new(); LOCKS.get_or_init(Default::default) }
async fn send_lock(task: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let lock = {
        let mut table = send_locks().lock().unwrap_or_else(|error| error.into_inner());
        table.retain(|_, lock| lock.strong_count() > 0);
        match table.get(task).and_then(Weak::upgrade) {
            Some(lock) => lock,
            None => { let lock = Arc::new(tokio::sync::Mutex::new(())); table.insert(task.to_owned(), Arc::downgrade(&lock)); lock }
        }
    };
    lock.lock_owned().await
}

fn busy(state: &crate::AppState, task: &str) -> Result<bool, Refusal> {
    crate::run_requests::lock_agents(&state.agents).map(|agents| agents.contains_key(task)).map_err(|_| Refusal::new("HostUnavailable"))
}
fn team(state: &crate::AppState, task: &str) -> bool { state.store.lock().is_ok_and(|store| crate::architect::load(&store, task).ok().flatten().is_some()) }
fn newest_user(state: &crate::AppState, task: &str) -> i64 {
    state.store.lock().ok().and_then(|store| store.db.query_row("SELECT COALESCE(MAX(id),0) FROM messages WHERE session_id=?1 AND role='user'", [task], |row| row.get(0)).ok()).unwrap_or(0)
}
/// A labelled line in the transcript: the thread shows which package acted. Not part of any prompt.
fn label_line(app: &tauri::AppHandle, task: &str, text: &str) -> Option<i64> {
    use tauri::{Emitter, Manager};
    let state = app.try_state::<crate::AppState>()?;
    let row = state.store.lock().ok()?.insert_message(task, "system", text).ok();
    let _ = app.emit("sessions-changed", ());
    row
}
fn recheck(app: &tauri::AppHandle, caller: &Caller, project: &str, permissions: &[&str]) -> Result<(), Refusal> {
    if caller_still(app, caller) && permissions.iter().all(|permission| held(app, caller, permission, project)) { Ok(()) } else { Err(denied(permissions.first().copied().unwrap_or(PERMISSION))) }
}
fn caller_still(app: &tauri::AppHandle, caller: &Caller) -> bool { self::caller(app, &caller.owner).is_ok() }
fn images(attachments: &[String]) -> Option<Vec<String>> { if attachments.is_empty() { None } else { Some(attachments.to_vec()) } }
fn queued_attachments(attachments: &[String]) -> Value { Value::Array(attachments.iter().map(|id| json!({"kind": "image", "id": id, "name": "Image", "width": 0, "height": 0, "thumbnail": "", "source": "file"})).collect()) }
fn changed(app: &tauri::AppHandle, task: &str) {
    use tauri::Emitter;
    let _ = app.emit("queue-changed", json!({"sessionId": task}));
    crate::headless::queue_changed(app, task);
}

/// Serves `tasksMessage`, `tasksNote` and `tasksQueue` of the service of `request.owner`.
pub async fn serve(app: tauri::AppHandle, request: super::runtime_service_lifetime::DispatchRequest) -> Value {
    let found = { let app = app.clone(); let owner = request.owner.clone(); tauri::async_runtime::spawn_blocking(move || caller(&app, &owner)).await.unwrap_or(Err("HostUnavailable")) };
    let caller = match found { Ok(caller) => caller, Err(code) => return if code == "PermissionDenied" { denied(PERMISSION).envelope() } else { failure(code) } };
    let result = match request.method.as_str() {
        "tasksMessage" => message(&app, &caller, &request.params).await,
        "tasksNote" => note(&app, &caller, &request.params),
        "tasksQueue" => queue(&app, &caller, &request.params).await,
        _ => Err(Refusal::new("UnsupportedCapability")),
    };
    match result { Ok(value) => ok(value), Err(refusal) => refusal.envelope() }
}

async fn message(app: &tauri::AppHandle, caller: &Caller, params: &Value) -> Result<Value, Refusal> {
    use tauri::Manager;
    let spec = with_world(app, caller, |world| admit_message(world, params))?;
    let state = app.state::<crate::AppState>();
    let _turn = send_lock(&spec.task_id).await;
    // The permission is read again once the task's turn is ours: a revoke or a narrowing while we waited sends nothing.
    recheck(app, caller, &spec.project_id, &[PERMISSION])?;
    let plan = plan(busy(&state, &spec.task_id)?, spec.delivery, !team(&state, &spec.task_id), !spec.attachments.is_empty())?;
    match plan {
        Plan::Queue => queue_message(app, caller, &spec).await,
        Plan::Send => send_message(app, caller, &spec).await,
        Plan::Steer => match steer_message(app, caller, &spec).await {
            Err(SteerFailure::Idle) => send_message(app, caller, &spec).await,
            Err(SteerFailure::Refused(refusal)) => Err(refusal),
            Ok(value) => Ok(value),
        },
    }
}

async fn queue_message(app: &tauri::AppHandle, caller: &Caller, spec: &Message) -> Result<Value, Refusal> {
    use tauri::Manager;
    let entry = crate::message_queue::queue_add(app.state::<crate::AppState>(), spec.task_id.clone(), spec.text.clone(), Some(queued_attachments(&spec.attachments))).await.map_err(|error| Refusal::new(queue_code(&error)))?;
    if let Some(store) = messages(app) { store.record_entry(&entry.id, EntryOrigin { task_id: spec.task_id.clone(), owner: caller.owner.clone(), package: caller.name.clone(), at: super::runtime_notifications::now_millis(), changed_by: None }); }
    origins_changed(app);
    changed(app, &spec.task_id);
    Ok(json!({"id": entry.id, "delivery": "queued"}))
}

/// Sends `text` as a new turn, with the waiting notes in front of it. The notes go back when the message never saved.
async fn send_text(app: &tauri::AppHandle, task: &str, text: &str, attachments: Option<Vec<String>>) -> Result<i64, Refusal> {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    let carried = take_context(app, task, text);
    let body = match &carried { Some((block, _)) => format!("{block}\n\n{text}"), None => text.to_owned() };
    let before = newest_user(&state, task);
    match crate::send_prompt(app.clone(), app.state::<crate::AppState>(), task.to_owned(), body, attachments).await {
        Ok(()) => Ok(newest_user(&state, task)),
        Err(error) => {
            // Saved and then the harness failed to start: the notes went with the saved prompt.
            if let Some((_, notes)) = carried { if newest_user(&state, task) <= before { restore_context(app, task, notes); } }
            Err(Refusal::new(super::runtime_tasks_start::code_of(&error)))
        }
    }
}

async fn send_message(app: &tauri::AppHandle, caller: &Caller, spec: &Message) -> Result<Value, Refusal> {
    use tauri::Emitter;
    let id = send_text(app, &spec.task_id, &spec.text, images(&spec.attachments)).await?;
    label_line(app, &spec.task_id, &format!("Sent by {}", caller.name));
    let _ = app.emit("sessions-changed", ());
    Ok(json!({"id": id.to_string(), "delivery": "sent"}))
}

async fn steer_message(app: &tauri::AppHandle, caller: &Caller, spec: &Message) -> Result<Value, SteerFailure> {
    use tauri::Manager;
    match crate::message_queue::steer_task(app.clone(), app.state::<crate::AppState>(), spec.task_id.clone(), spec.text.clone()).await {
        Ok(reply) => {
            label_line(app, &spec.task_id, &format!("Steered by {}", caller.name));
            Ok(json!({"id": reply["id"].as_str().unwrap_or_default(), "delivery": "steered"}))
        }
        Err(error) => Err(steer_failure(&error)),
    }
}

fn note(app: &tauri::AppHandle, caller: &Caller, params: &Value) -> Result<Value, Refusal> {
    let spec = with_world(app, caller, |world| admit_note(world, params))?;
    let mut needed = vec![PERMISSION];
    if spec.for_model { needed.push(CONTEXT_PERMISSION); }
    recheck(app, caller, &spec.project_id, &needed)?;
    let store = messages(app).ok_or_else(|| Refusal::new("UnsupportedCapability"))?;
    // A note starts no turn: it is one transcript line, and for the model one pending block kept for the next message.
    let line = if spec.for_model { format!("Note for the model from {}: {}", caller.name, spec.text.trim()) } else { format!("Note from {}: {}", caller.name, spec.text.trim()) };
    let row = label_line(app, &spec.task_id, &line).ok_or_else(|| Refusal::new("HostUnavailable"))?;
    if spec.for_model { store.add_note(&spec.task_id, &caller.owner, &caller.name, &spec.text, super::runtime_notifications::now_millis()).map_err(Refusal::new)?; }
    Ok(json!({"id": row.to_string()}))
}

/// Refuses a typed command of a switched-off skill, with the error the user's own queue edit would get.
async fn skill_guard(app: &tauri::AppHandle, task: &str, text: &str) -> Result<(), Refusal> {
    use tauri::Manager;
    if crate::skill_manager::typed_command(text).is_none() { return Ok(()); }
    let target = {
        let state = app.state::<crate::AppState>();
        let store = state.store.lock().map_err(|_| Refusal::new("HostUnavailable"))?;
        let session = store.session(task).map_err(|_| Refusal::new("NotFound"))?;
        let cwd = match session.worktree_path { Some(path) => path, None => store.project(&session.project_id).map_err(|_| Refusal::new("NotFound"))?.path };
        (session.provider, std::path::PathBuf::from(cwd))
    };
    let (task, text) = (task.to_owned(), text.to_owned());
    crate::blocking(move || crate::skill_manager::check_session_prompt(&task, &target.0, &target.1, &text)).await.map_err(|error| Refusal::new(queue_code(&error)))
}

async fn queue(app: &tauri::AppHandle, caller: &Caller, params: &Value) -> Result<Value, Refusal> {
    use tauri::Manager;
    let spec = with_world(app, caller, |world| admit_queue(world, params))?;
    recheck(app, caller, &spec.project_id, &[PERMISSION])?;
    let state = app.state::<crate::AppState>();
    let task = spec.task_id.clone();
    let origin = |entry: &str| messages(app).and_then(|store| store.entry(entry));
    // The entry must be this task's: another task's id answers like an entry that is gone.
    let of_task = |store: &crate::storage::Store, entry: &str| -> Result<crate::message_queue::QueuedMessage, Refusal> {
        crate::message_queue::list(store, Some(&task)).map_err(|error| Refusal::new(queue_code(&error)))?.into_iter().find(|queued| queued.id == entry).ok_or_else(|| Refusal::new("NotFound"))
    };
    match spec.op.clone() {
        QueueOp::List => {
            let entries = crate::message_queue::list(&*state.store.lock().map_err(|_| Refusal::new("HostUnavailable"))?, Some(&task)).map_err(|error| Refusal::new(queue_code(&error)))?;
            Ok(queue_view(&entries, &origin))
        }
        QueueOp::Update { entry, text, revision: expected } => {
            skill_guard(app, &task, &text).await?;
            {
                // Read, compare and write in one critical section: a change between the read and the write cannot slip in.
                let store = state.store.lock().map_err(|_| Refusal::new("HostUnavailable"))?;
                let entries = crate::message_queue::list(&store, Some(&task)).map_err(|error| Refusal::new(queue_code(&error)))?;
                let current = entries.iter().find(|queued| queued.id == entry).ok_or_else(|| Refusal::new("NotFound"))?;
                if expected.is_some_and(|expected| expected != revision(&entries)) { return Err(Refusal::new("StaleContext")); }
                crate::message_queue::update(&store, &entry, &text, &current.attachments).map_err(|error| Refusal::new(queue_code(&error)))?;
            }
            if let Some(store) = messages(app) { store.changed_entry(&entry, &caller.name); }
            origins_changed(app);
            changed(app, &task);
            Ok(Value::Null)
        }
        QueueOp::Remove { entry } => {
            {
                let store = state.store.lock().map_err(|_| Refusal::new("HostUnavailable"))?;
                of_task(&store, &entry)?;
                crate::message_queue::remove_delivered(&store, &entry).map_err(|error| Refusal::new(queue_code(&error)))?;
            }
            if let Some(store) = messages(app) { store.forget_entry(&entry); }
            origins_changed(app);
            changed(app, &task);
            Ok(Value::Null)
        }
        QueueOp::Reorder { entries } => {
            crate::message_queue::reorder(&*state.store.lock().map_err(|_| Refusal::new("HostUnavailable"))?, &task, &entries).map_err(|error| Refusal::new(queue_code(&error)))?;
            changed(app, &task);
            Ok(Value::Null)
        }
        QueueOp::SendNow { entry } => send_now(app, caller, &spec, &entry).await,
        QueueOp::Resume => {
            use tauri::Emitter;
            // The hold is the window's state; a headless host has no hold and drains natively.
            let _ = app.emit("extensions-runtime-queue-resume", json!({"taskId": task, "owner": caller.owner}));
            crate::headless::queue_changed(app, &task);
            Ok(Value::Null)
        }
    }
}

/// `queue.sendNow`: an idle task takes the entry as its next turn; a running one takes it into the turn where the
/// harness steers. Stopping a run to send is `tasks.control`, so a harness that cannot steer is `UnsupportedCapability`
/// and the entry stays queued.
async fn send_now(app: &tauri::AppHandle, caller: &Caller, spec: &Queue, entry_id: &str) -> Result<Value, Refusal> {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    let _turn = send_lock(&spec.task_id).await;
    recheck(app, caller, &spec.project_id, &[PERMISSION])?;
    let entry = {
        let store = state.store.lock().map_err(|_| Refusal::new("HostUnavailable"))?;
        crate::message_queue::list(&store, Some(&spec.task_id)).map_err(|error| Refusal::new(queue_code(&error)))?.into_iter().find(|queued| queued.id == entry_id).ok_or_else(|| Refusal::new("NotFound"))?
    };
    let attachments = entry.attachments.as_array().cloned().unwrap_or_default();
    if busy(&state, &spec.task_id)? {
        if team(&state, &spec.task_id) { return Err(unsupported("delivery")); }
        if !attachments.is_empty() { return Err(unsupported("attachments")); }
        match crate::message_queue::steer_task(app.clone(), app.state::<crate::AppState>(), spec.task_id.clone(), entry.text.clone()).await {
            Ok(_) => {
                crate::message_queue::remove_delivered(&*state.store.lock().map_err(|_| Refusal::new("HostUnavailable"))?, entry_id).map_err(|error| Refusal::new(queue_code(&error)))?;
                label_line(app, &spec.task_id, &format!("Steered by {}", caller.name));
            }
            Err(error) => match steer_failure(&error) {
                SteerFailure::Refused(refusal) => return Err(refusal),
                // The run ended while we looked: the entry goes out as a turn, below.
                SteerFailure::Idle => return deliver_entry(app, caller, spec, &entry).await,
            },
        }
    } else {
        return deliver_entry(app, caller, spec, &entry).await;
    }
    if let Some(store) = messages(app) { store.forget_entry(entry_id); }
    origins_changed(app);
    changed(app, &spec.task_id);
    Ok(Value::Null)
}

/// Takes the entry out of the queue and sends it as a turn; a send that fails puts it back at the front.
async fn deliver_entry(app: &tauri::AppHandle, caller: &Caller, spec: &Queue, entry: &crate::message_queue::QueuedMessage) -> Result<Value, Refusal> {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    let mut ids = vec![];
    for attachment in entry.attachments.as_array().into_iter().flatten() {
        match (attachment["kind"].as_str(), attachment["id"].as_str()) { (Some("image"), Some(id)) => ids.push(id.to_owned()), _ => return Err(unsupported("attachments")) }
    }
    let taken = crate::message_queue::take(&*state.store.lock().map_err(|_| Refusal::new("HostUnavailable"))?, &entry.id).map_err(|_| Refusal::new("NotFound"))?;
    if let Err(refusal) = send_text(app, &spec.task_id, &taken.text, images(&ids)).await {
        if let Ok(store) = state.store.lock() { let _ = crate::message_queue::restore(&store, &taken); }
        changed(app, &spec.task_id);
        return Err(refusal);
    }
    label_line(app, &spec.task_id, &format!("Sent by {}", caller.name));
    if let Some(store) = messages(app) { store.forget_entry(&entry.id); }
    origins_changed(app);
    changed(app, &spec.task_id);
    Ok(Value::Null)
}

/// A deleted task loses its labels and waiting notes.
pub fn task_removed(app: &tauri::AppHandle, task: &str) { if messages(app).is_some_and(|store| store.forget_task(task)) { origins_changed(app); } }

/// The interface reads which package put each queued entry there (queue rows carry its name).
#[tauri::command]
pub fn extensions_runtime_message_origins(app: tauri::AppHandle) -> Value { messages(&app).map_or_else(|| json!({"revision": 0, "entries": {}}), |store| store.snapshot()) }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message_queue::QueuedMessage;
    const OWNER: &str = "sample.runtime-tasks-messages";

    fn entry(id: &str, position: i64, text: &str, updated: i64) -> QueuedMessage { QueuedMessage { id: id.into(), session_id: "t1".into(), position, text: text.into(), attachments: json!([]), created_at: 1, updated_at: updated } }

    /// Tasks `t1` and `t2` are in project A, `t3` in B. `grants` lists `(permission, project)` pairs held.
    fn admit_with<T>(grants: &[(&str, &str)], run: impl FnOnce(&World) -> Result<T, Refusal>) -> Result<T, Refusal> {
        let project_of = |task: &str| match task { "t1" | "t2" => Some("A".to_owned()), "t3" => Some("B".to_owned()), _ => None };
        let granted = |permission: &str, project: &str| grants.contains(&(permission, project));
        let holds_any = |permission: &str| grants.iter().any(|(held, _)| *held == permission);
        run(&World { project_of: &project_of, granted: &granted, holds_any: &holds_any })
    }
    const BOTH: [(&str, &str); 3] = [("tasks.message", "A"), ("tasks.message", "B"), ("harness.hooks.context", "A")];
    fn code<T>(result: Result<T, Refusal>) -> String { result.err().unwrap().code }

    #[test]
    fn a_granted_message_reads_text_attachments_and_delivery() {
        let message = admit_with(&BOTH, |world| admit_message(world, &json!({"taskId": "t1", "message": {"text": "also run the linter"}}))).unwrap();
        assert_eq!((message.project_id.as_str(), message.text.as_str(), message.delivery), ("A", "also run the linter", Delivery::Auto));
        let full = admit_with(&BOTH, |world| admit_message(world, &json!({"taskId": "t1", "message": {"text": "go", "attachments": ["img-1"], "delivery": "queue"}}))).unwrap();
        assert_eq!((full.attachments, full.delivery), (vec!["img-1".to_owned()], Delivery::Queue));
        let steer = admit_with(&BOTH, |world| admit_message(world, &json!({"taskId": "t1", "message": {"text": "go", "delivery": "steer"}}))).unwrap();
        assert_eq!(steer.delivery, Delivery::Steer);
        // Attachments alone are a message.
        assert!(admit_with(&BOTH, |world| admit_message(world, &json!({"taskId": "t1", "message": {"attachments": ["a"]}}))).is_ok());
    }

    #[test]
    fn the_grant_answers_first_and_an_unknown_task_never_leaks_to_a_package_without_it() {
        let none: [(&str, &str); 0] = [];
        for grants in [&none[..], &[("tasks.message", "B")][..]] {
            let refusal = admit_with(grants, |world| admit_message(world, &json!({"taskId": "t1", "message": {"text": "go"}}))).unwrap_err();
            assert_eq!((refusal.code.as_str(), refusal.path.as_str()), ("PermissionDenied", "tasks.message"));
        }
        // Without the permission anywhere an unknown task is still PermissionDenied; with it, NotFound.
        assert_eq!(code(admit_with(&none, |world| admit_message(world, &json!({"taskId": "ghost", "message": {"text": "go"}})))), "PermissionDenied");
        assert_eq!(code(admit_with(&BOTH, |world| admit_message(world, &json!({"taskId": "ghost", "message": {"text": "go"}})))), "NotFound");
        // The queue and the note answer the same way.
        assert_eq!(code(admit_with(&none, |world| admit_queue(world, &json!({"op": "list", "taskId": "t1"})))), "PermissionDenied");
        assert_eq!(code(admit_with(&none, |world| admit_note(world, &json!({"taskId": "t1", "note": {"text": "x"}})))), "PermissionDenied");
    }

    #[test]
    fn shapes_are_refused_with_their_reason() {
        for (raw, expected) in [
            (json!("text"), "InvalidShape"), (json!({"message": {"text": "x"}}), "InvalidShape"), (json!({"taskId": "t1"}), "InvalidShape"), (json!({"taskId": "t1", "message": "x"}), "InvalidShape"),
            (json!({"taskId": "t1", "message": {"text": "  "}}), "InvalidShape"), (json!({"taskId": "t1", "message": {"text": "x", "delivery": "teleport"}}), "InvalidShape"),
            (json!({"taskId": "t1", "message": {"text": "x", "mode": "plan"}}), "InvalidShape"), (json!({"taskId": "t1", "message": {"text": "x", "attachments": "a"}}), "InvalidShape"),
            (json!({"taskId": "t1", "message": {"text": "x".repeat(TEXT_BYTES + 1)}}), "LimitExceeded"), (json!({"taskId": "t1", "message": {"text": "x", "attachments": vec!["a"; MAX_ATTACHMENTS + 1]}}), "LimitExceeded"),
        ] { assert_eq!(code(admit_with(&BOTH, |world| admit_message(world, &raw))), expected, "{raw}"); }
    }

    #[test]
    fn a_note_for_the_model_also_needs_the_context_permission_named_in_the_refusal() {
        let plain = admit_with(&BOTH, |world| admit_note(world, &json!({"taskId": "t1", "note": {"text": "FYI"}}))).unwrap();
        assert!(!plain.for_model);
        assert!(admit_with(&BOTH, |world| admit_note(world, &json!({"taskId": "t1", "note": {"text": "FYI", "forModel": true}}))).unwrap().for_model);
        // Project B has no context grant: the plain note works, the forModel one names the missing permission.
        assert!(admit_with(&BOTH, |world| admit_note(world, &json!({"taskId": "t3", "note": {"text": "FYI"}}))).is_ok());
        let refusal = admit_with(&BOTH, |world| admit_note(world, &json!({"taskId": "t3", "note": {"text": "FYI", "forModel": true}}))).unwrap_err();
        assert_eq!((refusal.code.as_str(), refusal.path.as_str()), ("PermissionDenied", "harness.hooks.context"));
        for (raw, expected) in [(json!({"taskId": "t1", "note": {"text": " "}}), "InvalidShape"), (json!({"taskId": "t1", "note": {"text": "x", "forModel": "yes"}}), "InvalidShape"), (json!({"taskId": "t1", "note": {"text": "x".repeat(NOTE_BYTES + 1)}}), "LimitExceeded"), (json!({"taskId": "t1", "note": {"text": "x", "send": true}}), "InvalidShape")] {
            assert_eq!(code(admit_with(&BOTH, |world| admit_note(world, &raw))), expected, "{raw}");
        }
    }

    #[test]
    fn queue_operations_read_their_arguments_and_reject_malformed_orders() {
        let admit = |raw: Value| admit_with(&BOTH, |world| admit_queue(world, &raw));
        assert_eq!(admit(json!({"op": "list", "taskId": "t1"})).unwrap().op, QueueOp::List);
        assert_eq!(admit(json!({"op": "update", "taskId": "t1", "entryId": "e1", "change": {"text": "new", "revision": 7}})).unwrap().op, QueueOp::Update { entry: "e1".into(), text: "new".into(), revision: Some(7) });
        assert_eq!(admit(json!({"op": "reorder", "taskId": "t1", "entryIds": ["b", "a"]})).unwrap().op, QueueOp::Reorder { entries: vec!["b".into(), "a".into()] });
        assert_eq!(admit(json!({"op": "sendNow", "taskId": "t1", "entryId": "e1"})).unwrap().op, QueueOp::SendNow { entry: "e1".into() });
        for raw in [json!({"op": "explode", "taskId": "t1"}), json!({"op": "remove", "taskId": "t1"}), json!({"op": "update", "taskId": "t1", "entryId": "e1", "change": {"revision": 1}}), json!({"op": "update", "taskId": "t1", "entryId": "e1", "change": {"text": "x", "revision": -1}}), json!({"op": "reorder", "taskId": "t1", "entryIds": ["a", "a"]}), json!({"op": "reorder", "taskId": "t1"}), json!({"op": "list", "taskId": "t1", "extra": 1})] {
            assert_eq!(code(admit(raw.clone())), "InvalidShape", "{raw}");
        }
    }

    #[test]
    fn the_plan_sends_idle_queues_busy_steers_where_supported_and_never_hides_an_unsupported_steer() {
        assert_eq!(plan(false, Delivery::Auto, true, false), Ok(Plan::Send));
        assert_eq!(plan(false, Delivery::Steer, true, false), Ok(Plan::Send));
        assert_eq!(plan(false, Delivery::Queue, true, false), Ok(Plan::Queue));
        assert_eq!(plan(true, Delivery::Auto, true, true), Ok(Plan::Queue));
        assert_eq!(plan(true, Delivery::Queue, false, false), Ok(Plan::Queue));
        assert_eq!(plan(true, Delivery::Steer, true, false), Ok(Plan::Steer));
        assert_eq!(plan(true, Delivery::Steer, false, false).unwrap_err().code, "UnsupportedCapability");
        let attached = plan(true, Delivery::Steer, true, true).unwrap_err();
        assert_eq!((attached.code.as_str(), attached.path.as_str()), ("UnsupportedCapability", "attachments"));
    }

    #[test]
    fn steer_and_queue_failures_map_to_frozen_codes_without_their_text() {
        assert_eq!(steer_failure("The agent is not running; the message stays queued."), SteerFailure::Idle);
        assert!(matches!(steer_failure("This agent cannot be steered; the message stays queued."), SteerFailure::Refused(refusal) if refusal.code == "UnsupportedCapability"));
        assert!(matches!(steer_failure("Too many steering messages are waiting; the message stays queued."), SteerFailure::Refused(refusal) if refusal.code == "HostUnavailable"));
        for (text, expected) in [("The queue changed. Try reordering again.", "StaleContext"), ("This queued message was already sent or removed.", "NotFound"), ("A task can queue up to 50 messages.", "LimitExceeded"), ("Write a message or add an attachment to queue.", "InvalidShape"), ("disk on fire", "HostUnavailable")] { assert_eq!(queue_code(text), expected, "{text}"); }
    }

    #[test]
    fn the_revision_moves_with_every_change_to_the_queue_and_with_nothing_else() {
        let base = vec![entry("a", 0, "first", 1), entry("b", 1, "second", 1)];
        assert_eq!(revision(&base), revision(&base.clone()));
        assert!(revision(&base) < (1u64 << 53));
        let edited = vec![entry("a", 0, "first!", 2), entry("b", 1, "second", 1)];
        let reordered = vec![entry("b", 0, "second", 1), entry("a", 1, "first", 1)];
        let removed = vec![entry("a", 0, "first", 1)];
        let mut distinct = vec![revision(&base), revision(&edited), revision(&reordered), revision(&removed), revision(&[])];
        distinct.sort();
        distinct.dedup();
        assert_eq!(distinct.len(), 5);
        let mut attached = base.clone();
        attached[0].attachments = json!([{"kind": "image", "id": "x"}]);
        assert_ne!(revision(&attached), revision(&base));
    }

    #[test]
    fn the_queue_view_names_the_package_that_queued_an_entry_and_cuts_a_long_text() {
        let entries = vec![entry("a", 0, "first", 1), entry("b", 1, &"x".repeat(VIEW_CHARS + 5), 1)];
        let origin = |id: &str| if id == "a" { Some(EntryOrigin { task_id: "t1".into(), owner: OWNER.into(), package: "Messenger".into(), at: 1, changed_by: Some("Other".into()) }) } else { None };
        let view = queue_view(&entries, &origin);
        assert_eq!(view["revision"], json!(revision(&entries)));
        assert_eq!((view["entries"][0]["package"].as_str(), view["entries"][0]["changedBy"].as_str(), view["entries"][1]["package"].as_str()), (Some("Messenger"), Some("Other"), None));
        assert_eq!((view["entries"][1]["truncated"].as_bool(), view["entries"][1]["text"].as_str().map(|text| text.chars().count())), (Some(true), Some(VIEW_CHARS)));
    }

    #[test]
    fn notes_for_the_model_are_taken_once_labelled_and_given_back_when_the_message_never_saved() {
        let store = TaskMessages::default();
        let first = store.add_note("t1", OWNER, "Messenger", "The linter is flaky on CI.", 1).unwrap();
        store.add_note("t1", OWNER, "Messenger", "Line one\nline two", 2).unwrap();
        store.add_note("t2", OWNER, "Messenger", "other task", 3).unwrap();
        assert_eq!((first.as_str(), store.pending_notes("t1"), store.pending_notes("t2")), ("note-1", 2, 1));
        let taken = store.take_notes("t1");
        assert_eq!(render_context(&taken), "Notes added by extensions for this message (not written by the user):\n- [Messenger] The linter is flaky on CI.\n- [Messenger] Line one\n  line two");
        // A second sender gets nothing: exactly one message carries a note.
        assert!(store.take_notes("t1").is_empty());
        store.add_note("t1", OWNER, "Messenger", "newer", 4).unwrap();
        store.restore_notes("t1", taken);
        assert_eq!(store.take_notes("t1").iter().map(|note| note.text.as_str()).collect::<Vec<_>>(), ["The linter is flaky on CI.", "Line one\nline two", "newer"]);
        for index in 0..MAX_NOTES_PER_TASK { store.add_note("t9", OWNER, "Messenger", &format!("n{index}"), index as u64).unwrap(); }
        assert_eq!(store.add_note("t9", OWNER, "Messenger", "one too many", 0), Err("LimitExceeded"));
        assert!(carries_context("plain text") && !carries_context("  /compact"));
    }

    #[test]
    fn attribution_and_notes_survive_a_restart_keep_the_creator_and_follow_the_task() {
        let directory = std::env::temp_dir().join(format!("panda-task-messages-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let origin = |at: u64| EntryOrigin { task_id: "t1".into(), owner: OWNER.into(), package: "Messenger".into(), at, changed_by: None };
        let store = TaskMessages::open(&directory);
        store.record_entry("e1", origin(1));
        store.record_entry("e1", EntryOrigin { package: "Other".into(), ..origin(2) });
        store.record_entry("e2", EntryOrigin { task_id: "t2".into(), ..origin(3) });
        store.changed_entry("e1", "Editor");
        store.changed_entry("e1", "Messenger");
        store.add_note("t1", OWNER, "Messenger", "kept across a restart", 5).unwrap();
        assert_eq!((store.entry("e1").unwrap().package.as_str(), store.entry("e1").unwrap().changed_by.as_deref()), ("Messenger", Some("Editor")));
        let reopened = TaskMessages::open(&directory);
        assert_eq!(reopened.snapshot()["entries"]["e2"]["package"], json!("Messenger"));
        assert_eq!((reopened.pending_notes("t1"), reopened.entry("e1").unwrap().changed_by.as_deref()), (1, Some("Editor")));
        assert!(reopened.forget_entry("e2") && !reopened.forget_entry("e2"));
        // A deleted task loses its labels and its notes.
        assert!(reopened.forget_task("t1"));
        let after = TaskMessages::open(&directory);
        assert_eq!((after.entry("e1").is_none(), after.pending_notes("t1")), (true, 0));
        let many = TaskMessages::default();
        for index in 0..MAX_LEDGER + 5 { many.record_entry(&format!("e{index}"), origin(index as u64)); }
        assert_eq!((many.entry("e0").is_none(), many.entry(&format!("e{}", MAX_LEDGER + 4)).is_some()), (true, true));
        let _ = std::fs::remove_dir_all(&directory);
    }
}
