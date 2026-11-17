//! The granted unstable internal interface (`internal.unstable`, runtime phase R13, slice R1301).
//!
//! A trusted background service reaches the app's own host operations by name with `panda.internal.invoke(command, args)` and
//! subscribes to host events by name with `panda.internal.listen(event, handler)`. It is the last slice of the runtime and it
//! carries no compatibility promise: the names, the arguments and the results change with any release or upstream merge. A
//! package that uses it accepts that; the reference packages never do.
//!
//! The mechanism is the one every other service call uses: the service's request goes to the native dispatcher
//! (`runtime_service_lifetime`, method `internal`), which checks the grants file for the named permission on every call and
//! answers a refusal natively. `listen` is a bounded subscription pumped by the service (the same shape as `terminals.onOutput`):
//! the host keeps the queue, every poll rechecks the grant, and a revoke, a disable, safe mode, an untrust or the service's end
//! removes the listener and its queue.
//!
//! - **Service only.** A rich panel is a webview: `internal.*` answers `UnsupportedCapability` there (`runtime_rich_channel::SERVICE_ONLY`).
//! - **Grant.** `internal.unstable` is global, granted with the trust decision, revocable by the user and never asked again per
//!   action (ADR-0005). Without it, or when it is revoked, the package is disabled or untrusted: `PermissionDenied`, with the
//!   permission name in `path`.
//! - **What a name reaches.** Only the host operations registered in `COMMANDS` and the events registered in `EVENTS`; any other
//!   name is `NotFound`. The table holds inert operations (`internal.info`, `internal.echo`); a host module that wants to be
//!   reachable adds one row. This is the "existing native mechanism" and it is deliberately a table, not a generic router to
//!   every Tauri command: such a router would make every private command name part of the interface.
//! - **Secrets (ADR-0006).** A name that denotes a credential, a token, a secret or a sign-in (`reserved`) is `PermissionDenied`
//!   with the path `credentials`: the value of what PandaCode holds is never handed to a package or a webview, and no table row
//!   may return one. A package gets its own secrets and host-run sign-in through their own named calls.
//! - **Attribution.** Every call is written to the package's activity list: package, operation, name and outcome, never an
//!   argument or a result. The main window reads it (`extensions_internal_activity`); a panel cannot.
//!
//! The rules are pure (an injected clock and grant answer), so they are deterministic to test; the app half (`serve`) only adds the
//! grants file and the package store. Bounds are for reliability and predictability only: 64 KiB of arguments, 16 listeners a
//! package, 64 queued events a listener, 200 activity lines a package.
use serde_json::{json, Map, Value};
use std::{collections::{BTreeMap, VecDeque}, sync::{LazyLock, Mutex}, time::{SystemTime, UNIX_EPOCH}};

use super::runtime_tasks_start::Refusal;

pub const PERMISSION: &str = "internal.unstable";
/// Arguments of one call, as JSON.
pub const ARGS_BYTES: usize = 64 * 1024;
/// Listeners one package may hold at once.
pub const MAX_LISTENERS: usize = 16;
/// Events a listener may have waiting; the oldest goes first and `dropped` says how many.
pub const MAX_QUEUE: usize = 64;
/// Lines of one package's activity list.
pub const MAX_ACTIVITY: usize = 200;
/// How long the service waits between two polls of a listener.
pub const TICK_MS: u64 = 100;
const OPS: [&str; 4] = ["invoke", "listen", "poll", "unlisten"];
/// Fragments that mark a name as holding a credential (ADR-0006).
pub const RESERVED: [&str; 8] = ["secret", "credential", "token", "password", "keychain", "oauth", "signin", "privatekey"];

/// The host operations a service may invoke. Inert: they read nothing a package could not read and change nothing.
pub const COMMANDS: [&str; 2] = ["internal.info", "internal.echo"];
/// The host events a service may listen to.
pub const EVENTS: [&str; 1] = ["internal.echoed"];

fn denied() -> Refusal { Refusal { code: "PermissionDenied".into(), path: PERMISSION.into(), ids: vec![] } }
fn reserved_refusal() -> Refusal { Refusal { code: "PermissionDenied".into(), path: "credentials".into(), ids: vec![] } }
fn name_ok(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.starts_with(|c: char| c.is_ascii_lowercase()) && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-' | ':'))
}
/// Whether `name` denotes something that holds a credential. Separators and case are ignored, so `Sign-In` and `sign_in` both match.
pub fn reserved(name: &str) -> bool {
    let folded: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect();
    RESERVED.iter().any(|part| folded.contains(part))
}

/// A validated call.
#[derive(Clone, Debug, PartialEq)]
pub enum Request {
    Invoke { command: String, args: Value },
    Listen { event: String },
    Poll { listener: String },
    Unlisten { listener: String },
}

/// The operation name of a call.
pub fn op_of(raw: &Value) -> Result<&str, Refusal> {
    raw.as_object().and_then(|object| object.get("op")).and_then(Value::as_str).filter(|op| OPS.contains(op)).ok_or_else(|| "InvalidShape".into())
}

fn text(object: &Map<String, Value>, key: &str) -> Result<String, Refusal> {
    object.get(key).and_then(Value::as_str).filter(|text| !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control)).map(str::to_owned).ok_or_else(|| "InvalidShape".into())
}
fn name(object: &Map<String, Value>, key: &str) -> Result<String, Refusal> {
    let name = object.get(key).and_then(Value::as_str).ok_or("InvalidShape")?;
    if !name_ok(name) { return Err("InvalidShape".into()); }
    Ok(name.to_owned())
}

/// Reads a call: `{op, ...fields}`. Nothing is looked up here, and the permission is checked before this is trusted.
pub fn read_request(raw: &Value) -> Result<Request, Refusal> {
    let object = raw.as_object().ok_or("InvalidShape")?;
    let op = op_of(raw)?;
    let allowed: &[&str] = match op { "invoke" => &["command", "args"], "listen" => &["event"], _ => &["listenerId"] };
    if object.keys().any(|key| key != "op" && !allowed.contains(&key.as_str())) { return Err("InvalidShape".into()); }
    Ok(match op {
        "invoke" => {
            let args = object.get("args").cloned().unwrap_or(Value::Null);
            if args.to_string().len() > ARGS_BYTES { return Err("LimitExceeded".into()); }
            Request::Invoke { command: name(object, "command")?, args }
        }
        "listen" => Request::Listen { event: name(object, "event")? },
        "poll" => Request::Poll { listener: text(object, "listenerId")? },
        _ => Request::Unlisten { listener: text(object, "listenerId")? },
    })
}

/// The order of the checks: the grant answers first (a package without it learns nothing about names), then the credential
/// rule, then the table.
pub fn gate(holds: bool, table: &[&str], name: &str) -> Result<(), Refusal> {
    if !holds { return Err(denied()); }
    if reserved(name) { return Err(reserved_refusal()); }
    if table.contains(&name) { Ok(()) } else { Err("NotFound".into()) }
}

// ---- The operations ----------------------------------------------------------------------------------------------------

/// Runs one registered operation. `internal.echo` answers its arguments and publishes `internal.echoed`: the inert pair that
/// shows invoke and listen end to end.
pub fn run_command(state: &State, command: &str, args: &Value) -> Result<Value, Refusal> {
    match command {
        "internal.info" => Ok(json!({"schemaVersion": 1, "stability": "unstable", "appVersion": env!("CARGO_PKG_VERSION"), "commands": COMMANDS, "events": EVENTS})),
        "internal.echo" => { state.publish("internal.echoed", args.clone()); Ok(json!({"echo": args})) }
        _ => Err("NotFound".into()),
    }
}

// ---- Listeners and the activity list -----------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Listener { pub owner: String, pub version: String, pub event: String, queue: VecDeque<Value>, dropped: u64 }

/// One line of a package's activity list. There is no field for an argument or a result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry { pub at_ms: u64, pub package: String, pub op: String, pub name: String, pub outcome: String }
impl Entry { pub fn value(&self) -> Value { json!({"at": self.at_ms, "package": self.package, "op": self.op, "name": self.name, "outcome": self.outcome, "stability": "unstable"}) } }

#[derive(Default)]
struct Inner { listeners: BTreeMap<String, Listener>, activity: BTreeMap<String, VecDeque<Entry>>, serial: u64 }

/// The listeners of the running services and the activity of every package.
#[derive(Default)]
pub struct State { inner: Mutex<Inner> }
impl State {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, Refusal> { self.inner.lock().map_err(|_| Refusal::new("HostUnavailable")) }
    /// Writes one line of the package's activity list (the oldest goes at 200).
    pub fn record(&self, owner: &str, op: &str, name: &str, outcome: &str, now_ms: u64) {
        let Ok(mut inner) = self.inner.lock() else { return };
        let list = inner.activity.entry(owner.to_owned()).or_default();
        list.push_back(Entry { at_ms: now_ms, package: owner.to_owned(), op: op.to_owned(), name: name.chars().take(64).collect(), outcome: outcome.to_owned() });
        while list.len() > MAX_ACTIVITY { list.pop_front(); }
    }
    pub fn activity(&self, owner: &str) -> Vec<Entry> { self.inner.lock().map(|inner| inner.activity.get(owner).map(|list| list.iter().cloned().collect()).unwrap_or_default()).unwrap_or_default() }
    /// A listener for `event`. A seventeenth of one package is `LimitExceeded`.
    pub fn listen(&self, owner: &str, version: &str, event: &str) -> Result<String, Refusal> {
        let mut inner = self.lock()?;
        if inner.listeners.values().filter(|listener| listener.owner == owner).count() >= MAX_LISTENERS { return Err("LimitExceeded".into()); }
        inner.serial += 1;
        let id = format!("{owner}#internal-{}", inner.serial);
        inner.listeners.insert(id.clone(), Listener { owner: owner.to_owned(), version: version.to_owned(), event: event.to_owned(), queue: VecDeque::new(), dropped: 0 });
        Ok(id)
    }
    /// The package stops listening. Idempotent; another package's id removes nothing.
    pub fn unlisten(&self, owner: &str, id: &str) -> bool {
        let Ok(mut inner) = self.inner.lock() else { return false };
        if inner.listeners.get(id).is_some_and(|listener| listener.owner == owner) { inner.listeners.remove(id).is_some() } else { false }
    }
    /// The host raised `event`: every listener of it queues a copy (at most 64; the oldest goes first).
    pub fn publish(&self, event: &str, payload: Value) -> usize {
        let Ok(mut inner) = self.inner.lock() else { return 0 };
        let mut queued = 0;
        for listener in inner.listeners.values_mut().filter(|listener| listener.event == event) {
            if listener.queue.len() >= MAX_QUEUE { listener.queue.pop_front(); listener.dropped += 1; }
            listener.queue.push_back(payload.clone());
            queued += 1;
        }
        queued
    }
    /// One pump: hands the queued events to the service. `allowed` rechecks the grant of the listener's package: a listener that
    /// is no longer allowed is removed and answers `PermissionDenied`.
    pub fn poll(&self, id: &str, owner: &str, allowed: &dyn Fn(&Listener) -> bool) -> Result<Value, Refusal> {
        let mut inner = self.lock()?;
        let Some(listener) = inner.listeners.get(id).filter(|listener| listener.owner == owner).cloned() else { return Err("NotFound".into()) };
        if !allowed(&listener) { inner.listeners.remove(id); return Err(denied()); }
        let Some(entry) = inner.listeners.get_mut(id) else { return Err("NotFound".into()) };
        let events: Vec<Value> = entry.queue.drain(..).collect();
        let dropped = std::mem::take(&mut entry.dropped);
        Ok(json!({"events": events, "dropped": dropped, "retryMs": TICK_MS}))
    }
    /// The package no longer holds the grant: every listener of it goes.
    pub fn drop_listeners(&self, owner: &str) -> usize {
        let Ok(mut inner) = self.inner.lock() else { return 0 };
        let before = inner.listeners.len();
        inner.listeners.retain(|_, listener| listener.owner != owner);
        before - inner.listeners.len()
    }
    pub fn count(&self, owner: &str) -> usize { self.inner.lock().map_or(0, |inner| inner.listeners.values().filter(|listener| listener.owner == owner).count()) }
}

static STATE: LazyLock<State> = LazyLock::new(State::default);
/// The state of the running app.
pub fn state() -> &'static State { &STATE }
fn unix_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64) }

// ---- The app ---------------------------------------------------------------------------------------------------------

/// The enabled version of the package, or why it may not call.
fn version_of(app: &tauri::AppHandle, owner: &str) -> Result<String, &'static str> {
    use tauri::Manager;
    let packages = app.state::<crate::extensions::packages::ExtensionPackages>();
    let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
    super::runtime_service_lifetime::runtime_usage_resources::enabled_version(&packages, owner).ok_or("PermissionDenied")
}

fn holds(app: &tauri::AppHandle, owner: &str, version: &str) -> bool {
    use tauri::Manager;
    app.try_state::<super::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(owner, version, PERMISSION, &super::runtime_grants::Target::default()).is_ok())
}

/// Serves `internal` of the service of `request.owner`.
pub async fn serve(app: tauri::AppHandle, request: super::runtime_service_lifetime::DispatchRequest) -> Value {
    let owner = request.owner.clone();
    let op = match op_of(&request.params) { Ok(op) => op.to_owned(), Err(refusal) => return refusal.envelope() };
    let version = { let app = app.clone(); let owner = owner.clone(); tauri::async_runtime::spawn_blocking(move || version_of(&app, &owner)).await.unwrap_or(Err("HostUnavailable")) };
    let named = request.params.get("command").or_else(|| request.params.get("event")).and_then(Value::as_str).unwrap_or("").to_owned();
    let answer = match version {
        Ok(version) => { let params = request.params.clone(); let (app, owner) = (app.clone(), owner.clone()); tauri::async_runtime::spawn_blocking(move || run(&app, &owner, &version, &params)).await.unwrap_or_else(|_| Err("HostUnavailable".into())) }
        Err("PermissionDenied") => { state().drop_listeners(&owner); Err(denied()) }
        Err(code) => Err(Refusal::new(code)),
    };
    // Stopping a listener is cleanup, not a use of the interface: it is not written to the activity list.
    if op != "unlisten" && op != "poll" { state().record(&owner, &op, &named, answer.as_ref().map_or_else(|refusal| refusal.code.as_str(), |_| "ok"), unix_ms()); }
    match answer { Ok(value) => json!({"ok": true, "value": value}), Err(refusal) => refusal.envelope() }
}

fn run(app: &tauri::AppHandle, owner: &str, version: &str, params: &Value) -> Result<Value, Refusal> {
    // Stopping a listener is cleanup, never a power: it needs no grant and cannot touch another package's.
    if op_of(params)? == "unlisten" {
        if let Request::Unlisten { listener } = read_request(params)? { state().unlisten(owner, &listener); }
        return Ok(Value::Null);
    }
    let any = holds(app, owner, version);
    if !any { state().drop_listeners(owner); return Err(denied()); }
    match read_request(params)? {
        Request::Invoke { command, args } => {
            gate(any, &COMMANDS, &command)?;
            // The grant is read again just before the operation runs: a revoke in between changes nothing.
            if !holds(app, owner, version) { return Err(denied()); }
            run_command(state(), &command, &args)
        }
        Request::Listen { event } => {
            gate(any, &EVENTS, &event)?;
            let id = state().listen(owner, version, &event)?;
            Ok(json!({"listenerId": id, "intervalMs": TICK_MS}))
        }
        Request::Poll { listener } => {
            let (app_check, owner_id, version_id) = (app.clone(), owner.to_owned(), version.to_owned());
            let allowed = move |entry: &Listener| entry.version == version_id && holds(&app_check, &owner_id, &entry.version) && version_of(&app_check, &owner_id).is_ok();
            state().poll(&listener, owner, &allowed)
        }
        Request::Unlisten { .. } => Ok(Value::Null),
    }
}

/// The service of `owner` stopped (disable, revoke, uninstall, safe mode, untrust, crash, quit): its listeners go.
pub fn service_stopped(_app: &tauri::AppHandle, owner: &str) { state().drop_listeners(owner); }

/// The package's activity list as the webview may see it (main window only): operations, names and outcomes, never an argument
/// or a result.
#[tauri::command]
pub fn extensions_internal_activity(window: tauri::WebviewWindow, id: String) -> Result<Value, String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    if id.is_empty() || id.len() > 128 { return Err("InvalidArguments".into()); }
    Ok(json!({"schemaVersion": 1, "package": id, "stability": "unstable", "items": state().activity(&id).iter().map(Entry::value).collect::<Vec<_>>()}))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "sample.runtime-internal-unstable";
    fn code(result: Result<Request, Refusal>) -> String { result.unwrap_err().code }

    #[test]
    fn every_call_reads_its_fields_and_refuses_the_rest_as_invalid_shape() {
        assert_eq!(read_request(&json!({"op": "invoke", "command": "internal.info"})).unwrap(), Request::Invoke { command: "internal.info".into(), args: Value::Null });
        assert_eq!(read_request(&json!({"op": "invoke", "command": "internal.echo", "args": {"a": 1}})).unwrap(), Request::Invoke { command: "internal.echo".into(), args: json!({"a": 1}) });
        assert_eq!(read_request(&json!({"op": "listen", "event": "internal.echoed"})).unwrap(), Request::Listen { event: "internal.echoed".into() });
        assert_eq!(read_request(&json!({"op": "poll", "listenerId": "x#internal-1"})).unwrap(), Request::Poll { listener: "x#internal-1".into() });
        for raw in [
            json!("x"), json!({}), json!({"op": "call", "command": "a"}), json!({"op": "invoke"}), json!({"op": "invoke", "command": ""}), json!({"op": "invoke", "command": "Internal.Info"}),
            json!({"op": "invoke", "command": "a b"}), json!({"op": "invoke", "command": 3}), json!({"op": "invoke", "command": "a", "extra": 1}), json!({"op": "listen"}),
            json!({"op": "listen", "event": "a", "args": 1}), json!({"op": "poll"}), json!({"op": "unlisten", "listenerId": ""}),
        ] { assert_eq!(code(read_request(&raw)), "InvalidShape", "{raw}"); }
        assert_eq!(code(read_request(&json!({"op": "invoke", "command": "internal.echo", "args": "x".repeat(ARGS_BYTES + 1)}))), "LimitExceeded");
    }

    #[test]
    fn the_grant_answers_first_then_the_credential_rule_then_the_table() {
        let none = gate(false, &COMMANDS, "internal.info").unwrap_err();
        assert_eq!((none.code.as_str(), none.path.as_str()), ("PermissionDenied", "internal.unstable"));
        // A package without the grant learns nothing about names: an unknown name is the same refusal.
        assert_eq!(gate(false, &COMMANDS, "nothing.here").unwrap_err().path, "internal.unstable");
        assert!(gate(true, &COMMANDS, "internal.info").is_ok());
        assert_eq!(gate(true, &COMMANDS, "app.restart").unwrap_err().code, "NotFound");
        assert_eq!(gate(true, &EVENTS, "internal.echoed").is_ok(), true);
        for name in ["secret_store.get", "held-credentials.read", "oauth.token", "auth.sign-in", "keychain.read", "password.reveal", "private_key"] {
            let refusal = gate(true, &COMMANDS, name).unwrap_err();
            assert_eq!((refusal.code.as_str(), refusal.path.as_str()), ("PermissionDenied", "credentials"), "{name}");
        }
        // No registered name is a credential name.
        assert!(COMMANDS.iter().chain(EVENTS.iter()).all(|name| !reserved(name)));
    }

    #[test]
    fn invoke_and_listen_work_end_to_end_through_the_inert_pair() {
        let state = State::default();
        let info = run_command(&state, "internal.info", &Value::Null).unwrap();
        assert_eq!((info["stability"].clone(), info["schemaVersion"].clone()), (json!("unstable"), json!(1)));
        let id = state.listen(OWNER, "1.0.0", "internal.echoed").unwrap();
        let answer = run_command(&state, "internal.echo", &json!({"n": 7})).unwrap();
        assert_eq!(answer["echo"]["n"], 7);
        let first = state.poll(&id, OWNER, &|_| true).unwrap();
        assert_eq!((first["events"].clone(), first["dropped"].clone()), (json!([{"n": 7}]), json!(0)));
        assert_eq!(state.poll(&id, OWNER, &|_| true).unwrap()["events"], json!([]), "delivered once");
        assert_eq!(run_command(&state, "app.restart", &Value::Null).unwrap_err().code, "NotFound");
    }

    #[test]
    fn a_revoked_foreign_or_stopped_listener_is_removed_and_the_queue_is_bounded() {
        let state = State::default();
        let id = state.listen(OWNER, "1.0.0", "internal.echoed").unwrap();
        assert_eq!(state.poll(&id, "sample.other", &|_| true).unwrap_err().code, "NotFound");
        assert!(!state.unlisten("sample.other", &id));
        assert_eq!(state.count(OWNER), 1);
        for number in 0..(MAX_QUEUE + 5) { state.publish("internal.echoed", json!(number)); }
        let page = state.poll(&id, OWNER, &|_| true).unwrap();
        assert_eq!((page["events"].as_array().unwrap().len(), page["dropped"].clone(), page["events"][0].clone()), (MAX_QUEUE, json!(5), json!(5)));
        // The grant went: the next pump removes the listener and names the permission.
        let refusal = state.poll(&id, OWNER, &|_| false).unwrap_err();
        assert_eq!((refusal.code.as_str(), refusal.path.as_str()), ("PermissionDenied", "internal.unstable"));
        assert_eq!(state.count(OWNER), 0);
        // Disable, safe mode and the service's end drop every listener of the package, and only of it.
        for _ in 0..3 { state.listen(OWNER, "1.0.0", "internal.echoed").unwrap(); }
        state.listen("sample.other", "1.0.0", "internal.echoed").unwrap();
        assert_eq!(state.drop_listeners(OWNER), 3);
        assert_eq!((state.count(OWNER), state.count("sample.other")), (0, 1));
        // A seventeenth listener of one package is refused.
        for _ in 0..MAX_LISTENERS { state.listen("sample.many", "1.0.0", "internal.echoed").unwrap(); }
        assert_eq!(state.listen("sample.many", "1.0.0", "internal.echoed").unwrap_err().code, "LimitExceeded");
    }

    #[test]
    fn every_call_is_written_to_the_activity_list_with_no_argument_or_result() {
        let state = State::default();
        state.record(OWNER, "invoke", "internal.echo", "ok", 1);
        state.record(OWNER, "invoke", "secret_store.get", "PermissionDenied", 2);
        state.record("sample.other", "listen", "internal.echoed", "ok", 3);
        let list = state.activity(OWNER);
        assert_eq!(list.len(), 2);
        assert_eq!((list[1].name.as_str(), list[1].outcome.as_str()), ("secret_store.get", "PermissionDenied"));
        assert!(state.activity("sample.other").iter().all(|entry| entry.package == "sample.other"), "a package's list is its own");
        let line = list[0].value();
        assert_eq!(line["stability"], "unstable");
        assert!(line.as_object().unwrap().keys().all(|key| ["at", "package", "op", "name", "outcome", "stability"].contains(&key.as_str())));
        for at in 0..(MAX_ACTIVITY + 10) as u64 { state.record(OWNER, "invoke", "internal.info", "ok", at); }
        assert_eq!(state.activity(OWNER).len(), MAX_ACTIVITY);
    }
}
