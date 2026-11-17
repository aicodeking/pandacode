//! Decisions on `tool.before`: approve, deny with a reason, ask, and rewrite the arguments, through the permission
//! request a harness opens and through "ask at the harness, answer at the host" in `full` mode (runtime phase R5,
//! slice R0505).
//!
//! * **One resolver for every source.** A call reaches `tool.before` through a permission request as it arrives
//!   (source `permissionRequest`, coverage `askedCalls` or `escalationsOnly` as the harness and mode give it), through
//!   ask-at-host in `full` (source `askAtHost`), or later through a companion (R06xx, which hands its calls to the same
//!   fold). The packages whose hook reaches the call and who hold `harness.hooks.decide` for its project and tool kind
//!   are asked one after another (the user's package order, R0506), inside their `budgetMs` and a 60 s
//!   chain; the others receive the call one way. [`DecisionFold`] resolves the answers: a deny ends the chain and wins,
//!   an ask wins over an approve, the first approve applies, rewrites accumulate (each package sees the input as the
//!   earlier ones rewrote it). A failure follows `onFailure` (`continue`, `ask`, `deny`) and never approves.
//! * **What the decision does.** Approve: the host answers the harness at once and the prompt never appears. Deny: the
//!   answer carries the reason where the harness takes one (`denyReason: answer`), or is followed by a live steer with
//!   it (`steer`). Ask, or no decision: the normal host prompt appears, with the package's reason. Rewrite: only where
//!   the source can run new arguments (`rewriteInput` in `can`, the Claude Code stream family and declaring package or
//!   ACP harnesses); elsewhere it is refused with `UnsupportedCapability` and the call goes on as with no decision.
//! * **Mode and sandbox.** `can` is computed natively per call: a call the task's mode forbids outright (`plan` for
//!   anything but reads, searches and fetches), a sandbox escalation (Codex, DeepSeek, Muse), an action no mode approves
//!   (the Claude Code family in `full`) and a request whose approval grants a standing rule (`lastingOnly`) offer only
//!   `deny` and `ask`: a package decides inside the user's mode and sandbox, never around them.
//! * **Ask at the harness, answer at the host.** Only while an enabled package holds an attached `tool.before` hook
//!   for the run's harness and run kind, with `harness.hooks.decide` for its project, a `full` run of a harness without a
//!   companion whose asking mode does not also choose a sandbox ([`ASK_AT_HOST`]) is launched in `ask`; the host then
//!   answers every request at once as `full` would, unless a hook decides otherwise. Removing the hook (dispose, revoke,
//!   disable, safe mode) restores the original launch from the next run; a run already launched keeps answering at the
//!   host until it ends.
//!
//! Everything here is for predictability and fault isolation (ADR-0004, ADR-0005): trust and the named grant are the
//! safeguard; a slow or failing hook never blocks the agent and never approves.
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}};
use tokio::sync::mpsc::WeakUnboundedSender;

use crate::extensions::runtime_hook_context::{Ask, Names, Step, DECIDE, NOTE_BYTES, PRESENTATION, REASON_BYTES};
use crate::extensions::runtime_hook_payload::{self as payloads, Answer, DenyReason, Support};
use crate::extensions::runtime_hook_registration::{self as hooks, HookRegistry, Occurrence, RunFacts, Target};
use crate::providers::{AgentEvent, RunConfig, RunInput, Sink};

pub const EVENT: &str = "tool.before";
pub const PERMISSION_REQUEST: &str = "permissionRequest";
pub const ASK_AT_HOST_SOURCE: &str = "askAtHost";
/// Harnesses whose `full` can be launched as "ask at the harness, answer at the host" (PLAN-contracts, the three
/// sources; the same list `panda.harnesses.list` reports as feasible). Not the Claude Code family and Pi/omp (they have
/// companions), not Codex, DeepSeek and Muse (their mode also selects a sandbox), not Devin and Cursor (not
/// established), not Antigravity (its `full` already asks; the adapter answers it).
pub const ASK_AT_HOST: [&str; 9] = ["opencode", "kilo", "cline", "kimi", "grok", "commandcode", "github-copilot", "hermes", "zcode"];
/// The decisions a `tool.before` handler may return.
pub const DECISIONS: [&str; 4] = ["approve", "deny", "ask", "rewrite"];

// ---------------------------------------------------------------------------------------------------------------
// Sources, coverage and what a call can carry
// ---------------------------------------------------------------------------------------------------------------

/// What a permission request covers for `harness` in `mode` (R0509's table). A request that arrived where the table
/// says none would is reported as `askedCalls`: it was asked. Never `everyCall`: a request covers what the harness
/// chose to ask about.
pub fn request_coverage(harness: &str, mode: &str) -> &'static str {
    match raw_coverage(harness, mode) { "none" => "askedCalls", coverage => coverage }
}
/// R0509's coverage of a permission request, `none` where no request arrives.
pub fn raw_coverage(harness: &str, mode: &str) -> &'static str {
    let package = harness.split_once('/').map(|(owner, _)| owner.to_owned());
    let row = crate::extensions::runtime_harness_coverage::Harness { id: harness.to_owned(), name: harness.to_owned(), package, installed: "Unknown" };
    crate::extensions::runtime_harness_coverage::request_coverage(&row, mode)
}
/// Whether the harness's mode itself holds the approval of what it asks about: a sandbox escalation (Codex,
/// DeepSeek, Muse ask only to leave their sandbox) or the actions no mode approves (the Claude Code family in `full`).
pub fn mode_holds(harness: &str, mode: &str) -> bool {
    matches!(harness, "codex" | "deepseek" | "muse") || (matches!(harness, "claude" | "glm" | "mimo" | "alibaba") && mode == "full")
}
/// `HookCall.can` of one call: what the source carries (R0502's `Support`), without `rewriteInput` for ask-at-host,
/// and without `approve` and `rewriteInput` where the mode or sandbox holds the call: a `plan` call that is not a read,
/// search or fetch, a [`mode_holds`] request, and a request whose approval grants a standing rule.
pub(crate) fn call_can(support: Support, source: &str, harness: &str, mode: &str, kind: &str, lasting: bool) -> Vec<&'static str> {
    let mut can = support.can();
    if source == ASK_AT_HOST_SOURCE { can.retain(|entry| *entry != "rewriteInput"); }
    let held = mode_holds(harness, mode) || lasting || (mode == "plan" && !matches!(kind, "read" | "search" | "fetch"));
    if held { can.retain(|entry| !matches!(*entry, "approve" | "rewriteInput")); }
    can
}
/// The `can` a permission request of `harness` offers in `mode` for a call the mode allows (the capability report).
pub(crate) fn mode_can(support: Support, harness: &str, mode: &str) -> Vec<&'static str> { call_can(support, PERMISSION_REQUEST, harness, mode, "read", false) }
/// Whether a launch of `harness` in `mode` becomes ask-at-host when a deciding hook is held.
pub fn launch_asks(mode: &str, harness: &str) -> bool { mode == "full" && ASK_AT_HOST.contains(&harness) }
/// What happens to one request before any package is asked: `pass` (the normal prompt path, observers are delivered
/// one way by the agent event sink), `approve` (ask-at-host with no deciding package: the host answers as `full`
/// would) or `chain` (deciding packages are asked).
pub fn route(deciders: usize, ask_at_host: bool, auto: bool) -> &'static str {
    if deciders > 0 { "chain" } else if ask_at_host && auto { "approve" } else { "pass" }
}

// ---------------------------------------------------------------------------------------------------------------
// The returns and their fold
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub enum Decision { Approve { reason: Option<String> }, Deny { reason: String }, Ask { reason: Option<String> }, Rewrite { input: Value } }
#[derive(Clone, Debug, PartialEq)]
pub struct Parsed { pub decision: Decision, pub note: Option<String> }

fn one_line(text: &str) -> String { text.split_whitespace().collect::<Vec<_>>().join(" ") }
/// A `ToolDecision`, strictly: `null` is no decision; otherwise an object of `decision`, `reason`, `note`, `input`.
/// The checks run in this order (the twin's too): keys, `reason` (text, at most 4,096 bytes, not blank), `note` (text,
/// at most 512 bytes), `decision`, then `input` (only and always with `rewrite`, at most 1 MiB serialized).
pub fn parse(value: &Value) -> Result<Option<Parsed>, &'static str> {
    if value.is_null() { return Ok(None); }
    let object = value.as_object().ok_or("InvalidShape")?;
    if object.keys().any(|key| !["decision", "reason", "note", "input"].contains(&key.as_str())) { return Err("InvalidShape"); }
    let reason = match object.get("reason") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => {
            if text.len() > REASON_BYTES { return Err("LimitExceeded"); }
            let text = one_line(text);
            if text.is_empty() { return Err("InvalidShape"); }
            Some(text)
        }
        Some(_) => return Err("InvalidShape"),
    };
    let note = match object.get("note") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => { if text.len() > NOTE_BYTES { return Err("LimitExceeded"); } Some(one_line(text)).filter(|note| !note.is_empty()) }
        Some(_) => return Err("InvalidShape"),
    };
    let input = object.get("input").filter(|input| !input.is_null());
    let decision = match object.get("decision").and_then(Value::as_str) {
        Some("approve") => Decision::Approve { reason },
        Some("deny") => Decision::Deny { reason: reason.ok_or("InvalidShape")? },
        Some("ask") => Decision::Ask { reason },
        Some("rewrite") => {
            let input = input.cloned().ok_or("InvalidShape")?;
            if serde_json::to_vec(&input).map_or(usize::MAX, |bytes| bytes.len()) > payloads::COMPLETE_BYTES { return Err("LimitExceeded"); }
            Decision::Rewrite { input }
        }
        _ => return Err("InvalidShape"),
    };
    if input.is_some() && !matches!(decision, Decision::Rewrite { .. }) { return Err("InvalidShape"); }
    Ok(Some(Parsed { decision, note }))
}

/// Who decided: the package id and its display name, the reason, and whether it is the package's failure policy.
#[derive(Clone, Debug, PartialEq)]
pub struct Verdict { pub owner: String, pub name: String, pub reason: Option<String>, pub failed: bool }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role { Approve, Rewrite, Ask, Deny, None }

/// What the host did with one non-empty return (`panda.hooks.onApplied`).
#[derive(Clone, Debug, PartialEq)]
pub struct DecisionReceipt { pub owner: String, pub applied: bool, pub code: Option<String>, pub overridden_by: Option<String>, pub refused: BTreeMap<String, String>, role: Role }
impl DecisionReceipt {
    fn new(owner: &str) -> Self { Self { owner: owner.to_owned(), applied: false, code: None, overridden_by: None, refused: BTreeMap::new(), role: Role::None } }
    fn invalid(owner: &str, code: &str) -> Self { Self { code: Some(code.to_owned()), ..Self::new(owner) } }
    fn refuse(&mut self, key: &str, code: &str) { self.refused.entry(key.to_owned()).or_insert_with(|| code.to_owned()); }
    fn finish(mut self) -> Self {
        if !self.applied && self.code.is_none() { self.code = self.refused.values().next().cloned(); }
        self
    }
    /// `HookReceipt` as the service receives it.
    pub fn json(&self, hook_id: &str, task: &str, call: Option<&str>) -> Value {
        let mut receipt = json!({"schemaVersion": 1, "hookId": hook_id, "event": EVENT, "taskId": task, "applied": self.applied});
        if let Some(call) = call { receipt["callId"] = json!(call); }
        if let Some(code) = &self.code { receipt["code"] = json!(code); }
        if let Some(package) = &self.overridden_by { receipt["overriddenBy"] = json!({"package": package}); }
        if !self.refused.is_empty() { receipt["refused"] = json!(self.refused); }
        receipt
    }
}

/// The resolution of one call.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// Nobody decided: the prompt where one would appear, the call runs where none would (ask-at-host).
    None,
    Approve { by: Verdict, input: Option<Value> },
    Deny(Verdict),
    Ask(Verdict),
}

/// The fold of `tool.before`, one package at a time.
#[derive(Clone, Debug, Default)]
pub struct DecisionFold {
    pub can: Vec<String>,
    /// The last rewritten input (the next package sees it, the harness runs it).
    pub input: Option<Value>,
    pub approved: Option<Verdict>,
    pub rewritten_by: Vec<Verdict>,
    pub asked: Option<Verdict>,
    pub denied: Option<Verdict>,
    /// `(package name, note)`, shown with the package's name.
    pub notes: Vec<(String, String)>,
    pub receipts: Vec<DecisionReceipt>,
}
impl DecisionFold {
    pub fn new(can: &[&str]) -> Self { Self { can: can.iter().map(|entry| (*entry).to_owned()).collect(), ..Self::default() } }
    fn offered(&self, key: &str) -> bool { self.can.iter().any(|entry| entry == key) }
    pub fn stopped(&self) -> bool { self.denied.is_some() }
    /// The payload the next package receives: `can`, and the input as the earlier packages rewrote it.
    pub fn payload(&self, base: &Value) -> Value {
        let mut payload = base.clone();
        payload["can"] = json!(self.can);
        if let (Some(input), Some(object)) = (&self.input, payload.as_object_mut()) {
            object.remove("inputPreview");
            object.insert("input".into(), input.clone());
            object.insert("inputComplete".into(), json!(true));
            object.insert("inputBytes".into(), json!(serde_json::to_vec(input).map_or(0, |bytes| bytes.len())));
        }
        payload
    }
    fn failed(&mut self, step: &Step, code: &str) {
        let verdict = Verdict { owner: step.owner.clone(), name: step.name.clone(), reason: Some(format!("{} did not answer ({code}).", step.name)), failed: true };
        match step.on_failure.as_str() {
            "deny" => self.denied = Some(verdict),
            "ask" => { if self.asked.is_none() { self.asked = Some(verdict); } }
            _ => {}
        }
    }
    pub fn step(&mut self, step: &Step) {
        let value = match &step.answer { Ok(value) => value, Err(code) => { self.failed(step, code); return } };
        let parsed = match parse(value) {
            Ok(None) => return,
            Ok(Some(parsed)) => parsed,
            Err(code) => { self.receipts.push(DecisionReceipt::invalid(&step.owner, code)); self.failed(step, code); return }
        };
        let mut receipt = DecisionReceipt::new(&step.owner);
        if let Some(note) = parsed.note {
            if step.grants.contains(PRESENTATION) { self.notes.push((step.name.clone(), note)); } else { receipt.refuse("note", "PermissionDenied"); }
        }
        if !step.grants.contains(DECIDE) {
            receipt.refuse("decision", "PermissionDenied");
            self.receipts.push(receipt.finish());
            return;
        }
        let verdict = |reason: Option<String>| Verdict { owner: step.owner.clone(), name: step.name.clone(), reason, failed: false };
        match parsed.decision {
            Decision::Deny { reason } => { self.denied = Some(verdict(Some(reason))); receipt.applied = true; receipt.role = Role::Deny; }
            Decision::Ask { reason } => { if self.asked.is_none() { self.asked = Some(verdict(reason)); } receipt.applied = true; receipt.role = Role::Ask; }
            Decision::Approve { reason } => {
                if !self.offered("approve") { receipt.refuse("decision", "UnsupportedCapability"); }
                else { if self.approved.is_none() { self.approved = Some(verdict(reason)); } receipt.applied = true; receipt.role = Role::Approve; }
            }
            Decision::Rewrite { input } => {
                if !self.offered("rewriteInput") { receipt.refuse("decision", "UnsupportedCapability"); }
                else { self.input = Some(input); self.rewritten_by.push(verdict(None)); receipt.applied = true; receipt.role = Role::Rewrite; }
            }
        }
        self.receipts.push(receipt.finish());
    }
    /// A deny wins; then an ask; then the first approve (with the last rewritten input); else no decision.
    pub fn outcome(&self) -> Outcome {
        if let Some(denied) = &self.denied { return Outcome::Deny(denied.clone()); }
        if let Some(asked) = &self.asked { return Outcome::Ask(asked.clone()); }
        match (&self.approved, self.rewritten_by.last()) {
            (Some(approved), _) => Outcome::Approve { by: approved.clone(), input: self.input.clone() },
            (None, Some(rewriter)) => Outcome::Approve { by: rewriter.clone(), input: self.input.clone() },
            (None, None) => Outcome::None,
        }
    }
    /// The receipts once the chain is resolved: an approve or rewrite another package's deny or ask overrode, and an
    /// ask a deny overrode, say who won.
    pub fn settled(&self) -> Vec<DecisionReceipt> {
        let winner = self.denied.as_ref().map(|verdict| (verdict.owner.clone(), true)).or_else(|| self.asked.as_ref().map(|verdict| (verdict.owner.clone(), false)));
        self.receipts.iter().cloned().map(|mut receipt| {
            if let Some((owner, deny)) = &winner {
                let overridden = match receipt.role { Role::Approve | Role::Rewrite => true, Role::Ask => *deny, _ => false };
                if overridden && receipt.owner != *owner { receipt.applied = false; receipt.overridden_by = Some(owner.clone()); }
            }
            receipt
        }).collect()
    }
}

/// What the host does with a request.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Action {
    /// Answer the harness "yes" now; the prompt never appears. `decided_by` is `None` for ask-at-host's own answer.
    Approve(Answer),
    /// Answer "no" now, with the reason where the source carries one.
    Deny(Answer),
    /// Show the normal prompt; the note names the package that asked for it.
    Prompt(Option<String>),
}
/// The action of an outcome. `auto`: ask-at-host may answer this request itself (not a standing rule, not an action
/// that asks in every mode).
pub(crate) fn action(outcome: &Outcome, ask_at_host: bool, auto: bool) -> Action {
    match outcome {
        Outcome::Deny(verdict) => Action::Deny(Answer { approved: false, reason: verdict.reason.clone(), input: None, decided_by: Some(verdict.owner.clone()) }),
        Outcome::Approve { by, input } => Action::Approve(Answer { approved: true, reason: by.reason.clone(), input: input.clone(), decided_by: Some(by.owner.clone()) }),
        Outcome::Ask(verdict) => Action::Prompt(Some(match (&verdict.reason, verdict.failed) {
            (Some(reason), true) => format!("{reason} Decide yourself."),
            (Some(reason), false) => format!("{} asks you to decide: {reason}", verdict.name),
            (None, _) => format!("{} asks you to decide.", verdict.name),
        })),
        Outcome::None if ask_at_host && auto => Action::Approve(Answer::plain(true)),
        Outcome::None => Action::Prompt(None),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Ledgers
// ---------------------------------------------------------------------------------------------------------------

#[derive(Default)]
struct Ledger {
    /// Tasks whose current run was launched ask-at-host.
    asking: BTreeSet<String>,
    /// `(run, host call id)` → the package that decided the call (`tool.after`'s `decidedBy`).
    decided: BTreeMap<(String, String), String>,
    /// Tasks told once that their `full` runs ask at the harness.
    announced: BTreeSet<String>,
}
static LEDGER: Mutex<Option<Ledger>> = Mutex::new(None);
fn ledger<T>(work: impl FnOnce(&mut Ledger) -> T) -> T {
    let mut slot = LEDGER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    work(slot.get_or_insert_with(Ledger::default))
}
const LEDGER_LIMIT: usize = 4_096;

/// Whether the current run of `task` was launched ask-at-host.
pub fn asking(task: &str) -> bool { ledger(|ledger| ledger.asking.contains(task)) }
/// The package that decided a call of the run, for its `tool.after`.
pub fn decided_by(run: &str, call: &str) -> Option<String> { ledger(|ledger| ledger.decided.get(&(run.to_owned(), call.to_owned())).cloned()) }
fn record_decision(run: &str, call: &str, package: &str) {
    ledger(|ledger| { if ledger.decided.len() >= LEDGER_LIMIT { ledger.decided.clear(); } ledger.decided.insert((run.to_owned(), call.to_owned()), package.to_owned()); });
}
/// The run ended (`run_ended`): its decisions and its launch flag go.
pub fn forget_run(run: &str) { ledger(|ledger| { ledger.asking.remove(run); ledger.decided.retain(|(owner, _), _| owner != run); }); }

// ---------------------------------------------------------------------------------------------------------------
// Preparing and resolving one request
// ---------------------------------------------------------------------------------------------------------------

/// `(owner, version, project, tool kind)`: does the package hold `harness.hooks.decide` there (the grant's project and
/// tool-kind narrowing, checked now)?
pub type Decides = Arc<dyn Fn(&str, &str, &str, &str) -> bool + Send + Sync>;
/// How the app (or a test) asks a service, names a package and checks the decide grant.
#[derive(Clone)]
pub struct Env { pub ask: Ask, pub names: Names, pub decides: Decides }

/// A permission request as the sink sees it.
#[derive(Clone, Debug)]
pub struct Request { pub task: String, pub request: String, pub name: String, pub lasting: bool, pub always_ask: bool }
impl Request {
    /// Ask-at-host may answer it itself: not a standing rule, not an action that asks in every mode.
    pub fn auto(&self) -> bool { !self.lasting && !self.always_ask }
}

/// A chain to run for one request.
pub(crate) struct Chain {
    pub occurrence: Occurrence,
    pub deciders: Vec<Target>,
    pub observers: Vec<Target>,
    pub can: Vec<&'static str>,
    pub call: String,
    pub support: Support,
}
pub(crate) enum Prepared { Pass, Approve, Chain(Box<Chain>) }

/// Decides, at once and without waiting, what happens to a request: builds its `HookCall` (complete input, kind,
/// `can`, source and coverage), finds the hooks it reaches and splits them into deciders and observers.
pub(crate) fn prepare(registry: &HookRegistry, decides: &Decides, request: &Request, ask_at_host: bool) -> Prepared {
    let fallback = || match route(0, ask_at_host, request.auto()) { "approve" => Prepared::Approve, _ => Prepared::Pass };
    let Some(call) = payloads::request_call(&request.task, &request.request) else { return fallback() };
    let Some(facts) = registry.run(&request.task) else { return fallback() };
    let support = payloads::support(&request.task, &request.request).unwrap_or(Support::BARE);
    let source = if ask_at_host { ASK_AT_HOST_SOURCE } else { PERMISSION_REQUEST };
    let coverage = if ask_at_host { "askedCalls" } else { request_coverage(&facts.harness, &facts.mode) };
    let base = HookRegistry::call_base(&facts, &request.name, hooks::tool_kind(&request.name), Some(&request.request), source, coverage);
    let Ok(mut payload) = payloads::hook_call(&base, &call) else { return fallback() };
    let (kind, paths) = HookRegistry::complete(&mut payload, &request.name);
    let can = call_can(support, source, &facts.harness, &facts.mode, &kind, request.lasting);
    payload["can"] = json!(can);
    let occurrence = Occurrence {
        event: EVENT, project: facts.project_id.clone(), harness: facts.harness.clone(), run: facts.run["kind"].as_str().unwrap_or("task").to_owned(),
        tool_kind: Some(kind.clone()), paths, payload,
    };
    let (deciders, observers): (Vec<Target>, Vec<Target>) = registry.reach(&occurrence).into_iter().partition(|target| decides(&target.owner, &target.version, &occurrence.project, &kind));
    match route(deciders.len(), ask_at_host, request.auto()) {
        "chain" => {
            // This path reports the call's `tool.before`; the agent event sink must not deliver it again. `targets`
            // counts the occurrence for the run coverage report.
            registry.claim_before(&request.task, &call, &request.name);
            let _ = registry.targets(&occurrence);
            Prepared::Chain(Box::new(Chain { occurrence, deciders, observers, can, call, support }))
        }
        "approve" => {
            // The request never reaches the sink, so the observers get the call here, one way.
            if registry.claim_before(&request.task, &call, &request.name).is_some() {
                let mut one_way = occurrence;
                one_way.payload["can"] = json!([]);
                registry.publish(&one_way);
            }
            Prepared::Approve
        }
        _ => Prepared::Pass,
    }
}

/// Runs a prepared chain: the observers get the call one way, the deciders are asked one after another in the user's
/// package order (R0506) through `runtime_hook_resolution::ask_member` (each inside its budget and the event's
/// ceiling, all inside 60 s; a package removed meanwhile is skipped, not failed; a late answer is never applied), then
/// every non-empty return gets its receipt. A failure counts toward the package's failure notice. Answers the fold.
pub(crate) async fn run_chain(registry: &HookRegistry, env: &Env, chain: &Chain, task: &str) -> DecisionFold {
    use crate::extensions::runtime_hook_resolution::{self as resolution, Asked, Late};
    let _ = payloads::retain(&chain.call);
    let base = &chain.occurrence.payload;
    for observer in &chain.observers {
        let mut payload = base.clone();
        payload["can"] = json!([]);
        let _ = registry.deliver_to(&observer.owner, json!({"schemaVersion": 1, "hookId": observer.declaration.id, "event": EVENT, "observeOnly": true, "payload": payload}));
    }
    let mut fold = DecisionFold::new(&chain.can);
    let started = tokio::time::Instant::now();
    let mut asked: Vec<(String, usize)> = Vec::new();
    for target in &chain.deciders {
        if fold.stopped() { break; }
        // A decide grant revoked or narrowed while the chain runs takes the package out of the deciders (R0506).
        let kind = chain.occurrence.tool_kind.as_deref().unwrap_or("other");
        let deciding = || (env.decides)(&target.owner, &target.version, &chain.occurrence.project, kind);
        if !deciding() { continue; }
        let frame = json!({"schemaVersion": 1, "hookId": target.declaration.id, "event": EVENT, "observeOnly": false, "payload": fold.payload(base)});
        let late = Late { hook_id: target.declaration.id.clone(), event: EVENT.to_owned(), task: task.to_owned(), call: Some(chain.call.clone()) };
        let (answer, reached) = match crate::extensions::runtime_hook_resolution::ask_member(registry, &env.ask, target, &chain.occurrence, frame, started, late).await {
            Asked::Removed => continue,
            Asked::Answered { answer, asked } => (answer, asked),
        };
        if answer.is_err() && !deciding() { continue; }
        let mut grants = BTreeSet::from([DECIDE.to_owned()]);
        if registry.holds(&target.owner, &target.version, PRESENTATION, Some(&chain.occurrence.project)) { grants.insert(PRESENTATION.to_owned()); }
        let before = fold.receipts.len();
        let name = (env.names)(&target.owner);
        fold.step(&Step { owner: target.owner.clone(), name: name.clone(), on_failure: target.declaration.on_failure.clone(), grants, answer: answer.clone() });
        let codes: Vec<Option<String>> = fold.receipts[before..].iter().map(|receipt| receipt.code.clone()).collect();
        resolution::settle(target, EVENT, &name, task, resolution::failure_of(&answer, &codes).as_deref(), reached);
        asked.push((target.declaration.id.clone(), before));
    }
    payloads::release(&chain.call);
    let receipts = fold.settled();
    for (index, (hook_id, before)) in asked.iter().enumerate() {
        let after = asked.get(index + 1).map_or(receipts.len(), |(_, next)| *next);
        for receipt in receipts.iter().take(after).skip(*before) {
            let _ = registry.deliver_to(&receipt.owner, json!({"schemaVersion": 1, "receipt": receipt.json(hook_id, task, Some(&chain.call))}));
        }
    }
    fold
}

/// The owners of attached `tool.before` hooks that make a `full` launch ask at the harness: the hook's `match`
/// accepts the run's harness and run kind, and the package holds `harness.hooks.observe` and, for some tool kind,
/// `harness.hooks.decide` for the run's project.
pub fn holders(registry: &HookRegistry, decides: &Decides, facts: &RunFacts) -> Vec<String> {
    let kind = facts.run["kind"].as_str().unwrap_or("task");
    let mut owners: Vec<String> = registry.attached(EVENT).into_iter().filter(|target| {
        let filter = &target.declaration.matcher;
        filter.harnesses.as_ref().is_none_or(|harnesses| harnesses.contains("*") || harnesses.contains(&facts.harness))
            && filter.runs.as_ref().is_none_or(|runs| runs.contains(kind))
            && registry.holds(&target.owner, &target.version, hooks::OBSERVE, Some(&facts.project_id))
            && hooks::TOOL_KINDS.iter().any(|tool| decides(&target.owner, &target.version, &facts.project_id, tool))
    }).map(|target| target.owner).collect();
    owners.dedup();
    owners
}

// ---------------------------------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------------------------------

fn app_env(app: &tauri::AppHandle) -> Env {
    use tauri::Manager;
    let asking = app.clone();
    let naming = app.clone();
    let granting = app.clone();
    Env {
        ask: Arc::new(move |owner: &str, frame: Value| {
            asking.try_state::<crate::extensions::runtime_service_lifetime::ServiceLifetime>().ok_or("HostUnavailable")?.send_hook(owner, frame)
        }),
        names: Arc::new(move |owner: &str| {
            naming.try_state::<crate::extensions::packages::ExtensionPackages>()
                .and_then(|packages| packages.0.lock().ok().and_then(|packages| serde_json::to_value(packages.snapshot()).ok()))
                .and_then(|snapshot| snapshot["packages"].as_array().and_then(|packages| packages.iter().find(|package| package["manifest"]["id"] == owner).and_then(|package| package["manifest"]["name"].as_str().filter(|name| !name.trim().is_empty()).map(str::to_owned))))
                .unwrap_or_else(|| owner.to_owned())
        }),
        decides: Arc::new(move |owner: &str, version: &str, project: &str, kind: &str| {
            granting.try_state::<crate::extensions::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(owner, version, DECIDE, &crate::extensions::runtime_grants::Target::tool(project, kind)).is_ok())
        }),
    }
}
fn system_line(app: &tauri::AppHandle, task: &str, text: &str) {
    use tauri::{Emitter, Manager};
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    let saved = state.store.lock().ok().map(|store| store.insert_message(task, "system", text));
    if saved.is_some() { let _ = app.emit("sessions-changed", ()); }
}

/// The tool a request asks about: the event's data names it, else the prompt's `Allow <tool>?` line.
fn tool_name(event: &AgentEvent) -> String {
    let data = event.data.clone().unwrap_or(Value::Null);
    if let Some(name) = ["name", "tool_name", "title"].iter().find_map(|key| data[*key].as_str()).filter(|name| !name.is_empty()) { return name.to_owned(); }
    event.text.lines().next().and_then(|line| line.strip_prefix("Allow ")).and_then(|rest| rest.split('?').next()).map(str::trim).filter(|name| !name.is_empty() && name.len() <= 128).unwrap_or("tool").to_owned()
}

struct Wrapped {
    app: tauri::AppHandle,
    inner: Sink,
    input: WeakUnboundedSender<RunInput>,
    stopped: Arc<AtomicBool>,
    task: String,
    ask_at_host: bool,
    env: Env,
    /// Requests whose chain is running → cancelled meanwhile.
    held: Mutex<BTreeMap<String, bool>>,
}
impl Wrapped {
    fn send(&self, input: RunInput) -> bool { self.input.upgrade().is_some_and(|sender| sender.send(input).is_ok()) }
    fn on_event(self: &Arc<Self>, event: AgentEvent) {
        if event.kind == "approval_cancelled" {
            if let Some(id) = &event.request_id { if let Some(cancelled) = self.held.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get_mut(id) { *cancelled = true; } }
            return (self.inner)(event);
        }
        let Some(request_id) = event.request_id.clone().filter(|_| event.kind == "approval") else { return (self.inner)(event) };
        let registry = hooks::registry();
        if !self.ask_at_host && !registry.active() { return (self.inner)(event); }
        let name = tool_name(&event);
        let lasting = event.data.as_ref().is_some_and(|data| data[crate::providers::LASTING_ONLY] == true);
        let always_ask = crate::cloud::deploy::ALWAYS_ASK.contains(&name.as_str());
        let request = Request { task: self.task.clone(), request: request_id.clone(), name, lasting, always_ask };
        match prepare(registry, &self.env.decides, &request, self.ask_at_host) {
            Prepared::Pass => (self.inner)(event),
            Prepared::Approve => { self.send(RunInput::Approval { request_id, approved: true }); }
            Prepared::Chain(chain) => {
                self.held.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(request_id.clone(), false);
                let this = self.clone();
                tauri::async_runtime::spawn(async move {
                    let fold = run_chain(hooks::registry(), &this.env, &chain, &this.task).await;
                    let cancelled = this.held.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&request_id).unwrap_or(false);
                    if cancelled || this.stopped.load(Ordering::SeqCst) { return; }
                    this.apply(event, &request, &chain, &fold);
                });
            }
        }
    }
    fn apply(&self, event: AgentEvent, request: &Request, chain: &Chain, fold: &DecisionFold) {
        for (package, note) in &fold.notes { system_line(&self.app, &self.task, &format!("{package}: {note}")); }
        let label = |answer: &Answer| answer.decided_by.as_deref().map(|owner| (self.env.names)(owner));
        match action(&fold.outcome(), self.ask_at_host, request.auto()) {
            Action::Approve(answer) => {
                let by = label(&answer);
                if answer.decided_by.is_some() {
                    if let Err(error) = payloads::attach(&self.task, &request.request, answer.clone()) {
                        // A request no longer open is gone; anything else keeps the normal prompt.
                        if !error.starts_with("StaleContext") { (self.inner)(event); }
                        return;
                    }
                    if let Some(owner) = &answer.decided_by { record_decision(&self.task, &chain.call, owner); }
                }
                if let Some(by) = by {
                    let rewritten = if answer.input.is_some() { " with rewritten arguments" } else { "" };
                    let reason = answer.reason.as_deref().map(|reason| format!(" {reason}")).unwrap_or_default();
                    system_line(&self.app, &self.task, &format!("{} approved by {by}{rewritten}.{reason}", request.name));
                }
                self.send(RunInput::Approval { request_id: request.request.clone(), approved: true });
            }
            Action::Deny(answer) => {
                let by = label(&answer).unwrap_or_default();
                let reason = answer.reason.clone().unwrap_or_default();
                if let Err(error) = payloads::attach(&self.task, &request.request, answer.clone()) {
                    if error.starts_with("StaleContext") { return; }
                }
                if let Some(owner) = &answer.decided_by { record_decision(&self.task, &chain.call, owner); }
                // The call's `tool.after` reports `denied` with no output (R0504's ledger).
                crate::extensions::runtime_hook_context::answered(&self.task, &request.request, false);
                system_line(&self.app, &self.task, &format!("{} denied by {by}. {reason}", request.name));
                self.send(RunInput::Approval { request_id: request.request.clone(), approved: false });
                if chain.support.deny_reason == DenyReason::Steer && !reason.is_empty() {
                    let (reply, _) = tokio::sync::oneshot::channel();
                    self.send(RunInput::Steer { id: uuid::Uuid::new_v4().to_string(), text: format!("{by} denied {}: {reason}", request.name), reply });
                }
            }
            Action::Prompt(note) => {
                let mut event = event;
                if let Some(note) = note { event.text = format!("{}\n{note}", event.text); }
                (self.inner)(event);
            }
        }
    }
}

/// Wraps a run's launch (`launch_operation_admitted`, before the provider starts): a `full` run becomes ask-at-host
/// while a deciding `tool.before` hook is held ([`holders`]), and the run's event sink resolves each permission request
/// through the hooks before it can become a prompt. With no hook attached, and no ask-at-host launch, the config and
/// the sink are returned unchanged.
pub fn wrap(app: &tauri::AppHandle, mut config: RunConfig, sink: Sink, input: WeakUnboundedSender<RunInput>, stopped: Arc<AtomicBool>) -> (RunConfig, Sink) {
    let task = config.session_id.clone();
    ledger(|ledger| { ledger.asking.remove(&task); });
    let registry = hooks::registry();
    if !registry.active() { return (config, sink); }
    let env = app_env(app);
    let held = if launch_asks(&config.mode, &config.provider) { registry.run(&task).map(|facts| holders(registry, &env.decides, &facts)).unwrap_or_default() } else { vec![] };
    let ask_at_host = !held.is_empty();
    if ask_at_host {
        config.mode = "ask".into();
        let first = ledger(|ledger| { ledger.asking.insert(task.clone()); if ledger.announced.len() >= LEDGER_LIMIT { ledger.announced.clear(); } ledger.announced.insert(task.clone()) });
        if first {
            let names = held.iter().map(|owner| (env.names)(owner)).collect::<Vec<_>>().join(", ");
            system_line(app, &task, &format!("Full access with {names}'s tool hook: the harness asks before each tool and PandaCode answers at once, unless the hook decides otherwise. Without the hook, full access runs as before."));
        }
    }
    let wrapped = Arc::new(Wrapped { app: app.clone(), inner: sink, input, stopped, task, ask_at_host, env, held: Mutex::new(BTreeMap::new()) });
    (config, Arc::new(move |event: AgentEvent| wrapped.on_event(event)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    const DECISIONS_FIXTURE: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-decisions/decisions.json");
    const MODES: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-decisions/modes.json");
    const SCENARIOS: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-decisions/scenarios.json");
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-decisions/extension.json");
    const OWNER: &str = "sample.hook-guard";

    fn step(raw: &Value) -> Step {
        Step {
            owner: raw["owner"].as_str().unwrap().into(), name: raw["name"].as_str().unwrap().into(),
            on_failure: raw["onFailure"].as_str().unwrap_or("continue").into(),
            grants: raw["grants"].as_array().unwrap().iter().map(|grant| grant.as_str().unwrap().to_owned()).collect(),
            answer: match raw["answer"]["error"].as_str() { Some(code) => Err(code.into()), None => Ok(raw["answer"]["value"].clone()) },
        }
    }
    fn receipts(receipts: &[DecisionReceipt]) -> Value {
        Value::Array(receipts.iter().map(|receipt| {
            let mut out = json!({"owner": receipt.owner, "applied": receipt.applied});
            if let Some(code) = &receipt.code { out["code"] = json!(code); }
            if let Some(owner) = &receipt.overridden_by { out["overriddenBy"] = json!(owner); }
            if !receipt.refused.is_empty() { out["refused"] = json!(receipt.refused); }
            out
        }).collect())
    }
    fn outcome_json(outcome: &Outcome) -> Value {
        let verdict = |kind: &str, verdict: &Verdict| json!({"kind": kind, "by": verdict.owner, "reason": verdict.reason, "failed": verdict.failed});
        match outcome {
            Outcome::None => json!({"kind": "none"}),
            Outcome::Approve { by, input } => { let mut out = verdict("approve", by); out["input"] = input.clone().unwrap_or(Value::Null); out }
            Outcome::Deny(by) => verdict("deny", by),
            Outcome::Ask(by) => verdict("ask", by),
        }
    }
    fn action_json(action: &Action) -> Value {
        match action {
            Action::Approve(answer) => json!({"kind": "approve", "decidedBy": answer.decided_by, "reason": answer.reason, "input": answer.input}),
            Action::Deny(answer) => json!({"kind": "deny", "decidedBy": answer.decided_by, "reason": answer.reason}),
            Action::Prompt(note) => json!({"kind": "prompt", "note": note}),
        }
    }

    #[test]
    fn scripted_decisions_resolve_the_same_way_as_in_the_twin() {
        let script: Value = serde_json::from_str(DECISIONS_FIXTURE).unwrap();
        for case in script["cases"].as_array().unwrap() {
            let label = case["id"].as_str().unwrap();
            let can: Vec<&str> = case["can"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
            let mut fold = DecisionFold::new(&can);
            let base = case["payload"].clone();
            let (mut asked, mut seen) = (0, vec![]);
            for raw in case["steps"].as_array().unwrap() {
                if fold.stopped() { break; }
                seen.push(fold.payload(&base)["input"].clone());
                fold.step(&step(raw));
                asked += 1;
            }
            let expect = &case["expect"];
            assert_eq!(outcome_json(&fold.outcome()), expect["outcome"], "{label}");
            assert_eq!(json!(asked), expect["asked"], "{label}");
            assert_eq!(receipts(&fold.settled()), expect["receipts"], "{label}");
            assert_eq!(json!(fold.notes.iter().map(|(name, note)| json!([name, note])).collect::<Vec<_>>()), expect["notes"], "{label}");
            if let Some(expected) = expect.get("seen") { assert_eq!(&json!(seen), expected, "{label}"); }
            for (mode, wanted) in expect["actions"].as_object().into_iter().flatten() {
                let (ask_at_host, auto) = match mode.as_str() { "request" => (false, true), "askAtHost" => (true, true), _ => (true, false) };
                assert_eq!(action_json(&action(&fold.outcome(), ask_at_host, auto)), *wanted, "{label} {mode}");
            }
        }
    }

    #[test]
    fn can_coverage_and_launch_follow_the_shared_table() {
        let table: Value = serde_json::from_str(MODES).unwrap();
        for row in table["calls"].as_array().unwrap() {
            let harness = row["harness"].as_str().unwrap();
            let mode = row["mode"].as_str().unwrap();
            let source = row["source"].as_str().unwrap();
            let support = if harness.contains('/') { payloads::provider_support(&Value::Null) } else { payloads::builtin_support(harness) };
            let can = call_can(support, source, harness, mode, row["kind"].as_str().unwrap(), row["lasting"] == true);
            assert_eq!(json!(can), row["can"], "{row}");
            let coverage = if source == ASK_AT_HOST_SOURCE { "askedCalls" } else { request_coverage(harness, mode) };
            assert_eq!(json!(coverage), row["coverage"], "{row}");
            // A permission request never claims every call.
            assert_ne!(coverage, "everyCall");
        }
        for row in table["launches"].as_array().unwrap() {
            let asks = launch_asks(row["mode"].as_str().unwrap(), row["harness"].as_str().unwrap()) && row["held"] == true;
            assert_eq!(json!(asks), row["asks"], "{row}");
        }
        for (deciders, ask_at_host, auto, expected) in [(1, false, true, "chain"), (0, false, true, "pass"), (0, true, true, "approve"), (0, true, false, "pass"), (2, true, true, "chain")] {
            assert_eq!(route(deciders, ask_at_host, auto), expected);
        }
        // The capability report's feasible ask-at-host harnesses are exactly the ones launched that way.
        for (id, _) in crate::providers::PROVIDERS {
            let row = crate::extensions::runtime_harness_coverage::row(&crate::extensions::runtime_harness_coverage::Harness { id: (*id).into(), name: (*id).into(), package: None, installed: "Unknown" });
            let feasible = row["hooks"]["toolBefore"]["full"]["feasible"].as_array().unwrap().iter().any(|entry| entry["source"] == ASK_AT_HOST_SOURCE);
            assert_eq!(feasible, ASK_AT_HOST.contains(&id), "{id}");
        }
    }

    /// A registry with the fixture package attached (when `attach`), then its observe grant per `observe` (a revoked
    /// grant keeps the hook attached and stops delivery) and its decide grant per `decide`.
    fn registry(observe: bool, decide: bool, attach: bool) -> (HookRegistry, Arc<Mutex<Vec<Value>>>, Decides) {
        let hub = HookRegistry::default();
        let observing = Arc::new(AtomicBool::new(true));
        let gate = observing.clone();
        hub.set_gate(Arc::new(move |_, _, permission, _| (permission == hooks::OBSERVE && gate.load(Ordering::SeqCst)) || (permission == DECIDE && decide) || permission == PRESENTATION));
        let frames: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = frames.clone();
        hub.set_deliver(Arc::new(move |_, frame| { sink.lock().unwrap().push(frame); Ok(()) }));
        if attach {
            let declarations = hooks::check(&serde_json::from_str(MANIFEST).unwrap()).unwrap();
            hub.register(OWNER, "1.0.0", &declarations, EVENT).unwrap();
        }
        observing.store(observe, Ordering::SeqCst);
        let decides: Decides = Arc::new(move |_, _, _, _| decide);
        (hub, frames, decides)
    }
    fn facts(task: &str, harness: &str, mode: &str) -> RunFacts {
        RunFacts {
            task_id: task.into(), project_id: "A".into(), project_root: "/work/A".into(), cwd: "/work/A".into(), harness: harness.into(), model: None, mode: mode.into(),
            run: json!({"kind": "task", "trigger": "user", "executor": "desktop"}), index: 1, text: "clean up".into(), attachments: vec![], started_by: json!("user"), transcript_cursor: 0,
        }
    }
    /// The fixture service's rule (main.cjs): deny `rm -rf`, approve reads, ask on `curl`, rewrite `npm` to `pnpm`.
    fn guard(frame: &Value) -> Result<Value, String> {
        let call = &frame["payload"];
        let command = call["input"]["command"].as_str().unwrap_or_default();
        Ok(if command.contains("rm -rf") { json!({"decision": "deny", "reason": "rm -rf outside the project"}) }
            else if matches!(call["tool"]["kind"].as_str(), Some("read" | "search")) { json!({"decision": "approve"}) }
            else if command.starts_with("curl ") { json!({"decision": "ask", "reason": "network access"}) }
            else if let Some(rest) = command.strip_prefix("npm ") { json!({"decision": "rewrite", "input": {"command": format!("pnpm {rest}")}}) }
            else { Value::Null })
    }
    fn env(frames: Arc<Mutex<Vec<Value>>>, decides: Decides) -> Env {
        Env {
            ask: Arc::new(move |_, frame: Value| { frames.lock().unwrap().push(frame.clone()); let (sender, receiver) = oneshot::channel(); let _ = sender.send(guard(&frame)); Ok(receiver) }),
            names: Arc::new(|_| "Guard".to_owned()),
            decides,
        }
    }
    /// One request of `task` for a call of `harness` with `input`, opened as the adapter opens it.
    fn open(task: &str, call: &str, request: &str, harness: &str, input: Value) {
        payloads::record(task, Some("A"), call, &input).unwrap();
        payloads::open_approval(task, request, Some(call), if harness.contains('/') { payloads::provider_support(&Value::Null) } else { payloads::builtin_support(harness) });
    }

    #[test]
    fn identical_calls_with_no_hook_an_observer_a_decider_and_a_revoked_hook() {
        let script: Value = serde_json::from_str(SCENARIOS).unwrap();
        tauri::async_runtime::block_on(async {
            for (index, case) in script["cases"].as_array().unwrap().iter().enumerate() {
                let label = case["id"].as_str().unwrap();
                let state = case["hook"].as_str().unwrap();
                let (harness, mode) = (case["harness"].as_str().unwrap(), case["mode"].as_str().unwrap());
                let (observe, decide, attach) = match state { "none" => (false, false, false), "observer" => (true, false, true), "decider" => (true, true, true), _ => (false, false, true) };
                let (hub, delivered, decides) = registry(observe, decide, attach);
                let task = format!("decide-{index}-{}", std::process::id());
                hub.turn_started(facts(&task, harness, mode));
                let held = launch_asks(mode, harness) && !holders(&hub, &decides, &facts(&task, harness, mode)).is_empty();
                let launched = if held { "ask" } else { mode };
                let expect = &case["expect"];
                assert_eq!(json!(launched), expect["launchMode"], "{label}");
                let arrives = raw_coverage(harness, launched) != "none";
                assert_eq!(json!(arrives), expect["request"], "{label}");
                if !arrives { payloads::forget_run(&task); continue; }
                open(&task, "c1", "r1", harness, case["input"].clone());
                let request = Request { task: task.clone(), request: "r1".into(), name: case["tool"].as_str().unwrap().into(), lasting: false, always_ask: false };
                let asked: Arc<Mutex<Vec<Value>>> = Arc::default();
                let (route_taken, action_taken) = match prepare(&hub, &decides, &request, held) {
                    Prepared::Pass => ("pass", action(&Outcome::None, held, true)),
                    Prepared::Approve => ("approve", Action::Approve(Answer::plain(true))),
                    Prepared::Chain(chain) => {
                        assert_eq!(chain.occurrence.payload["source"], if held { ASK_AT_HOST_SOURCE } else { PERMISSION_REQUEST }, "{label}");
                        let fold = run_chain(&hub, &env(asked.clone(), decides.clone()), &chain, &task).await;
                        ("chain", action(&fold.outcome(), held, true))
                    }
                };
                assert_eq!(json!(route_taken), expect["route"], "{label}");
                assert_eq!(action_json(&action_taken)["kind"], expect["action"], "{label}");
                assert_eq!(json!(asked.lock().unwrap().len()), expect["awaited"], "{label}");
                // Every awaited frame is a decision frame carrying `can`; one-way frames are observe only.
                assert!(asked.lock().unwrap().iter().all(|frame| frame["observeOnly"] == false && frame["payload"]["can"].as_array().is_some_and(|can| !can.is_empty())), "{label}");
                // A pass leaves the one-way delivery to the agent event sink, as before this slice.
                if route_taken == "pass" { hub.tool_before(&task, &payloads::request_call(&task, "r1").unwrap(), &payloads::request_call(&task, "r1").unwrap(), &request.name, Some("r1"), &payloads::hook_call); }
                let one_way = delivered.lock().unwrap().iter().filter(|frame| frame["event"] == EVENT && frame["observeOnly"] == true).count();
                assert_eq!(json!(one_way), expect["oneWay"], "{label}");
                payloads::forget_run(&task);
                forget_run(&task);
            }
        });
    }

    #[test]
    fn a_deny_carries_its_reason_and_a_rewrite_runs_only_where_supported() {
        tauri::async_runtime::block_on(async {
            let (hub, delivered, decides) = registry(true, true, true);
            let frames: Arc<Mutex<Vec<Value>>> = Arc::default();
            let env = env(frames.clone(), decides.clone());
            let task = format!("deny-{}", std::process::id());
            hub.turn_started(facts(&task, "claude", "ask"));
            // Deny: the reason is attached beside the plain decision and the adapter claims it.
            open(&task, "c1", "r1", "claude", json!({"command": "rm -rf /"}));
            let request = Request { task: task.clone(), request: "r1".into(), name: "Bash".into(), lasting: false, always_ask: false };
            let Prepared::Chain(chain) = prepare(&hub, &decides, &request, false) else { panic!("a decider is attached") };
            assert_eq!(chain.can, ["approve", "deny", "ask", "rewriteInput"]);
            assert_eq!(chain.occurrence.payload["coverage"], "askedCalls");
            let fold = run_chain(&hub, &env, &chain, &task).await;
            let Action::Deny(answer) = action(&fold.outcome(), false, true) else { panic!("denied") };
            payloads::attach(&task, "r1", answer).unwrap();
            let taken = payloads::take(&task, "r1", false);
            assert_eq!((taken.reason.as_deref(), taken.decided_by.as_deref()), (Some("rm -rf outside the project"), Some(OWNER)));
            assert_eq!(delivered.lock().unwrap().iter().filter(|frame| frame.get("receipt").is_some()).count(), 1);
            // The agent event sink does not deliver this call's `tool.before` again.
            let before = delivered.lock().unwrap().len();
            hub.tool_before(&task, &chain.call, &chain.call, "Bash", Some("r1"), &payloads::hook_call);
            assert_eq!(delivered.lock().unwrap().len(), before);
            // Rewrite on Claude Code: approved with the new arguments.
            open(&task, "c2", "r2", "claude", json!({"command": "npm test"}));
            let request = Request { request: "r2".into(), ..request };
            let Prepared::Chain(chain) = prepare(&hub, &decides, &request, false) else { panic!("chain") };
            let fold = run_chain(&hub, &env, &chain, &task).await;
            let Action::Approve(answer) = action(&fold.outcome(), false, true) else { panic!("approved") };
            assert_eq!(answer.input, Some(json!({"command": "pnpm test"})));
            payloads::attach(&task, "r2", answer).unwrap();
            assert_eq!(payloads::take(&task, "r2", true).input, Some(json!({"command": "pnpm test"})));
            payloads::forget_run(&task);
            // The same rewrite on Codex (no rewritten input, an escalation the sandbox holds): nothing applies, the
            // normal prompt appears, the receipt says why.
            let task = format!("codex-{}", std::process::id());
            hub.turn_started(facts(&task, "codex", "ask"));
            open(&task, "c3", "r3", "codex", json!({"command": "npm test"}));
            let request = Request { task: task.clone(), request: "r3".into(), name: "shell".into(), lasting: false, always_ask: false };
            let Prepared::Chain(chain) = prepare(&hub, &decides, &request, false) else { panic!("chain") };
            assert_eq!(chain.can, ["deny", "ask"]);
            assert_eq!(chain.occurrence.payload["coverage"], "escalationsOnly");
            let fold = run_chain(&hub, &env, &chain, &task).await;
            assert_eq!(action(&fold.outcome(), false, true), Action::Prompt(None));
            assert_eq!(fold.settled()[0].code.as_deref(), Some("UnsupportedCapability"));
            payloads::forget_run(&task);
        });
    }

    #[test]
    fn removing_the_hook_restores_the_original_full_launch() {
        let (hub, _, decides) = registry(true, true, true);
        let task = format!("full-{}", std::process::id());
        let run = facts(&task, "opencode", "full");
        hub.turn_started(run.clone());
        assert_eq!(holders(&hub, &decides, &run), [OWNER]);
        hub.unregister(OWNER, EVENT).unwrap();
        assert!(holders(&hub, &decides, &run).is_empty());
        // A revoked decide grant also restores it.
        let (hub, _, decides) = registry(true, false, true);
        hub.turn_started(run.clone());
        assert!(holders(&hub, &decides, &run).is_empty());
        assert!(!launch_asks("full", "codex") && !launch_asks("ask", "opencode") && launch_asks("full", "kimi"));
    }
}
