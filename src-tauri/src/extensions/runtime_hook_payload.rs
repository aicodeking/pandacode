//! What a hook sees of a tool call, and how an answer travels back to the harness (runtime phase R5, slice R0502).
//!
//! Three things live here, all keyed by the run (the task's session id), so two runs never share a call or a request:
//!
//! * **The complete input.** Every adapter hands the complete input value of the harness frame to [`record`] before
//!   its display preview is cut (`ToolActivity.input` stays a preview for the interface). The serialization is the
//!   compact JSON of that value. A payload carries it structured (`inputComplete: true`, `input`) when it is at most
//!   1 MiB and fits the hook frame budget (2 MiB, depth 64, 131,072 nodes, envelope included); otherwise it carries
//!   `inputComplete: false` and `inputPreview`, the first 1 MiB of the serialization cut back to a code point boundary
//!   and, when escaping would push the frame over 2 MiB, cut further. The rest is read with [`read`]
//!   (`panda.hooks.input`): 256 KiB per chunk, UTF-8 byte cursors on code point boundaries.
//! * **The call lifetime.** A call is live from its first record until it is finished and no hook holds it
//!   ([`retain`] / [`release`]); afterwards a read answers `StaleContext`, an unknown call `NotFound`. The
//!   serialization is fixed once a payload was built or a chunk read.
//! * **Answers.** A permission request is opened with the call it belongs to and what its source can carry
//!   ([`Support`]: where a deny reason goes, whether a rewritten input runs). An answer with a reason, a rewritten input
//!   and the deciding package is attached to it ([`attach`]) before `RunInput::Approval` is sent; the adapter claims it
//!   once ([`take`]) and renders it for its protocol. A rewrite the source cannot run is refused at [`attach`] with
//!   `UnsupportedCapability`, so the old input is never approved in its place and the normal prompt stays.
//!
//! The details travel beside `RunInput` (keyed by run and request id, claimed once, dropped when the run ends) rather
//! than inside it, like `providers::set_decline_reason`: every existing answer path keeps its exact shape and a user's
//! own answer reads exactly as before.
// The hook dispatcher, `hooks.input` routing and the normalized task events (later R5 slices) are the callers of the
// payload, reader and event builders; until they land only the tests use them.
#![cfg_attr(not(test), allow(dead_code))]
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, sync::{Arc, Mutex, MutexGuard}};

/// `schemaVersion` of hook payloads and `hooks.input` results.
pub(crate) const SCHEMA_VERSION: u64 = 1;
/// Largest serialized input that travels structured in a payload.
pub(crate) const COMPLETE_BYTES: usize = 1 << 20;
/// Largest `inputPreview`, in UTF-8 bytes of the serialization.
pub(crate) const PREVIEW_BYTES: usize = 1 << 20;
/// Largest `text` of one `hooks.input` chunk.
pub(crate) const CHUNK_BYTES: usize = 256 << 10;
/// Budget of one hook frame (payload or `hooks.input` result), counted on the whole compact envelope.
pub(crate) const FRAME_BYTES: usize = 2 << 20;
pub(crate) const FRAME_DEPTH: usize = 64;
pub(crate) const FRAME_NODES: usize = 131_072;
/// Room kept in a hook frame for the envelope and the `HookCallBase` fields around the input.
pub(crate) const ENVELOPE_BYTES: usize = 64 << 10;
const ENVELOPE_DEPTH: usize = 4;
const ENVELOPE_NODES: usize = 1_024;
/// Longest deny or approval reason carried to a harness.
pub(crate) const REASON_BYTES: usize = 4_096;
/// Calls one run keeps (live ones and the ended ones that still answer `StaleContext`); the oldest unheld go first.
const CALLS_PER_RUN: usize = 256;
/// Serialized bytes one run keeps for live calls; beyond it the oldest unheld calls are dropped.
const RUN_BYTES: usize = 64 << 20;
/// Open requests one run keeps.
const REQUESTS_PER_RUN: usize = 64;
/// Calls and live bytes kept over all runs (a run that never reports its end cannot grow the store without bound).
const CALLS_TOTAL: usize = 4_096;
const BYTES_TOTAL: usize = 256 << 20;

/// Whether built-in harness runs record complete inputs: on while any enabled package holds a hook (the hook
/// registration slice turns it on and off). Package provider runs always record. Off, a built-in run does exactly
/// what it did before this slice.
static OBSERVED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub(crate) fn observed() -> bool { OBSERVED.load(std::sync::atomic::Ordering::Acquire) }
pub(crate) fn set_observed(on: bool) { OBSERVED.store(on, std::sync::atomic::Ordering::Release); }

// ---------------------------------------------------------------------------------------------------------------
// Frame budget and the payload's input fields
// ---------------------------------------------------------------------------------------------------------------

/// Depth and node count of a JSON value (a scalar is depth 1 and one node).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Shape { pub depth: usize, pub nodes: usize }
pub(crate) fn shape(value: &Value) -> Shape {
    match value {
        Value::Array(items) => items.iter().map(shape).fold(Shape { depth: 1, nodes: 1 }, |acc, child| Shape { depth: acc.depth.max(child.depth + 1), nodes: acc.nodes + child.nodes }),
        Value::Object(fields) => fields.values().map(shape).fold(Shape { depth: 1, nodes: 1 }, |acc, child| Shape { depth: acc.depth.max(child.depth + 1), nodes: acc.nodes + child.nodes }),
        _ => Shape { depth: 1, nodes: 1 },
    }
}

/// Whether a whole hook frame (payload or `hooks.input` result, with its envelope) fits the endpoint budget.
pub(crate) fn frame_check(frame: &Value) -> Result<(), &'static str> {
    let measured = shape(frame);
    if measured.depth > FRAME_DEPTH || measured.nodes > FRAME_NODES { return Err("LimitExceeded"); }
    if serde_json::to_vec(frame).map_or(usize::MAX, |bytes| bytes.len()) > FRAME_BYTES { return Err("LimitExceeded"); }
    Ok(())
}

/// Bytes a character takes once written inside a JSON string (serde_json's escaping).
fn escaped(character: char) -> usize {
    match character {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
        other if (other as u32) < 0x20 => 6,
        other => other.len_utf8(),
    }
}

/// The preview of a serialization: at most [`PREVIEW_BYTES`], cut back to a code point boundary, and short enough
/// that written as a JSON string inside a payload it leaves the frame within [`FRAME_BYTES`].
pub(crate) fn preview(text: &str) -> &str {
    let budget = FRAME_BYTES - ENVELOPE_BYTES;
    let (mut end, mut written) = (0, 2);
    for (index, character) in text.char_indices() {
        let width = character.len_utf8();
        if index + width > PREVIEW_BYTES { break; }
        let cost = escaped(character);
        if written + cost > budget { break; }
        written += cost;
        end = index + width;
    }
    &text[..end]
}

/// Whether a serialized input travels structured: small enough, and its shape leaves room for the envelope.
fn travels_complete(bytes: usize, measured: Shape) -> bool {
    bytes <= COMPLETE_BYTES && measured.depth + ENVELOPE_DEPTH <= FRAME_DEPTH && measured.nodes + ENVELOPE_NODES <= FRAME_NODES
}

/// The input fields of a `HookCall`: `inputBytes`, then either `inputComplete: true` with `input`, or
/// `inputComplete: false` with `inputPreview`.
pub(crate) fn input_fields(input: &Value) -> Map<String, Value> {
    let text = serde_json::to_string(input).unwrap_or_else(|_| "null".into());
    fields(input, &text)
}
fn fields(input: &Value, text: &str) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("inputBytes".into(), json!(text.len()));
    if travels_complete(text.len(), shape(input)) {
        out.insert("inputComplete".into(), json!(true));
        out.insert("input".into(), input.clone());
    } else {
        out.insert("inputComplete".into(), json!(false));
        out.insert("inputPreview".into(), json!(preview(text)));
    }
    out
}
fn fields_from_text(text: &str) -> Map<String, Value> {
    // A large serialization never needs parsing: it travels as a preview whatever its shape.
    if text.len() > COMPLETE_BYTES {
        let mut out = Map::new();
        out.insert("inputBytes".into(), json!(text.len()));
        out.insert("inputComplete".into(), json!(false));
        out.insert("inputPreview".into(), json!(preview(text)));
        return out;
    }
    fields(&serde_json::from_str(text).unwrap_or(Value::Null), text)
}

// ---------------------------------------------------------------------------------------------------------------
// Calls of a run
// ---------------------------------------------------------------------------------------------------------------

struct Call {
    run: String,
    harness: String,
    project: Option<String>,
    /// The serialization; `None` once the call ended (reads answer `StaleContext`).
    text: Option<Arc<str>>,
    sealed: bool,
    finished: bool,
    holds: u32,
    order: u64,
}

/// What a source can carry back for one permission request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DenyReason {
    /// In the answer itself (Claude Code `message`, a package provider's `reason`, ACP `_meta.pandacode.reason`).
    Answer,
    /// As a steering message right after the answer, sent by the answering side (`RunInput::Steer`).
    Steer,
    /// Nowhere: the harness gets the bare decision.
    None,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Support { pub deny_reason: DenyReason, pub rewrite_input: bool }
impl Support {
    pub(crate) const BARE: Support = Support { deny_reason: DenyReason::None, rewrite_input: false };
    /// `HookCall.can` for a call that came with this permission request.
    pub(crate) fn can(&self) -> Vec<&'static str> {
        let mut can = vec!["approve", "deny", "ask"];
        if self.rewrite_input { can.push("rewriteInput"); }
        can
    }
    /// The `denyReason` reported by `panda.harnesses.list`, with the rewrite capability beside it.
    pub(crate) fn json(&self) -> Value {
        json!({"denyReason": match self.deny_reason { DenyReason::Answer => "answer", DenyReason::Steer => "steer", DenyReason::None => "none" }, "rewriteInput": self.rewrite_input})
    }
}

/// What each built-in harness's permission answer can carry (PLAN-contracts, "What must change natively").
pub(crate) fn builtin_support(provider: &str) -> Support {
    match provider {
        // Claude Code's control response takes `message` and `updatedInput` (every harness on its stream protocol).
        "claude" | "glm" | "mimo" | "alibaba" => Support { deny_reason: DenyReason::Answer, rewrite_input: true },
        // The bridge's channel does not carry a reason yet; these harnesses take a live steer right after the answer.
        "pi" | "omp" | "codex" | "opencode" | "devin" => Support { deny_reason: DenyReason::Steer, rewrite_input: false },
        _ => Support::BARE,
    }
}

/// What a declared ACP harness (or any ACP agent) said it reads in a permission result, from its `initialize`
/// result: `agentCapabilities._meta.pandacode.permissionAnswer = { reason?: true, updatedInput?: true }`.
pub(crate) fn acp_support(initialize_result: &Value) -> Support {
    let declared = &initialize_result["agentCapabilities"]["_meta"]["pandacode"]["permissionAnswer"];
    Support {
        deny_reason: if declared["reason"] == true { DenyReason::Answer } else { DenyReason::None },
        rewrite_input: declared["updatedInput"] == true,
    }
}

/// What a package provider said one approval can take: the reason travels in `ProviderInput` unless its `approval`
/// event says otherwise (`denyReason`, set by a declared ACP transport from what the agent declared); a rewritten
/// input only when the event lists `"rewriteInput"` in `can`.
pub(crate) fn provider_support(event: &Value) -> Support {
    let rewrite = event["can"].as_array().is_some_and(|can| can.iter().any(|entry| entry == "rewriteInput"));
    let deny_reason = match event["denyReason"].as_str() { Some("none") => DenyReason::None, Some("steer") => DenyReason::Steer, _ => DenyReason::Answer };
    Support { deny_reason, rewrite_input: rewrite }
}

/// A normalized answer to a permission request.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Answer {
    pub approved: bool,
    pub reason: Option<String>,
    /// The arguments to run instead of the harness's own (only with `approved`).
    pub input: Option<Value>,
    /// The package that decided, for the label and the store; `None` for the user.
    pub decided_by: Option<String>,
}
impl Answer {
    pub(crate) fn plain(approved: bool) -> Self { Self { approved, reason: None, input: None, decided_by: None } }
    /// Parses `{ approved, reason?, input?, decidedBy? }` strictly.
    pub(crate) fn parse(value: &Value) -> Result<Self, String> {
        let fields = value.as_object().ok_or("InvalidShape: an answer is an object")?;
        if fields.keys().any(|key| !["approved", "reason", "input", "decidedBy"].contains(&key.as_str())) { return Err("InvalidShape: an answer has an unknown field".into()); }
        let approved = fields.get("approved").and_then(Value::as_bool).ok_or("InvalidShape: approved must be true or false")?;
        let text = |name: &str| -> Result<Option<String>, String> {
            match fields.get(name) { None | Some(Value::Null) => Ok(None), Some(Value::String(text)) => Ok(Some(text.clone())), Some(_) => Err(format!("InvalidShape: {name} must be text")) }
        };
        let answer = Self { approved, reason: text("reason")?, input: fields.get("input").cloned(), decided_by: text("decidedBy")? };
        answer.validate()?;
        Ok(answer)
    }
    pub(crate) fn validate(&self) -> Result<(), String> {
        if let Some(reason) = &self.reason {
            if reason.trim().is_empty() || reason.contains('\0') { return Err("InvalidShape: a reason is non-empty text".into()); }
            if reason.len() > REASON_BYTES { return Err("LimitExceeded: a reason is at most 4,096 bytes".into()); }
        }
        if let Some(input) = &self.input {
            if !self.approved { return Err("InvalidShape: a rewritten input comes only with an approval".into()); }
            if serde_json::to_vec(input).map_or(usize::MAX, |bytes| bytes.len()) > COMPLETE_BYTES { return Err("LimitExceeded: a rewritten input is at most 1 MiB".into()); }
        }
        if let Some(package) = &self.decided_by { if !package_id(package) { return Err("InvalidShape: decidedBy is a package id".into()); } }
        Ok(())
    }
}
/// `publisher.name`, as the manifest schema's `id` without a local part.
fn package_id(text: &str) -> bool {
    let part = |part: &str| part.chars().next().is_some_and(|first| first.is_ascii_lowercase()) && part.chars().all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-');
    text.len() <= 160 && text.split_once('.').is_some_and(|(publisher, name)| part(publisher) && part(name))
}

enum Pending {
    Approval { call: Option<String>, support: Support, answer: Option<Answer> },
    Question { decided_by: Option<String> },
}
struct Request { pending: Pending, order: u64 }

#[derive(Default)]
struct Book {
    calls: BTreeMap<String, Call>,
    by_harness: BTreeMap<(String, String), String>,
    requests: BTreeMap<(String, String), Request>,
    serial: u64,
}
static BOOK: Mutex<Option<Book>> = Mutex::new(None);
fn with<T>(change: impl FnOnce(&mut Book) -> T) -> T {
    let mut guard: MutexGuard<'_, Option<Book>> = BOOK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    change(guard.get_or_insert_with(Book::default))
}

impl Book {
    fn next(&mut self) -> u64 { self.serial += 1; self.serial }
    /// Keeps one run, then all runs, within their call count and byte bounds, dropping the oldest unheld calls first
    /// (ended ones first).
    fn bound(&mut self, run: &str) {
        for scoped in [true, false] {
            loop {
                let owned: Vec<(&String, &Call)> = self.calls.iter().filter(|(_, call)| !scoped || call.run == run).collect();
                let bytes: usize = owned.iter().filter_map(|(_, call)| call.text.as_ref().map(|text| text.len())).sum();
                let (calls, limit) = if scoped { (CALLS_PER_RUN, RUN_BYTES) } else { (CALLS_TOTAL, BYTES_TOTAL) };
                if owned.len() <= calls && bytes <= limit { break; }
                let victim = owned.iter().filter(|(_, call)| call.holds == 0).min_by_key(|(_, call)| (call.text.is_some(), call.order)).map(|(id, _)| (*id).clone());
                let Some(victim) = victim else { break };
                if let Some(call) = self.calls.remove(&victim) { self.by_harness.remove(&(call.run, call.harness)); }
            }
        }
    }
}

/// A recorded call: the host's call id (unique across runs) and the payload's input fields.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Recorded { pub call_id: String, pub fields: Map<String, Value> }

fn bounded_id(text: &str) -> Result<(), &'static str> {
    if text.is_empty() || text.len() > 256 || text.chars().any(char::is_control) { Err("InvalidShape") } else { Ok(()) }
}

/// Records the complete input of a harness call (`harness_call` is the harness's own id, which may repeat across
/// runs). A later record of a call whose serialization is not yet fixed replaces it (a harness that streams its
/// arguments); once fixed, or after the call ended, the first one stays.
pub(crate) fn record(run: &str, project: Option<&str>, harness_call: &str, input: &Value) -> Result<Recorded, &'static str> {
    bounded_id(run)?;
    bounded_id(harness_call)?;
    let text: Arc<str> = serde_json::to_string(input).map_err(|_| "InvalidShape")?.into();
    with(|book| {
        let key = (run.to_owned(), harness_call.to_owned());
        if let Some(id) = book.by_harness.get(&key).cloned() {
            if let Some(call) = book.calls.get_mut(&id) {
                if call.sealed || call.finished || call.text.is_none() {
                    let fields = call.text.as_deref().map(fields_from_text).unwrap_or_default();
                    return Ok(Recorded { call_id: id, fields });
                }
                call.text = Some(text.clone());
                if project.is_some() { call.project = project.map(str::to_owned); }
                let fields = fields(input, &text);
                book.bound(run);
                return Ok(Recorded { call_id: id, fields });
            }
        }
        let id = format!("call-{}", uuid::Uuid::new_v4());
        let order = book.next();
        book.calls.insert(id.clone(), Call { run: run.to_owned(), harness: harness_call.to_owned(), project: project.map(str::to_owned), text: Some(text.clone()), sealed: false, finished: false, holds: 0, order });
        book.by_harness.insert(key, id.clone());
        let fields = fields(input, &text);
        book.bound(run);
        Ok(Recorded { call_id: id, fields })
    })
}

/// The host call id of a harness call of this run, while it is known.
pub(crate) fn call_id(run: &str, harness_call: &str) -> Option<String> {
    with(|book| book.by_harness.get(&(run.to_owned(), harness_call.to_owned())).cloned())
}
/// The run and project a call belongs to (for the per-project grant check of `hooks.input`).
pub(crate) fn scope(call_id: &str) -> Option<(String, Option<String>)> {
    with(|book| book.calls.get(call_id).map(|call| (call.run.clone(), call.project.clone())))
}

/// The payload's input fields of a live call, fixing its serialization (what a hook was shown is what it can read).
pub(crate) fn payload(call_id: &str) -> Result<Map<String, Value>, &'static str> {
    let text = with(|book| {
        let call = book.calls.get_mut(call_id).ok_or("NotFound")?;
        let text = call.text.clone().ok_or("StaleContext")?;
        call.sealed = true;
        Ok::<_, &'static str>(text)
    })?;
    Ok(fields_from_text(&text))
}

/// A `HookCall`: `base` (the `HookCallBase` facts the dispatcher owns) with `schemaVersion`, `callId` and the input
/// fields of the call, checked against the frame budget.
pub(crate) fn hook_call(base: &Value, call_id: &str) -> Result<Value, &'static str> {
    let mut call = base.as_object().cloned().ok_or("InvalidShape")?;
    call.insert("schemaVersion".into(), json!(SCHEMA_VERSION));
    call.insert("callId".into(), json!(call_id));
    for key in ["input", "inputPreview", "inputComplete", "inputBytes"] { call.remove(key); }
    call.extend(payload(call_id)?);
    let call = Value::Object(call);
    frame_check(&call)?;
    Ok(call)
}

/// The harness call reached its end (completed, failed, denied or cancelled). Its text is dropped as soon as no
/// hook holds it.
pub(crate) fn finish(run: &str, harness_call: &str) {
    with(|book| {
        let Some(id) = book.by_harness.get(&(run.to_owned(), harness_call.to_owned())).cloned() else { return };
        if let Some(call) = book.calls.get_mut(&id) {
            call.finished = true;
            if call.holds == 0 { call.text = None; }
        }
    });
}
/// A hook path holds a live call while its chain answers and its `tool.after` is delivered.
pub(crate) fn retain(call_id: &str) -> Result<(), &'static str> {
    with(|book| {
        let call = book.calls.get_mut(call_id).ok_or("NotFound")?;
        if call.text.is_none() { return Err("StaleContext"); }
        call.holds += 1;
        call.sealed = true;
        Ok(())
    })
}
pub(crate) fn release(call_id: &str) {
    with(|book| {
        if let Some(call) = book.calls.get_mut(call_id) {
            call.holds = call.holds.saturating_sub(1);
            if call.finished && call.holds == 0 { call.text = None; }
        }
    });
}

/// One chunk of a call's serialization (`panda.hooks.input`): `cursor` is a UTF-8 byte offset on a code point
/// boundary, at most `totalBytes`.
pub(crate) fn read(call_id: &str, cursor: u64) -> Result<Value, &'static str> {
    let text = with(|book| {
        let call = book.calls.get_mut(call_id).ok_or("NotFound")?;
        let text = call.text.clone().ok_or("StaleContext")?;
        call.sealed = true;
        Ok::<_, &'static str>(text)
    })?;
    let total = text.len();
    let cursor = usize::try_from(cursor).map_err(|_| "InvalidShape")?;
    if cursor > total || !text.is_char_boundary(cursor) { return Err("InvalidShape"); }
    let mut end = cursor.saturating_add(CHUNK_BYTES).min(total);
    while !text.is_char_boundary(end) { end -= 1; }
    Ok(json!({"schemaVersion":SCHEMA_VERSION,"text":&text[cursor..end],"cursor":cursor,"nextCursor":if end == total { Value::Null } else { json!(end) },"totalBytes":total}))
}

/// The `hooks.input` request of a service, `{ callId, cursor }`, strictly. The caller checks
/// `harness.hooks.observe` for the call's project ([`scope`]) before calling.
pub(crate) fn serve(params: &Value) -> Result<Value, String> {
    let fields = params.as_object().ok_or("InvalidShape")?;
    if fields.len() != 2 { return Err("InvalidShape".into()); }
    let call = fields.get("callId").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 256).ok_or("InvalidShape")?;
    let cursor = fields.get("cursor").and_then(Value::as_u64).ok_or("InvalidShape")?;
    read(call, cursor).map_err(str::to_owned)
}

// ---------------------------------------------------------------------------------------------------------------
// Requests and answers of a run
// ---------------------------------------------------------------------------------------------------------------

/// Opens a permission request of this run. `harness_call` pairs it with the call it asks about (the same `callId`
/// in `tool.before`, `approval.*` and `tool.after`); the host call id is returned when the call is known.
pub(crate) fn open_approval(run: &str, request_id: &str, harness_call: Option<&str>, support: Support) -> Option<String> {
    with(|book| {
        let call = harness_call.and_then(|harness| book.by_harness.get(&(run.to_owned(), harness.to_owned())).cloned());
        let order = book.next();
        book.requests.insert((run.to_owned(), request_id.to_owned()), Request { pending: Pending::Approval { call: call.clone(), support, answer: None }, order });
        bound_requests(book, run);
        call
    })
}
/// Opens a structured question of this run.
pub(crate) fn open_question(run: &str, request_id: &str) {
    with(|book| {
        let order = book.next();
        book.requests.insert((run.to_owned(), request_id.to_owned()), Request { pending: Pending::Question { decided_by: None }, order });
        bound_requests(book, run);
    });
}
fn bound_requests(book: &mut Book, run: &str) {
    while book.requests.keys().filter(|(owner, _)| owner == run).count() > REQUESTS_PER_RUN {
        let Some(oldest) = book.requests.iter().filter(|((owner, _), _)| owner == run).min_by_key(|(_, request)| request.order).map(|(key, _)| key.clone()) else { return };
        book.requests.remove(&oldest);
    }
}

/// What the request's source can carry, while it is open.
pub(crate) fn support(run: &str, request_id: &str) -> Option<Support> {
    with(|book| match book.requests.get(&(run.to_owned(), request_id.to_owned())).map(|request| &request.pending) { Some(Pending::Approval { support, .. }) => Some(*support), _ => None })
}
/// The host call id a request belongs to.
pub(crate) fn request_call(run: &str, request_id: &str) -> Option<String> {
    with(|book| match book.requests.get(&(run.to_owned(), request_id.to_owned())).map(|request| &request.pending) { Some(Pending::Approval { call, .. }) => call.clone(), _ => None })
}

/// Attaches the details of an answer before `RunInput::Approval` is sent. `StaleContext` when the request is not
/// open in this run; `UnsupportedCapability` (nothing attached, the request stays open, the old input is not
/// approved) when the answer rewrites the input of a source that cannot run new arguments.
pub(crate) fn attach(run: &str, request_id: &str, answer: Answer) -> Result<(), String> {
    answer.validate()?;
    with(|book| {
        let request = book.requests.get_mut(&(run.to_owned(), request_id.to_owned())).ok_or("StaleContext: the request is no longer open")?;
        let Pending::Approval { support, answer: slot, .. } = &mut request.pending else { return Err("InvalidShape: this request is a question".into()) };
        if answer.input.is_some() && !support.rewrite_input {
            return Err("UnsupportedCapability: this harness cannot run a rewritten input; the call was not approved".into());
        }
        *slot = Some(answer);
        Ok(())
    })
}
/// Attributes a question's answer to the package that gives it.
pub(crate) fn attach_question(run: &str, request_id: &str, package: &str) -> Result<(), String> {
    if !package_id(package) { return Err("InvalidShape: decidedBy is a package id".into()); }
    with(|book| {
        let request = book.requests.get_mut(&(run.to_owned(), request_id.to_owned())).ok_or("StaleContext: the request is no longer open")?;
        let Pending::Question { decided_by } = &mut request.pending else { return Err("InvalidShape: this request is an approval".into()) };
        *decided_by = Some(package.to_owned());
        Ok(())
    })
}

/// Claims the answer of a request as the adapter applies `approved`, and closes the request. The attached details
/// count only when they agree with the decision actually sent; otherwise the answer is the bare decision.
pub(crate) fn take(run: &str, request_id: &str, approved: bool) -> Answer {
    with(|book| match book.requests.remove(&(run.to_owned(), request_id.to_owned())).map(|request| request.pending) {
        Some(Pending::Approval { answer: Some(answer), .. }) if answer.approved == approved => answer,
        _ => Answer::plain(approved),
    })
}
/// Claims the package a question's answer is attributed to, and closes it.
pub(crate) fn take_question(run: &str, request_id: &str) -> Option<String> {
    with(|book| match book.requests.remove(&(run.to_owned(), request_id.to_owned())).map(|request| request.pending) {
        Some(Pending::Question { decided_by }) => decided_by,
        _ => None,
    })
}
/// The request was cancelled, expired or its run moved on: nothing is claimed.
pub(crate) fn close(run: &str, request_id: &str) { with(|book| { book.requests.remove(&(run.to_owned(), request_id.to_owned())); }); }

/// Everything of a run: its calls, their ids and its open requests (the run ended).
pub(crate) fn forget_run(run: &str) {
    with(|book| {
        book.calls.retain(|_, call| call.run != run);
        book.by_harness.retain(|(owner, _), _| owner != run);
        book.requests.retain(|(owner, _), _| owner != run);
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering an answer for each protocol, and the normalized events
// ---------------------------------------------------------------------------------------------------------------

/// `ProviderInput` of a package handler provider: `{ kind: 'approval', approved, reason?, input?, decidedBy? }`.
pub(crate) fn provider_input(answer: &Answer) -> Value {
    let mut value = json!({"kind":"approval","approved":answer.approved});
    if let Some(reason) = &answer.reason { value["reason"] = json!(reason); }
    if let Some(input) = &answer.input { value["input"] = input.clone(); }
    if let Some(package) = &answer.decided_by { value["decidedBy"] = json!(package); }
    value
}
/// Reads a `ProviderInput` approval back into an answer (what a launch transport receives from core).
pub(crate) fn answer_of(provider_input: &Value) -> Answer {
    Answer {
        approved: provider_input["approved"] == true,
        reason: provider_input["reason"].as_str().map(str::to_owned),
        input: provider_input.get("input").filter(|_| provider_input["approved"] == true).cloned(),
        decided_by: provider_input["decidedBy"].as_str().map(str::to_owned),
    }
}

/// The `_meta.pandacode` of an ACP permission result, with only what the agent declared it reads.
pub(crate) fn acp_meta(answer: &Answer, support: Support) -> Option<Value> {
    let mut meta = Map::new();
    if support.deny_reason == DenyReason::Answer {
        if let Some(reason) = &answer.reason { meta.insert("reason".into(), json!(reason)); }
        if let Some(package) = &answer.decided_by { meta.insert("decidedBy".into(), json!(package)); }
    }
    if support.rewrite_input { if let Some(input) = &answer.input { meta.insert("updatedInput".into(), input.clone()); } }
    (!meta.is_empty()).then(|| json!({"pandacode": meta}))
}
/// The option an ACP permission answer selects: allow once (or always) when approved, reject once (or always).
pub(crate) fn acp_choice(options: &[Value], approved: bool) -> Option<&Value> {
    let (wanted, fallback) = if approved { ("allow_once", "allow_always") } else { ("reject_once", "reject_always") };
    options.iter().find(|option| option["kind"] == wanted).or_else(|| options.iter().find(|option| option["kind"] == fallback))
}
/// The `result` of an ACP `session/request_permission` answer.
pub(crate) fn acp_permission_result(options: &[Value], answer: &Answer, support: Support) -> Value {
    let mut result = match acp_choice(options, answer.approved) {
        Some(option) => json!({"outcome":{"outcome":"selected","optionId":option["optionId"]}}),
        None => json!({"outcome":{"outcome":"cancelled"}}),
    };
    if result["outcome"]["outcome"] == "selected" { if let Some(meta) = acp_meta(answer, support) { result["_meta"] = meta; } }
    result
}
/// The `response` of a Claude Code `can_use_tool` answer: allow with the rewritten (or original) input, or deny with
/// the reason (or `decline`, the text the host would send without one).
pub(crate) fn claude_permission_response(original: &Value, answer: &Answer, decline: &str) -> Value {
    if answer.approved { json!({"behavior":"allow","updatedInput":answer.input.clone().unwrap_or_else(|| original.clone())}) }
    else { json!({"behavior":"deny","message":answer.reason.as_deref().unwrap_or(decline)}) }
}

/// Whether an ACP `session/request_permission` is a structured question rather than a tool approval: more than one
/// allow option, or answer ids of the `q<N>_opt_<M>` form (the rule of the built-in ACP harnesses).
pub(crate) fn acp_structured_question(request: &Value) -> bool {
    let options = request["params"]["options"].as_array().map(Vec::as_slice).unwrap_or_default();
    options.iter().filter(|option| option["kind"] == "allow_once").count() > 1
        || options.iter().any(|option| option["optionId"].as_str().and_then(|id| id.strip_prefix('q')).and_then(|id| id.split_once("_opt_")).is_some_and(|(number, _)| number.parse::<usize>().is_ok()))
}
/// The core `questions` list of an ACP structured question: one question whose options are the allow options.
pub(crate) fn acp_question(request: &Value) -> Option<Value> {
    if !acp_structured_question(request) { return None; }
    let params = &request["params"];
    let title: String = params["toolCall"]["title"].as_str().filter(|title| !title.trim().is_empty()).unwrap_or("The agent asks a question.").chars().take(4_000).collect();
    let options: Vec<Value> = params["options"].as_array()?.iter().filter(|option| option["kind"] == "allow_once")
        .filter_map(|option| option["name"].as_str().or_else(|| option["optionId"].as_str()).map(|label| json!({"label":label.chars().take(200).collect::<String>(),"description":""}))).take(20).collect();
    if options.is_empty() { return None; }
    Some(json!([{"id":"q0","header":"","question":title,"isOther":false,"isSecret":false,"options":options}]))
}
/// The `result` of an ACP structured question answered with core's response `{ answers: { q0: { answers: [label] } } }`:
/// the matching option is selected; an empty or unmatched answer cancels.
pub(crate) fn acp_question_result(request: &Value, response: &Value) -> Value {
    let label = response["answers"]["q0"]["answers"][0].as_str();
    let options = request["params"]["options"].as_array().map(Vec::as_slice).unwrap_or_default();
    match label.and_then(|label| options.iter().filter(|option| option["kind"] == "allow_once").find(|option| option["name"].as_str().or_else(|| option["optionId"].as_str()) == Some(label))) {
        Some(option) => json!({"outcome":{"outcome":"selected","optionId":option["optionId"]}}),
        None => json!({"outcome":{"outcome":"cancelled"}}),
    }
}

/// The harness's own call id and complete input in a permission request frame of any built-in protocol: Claude
/// Code `can_use_tool`, ACP `session/request_permission`, a PandaCode-served tool call, Codex and ZCode requests.
pub(crate) fn frame_call(frame: &Value) -> Option<(String, Value)> {
    let request = &frame["request"];
    if request["subtype"] == "can_use_tool" {
        let id = request["tool_use_id"].as_str().or_else(|| frame["request_id"].as_str())?;
        return Some((id.to_owned(), request["input"].clone()));
    }
    let params = &frame["params"];
    if let Some(tool) = params["toolCall"].as_object() {
        let id = tool.get("toolCallId").and_then(Value::as_str)?;
        return Some((id.to_owned(), tool.get("rawInput").cloned().unwrap_or(Value::Null)));
    }
    if let Some(id) = params["callId"].as_str() { return Some((id.to_owned(), params["arguments"].clone())); }
    if let Some(id) = params["itemId"].as_str() { return Some((id.to_owned(), params.clone())); }
    let id = params["toolUseId"].as_str().or_else(|| params["tool_use_id"].as_str())?;
    Some((id.to_owned(), params["input"].clone()))
}

/// `by` of `approval.resolved` and `question.resolved`.
fn by(decided_by: Option<&str>, cancelled: bool) -> Value {
    match (cancelled, decided_by) { (true, _) => json!("cancelled"), (false, Some(package)) => json!({"package":package}), (false, None) => json!("user") }
}
/// The normalized `approval.resolved` event of a request.
pub(crate) fn approval_resolved(task_id: &str, request_id: &str, call_id: Option<&str>, answer: Option<&Answer>) -> Value {
    let mut value = json!({"requestId":request_id,"taskId":task_id,"approved":answer.is_some_and(|answer| answer.approved),"by":by(answer.and_then(|answer| answer.decided_by.as_deref()), answer.is_none())});
    if let Some(call) = call_id { value["callId"] = json!(call); }
    if let Some(reason) = answer.and_then(|answer| answer.reason.as_deref()) { value["reason"] = json!(reason); }
    value
}
/// The normalized `question.pending` event, from core's normalized `input_request` data (`kind: "questions"`).
pub(crate) fn question_pending(task_id: &str, project_id: &str, harness: &str, request_id: &str, data: &Value, at: &str) -> Option<Value> {
    if data["kind"] != "questions" { return None; }
    let questions: Vec<Value> = data["questions"].as_array()?.iter().map(|question| {
        let mut out = json!({"id":question["id"],"question":question["question"],"multiple":false,"secret":question["isSecret"] == true});
        if question["header"].as_str().is_some_and(|header| !header.is_empty()) { out["header"] = question["header"].clone(); }
        if let Some(options) = question["options"].as_array() {
            out["options"] = Value::Array(options.iter().map(|option| {
                let mut entry = json!({"label":option["label"]});
                if option["description"].as_str().is_some_and(|description| !description.is_empty()) { entry["description"] = option["description"].clone(); }
                entry
            }).collect());
        }
        out
    }).collect();
    Some(json!({"requestId":request_id,"taskId":task_id,"projectId":project_id,"harness":harness,"questions":questions,"at":at}))
}
/// The normalized `question.resolved` event; `answers` is core's validated response, `None` when cancelled.
pub(crate) fn question_resolved(task_id: &str, request_id: &str, decided_by: Option<&str>, answers: Option<&Value>) -> Value {
    let mut value = json!({"requestId":request_id,"taskId":task_id,"by":by(decided_by, answers.is_none())});
    if let Some(answers) = answers { value["answers"] = answers["answers"].clone(); }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-payload/answers.json");

    fn run(name: &str) -> String { format!("{name}-{}", uuid::Uuid::new_v4()) }
    /// A tool input whose serialization is about `bytes` long: one shell command padded with text.
    fn large_input(bytes: usize) -> Value { json!({"command":"rm -rf /tmp/fixture","padding":"é".repeat(bytes / 2)}) }

    #[test]
    fn a_small_input_travels_complete_and_structured_while_the_display_preview_stays_cut() {
        let run = run("complete");
        // Larger than the 4,096-byte display preview of ToolActivity, smaller than 1 MiB.
        let input = json!({"command":"echo fixture","content":"x".repeat(50_000)});
        let recorded = record(&run, Some("project-a"), "tool-1", &input).unwrap();
        assert_eq!(recorded.fields["inputComplete"], true);
        assert_eq!(recorded.fields["input"], input, "the hook sees the input exactly as the harness sent it");
        assert_eq!(recorded.fields["inputBytes"], serde_json::to_string(&input).unwrap().len());
        assert!(recorded.call_id.starts_with("call-"));
        assert_eq!(call_id(&run, "tool-1"), Some(recorded.call_id.clone()));
        assert_eq!(scope(&recorded.call_id), Some((run.clone(), Some("project-a".into()))));
        let call = hook_call(&json!({"taskId":run,"tool":{"kind":"shell","name":"Bash"},"input":"forged"}), &recorded.call_id).unwrap();
        assert_eq!(call["input"], input);
        assert_eq!(call["schemaVersion"], 1);
        frame_check(&json!({"kind":"hook","event":"tool.before","payload":call})).unwrap();
        forget_run(&run);
    }

    #[test]
    fn a_large_input_arrives_as_a_preview_and_is_read_completely_in_bounded_chunks() {
        let run = run("large");
        let input = large_input(3 << 20);
        let text = serde_json::to_string(&input).unwrap();
        assert!(text.len() > 3 << 20);
        let recorded = record(&run, None, "tool-big", &input).unwrap();
        let fields = &recorded.fields;
        assert_eq!(fields["inputComplete"], false);
        assert!(fields.get("input").is_none(), "a large input is never structured in the payload");
        let shown = fields["inputPreview"].as_str().unwrap();
        assert!(shown.len() <= PREVIEW_BYTES && text.starts_with(shown) && text.is_char_boundary(shown.len()));
        assert!(shown.len() > PREVIEW_BYTES - 4, "the preview is the first MiB, cut back only to a code point");
        let payload = hook_call(&json!({"taskId":run}), &recorded.call_id).unwrap();
        frame_check(&json!({"kind":"hook","payload":payload})).unwrap();
        // Read from the start, and continuing after the preview: both reassemble the whole serialization.
        for start in [0, shown.len()] {
            let (mut cursor, mut joined, mut chunks) = (start as u64, String::from(&text[..start]), 0);
            loop {
                let chunk = read(&recorded.call_id, cursor).unwrap();
                frame_check(&json!({"ok":true,"value":chunk})).unwrap();
                let piece = chunk["text"].as_str().unwrap();
                assert!(piece.len() <= CHUNK_BYTES && piece.len() > CHUNK_BYTES - 4 || chunk["nextCursor"].is_null());
                assert_eq!(chunk["totalBytes"], text.len());
                joined.push_str(piece);
                chunks += 1;
                match chunk["nextCursor"].as_u64() { Some(next) => cursor = next, None => break }
            }
            assert_eq!(joined, text);
            assert_eq!(serde_json::from_str::<Value>(&joined).unwrap(), input, "the concatenated chunks parse as the complete input");
            assert!(chunks >= (text.len() - start) / CHUNK_BYTES);
        }
        // A cursor inside a code point, beyond the end or after the call ended.
        let inside = text.char_indices().find(|(_, character)| character.len_utf8() > 1).unwrap().0 + 1;
        assert_eq!(read(&recorded.call_id, inside as u64), Err("InvalidShape"));
        assert_eq!(read(&recorded.call_id, text.len() as u64 + 1), Err("InvalidShape"));
        assert_eq!(read(&recorded.call_id, text.len() as u64).unwrap()["nextCursor"], Value::Null);
        assert_eq!(read("call-unknown", 0), Err("NotFound"));
        assert_eq!(serve(&json!({"callId":recorded.call_id,"cursor":0})).unwrap()["cursor"], 0);
        for bad in [json!({"callId":recorded.call_id}), json!({"callId":recorded.call_id,"cursor":-1}), json!({"callId":recorded.call_id,"cursor":0,"extra":1}), json!({"callId":1,"cursor":0})] { assert!(serve(&bad).is_err(), "{bad}"); }
        finish(&run, "tool-big");
        assert_eq!(read(&recorded.call_id, 0), Err("StaleContext"));
        forget_run(&run);
        assert_eq!(read(&recorded.call_id, 0), Err("NotFound"));
    }

    #[test]
    fn escaping_and_shape_never_push_a_payload_over_its_frame() {
        let run = run("frame");
        // Backslashes double when serialized and double again inside the payload's preview string.
        let input = json!({"path":"\\".repeat(1 << 20)});
        let recorded = record(&run, None, "tool-escape", &input).unwrap();
        assert_eq!(recorded.fields["inputComplete"], false);
        frame_check(&hook_call(&json!({"taskId":run}), &recorded.call_id).unwrap()).unwrap();
        // Under 1 MiB but too many nodes for a 131,072-node frame: a preview, not a structured input.
        let wide = Value::Array((0..140_000).map(|_| json!(0)).collect());
        assert!(serde_json::to_string(&wide).unwrap().len() < COMPLETE_BYTES);
        assert_eq!(input_fields(&wide)["inputComplete"], false);
        // Too deep for a depth-64 frame.
        let mut deep = json!(0);
        for _ in 0..70 { deep = json!([deep]); }
        assert_eq!(input_fields(&deep)["inputComplete"], false);
        // A frame over 2 MiB is refused.
        assert_eq!(frame_check(&json!({"text":"x".repeat(FRAME_BYTES)})), Err("LimitExceeded"));
        forget_run(&run);
    }

    #[test]
    fn the_serialization_is_fixed_once_seen_and_held_calls_outlive_their_end() {
        let run = run("lifetime");
        let first = record(&run, None, "tool-1", &json!({"command":"partial"})).unwrap();
        // Not yet seen by any hook: a fuller frame replaces it, under the same call id.
        let second = record(&run, None, "tool-1", &json!({"command":"complete"})).unwrap();
        assert_eq!(first.call_id, second.call_id);
        assert_eq!(payload(&first.call_id).unwrap()["input"]["command"], "complete");
        // Seen: fixed.
        let third = record(&run, None, "tool-1", &json!({"command":"changed later"})).unwrap();
        assert_eq!(third.fields["input"]["command"], "complete");
        retain(&first.call_id).unwrap();
        finish(&run, "tool-1");
        assert!(read(&first.call_id, 0).is_ok(), "a held call stays readable until its tool.after is delivered");
        release(&first.call_id);
        assert_eq!(read(&first.call_id, 0), Err("StaleContext"));
        assert_eq!(retain(&first.call_id), Err("StaleContext"));
        forget_run(&run);
    }

    #[test]
    fn harness_call_ids_repeat_across_runs_without_sharing_a_call_or_a_request() {
        let (one, two) = (run("identity-one"), run("identity-two"));
        let a = record(&one, None, "1", &json!({"command":"a"})).unwrap();
        let b = record(&two, None, "1", &json!({"command":"b"})).unwrap();
        assert_ne!(a.call_id, b.call_id);
        assert_eq!(open_approval(&one, "7", Some("1"), builtin_support("claude")), Some(a.call_id.clone()));
        assert_eq!(open_approval(&two, "7", Some("1"), builtin_support("claude")), Some(b.call_id.clone()));
        attach(&one, "7", Answer { approved: false, reason: Some("not here".into()), input: None, decided_by: Some("sample.guard".into()) }).unwrap();
        assert_eq!(take(&two, "7", false), Answer::plain(false), "another run's answer never leaks");
        assert_eq!(take(&one, "7", false).reason.as_deref(), Some("not here"));
        assert_eq!(take(&one, "7", false), Answer::plain(false), "claimed once");
        forget_run(&one); forget_run(&two);
        assert_eq!(call_id(&one, "1"), None);
    }

    #[test]
    fn calls_and_requests_of_one_run_stay_bounded() {
        let run = run("bounded");
        let first = record(&run, None, "tool-0", &json!(0)).unwrap();
        retain(&first.call_id).unwrap();
        for index in 1..=CALLS_PER_RUN + 10 { record(&run, None, &format!("tool-{index}"), &json!(index)).unwrap(); }
        assert!(read(&first.call_id, 0).is_ok(), "a held call is never dropped");
        assert_eq!(call_id(&run, "tool-1"), None, "the oldest unheld call went first");
        for index in 0..REQUESTS_PER_RUN + 5 { open_question(&run, &format!("q{index}")); }
        assert_eq!(take_question(&run, "q0"), None);
        assert!(attach_question(&run, &format!("q{}", REQUESTS_PER_RUN + 4), "sample.guard").is_ok());
        release(&first.call_id);
        forget_run(&run);
    }

    #[test]
    fn answers_are_strict_and_an_unsupported_rewrite_is_refused_before_anything_is_sent() {
        assert!(Answer::parse(&json!({"approved":true,"input":{"command":"ls"},"decidedBy":"sample.guard"})).is_ok());
        for bad in [json!({"approved":"yes"}), json!({"approved":false,"input":{}}), json!({"approved":false,"reason":""}), json!({"approved":false,"reason":"x".repeat(REASON_BYTES + 1)}), json!({"approved":true,"decidedBy":"Sample"}), json!({"approved":true,"extra":1})] {
            assert!(Answer::parse(&bad).is_err(), "{bad}");
        }
        let run = run("unsupported");
        open_approval(&run, "r1", None, Support::BARE);
        let rewrite = Answer { approved: true, reason: None, input: Some(json!({"command":"ls"})), decided_by: Some("sample.guard".into()) };
        let refused = attach(&run, "r1", rewrite.clone()).unwrap_err();
        assert!(refused.starts_with("UnsupportedCapability"), "{refused}");
        assert_eq!(support(&run, "r1"), Some(Support::BARE), "the request stays open for the normal prompt");
        assert!(attach(&run, "missing", Answer::plain(true)).unwrap_err().starts_with("StaleContext"));
        // A deny with a reason is still accepted where the reason goes nowhere: the decision is never lost.
        attach(&run, "r1", Answer { approved: false, reason: Some("no".into()), input: None, decided_by: None }).unwrap();
        // The decision actually sent wins over attached details that disagree with it.
        assert_eq!(take(&run, "r1", true), Answer::plain(true));
        forget_run(&run);
    }

    #[test]
    fn support_tables_follow_the_contract() {
        assert_eq!(builtin_support("claude"), Support { deny_reason: DenyReason::Answer, rewrite_input: true });
        assert_eq!(builtin_support("codex").deny_reason, DenyReason::Steer);
        assert_eq!(builtin_support("kimi"), Support::BARE);
        assert_eq!(builtin_support("claude").can(), ["approve", "deny", "ask", "rewriteInput"]);
        assert_eq!(builtin_support("zcode").json(), json!({"denyReason":"none","rewriteInput":false}));
        assert_eq!(acp_support(&json!({"agentCapabilities":{"_meta":{"pandacode":{"permissionAnswer":{"reason":true,"updatedInput":true}}}}})), Support { deny_reason: DenyReason::Answer, rewrite_input: true });
        assert_eq!(acp_support(&json!({"agentCapabilities":{}})), Support::BARE);
        assert!(provider_support(&json!({"kind":"approval","text":"x","can":["rewriteInput"]})).rewrite_input);
        assert_eq!(provider_support(&json!({"kind":"approval","text":"x"})).deny_reason, DenyReason::Answer);
    }

    #[test]
    fn frames_of_each_built_in_protocol_give_their_call_id_and_complete_input() {
        let claude = json!({"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"toolu_1","input":{"command":"ls"}}});
        assert_eq!(frame_call(&claude), Some(("toolu_1".into(), json!({"command":"ls"}))));
        let acp = json!({"jsonrpc":"2.0","id":4,"method":"session/request_permission","params":{"toolCall":{"toolCallId":"t1","rawInput":{"path":"a"}},"options":[]}});
        assert_eq!(frame_call(&acp), Some(("t1".into(), json!({"path":"a"}))));
        let codex = json!({"id":9,"method":"item/commandExecution/requestApproval","params":{"itemId":"i1","command":"ls"}});
        assert_eq!(frame_call(&codex).unwrap().0, "i1");
        let host = json!({"id":1,"method":"item/tool/call","params":{"tool":"pandacode_x","arguments":{"a":1},"callId":"c1"}});
        assert_eq!(frame_call(&host), Some(("c1".into(), json!({"a":1}))));
        assert_eq!(frame_call(&json!({"type":"extension_ui_request","id":"p"})), None);
    }

    #[test]
    fn acp_questions_become_core_questions_and_answers_select_their_option() {
        let request = json!({"id":1003,"method":"session/request_permission","params":{"toolCall":{"toolCallId":"question-db","title":"Which database?"},"options":[{"optionId":"q0_opt_0","name":"Postgres","kind":"allow_once"},{"optionId":"q0_opt_1","name":"SQLite","kind":"allow_once"},{"optionId":"q0_skip","name":"Skip","kind":"reject_once"}]}});
        let questions = acp_question(&request).unwrap();
        assert_eq!(questions[0]["question"], "Which database?");
        assert_eq!(questions[0]["options"][1]["label"], "SQLite");
        assert_eq!(acp_question_result(&request, &json!({"answers":{"q0":{"answers":["SQLite"]}}})), json!({"outcome":{"outcome":"selected","optionId":"q0_opt_1"}}));
        assert_eq!(acp_question_result(&request, &json!({"answers":{}})), json!({"outcome":{"outcome":"cancelled"}}));
        assert_eq!(acp_question_result(&request, &json!({"answers":{"q0":{"answers":["Unlisted"]}}}))["outcome"]["outcome"], "cancelled");
        assert!(acp_question(&json!({"params":{"options":[{"optionId":"allow","kind":"allow_once"},{"optionId":"deny","kind":"reject_once"}]}})).is_none());
        let data = json!({"kind":"questions","questions":[{"id":"q0","header":"","question":"Which database?","isOther":false,"isSecret":false,"options":[{"label":"Postgres","description":""}]}]});
        let pending = question_pending("task", "project", "sample.agent/fake", "req", &data, "2026-11-17T00:00:00Z").unwrap();
        assert_eq!(pending["questions"][0], json!({"id":"q0","question":"Which database?","multiple":false,"secret":false,"options":[{"label":"Postgres"}]}));
        assert_eq!(question_resolved("task", "req", Some("sample.guard"), Some(&json!({"answers":{"q0":{"answers":["Postgres"]}}})))["by"], json!({"package":"sample.guard"}));
        assert_eq!(question_resolved("task", "req", None, None)["by"], "cancelled");
    }

    /// The shared answer fixture: every case renders with the same semantics for a package handler provider
    /// (`ProviderInput`), a declared ACP harness that declares the PandaCode answer fields, a bare ACP agent and Claude
    /// Code; `approval.resolved` carries the same attribution everywhere.
    #[test]
    fn the_shared_answer_fixture_renders_the_same_semantics_for_every_protocol() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(fixture["_fixture"]["provenance"], "synthetic");
        let options = fixture["acpOptions"].as_array().unwrap().clone();
        let original = fixture["originalInput"].clone();
        for case in fixture["cases"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap();
            let answer = Answer::parse(&case["answer"]).unwrap();
            let expect = &case["expect"];
            for (adapter, support) in [("provider", provider_support(&json!({"can":["rewriteInput"]}))), ("providerBare", provider_support(&json!({}))), ("acpDeclared", acp_support(&fixture["acpDeclaredInitialize"])), ("acpBare", Support::BARE), ("claude", builtin_support("claude")), ("kimi", builtin_support("kimi"))] {
                let run = run(id);
                open_approval(&run, "req", Some("tool-1"), support);
                let attached = attach(&run, "req", answer.clone());
                let refused = expect["unsupportedFor"].as_array().is_some_and(|list| list.iter().any(|entry| entry == adapter));
                assert_eq!(attached.is_err(), refused, "{id}/{adapter}: {attached:?}");
                if refused {
                    assert!(attached.unwrap_err().starts_with("UnsupportedCapability"));
                    assert!(support_of_open(&run), "{id}/{adapter}: the request stays open");
                    forget_run(&run);
                    continue;
                }
                let claimed = take(&run, "req", answer.approved);
                assert_eq!(claimed, answer, "{id}/{adapter}");
                // What runs: the rewritten input where the adapter carries it, else the harness's own.
                let (executed, reason) = match adapter {
                    "provider" | "providerBare" => { let value = provider_input(&claimed); (value.get("input").cloned().unwrap_or(original.clone()), value["reason"].as_str().map(str::to_owned)) }
                    "acpDeclared" | "acpBare" | "kimi" => {
                        let result = acp_permission_result(&options, &claimed, support);
                        let selected = result["outcome"]["optionId"].as_str().unwrap();
                        assert_eq!(selected, if answer.approved { "allow" } else { "deny" }, "{id}/{adapter}");
                        (result["_meta"]["pandacode"].get("updatedInput").cloned().unwrap_or(original.clone()), result["_meta"]["pandacode"]["reason"].as_str().map(str::to_owned))
                    }
                    _ => {
                        let response = claude_permission_response(&original, &claimed, crate::providers::USER_DECLINE);
                        (response.get("updatedInput").cloned().unwrap_or(original.clone()), response["message"].as_str().filter(|text| *text != crate::providers::USER_DECLINE).map(str::to_owned))
                    }
                };
                if answer.approved { assert_eq!(executed, expect["executed"], "{id}/{adapter}"); }
                let reason_travels = support.deny_reason == DenyReason::Answer;
                assert_eq!(reason, if reason_travels { expect["reason"].as_str().map(str::to_owned) } else { None }, "{id}/{adapter}");
                let resolved = approval_resolved("task", "req", Some("call-x"), Some(&claimed));
                assert_eq!(resolved["by"], expect["by"], "{id}/{adapter}");
                assert_eq!(resolved["approved"], answer.approved);
                forget_run(&run);
            }
        }
        assert_eq!(approval_resolved("task", "req", None, None)["by"], "cancelled");
    }
    fn support_of_open(run: &str) -> bool { support(run, "req").is_some() }

    /// The Node fake agent (B5) through PandaCode's declared ACP transport on Windows: a tool input larger than the
    /// display preview and one larger than 1 MiB reach the call store completely, a deny reason and a supported
    /// rewrite reach the agent through `_meta.pandacode`, and a rewrite for an agent that did not declare it is refused
    /// before any answer is sent.
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows"))]
    mod windows_transport {
        use super::*;
        use crate::{extensions::runtime_provider_launch as launch, providers::RunInput};
        use std::{path::{Path, PathBuf}, sync::{atomic::{AtomicBool, Ordering}, Mutex as StdMutex}, time::Duration};
        use tokio::sync::mpsc;

        const AGENT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/extensions/backends/fake-agent.mjs");
        const SCENARIOS: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-payload/scenarios.json");
        const OWNER: &str = "sample.hook-payload";
        const WAIT: Duration = Duration::from_secs(60);

        struct Dir(PathBuf);
        impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-hook-payload-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
        impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

        fn node() -> PathBuf {
            let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
            crate::extensions::supervisor::Runtime::packaged(&root.join("_work/00-tmp/extensibility-trusted-runtime")).ok().map(|runtime| runtime.binary)
                .or_else(|| crate::providers::tool_path("node"))
                .expect("a Node runtime for the fake agent")
        }

        /// A stand-in for core's conversation of one run: tool events with `inputJson` are recorded under the run,
        /// approval events open a request with what the transport said the agent can take, and an approval answer
        /// claims the attached details exactly as `dynamic_harness::Conversation` does.
        struct Running { run: String, events: mpsc::UnboundedReceiver<Value>, seen: Vec<Value>, inputs: mpsc::Sender<RunInput>, task: tokio::task::JoinHandle<Result<(), String>>, dir: Dir, pending: Arc<StdMutex<Option<String>>> }
        impl Running {
            fn start(prompt: &str, env: &Value) -> Self {
                let dir = Dir::new();
                let mut variables = json!({"FAKE_AGENT_LOG":"{data}/frames.log"});
                for (name, value) in env.as_object().into_iter().flatten() { variables[name] = value.clone(); }
                let spec = json!({"protocol":"acp","command":["{node}", AGENT],"env":variables});
                let resolved = launch::resolve(&spec, &launch::Places { node: Some(node()), package: None, data: Some(dir.0.clone()) }).unwrap();
                let run = format!("payload-run-{}", uuid::Uuid::new_v4());
                let (sink, events) = mpsc::unbounded_channel();
                let (inputs, received) = mpsc::channel(16);
                let cancel = Arc::new(AtomicBool::new(false));
                let stop = cancel.clone();
                let pending: Arc<StdMutex<Option<String>>> = Arc::default();
                let (cwd, prompt, owner_run, answer_run, opened, answered) = (dir.0.clone(), prompt.to_owned(), run.clone(), run.clone(), pending.clone(), pending.clone());
                let task = tokio::spawn(async move {
                    launch::drive(OWNER, resolved, &cwd, &prompt, None,
                        move |mut value| {
                            if value["kind"] == "tool" {
                                if let Some(input) = value.as_object_mut().and_then(|event| event.remove("inputJson")) { record(&owner_run, None, value["tool"]["id"].as_str().unwrap(), &input).map_err(str::to_owned)?; }
                            }
                            if value["kind"] == "approval" {
                                let id = format!("req-{}", uuid::Uuid::new_v4());
                                open_approval(&owner_run, &id, value["callId"].as_str(), provider_support(&value));
                                *opened.lock().unwrap() = Some(id);
                            }
                            let _ = sink.send(value);
                            Ok(Value::Null)
                        },
                        move |input| match input {
                            RunInput::Stop => { stop.store(true, Ordering::Release); None }
                            RunInput::Approval { request_id, approved } => {
                                if answered.lock().unwrap().as_deref() != Some(request_id.as_str()) { return None; }
                                *answered.lock().unwrap() = None;
                                Some(provider_input(&take(&answer_run, &request_id, approved)))
                            }
                            _ => None,
                        },
                        received, cancel).await
                });
                Self { run, events, seen: Vec::new(), inputs, task, dir, pending }
            }
            async fn until(&mut self, what: &str, matches: impl Fn(&Value) -> bool) -> Value {
                tokio::time::timeout(WAIT, async {
                    loop {
                        let value = self.events.recv().await.unwrap_or_else(|| panic!("the run ended before {what}: {:?}", self.seen));
                        let hit = matches(&value);
                        self.seen.push(value.clone());
                        if hit { return value; }
                    }
                }).await.unwrap_or_else(|_| panic!("timed out waiting for {what}: {:?}", self.seen))
            }
            fn request(&self) -> String { self.pending.lock().unwrap().clone().expect("an open request") }
            async fn finish(mut self) -> (Result<(), String>, Vec<Value>, Vec<Value>) {
                let result = tokio::time::timeout(WAIT, &mut self.task).await.expect("the run finishes").expect("the run task does not panic");
                while let Ok(value) = self.events.try_recv() { self.seen.push(value); }
                let log = std::fs::read_to_string(self.dir.0.join("frames.log")).unwrap_or_default();
                let frames = log.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()).collect();
                forget_run(&self.run);
                (result, std::mem::take(&mut self.seen), frames)
            }
        }
        fn texts(events: &[Value]) -> Vec<String> { events.iter().filter(|event| event["kind"] == "text").filter_map(|event| event["text"].as_str().map(str::to_owned)).collect() }
        fn scenario<'a>(fixture: &'a Value, id: &str) -> &'a Value { fixture["scenarios"].as_array().unwrap().iter().find(|scenario| scenario["id"] == id).unwrap() }

        #[tokio::test]
        async fn the_fake_agent_carries_complete_inputs_reasons_and_rewrites_through_the_declared_acp_transport() {
            assert!(Path::new(AGENT).is_file());
            launch::forget(OWNER);
            let fixture: Value = serde_json::from_str(SCENARIOS).unwrap();
            assert_eq!(fixture["_fixture"]["provenance"], "synthetic");

            // 1. A large input: the display preview is cut at 2,000 characters, the hook payload is a 1 MiB preview,
            //    and hooks.input reassembles the original in 256 KiB chunks.
            let spec = scenario(&fixture, "large-input");
            let mut run = Running::start(spec["prompt"].as_str().unwrap(), &spec["env"]);
            let tool = run.until("the large tool call", |event| event["kind"] == "tool").await;
            let displayed = tool["tool"]["input"].as_str().unwrap().to_owned();
            let id = call_id(&run.run, tool["tool"]["id"].as_str().unwrap()).expect("the complete input was recorded");
            let fields = payload(&id).unwrap();
            assert_eq!(fields["inputComplete"], false);
            let total = fields["inputBytes"].as_u64().unwrap() as usize;
            assert!(total > 1 << 20 && displayed.chars().count() <= 2_000);
            let (mut cursor, mut joined) = (0u64, String::new());
            loop {
                let chunk = read(&id, cursor).unwrap();
                frame_check(&json!({"ok":true,"value":chunk})).unwrap();
                joined.push_str(chunk["text"].as_str().unwrap());
                match chunk["nextCursor"].as_u64() { Some(next) => cursor = next, None => break }
            }
            let original: Value = serde_json::from_str(&joined).unwrap();
            assert_eq!(original["command"], spec["expect"]["command"]);
            assert_eq!(joined.len(), total);
            assert!(displayed.len() < total);
            let (result, events, _) = run.finish().await;
            assert!(result.is_ok(), "{result:?} {events:?}");

            // 2. A deny reason reaches the agent that declared it reads one.
            let spec = scenario(&fixture, "deny-reason");
            let mut run = Running::start(spec["prompt"].as_str().unwrap(), &spec["env"]);
            run.until("an approval request", |event| event["kind"] == "approval").await;
            let request = run.request();
            attach(&run.run, &request, Answer { approved: false, reason: Some(spec["reason"].as_str().unwrap().into()), input: None, decided_by: Some("sample.guard".into()) }).unwrap();
            run.inputs.send(RunInput::Approval { request_id: request, approved: false }).await.unwrap();
            let (result, events, frames) = run.finish().await;
            assert!(result.is_ok(), "{result:?}");
            assert!(texts(&events).contains(&format!("denied: {}", spec["reason"].as_str().unwrap())), "{events:?}");
            let answer = frames.iter().find(|frame| frame["result"]["outcome"].is_object()).unwrap();
            assert_eq!(answer["result"]["_meta"]["pandacode"]["decidedBy"], "sample.guard");

            // 3. A supported rewrite runs the new arguments.
            let spec = scenario(&fixture, "rewrite-supported");
            let mut run = Running::start(spec["prompt"].as_str().unwrap(), &spec["env"]);
            run.until("an approval request", |event| event["kind"] == "approval").await;
            let request = run.request();
            attach(&run.run, &request, Answer { approved: true, reason: None, input: Some(spec["rewrite"].clone()), decided_by: Some("sample.guard".into()) }).unwrap();
            run.inputs.send(RunInput::Approval { request_id: request, approved: true }).await.unwrap();
            let (result, events, _) = run.finish().await;
            assert!(result.is_ok(), "{result:?}");
            let said = texts(&events);
            assert!(said.contains(&format!("ran: {}", serde_json::to_string(&spec["rewrite"]).unwrap())), "{said:?}");
            assert!(!said.contains(&format!("ran: {}", serde_json::to_string(&spec["expect"]["original"]).unwrap())), "{said:?}");

            // 4. An agent that did not declare rewrites: the rewrite is refused before any answer, the old input is
            //    never approved, and the request stays open until the user (here, a plain deny) answers it.
            let spec = scenario(&fixture, "rewrite-unsupported");
            let mut run = Running::start(spec["prompt"].as_str().unwrap(), &spec["env"]);
            run.until("an approval request", |event| event["kind"] == "approval").await;
            let request = run.request();
            let refused = attach(&run.run, &request, Answer { approved: true, reason: None, input: Some(spec["rewrite"].clone()), decided_by: Some("sample.guard".into()) }).unwrap_err();
            assert!(refused.starts_with("UnsupportedCapability"), "{refused}");
            assert!(support(&run.run, &request).is_some(), "the request is still open");
            tokio::time::sleep(Duration::from_millis(300)).await;
            run.inputs.send(RunInput::Approval { request_id: request, approved: false }).await.unwrap();
            let (result, events, frames) = run.finish().await;
            assert!(result.is_ok(), "{result:?}");
            let said = texts(&events);
            assert!(!said.iter().any(|text| text.starts_with("ran: ")), "the old input never ran: {said:?}");
            let answers: Vec<&Value> = frames.iter().filter(|frame| frame["result"]["outcome"].is_object()).collect();
            assert_eq!(answers.len(), 1, "{answers:?}");
            assert_eq!(answers[0]["result"]["outcome"]["optionId"], "deny");
            assert!(answers[0]["result"].get("_meta").is_none(), "a bare agent gets the bare decision");
            launch::forget(OWNER);
        }
    }
}
