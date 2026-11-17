//! One bounded model answer for a package service: `panda.models.call` (runtime phase R7, slice R0704).
//!
//! * **What it is.** One prompt, one answer: no tools, no session kept, no task. The call runs through a signed-in
//!   harness on the provider run path, so it spends the user's sign-in and quota, and the usage log names the calling
//!   package. It is a hidden run: it never creates a task, never appears in the sidebar and adds nothing to the task
//!   named by `taskId` (that id only chooses defaults and the label).
//! * **Isolation by construction.** [`RunRequest`] carries the options and the package name and nothing else: no tool
//!   host, no model tools, no hook registry, no session id. So the auxiliary run offers the model no tool (it cannot
//!   recursively invoke a model tool), delivers no hook (`prompt.submit` and the R0503-R0506 chain never see it, so a
//!   handler that calls a model cannot call itself) and counts as no user task. A harness without a hidden-run path
//!   answers `UnsupportedCapability`; a signed-out or missing one `HostUnavailable`.
//! * **Admission.** Per package two calls run and eight wait; the ninth waiting call answers `LimitExceeded` at once.
//!   Waiting calls start in arrival order. `timeoutMs` (1,000 to 600,000, default 60,000) covers the wait and the run:
//!   past it the call answers `Timeout` and the run is dropped (which ends its process).
//! * **Ending a call.** [`ModelCalls::cancel`] (the service's `AbortSignal`) answers `Cancelled`; [`ModelCalls::revoked`]
//!   (the `models.call` grant was revoked, the package was disabled or its service stopped) ends the package's calls with
//!   `PermissionDenied`; [`ModelCalls::signed_out`] ends the calls that use that harness (or default to one) with
//!   `HostUnavailable`. The grant is rechecked natively when a call arrives, never remembered.
//!
//! Everything here is for fault isolation and predictability (ADR-0005): the named grant is the safeguard, there is no
//! confirmation per call. The credential of the harness is never seen by the package (ADR-0006): only the answer text,
//! the harness and model names and the token counts leave.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{atomic::{AtomicUsize, Ordering}, Arc, LazyLock, Mutex},
    time::Duration,
};
use tokio::sync::{watch, Semaphore};

use crate::extensions::runtime_hook_registration::Gate;

/// The permission a package must hold (global).
pub const PERMISSION: &str = "models.call";
pub const MAX_RUNNING: usize = 2;
pub const MAX_WAITING: usize = 8;
pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
pub const MIN_TIMEOUT_MS: u64 = 1_000;
pub const MAX_TIMEOUT_MS: u64 = 600_000;
/// UTF-8 bytes of `prompt`, `system` and of the answer `text`.
pub const MAX_PROMPT_BYTES: usize = 256 * 1024;
pub const MAX_SYSTEM_BYTES: usize = 64 * 1024;
pub const MAX_ANSWER_BYTES: usize = 256 * 1024;
pub const MAX_LABEL: usize = 128;
pub const MAX_CALL_ID: usize = 64;
/// The usage log keeps this many records (the oldest go first).
pub const MAX_USAGE: usize = 500;
const FIELDS: [&str; 8] = ["prompt", "system", "harness", "model", "effort", "projectId", "taskId", "timeoutMs"];

/// Why a call answered an error: the code of the shared enum and the line the package reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallError { pub code: &'static str, pub message: String }
fn fail(code: &'static str, message: impl Into<String>) -> CallError { CallError { code, message: message.into() } }
impl CallError { pub fn json(&self) -> Value { json!({"ok": false, "code": self.code, "message": self.message}) } }

/// `panda.models.call` options, checked.
#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    pub prompt: String,
    pub system: Option<String>,
    pub harness: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub timeout_ms: u64,
}

fn label(options: &serde_json::Map<String, Value>, key: &str) -> Result<Option<String>, CallError> {
    match options.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if !text.trim().is_empty() && text.chars().count() <= MAX_LABEL => Ok(Some(text.clone())),
        Some(_) => Err(fail("InvalidShape", format!("{key} must be a short non-empty string."))),
    }
}

/// The options of one call. `InvalidShape` for a missing or empty prompt, a field of the wrong type, an unknown field or
/// a timeout outside 1,000 to 600,000 ms (an integer); `LimitExceeded` for a prompt or system text past its size.
pub fn parse(options: &Value) -> Result<Options, CallError> {
    let fields = options.as_object().ok_or_else(|| fail("InvalidShape", "The options must be an object."))?;
    if let Some(unknown) = fields.keys().find(|key| !FIELDS.contains(&key.as_str())) { return Err(fail("InvalidShape", format!("{unknown} is not an option of models.call."))); }
    let prompt = fields.get("prompt").and_then(Value::as_str).filter(|text| !text.trim().is_empty()).ok_or_else(|| fail("InvalidShape", "prompt must be a non-empty string."))?;
    if prompt.len() > MAX_PROMPT_BYTES { return Err(fail("LimitExceeded", format!("The prompt is larger than {} KiB.", MAX_PROMPT_BYTES / 1024))); }
    let system = match fields.get("system") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.len() <= MAX_SYSTEM_BYTES => Some(text.clone()),
        Some(Value::String(_)) => return Err(fail("LimitExceeded", format!("The system text is larger than {} KiB.", MAX_SYSTEM_BYTES / 1024))),
        Some(_) => return Err(fail("InvalidShape", "system must be a string.")),
    };
    let timeout_ms = match fields.get("timeoutMs") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT_MS,
        Some(value) => value.as_u64().filter(|ms| (MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(ms)).ok_or_else(|| fail("InvalidShape", format!("timeoutMs must be an integer from {MIN_TIMEOUT_MS} to {MAX_TIMEOUT_MS}.")))?,
    };
    Ok(Options {
        prompt: prompt.to_owned(), system, timeout_ms,
        harness: label(fields, "harness")?, model: label(fields, "model")?, effort: label(fields, "effort")?,
        project_id: label(fields, "projectId")?, task_id: label(fields, "taskId")?,
    })
}

/// What the hidden run is handed. By construction there is no tool host, no hook registry and no session here.
#[derive(Clone, Debug, PartialEq)]
pub struct RunRequest { pub owner: String, pub package_name: String, pub options: Options }
/// What the hidden run answers: the text, the harness and model that served it and the token counts it reported.
#[derive(Clone, Debug, PartialEq)]
pub struct RunOutput { pub text: String, pub harness: String, pub model: String, pub input: Option<u64>, pub output: Option<u64> }
/// The provider run path of the app (or a stand-in): `HostUnavailable` (signed out, not installed), `UnsupportedCapability`
/// (no hidden-run path for the harness) or `NotFound` (unknown project, task, harness or model). Dropping the future must
/// end the run and its process.
pub type Run = Arc<dyn Fn(RunRequest) -> Pin<Box<dyn Future<Output = Result<RunOutput, &'static str>> + Send>> + Send + Sync>;
/// `(version, display name)` of an enabled, trusted package outside safe mode.
pub type Package = Arc<dyn Fn(&str) -> Option<(String, String)> + Send + Sync>;

/// A served call, as the package receives it.
#[derive(Clone, Debug, PartialEq)]
pub struct Answer { pub text: String, pub harness: String, pub model: String, pub input: Option<u64>, pub output: Option<u64> }
impl Answer {
    pub fn json(&self) -> Value {
        let mut value = json!({"text": self.text, "harness": self.harness, "model": self.model});
        if self.input.is_some() || self.output.is_some() {
            let mut usage = serde_json::Map::new();
            if let Some(input) = self.input { usage.insert("input".into(), json!(input)); }
            if let Some(output) = self.output { usage.insert("output".into(), json!(output)); }
            value["usage"] = Value::Object(usage);
        }
        value
    }
}

/// One line of the usage view: which package spent what, never the prompt or the answer.
#[derive(Clone, Debug, PartialEq)]
pub struct Usage { pub owner: String, pub package_name: String, pub harness: String, pub model: String, pub input: Option<u64>, pub output: Option<u64>, pub task_id: Option<String> }
impl Usage {
    pub fn json(&self) -> Value {
        json!({"kind": "models.call", "owner": self.owner, "package": self.package_name, "harness": self.harness, "model": self.model, "input": self.input, "output": self.output, "taskId": self.task_id})
    }
}

struct Lane { running: Arc<Semaphore>, waiting: AtomicUsize }
struct Live { harness: Option<String>, stop: watch::Sender<Option<&'static str>> }
/// Counters a test or the usage view reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters { pub running: usize, pub waiting: usize, pub live: usize }

type Stop = watch::Receiver<Option<&'static str>>;
async fn stopped(stop: &mut Stop) -> &'static str {
    loop {
        if let Some(reason) = *stop.borrow_and_update() { return reason; }
        if stop.changed().await.is_err() { std::future::pending::<()>().await; }
    }
}

/// Removes the call from the live table and the lane's waiting count however the call ends.
struct Ending<'a> { calls: &'a ModelCalls, key: (String, String) }
impl Drop for Ending<'_> { fn drop(&mut self) { self.calls.live().remove(&self.key); } }
struct Waiting(Arc<Lane>);
impl Drop for Waiting { fn drop(&mut self) { self.0.waiting.fetch_sub(1, Ordering::AcqRel); } }

/// Every call in flight and the wiring to the app. The app has one ([`registry`]); tests build their own.
#[derive(Default)]
pub struct ModelCalls {
    gate: Mutex<Option<Gate>>,
    package: Mutex<Option<Package>>,
    run: Mutex<Option<Run>>,
    lanes: Mutex<BTreeMap<String, Arc<Lane>>>,
    /// `(owner, call id)` of a call in flight.
    live: Mutex<BTreeMap<(String, String), Live>>,
    usage: Mutex<Vec<Usage>>,
}
impl ModelCalls {
    pub fn set_gate(&self, gate: Gate) { if let Ok(mut slot) = self.gate.lock() { *slot = Some(gate); } }
    pub fn set_package(&self, package: Package) { if let Ok(mut slot) = self.package.lock() { *slot = Some(package); } }
    pub fn set_run(&self, run: Run) { if let Ok(mut slot) = self.run.lock() { *slot = Some(run); } }
    fn live(&self) -> std::sync::MutexGuard<'_, BTreeMap<(String, String), Live>> { self.live.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) }
    fn lane(&self, owner: &str) -> Arc<Lane> {
        let mut lanes = self.lanes.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        lanes.entry(owner.to_owned()).or_insert_with(|| Arc::new(Lane { running: Arc::new(Semaphore::new(MAX_RUNNING)), waiting: AtomicUsize::new(0) })).clone()
    }

    /// What a package is running and waiting now.
    pub fn counters(&self, owner: &str) -> Counters {
        let lane = self.lane(owner);
        let live = self.live().keys().filter(|(live_owner, _)| live_owner == owner).count();
        Counters { running: MAX_RUNNING - lane.running.available_permits().min(MAX_RUNNING), waiting: lane.waiting.load(Ordering::Acquire), live }
    }
    /// The usage records, oldest first, optionally of one package.
    pub fn usage(&self, owner: Option<&str>) -> Vec<Usage> {
        self.usage.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).iter().filter(|record| owner.is_none_or(|owner| record.owner == owner)).cloned().collect()
    }

    fn end(&self, owner: &str, matching: impl Fn(&Live) -> bool, reason: &'static str) -> usize {
        let live = self.live();
        let mut ended = 0;
        for ((live_owner, _), call) in live.iter() {
            if live_owner == owner && matching(call) { let _ = call.stop.send(Some(reason)); ended += 1; }
        }
        ended
    }
    /// The service's `AbortSignal` of one call (or the user's cancel): the call answers `Cancelled`.
    pub fn cancel(&self, owner: &str, call_id: &str) -> bool {
        let live = self.live();
        match live.get(&(owner.to_owned(), call_id.to_owned())) { Some(call) => { let _ = call.stop.send(Some("Cancelled")); true } None => false }
    }
    /// The grant was revoked, the package disabled or its service stopped: every call of the package ends with
    /// `PermissionDenied` (a stopped service has nobody to answer, so its calls end the same way).
    pub fn revoked(&self, owner: &str) -> usize { self.end(owner, |_| true, "PermissionDenied") }
    /// A harness signed out: the calls that use it, or default to a harness that may be it, end with `HostUnavailable`.
    pub fn signed_out(&self, harness: &str) -> usize {
        let owners: Vec<String> = self.live().keys().map(|(owner, _)| owner.clone()).collect();
        owners.iter().collect::<std::collections::BTreeSet<_>>().into_iter().map(|owner| self.end(owner, |call| call.harness.as_deref().is_none_or(|used| used == harness), "HostUnavailable")).sum()
    }

    /// One call of `owner`. `call_id` is the service's own id (unique per package while the call lives, at most 64
    /// characters); it is how [`ModelCalls::cancel`] finds the call.
    pub async fn call(&self, owner: &str, call_id: &str, params: &Value) -> Result<Answer, CallError> {
        if call_id.is_empty() || call_id.len() > MAX_CALL_ID { return Err(fail("InvalidShape", "The call id must be 1 to 64 characters.")); }
        let options = parse(params)?;
        let (version, package_name) = self.package.lock().ok().and_then(|slot| slot.clone()).and_then(|package| package(owner)).ok_or_else(|| fail("HostUnavailable", "The package is not enabled."))?;
        // The grant is read from the grants file now: a revoked package never reaches a harness.
        if !self.gate.lock().ok().and_then(|slot| slot.clone()).is_some_and(|gate| gate(owner, &version, PERMISSION, None)) { return Err(fail("PermissionDenied", format!("{package_name} does not hold {PERMISSION}."))); }
        let run = self.run.lock().ok().and_then(|slot| slot.clone()).ok_or_else(|| fail("UnsupportedCapability", "This build has no hidden-run path for a one-shot model call."))?;
        let (stop_tx, mut stop) = watch::channel(None);
        let key = (owner.to_owned(), call_id.to_owned());
        {
            let mut live = self.live();
            if live.contains_key(&key) { return Err(fail("DuplicateId", "A call with this id is already in flight.")); }
            live.insert(key.clone(), Live { harness: options.harness.clone(), stop: stop_tx });
        }
        let _ending = Ending { calls: self, key };
        let lane = self.lane(owner);
        let limit = Duration::from_millis(options.timeout_ms);
        let timeout_ms = options.timeout_ms;
        let task_id = options.task_id.clone();
        let request = RunRequest { owner: owner.to_owned(), package_name: package_name.clone(), options };
        let work = async {
            let _permit = match lane.running.clone().try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => {
                    if lane.waiting.fetch_add(1, Ordering::AcqRel) >= MAX_WAITING {
                        lane.waiting.fetch_sub(1, Ordering::AcqRel);
                        return Err(fail("LimitExceeded", format!("{package_name} already has {MAX_RUNNING} calls running and {MAX_WAITING} waiting.")));
                    }
                    let _waiting = Waiting(lane.clone());
                    tokio::select! {
                        permit = lane.running.clone().acquire_owned() => permit.map_err(|_| fail("HostUnavailable", "The call queue closed."))?,
                        reason = stopped(&mut stop) => return Err(ended(reason, &package_name)),
                    }
                }
            };
            tokio::select! {
                output = run(request) => output.map_err(|code| match code {
                    "UnsupportedCapability" => fail(code, "The harness has no hidden-run path for a one-shot call."),
                    "NotFound" => fail(code, "The project, task, harness or model is not known."),
                    "HostUnavailable" => fail(code, "The harness is signed out or not installed."),
                    other => fail("HostUnavailable", format!("The harness could not answer ({other}).")),
                }),
                reason = stopped(&mut stop) => Err(ended(reason, &package_name)),
            }
        };
        let output = match tokio::time::timeout(limit, work).await {
            Err(_) => return Err(fail("Timeout", format!("The model did not answer within {timeout_ms} ms."))),
            Ok(result) => result?,
        };
        if output.text.len() > MAX_ANSWER_BYTES { return Err(fail("LimitExceeded", format!("The answer is larger than {} KiB.", MAX_ANSWER_BYTES / 1024))); }
        {
            let mut usage = self.usage.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            usage.push(Usage { owner: owner.to_owned(), package_name, harness: output.harness.clone(), model: output.model.clone(), input: output.input, output: output.output, task_id });
            if usage.len() > MAX_USAGE { let excess = usage.len() - MAX_USAGE; usage.drain(..excess); }
        }
        Ok(Answer { text: output.text, harness: output.harness, model: output.model, input: output.input, output: output.output })
    }
}

fn ended(reason: &'static str, package: &str) -> CallError {
    match reason {
        "Cancelled" => fail("Cancelled", "The call was cancelled."),
        "PermissionDenied" => fail("PermissionDenied", format!("{package} no longer holds {PERMISSION}, or its service stopped.")),
        _ => fail("HostUnavailable", "The harness signed out while the call was in flight."),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------------------------------

static REGISTRY: LazyLock<ModelCalls> = LazyLock::new(ModelCalls::default);
static INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// The app's registry.
pub fn registry() -> &'static ModelCalls { &REGISTRY }

/// Wires the app's registry once: the grants file answers every check and the manager says which package is enabled,
/// trusted and outside safe mode. The hidden-run path is attached with [`ModelCalls::set_run`] by the provider run
/// path; until it is, a call answers `UnsupportedCapability` (explicit, never a hang).
fn install(app: &tauri::AppHandle) {
    if INSTALLED.swap(true, Ordering::AcqRel) { return; }
    use tauri::Manager;
    let gated = app.clone();
    REGISTRY.set_gate(Arc::new(move |owner, version, permission, project| gated.try_state::<crate::extensions::runtime_grants::RuntimeGrants>().is_some_and(|grants| crate::extensions::runtime_hook_registration::holds(&grants, owner, version, permission, project))));
    let listing = app.clone();
    REGISTRY.set_package(Arc::new(move |owner: &str| {
        let packages = listing.try_state::<crate::extensions::packages::ExtensionPackages>()?;
        let snapshot = packages.0.lock().ok().and_then(|packages| serde_json::to_value(packages.snapshot()).ok())?;
        if snapshot["safeMode"] == true { return None; }
        snapshot["packages"].as_array()?.iter()
            .find(|package| package["manifest"]["id"] == owner && package["enabled"] == true && package["executable"]["trusted"] == true)
            .and_then(|package| Some((package["manifest"]["version"].as_str()?.to_owned(), package["manifest"]["name"].as_str().filter(|name| !name.trim().is_empty()).unwrap_or(owner).to_owned())))
    }));
}

/// The service requests of this slice: `modelsCall` with `{ op: 'call', callId, options }` or `{ op: 'cancel', callId }`.
/// The owner is the connection's, never the request's.
pub async fn serve(app: tauri::AppHandle, request: crate::extensions::runtime_service_lifetime::DispatchRequest) -> Value {
    install(&app);
    if request.method != "modelsCall" { return crate::extensions::context::failure("UnsupportedCapability"); }
    let (Some(op), Some(call_id)) = (request.params["op"].as_str(), request.params["callId"].as_str()) else { return crate::extensions::context::failure("InvalidShape") };
    match op {
        "cancel" => json!({"ok": true, "value": REGISTRY.cancel(&request.owner, call_id)}),
        "call" => match REGISTRY.call(&request.owner, call_id, &request.params["options"]).await {
            Ok(answer) => json!({"ok": true, "value": answer.json()}),
            Err(error) => crate::extensions::context::failure(error.code),
        },
        _ => crate::extensions::context::failure("InvalidShape"),
    }
}

/// The service of `owner` ended (any reason): its calls end with it.
pub fn service_stopped(owner: &str) { REGISTRY.revoked(owner); }

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Notify;

    const CASES: &str = include_str!("../../../tests/fixtures/extensions/runtime-model-call/cases.json");
    const OWNER: &str = "sample.ask";

    fn cases() -> Value { serde_json::from_str(CASES).unwrap() }
    fn expand(value: &Value) -> Value {
        match value {
            Value::String(text) => match text.strip_prefix("{pad:").and_then(|rest| rest.strip_suffix('}')).and_then(|count| count.parse::<usize>().ok()) { Some(count) => json!("x".repeat(count)), None => value.clone() },
            Value::Array(items) => Value::Array(items.iter().map(expand).collect()),
            Value::Object(fields) => Value::Object(fields.iter().map(|(key, value)| (key.clone(), expand(value))).collect()),
            other => other.clone(),
        }
    }

    /// A registry over the fixture package. `answer` is the scripted harness: it answers `#reply <text>` with the text,
    /// holds every other prompt until `release` is notified, and counts the runs it started.
    fn fixture(granted: bool, release: Arc<Notify>, started: Arc<AtomicUsize>, seen: Arc<Mutex<Vec<RunRequest>>>) -> ModelCalls {
        let calls = ModelCalls::default();
        calls.set_gate(Arc::new(move |owner, _, permission, _| granted && owner == OWNER && permission == PERMISSION));
        calls.set_package(Arc::new(|owner: &str| (owner == OWNER).then(|| ("1.0.0".to_owned(), "Ask".to_owned()))));
        calls.set_run(Arc::new(move |request: RunRequest| {
            let (release, started, seen) = (release.clone(), started.clone(), seen.clone());
            Box::pin(async move {
                started.fetch_add(1, Ordering::AcqRel);
                seen.lock().unwrap().push(request.clone());
                if request.options.harness.as_deref() == Some("no-hidden") { return Err("UnsupportedCapability"); }
                if request.options.harness.as_deref() == Some("signed-out") { return Err("HostUnavailable"); }
                let text = match request.options.prompt.strip_prefix("#reply ") {
                    Some(reply) => reply.to_owned(),
                    None => { release.notified().await; "released".to_owned() }
                };
                Ok(RunOutput { text, harness: request.options.harness.clone().unwrap_or_else(|| "fake-agent".into()), model: "fixture-model".into(), input: Some(11), output: Some(3) })
            }) as Pin<Box<dyn Future<Output = Result<RunOutput, &'static str>> + Send>>
        }));
        calls
    }
    fn parts() -> (Arc<Notify>, Arc<AtomicUsize>, Arc<Mutex<Vec<RunRequest>>>) { (Arc::new(Notify::new()), Arc::new(AtomicUsize::new(0)), Arc::new(Mutex::new(vec![]))) }
    fn block_on<F: Future>(future: F) -> F::Output { tauri::async_runtime::block_on(future) }

    #[test]
    fn options_are_checked_with_the_fixture_cases() {
        for case in cases()["options"].as_array().unwrap() {
            let label = case["id"].as_str().unwrap();
            let result = parse(&expand(&case["options"]));
            match case["expect"]["code"].as_str() {
                None => { let options = result.expect(label); assert_eq!(options.timeout_ms, case["expect"]["timeoutMs"].as_u64().unwrap_or(DEFAULT_TIMEOUT_MS), "{label}"); }
                Some(code) => assert_eq!(result.expect_err(label).code, code, "{label}"),
            }
        }
    }

    #[test]
    fn the_scripted_harness_returns_its_answer_and_usage_names_the_package() {
        let (release, started, seen) = parts();
        let calls = fixture(true, release, started.clone(), seen.clone());
        let answer = block_on(calls.call(OWNER, "c1", &json!({"prompt": "#reply four"}))).unwrap();
        assert_eq!((answer.text.as_str(), answer.harness.as_str(), answer.model.as_str()), ("four", "fake-agent", "fixture-model"));
        assert_eq!(answer.json()["usage"], json!({"input": 11, "output": 3}));
        let usage = calls.usage(Some(OWNER));
        assert_eq!((usage.len(), usage[0].owner.as_str(), usage[0].package_name.as_str()), (1, OWNER, "Ask"));
        assert!(!usage[0].json().to_string().contains("four"), "the usage view never carries the answer");
        assert_eq!(calls.counters(OWNER), Counters::default(), "no call stays behind");
        // The hidden run gets the options and the package name: no tool host, no hook registry, no session, no task.
        assert_eq!(started.load(Ordering::Acquire), 1);
        assert_eq!(seen.lock().unwrap()[0], RunRequest { owner: OWNER.into(), package_name: "Ask".into(), options: parse(&json!({"prompt": "#reply four"})).unwrap() });
    }

    #[test]
    fn two_run_eight_wait_and_the_next_is_refused() {
        let (release, started, seen) = parts();
        let calls = Arc::new(fixture(true, release.clone(), started.clone(), seen));
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let local = tokio::task::LocalSet::new();
            local.run_until(async {
                let mut handles = vec![];
                for index in 0..(MAX_RUNNING + MAX_WAITING) {
                    let calls = calls.clone();
                    handles.push(tokio::task::spawn_local(async move { calls.call(OWNER, &format!("c{index}"), &json!({"prompt": "hold", "timeoutMs": 600_000})).await }));
                    tokio::task::yield_now().await;
                }
                for _ in 0..8 { tokio::task::yield_now().await; }
                assert_eq!(calls.counters(OWNER), Counters { running: MAX_RUNNING, waiting: MAX_WAITING, live: MAX_RUNNING + MAX_WAITING });
                assert_eq!(started.load(Ordering::Acquire), MAX_RUNNING, "only two runs started");
                let refused = calls.call(OWNER, "c-over", &json!({"prompt": "hold"})).await.unwrap_err();
                assert_eq!(refused.code, "LimitExceeded");
                // A waiting call cancelled leaves its place at once; a running one frees its slot for the next.
                assert!(calls.cancel(OWNER, "c9"));
                assert_eq!(handles.pop().unwrap().await.unwrap().unwrap_err().code, "Cancelled");
                assert!(calls.cancel(OWNER, "c0"));
                assert_eq!(handles.remove(0).await.unwrap().unwrap_err().code, "Cancelled");
                for _ in 0..8 { tokio::task::yield_now().await; }
                assert_eq!(started.load(Ordering::Acquire), MAX_RUNNING + 1, "the next waiting call started when a slot freed");
                assert_eq!(calls.revoked(OWNER), MAX_RUNNING + MAX_WAITING - 2);
                for handle in handles { assert_eq!(handle.await.unwrap().unwrap_err().code, "PermissionDenied"); }
                assert_eq!(calls.counters(OWNER), Counters::default());
            }).await;
        });
    }

    #[test]
    fn a_call_ends_deterministically_on_timeout_sign_out_and_missing_paths() {
        let (release, started, seen) = parts();
        let calls = fixture(true, release, started, seen);
        assert_eq!(block_on(calls.call(OWNER, "t", &json!({"prompt": "hold", "timeoutMs": 1_000}))).unwrap_err().code, "Timeout");
        assert_eq!(block_on(calls.call(OWNER, "u", &json!({"prompt": "x", "harness": "no-hidden"}))).unwrap_err().code, "UnsupportedCapability");
        assert_eq!(block_on(calls.call(OWNER, "s", &json!({"prompt": "x", "harness": "signed-out"}))).unwrap_err().code, "HostUnavailable");
        assert_eq!(block_on(calls.call(OWNER, "", &json!({"prompt": "x"}))).unwrap_err().code, "InvalidShape");
        assert_eq!(block_on(calls.call("sample.other", "o", &json!({"prompt": "#reply x"}))).unwrap_err().code, "HostUnavailable");
        assert!(calls.usage(None).is_empty(), "a failed call spends nothing it records");
        let (release, started, seen) = parts();
        let denied = fixture(false, release, started.clone(), seen);
        assert_eq!(block_on(denied.call(OWNER, "d", &json!({"prompt": "#reply x"}))).unwrap_err().code, "PermissionDenied");
        assert_eq!(started.load(Ordering::Acquire), 0, "without models.call no harness is reached");
    }

    #[test]
    fn without_a_hidden_run_path_the_call_answers_unsupported() {
        let calls = ModelCalls::default();
        calls.set_gate(Arc::new(|_, _, _, _| true));
        calls.set_package(Arc::new(|owner: &str| Some(("1.0.0".to_owned(), owner.to_owned()))));
        assert_eq!(block_on(calls.call(OWNER, "a", &json!({"prompt": "x"}))).unwrap_err().code, "UnsupportedCapability");
    }
}
