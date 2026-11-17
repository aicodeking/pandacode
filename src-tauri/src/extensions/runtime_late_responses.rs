//! Answering open requests after the hook budget (runtime phase R5, slice R0508): `panda.tasks.respond`.
//!
//! A hook that needs more than its budget leaves the normal prompt in front of the user (R0505/R0506) and the request
//! becomes a pending event (R0507). A package holding `harness.hooks.decide` answers it later with
//! `panda.tasks.respond(taskId, requestId, answer)`: `{ approved, reason? }` for an approval, `{ answers }` for a
//! question. Nothing expires; the request is valid while it is open.
//!
//! * **Open-request validation.** The request must be open in the pending book under that task. An id this app issued
//!   that is no longer open (answered, withdrawn, its run ended, its task removed, or open in another task) answers
//!   `StaleContext`; an id never seen answers `NotFound`. Ids carry their run (`<run>:<harness id>`), so an old id
//!   never reaches a newer request that reuses the harness id.
//! * **Grant.** `harness.hooks.decide` for the request's project and tool kind (a question counts as kind `other`),
//!   checked when the call arrives and again under the agent's approvals lock just before the answer is sent: a revoke,
//!   a narrowing or a disabled package in between sends nothing.
//! * **Mode and sandbox.** A package answers inside the user's mode, never around it: approving is refused
//!   (`UnsupportedCapability`) where R0505's `call_can` withholds `approve` (plan mode, sandbox escalations, standing
//!   rules). Denying is always possible.
//! * **One winner.** The user's answer paths and this one claim the request before answering; the second claimant is
//!   refused. A claim ends when its answer was sent or failed, so a rejected answer leaves the request open.
//! * **Attribution.** The answer carries the package (`decidedBy`, R0502) and its reason to the harness; the resolved
//!   event says `by: { package }` (R0507's `attribute`); the transcript says "answered through <package>". When a
//!   harness reports the answered request as withdrawn, the claim turns that report into the answer it was.
//!
//! Every refusal here has a non-security reason (ADR-0005): identity and predictability.
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, sync::{LazyLock, Mutex, MutexGuard}};

use crate::extensions::runtime_hook_payload::{self as payloads, Answer, DenyReason, Support};
use crate::extensions::runtime_pending_requests::{self as pending, Ending, Kind, PendingBook};

/// The service request of `panda.tasks.respond`.
pub const METHOD: &str = "tasksRespond";
/// The permission every answer needs.
pub const DECIDE: &str = "harness.hooks.decide";
/// The tool kind a question is checked under.
pub const QUESTION_KIND: &str = "other";
/// Largest `answers` a package may send (the window's own limit for `respond_user_input`).
pub const ANSWERS_BYTES: usize = 32 * 1024;
/// Most entries in `answers`.
const ANSWERS: usize = 64;
/// Request ids remembered per task and in all, so an ended id answers `StaleContext`, not `NotFound`.
const ISSUED_PER_TASK: usize = 256;
const ISSUED_TOTAL: usize = 8_192;
const ID_BYTES: usize = 512;

/// A refusal in the broker envelope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal { pub code: &'static str, pub path: String }
impl Refusal {
    pub fn new(code: &'static str) -> Self { Self { code, path: "$".into() } }
    pub fn at(code: &'static str, path: &str) -> Self { Self { code, path: path.into() } }
    pub fn envelope(&self) -> Value { crate::extensions::runtime_tasks_start::failure_with(self.code, &self.path, &[]) }
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------------

/// What a package sent.
#[derive(Clone, Debug, PartialEq)]
pub enum Reply { Approval { approved: bool, reason: Option<String> }, Answers(Map<String, Value>) }
/// A parsed `tasks.respond`.
#[derive(Clone, Debug, PartialEq)]
pub struct Respond { pub task: String, pub request: String, pub reply: Reply }

fn ident(value: Option<&Value>, path: &str) -> Result<String, Refusal> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty() && text.len() <= ID_BYTES && !text.chars().any(char::is_control)).map(str::to_owned).ok_or_else(|| Refusal::at("InvalidShape", path))
}

/// `{ taskId, requestId, answer }`, strictly.
pub fn parse(params: &Value) -> Result<Respond, Refusal> {
    let fields = params.as_object().ok_or_else(|| Refusal::new("InvalidShape"))?;
    if fields.len() != 3 || !["taskId", "requestId", "answer"].iter().all(|key| fields.contains_key(*key)) { return Err(Refusal::new("InvalidShape")); }
    let task = ident(fields.get("taskId"), "$.taskId")?;
    let request = ident(fields.get("requestId"), "$.requestId")?;
    let answer = fields["answer"].as_object().ok_or_else(|| Refusal::at("InvalidShape", "$.answer"))?;
    let reply = if answer.contains_key("approved") {
        if answer.keys().any(|key| key != "approved" && key != "reason") { return Err(Refusal::at("InvalidShape", "$.answer")); }
        let approved = answer["approved"].as_bool().ok_or_else(|| Refusal::at("InvalidShape", "$.answer.approved"))?;
        let reason = match answer.get("reason") { None | Some(Value::Null) => None, Some(Value::String(text)) => Some(text.clone()), Some(_) => return Err(Refusal::at("InvalidShape", "$.answer.reason")) };
        if let Err(error) = (Answer { approved, reason: reason.clone(), input: None, decided_by: None }).validate() {
            return Err(Refusal::at(if error.starts_with("LimitExceeded") { "LimitExceeded" } else { "InvalidShape" }, "$.answer.reason"));
        }
        Reply::Approval { approved, reason }
    } else if answer.len() == 1 && answer.contains_key("answers") {
        let answers = answer["answers"].as_object().ok_or_else(|| Refusal::at("InvalidShape", "$.answer.answers"))?;
        if answers.len() > ANSWERS || serde_json::to_vec(answers).map_or(usize::MAX, |bytes| bytes.len()) > ANSWERS_BYTES { return Err(Refusal::at("LimitExceeded", "$.answer.answers")); }
        Reply::Answers(answers.clone())
    } else {
        return Err(Refusal::at("InvalidShape", "$.answer"));
    };
    Ok(Respond { task, request, reply })
}

// ---------------------------------------------------------------------------------------------------------------
// Questions: a package's answers as the response the window would send
// ---------------------------------------------------------------------------------------------------------------

/// The form of a question, from core's normalized `input_request` data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Form { Questions, Fields, Url, Other }
impl Form {
    pub fn of(data: &Value) -> Self {
        match data["kind"].as_str() { Some("questions") => Form::Questions, Some("form") => Form::Fields, Some("url") => Form::Url, _ => Form::Other }
    }
}

/// The response for `RunInput::UserInput`, from `answers` and the question's frozen `PendingQuestion.questions`:
///
/// * `Questions`: each id is a question; a value is a text or a one-text list (`{ answers: { [id]: [text] } }`); all
///   questions or none (none skips them, as the window's cancel does);
/// * `Fields`: `{ action: "accept", content: answers }`, each key a field (the harness's validation still applies);
/// * `Url`: `{ url: "accept" | "decline" | "cancel" }` or `{ url: true | false }`;
/// * `Other`: no structured answer exists (`UnsupportedCapability`): the user answers it in the window.
pub fn response_for(form: Form, questions: &[Value], answers: &Map<String, Value>) -> Result<Value, Refusal> {
    let known = |id: &str| questions.iter().any(|question| question["id"] == id);
    if let Some(unknown) = answers.keys().find(|id| !known(id)) { return Err(Refusal::at("InvalidShape", &format!("$.answer.answers.{unknown}"))); }
    match form {
        Form::Questions => {
            if !answers.is_empty() && answers.len() != questions.len() { return Err(Refusal::at("InvalidShape", "$.answer.answers")); }
            let mut out = Map::new();
            for (id, value) in answers {
                let text = match value {
                    Value::String(text) => text.clone(),
                    Value::Array(list) if list.len() == 1 && list[0].is_string() => list[0].as_str().unwrap_or_default().to_owned(),
                    _ => return Err(Refusal::at("InvalidShape", &format!("$.answer.answers.{id}"))),
                };
                if text.is_empty() { return Err(Refusal::at("InvalidShape", &format!("$.answer.answers.{id}"))); }
                out.insert(id.clone(), json!([text]));
            }
            Ok(json!({"answers": out}))
        }
        Form::Fields => Ok(json!({"action": "accept", "content": answers})),
        Form::Url => {
            let action = match answers.get("url") {
                Some(Value::Bool(true)) => "accept",
                Some(Value::Bool(false)) => "decline",
                Some(Value::String(text)) if ["accept", "decline", "cancel"].contains(&text.as_str()) => text.as_str(),
                _ => return Err(Refusal::at("InvalidShape", "$.answer.answers.url")),
            };
            Ok(json!({"action": action}))
        }
        Form::Other => Err(Refusal::at("UnsupportedCapability", "$.answer")),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Claims (one winner) and the ids this app issued
// ---------------------------------------------------------------------------------------------------------------

/// What this app saw of a request when it opened.
#[derive(Clone, Debug, PartialEq)]
pub struct Issued { pub kind: Kind, pub form: Form, pub lasting: bool }

struct Claim { ending: Ending, armed: bool, token: u64 }
#[derive(Default)]
struct Ledger {
    claims: BTreeMap<(String, String), Claim>,
    issued: BTreeMap<(String, String), (u64, Issued)>,
    serial: u64,
}

/// The claims of answers in flight and the ids this app issued; tests build their own.
#[derive(Default)]
pub struct Responses { inner: Mutex<Ledger> }

/// An answer in flight. Dropped, it ends its claim.
pub struct Answering<'a> { owner: &'a Responses, key: (String, String), token: u64 }
impl Answering<'_> {
    /// The answer is about to be sent: a withdrawal the harness reports from now on is this answer.
    pub fn arm(&self) {
        if let Some(claim) = self.owner.lock().claims.get_mut(&self.key).filter(|claim| claim.token == self.token) { claim.armed = true; }
    }
}
impl Drop for Answering<'_> {
    fn drop(&mut self) {
        let mut inner = self.owner.lock();
        if inner.claims.get(&self.key).is_some_and(|claim| claim.token == self.token) { inner.claims.remove(&self.key); }
    }
}

impl Responses {
    fn lock(&self) -> MutexGuard<'_, Ledger> { self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) }

    /// Claims the answer of a request; `Err("StaleContext")` while another answer to it is in flight.
    pub fn claim(&self, task: &str, request: &str, ending: Ending) -> Result<Answering<'_>, &'static str> {
        let mut inner = self.lock();
        let key = (task.to_owned(), request.to_owned());
        if inner.claims.contains_key(&key) { return Err("StaleContext"); }
        inner.serial += 1;
        let token = inner.serial;
        inner.claims.insert(key.clone(), Claim { ending, armed: false, token });
        Ok(Answering { owner: self, key, token })
    }

    /// A request opened (`approval` / `input_request`, under the id the app shows).
    pub fn issue(&self, task: &str, request: &str, issued: Issued) {
        let mut inner = self.lock();
        inner.serial += 1;
        let order = inner.serial;
        inner.issued.insert((task.to_owned(), request.to_owned()), (order, issued));
        while inner.issued.keys().filter(|(owner, _)| owner == task).count() > ISSUED_PER_TASK {
            let Some(oldest) = inner.issued.iter().filter(|((owner, _), _)| owner == task).min_by_key(|(_, (order, _))| *order).map(|(key, _)| key.clone()) else { break };
            inner.issued.remove(&oldest);
        }
        while inner.issued.len() > ISSUED_TOTAL {
            let Some(oldest) = inner.issued.iter().min_by_key(|(_, (order, _))| *order).map(|(key, _)| key.clone()) else { break };
            inner.issued.remove(&oldest);
        }
    }
    pub fn issued(&self, task: &str, request: &str) -> Option<Issued> { self.lock().issued.get(&(task.to_owned(), request.to_owned())).map(|(_, issued)| issued.clone()) }
    /// Whether this app issued the id under any task.
    pub fn known(&self, request: &str) -> bool { self.lock().issued.keys().any(|(_, id)| id == request) }

    /// The harness reports a request withdrawn: the answer it really was when an armed claim is in flight.
    pub fn withdrawn(&self, task: &str, request: &str) -> Option<Ending> {
        self.lock().claims.get(&(task.to_owned(), request.to_owned())).filter(|claim| claim.armed).map(|claim| claim.ending.clone())
    }
}

static RESPONSES: LazyLock<Responses> = LazyLock::new(Responses::default);
/// The app's ledger.
pub fn responses() -> &'static Responses { &RESPONSES }

/// The ending an approval answer is.
pub fn approval_ending(approved: bool) -> Ending { Ending::Answered { approved: Some(approved), response: None } }
/// The ending a question answer is.
pub fn question_ending(response: &Value) -> Ending { Ending::Answered { approved: None, response: Some(response.clone()) } }

// ---------------------------------------------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------------------------------------------

/// An open request as the pending book froze it.
#[derive(Clone, Debug, PartialEq)]
pub struct Open { pub kind: Kind, pub project: String, pub harness: String, pub mode: String, pub tool: String, pub tool_kind: String, pub questions: Vec<Value> }
impl Open {
    /// From a `hooks.pending` item (`PendingApproval` or `PendingQuestion`).
    pub fn of(kind: Kind, item: &Value) -> Self {
        let text = |key: &str| item[key].as_str().unwrap_or_default().to_owned();
        Open {
            kind, project: text("projectId"), harness: text("harness"), mode: text("mode"),
            tool: item["tool"]["name"].as_str().unwrap_or("tool").to_owned(),
            tool_kind: match kind { Kind::Approval => item["tool"]["kind"].as_str().unwrap_or("other").to_owned(), Kind::Question => QUESTION_KIND.to_owned() },
            questions: item["questions"].as_array().cloned().unwrap_or_default(),
        }
    }
}

/// What admission reads. Each read is now.
pub(crate) struct World<'a> {
    /// The request, when it is open in that task.
    pub open: &'a dyn Fn(&str, &str) -> Option<Open>,
    /// What the app saw when it opened (`None` for a mirror's request).
    pub issued: &'a dyn Fn(&str, &str) -> Option<Issued>,
    /// The id was issued under any task.
    pub known: &'a dyn Fn(&str) -> bool,
    /// The package holds `harness.hooks.decide` for some project.
    pub holds_any: &'a dyn Fn() -> bool,
    /// `(project, tool kind)`: the package holds the grant there.
    pub granted: &'a dyn Fn(&str, &str) -> bool,
    /// The task's mode now.
    pub mode: &'a dyn Fn(&str) -> Option<String>,
    /// What the request's source can carry back.
    pub support: &'a dyn Fn(&str, &str) -> Support,
}

/// What to send.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Plan { Approval { approved: bool, reason: Option<String>, support: Support }, Question { response: Value } }
impl Plan {
    pub fn ending(&self) -> Ending {
        match self { Plan::Approval { approved, .. } => approval_ending(*approved), Plan::Question { response } => question_ending(response) }
    }
}

/// Checks a parsed answer against the open request, the grant and the mode. Nothing is changed.
pub(crate) fn admit(world: &World<'_>, respond: &Respond) -> Result<(Open, Plan), Refusal> {
    if !(world.holds_any)() { return Err(Refusal::at("PermissionDenied", DECIDE)); }
    let Some(open) = (world.open)(&respond.task, &respond.request) else {
        return Err(Refusal::at(if (world.known)(&respond.request) { "StaleContext" } else { "NotFound" }, "$.requestId"));
    };
    if !(world.granted)(&open.project, &open.tool_kind) { return Err(Refusal::at("PermissionDenied", DECIDE)); }
    let issued = (world.issued)(&respond.task, &respond.request);
    let plan = match (&respond.reply, open.kind) {
        (Reply::Approval { approved, reason }, Kind::Approval) => {
            let support = (world.support)(&respond.task, &respond.request);
            if *approved {
                let mode = (world.mode)(&respond.task).unwrap_or_else(|| open.mode.clone());
                let lasting = issued.as_ref().is_some_and(|issued| issued.lasting);
                let can = crate::extensions::runtime_hook_decisions::call_can(support, crate::extensions::runtime_hook_decisions::PERMISSION_REQUEST, &open.harness, &mode, &open.tool_kind, lasting);
                if !can.contains(&"approve") { return Err(Refusal::at("UnsupportedCapability", "$.answer.approved")); }
            }
            Plan::Approval { approved: *approved, reason: reason.clone(), support }
        }
        (Reply::Answers(answers), Kind::Question) => {
            let form = issued.map_or_else(|| infer_form(&open.questions), |issued| issued.form);
            Plan::Question { response: response_for(form, &open.questions, answers)? }
        }
        _ => return Err(Refusal::at("InvalidShape", "$.answer")),
    };
    Ok((open, plan))
}

/// A mirror's question was not seen here: its form from the frozen questions.
fn infer_form(questions: &[Value]) -> Form {
    match questions {
        [only] if only["id"] == "url" => Form::Url,
        [only] if only["id"] == "q0" => Form::Other,
        _ if questions.iter().any(|question| question["multiple"] == true) => Form::Fields,
        _ => Form::Questions,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Sending: the steps every transport shares
// ---------------------------------------------------------------------------------------------------------------

/// Run under the agent's approvals lock once the request is known to be pending (`original`: the harness's own id):
/// the grant again, the book's attribution, the details for the adapter (R0502). Answers the steering text to send
/// after a deny when the harness takes its reason that way.
#[allow(clippy::too_many_arguments)]
pub fn attribute_approval(book: &PendingBook, run: &str, task: &str, request: &str, original: &str, owner: &str, name: &str, tool: &str, approved: bool, reason: Option<&str>, granted_now: bool) -> Result<Option<String>, &'static str> {
    if !granted_now { return Err("PermissionDenied"); }
    book.attribute(task, request, owner, reason)?;
    let support = payloads::support(run, original);
    // A request the adapter did not open there (some built-in arms) still takes the bare answer.
    let _ = payloads::attach(run, original, Answer { approved, reason: reason.map(str::to_owned), input: None, decided_by: Some(owner.to_owned()) });
    let steer = support.filter(|support| !approved && support.deny_reason == DenyReason::Steer);
    Ok(steer.and(reason).map(|reason| format!("{name} denied {tool}: {reason}")))
}
/// The same for a question. Answers whether the adapter took the attribution.
pub fn attribute_question(book: &PendingBook, run: &str, task: &str, request: &str, original: &str, owner: &str, granted_now: bool) -> Result<bool, &'static str> {
    if !granted_now { return Err("PermissionDenied"); }
    book.attribute(task, request, owner, None)?;
    Ok(payloads::attach_question(run, original, owner).is_ok())
}
/// The answer was not sent: the request stays open, attributed to nobody.
pub(crate) fn undo(book: &PendingBook, run: &str, task: &str, request: &str, original: Option<&str>, plan: &Plan, question_attached: bool) {
    book.unattribute(task, request);
    let Some(original) = original else { return };
    match plan {
        Plan::Approval { approved, .. } => { let _ = payloads::attach(run, original, Answer::plain(*approved)); }
        Plan::Question { .. } if question_attached => payloads::open_question(run, original),
        Plan::Question { .. } => {}
    }
}
/// A sending error as a code: the request had moved on (`StaleContext`), the grant went (`PermissionDenied`), the
/// harness refused the answer (`InvalidShape`), anything else (`HostUnavailable`).
pub fn code_of(error: &str) -> &'static str {
    match error {
        "PermissionDenied" => "PermissionDenied",
        "StaleContext" => "StaleContext",
        _ if error.contains("no longer pending") || error.contains("earlier run") || error.contains("no longer running") || error.contains("has stopped") || error.contains("stopped before") => "StaleContext",
        _ if error.starts_with("Answer ") || error.starts_with("Response ") || error.starts_with("Each ") || error.starts_with("A required") || error.starts_with("Choose ") => "InvalidShape",
        _ => "HostUnavailable",
    }
}
/// The transcript line of an answer given through a package.
pub fn line(kind: Kind, tool: &str, name: &str, approved: bool, reason: Option<&str>) -> String {
    let reason = reason.map(|reason| format!(" {reason}")).unwrap_or_default();
    match kind {
        Kind::Approval => format!("{tool} {} through {name}.{reason}", if approved { "approved" } else { "denied" }),
        Kind::Question => format!("Question answered through {name}."),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------------------------------

/// The agent event sink (`emit_coalesced`, before R0507's): remembers what opened, and turns a withdrawal reported for
/// an answer in flight into that answer.
pub fn agent_event(event: &crate::providers::AgentEvent) {
    let Some(request) = event.request_id.as_deref().filter(|id| !id.is_empty() && id.len() <= ID_BYTES) else { return };
    let task = &event.session_id;
    match event.kind.as_str() {
        "approval" | "input_request" => {
            let data = event.data.as_ref().unwrap_or(&Value::Null);
            let kind = if event.kind == "approval" { Kind::Approval } else { Kind::Question };
            RESPONSES.issue(task, request, Issued { kind, form: Form::of(data), lasting: data[crate::providers::LASTING_ONLY] == true });
        }
        "approval_cancelled" | "input_cancelled" => {
            if let Some(ending) = RESPONSES.withdrawn(task, request) {
                if let Some(change) = pending::book().end(task, request, ending) { pending::deliver(crate::extensions::runtime_hook_registration::registry(), [change]); }
            }
        }
        _ => {}
    }
}

/// The open request from the book's frozen payloads.
fn open_of(task: &str, request: &str) -> Option<Open> {
    if !pending::book().is_open(task, request) { return None; }
    let snapshot = pending::book().snapshot(|_, _| true);
    for (list, kind) in [("approvals", Kind::Approval), ("questions", Kind::Question)] {
        if let Some(item) = snapshot[list].as_array().into_iter().flatten().find(|item| item["taskId"] == task && item["requestId"] == request) { return Some(Open::of(kind, item)); }
    }
    None
}

fn package(app: &tauri::AppHandle, owner: &str) -> Result<(String, String), &'static str> {
    use tauri::Manager;
    let packages = app.try_state::<crate::extensions::packages::ExtensionPackages>().ok_or("HostUnavailable")?;
    let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
    let version = crate::extensions::runtime_service_lifetime::runtime_usage_resources::enabled_version(&packages, owner).ok_or("PermissionDenied")?;
    let snapshot = serde_json::to_value(packages.snapshot()).unwrap_or(Value::Null);
    let name = snapshot["packages"].as_array().into_iter().flatten().find(|package| package["manifest"]["id"] == owner)
        .and_then(|package| package["manifest"]["name"].as_str().filter(|name| !name.trim().is_empty()).map(str::to_owned)).unwrap_or_else(|| owner.to_owned());
    Ok((version, name))
}
fn granted(app: &tauri::AppHandle, owner: &str, version: &str, project: &str, kind: &str) -> bool {
    use tauri::Manager;
    app.try_state::<crate::extensions::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(owner, version, DECIDE, &crate::extensions::runtime_grants::Target::tool(project, kind)).is_ok())
}
fn holds_any(app: &tauri::AppHandle, owner: &str, version: &str) -> bool {
    use tauri::Manager;
    let Some(grants) = app.try_state::<crate::extensions::runtime_grants::RuntimeGrants>() else { return false };
    let projection = grants.projection();
    projection["packages"].as_array().into_iter().flatten().any(|package| {
        package["id"] == owner && package["version"] == version && package["authorized"] == true
            && package["grants"].as_array().into_iter().flatten().any(|grant| grant["permission"] == DECIDE && grant["scope"]["projects"].as_array().is_none_or(|projects| !projects.is_empty()))
    })
}
fn system_line(app: &tauri::AppHandle, task: &str, text: &str) {
    use tauri::{Emitter, Manager};
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    let saved = state.store.lock().ok().map(|store| store.insert_message(task, "system", text));
    if saved.is_some() { let _ = app.emit("sessions-changed", ()); }
}

/// `panda.tasks.respond` (`tasksRespond`): the owner is the connection's, never the request's.
pub async fn serve(app: tauri::AppHandle, request: crate::extensions::runtime_service_lifetime::DispatchRequest) -> Value {
    use tauri::Manager;
    let respond = match parse(&request.params) { Ok(respond) => respond, Err(refusal) => return refusal.envelope() };
    let owner = request.owner.clone();
    let (version, name) = match package(&app, &owner) { Ok(found) => found, Err("PermissionDenied") => return Refusal::at("PermissionDenied", DECIDE).envelope(), Err(code) => return Refusal::new(code).envelope() };
    // Admission reads everything now; `World` holds no reference past this block (the future stays `Send`).
    let admitted = {
        let mode_of = |task: &str| app.try_state::<crate::AppState>().and_then(|state| state.store.lock().ok().and_then(|store| store.session(task).ok().map(|session| session.mode)));
        let world = World {
            open: &open_of,
            issued: &|task, id| RESPONSES.issued(task, id),
            known: &|id| RESPONSES.known(id),
            holds_any: &|| holds_any(&app, &owner, &version),
            granted: &|project, kind| granted(&app, &owner, &version, project, kind),
            mode: &mode_of,
            support: &|task, id| payloads::support(task, pending::local_id(id)).unwrap_or(Support::BARE),
        };
        admit(&world, &respond)
    };
    let (open, plan) = match admitted { Ok(admitted) => admitted, Err(refusal) => return refusal.envelope() };
    let Ok(answering) = RESPONSES.claim(&respond.task, &respond.request, plan.ending()) else { return Refusal::at("StaleContext", "$.requestId").envelope() };
    let Some(state) = app.try_state::<crate::AppState>() else { return Refusal::new("HostUnavailable").envelope() };
    let (task, id) = (respond.task.as_str(), respond.request.as_str());
    let book = pending::book();
    let reason = match &plan { Plan::Approval { reason, .. } => reason.clone(), Plan::Question { .. } => None };

    // A task on another machine: the same route as the window's answer; attributed before it can come back.
    let routed_params = match &plan {
        Plan::Approval { approved, .. } => ("approval.respond", json!({"requestId": id, "approve": approved})),
        Plan::Question { response } => ("input.respond", json!({"requestId": id, "response": response})),
    };
    let mirrored = state.store.lock().ok().is_some_and(|store| crate::remote::mirror::prepare(&store, task, routed_params.0, routed_params.1.clone()).ok().flatten().is_some());
    if mirrored {
        if !granted(&app, &owner, &version, &open.project, &open.tool_kind) { return Refusal::at("PermissionDenied", DECIDE).envelope(); }
        if book.attribute(task, id, &owner, reason.as_deref()).is_err() { return Refusal::at("StaleContext", "$.requestId").envelope(); }
        answering.arm();
        return match crate::remote::route(&app, &state, task, routed_params.0, routed_params.1).await {
            Ok(Some(_)) => { finish(&app, task, id, &open, &plan, &name); ok() }
            Ok(None) | Err(_) => { book.unattribute(task, id); Refusal::at("StaleContext", "$.requestId").envelope() }
        };
    }

    // A task running here: the window's own lock and checks.
    let mut original: Option<String> = None;
    let mut attached = false;
    let sent = match &plan {
        Plan::Approval { approved, reason, .. } => {
            let mut before = |harness_id: &str| -> Result<Option<crate::providers::RunInput>, String> {
                original = Some(harness_id.to_owned());
                let steer = attribute_approval(book, task, task, id, harness_id, &owner, &name, &open.tool, *approved, reason.as_deref(), granted(&app, &owner, &version, &open.project, &open.tool_kind)).map_err(str::to_owned)?;
                answering.arm();
                Ok(steer.map(|text| { let (reply, _) = tokio::sync::oneshot::channel(); crate::providers::RunInput::Steer { id: uuid::Uuid::new_v4().to_string(), text, reply } }))
            };
            crate::respond_approval_for_extension(&state, task, id, *approved, &mut before)
        }
        Plan::Question { response } => {
            let before = |harness_id: &str| -> Result<(), String> {
                original = Some(harness_id.to_owned());
                attached = attribute_question(book, task, task, id, harness_id, &owner, granted(&app, &owner, &version, &open.project, QUESTION_KIND)).map_err(str::to_owned)?;
                answering.arm();
                Ok(())
            };
            crate::answer_user_input(&state, task, id, response.clone(), before).await
        }
    };
    match sent {
        Ok(()) => { finish(&app, task, id, &open, &plan, &name); drop(answering); ok() }
        Err(error) => {
            undo(book, task, task, id, original.as_deref(), &plan, attached);
            let code = code_of(&error);
            Refusal::at(code, if code == "PermissionDenied" { DECIDE } else if code == "InvalidShape" { "$.answer" } else { "$.requestId" }).envelope()
        }
    }
}
fn ok() -> Value { json!({"ok": true, "value": null}) }

/// The answer was sent: its resolved event (by the package), and the transcript line.
fn finish(app: &tauri::AppHandle, task: &str, request: &str, open: &Open, plan: &Plan, name: &str) {
    match plan {
        Plan::Approval { approved, reason, .. } => {
            pending::approval_answered(task, request, *approved);
            system_line(app, task, &line(Kind::Approval, &open.tool, name, *approved, reason.as_deref()));
        }
        Plan::Question { response } => {
            pending::question_answered(task, request, response);
            system_line(app, task, &line(Kind::Question, &open.tool, name, true, None));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::runtime_pending_requests::{Facts, Request};
    use std::collections::{BTreeMap, BTreeSet};

    const SCENARIOS: &str = include_str!("../../../tests/fixtures/extensions/runtime-late-responses/scenarios.json");
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-late-responses/responder/extension.json");

    /// A stand-in for one task's running agent, with the same checks as `RunningAgent::respond_approval` and the local
    /// part of `respond_user_input`: the request must be pending in the current run, and its id must carry that run.
    struct Agent { run: String, pending: BTreeSet<String>, alive: bool }
    impl Agent {
        fn original(&self, request: &str) -> Result<String, String> {
            if !self.alive || !self.pending.contains(request) { return Err("This approval is no longer pending.".into()); }
            request.strip_prefix(&format!("{}:", self.run)).map(str::to_owned).ok_or_else(|| "This approval belongs to an earlier run.".into())
        }
    }

    /// Replays one scripted scenario: the resolved events, the results of `respond` / `user`, and what each agent
    /// received. `payloads` keys are made unique per replay (the call store is process-wide); the book and the ledger
    /// are the replay's own.
    struct Replay<'a> {
        table: &'a Value, owner: String, name: String, prefix: String,
        book: PendingBook, responses: &'static Responses, agents: BTreeMap<String, Agent>, modes: BTreeMap<String, String>,
        granted: bool, enabled: bool, held: Option<Answering<'static>>,
        events: Vec<Value>, results: Vec<Value>, inputs: Vec<Value>,
    }
    impl<'a> Replay<'a> {
        fn run_key(&self, task: &str) -> String { format!("{}-{task}", self.prefix) }
        fn row(&self, task: &str) -> &Value { &self.table[task] }
        fn facts(&self, task: &str) -> Facts {
            let row = self.row(task);
            Facts { project: row["project"].as_str().unwrap().into(), harness: row["harness"].as_str().unwrap().into(), mode: self.modes.get(task).cloned().unwrap_or_else(|| row["mode"].as_str().unwrap().into()), run: "task".into() }
        }
        fn push(&mut self, change: Option<pending::Change>) { if let Some(change) = change { if change.event.ends_with(".resolved") { self.events.push(change.json()); } } }

        fn open(&mut self, step: &Value) {
            let (task, request) = (step["task"].as_str().unwrap(), step["request"].as_str().unwrap());
            let kind = if step["kind"] == "approval" { Kind::Approval } else { Kind::Question };
            let data = step["data"].clone();
            let local = pending::local_id(request).to_owned();
            let run = self.run_key(task);
            match kind {
                Kind::Approval => { payloads::open_approval(&run, &local, None, payloads::builtin_support(self.row(task)["harness"].as_str().unwrap())); }
                Kind::Question => payloads::open_question(&run, &local),
            }
            self.responses.issue(task, request, Issued { kind, form: Form::of(&data), lasting: data[crate::providers::LASTING_ONLY] == true });
            let facts = self.facts(task);
            let opened = Request { task: task.into(), request: request.into(), text: step["text"].as_str().unwrap_or_default().into(), data, at: "2026-11-17T00:00:00.000Z".into(), ..Request::default() };
            self.book.open(kind, &opened, facts);
            self.agents.get_mut(task).unwrap().pending.insert(request.into());
        }

        fn world_open(&self, task: &str, request: &str) -> Option<Open> {
            if !self.book.is_open(task, request) { return None; }
            let snapshot = self.book.snapshot(|_, _| true);
            [("approvals", Kind::Approval), ("questions", Kind::Question)].into_iter().find_map(|(list, kind)| snapshot[list].as_array().into_iter().flatten().find(|item| item["taskId"] == task && item["requestId"] == request).map(|item| Open::of(kind, item)))
        }

        fn respond(&mut self, step: &Value) -> Value {
            let params = json!({"taskId": step["task"], "requestId": step["request"], "answer": step["answer"]});
            let respond = match parse(&params) { Ok(respond) => respond, Err(refusal) => return json!(refusal.code) };
            let admitted = {
                let world = World {
                    open: &|task, request| self.world_open(task, request),
                    issued: &|task, request| self.responses.issued(task, request),
                    known: &|request| self.responses.known(request),
                    holds_any: &|| self.enabled,
                    granted: &|_, _| self.enabled && self.granted,
                    mode: &|task| Some(self.facts(task).mode),
                    support: &|task, request| payloads::support(&self.run_key(task), pending::local_id(request)).unwrap_or(Support::BARE),
                };
                admit(&world, &respond)
            };
            let (open, plan) = match admitted { Ok(admitted) => admitted, Err(refusal) => return json!(refusal.code) };
            let (task, request) = (respond.task.clone(), respond.request.clone());
            let Ok(answering) = self.responses.claim(&task, &request, plan.ending()) else { return json!("StaleContext") };
            let run = self.run_key(&task);
            let granted_now = self.enabled && self.granted && step["revokeAtSend"] != true;
            let original = match self.agents.get(&task).map_or(Err("This agent is no longer running.".to_owned()), |agent| agent.original(&request)) { Ok(original) => original, Err(error) => return json!(code_of(&error)) };
            let sent: Result<Vec<Value>, String> = match &plan {
                Plan::Approval { approved, reason, .. } => attribute_approval(&self.book, &run, &task, &request, &original, &self.owner, &self.name, &open.tool, *approved, reason.as_deref(), granted_now).map_err(str::to_owned).map(|steer| {
                    answering.arm();
                    let taken = payloads::take(&run, &original, *approved);
                    let mut inputs = vec![answer_json(&original, &taken)];
                    inputs.extend(steer.map(|text| json!({"steer": text})));
                    inputs
                }),
                Plan::Question { response } => match attribute_question(&self.book, &run, &task, &request, &original, &self.owner, granted_now) {
                    Err(error) => Err(error.to_owned()),
                    Ok(attached) => {
                        answering.arm();
                        if step["reject"] == true {
                            undo(&self.book, &run, &task, &request, Some(&original), &plan, attached);
                            return json!("InvalidShape");
                        }
                        let by = payloads::take_question(&run, &original);
                        Ok(vec![question_json(&original, response, by)])
                    }
                },
            };
            match sent {
                Ok(inputs) => {
                    self.inputs.extend(inputs);
                    self.agents.get_mut(&task).unwrap().pending.remove(&request);
                    // A package provider reports the answered request as withdrawn while it is being answered.
                    if step["withdrawOnSend"] == true { if let Some(ending) = self.responses.withdrawn(&task, &request) { let change = self.book.end(&task, &request, ending); self.push(change); } }
                    let change = self.book.end(&task, &request, plan.ending());
                    self.push(change);
                    drop(answering);
                    Value::Null
                }
                Err(error) => { undo(&self.book, &run, &task, &request, Some(&original), &plan, false); json!(code_of(&error)) }
            }
        }

        fn user(&mut self, step: &Value) -> Value {
            let (task, request) = (step["task"].as_str().unwrap().to_owned(), step["request"].as_str().unwrap().to_owned());
            let ending = match step.get("response") { Some(response) => question_ending(response), None => approval_ending(step["approved"] == true) };
            let Ok(answering) = self.responses.claim(&task, &request, ending.clone()) else { return json!("busy") };
            let Some(Ok(original)) = self.agents.get(&task).map(|agent| agent.original(&request)) else { return json!("stale") };
            answering.arm();
            let run = self.run_key(&task);
            let input = match step.get("response") {
                Some(response) => question_json(&original, response, payloads::take_question(&run, &original)),
                None => answer_json(&original, &payloads::take(&run, &original, step["approved"] == true)),
            };
            self.inputs.push(input);
            self.agents.get_mut(&task).unwrap().pending.remove(&request);
            let change = self.book.end(&task, &request, ending);
            self.push(change);
            Value::Null
        }
    }
    fn answer_json(request: &str, answer: &Answer) -> Value {
        let mut out = json!({"request": request, "approved": answer.approved});
        if let Some(reason) = &answer.reason { out["reason"] = json!(reason); }
        if let Some(package) = &answer.decided_by { out["decidedBy"] = json!(package); }
        out
    }
    fn question_json(request: &str, response: &Value, by: Option<String>) -> Value {
        let mut out = json!({"request": request, "response": response});
        if let Some(package) = by { out["decidedBy"] = json!(package); }
        out
    }

    fn replay(script: &Value, steps: &[Value]) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
        let table = &script["tasks"];
        // One ledger for the replay: a held claim (an answer in flight) borrows it for the whole run.
        let ledger: &'static Responses = Box::leak(Box::new(Responses::default()));
        let mut state = Replay {
            table, owner: script["package"]["id"].as_str().unwrap().into(), name: script["package"]["name"].as_str().unwrap().into(), prefix: uuid::Uuid::new_v4().to_string(),
            book: PendingBook::default(), responses: ledger, agents: BTreeMap::new(), modes: BTreeMap::new(),
            granted: true, enabled: true, held: None, events: vec![], results: vec![], inputs: vec![],
        };
        for (task, row) in table.as_object().unwrap() { state.agents.insert(task.clone(), Agent { run: row["agentRun"].as_str().unwrap().into(), pending: BTreeSet::new(), alive: true }); }
        for step in steps {
            let task = step["task"].as_str().unwrap_or_default().to_owned();
            match step["op"].as_str().unwrap() {
                "open" => state.open(step),
                "wait" => {}
                "respond" => { let result = state.respond(step); state.results.push(result); }
                "user" => { let result = state.user(step); state.results.push(result); }
                "hold" => state.held = Some(ledger.claim(&task, step["request"].as_str().unwrap(), Ending::Gone).unwrap()),
                "release" => state.held = None,
                "withdraw" => {
                    let request = step["request"].as_str().unwrap();
                    state.agents.get_mut(&task).unwrap().pending.remove(request);
                    let change = state.book.end(&task, request, Ending::Withdrawn { current_mode: Some(state.facts(&task).mode) });
                    state.push(change);
                }
                "mode" => { state.modes.insert(task, step["mode"].as_str().unwrap().into()); }
                "revoke" => state.granted = false,
                "grant" => state.granted = true,
                "disable" => state.enabled = false,
                "enable" => state.enabled = true,
                "runEnded" => {
                    let changes = state.book.end_run(&task, step["run"].as_str());
                    for change in changes { state.push(Some(change)); }
                    let agent = state.agents.get_mut(&task).unwrap();
                    agent.pending.clear();
                    agent.run = step["next"].as_str().unwrap().into();
                }
                "taskRemoved" => {
                    let changes = state.book.forget_task(&task);
                    for change in changes { state.push(Some(change)); }
                    state.agents.get_mut(&task).unwrap().alive = false;
                }
                other => panic!("unknown op {other}"),
            }
        }
        for task in table.as_object().unwrap().keys() { payloads::forget_run(&state.run_key(task)); }
        (state.events, state.results, state.inputs)
    }

    #[test]
    fn every_shared_scenario_replays_to_the_recorded_events_results_and_inputs() {
        let script: Value = serde_json::from_str(SCENARIOS).unwrap();
        assert_eq!(script["_fixture"]["provenance"], "synthetic");
        for scenario in script["scenarios"].as_array().unwrap() {
            let id = scenario["id"].as_str().unwrap();
            let (events, results, inputs) = replay(&script, scenario["steps"].as_array().unwrap());
            let expect = &scenario["expect"];
            assert_eq!(Value::Array(events), expect["events"], "{id}: events");
            assert_eq!(Value::Array(results), expect["results"], "{id}: results");
            assert_eq!(Value::Array(inputs), expect["inputs"], "{id}: inputs");
        }
    }

    #[test]
    fn the_responder_fixture_declares_decide_and_observes_the_pending_events() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let permissions: Vec<&str> = manifest["permissions"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(permissions.contains(&DECIDE) && permissions.contains(&"harness.hooks.observe"));
        let declarations = crate::extensions::runtime_hook_registration::check(&manifest).unwrap();
        assert!(["approval.pending", "question.pending"].iter().all(|event| declarations.iter().any(|declaration| declaration.event == *event)));
    }

    #[test]
    fn parsing_is_strict() {
        let ok = |answer: Value| parse(&json!({"taskId": "t", "requestId": "r:1", "answer": answer}));
        assert_eq!(ok(json!({"approved": false, "reason": "no"})).unwrap().reply, Reply::Approval { approved: false, reason: Some("no".into()) });
        assert!(matches!(ok(json!({"answers": {"a": "x"}})).unwrap().reply, Reply::Answers(_)));
        assert_eq!(ok(json!({"approved": true, "input": {}})).unwrap_err().code, "InvalidShape", "no rewrite after the budget");
        assert_eq!(ok(json!({"approved": "yes"})).unwrap_err().path, "$.answer.approved");
        assert_eq!(ok(json!({"approved": false, "reason": "x".repeat(4_097)})).unwrap_err().code, "LimitExceeded");
        assert_eq!(ok(json!({"approved": false, "reason": "  "})).unwrap_err().code, "InvalidShape");
        assert_eq!(ok(json!({"answers": {"a": "x".repeat(ANSWERS_BYTES)}})).unwrap_err().code, "LimitExceeded");
        assert_eq!(ok(json!({})).unwrap_err().path, "$.answer");
        assert_eq!(parse(&json!({"taskId": "t", "requestId": "", "answer": {"approved": true}})).unwrap_err().path, "$.requestId");
        assert_eq!(parse(&json!({"taskId": "t", "requestId": "r", "answer": {"approved": true}, "extra": 1})).unwrap_err().code, "InvalidShape");
    }

    #[test]
    fn answers_become_the_response_the_window_would_send() {
        let questions = vec![json!({"id": "db"}), json!({"id": "name"})];
        let answers = |value: Value| value.as_object().unwrap().clone();
        assert_eq!(response_for(Form::Questions, &questions, &answers(json!({"db": "Postgres", "name": ["atlas"]}))).unwrap(), json!({"answers": {"db": ["Postgres"], "name": ["atlas"]}}));
        assert_eq!(response_for(Form::Questions, &questions, &answers(json!({}))).unwrap(), json!({"answers": {}}), "none skips them");
        assert_eq!(response_for(Form::Questions, &questions, &answers(json!({"db": "Postgres"}))).unwrap_err().code, "InvalidShape", "all or none");
        assert_eq!(response_for(Form::Questions, &questions, &answers(json!({"other": "x", "db": "y"}))).unwrap_err().path, "$.answer.answers.other");
        assert_eq!(response_for(Form::Fields, &questions, &answers(json!({"db": "Postgres"}))).unwrap(), json!({"action": "accept", "content": {"db": "Postgres"}}));
        assert_eq!(response_for(Form::Url, &[json!({"id": "url"})], &answers(json!({"url": false}))).unwrap(), json!({"action": "decline"}));
        assert_eq!(response_for(Form::Other, &[json!({"id": "q0"})], &answers(json!({"q0": "x"}))).unwrap_err().code, "UnsupportedCapability");
    }

    #[test]
    fn one_answer_is_in_flight_at_a_time_and_only_an_armed_one_turns_a_withdrawal_into_its_answer() {
        let ledger = Responses::default();
        let first = ledger.claim("t", "r:1", approval_ending(false)).unwrap();
        assert_eq!(ledger.claim("t", "r:1", approval_ending(true)).err(), Some("StaleContext"));
        assert_eq!(ledger.withdrawn("t", "r:1"), None, "not sent yet: a withdrawal is the harness's");
        first.arm();
        assert_eq!(ledger.withdrawn("t", "r:1"), Some(approval_ending(false)));
        drop(first);
        assert!(ledger.claim("t", "r:1", approval_ending(true)).is_ok(), "a claim ends with its answer");
    }

    #[tokio::test(start_paused = true)]
    async fn a_late_deny_reaches_the_adapter_with_its_reason_and_package() {
        let run = format!("late-{}", uuid::Uuid::new_v4());
        let book = PendingBook::default();
        payloads::open_approval(&run, "7", None, payloads::builtin_support("claude"));
        let facts = Facts { project: "A".into(), harness: "claude".into(), mode: "ask".into(), run: "task".into() };
        book.open(Kind::Approval, &Request { task: "t".into(), request: "r1:7".into(), text: "Allow Bash?".into(), data: json!({"name": "Bash"}), at: "x".into(), ..Request::default() }, facts);
        // Past every hook budget: still open, still answerable.
        tokio::time::advance(std::time::Duration::from_secs(2)).await;
        let steer = attribute_approval(&book, &run, "t", "r1:7", "7", "sample.late-responder", "Late responder", "Bash", false, Some("Outside the project."), true).unwrap();
        assert_eq!(steer, None, "Claude Code takes the reason in the answer itself");
        let taken = payloads::take(&run, "7", false);
        assert_eq!((taken.reason.as_deref(), taken.decided_by.as_deref()), (Some("Outside the project."), Some("sample.late-responder")));
        let resolved = book.end("t", "r1:7", approval_ending(false)).unwrap().payload;
        assert_eq!(resolved["by"], json!({"package": "sample.late-responder"}));
        assert_eq!(resolved["reason"], "Outside the project.");
        // A revoke under the lock sends nothing and leaves nothing attributed.
        assert_eq!(attribute_approval(&book, &run, "t", "r1:7", "7", "sample.late-responder", "Late responder", "Bash", true, None, false), Err("PermissionDenied"));
        payloads::forget_run(&run);
    }

    #[test]
    fn sending_errors_map_to_frozen_codes() {
        assert_eq!(code_of("This approval is no longer pending."), "StaleContext");
        assert_eq!(code_of("This question belongs to an earlier run."), "StaleContext");
        assert_eq!(code_of("This agent is no longer running."), "StaleContext");
        assert_eq!(code_of("Answer every question or cancel the request"), "InvalidShape");
        assert_eq!(code_of("PermissionDenied"), "PermissionDenied");
        assert_eq!(code_of("The agent did not acknowledge the answer. Try again."), "HostUnavailable");
        assert_eq!(line(Kind::Approval, "Bash", "Late responder", false, Some("Outside.")), "Bash denied through Late responder. Outside.");
    }
}
