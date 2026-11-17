//! Hook returns the host applies: prompt context, rewrite and block, the next-send `forModel` notes, rewritten tool
//! results and capability-bounded compaction answers (runtime phase R5, slice R0504).
//!
//! R0503 delivers every hook one way. This slice turns three of them into a **chain the host awaits**, each package
//! asked in turn inside its declaration's `budgetMs` (the whole chain inside 60 s), with a frame that says
//! `observeOnly: false` and a payload whose `can` lists what the host can apply:
//!
//! * **`prompt.submit`** runs before a message is saved and sent (`before_send`, called first by
//!   `launch_operation_admitted`). `context` (needs `harness.hooks.context`) is added under an attributed heading that
//!   the transcript folds into a collapsible block; `prompt` and `block` need `harness.hooks.decide`; a block, or a
//!   failure of a hook declared `onFailure: "deny"`, refuses the send so the message returns to the draft with the
//!   reason. The task's waiting `forModel` notes (R0402) are taken here, through `runtime_tasks_messages::take_context`,
//!   and given back when the message is not sent.
//! * **`tool.after`** can rewrite a result only where the host serves the call itself (PandaCode's own tools, through
//!   [`with_result_hooks`]: `source: 'hostTool'`, `can: ['rewriteResult']`); the rewritten value is what the harness
//!   and so the model receives. A call a harness runs stays observe only (`can: []`). Denied and cancelled calls still
//!   produce `tool.after`, with `output: null` instead of a host-invented decline text.
//! * **`compaction`** with `phase: 'before'` fires for a typed `/compact` the host is about to send. `can` lists what
//!   the host can do there: `cancel` always (the command is not sent), `instructions` where the harness's `/compact`
//!   takes them; `summary` is never offered (no harness takes a supplied summary). A return outside `can` is ignored
//!   and its receipt says `UnsupportedCapability`.
//!
//! Every non-empty return gets a receipt (`panda.hooks.onApplied`): applied or not, with the refusal of each part
//! that was not. A failing, slow or absent handler never blocks a run on its own and never approves: under the
//! default `onFailure: "continue"` the message is sent without that package's part. Everything here is for
//! predictability and fault isolation (ADR-0005); the named grant is the safeguard.
use serde_json::{json, Map, Value};
use std::{collections::{BTreeMap, BTreeSet}, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tokio::sync::oneshot;

use super::runtime_hook_registration::{self as hooks, HookRegistry, Occurrence};

pub const DECIDE: &str = "harness.hooks.decide";
pub const CONTEXT: &str = "harness.hooks.context";
pub const PRESENTATION: &str = "ui.presentation";
/// The whole chain of one event.
pub const CHAIN_MS: u64 = 60_000;
pub const CONTEXT_BYTES: usize = 64 * 1024;
pub const PROMPT_BYTES: usize = 1024 * 1024;
pub const REASON_BYTES: usize = 4_096;
pub const NOTE_BYTES: usize = 512;
pub const INSTRUCTIONS_BYTES: usize = 16 * 1024;
pub const SUMMARY_BYTES: usize = 256 * 1024;
pub const OUTPUT_BYTES: usize = 1024 * 1024;
/// The heading of one package's context in a sent message; the transcript folds it (`runtime-hook-context.ts`).
pub const CONTEXT_HEADING: &str = "Extension context from";
pub const NOT_WRITTEN: &str = "(not written by the user):";

// ---------------------------------------------------------------------------------------------------------------
// One step of a chain and its receipt
// ---------------------------------------------------------------------------------------------------------------

/// One package asked in a chain: who, what it holds for the run's project, its failure policy and what it answered
/// (`Err` carries the failure code: `Timeout`, `HostUnavailable`, a code the handler threw, ...).
#[derive(Clone, Debug)]
pub struct Step { pub owner: String, pub name: String, pub on_failure: String, pub grants: BTreeSet<String>, pub answer: Result<Value, String> }
impl Step {
    fn holds(&self, permission: &str) -> bool { self.grants.contains(permission) }
}

/// What the host did with one non-empty return.
#[derive(Clone, Debug, PartialEq)]
pub struct Receipt { pub owner: String, pub applied: bool, pub code: Option<String>, pub refused: BTreeMap<String, String> }
impl Receipt {
    fn new(owner: &str) -> Self { Self { owner: owner.to_owned(), applied: false, code: None, refused: BTreeMap::new() } }
    fn refuse(&mut self, key: &str, code: &str) { self.refused.entry(key.to_owned()).or_insert_with(|| code.to_owned()); }
    fn finish(mut self) -> Self {
        if !self.applied && self.code.is_none() { self.code = self.refused.values().next().cloned(); }
        self
    }
    fn invalid(owner: &str, code: &str) -> Self { Self { owner: owner.to_owned(), applied: false, code: Some(code.to_owned()), refused: BTreeMap::new() } }
    /// `HookReceipt` as the service receives it.
    pub fn json(&self, hook_id: &str, event: &str, task: &str, call: Option<&str>) -> Value {
        let mut receipt = json!({"schemaVersion": 1, "hookId": hook_id, "event": event, "taskId": task, "applied": self.applied});
        if let Some(call) = call { receipt["callId"] = json!(call); }
        if let Some(code) = &self.code { receipt["code"] = json!(code); }
        if !self.refused.is_empty() { receipt["refused"] = json!(self.refused); }
        receipt
    }
}

fn bounded_text(value: &Value, limit: usize, allow_empty: bool) -> Result<String, &'static str> {
    let text = value.as_str().ok_or("InvalidShape")?;
    if text.len() > limit { return Err("LimitExceeded"); }
    if !allow_empty && text.trim().is_empty() { return Err("InvalidShape"); }
    Ok(text.to_owned())
}
fn one_line(text: &str) -> String { text.split_whitespace().collect::<Vec<_>>().join(" ") }
/// `{ reason: string }`, exactly.
fn reason_of(value: &Value) -> Result<String, &'static str> {
    let object = value.as_object().ok_or("InvalidShape")?;
    if object.len() != 1 { return Err("InvalidShape"); }
    let reason = bounded_text(&object["reason"], REASON_BYTES, false)?;
    Ok(one_line(&reason))
}
/// The return as an object of known keys; `None` for an empty return (nothing to apply, no receipt).
fn fields(value: &Value, keys: &[&str]) -> Result<Option<Map<String, Value>>, &'static str> {
    match value {
        Value::Null => Ok(None),
        Value::Object(object) => {
            if object.keys().any(|key| !keys.contains(&key.as_str())) { return Err("InvalidShape"); }
            let present: Map<String, Value> = object.iter().filter(|(_, value)| !value.is_null()).map(|(key, value)| (key.clone(), value.clone())).collect();
            Ok((!present.is_empty()).then_some(present))
        }
        _ => Err("InvalidShape"),
    }
}

/// How a chain folds the answers of its steps, one at a time; a stopped fold asks nobody else.
pub trait Fold {
    /// The payload the next step receives (what earlier steps changed is visible to later ones).
    fn payload(&self, base: &Value) -> Value;
    fn step(&mut self, step: &Step);
    fn stopped(&self) -> bool;
    fn receipts(&self) -> &[Receipt];
}

// ---------------------------------------------------------------------------------------------------------------
// prompt.submit
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct Blocked { pub by: String, pub reason: String, pub failed: bool }
impl Blocked {
    /// The error the send answers: the composer puts the message back into the draft and shows it.
    pub fn message(&self) -> String {
        if self.failed { format!("Not sent: {}", self.reason) } else { format!("Not sent: blocked by {}. {}", self.by, self.reason) }
    }
}

/// The fold of `prompt.submit`.
#[derive(Clone, Debug, Default)]
pub struct PromptFold {
    pub text: String,
    /// `(package name, context)`, in chain order.
    pub contexts: Vec<(String, String)>,
    pub rewritten_by: Vec<String>,
    pub notes: Vec<(String, String)>,
    pub blocked: Option<Blocked>,
    pub receipts: Vec<Receipt>,
}
impl PromptFold {
    pub fn new(text: &str) -> Self { Self { text: text.to_owned(), ..Self::default() } }
    fn failed(&mut self, step: &Step, code: &str) {
        if step.on_failure == "deny" { self.blocked = Some(Blocked { by: step.name.clone(), reason: format!("{} did not answer ({code}).", step.name), failed: true }); }
    }
}
impl Fold for PromptFold {
    fn payload(&self, base: &Value) -> Value {
        let mut payload = base.clone();
        payload["text"] = json!(super::runtime_hook_payload::preview(&self.text));
        payload
    }
    fn stopped(&self) -> bool { self.blocked.is_some() }
    fn receipts(&self) -> &[Receipt] { &self.receipts }
    fn step(&mut self, step: &Step) {
        let value = match &step.answer { Ok(value) => value, Err(code) => { self.failed(step, code); return } };
        let present = match fields(value, &["context", "prompt", "block", "note"]) {
            Ok(None) => return,
            Ok(Some(present)) => present,
            Err(code) => { self.receipts.push(Receipt::invalid(&step.owner, code)); self.failed(step, code); return }
        };
        // Every part is checked before any applies, so an invalid return changes nothing.
        let parsed = (|| -> Result<_, &'static str> {
            Ok((
                present.get("block").map(reason_of).transpose()?,
                present.get("prompt").map(|value| bounded_text(value, PROMPT_BYTES, false)).transpose()?,
                present.get("context").map(|value| bounded_text(value, CONTEXT_BYTES, true)).transpose()?,
                present.get("note").map(|value| bounded_text(value, NOTE_BYTES, true).map(|note| one_line(&note))).transpose()?,
            ))
        })();
        let (block, prompt, context, note) = match parsed {
            Ok(parsed) => parsed,
            Err(code) => { self.receipts.push(Receipt::invalid(&step.owner, code)); self.failed(step, code); return }
        };
        let mut receipt = Receipt::new(&step.owner);
        if let Some(note) = note.filter(|note| !note.is_empty()) {
            if step.holds(PRESENTATION) { self.notes.push((step.name.clone(), note)); receipt.applied = true; } else { receipt.refuse("note", "PermissionDenied"); }
        }
        if let Some(reason) = block {
            if step.holds(DECIDE) {
                self.blocked = Some(Blocked { by: step.name.clone(), reason, failed: false });
                receipt.applied = true;
                self.receipts.push(receipt.finish());
                return;
            }
            receipt.refuse("block", "PermissionDenied");
        }
        if let Some(prompt) = prompt {
            if step.holds(DECIDE) { self.text = prompt; self.rewritten_by.push(step.name.clone()); receipt.applied = true; } else { receipt.refuse("prompt", "PermissionDenied"); }
        }
        if let Some(context) = context.filter(|context| !context.trim().is_empty()) {
            if step.holds(CONTEXT) { self.contexts.push((step.name.clone(), context.trim().to_owned())); receipt.applied = true; } else { receipt.refuse("context", "PermissionDenied"); }
        }
        self.receipts.push(receipt.finish());
    }
}

/// The message as sent: the (possibly rewritten) text, then each package's context and the waiting notes, each as an
/// attributed block after a blank line. The transcript shows the text and folds the blocks (`runtime-hook-context.ts`).
pub fn compose(text: &str, contexts: &[(String, String)], notes_block: Option<&str>) -> String {
    let mut message = text.to_owned();
    for (name, context) in contexts {
        // A blank line inside a context would split the block where the transcript looks for the next one.
        let body = context.split("\n\n").map(str::trim).filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n");
        message.push_str(&format!("\n\n{CONTEXT_HEADING} {} {NOT_WRITTEN}\n{body}", one_line(name)));
    }
    if let Some(block) = notes_block { message.push_str("\n\n"); message.push_str(block); }
    message
}

// ---------------------------------------------------------------------------------------------------------------
// tool.after
// ---------------------------------------------------------------------------------------------------------------

/// The fold of `tool.after`: `output` is the rewritten result (`None`: unchanged).
#[derive(Clone, Debug, Default)]
pub struct ToolAfterFold { pub can: Vec<String>, pub original: Value, pub output: Option<Value>, pub by: Vec<String>, pub notes: Vec<(String, String)>, pub receipts: Vec<Receipt> }
impl ToolAfterFold {
    pub fn new(can: &[&str], original: Value) -> Self { Self { can: can.iter().map(|entry| (*entry).to_owned()).collect(), original, ..Self::default() } }
}
impl Fold for ToolAfterFold {
    fn payload(&self, base: &Value) -> Value {
        let mut payload = base.clone();
        payload["can"] = json!(self.can);
        if let Some(output) = &self.output { payload["output"] = output.clone(); }
        payload
    }
    fn stopped(&self) -> bool { false }
    fn receipts(&self) -> &[Receipt] { &self.receipts }
    fn step(&mut self, step: &Step) {
        // `tool.after` takes `onFailure: "continue"` only: a failure leaves the result as it was.
        let Ok(value) = &step.answer else { return };
        let present = match fields(value, &["output", "note"]) {
            Ok(None) => return,
            Ok(Some(present)) => present,
            Err(code) => { self.receipts.push(Receipt::invalid(&step.owner, code)); return }
        };
        let note = match present.get("note").map(|value| bounded_text(value, NOTE_BYTES, true)).transpose() { Ok(note) => note, Err(code) => { self.receipts.push(Receipt::invalid(&step.owner, code)); return } };
        if present.get("output").is_some_and(|output| output.to_string().len() > OUTPUT_BYTES) { self.receipts.push(Receipt::invalid(&step.owner, "LimitExceeded")); return; }
        let mut receipt = Receipt::new(&step.owner);
        if let Some(output) = present.get("output") {
            if !self.can.iter().any(|entry| entry == "rewriteResult") { receipt.refuse("output", "UnsupportedCapability"); }
            else if !step.holds(DECIDE) { receipt.refuse("output", "PermissionDenied"); }
            else { self.output = Some(output.clone()); self.by.push(step.name.clone()); receipt.applied = true; }
        }
        if let Some(note) = note.map(|note| one_line(&note)).filter(|note| !note.is_empty()) {
            if step.holds(PRESENTATION) { self.notes.push((step.name.clone(), note)); receipt.applied = true; } else { receipt.refuse("note", "PermissionDenied"); }
        }
        self.receipts.push(receipt.finish());
    }
}

// ---------------------------------------------------------------------------------------------------------------
// compaction
// ---------------------------------------------------------------------------------------------------------------

/// What the host can do with a compaction it is about to send for `harness`: `cancel` (it simply does not send the
/// command) and `instructions` where the harness's `/compact` takes them (the Claude Code stream family). `summary`
/// is never offered: no harness takes a supplied summary on the host path.
pub fn compaction_can(harness: &str) -> Vec<&'static str> {
    let mut can = vec!["cancel"];
    if matches!(harness, "claude" | "glm" | "mimo" | "alibaba") { can.push("instructions"); }
    can
}

#[derive(Clone, Debug, Default)]
pub struct CompactionFold { pub can: Vec<String>, pub cancel: Option<(String, String)>, pub instructions: Vec<(String, String)>, pub summaries: Vec<(String, String)>, pub receipts: Vec<Receipt> }
impl CompactionFold {
    pub fn new(can: &[&str]) -> Self { Self { can: can.iter().map(|entry| (*entry).to_owned()).collect(), ..Self::default() } }
    fn offered(&self, key: &str) -> bool { self.can.iter().any(|entry| entry == key) }
}
impl Fold for CompactionFold {
    fn payload(&self, base: &Value) -> Value { let mut payload = base.clone(); payload["can"] = json!(self.can); payload }
    fn stopped(&self) -> bool { self.cancel.is_some() }
    fn receipts(&self) -> &[Receipt] { &self.receipts }
    fn step(&mut self, step: &Step) {
        let Ok(value) = &step.answer else { return };
        let present = match fields(value, &["summary", "instructions", "cancel"]) {
            Ok(None) => return,
            Ok(Some(present)) => present,
            Err(code) => { self.receipts.push(Receipt::invalid(&step.owner, code)); return }
        };
        let parsed = (|| -> Result<_, &'static str> {
            Ok((
                present.get("cancel").map(reason_of).transpose()?,
                present.get("instructions").map(|value| bounded_text(value, INSTRUCTIONS_BYTES, false)).transpose()?,
                present.get("summary").map(|value| bounded_text(value, SUMMARY_BYTES, false)).transpose()?,
            ))
        })();
        let (cancel, instructions, summary) = match parsed { Ok(parsed) => parsed, Err(code) => { self.receipts.push(Receipt::invalid(&step.owner, code)); return } };
        let mut receipt = Receipt::new(&step.owner);
        let mut gate = |key: &str, receipt: &mut Receipt| -> bool {
            if !self.offered(key) { receipt.refuse(key, "UnsupportedCapability"); false }
            else if !step.holds(DECIDE) { receipt.refuse(key, "PermissionDenied"); false }
            else { true }
        };
        let cancel_ok = cancel.as_ref().is_some_and(|_| gate("cancel", &mut receipt));
        let instructions_ok = instructions.as_ref().is_some_and(|_| gate("instructions", &mut receipt));
        let summary_ok = summary.as_ref().is_some_and(|_| gate("summary", &mut receipt));
        if cancel_ok {
            self.cancel = Some((step.name.clone(), cancel.unwrap_or_default()));
            receipt.applied = true;
            self.receipts.push(receipt.finish());
            return;
        }
        if instructions_ok { self.instructions.push((step.name.clone(), one_line(&instructions.unwrap_or_default()))); receipt.applied = true; }
        if summary_ok { self.summaries.push((step.name.clone(), summary.unwrap_or_default())); receipt.applied = true; }
        self.receipts.push(receipt.finish());
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------------------------------------------

/// Hands one awaited hook frame to the running service of `owner`; the receiver settles with the handler's answer.
pub type Ask = Arc<dyn Fn(&str, Value) -> Result<oneshot::Receiver<Result<Value, String>>, &'static str> + Send + Sync>;
/// The display name of a package, for attribution.
pub type Names = Arc<dyn Fn(&str) -> String + Send + Sync>;

async fn ask_one(ask: &Ask, owner: &str, frame: Value, budget: Duration) -> Result<Value, String> {
    let receiver = ask(owner, frame).map_err(str::to_owned)?;
    match tokio::time::timeout(budget, receiver).await {
        Err(_) => Err("Timeout".into()),
        Ok(Err(_)) => Err("HostUnavailable".into()),
        Ok(Ok(answer)) => answer,
    }
}

/// Asks every attached hook of the occurrence's event whose filter and observe grant accept it, one after another,
/// folding each answer before the next is asked, then sends each receipt. Answers how many were asked.
pub async fn drive<F: Fold + Send>(registry: &HookRegistry, ask: &Ask, names: &Names, occurrence: &Occurrence, task: &str, call: Option<&str>, fold: &mut F) -> usize {
    let targets = registry.targets(occurrence);
    let started = Instant::now();
    let chain = Duration::from_millis(CHAIN_MS);
    let mut asked = Vec::new();
    for target in &targets {
        if fold.stopped() { break; }
        let budget = Duration::from_millis(target.declaration.budget_ms).min(chain.saturating_sub(started.elapsed()));
        let answer = if budget.is_zero() { Err("Timeout".to_owned()) } else {
            let frame = json!({"schemaVersion": 1, "hookId": target.declaration.id, "event": occurrence.event, "observeOnly": false, "payload": fold.payload(&occurrence.payload)});
            ask_one(ask, &target.owner, frame, budget).await
        };
        let grants = [DECIDE, CONTEXT, PRESENTATION].into_iter().filter(|permission| registry.holds(&target.owner, &target.version, permission, Some(&occurrence.project))).map(str::to_owned).collect();
        let receipts = fold.receipts().len();
        fold.step(&Step { owner: target.owner.clone(), name: names(&target.owner), on_failure: target.declaration.on_failure.clone(), grants, answer });
        asked.push((target.declaration.id.clone(), receipts));
    }
    // One receipt per non-empty return, to the package that made it, in the order the returns were made.
    let receipts = fold.receipts().to_vec();
    for (index, (hook_id, before)) in asked.iter().enumerate() {
        let after = asked.get(index + 1).map_or(receipts.len(), |(_, next)| *next);
        for receipt in receipts.iter().take(after).skip(*before) {
            let _ = registry.deliver_to(&receipt.owner, json!({"schemaVersion": 1, "receipt": receipt.json(hook_id, occurrence.event, task, call)}));
        }
    }
    asked.len()
}

// ---------------------------------------------------------------------------------------------------------------
// Ledgers the agent event sink reads
// ---------------------------------------------------------------------------------------------------------------

#[derive(Default)]
struct Ledgers {
    /// `(run, host call id)` of calls whose permission request the user or a package denied.
    denied: BTreeSet<(String, String)>,
    /// `(run, tool base name)` of host-served calls whose `tool.after` this slice already delivered.
    hosted: BTreeMap<(String, String), u32>,
}
static LEDGERS: Mutex<Option<Ledgers>> = Mutex::new(None);
fn ledgers<T>(work: impl FnOnce(&mut Ledgers) -> T) -> T {
    let mut slot = LEDGERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    work(slot.get_or_insert_with(Ledgers::default))
}
const LEDGER_LIMIT: usize = 4_096;

/// The name a harness reports for a host tool, without its server prefix (`mcp__pandacode__x`, `pandacode.x`).
pub fn base_name(name: &str) -> String {
    let name = name.strip_prefix("mcp__").map_or(name, |rest| rest.rsplit("__").next().unwrap_or(rest));
    name.rsplit(['.', ':', '/']).next().unwrap_or(name).to_owned()
}
/// An approval was answered (`respond_approval`): a denial makes the call's `tool.after` status `denied` with no
/// output, whatever decline text the harness echoes.
pub fn answered(run: &str, request: &str, approved: bool) {
    if approved { return; }
    // The app's request ids may carry the run prefix (`<run>:<id>`); the adapter's book keys the bare id.
    let call = super::runtime_hook_payload::request_call(run, request).or_else(|| request.split_once(':').and_then(|(_, original)| super::runtime_hook_payload::request_call(run, original)));
    if let Some(call) = call { ledgers(|ledgers| { if ledgers.denied.len() >= LEDGER_LIMIT { ledgers.denied.clear(); } ledgers.denied.insert((run.to_owned(), call)); }); }
}
pub fn denied(run: &str, call: &str) -> bool { ledgers(|ledgers| ledgers.denied.contains(&(run.to_owned(), call.to_owned()))) }
fn hosted(run: &str, name: &str) {
    ledgers(|ledgers| { if ledgers.hosted.len() >= LEDGER_LIMIT { ledgers.hosted.clear(); } *ledgers.hosted.entry((run.to_owned(), base_name(name))).or_default() += 1; });
}
/// The activity row of a host-served call whose `tool.after` was already delivered: true once per such call.
pub fn take_hosted(run: &str, name: &str) -> bool {
    ledgers(|ledgers| {
        let key = (run.to_owned(), base_name(name));
        match ledgers.hosted.get_mut(&key) {
            Some(count) => { *count -= 1; if *count == 0 { ledgers.hosted.remove(&key); } true }
            None => false,
        }
    })
}
/// The run ended: its ledgers go.
pub fn forget_run(run: &str) { ledgers(|ledgers| { ledgers.denied.retain(|(owner, _)| owner != run); ledgers.hosted.retain(|(owner, _), _| owner != run); }); }

// ---------------------------------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------------------------------

fn app_ask(app: &tauri::AppHandle) -> Ask {
    let app = app.clone();
    Arc::new(move |owner: &str, frame: Value| {
        use tauri::Manager;
        app.try_state::<super::runtime_service_lifetime::ServiceLifetime>().ok_or("HostUnavailable")?.send_hook(owner, frame)
    })
}
/// The manifest `name` of a package, else its id.
fn app_names(app: &tauri::AppHandle) -> Names {
    let app = app.clone();
    Arc::new(move |owner: &str| {
        use tauri::Manager;
        app.try_state::<super::packages::ExtensionPackages>()
            .and_then(|packages| packages.0.lock().ok().and_then(|packages| serde_json::to_value(packages.snapshot()).ok()))
            .and_then(|snapshot| snapshot["packages"].as_array().and_then(|packages| packages.iter().find(|package| package["manifest"]["id"] == owner).and_then(|package| package["manifest"]["name"].as_str().filter(|name| !name.trim().is_empty()).map(str::to_owned))))
            .unwrap_or_else(|| owner.to_owned())
    })
}
fn system_line(app: &tauri::AppHandle, task: &str, text: &str) {
    use tauri::{Emitter, Manager};
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    let saved = state.store.lock().ok().map(|store| store.insert_message(task, "system", text));
    if saved.is_some() { let _ = app.emit("sessions-changed", ()); }
}
fn names_list(names: &[String]) -> String {
    let mut unique: Vec<&str> = Vec::new();
    for name in names { if !unique.contains(&name.as_str()) { unique.push(name); } }
    unique.join(", ")
}

/// What `before_send` decided: the text to send and the notes it carries (given back when the message never saves).
pub struct Submitted { pub text: Option<String>, notes: Vec<super::runtime_tasks_messages::PendingNote> }
impl Submitted {
    fn plain(text: Option<String>) -> Self { Self { text, notes: vec![] } }
    /// The text, and a guard that gives the notes back to the task unless the message was saved ([`Carried::keep`]).
    pub fn split(self, app: &tauri::AppHandle, task: &str) -> (Option<String>, Carried) {
        (self.text, Carried { app: app.clone(), task: task.to_owned(), notes: self.notes })
    }
}
/// The notes a message carries until it is saved: dropped without [`Carried::keep`] (the send failed on the way),
/// they wait for the task's next message again.
pub struct Carried { app: tauri::AppHandle, task: String, notes: Vec<super::runtime_tasks_messages::PendingNote> }
impl Carried {
    /// The message was saved with its notes.
    pub fn keep(mut self) { self.notes.clear(); }
}
impl Drop for Carried {
    fn drop(&mut self) {
        let notes = std::mem::take(&mut self.notes);
        if !notes.is_empty() { super::runtime_tasks_messages::restore_context(&self.app, &self.task, notes); }
    }
}

/// Runs before a message is saved and sent (`launch_operation_admitted`). `eligible` is false for runs that send no
/// user message of their own (goals, cloud re-attach, coordination turns, commands prepared by the caller). A typed
/// `/compact` runs the `compaction` chain (`phase: 'before'`); another typed command passes unchanged; any other
/// message takes the task's waiting notes and runs the `prompt.submit` chain. `Err` refuses the send: the composer
/// keeps the message in the draft and shows the reason.
pub async fn before_send(app: &tauri::AppHandle, session_id: &str, text: Option<String>, eligible: bool, worker: bool) -> Result<Submitted, String> {
    let Some(original) = text else { return Ok(Submitted::plain(None)) };
    if !eligible || original.trim().is_empty() { return Ok(Submitted::plain(Some(original))); }
    let registry = hooks::registry();
    if let Some((name, arguments)) = crate::slash_commands::split_command(&original) {
        if name == "/compact" && registry.active() { return compaction_before(app, session_id, &original, arguments, worker).await; }
        return Ok(Submitted::plain(Some(original)));
    }
    let carried = super::runtime_tasks_messages::take_context(app, session_id, &original);
    let mut fold = PromptFold::new(&original);
    if registry.active() {
        if let Some(facts) = hooks::facts_of(app, session_id, None, Some(&original), worker) {
            let since = registry.since_compaction(session_id, facts.index);
            let occurrence = HookRegistry::turn_occurrence(&facts, "prompt.submit", since);
            let asked = drive(registry, &app_ask(app), &app_names(app), &occurrence, session_id, None, &mut fold).await;
            if asked > 0 && fold.blocked.is_none() { registry.mark_submitted(session_id); }
        }
    }
    if let Some(blocked) = &fold.blocked {
        if let Some((_, notes)) = carried { super::runtime_tasks_messages::restore_context(app, session_id, notes); }
        return Err(blocked.message());
    }
    if !fold.rewritten_by.is_empty() {
        let shown: String = original.chars().take(2_000).collect();
        system_line(app, session_id, &format!("Message rewritten by {} before it was sent. You wrote: {shown}", names_list(&fold.rewritten_by)));
    }
    for (name, note) in &fold.notes { system_line(app, session_id, &format!("{name}: {note}")); }
    let (block, notes) = match carried { Some((block, notes)) => (Some(block), notes), None => (None, vec![]) };
    Ok(Submitted { text: Some(compose(&fold.text, &fold.contexts, block.as_deref())), notes })
}

async fn compaction_before(app: &tauri::AppHandle, session_id: &str, original: &str, arguments: &str, worker: bool) -> Result<Submitted, String> {
    let registry = hooks::registry();
    let Some(facts) = hooks::facts_of(app, session_id, None, None, worker) else { return Ok(Submitted::plain(Some(original.to_owned()))) };
    let can = compaction_can(&facts.harness);
    let mut fold = CompactionFold::new(&can);
    let occurrence = Occurrence {
        event: "compaction", project: facts.project_id.clone(), harness: facts.harness.clone(), run: facts.run["kind"].as_str().unwrap_or("task").to_owned(), tool_kind: None, paths: vec![],
        payload: json!({"taskId": facts.task_id, "projectId": facts.project_id, "harness": facts.harness, "phase": "before", "can": can}),
    };
    drive(registry, &app_ask(app), &app_names(app), &occurrence, session_id, None, &mut fold).await;
    if let Some((name, reason)) = fold.cancel { return Err(format!("Compaction cancelled by {name}. {reason}")); }
    if fold.instructions.is_empty() { return Ok(Submitted::plain(Some(original.to_owned()))); }
    let added = fold.instructions.iter().map(|(_, text)| text.as_str()).collect::<Vec<_>>().join(" ");
    let command = if arguments.is_empty() { format!("/compact {added}") } else { format!("/compact {arguments} {added}") };
    system_line(app, session_id, &format!("Compaction instructions added by {}: {added}", names_list(&fold.instructions.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>())));
    Ok(Submitted::plain(Some(command)))
}

/// Wraps the host's own tools of a run (`build_task_host`): after each call, `tool.after` with `source: 'hostTool'`
/// and `can: ['rewriteResult']` runs as an awaited chain, and a rewritten result is what the harness receives. Free
/// when no hook is attached. A call that failed passes its error through unchanged.
pub fn with_result_hooks(base: crate::providers::ToolHost, app: tauri::AppHandle, session_id: String) -> crate::providers::ToolHost {
    let inner = base.handler.clone();
    let serial = Arc::new(std::sync::atomic::AtomicU64::new(0));
    crate::providers::ToolHost {
        tools: base.tools,
        approval_tools: base.approval_tools,
        handler: Arc::new(move |name: String, arguments: Value| {
            let (inner, app, session_id, serial) = (inner.clone(), app.clone(), session_id.clone(), serial.clone());
            Box::pin(async move {
                let started = Instant::now();
                let result = inner(name.clone(), arguments.clone()).await;
                let registry = hooks::registry();
                if !registry.active() { return result; }
                let Some(facts) = registry.run(&session_id) else { return result };
                let harness_call = format!("host-{}", serial.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
                let Ok(recorded) = super::runtime_hook_payload::record(&session_id, Some(&facts.project_id), &harness_call, &arguments) else { return result };
                let mut base = hooks::HookRegistry::call_base(&facts, &name, hooks::tool_kind(&name), None, "hostTool", "everyCall");
                base["tool"]["owner"] = json!("panda.core");
                let built = super::runtime_hook_payload::hook_call(&base, &recorded.call_id);
                super::runtime_hook_payload::finish(&session_id, &harness_call);
                let Ok(mut call) = built else { return result };
                let (kind, paths) = hooks::HookRegistry::complete(&mut call, &name);
                let (status, output) = match &result { Ok(value) => ("completed", value.clone()), Err(error) => ("failed", json!(error)) };
                let complete = output.to_string().len() <= OUTPUT_BYTES;
                call["status"] = json!(status);
                call["output"] = if complete { output.clone() } else { json!(super::runtime_hook_payload::preview(&output.to_string())) };
                call["outputComplete"] = json!(complete);
                call["durationMs"] = json!(started.elapsed().as_millis() as u64);
                call["decidedBy"] = Value::Null;
                let can: &[&str] = if result.is_ok() { &["rewriteResult"] } else { &[] };
                let occurrence = Occurrence { event: "tool.after", project: facts.project_id.clone(), harness: facts.harness.clone(), run: facts.run["kind"].as_str().unwrap_or("task").to_owned(), tool_kind: Some(kind), paths, payload: call };
                let mut fold = ToolAfterFold::new(can, output);
                drive(registry, &app_ask(&app), &app_names(&app), &occurrence, &session_id, Some(&recorded.call_id), &mut fold).await;
                // The activity row of this call must not deliver `tool.after` a second time.
                hosted(&session_id, &name);
                for (package, note) in &fold.notes { system_line(&app, &session_id, &format!("{package}: {note}")); }
                match (result, fold.output) {
                    (Ok(_), Some(rewritten)) => {
                        system_line(&app, &session_id, &format!("Result of {name} rewritten by {}.", names_list(&fold.by)));
                        Ok(rewritten)
                    }
                    (result, _) => result,
                }
            }) as std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>>
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RETURNS: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-context/returns.json");
    const COMPACTION: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-context/compaction.json");
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-context/extension.json");
    const OWNER: &str = "sample.hook-context";

    fn step(raw: &Value) -> Step {
        Step {
            owner: raw["owner"].as_str().unwrap().into(), name: raw["name"].as_str().unwrap().into(),
            on_failure: raw["onFailure"].as_str().unwrap_or("continue").into(),
            grants: raw["grants"].as_array().unwrap().iter().map(|grant| grant.as_str().unwrap().to_owned()).collect(),
            answer: match raw["answer"]["error"].as_str() { Some(code) => Err(code.into()), None => Ok(raw["answer"]["value"].clone()) },
        }
    }
    fn receipts(receipts: &[Receipt]) -> Value {
        Value::Array(receipts.iter().map(|receipt| {
            let mut out = json!({"owner": receipt.owner, "applied": receipt.applied});
            if let Some(code) = &receipt.code { out["code"] = json!(code); }
            if !receipt.refused.is_empty() { out["refused"] = json!(receipt.refused); }
            out
        }).collect())
    }
    fn pairs(pairs: &[(String, String)]) -> Value { json!(pairs.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>()) }
    /// Folds a case the way `drive` does: each step sees the payload of the fold so far; a stopped fold asks nobody.
    fn fold_case<F: Fold>(fold: &mut F, steps: &[Value], base: &Value, seen: impl Fn(&Value) -> Value) -> (usize, Vec<Value>) {
        let (mut asked, mut shown) = (0, vec![]);
        for raw in steps {
            if fold.stopped() { break; }
            shown.push(seen(&fold.payload(base)));
            fold.step(&step(raw));
            asked += 1;
        }
        (asked, shown)
    }

    #[test]
    fn scripted_returns_fold_the_same_way_as_in_the_twin() {
        let script: Value = serde_json::from_str(RETURNS).unwrap();
        for case in script["cases"].as_array().unwrap() {
            let label = case["id"].as_str().unwrap();
            let expect = &case["expect"];
            let steps = case["steps"].as_array().unwrap();
            let can: Vec<&str> = case["can"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            match case["event"].as_str().unwrap() {
                "prompt.submit" => {
                    let mut fold = PromptFold::new(case["text"].as_str().unwrap());
                    let (asked, seen) = fold_case(&mut fold, steps, &json!({"text": ""}), |payload| payload["text"].clone());
                    assert_eq!(json!(fold.text), expect["text"], "{label}");
                    assert_eq!(pairs(&fold.contexts), expect["contexts"], "{label}");
                    assert_eq!(json!(fold.rewritten_by), expect["rewrittenBy"], "{label}");
                    assert_eq!(pairs(&fold.notes), expect["notes"], "{label}");
                    assert_eq!(fold.blocked.as_ref().map_or(Value::Null, |blocked| json!({"by": blocked.by, "reason": blocked.reason, "failed": blocked.failed})), expect["blocked"], "{label}");
                    assert_eq!(json!(asked), expect["asked"], "{label}");
                    if let Some(expected) = expect.get("seen") { assert_eq!(&json!(seen), expected, "{label}"); }
                    assert_eq!(receipts(&fold.receipts), expect["receipts"], "{label}");
                }
                "tool.after" => {
                    let mut fold = ToolAfterFold::new(&can, case["output"].clone());
                    let (asked, seen) = fold_case(&mut fold, steps, &json!({"output": case["output"]}), |payload| payload["output"].clone());
                    assert_eq!(fold.output.clone().unwrap_or(Value::Null), expect["output"], "{label}");
                    assert_eq!(json!(fold.by), expect["by"], "{label}");
                    assert_eq!(pairs(&fold.notes), expect["notes"], "{label}");
                    assert_eq!(json!(asked), expect["asked"], "{label}");
                    if let Some(expected) = expect.get("seen") { assert_eq!(&json!(seen), expected, "{label}"); }
                    assert_eq!(receipts(&fold.receipts), expect["receipts"], "{label}");
                }
                "compaction" => {
                    let mut fold = CompactionFold::new(&can);
                    let (asked, _) = fold_case(&mut fold, steps, &json!({}), |payload| payload["can"].clone());
                    assert_eq!(fold.cancel.as_ref().map_or(Value::Null, |(by, reason)| json!({"by": by, "reason": reason})), expect["cancel"], "{label}");
                    assert_eq!(pairs(&fold.instructions), expect["instructions"], "{label}");
                    assert_eq!(pairs(&fold.summaries), expect["summaries"], "{label}");
                    assert_eq!(json!(asked), expect["asked"], "{label}");
                    assert_eq!(receipts(&fold.receipts), expect["receipts"], "{label}");
                }
                other => panic!("{label}: unknown event {other}"),
            }
        }
    }

    #[test]
    fn the_sent_message_carries_attributed_blocks_and_a_block_returns_the_reason() {
        let notes = "Notes added by extensions for this message (not written by the user):\n- [Messenger] CI is flaky.";
        let sent = compose("hello", &[("Recall".into(), "Uses pnpm.\n\nAnd Node 22.".into())], Some(notes));
        assert_eq!(sent, format!("hello\n\n{CONTEXT_HEADING} Recall {NOT_WRITTEN}\nUses pnpm.\nAnd Node 22.\n\n{notes}"));
        assert_eq!(compose("hello", &[], None), "hello");
        assert_eq!(Blocked { by: "Guard".into(), reason: "The message names a secret.".into(), failed: false }.message(), "Not sent: blocked by Guard. The message names a secret.");
        assert_eq!(Blocked { by: "Guard".into(), reason: "Guard did not answer (Timeout).".into(), failed: true }.message(), "Not sent: Guard did not answer (Timeout).");
        assert_eq!(compaction_can("claude"), ["cancel", "instructions"]);
        assert_eq!(compaction_can("codex"), ["cancel"]);
        assert!(!compaction_can("glm").contains(&"summary"));
        assert_eq!(base_name("mcp__pandacode__pandacode_echo"), "pandacode_echo");
        assert_eq!(base_name("pandacode.pandacode_echo"), "pandacode_echo");
    }

    fn registry(grants: &'static [&'static str]) -> (HookRegistry, Arc<Mutex<Vec<Value>>>) {
        let hub = HookRegistry::default();
        hub.set_gate(Arc::new(move |_, _, permission, _| permission == hooks::OBSERVE || grants.contains(&permission)));
        let receipts: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = receipts.clone();
        hub.set_deliver(Arc::new(move |_, frame| { if frame.get("receipt").is_some() { sink.lock().unwrap().push(frame["receipt"].clone()); } Ok(()) }));
        let declarations = hooks::check(&serde_json::from_str(MANIFEST).unwrap()).unwrap();
        for declaration in &declarations { hub.register(OWNER, "1.0.0", &declarations, &declaration.event).unwrap(); }
        (hub, receipts)
    }
    fn facts(task: &str, index: u64, text: &str) -> hooks::RunFacts {
        hooks::RunFacts {
            task_id: task.into(), project_id: "A".into(), project_root: "/work/A".into(), cwd: "/work/A".into(), harness: "claude".into(), model: None, mode: "ask".into(),
            run: json!({"kind": "task"}), index, text: text.into(), attachments: vec![], started_by: json!("user"), transcript_cursor: 0,
        }
    }
    /// A service stand-in: answers each awaited frame with `respond(frame)`; `None` never answers (the sender is kept).
    fn service(respond: impl Fn(&Value) -> Option<Result<Value, String>> + Send + Sync + 'static) -> (Ask, Arc<Mutex<Vec<Value>>>) {
        let frames: Arc<Mutex<Vec<Value>>> = Arc::default();
        let held: Arc<Mutex<Vec<oneshot::Sender<Result<Value, String>>>>> = Arc::default();
        let seen = frames.clone();
        let ask: Ask = Arc::new(move |_, frame| {
            let (sender, receiver) = oneshot::channel();
            seen.lock().unwrap().push(frame.clone());
            match respond(&frame) { Some(answer) => { let _ = sender.send(answer); } None => held.lock().unwrap().push(sender) }
            Ok(receiver)
        });
        (ask, frames)
    }
    fn names() -> Names { Arc::new(|_| "Recall".to_owned()) }

    #[test]
    fn an_awaited_prompt_chain_applies_context_and_a_slow_deny_hook_returns_the_message() {
        tauri::async_runtime::block_on(async {
            let (hub, receipts) = registry(&[CONTEXT, PRESENTATION]);
            let (ask, frames) = service(|frame| {
                let text = frame["payload"]["text"].as_str().unwrap_or_default();
                if text == "slow" { None } else { Some(Ok(json!({"context": format!("About {text}."), "note": "Recalled"}))) }
            });
            let task = format!("ctx-{}", std::process::id());
            let occurrence = HookRegistry::turn_occurrence(&facts(&task, 1, "build"), "prompt.submit", 0);
            let mut fold = PromptFold::new("build");
            assert_eq!(drive(&hub, &ask, &names(), &occurrence, &task, None, &mut fold).await, 1);
            assert_eq!(fold.contexts, [("Recall".to_owned(), "About build.".to_owned())]);
            assert_eq!(fold.notes, [("Recall".to_owned(), "Recalled".to_owned())]);
            let frame = frames.lock().unwrap()[0].clone();
            assert_eq!((frame["observeOnly"].clone(), frame["event"].clone(), frame["hookId"].clone()), (json!(false), json!("prompt.submit"), json!("sample.hook-context/prompt")));
            assert_eq!(receipts.lock().unwrap()[0]["applied"], true);
            // `onFailure: "deny"` and no answer inside the budget: the message is not sent and nothing was applied.
            let mut fold = PromptFold::new("slow");
            drive(&hub, &ask, &names(), &HookRegistry::turn_occurrence(&facts(&task, 2, "slow"), "prompt.submit", 1), &task, None, &mut fold).await;
            assert_eq!(fold.blocked.as_ref().map(|blocked| (blocked.failed, blocked.reason.clone())), Some((true, "Recall did not answer (Timeout).".to_owned())));
            assert!(fold.contexts.is_empty());
        });
    }

    #[test]
    fn a_host_tool_result_rewrite_and_compaction_answers_stay_inside_can() {
        tauri::async_runtime::block_on(async {
            let (hub, receipts) = registry(&[DECIDE]);
            let (ask, frames) = service(|frame| Some(Ok(match frame["event"].as_str().unwrap() {
                "tool.after" => json!({"output": {"rewritten": true}}),
                _ => json!({"instructions": "Keep the API decisions.", "summary": "unused"}),
            })));
            let task = format!("tool-{}", std::process::id());
            let call = json!({"tool": {"kind": "other", "name": "pandacode_echo", "owner": "panda.core"}, "status": "completed", "output": {"echo": "hi"}, "source": "hostTool"});
            let occurrence = Occurrence { event: "tool.after", project: "A".into(), harness: "claude".into(), run: "task".into(), tool_kind: Some("other".into()), paths: vec![], payload: call };
            let mut fold = ToolAfterFold::new(&["rewriteResult"], json!({"echo": "hi"}));
            drive(&hub, &ask, &names(), &occurrence, &task, Some("call-1"), &mut fold).await;
            assert_eq!(fold.output, Some(json!({"rewritten": true})));
            assert_eq!(frames.lock().unwrap()[0]["payload"]["can"], json!(["rewriteResult"]));
            assert_eq!(receipts.lock().unwrap()[0]["callId"], "call-1");
            // Compaction on a harness whose /compact takes no instructions: nothing applies, the receipt says why.
            let occurrence = Occurrence { event: "compaction", project: "A".into(), harness: "codex".into(), run: "task".into(), tool_kind: None, paths: vec![], payload: json!({"phase": "before"}) };
            let mut fold = CompactionFold::new(&compaction_can("codex"));
            drive(&hub, &ask, &names(), &occurrence, &task, None, &mut fold).await;
            assert!(fold.instructions.is_empty() && fold.summaries.is_empty() && fold.cancel.is_none());
            let last = receipts.lock().unwrap().last().cloned().unwrap();
            assert_eq!((last["applied"].clone(), last["code"].clone(), last["refused"].clone()), (json!(false), json!("UnsupportedCapability"), json!({"instructions": "UnsupportedCapability", "summary": "UnsupportedCapability"})));
            assert_eq!(frames.lock().unwrap().last().unwrap()["payload"]["can"], json!(["cancel"]));
        });
    }

    #[test]
    fn since_compaction_resets_once_per_step_with_or_without_a_running_turn() {
        let (hub, _) = registry(&[]);
        let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = seen.clone();
        hub.set_deliver(Arc::new(move |_, frame| { if frame["event"] == "turn.start" { sink.lock().unwrap().push(frame["payload"]["sinceCompaction"].clone()); } Ok(()) }));
        let script: Value = serde_json::from_str(COMPACTION).unwrap();
        let task = format!("since-{}", std::process::id());
        for step in script["steps"].as_array().unwrap() {
            match step["op"].as_str().unwrap() {
                "turn" => {
                    hub.turn_started(facts(&task, step["index"].as_u64().unwrap(), "x"));
                    assert_eq!(seen.lock().unwrap().last().unwrap(), &step["expect"], "turn {}", step["index"]);
                }
                "compaction" => {
                    let published = hub.compacted(&task, step["step"].as_str().unwrap());
                    assert_eq!(published.delivered > 0, step["delivered"] == true, "{step}");
                }
                "end" => { hub.turn_ended(&task, true, None); }
                other => panic!("unknown op {other}"),
            }
        }
    }

    #[test]
    fn a_denied_call_reports_no_invented_output() {
        let run = format!("deny-{}", std::process::id());
        let recorded = super::super::runtime_hook_payload::record(&run, Some("A"), "tool-1", &json!({"command": "rm -rf /"})).unwrap();
        super::super::runtime_hook_payload::open_approval(&run, "req-1", Some("tool-1"), super::super::runtime_hook_payload::Support::BARE);
        answered(&run, "req-1", false);
        assert!(denied(&run, &recorded.call_id));
        let (hub, _) = registry(&[]);
        let delivered: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = delivered.clone();
        hub.set_deliver(Arc::new(move |_, frame| { if frame["event"] == "tool.after" { sink.lock().unwrap().push(frame["payload"].clone()); } Ok(()) }));
        // The registry's own `tool.after` hook is declared in the fixture without filters: a reported call that never
        // got a row is delivered at the end of the turn as denied, with no output.
        hub.turn_started(facts(&run, 1, ""));
        hub.tool_before(&run, &recorded.call_id, &recorded.call_id, "Bash", Some("req-1"), &super::super::runtime_hook_payload::hook_call);
        hub.flush_unpaired(&run, &super::super::runtime_hook_payload::hook_call);
        let after = delivered.lock().unwrap().clone();
        assert_eq!(after.len(), 1);
        assert_eq!((after[0]["status"].clone(), after[0]["output"].clone()), (json!("denied"), Value::Null));
        forget_run(&run);
        super::super::runtime_hook_payload::forget_run(&run);
        assert!(!denied(&run, &recorded.call_id));
    }
}
