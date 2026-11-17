//! Pending approvals and questions as durable events (runtime phase R5, slice R0507).
//!
//! A hook handler that needs more than its budget does not hold the call: it returns nothing (or `ask`), the normal
//! prompt appears, and the request becomes an event. This module keeps every request a run puts in front of the user
//! (a permission prompt, a question) under one stable identity and delivers four observe-only hook events:
//!
//! * `approval.pending` (`PendingApproval`) and `question.pending` (`PendingQuestion`) when the prompt appears;
//! * `approval.resolved` (`{ requestId, callId?, taskId, approved, reason?, by }`) and `question.resolved`
//!   (`{ requestId, taskId, by, answers? }`) when it ends, **in every case**: answered by the user (`user`), answered
//!   through a package (`{ package }`, R0508 attributes it), withdrawn by the harness after the task's mode changed
//!   (`mode`), or cancelled, timed out, its run ended or its task removed (`cancelled`).
//!
//! **Identity.** A request is keyed by its task and the id the app shows it under (`<run>:<harness id>`, the id the
//! window, the bots, the remote route and `respond_approval` use), so harness ids that repeat across runs never meet.
//! A duplicate or resumed frame of an open request (the same id again, a mirror's snapshot after a lost frame) opens
//! nothing; a request that already ended is remembered (bounded) and never opens again, so a late frame cannot replay a
//! resolved question. The fields are frozen when the request opens; nothing in a later event changes them.
//!
//! **No time limit.** Nothing here expires: a request stays pending until the harness, the user, a package, the run's
//! end or the task's removal closes it, however long ago the hook budget that put it there ran out.
//!
//! **Recovery.** Deliveries are one-way and can be lost (a service restarting, its 256-event queue overflowing). The
//! service request `hooksPending` (`panda.hooks.pending()`) answers the current open set, filtered exactly like a live
//! delivery (an attached hook of that family, its `match`, and `harness.hooks.observe` for the request's project,
//! checked now), so a service rebuilds its list after a gap without ever seeing a resolved request again.
//!
//! Everything here is for predictability and fault isolation (ADR-0005). A secret question's answer is left out of
//! `question.resolved` (ADR-0006: a value the user typed as secret for the harness is never handed to a package).
use serde_json::{json, Map, Value};
use std::{collections::{BTreeMap, BTreeSet}, sync::{LazyLock, Mutex, MutexGuard}};

use crate::extensions::runtime_hook_registration::{self as hooks, HookRegistry, Occurrence, Published, Target};

/// The four events this slice delivers (observe only: nothing waits for them).
pub const EVENTS: [&str; 4] = ["approval.pending", "approval.resolved", "question.pending", "question.resolved"];
/// `schemaVersion` of a `hooks.pending` answer.
pub const SCHEMA_VERSION: u64 = 1;
/// Open requests one task keeps; beyond it the oldest is dropped (and never reopens).
pub const OPEN_PER_TASK: usize = 64;
const OPEN_TOTAL: usize = 4_096;
/// Ended identities remembered, so a late or resumed frame of one never opens it again.
const CLOSED_PER_TASK: usize = 256;
const CLOSED_TOTAL: usize = 8_192;
/// Longest `text` (and question text) a payload carries, in UTF-8 bytes.
pub const TEXT_BYTES: usize = 64 << 10;
/// Longest serialized `input` a pending approval carries (the structured input of `runtime_hook_payload`).
pub const INPUT_BYTES: usize = 1 << 20;
/// Budget of a `hooks.pending` answer: the 2 MiB hook frame less room for its envelope.
pub const SNAPSHOT_BYTES: usize = (2 << 20) - (64 << 10);
/// Questions one request carries at most.
const QUESTIONS: usize = 64;
/// Attributions waiting for their request (a package's `ask`, R0505).
const ASKED_LIMIT: usize = 1_024;

/// The two families of requests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind { Approval, Question }
impl Kind {
    pub fn pending(self) -> &'static str { match self { Kind::Approval => "approval.pending", Kind::Question => "question.pending" } }
    pub fn resolved(self) -> &'static str { match self { Kind::Approval => "approval.resolved", Kind::Question => "question.resolved" } }
    /// The app's agent event kinds: whether one opens or withdraws a request of which family.
    pub fn of_event(kind: &str) -> Option<(Kind, bool)> {
        match kind {
            "approval" => Some((Kind::Approval, true)),
            "approval_cancelled" => Some((Kind::Approval, false)),
            "input_request" => Some((Kind::Question, true)),
            "input_cancelled" => Some((Kind::Question, false)),
            _ => None,
        }
    }
}

/// `by` of a resolved event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum By { User, Mode, Cancelled, Package(String) }
impl By {
    pub fn json(&self) -> Value {
        match self { By::User => json!("user"), By::Mode => json!("mode"), By::Cancelled => json!("cancelled"), By::Package(package) => json!({"package": package}) }
    }
}

/// What a request's run is, frozen when the request opens: the delivery filter (project grant, `match.harnesses`,
/// `match.runs`) and the payload's facts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Facts { pub project: String, pub harness: String, pub mode: String, pub run: String }

/// A request as the app's event sink reports it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Request {
    pub task: String,
    /// The id the app shows it under (`<run>:<harness id>`).
    pub request: String,
    pub text: String,
    pub data: Value,
    /// The host call id of the call an approval asks about (`runtime_hook_payload`), when known.
    pub call: Option<String>,
    /// Its complete input, when it is known and travels structured (at most 1 MiB).
    pub input: Option<Value>,
    /// The run was launched ask-at-host (R0505): a prompt that still appears is one the mode always shows.
    pub ask_at_host: bool,
    /// RFC 3339, when the prompt appeared.
    pub at: String,
}

/// How a request ended.
#[derive(Clone, Debug, PartialEq)]
pub enum Ending {
    /// Answered: `approved` for an approval, the validated `response` for a question.
    Answered { approved: Option<bool>, response: Option<Value> },
    /// The harness withdrew it (`approval_cancelled` / `input_cancelled`); `current_mode` is the task's mode now: an
    /// approval withdrawn after the mode changed was resolved by the mode.
    Withdrawn { current_mode: Option<String> },
    /// Its run ended or its task was removed.
    Gone,
}

/// One event to deliver.
#[derive(Clone, Debug, PartialEq)]
pub struct Change { pub event: &'static str, pub facts: Facts, pub payload: Value }
impl Change {
    /// The registry occurrence: filtered by the run's project, harness and run kind like every hook event.
    pub fn occurrence(&self) -> Occurrence {
        Occurrence { event: self.event, project: self.facts.project.clone(), harness: self.facts.harness.clone(), run: self.facts.run.clone(), tool_kind: None, paths: vec![], payload: self.payload.clone() }
    }
    pub fn json(&self) -> Value { json!({"event": self.event, "payload": self.payload}) }
}

// ---------------------------------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------------------------------

/// `text` cut back to at most `limit` UTF-8 bytes on a code point boundary.
pub fn bounded(text: &str, limit: usize) -> &str {
    if text.len() <= limit { return text; }
    let mut end = limit;
    while !text.is_char_boundary(end) { end -= 1; }
    &text[..end]
}
/// The harness's own id of an app request id (`<run>:<id>`).
pub fn local_id(request: &str) -> &str { request.split_once(':').map_or(request, |(_, local)| local) }
/// The tool a request asks about: the event's data names it, else the prompt's `Allow <tool>?` line (as R0505 reads it).
pub fn tool_name(text: &str, data: &Value) -> String {
    if let Some(name) = ["name", "tool_name", "title"].iter().find_map(|key| data[*key].as_str()).filter(|name| !name.is_empty()) { return name.to_owned(); }
    text.lines().next().and_then(|line| line.strip_prefix("Allow ")).and_then(|rest| rest.split('?').next()).map(str::trim).filter(|name| !name.is_empty() && name.len() <= 128).unwrap_or("tool").to_owned()
}
fn non_empty(value: &Value) -> Option<&str> { value.as_str().filter(|text| !text.is_empty()) }

/// `PendingApproval`: `{ requestId, callId?, taskId, projectId, harness, mode, tool: { kind, name }, text, input?,
/// askedBy, at }`. `asked` is the package whose `ask` (or failing `ask` policy) put the prompt there.
pub fn pending_approval(request: &Request, facts: &Facts, asked: Option<&str>) -> Value {
    let name = tool_name(&request.text, &request.data);
    let mut kind = hooks::tool_kind(&name);
    if kind == "other" { if let Some(input) = &request.input { kind = hooks::kind_of_input(input); } }
    let asked_by = match asked { Some(package) => json!({"package": package}), None if request.ask_at_host => json!("mode"), None => json!("harness") };
    let mut payload = json!({
        "requestId": request.request, "taskId": request.task, "projectId": facts.project, "harness": facts.harness, "mode": facts.mode,
        "tool": {"kind": kind, "name": name}, "text": bounded(&request.text, TEXT_BYTES), "askedBy": asked_by, "at": request.at,
    });
    if let Some(call) = &request.call { payload["callId"] = json!(call); }
    if let Some(input) = request.input.as_ref().filter(|input| serde_json::to_vec(input).map_or(usize::MAX, |bytes| bytes.len()) <= INPUT_BYTES) { payload["input"] = input.clone(); }
    payload
}

/// `PendingQuestion.questions` from core's normalized `input_request` data, with the ids of secret questions and
/// whether the answers are core's `{ answers: { [id]: { answers } } }` (`kind: "questions"`):
///
/// * `questions`: each question as asked (`header` and option `description` only when not empty, `multiple: false`,
///   `secret` from `isSecret`);
/// * `form`: one question per schema property, by name (`question` is its title, else its description, else its
///   name; `header` the form's message; `options` its `enum`; `multiple` for an array; `secret` for `format:
///   "password"`);
/// * `url`: one question `url` holding the message and the address;
/// * anything else: one question `q0` holding the prompt's text.
pub fn questions_of(text: &str, data: &Value) -> (Vec<Value>, BTreeSet<String>, bool) {
    let mut secret = BTreeSet::new();
    let question = |id: &str, header: Option<&str>, text: &str, options: Option<Vec<Value>>, multiple: bool, hidden: bool| {
        let mut out = json!({"id": id, "question": bounded(text, TEXT_BYTES), "multiple": multiple, "secret": hidden});
        if let Some(header) = header { out["header"] = json!(bounded(header, TEXT_BYTES)); }
        if let Some(options) = options { out["options"] = Value::Array(options); }
        out
    };
    match data["kind"].as_str() {
        Some("questions") => {
            let mut out = Vec::new();
            for asked in data["questions"].as_array().into_iter().flatten().take(QUESTIONS) {
                let Some(id) = asked["id"].as_str() else { continue };
                let hidden = asked["isSecret"] == true;
                if hidden { secret.insert(id.to_owned()); }
                let options = asked["options"].as_array().map(|options| options.iter().filter_map(|option| {
                    let label = option["label"].as_str()?;
                    let mut entry = json!({"label": label});
                    if let Some(description) = non_empty(&option["description"]) { entry["description"] = json!(description); }
                    Some(entry)
                }).collect());
                out.push(question(id, non_empty(&asked["header"]), asked["question"].as_str().unwrap_or_default(), options, false, hidden));
            }
            (out, secret, true)
        }
        Some("form") => {
            let header = non_empty(&data["message"]);
            let mut out = Vec::new();
            // A JSON object's fields by name, the same order on both sides.
            if let Some(properties) = data["schema"]["properties"].as_object() {
                let names: BTreeSet<&String> = properties.keys().collect();
                for name in names.into_iter().take(QUESTIONS) {
                    let property = &properties[name];
                    let hidden = property["format"] == "password";
                    if hidden { secret.insert(name.clone()); }
                    let asked = non_empty(&property["title"]).or_else(|| non_empty(&property["description"])).unwrap_or(name);
                    let options = property["enum"].as_array().map(|values| values.iter().filter_map(Value::as_str).map(|label| json!({"label": label})).collect());
                    out.push(question(name, header, asked, options, property["type"] == "array", hidden));
                }
            }
            (out, secret, false)
        }
        Some("url") => {
            let asked = [non_empty(&data["message"]), non_empty(&data["url"])].into_iter().flatten().collect::<Vec<_>>().join("\n");
            (vec![question("url", None, &asked, None, false, false)], secret, false)
        }
        _ => {
            let asked = if text.trim().is_empty() { "The agent asks a question." } else { text };
            (vec![question("q0", None, asked, None, false, false)], secret, false)
        }
    }
}

/// `PendingQuestion`: `{ requestId, taskId, projectId, harness, questions, at }`.
pub fn pending_question(request: &Request, facts: &Facts) -> (Value, BTreeSet<String>, bool) {
    let (questions, secret, structured) = questions_of(&request.text, &request.data);
    (json!({"requestId": request.request, "taskId": request.task, "projectId": facts.project, "harness": facts.harness, "questions": questions, "at": request.at}), secret, structured)
}

// ---------------------------------------------------------------------------------------------------------------
// The book
// ---------------------------------------------------------------------------------------------------------------

struct Entry {
    kind: Kind,
    facts: Facts,
    /// The frozen pending payload.
    payload: Value,
    /// Ids of secret questions (their answers never travel).
    secret: BTreeSet<String>,
    /// The answers are core's `{ answers: { [id]: ... } }`.
    structured: bool,
    /// The package an answer about to be sent comes from, with its reason (R0508).
    attributed: Option<(String, Option<String>)>,
    order: u64,
}

#[derive(Default)]
struct Inner {
    open: BTreeMap<(String, String), Entry>,
    /// Ended identities → when they ended.
    closed: BTreeMap<(String, String), u64>,
    /// `(task, harness id)` → the package whose `ask` will put the next prompt for it there (R0505).
    asked: BTreeMap<(String, String), String>,
    serial: u64,
    revision: u64,
}
impl Inner {
    fn next(&mut self) -> u64 { self.serial += 1; self.serial }
    fn tombstone(&mut self, key: (String, String)) {
        let order = self.next();
        let task = key.0.clone();
        self.closed.insert(key, order);
        while self.closed.keys().filter(|(owner, _)| *owner == task).count() > CLOSED_PER_TASK {
            let Some(oldest) = self.closed.iter().filter(|((owner, _), _)| *owner == task).min_by_key(|(_, order)| **order).map(|(key, _)| key.clone()) else { break };
            self.closed.remove(&oldest);
        }
        while self.closed.len() > CLOSED_TOTAL {
            let Some(oldest) = self.closed.iter().min_by_key(|(_, order)| **order).map(|(key, _)| key.clone()) else { break };
            self.closed.remove(&oldest);
        }
    }
    /// Keeps one task, then all tasks, within their bounds: the oldest open request goes (silently: it is not
    /// resolved, it is no longer tracked) and never opens again.
    fn bound(&mut self, task: &str) {
        loop {
            let owned = self.open.keys().filter(|(owner, _)| owner == task).count();
            if owned <= OPEN_PER_TASK && self.open.len() <= OPEN_TOTAL { break; }
            let scoped = owned > OPEN_PER_TASK;
            let Some(oldest) = self.open.iter().filter(|((owner, _), _)| !scoped || owner == task).min_by_key(|(_, entry)| entry.order).map(|(key, _)| key.clone()) else { break };
            self.open.remove(&oldest);
            self.tombstone(oldest);
            self.revision += 1;
        }
    }
}

/// Every open request of the app (one [`book`]); tests build their own.
#[derive(Default)]
pub struct PendingBook { inner: Mutex<Inner> }

impl PendingBook {
    fn lock(&self) -> MutexGuard<'_, Inner> { self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) }

    /// A package's `ask` decision (or failing `ask` policy) is about to put the prompt of `request` (the harness's own
    /// id or the app's) of `task` in front of the user (R0505): its `approval.pending` says `askedBy: { package }`.
    pub fn asked_by(&self, task: &str, request: &str, package: &str) {
        let mut inner = self.lock();
        if inner.asked.len() >= ASKED_LIMIT { inner.asked.clear(); }
        inner.asked.insert((task.to_owned(), local_id(request).to_owned()), package.to_owned());
    }

    /// Whether a request is open.
    pub fn is_open(&self, task: &str, request: &str) -> bool { self.lock().open.contains_key(&(task.to_owned(), request.to_owned())) }

    /// A prompt appeared. Answers its `*.pending` event the first time; a duplicate or resumed frame of an open
    /// request, or a frame of one that already ended, answers nothing.
    pub fn open(&self, kind: Kind, request: &Request, facts: Facts) -> Option<Change> {
        let key = (request.task.clone(), request.request.clone());
        let mut inner = self.lock();
        if inner.open.contains_key(&key) || inner.closed.contains_key(&key) { return None; }
        let asked = inner.asked.remove(&(request.task.clone(), local_id(&request.request).to_owned()));
        let (payload, secret, structured) = match kind {
            Kind::Approval => (pending_approval(request, &facts, asked.as_deref()), BTreeSet::new(), false),
            Kind::Question => pending_question(request, &facts),
        };
        let order = inner.next();
        inner.revision += 1;
        inner.open.insert(key, Entry { kind, facts: facts.clone(), payload: payload.clone(), secret, structured, attributed: None, order });
        inner.bound(&request.task);
        Some(Change { event: kind.pending(), facts, payload })
    }

    /// The answer about to be sent for an open request comes from `package` (R0508, `panda.tasks.respond`): its
    /// resolved event says `by: { package }` and carries `reason`. `StaleContext` when the request is not open.
    pub fn attribute(&self, task: &str, request: &str, package: &str, reason: Option<&str>) -> Result<(), &'static str> {
        let mut inner = self.lock();
        let entry = inner.open.get_mut(&(task.to_owned(), request.to_owned())).ok_or("StaleContext")?;
        entry.attributed = Some((package.to_owned(), reason.map(str::to_owned)));
        Ok(())
    }
    /// An attribution whose answer was not sent is withdrawn.
    pub fn unattribute(&self, task: &str, request: &str) {
        if let Some(entry) = self.lock().open.get_mut(&(task.to_owned(), request.to_owned())) { entry.attributed = None; }
    }

    /// The request ended. Answers its `*.resolved` event once; nothing for a request that is not open (never opened
    /// here, already ended, or dropped by the bound).
    pub fn end(&self, task: &str, request: &str, ending: Ending) -> Option<Change> {
        let key = (task.to_owned(), request.to_owned());
        let mut inner = self.lock();
        let entry = inner.open.remove(&key)?;
        inner.tombstone(key);
        inner.revision += 1;
        drop(inner);
        Some(resolved(request, task, entry, ending))
    }

    /// A run ended (`run`: its id, the prefix of its requests' ids; `None`: every run of the task, as for a mirrored
    /// task or a removed one): each of its open requests ends `cancelled`, in the order they opened.
    pub fn end_run(&self, task: &str, run: Option<&str>) -> Vec<Change> {
        let prefix = run.map(|run| format!("{run}:"));
        let ids: Vec<String> = {
            let inner = self.lock();
            let mut ids: Vec<(u64, String)> = inner.open.iter().filter(|((owner, id), _)| owner == task && prefix.as_ref().is_none_or(|prefix| id.starts_with(prefix.as_str()))).map(|((_, id), entry)| (entry.order, id.clone())).collect();
            ids.sort();
            ids.into_iter().map(|(_, id)| id).collect()
        };
        ids.iter().filter_map(|id| self.end(task, id, Ending::Gone)).collect()
    }

    /// The task was removed: its open requests end `cancelled`, then nothing of it is kept.
    pub fn forget_task(&self, task: &str) -> Vec<Change> {
        let changes = self.end_run(task, None);
        let mut inner = self.lock();
        inner.closed.retain(|(owner, _), _| owner != task);
        inner.asked.retain(|(owner, _), _| owner != task);
        changes
    }

    /// `(approvals, questions)` open in `task` (`task.idle.pending`).
    pub fn counts(&self, task: &str) -> (u64, u64) {
        let inner = self.lock();
        let of = |kind: Kind| inner.open.iter().filter(|((owner, _), entry)| owner == task && entry.kind == kind).count() as u64;
        (of(Kind::Approval), of(Kind::Question))
    }
    /// Changes of the open set so far (opened, ended, dropped).
    pub fn revision(&self) -> u64 { self.lock().revision }

    /// The current open set as `hooks.pending` answers it: `{ schemaVersion, revision, approvals, questions,
    /// truncated }`, in the order the requests opened, only those `include` accepts. Over the frame budget, an
    /// approval's `input` is left out first (read it with `hooks.input` while the call is live), then whole requests
    /// (`truncated: true`).
    pub fn snapshot(&self, include: impl Fn(Kind, &Facts) -> bool) -> Value {
        let (revision, mut entries) = {
            let inner = self.lock();
            let entries: Vec<(u64, Kind, Facts, Value)> = inner.open.values().map(|entry| (entry.order, entry.kind, entry.facts.clone(), entry.payload.clone())).collect();
            (inner.revision, entries)
        };
        entries.sort_by_key(|(order, ..)| *order);
        let (mut approvals, mut questions, mut size, mut truncated) = (Vec::new(), Vec::new(), 0usize, false);
        let measure = |value: &Value| serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len() + 1);
        for (_, kind, facts, mut item) in entries {
            if !include(kind, &facts) { continue; }
            let mut bytes = measure(&item);
            if size.saturating_add(bytes) > SNAPSHOT_BYTES {
                if let Some(object) = item.as_object_mut() { if object.remove("input").is_some() { bytes = measure(&item); } }
            }
            if size.saturating_add(bytes) > SNAPSHOT_BYTES { truncated = true; continue; }
            size += bytes;
            match kind { Kind::Approval => approvals.push(item), Kind::Question => questions.push(item) }
        }
        json!({"schemaVersion": SCHEMA_VERSION, "revision": revision, "approvals": approvals, "questions": questions, "truncated": truncated})
    }
}

/// The resolved event of an entry that ended.
fn resolved(request: &str, task: &str, entry: Entry, ending: Ending) -> Change {
    let attributed = entry.attributed.clone();
    let answered_by = || attributed.as_ref().map_or(By::User, |(package, _)| By::Package(package.clone()));
    let payload = match entry.kind {
        Kind::Approval => {
            let (approved, by, reason) = match &ending {
                Ending::Answered { approved, .. } => (approved.unwrap_or(false), answered_by(), attributed.as_ref().and_then(|(_, reason)| reason.clone())),
                Ending::Withdrawn { current_mode } => (false, if current_mode.as_ref().is_some_and(|mode| *mode != entry.facts.mode) { By::Mode } else { By::Cancelled }, None),
                Ending::Gone => (false, By::Cancelled, None),
            };
            let mut payload = json!({"requestId": request, "taskId": task, "approved": approved, "by": by.json()});
            if let Some(call) = entry.payload["callId"].as_str() { payload["callId"] = json!(call); }
            if let Some(reason) = reason { payload["reason"] = json!(reason); }
            payload
        }
        Kind::Question => {
            let (by, response) = match &ending { Ending::Answered { response, .. } => (answered_by(), response.as_ref()), _ => (By::Cancelled, None) };
            let mut payload = json!({"requestId": request, "taskId": task, "by": by.json()});
            if let Some(answers) = response.filter(|_| entry.structured).and_then(|response| response["answers"].as_object()) {
                let kept: Map<String, Value> = answers.iter().filter(|(id, _)| !entry.secret.contains(*id)).map(|(id, answer)| (id.clone(), answer.clone())).collect();
                payload["answers"] = Value::Object(kept);
            }
            payload
        }
    };
    Change { event: entry.kind.resolved(), facts: entry.facts, payload }
}

/// Hands changes to the registry, one way, filtered like every hook event. Free when no hook is attached.
pub fn deliver(registry: &HookRegistry, changes: impl IntoIterator<Item = Change>) -> Published {
    let mut out = Published::default();
    if !registry.active() { return out; }
    for change in changes { out += registry.publish(&change.occurrence()); }
    out
}

/// `hooks.pending` of `owner`: approvals when it has attached `approval.pending` or `approval.resolved`, questions
/// when it has attached `question.pending` or `question.resolved` (`UnknownReference` with neither), each request
/// only where that hook's `match` accepts its run and the package holds `harness.hooks.observe` for its project,
/// checked now.
pub fn snapshot_for(registry: &HookRegistry, book: &PendingBook, owner: &str) -> Result<Value, &'static str> {
    let of = |events: [&str; 2]| -> Vec<Target> { events.iter().flat_map(|event| registry.attached(event)).filter(|target| target.owner == owner).collect() };
    let approvals = of(["approval.pending", "approval.resolved"]);
    let questions = of(["question.pending", "question.resolved"]);
    if approvals.is_empty() && questions.is_empty() { return Err("UnknownReference"); }
    let reaches = |targets: &[Target], facts: &Facts| targets.iter().any(|target| {
        let probe = Occurrence { event: "approval.pending", project: facts.project.clone(), harness: facts.harness.clone(), run: facts.run.clone(), tool_kind: None, paths: vec![], payload: Value::Null };
        hooks::matches(&target.declaration.matcher, &probe) && registry.holds(owner, &target.version, hooks::OBSERVE, Some(&facts.project))
    });
    Ok(book.snapshot(|kind, facts| match kind { Kind::Approval => reaches(&approvals, facts), Kind::Question => reaches(&questions, facts) }))
}

// ---------------------------------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------------------------------

static BOOK: LazyLock<PendingBook> = LazyLock::new(PendingBook::default);
/// The app's book.
pub fn book() -> &'static PendingBook { &BOOK }

fn now() -> String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) }

/// The facts of a task's run: the hook registry's when a hook observes the run (its run kind), the store's otherwise;
/// the mode is always the task's current one.
fn facts_of(app: &tauri::AppHandle, task: &str, remote: bool) -> Option<Facts> {
    use tauri::Manager;
    let run = hooks::registry().run(task);
    let session = app.try_state::<crate::AppState>().and_then(|state| state.store.lock().ok().and_then(|store| store.session(task).ok()));
    match (run, session) {
        (Some(run), session) => Some(Facts { project: run.project_id, harness: run.harness, mode: session.map_or(run.mode, |session| session.mode), run: run.run["kind"].as_str().unwrap_or("task").to_owned() }),
        (None, Some(session)) => Some(Facts { run: if remote || session.remote_device.is_some() { "remote" } else { "task" }.to_owned(), project: session.project_id, harness: session.provider, mode: session.mode }),
        (None, None) => None,
    }
}
fn current_mode(app: &tauri::AppHandle, task: &str) -> Option<String> {
    use tauri::Manager;
    app.try_state::<crate::AppState>().and_then(|state| state.store.lock().ok().and_then(|store| store.session(task).ok().map(|session| session.mode)))
}
/// The host call and complete input of the call an approval asks about, as the adapter recorded them (only while a
/// hook observes: reading the payload fixes the call's serialization, which is what a hook was shown).
fn call_of(task: &str, request: &str) -> (Option<String>, Option<Value>) {
    use crate::extensions::runtime_hook_payload as payloads;
    let call = payloads::request_call(task, local_id(request)).or_else(|| payloads::request_call(task, request));
    if !hooks::registry().active() { return (call, None); }
    let input = call.as_deref().and_then(|call| payloads::payload(call).ok()).filter(|fields| fields.get("inputComplete") == Some(&json!(true))).and_then(|fields| fields.get("input").cloned());
    (call, input)
}

/// One request event of a task, from the app's sink or a mirror.
fn seen(app: &tauri::AppHandle, task: &str, kind: &str, request: &str, text: &str, data: &Value, mirror: Option<(Option<String>, Option<Value>)>) {
    let Some((family, opens)) = Kind::of_event(kind) else { return };
    if request.is_empty() || request.len() > 512 || task.is_empty() { return; }
    if opens {
        // A frame of a request already open or already ended opens nothing: no store read for it.
        let key_known = { let inner = BOOK.lock(); let key = (task.to_owned(), request.to_owned()); inner.open.contains_key(&key) || inner.closed.contains_key(&key) };
        if key_known { return; }
        let Some(facts) = facts_of(app, task, mirror.is_some()) else { return };
        let (call, input) = match (family, mirror) { (Kind::Question, _) => (None, None), (Kind::Approval, Some(found)) => found, (Kind::Approval, None) => call_of(task, request) };
        let request = Request {
            task: task.to_owned(), request: request.to_owned(), text: text.to_owned(), data: data.clone(), call, input,
            ask_at_host: crate::extensions::runtime_hook_decisions::asking(task), at: now(),
        };
        if let Some(change) = BOOK.open(family, &request, facts) { deliver(hooks::registry(), [change]); }
    } else {
        if !BOOK.is_open(task, request) { return; }
        let current = if family == Kind::Approval { current_mode(app, task) } else { None };
        if let Some(change) = BOOK.end(task, request, Ending::Withdrawn { current_mode: current }) { deliver(hooks::registry(), [change]); }
    }
}

/// The agent event sink (`emit_coalesced`): `approval` / `input_request` open a request under the id the app shows it
/// with; `approval_cancelled` / `input_cancelled` close it (withdrawn by the harness).
pub fn agent_event(app: &tauri::AppHandle, event: &crate::providers::AgentEvent) {
    if Kind::of_event(&event.kind).is_none() { return; }
    let Some(request) = event.request_id.as_deref() else { return };
    seen(app, &event.session_id, &event.kind, request, &event.text, event.data.as_ref().unwrap_or(&Value::Null), None);
}

/// Events of mirrored tasks, as `mirror::show` emits them (relabelled to local ids). A mirror's snapshot after a lost
/// frame shows a request again: it opens nothing twice.
pub fn mirror_events(app: &tauri::AppHandle, events: &[Value]) {
    use crate::extensions::runtime_hook_payload as payloads;
    for event in events {
        let (Some(task), Some(kind), Some(request)) = (event["sessionId"].as_str(), event["kind"].as_str(), event["requestId"].as_str()) else { continue };
        if Kind::of_event(kind).is_none() { continue; }
        let data = &event["data"];
        let call = payloads::call_id(task, &format!("request:{request}"));
        let input = [&data["input"], &data["rawInput"]].into_iter().find(|input| !input.is_null()).cloned();
        seen(app, task, kind, request, event["text"].as_str().unwrap_or_default(), data, Some((call, input)));
    }
}

/// An approval was answered (`respond_approval`, by the user from the window, a bot or a remote viewer, or through a
/// package that attributed it first).
pub fn approval_answered(task: &str, request: &str, approved: bool) {
    if let Some(change) = BOOK.end(task, request, Ending::Answered { approved: Some(approved), response: None }) { deliver(hooks::registry(), [change]); }
}
/// A question was answered and its harness accepted the answer (`respond_user_input`).
pub fn question_answered(task: &str, request: &str, response: &Value) {
    if let Some(change) = BOOK.end(task, request, Ending::Answered { approved: None, response: Some(response.clone()) }) { deliver(hooks::registry(), [change]); }
}
/// A run of `task` ended (`run`: its id; `None` for a mirrored task's turn): its open requests end `cancelled`.
pub fn run_ended(task: &str, run: Option<&str>) { deliver(hooks::registry(), BOOK.end_run(task, run)); }
/// A task was removed.
pub fn task_removed(task: &str) { deliver(hooks::registry(), BOOK.forget_task(task)); }
/// R0505: a package's `ask` is about to put this request's prompt in front of the user.
pub fn asked_by(task: &str, request: &str, package: &str) { BOOK.asked_by(task, request, package); }
/// R0508: the answer about to be sent comes from `package`.
pub fn attribute(task: &str, request: &str, package: &str, reason: Option<&str>) -> Result<(), &'static str> { BOOK.attribute(task, request, package, reason) }
/// `task.idle.pending`.
pub fn counts(task: &str) -> (u64, u64) { BOOK.counts(task) }

/// `panda.hooks.pending()` (`hooksPending`, `{}`): the owner is the connection's, never the request's.
pub async fn serve(app: tauri::AppHandle, request: crate::extensions::runtime_service_lifetime::DispatchRequest) -> Value {
    let _ = app;
    if !request.params.is_null() && request.params.as_object().is_none_or(|fields| !fields.is_empty()) { return crate::extensions::context::failure("InvalidShape"); }
    match snapshot_for(hooks::registry(), &BOOK, &request.owner) {
        Ok(value) => json!({"ok": true, "value": value}),
        Err(code) => crate::extensions::context::failure(code),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const SCENARIOS: &str = include_str!("../../../tests/fixtures/extensions/runtime-pending-requests/scenarios.json");
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-pending-requests/inbox/extension.json");
    const OWNER: &str = "sample.pending-inbox";

    fn facts_from(table: &Value, task: &str, modes: &BTreeMap<String, String>) -> Facts {
        let row = &table[task];
        Facts {
            project: row["project"].as_str().unwrap().into(), harness: row["harness"].as_str().unwrap().into(),
            mode: modes.get(task).cloned().unwrap_or_else(|| row["mode"].as_str().unwrap().into()), run: row["run"].as_str().unwrap().into(),
        }
    }
    fn request_from(step: &Value, at: &str) -> Request {
        Request {
            task: step["task"].as_str().unwrap().into(), request: step["request"].as_str().unwrap().into(),
            text: step["text"].as_str().unwrap_or_default().into(), data: step["data"].clone(),
            call: step["call"].as_str().map(str::to_owned), input: step.get("input").cloned(), ask_at_host: step["askAtHost"] == true,
            at: step["at"].as_str().unwrap_or(at).into(),
        }
    }

    /// Replays one scripted scenario on a fresh book; answers the events it produced and the snapshots it took.
    fn replay(table: &Value, at: &str, steps: &[Value]) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
        let book = PendingBook::default();
        let mut modes: BTreeMap<String, String> = BTreeMap::new();
        let (mut events, mut snapshots, mut results) = (Vec::new(), Vec::new(), Vec::new());
        for step in steps {
            let task = step["task"].as_str().unwrap_or_default();
            let request = step["request"].as_str().unwrap_or_default();
            match step["op"].as_str().unwrap() {
                "event" => {
                    let (kind, opens) = Kind::of_event(step["kind"].as_str().unwrap()).unwrap();
                    let change = if opens { book.open(kind, &request_from(step, at), facts_from(table, task, &modes)) }
                        else { book.end(task, request, Ending::Withdrawn { current_mode: (kind == Kind::Approval).then(|| facts_from(table, task, &modes).mode) }) };
                    events.extend(change.map(|change| change.json()));
                }
                "mode" => { modes.insert(task.into(), step["mode"].as_str().unwrap().into()); }
                "askedBy" => book.asked_by(task, request, step["package"].as_str().unwrap()),
                "attribute" => results.push(json!(book.attribute(task, request, step["package"].as_str().unwrap(), step["reason"].as_str()).err())),
                "answered" => {
                    let ending = Ending::Answered { approved: step["approved"].as_bool(), response: step.get("response").cloned() };
                    events.extend(book.end(task, request, ending).map(|change| change.json()));
                }
                "runEnded" => events.extend(book.end_run(task, step["run"].as_str()).into_iter().map(|change| change.json())),
                "taskRemoved" => events.extend(book.forget_task(task).into_iter().map(|change| change.json())),
                "counts" => results.push(json!(book.counts(task))),
                "snapshot" => {
                    let projects: Option<BTreeSet<String>> = step["projects"].as_array().map(|projects| projects.iter().map(|project| project.as_str().unwrap().to_owned()).collect());
                    let mut snapshot = book.snapshot(|_, facts| projects.as_ref().is_none_or(|projects| projects.contains(&facts.project)));
                    snapshot.as_object_mut().unwrap().remove("revision");
                    snapshots.push(snapshot);
                }
                other => panic!("unknown op {other}"),
            }
        }
        (events, snapshots, results)
    }

    #[test]
    fn every_shared_scenario_replays_to_the_recorded_events_and_snapshots() {
        let script: Value = serde_json::from_str(SCENARIOS).unwrap();
        let at = script["at"].as_str().unwrap();
        for scenario in script["scenarios"].as_array().unwrap() {
            let id = scenario["id"].as_str().unwrap();
            let (events, snapshots, results) = replay(&script["tasks"], at, scenario["steps"].as_array().unwrap());
            let expect = &scenario["expect"];
            assert_eq!(Value::Array(events), expect["events"], "{id}: events");
            assert_eq!(Value::Array(snapshots), expect.get("snapshots").cloned().unwrap_or(json!([])), "{id}: snapshots");
            assert_eq!(Value::Array(results), expect.get("results").cloned().unwrap_or(json!([])), "{id}: results");
        }
    }

    #[test]
    fn resolutions_say_who_ended_the_request() {
        let facts = Facts { project: "A".into(), harness: "claude".into(), mode: "ask".into(), run: "task".into() };
        let request = |id: &str| Request { task: "t".into(), request: format!("run:{id}"), text: "Allow Bash?".into(), data: json!({"name": "Bash"}), at: "2026-11-17T00:00:00.000Z".into(), ..Request::default() };
        let book = PendingBook::default();
        for id in ["user", "package", "mode", "cancelled", "gone"] { book.open(Kind::Approval, &request(id), facts.clone()).unwrap(); }
        book.attribute("t", "run:package", "sample.inbox", Some("checked")).unwrap();
        let by = |change: Option<Change>| change.unwrap().payload["by"].clone();
        assert_eq!(by(book.end("t", "run:user", Ending::Answered { approved: Some(true), response: None })), "user");
        let package = book.end("t", "run:package", Ending::Answered { approved: Some(false), response: None }).unwrap().payload;
        assert_eq!((package["by"].clone(), package["reason"].clone(), package["approved"].clone()), (json!({"package": "sample.inbox"}), json!("checked"), json!(false)));
        assert_eq!(by(book.end("t", "run:mode", Ending::Withdrawn { current_mode: Some("full".into()) })), "mode");
        assert_eq!(by(book.end("t", "run:cancelled", Ending::Withdrawn { current_mode: Some("ask".into()) })), "cancelled");
        assert_eq!(by(book.end_run("t", Some("run")).pop()), "cancelled");
        // Each identity resolves once; a late frame of one never opens again.
        assert!(book.end("t", "run:user", Ending::Gone).is_none());
        assert!(book.open(Kind::Approval, &request("user"), facts.clone()).is_none());
        assert!(book.attribute("t", "run:user", "sample.inbox", None).is_err());
    }

    #[test]
    fn one_task_keeps_a_bounded_number_of_open_requests() {
        let facts = Facts { project: "A".into(), harness: "claude".into(), mode: "ask".into(), run: "task".into() };
        let book = PendingBook::default();
        for index in 0..OPEN_PER_TASK + 6 {
            let request = Request { task: "t".into(), request: format!("run:{index}"), at: "x".into(), ..Request::default() };
            assert!(book.open(Kind::Question, &request, facts.clone()).is_some());
        }
        assert_eq!(book.counts("t"), (0, OPEN_PER_TASK as u64));
        assert!(!book.is_open("t", "run:0"), "the oldest went first");
        let again = Request { task: "t".into(), request: "run:0".into(), at: "x".into(), ..Request::default() };
        assert!(book.open(Kind::Question, &again, facts).is_none(), "a dropped request never opens again");
    }

    #[test]
    fn a_large_snapshot_stays_inside_the_hook_frame() {
        let facts = Facts { project: "A".into(), harness: "claude".into(), mode: "ask".into(), run: "task".into() };
        let book = PendingBook::default();
        for index in 0..4 {
            let request = Request { task: "t".into(), request: format!("run:{index}"), text: "Allow Write?".into(), input: Some(json!({"content": "x".repeat(900 << 10)})), at: "x".into(), ..Request::default() };
            book.open(Kind::Approval, &request, facts.clone()).unwrap();
        }
        let snapshot = book.snapshot(|_, _| true);
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= SNAPSHOT_BYTES + 256);
        let approvals = snapshot["approvals"].as_array().unwrap();
        assert_eq!(approvals.len(), 4, "inputs are left out before whole requests");
        assert!(approvals.iter().any(|approval| approval.get("input").is_none()));
        assert_eq!(snapshot["truncated"], false);
    }

    /// A registry with the inbox package's declarations attached; `projects` are the projects its observe grant reaches.
    fn registry(projects: &'static [&'static str]) -> (HookRegistry, Arc<Mutex<Vec<Value>>>, Arc<std::sync::atomic::AtomicBool>) {
        let hub = HookRegistry::default();
        let revoked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let gate_revoked = revoked.clone();
        hub.set_gate(Arc::new(move |owner: &str, _: &str, permission: &str, project: Option<&str>| -> bool {
            owner == OWNER && permission == hooks::OBSERVE && !gate_revoked.load(std::sync::atomic::Ordering::SeqCst) && project.is_none_or(|project| projects.contains(&project))
        }));
        let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = seen.clone();
        hub.set_deliver(Arc::new(move |_: &str, frame: Value| -> Result<(), &'static str> { sink.lock().unwrap().push(frame); Ok(()) }));
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let declarations = hooks::check(&manifest).unwrap();
        for event in EVENTS { hub.register(OWNER, "1.0.0", &declarations, event).unwrap(); }
        (hub, seen, revoked)
    }

    #[test]
    fn deliveries_follow_the_observe_grant_and_the_match_filter() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let declarations = hooks::check(&manifest).unwrap();
        assert!(EVENTS.iter().all(|event| declarations.iter().any(|declaration| declaration.event == *event)), "the inbox declares every event");
        let (hub, seen, revoked) = registry(&["A"]);
        let book = PendingBook::default();
        let open = |task: &str, project: &str, harness: &str, run: &str| {
            let facts = Facts { project: project.into(), harness: harness.into(), mode: "ask".into(), run: run.into() };
            let request = Request { task: task.into(), request: format!("run:{task}"), text: "Allow Bash?".into(), data: json!({"name": "Bash"}), at: "x".into(), ..Request::default() };
            deliver(&hub, book.open(Kind::Approval, &request, facts))
        };
        assert_eq!(open("t1", "A", "claude", "task").delivered, 1);
        assert_eq!(open("t2", "B", "claude", "task"), Published { delivered: 0, filtered: 1, failed: 0 }, "outside the project grant");
        // The inbox's approval hooks leave team workers out (`match.runs`).
        assert_eq!(open("t3", "A", "claude", "worker").filtered, 1);
        revoked.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(open("t4", "A", "claude", "task").filtered, 1, "a revoked grant stops delivery with the next event");
        let frames = seen.lock().unwrap().clone();
        assert_eq!(frames.len(), 1);
        assert_eq!((frames[0]["event"].clone(), frames[0]["observeOnly"].clone(), frames[0]["payload"]["requestId"].clone()), (json!("approval.pending"), json!(true), json!("run:t1")));
    }

    #[test]
    fn a_service_recovers_the_open_set_after_a_gap_and_never_sees_a_resolved_request_again() {
        let (hub, seen, revoked) = registry(&["A"]);
        let book = PendingBook::default();
        let facts = |project: &str| Facts { project: project.into(), harness: "claude".into(), mode: "ask".into(), run: "task".into() };
        let question = |task: &str, id: &str| Request { task: task.into(), request: id.into(), text: "Which database?".into(), data: json!({"kind": "questions", "questions": [{"id": "db", "header": "", "question": "Which database?", "isOther": false, "isSecret": false, "options": [{"label": "Postgres", "description": ""}]}]}), at: "x".into(), ..Request::default() };
        let approval = |task: &str, id: &str| Request { task: task.into(), request: id.into(), text: "Allow Bash?".into(), data: json!({"name": "Bash"}), at: "x".into(), ..Request::default() };
        // The service misses everything (restarting): deliveries fail.
        hub.set_deliver(Arc::new(|_: &str, _: Value| -> Result<(), &'static str> { Err("HostUnavailable") }));
        assert_eq!(deliver(&hub, book.open(Kind::Question, &question("t1", "run:q1"), facts("A"))).failed, 1);
        deliver(&hub, book.open(Kind::Question, &question("t1", "run:q2"), facts("A")));
        deliver(&hub, book.open(Kind::Approval, &approval("t1", "run:a1"), facts("A")));
        deliver(&hub, book.open(Kind::Approval, &approval("t2", "run:a2"), facts("B")));
        deliver(&hub, book.end("t1", "run:q1", Ending::Answered { approved: None, response: Some(json!({"answers": {"db": {"answers": ["Postgres"]}}})) }));
        assert!(seen.lock().unwrap().is_empty());
        // Back: the snapshot is the current open set, inside the grant, without the resolved question.
        let snapshot = snapshot_for(&hub, &book, OWNER).unwrap();
        let ids = |list: &str| snapshot[list].as_array().unwrap().iter().map(|item| item["requestId"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        assert_eq!((ids("approvals"), ids("questions")), (vec!["run:a1".to_owned()], vec!["run:q2".to_owned()]));
        // A resumed frame of the resolved question opens nothing.
        assert!(book.open(Kind::Question, &question("t1", "run:q1"), facts("A")).is_none());
        // Without the grant nothing is listed; a package with no approval or question hook gets UnknownReference.
        revoked.store(true, std::sync::atomic::Ordering::SeqCst);
        let empty = snapshot_for(&hub, &book, OWNER).unwrap();
        assert_eq!((empty["approvals"].as_array().unwrap().len(), empty["questions"].as_array().unwrap().len()), (0, 0));
        assert_eq!(snapshot_for(&hub, &book, "sample.other"), Err("UnknownReference"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_prompt_left_by_a_timed_out_hook_stays_pending_without_a_time_limit() {
        use crate::extensions::runtime_hook_context::Step;
        use crate::extensions::runtime_hook_decisions::{action, Action, DecisionFold, Outcome};
        // The guard's tool.before did not answer inside its budget and declared `onFailure: "ask"`: the prompt appears.
        let mut fold = DecisionFold::new(&["approve", "deny", "ask"]);
        fold.step(&Step { owner: "sample.guard".into(), name: "Guard".into(), on_failure: "ask".into(), grants: BTreeSet::from(["harness.hooks.decide".to_owned()]), answer: Err("Timeout".into()) });
        let outcome = fold.outcome();
        assert!(matches!(action(&outcome, false, true), Action::Prompt(Some(ref note)) if note.contains("did not answer (Timeout)")));
        let Outcome::Ask(verdict) = outcome else { panic!("the failing ask policy asks") };
        let book = PendingBook::default();
        book.asked_by("t", "7", &verdict.owner);
        let facts = Facts { project: "A".into(), harness: "claude".into(), mode: "ask".into(), run: "task".into() };
        let request = Request { task: "t".into(), request: "run-1:7".into(), text: "Allow Bash?\nGuard did not answer (Timeout). Decide yourself.".into(), data: json!({"name": "Bash"}), call: Some("call-1".into()), input: Some(json!({"command": "rm -rf build"})), at: "x".into(), ..Request::default() };
        let pending = book.open(Kind::Approval, &request, facts).unwrap().payload;
        assert_eq!(pending["askedBy"], json!({"package": "sample.guard"}));
        assert_eq!((pending["callId"].clone(), pending["tool"].clone(), pending["input"].clone()), (json!("call-1"), json!({"kind": "shell", "name": "Bash"}), json!({"command": "rm -rf build"})));
        // Long after every budget (30 s per hook, 60 s per chain): still pending, listed, and resolved once.
        tokio::time::advance(std::time::Duration::from_secs(3_600)).await;
        assert!(book.is_open("t", "run-1:7"));
        assert_eq!(book.snapshot(|_, _| true)["approvals"][0], pending, "the frozen fields");
        let resolved = book.end("t", "run-1:7", Ending::Answered { approved: Some(true), response: None }).unwrap().payload;
        assert_eq!(resolved, json!({"requestId": "run-1:7", "callId": "call-1", "taskId": "t", "approved": true, "by": "user"}));
        assert!(book.end("t", "run-1:7", Ending::Answered { approved: Some(true), response: None }).is_none());
    }
}
