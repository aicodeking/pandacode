//! Services placed beside remote and headless executors (runtime slice R0108).
//!
//! A package declared `extensionKind: "workspace"` (or `"split"`) acts for the tasks of the computer that executes
//! them. Its background service (R0104) therefore runs on that computer: on a desktop as before, and now also on a
//! headless host (`pandacode serve`), where only workspace-kind code runs (a `ui` package's code belongs to a window
//! and never starts there, Q024). A task whose executor is another computer is never served by this computer's copy
//! of the package: the desktop does not start, retarget or substitute anything for it (`route`).
//!
//! The desktop sees and steers those services through three PandaCode Connect registry methods served by the host:
//!
//! - `extensions.services` (view, read-only): the host's identity, its workspace-kind service rows with their
//!   grants, the attributed activity (hook decisions, controls, grant changes, live UI updates) and the live UI
//!   counts per package. Every row names its package and the host it runs on, so the attribution survives the
//!   projection.
//! - `extensions.serviceControl` (control): Stop and Retry of one service.
//! - `extensions.serviceGrant` (full): grant, revoke or revoke all of a package's permissions on the host.
//!
//! Both writers carry a `requestId`; the host answers a repeated id with the first answer, so a retry after a lost
//! reply or a reconnect never applies twice. The desktop retries once with the same id when the first try may have
//! run. A device's own access (pairing, `view`/`control`/`full`) is decided by the user in Connect; nothing here
//! pairs, approves a device or changes its access. The package must already be installed and trusted on the host.
//!
//! Evidence levels: the fake transport (`Transport`) proves the protocol only; the native fixture proves a real
//! service beside a headless executor; an installed cross-machine run is the only qualification, and it stays
//! pending until two real paired machines are available (`QUALIFICATION`). See
//! `docs/extensions/runtime-executor-placement.md`.
use crate::extensions::{packages::Packages, placement, runtime_grants::{RuntimeGrants, Scope}, runtime_service_lifetime::{self as lifetime, runtime_service_status, ServiceLifetime}};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const SCHEMA_VERSION: u64 = 1;
/// The host's projection of the services placed beside its executor.
pub const SERVICES_METHOD: &str = "extensions.services";
/// Stop or Retry of one service on the host.
pub const CONTROL_METHOD: &str = "extensions.serviceControl";
/// Grant or revoke a package's permission on the host.
pub const GRANT_METHOD: &str = "extensions.serviceGrant";
/// Rows one host reports at most.
pub const MAX_SERVICES: usize = 128;
/// Activity entries kept per host and reported per call.
pub const MAX_ACTIVITY: usize = 64;
/// Longest displayed text (names, status lines, activity summaries), in characters.
pub const MAX_TEXT: usize = 200;
/// Remembered writer answers (by caller and `requestId`) and for how long.
const REQUEST_MEMORY: usize = 256;
const REQUEST_TTL: Duration = Duration::from_secs(600);
/// Hosts the desktop asks at once.
const MAX_HOSTS: usize = 16;
/// How long the desktop waits for a host's projection (it rereads while the list is open).
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(8);
/// Installed cross-machine qualification is never claimed by code: it needs two real paired machines.
pub const QUALIFICATION: &str = "pending";
pub const QUALIFICATION_NOTE: &str = "Installed cross-machine qualification is pending: it needs two real computers already paired by you.";
pub const UNSUPPORTED_HOST: &str = "UnsupportedCapability: that computer's PandaCode does not place extension services yet. Nothing runs here instead.";
pub const OFFLINE: &str = "HostUnavailable: that computer is offline. Its services are not shown and nothing runs here instead.";

// ---- Placement rules ------------------------------------------------------------------------------------------

/// What kind of computer executes tasks here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Executor { Desktop, Headless }
impl Executor {
    pub fn as_str(self) -> &'static str { match self { Self::Desktop => "desktop", Self::Headless => "headless" } }
}

#[cfg(test)]
thread_local! {
    /// Tests only: pretend this thread runs on a headless host (the real flag is process-wide).
    static EXECUTOR: std::cell::Cell<Option<Executor>> = const { std::cell::Cell::new(None) };
}
/// Tests only: run `f` as if this computer were `executor` (on the calling thread).
#[cfg(test)]
pub fn with_executor<T>(executor: Executor, f: impl FnOnce() -> T) -> T {
    EXECUTOR.with(|cell| cell.set(Some(executor)));
    let result = f();
    EXECUTOR.with(|cell| cell.set(None));
    result
}
/// The executor this process is: a `pandacode serve` process is headless.
pub fn this_executor() -> Executor {
    #[cfg(test)]
    if let Some(executor) = EXECUTOR.with(std::cell::Cell::get) { return executor; }
    if crate::headless::active() { Executor::Headless } else { Executor::Desktop }
}

/// `true` when the package's code acts for the tasks of the computer that executes them (`workspace`, `split`).
pub fn beside_executor(manifest: &Value) -> bool { placement::workspace(manifest) }

/// Whether a package's service may run on `executor`: every kind on a desktop (it has a window and executes local
/// tasks); only workspace-kind packages on a headless host, which has no window for `ui` code (Q024 retained).
pub fn runs_on(manifest: &Value, executor: Executor) -> bool {
    match executor { Executor::Desktop => true, Executor::Headless => beside_executor(manifest) }
}

/// The ids of the installed packages whose service may run on this executor (`snapshot` is `extensions_snapshot`
/// JSON). `ServiceLifetime::reconcile` intersects its grant check with this set.
pub fn services_here(snapshot: &Value, executor: Executor) -> BTreeSet<String> {
    snapshot["packages"].as_array().into_iter().flatten()
        .filter(|package| runs_on(&package["manifest"], executor))
        .filter_map(|package| package["manifest"]["id"].as_str().map(str::to_owned)).collect()
}

/// Where package code acting for one task runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    /// The task executes here: this computer's service acts for it.
    Here,
    /// The task executes on that paired computer: only that computer's copy of a workspace-kind package acts for it.
    /// This computer never runs it instead.
    Executor(String),
    /// A `ui` package presents a remote task from the data the desktop already mirrors; it executes nothing for it.
    Presentation,
}
/// The routing rule for a task whose executor is `remote_device` (`None` for a local task).
pub fn route(manifest: &Value, remote_device: Option<&str>) -> Route {
    match remote_device {
        None => Route::Here,
        Some(device) if beside_executor(manifest) => Route::Executor(device.to_owned()),
        Some(_) => Route::Presentation,
    }
}

// ---- Attributed activity -------------------------------------------------------------------------------------

/// What an activity entry reports. Hooks (R05) and live UI slices record through `record_activity`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivityKind { Hook, Ui, Control, Grant, Lifecycle }
impl ActivityKind {
    pub fn as_str(self) -> &'static str {
        match self { Self::Hook => "hook", Self::Ui => "ui", Self::Control => "control", Self::Grant => "grant", Self::Lifecycle => "lifecycle" }
    }
}
struct Activity { seq: u64, owner: String, kind: ActivityKind, summary: String, at: u64 }
static ACTIVITY: Mutex<(u64, VecDeque<Activity>)> = Mutex::new((0, VecDeque::new()));

fn now_millis() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)) }

/// Display text: control characters become spaces, trimmed and bounded to `limit` characters.
pub fn bounded(text: &str, limit: usize) -> String {
    let line: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let line = line.trim();
    if line.chars().count() <= limit { return line.to_owned(); }
    let mut cut: String = line.chars().take(limit.saturating_sub(1)).collect();
    cut = cut.trim_end().to_owned(); cut.push('…'); cut
}

/// Records one attributed activity entry of `owner` on this host (the last `MAX_ACTIVITY` are kept). Answers its
/// sequence number. Nothing secret goes here: a summary is display text only.
pub fn record_activity(owner: &str, kind: ActivityKind, summary: &str) -> u64 {
    let Ok(mut activity) = ACTIVITY.lock() else { return 0 };
    activity.0 += 1;
    let seq = activity.0;
    activity.1.push_back(Activity { seq, owner: bounded(owner, 160), kind, summary: bounded(summary, MAX_TEXT), at: now_millis() });
    while activity.1.len() > MAX_ACTIVITY { activity.1.pop_front(); }
    seq
}
/// The kept activity of `owners`, oldest first, and the newest sequence number of the whole host.
fn activity_for(owners: &BTreeSet<String>) -> (Vec<Value>, u64) {
    let Ok(activity) = ACTIVITY.lock() else { return (vec![], 0) };
    let entries = activity.1.iter().filter(|entry| owners.contains(&entry.owner))
        .map(|entry| json!({"seq": entry.seq, "owner": entry.owner, "kind": entry.kind.as_str(), "summary": entry.summary, "at": entry.at}))
        .collect();
    (entries, activity.0)
}

// ---- Idempotent writers ----------------------------------------------------------------------------------------

static ANSWERS: Mutex<VecDeque<(String, Instant, Value)>> = Mutex::new(VecDeque::new());
fn answer_key(from: &str, method: &str, request_id: &str) -> String { format!("{from}\n{method}\n{request_id}") }
/// The first answer to this caller's `requestId`, marked `replayed`.
fn remembered(key: &str) -> Option<Value> {
    let mut answers = ANSWERS.lock().ok()?;
    answers.retain(|(_, at, _)| at.elapsed() < REQUEST_TTL);
    answers.iter().find(|(stored, ..)| stored == key).map(|(.., reply)| {
        let mut reply = reply.clone();
        if let Some(object) = reply.as_object_mut() { object.insert("replayed".into(), Value::Bool(true)); }
        reply
    })
}
fn remember(key: String, reply: &Value) {
    let Ok(mut answers) = ANSWERS.lock() else { return };
    answers.push_back((key, Instant::now(), reply.clone()));
    while answers.len() > REQUEST_MEMORY { answers.pop_front(); }
}

fn valid_package_id(id: &str) -> bool {
    (1..=160).contains(&id.len()) && !id.starts_with('.') && !id.contains("..") && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}
fn valid_request_id(id: &str) -> bool { (1..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') }
fn package_param(params: &Value) -> Result<String, String> {
    params["id"].as_str().filter(|id| valid_package_id(id)).map(str::to_owned).ok_or_else(|| "InvalidArguments".to_owned())
}
fn request_param(params: &Value) -> Result<String, String> {
    params["requestId"].as_str().filter(|id| valid_request_id(id)).map(str::to_owned).ok_or_else(|| "InvalidArguments".to_owned())
}

// ---- Host side -----------------------------------------------------------------------------------------------

/// What the host side reads. The app builds it from its managed state (`with_host`); tests build it directly.
pub struct HostParts<'a> {
    pub services: &'a ServiceLifetime,
    pub packages: &'a Packages,
    pub grants: &'a RuntimeGrants,
    /// `{deviceId, name, platform, headless}` of this computer.
    pub identity: Value,
    /// `{revision, owners: {id: {items, notices}}}`: the live UI of the host's packages (R0205/R0207).
    pub ui: Value,
}

fn package_snapshot(packages: &Packages) -> Value { serde_json::to_value(packages.snapshot()).unwrap_or(Value::Null) }
/// The installed workspace-kind packages, by id.
fn beside_packages(snapshot: &Value) -> BTreeMap<String, Value> {
    snapshot["packages"].as_array().into_iter().flatten()
        .filter(|package| beside_executor(&package["manifest"]))
        .filter_map(|package| package["manifest"]["id"].as_str().map(|id| (id.to_owned(), package.clone())))
        .take(MAX_SERVICES).collect()
}
fn strings(value: &Value, limit: usize) -> Vec<String> {
    value.as_array().into_iter().flatten().filter_map(Value::as_str).take(limit).map(str::to_owned).collect()
}

/// One attributed row: the service's live state (R0104/R0106/R0107 projection) beside the package's declared and
/// granted permissions on this host.
fn service_row(id: &str, package: &Value, status: &Value, grants: &Value, identity: &Value) -> Value {
    let manifest = &package["manifest"];
    let live = status["services"].as_array().into_iter().flatten().find(|row| row["id"] == id).cloned().unwrap_or(Value::Null);
    let record = grants["packages"].as_array().into_iter().flatten().find(|record| record["id"] == id).cloned().unwrap_or(Value::Null);
    let granted: Vec<String> = record["grants"].as_array().into_iter().flatten().filter_map(|grant| grant["permission"].as_str()).take(64).map(str::to_owned).collect();
    let text = live["status"]["text"].as_str().map(|text| bounded(text, MAX_TEXT));
    json!({
        "id": id,
        "version": manifest["version"],
        "kind": manifest["extensionKind"],
        "enabled": package["enabled"] == true,
        "trusted": package["executable"]["trusted"] == true,
        "declaresService": lifetime::declares_service(manifest),
        "state": live["state"].as_str().unwrap_or("stopped"),
        "held": live["held"] == true,
        "working": live["working"] == true,
        "status": text,
        "restarts": live["restarts"].as_u64().unwrap_or(0),
        "lastStop": live["lastStop"],
        "controls": {"stop": live["controls"]["stop"] == true, "retry": live["controls"]["retry"] == true},
        "declared": strings(&manifest["permissions"], 64),
        "granted": granted,
        "authorized": record["authorized"] == true,
        "attribution": {"package": id, "deviceId": identity["deviceId"], "host": identity["name"]},
    })
}

/// `extensions.services`: the host's identity, its workspace-kind services with their grants, their attributed
/// activity and live UI counts. In safe mode no package is loaded, so no row is reported.
pub fn host_snapshot(parts: &HostParts) -> Value {
    let snapshot = package_snapshot(parts.packages);
    let beside = beside_packages(&snapshot);
    let status = runtime_service_status::status(&parts.services.projection(), &BTreeMap::new(), &parts.identity);
    let grants = parts.grants.projection();
    let services: Vec<Value> = beside.iter().map(|(id, package)| service_row(id, package, &status, &grants, &parts.identity)).collect();
    let owners: BTreeSet<String> = beside.keys().cloned().collect();
    let (activity, seq) = activity_for(&owners);
    let mut ui = Map::new();
    for (owner, counts) in parts.ui["owners"].as_object().into_iter().flatten() {
        if owners.contains(owner) { ui.insert(owner.clone(), json!({"items": counts["items"].as_u64().unwrap_or(0), "notices": counts["notices"].as_u64().unwrap_or(0)})); }
    }
    let ui_revision = parts.ui["revision"].as_u64().unwrap_or(0);
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "host": parts.identity,
        "safeMode": snapshot["safeMode"] == true,
        "services": services,
        "activity": activity,
        "ui": {"revision": ui_revision, "owners": ui},
        // Changes whenever a row, an activity entry, a grant or the live UI changes, so a reader can skip a redraw.
        "revision": format!("{seq}.{ui_revision}.{}", grants["revision"].as_u64().unwrap_or(0)),
    })
}

fn row_for(parts: &HostParts, id: &str) -> Value {
    let snapshot = package_snapshot(parts.packages);
    let status = runtime_service_status::status(&parts.services.projection(), &BTreeMap::new(), &parts.identity);
    beside_packages(&snapshot).get(id).map_or(Value::Null, |package| service_row(id, package, &status, &parts.grants.projection(), &parts.identity))
}
/// A workspace-kind package installed on this host, or `NotFound` (a foreign, a `ui` or an unknown package is never
/// steered from another computer).
fn ensure_beside(parts: &HostParts, id: &str) -> Result<(), String> {
    if beside_packages(&package_snapshot(parts.packages)).contains_key(id) { Ok(()) } else { Err("NotFound".into()) }
}

/// `extensions.serviceControl` `{id, op: "stop" | "retry", requestId}` from the paired device labelled `from`.
/// Stop of a service the user already stopped answers `applied: false`; a repeated `requestId` answers the first
/// answer. Retry clears a stop, a failed start or a parked service and reconciles.
pub fn host_control(parts: &HostParts, from: &str, params: &Value) -> Result<Value, String> {
    let request_id = request_param(params)?;
    let key = answer_key(from, CONTROL_METHOD, &request_id);
    if let Some(reply) = remembered(&key) { return Ok(reply); }
    let id = package_param(params)?;
    let op = params["op"].as_str().filter(|op| matches!(*op, "stop" | "retry")).ok_or("InvalidArguments")?.to_owned();
    ensure_beside(parts, &id)?;
    let applied = if op == "stop" {
        match parts.services.stop(&id) {
            Ok(()) => true,
            Err("Conflict") if row_for(parts, &id)["held"] == true => false,
            Err(code) => return Err(code.into()),
        }
    } else {
        parts.services.retry(&id);
        parts.services.reconcile(parts.packages, parts.grants);
        true
    };
    if applied { record_activity(&id, ActivityKind::Control, &format!("{} requested from {from}", if op == "stop" { "Stop" } else { "Retry" })); }
    let reply = json!({
        "schemaVersion": SCHEMA_VERSION, "id": id, "op": op, "applied": applied, "requestId": request_id,
        "attribution": {"package": id, "deviceId": parts.identity["deviceId"], "host": parts.identity["name"], "from": from},
        "service": row_for(parts, &id),
    });
    remember(key, &reply);
    Ok(reply)
}

/// `extensions.serviceGrant` `{id, op: "grant" | "revoke" | "revokeAll", permission?, scope?, requestId}`. The host's
/// own grant store decides: a permission the package does not declare is `PermissionDenied`, a name outside the
/// vocabulary `UnsupportedCapability`. A granted `runtime.service` starts the service; a revoked one stops it
/// (reason `trust`), as on the desktop.
pub fn host_grant(parts: &HostParts, from: &str, params: &Value) -> Result<Value, String> {
    let request_id = request_param(params)?;
    let key = answer_key(from, GRANT_METHOD, &request_id);
    if let Some(reply) = remembered(&key) { return Ok(reply); }
    let id = package_param(params)?;
    ensure_beside(parts, &id)?;
    parts.grants.sync(&package_snapshot(parts.packages))?;
    let permission = params["permission"].as_str();
    let op = params["op"].as_str().unwrap_or_default().to_owned();
    match (op.as_str(), permission) {
        ("grant", Some(permission)) => {
            let scope = serde_json::from_value::<Scope>(params.get("scope").cloned().unwrap_or_else(|| json!({}))).map_err(|_| "InvalidArguments".to_owned())?;
            parts.grants.grant(&id, permission, scope)?;
        }
        ("revoke", Some(permission)) => parts.grants.revoke(&id, permission)?,
        ("revokeAll", _) => parts.grants.revoke_all(&id)?,
        _ => return Err("InvalidArguments".into()),
    }
    parts.services.reconcile(parts.packages, parts.grants);
    let what = match op.as_str() { "grant" => "granted", "revoke" => "revoked", _ => "all revoked" };
    record_activity(&id, ActivityKind::Grant, &format!("{} {what} from {from}", permission.unwrap_or("Permissions")));
    let reply = json!({
        "schemaVersion": SCHEMA_VERSION, "id": id, "op": op, "permission": permission, "requestId": request_id,
        "attribution": {"package": id, "deviceId": parts.identity["deviceId"], "host": parts.identity["name"], "from": from},
        "service": row_for(parts, &id),
    });
    remember(key, &reply);
    Ok(reply)
}

/// This computer as a host: its Connect device id and name, its platform and whether it is headless.
fn identity(app: &tauri::AppHandle) -> Value {
    json!({"deviceId": crate::remote::extension_placement::this_device(app), "name": crate::remote::extension_placement::device_name(), "platform": std::env::consts::OS, "headless": this_executor() == Executor::Headless})
}
/// Live items (R0205) and notices (R0207) per owner.
fn ui_counts(app: &tauri::AppHandle) -> Value {
    let items = crate::extensions::runtime_dynamic_items::state(app).map_or(Value::Null, |items| items.snapshot());
    let notices = crate::extensions::runtime_notifications::state(app);
    let mut owners = Map::new();
    for (owner, buckets) in items["owners"].as_object().into_iter().flatten() {
        let count: usize = ["menus", "commands", "views", "slashCommands"].iter().map(|bucket| buckets[*bucket].as_array().map_or(0, Vec::len)).sum();
        owners.insert(owner.clone(), json!({"items": count, "notices": notices.as_ref().map_or(0, |notices| notices.count(owner))}));
    }
    let revision = items["revision"].as_u64().unwrap_or(0).saturating_add(notices.as_ref().map_or(0, |notices| notices.revision()));
    json!({"revision": revision, "owners": owners})
}
/// Runs `serve` over the app's managed state.
fn with_host<T>(app: &tauri::AppHandle, serve: impl FnOnce(&HostParts) -> Result<T, String>) -> Result<T, String> {
    use tauri::Manager;
    let services = app.try_state::<ServiceLifetime>().ok_or("HostUnavailable")?;
    let packages = app.try_state::<crate::extensions::packages::ExtensionPackages>().ok_or("HostUnavailable")?;
    let grants = app.try_state::<RuntimeGrants>().ok_or("HostUnavailable")?;
    let (identity, ui) = (identity(app), ui_counts(app));
    let packages = packages.0.lock().map_err(|_| "HostUnavailable".to_owned())?;
    serve(&HostParts { services: &services, packages: &packages, grants: &grants, identity, ui })
}

// ---- Registry methods (served by `remote::host` through `remote::methods`) ------------------------------------

use crate::remote::extension_placement::{Access, Ctx, Method, Reply, Run};

/// Registered as the `extensions` group in `remote/methods/mod.rs`. The device grant gates each call before it runs
/// (`view`, `control`, `full`); the package's own grants are decided by the host's grant store.
pub(crate) const REMOTE_METHODS: &[Method] = &[
    Method { name: SERVICES_METHOD, access: Access::View, read_only: true, parse: parse_services },
    Method { name: CONTROL_METHOD, access: Access::Control, read_only: false, parse: parse_control },
    Method { name: GRANT_METHOD, access: Access::Full, read_only: false, parse: parse_grant },
];

#[derive(Debug)]
struct Services;
#[derive(Debug)]
struct Control(Value);
#[derive(Debug)]
struct Grant(Value);

fn parse_services(params: &Value) -> crate::Result<Box<dyn Run>> {
    if params["apiVersion"] != 1 { return Err(placement::UNSUPPORTED.into()); }
    Ok(Box::new(Services))
}
fn parse_control(params: &Value) -> crate::Result<Box<dyn Run>> {
    let (id, request) = (package_param(params)?, request_param(params)?);
    let op = params["op"].as_str().filter(|op| matches!(*op, "stop" | "retry")).ok_or("InvalidArguments")?;
    Ok(Box::new(Control(json!({"id": id, "op": op, "requestId": request}))))
}
fn parse_grant(params: &Value) -> crate::Result<Box<dyn Run>> {
    let (id, request) = (package_param(params)?, request_param(params)?);
    let op = params["op"].as_str().filter(|op| matches!(*op, "grant" | "revoke" | "revokeAll")).ok_or("InvalidArguments")?;
    let permission = params["permission"].as_str().filter(|name| (1..=64).contains(&name.len()));
    if op != "revokeAll" && permission.is_none() { return Err("InvalidArguments".into()); }
    let scope = params.get("scope").cloned().unwrap_or_else(|| json!({}));
    if scope.to_string().len() > 16 * 1024 { return Err("InvalidArguments".into()); }
    Ok(Box::new(Grant(json!({"id": id, "op": op, "permission": permission, "scope": scope, "requestId": request}))))
}

fn blocking<'a>(ctx: Ctx<'a>, serve: impl FnOnce(&tauri::AppHandle, &str) -> Result<Value, String> + Send + 'static) -> Reply<'a> {
    let app = ctx.app.clone();
    let from = crate::remote::device_label(ctx.from);
    Box::pin(async move { tauri::async_runtime::spawn_blocking(move || serve(&app, &from)).await.map_err(|_| "HostUnavailable".to_owned())? })
}
impl Run for Services {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> { blocking(ctx, |app, _| with_host(app, |parts| Ok(host_snapshot(parts)))) }
}
impl Run for Control {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        let params = self.0;
        blocking(ctx, move |app, from| with_host(app, |parts| host_control(parts, from, &params)))
    }
}
impl Run for Grant {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        let params = self.0;
        blocking(ctx, move |app, from| {
            let reply = with_host(app, |parts| host_grant(parts, from, &params))?;
            // A revoked or narrowed ui.notify / ui.dynamic takes the package's notices and provider changes away, as
            // the desktop grant command does.
            crate::extensions::runtime_notifications::sweep_app(app);
            crate::extensions::runtime_provider_state::sweep_app(app);
            Ok(reply)
        })
    }
}

// ---- Desktop side --------------------------------------------------------------------------------------------

/// A call to a paired host. The app's transport is PandaCode Connect; tests use a fake that proves the protocol only.
pub type Call<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;
pub trait Transport: Send + Sync {
    fn call<'a>(&'a self, device: &'a str, method: &'static str, params: Value) -> Call<'a>;
}
/// PandaCode Connect: the call is sealed for the device, and the host checks the device's grant before it runs.
pub struct AppTransport(pub tauri::AppHandle);
impl Transport for AppTransport {
    fn call<'a>(&'a self, device: &'a str, method: &'static str, params: Value) -> Call<'a> {
        let timeout = if method == SERVICES_METHOD { SNAPSHOT_TIMEOUT } else { crate::remote::extension_placement::TIMEOUT };
        Box::pin(crate::remote::extension_placement::call_within(&self.0, device, method, params, timeout))
    }
}

/// `true` when a failed call may still have reached the host (timed out or lost): the writer is retried once with
/// the same `requestId`, which the host answers from memory if it already ran.
fn maybe_ran(error: &str) -> bool { crate::remote::extension_placement::maybe_ran(error) }

fn pending() -> Value { json!({"installed": QUALIFICATION, "note": QUALIFICATION_NOTE}) }

/// A host that did not answer: listed, unreachable, nothing delivered and qualification pending.
pub fn unavailable(device: &str, name: &str, error: &str) -> Value {
    json!({
        "schemaVersion": SCHEMA_VERSION, "deviceId": device, "reachable": false,
        "host": {"placement": "remote", "deviceId": device, "name": bounded(name, 64), "platform": null, "headless": null},
        "services": [], "activity": [], "ui": {"revision": 0, "owners": {}}, "revision": null,
        "error": bounded(error, MAX_TEXT), "qualification": pending(),
    })
}
fn classify(error: &str) -> String {
    if error.contains("Unknown method") || error.starts_with("UnsupportedCapability") { UNSUPPORTED_HOST.into() } else { error.to_owned() }
}

/// Reads a host's `extensions.services` answer strictly. The host must be the computer asked and every row must be
/// attributed to its own package on that computer; anything else is `StaleContext` and shows nothing.
pub fn read_host(device: &str, reply: &Value) -> Result<Value, String> {
    if reply["schemaVersion"] != SCHEMA_VERSION || reply["host"]["deviceId"] != device { return Err("StaleContext".into()); }
    let rows = reply["services"].as_array().ok_or("StaleContext")?;
    if rows.len() > MAX_SERVICES { return Err("LimitExceeded".into()); }
    let mut services = Vec::with_capacity(rows.len());
    let mut owners = BTreeSet::new();
    for row in rows {
        let id = row["id"].as_str().filter(|id| valid_package_id(id)).ok_or("StaleContext")?;
        if row["attribution"]["package"] != id || row["attribution"]["deviceId"] != device || !owners.insert(id.to_owned()) { return Err("StaleContext".into()); }
        let mut row = row.clone();
        if let Some(object) = row.as_object_mut() {
            if let Some(text) = object.get("status").and_then(Value::as_str).map(|text| bounded(text, MAX_TEXT)) { object.insert("status".into(), json!(text)); }
            object.insert("attribution".into(), json!({"package": id, "deviceId": device, "host": bounded(reply["host"]["name"].as_str().unwrap_or_default(), 64)}));
        }
        services.push(row);
    }
    let activity: Vec<Value> = reply["activity"].as_array().into_iter().flatten()
        .filter(|entry| entry["owner"].as_str().is_some_and(|owner| owners.contains(owner)))
        .rev().take(MAX_ACTIVITY).collect::<Vec<_>>().into_iter().rev()
        .map(|entry| json!({"seq": entry["seq"], "owner": entry["owner"], "kind": entry["kind"], "summary": bounded(entry["summary"].as_str().unwrap_or_default(), MAX_TEXT), "at": entry["at"]}))
        .collect();
    let mut ui = Map::new();
    for (owner, counts) in reply["ui"]["owners"].as_object().into_iter().flatten() {
        if owners.contains(owner) { ui.insert(owner.clone(), json!({"items": counts["items"].as_u64().unwrap_or(0), "notices": counts["notices"].as_u64().unwrap_or(0)})); }
    }
    Ok(json!({
        "schemaVersion": SCHEMA_VERSION, "deviceId": device, "reachable": true,
        "host": {"placement": "remote", "deviceId": device, "name": bounded(reply["host"]["name"].as_str().unwrap_or_default(), 64), "platform": reply["host"]["platform"].as_str().map(|text| bounded(text, 32)), "headless": reply["host"]["headless"] == true},
        "safeMode": reply["safeMode"] == true,
        "services": services, "activity": activity, "ui": {"revision": reply["ui"]["revision"].as_u64().unwrap_or(0), "owners": ui},
        "revision": reply["revision"].as_str().map(|text| bounded(text, 64)),
        "error": null, "qualification": pending(),
    }))
}

/// One host's services, or an unavailable host (pending, never delivered).
pub async fn executor_services(transport: &dyn Transport, device: &str, name: &str) -> Value {
    match transport.call(device, SERVICES_METHOD, json!({"apiVersion": 1})).await {
        Ok(reply) => read_host(device, &reply).unwrap_or_else(|code| unavailable(device, name, &code)),
        Err(error) => unavailable(device, name, &classify(&error)),
    }
}

/// A writer call, retried once with the same `requestId` when the first try may have run.
async fn call_once(transport: &dyn Transport, device: &str, method: &'static str, params: Value) -> Result<Value, String> {
    match transport.call(device, method, params.clone()).await {
        Err(error) if maybe_ran(&error) => transport.call(device, method, params).await,
        other => other,
    }
}
fn attributed(device: &str, id: &str, reply: Value) -> Result<Value, String> {
    if reply["id"] != id || reply["attribution"]["package"] != id || reply["attribution"]["deviceId"] != device { return Err("StaleContext".into()); }
    Ok(reply)
}

/// Stop or Retry of one service on a paired host.
pub async fn executor_control(transport: &dyn Transport, device: &str, id: &str, op: &str, request_id: &str) -> Result<Value, String> {
    if !valid_package_id(id) || !valid_request_id(request_id) || !matches!(op, "stop" | "retry") { return Err("InvalidArguments".into()); }
    let reply = call_once(transport, device, CONTROL_METHOD, json!({"id": id, "op": op, "requestId": request_id})).await.map_err(|error| classify(&error))?;
    attributed(device, id, reply)
}

/// Grant or revoke a package's permission on a paired host (`request` is `{op, id, permission?, scope?, requestId}`).
pub async fn executor_grant(transport: &dyn Transport, device: &str, request: &Value) -> Result<Value, String> {
    let id = package_param(request)?;
    request_param(request)?;
    let reply = call_once(transport, device, GRANT_METHOD, request.clone()).await.map_err(|error| classify(&error))?;
    attributed(device, &id, reply)
}

fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    Ok(())
}
fn valid_device(device: &str) -> Result<(), String> {
    if (1..=128).contains(&device.len()) && device.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) { Ok(()) } else { Err("InvalidArguments".into()) }
}

/// The services placed beside the executors of this account's other computers: one entry per paired host computer
/// (offline or older ones are listed as unavailable; nothing runs here instead). Main window only.
#[tauri::command]
pub async fn extensions_executor_services(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    main_window(&window)?;
    // Not signed in to Connect, or no paired computer: nothing to show.
    let devices = crate::remote::remote_devices(app.clone()).await.unwrap_or_default();
    let hosts: Vec<(String, String, bool)> = devices.iter()
        .filter(|device| device["host"] == true && device["current"] != true)
        .filter_map(|device| Some((device["id"].as_str()?.to_owned(), device["name"].as_str().unwrap_or_default().to_owned(), device["online"] == true)))
        .take(MAX_HOSTS).collect();
    let transport = AppTransport(app.clone());
    let transport = &transport;
    let rows = futures_util::future::join_all(hosts.iter().map(|(device, name, online)| async move {
        if *online { executor_services(transport, device, name).await } else { unavailable(device, name, OFFLINE) }
    })).await;
    Ok(json!({"schemaVersion": SCHEMA_VERSION, "hosts": rows, "qualification": pending()}))
}

/// Stop or Retry a service on a paired host. Main window only.
#[tauri::command]
pub async fn extensions_executor_service_control(app: tauri::AppHandle, window: tauri::WebviewWindow, device_id: String, id: String, op: String, request_id: String) -> Result<Value, String> {
    main_window(&window)?;
    valid_device(&device_id)?;
    executor_control(&AppTransport(app), &device_id, &id, &op, &request_id).await
}

/// Grant or revoke a package's permission on a paired host. Main window only.
#[tauri::command]
pub async fn extensions_executor_grant(app: tauri::AppHandle, window: tauri::WebviewWindow, device_id: String, request: Value) -> Result<Value, String> {
    main_window(&window)?;
    valid_device(&device_id)?;
    executor_grant(&AppTransport(app), &device_id, &request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::packages::ExtensionPackages;
    use std::io::Write;
    use std::sync::Arc;

    pub(super) const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-executor-placement/extension.json");
    pub(super) const UI_MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-executor-placement/ui-extension.json");
    pub(super) const SOURCE: &str = include_str!("../../../tests/fixtures/extensions/runtime-executor-placement/main.cjs");
    pub(super) const ID: &str = "sample.executor-placement";
    pub(super) const UI_ID: &str = "sample.executor-placement-ui";
    const HOST: &str = "host-build-server";

    pub(super) fn archive(manifest: &str, source: &str) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, bytes) in [("extension.json", manifest.as_bytes()), ("main.cjs", source.as_bytes())] {
            writer.start_file(name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }
    /// A host with both fixture packages installed, trusted and enabled, and `runtime.service` granted to both.
    pub(super) struct Fixture { pub dir: std::path::PathBuf, pub packages: ExtensionPackages, pub grants: RuntimeGrants }
    impl Fixture {
        pub fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("pandacode-executor-placement-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let packages = ExtensionPackages::new(&dir, false);
            let grants = RuntimeGrants::open(&dir);
            {
                let packages = packages.0.lock().unwrap();
                for (manifest, id) in [(MANIFEST, ID), (UI_MANIFEST, UI_ID)] {
                    packages.install(&archive(manifest, SOURCE)).unwrap();
                    let snapshot = serde_json::to_value(packages.snapshot()).unwrap();
                    let digest = snapshot["packages"].as_array().unwrap().iter().find(|package| package["manifest"]["id"] == id).unwrap()["executable"]["digest"].as_str().unwrap().to_owned();
                    packages.trust(id, &digest, true).unwrap(); packages.enable(id, true).unwrap();
                }
                grants.sync(&serde_json::to_value(packages.snapshot()).unwrap()).unwrap();
            }
            for id in [ID, UI_ID] { grants.grant(id, lifetime::PERMISSION, Scope::default()).unwrap(); }
            Self { dir, packages, grants }
        }
        pub fn identity() -> Value { json!({"deviceId": HOST, "name": "build-server", "platform": "linux", "headless": true}) }
        pub fn parts<'a>(&'a self, services: &'a ServiceLifetime, packages: &'a Packages) -> HostParts<'a> {
            HostParts { services, packages, grants: &self.grants, identity: Self::identity(), ui: json!({"revision": 3, "owners": {ID: {"items": 2, "notices": 1}, UI_ID: {"items": 9, "notices": 9}}}) }
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.dir); } }

    fn entry(manager: &ServiceLifetime, id: &str) -> Option<Value> {
        manager.projection()["services"].as_array().unwrap().iter().find(|row| row["id"] == id).cloned()
    }

    #[test]
    fn the_fixtures_are_valid_packages_of_each_kind() {
        for (manifest, kind) in [(MANIFEST, "workspace"), (UI_MANIFEST, "ui")] {
            let manifest: Value = serde_json::from_str(manifest).unwrap();
            assert_eq!(manifest["extensionKind"], kind);
            assert!(lifetime::declares_service(&manifest));
            let checked = crate::extensions::contracts::validate_contract("packages", &json!([manifest]));
            assert_eq!(checked["ok"], true, "{checked}");
        }
        // The preview's fake host lists the same packages (id, kind, permissions) as the native fixture.
        let peers: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/runtime-executor-placement/peers.json")).unwrap();
        for (index, manifest) in [MANIFEST, UI_MANIFEST].into_iter().enumerate() {
            let manifest: Value = serde_json::from_str(manifest).unwrap();
            let fake = &peers[0]["packages"][index]["manifest"];
            assert_eq!((&fake["id"], &fake["extensionKind"], &fake["permissions"]), (&manifest["id"], &manifest["extensionKind"], &manifest["permissions"]));
        }
    }

    /// The headless refusal is resolved for workspace-kind packages only: a desktop runs every kind, a headless host
    /// runs workspace and split packages and never a `ui` one (Q024 retained).
    #[test]
    fn workspace_services_run_beside_a_headless_executor_and_ui_services_never_do() {
        let workspace: Value = serde_json::from_str(MANIFEST).unwrap();
        let ui: Value = serde_json::from_str(UI_MANIFEST).unwrap();
        let split = json!({"id": "sample.split", "extensionKind": "split"});
        assert!(runs_on(&workspace, Executor::Desktop) && runs_on(&ui, Executor::Desktop) && runs_on(&split, Executor::Desktop));
        assert!(runs_on(&workspace, Executor::Headless) && runs_on(&split, Executor::Headless));
        assert!(!runs_on(&ui, Executor::Headless), "ui code has no window on a headless host");
        let snapshot = json!({"safeMode": false, "packages": [{"manifest": workspace}, {"manifest": ui}, {"manifest": split}]});
        assert_eq!(services_here(&snapshot, Executor::Desktop), BTreeSet::from([ID.to_owned(), UI_ID.to_owned(), "sample.split".to_owned()]));
        assert_eq!(services_here(&snapshot, Executor::Headless), BTreeSet::from([ID.to_owned(), "sample.split".to_owned()]));
        assert_eq!(with_executor(Executor::Headless, this_executor), Executor::Headless);
        assert_eq!(this_executor(), Executor::Desktop, "the override ends with its scope");
    }

    /// A task executed by another computer is acted for by that computer's copy only; this computer never runs it
    /// instead. A `ui` package presents the mirror.
    #[test]
    fn a_remote_task_is_routed_to_its_executor_and_never_run_here() {
        let workspace: Value = serde_json::from_str(MANIFEST).unwrap();
        let ui: Value = serde_json::from_str(UI_MANIFEST).unwrap();
        assert_eq!(route(&workspace, None), Route::Here);
        assert_eq!(route(&workspace, Some(HOST)), Route::Executor(HOST.to_owned()));
        assert_eq!(route(&ui, Some(HOST)), Route::Presentation);
        assert_eq!(route(&ui, None), Route::Here);
    }

    /// The service lifetime reconciles by the placement rule: on a headless executor the workspace package's service
    /// is started (here it fails for want of a runtime, which proves the start was attempted) and the `ui` package's
    /// never is; on a desktop both are.
    #[tokio::test]
    async fn reconcile_on_a_headless_executor_starts_only_the_workspace_service() {
        let fixture = Fixture::new();
        let headless = ServiceLifetime::new(vec![fixture.dir.join("no-runtime")]);
        with_executor(Executor::Headless, || headless.reconcile(&fixture.packages.0.lock().unwrap(), &fixture.grants));
        assert!(entry(&headless, ID).is_some(), "the workspace service is placed beside the headless executor");
        assert!(entry(&headless, UI_ID).is_none(), "a ui service never starts on a headless host");
        let desktop = ServiceLifetime::new(vec![fixture.dir.join("no-runtime")]);
        with_executor(Executor::Desktop, || desktop.reconcile(&fixture.packages.0.lock().unwrap(), &fixture.grants));
        assert!(entry(&desktop, ID).is_some() && entry(&desktop, UI_ID).is_some());
        headless.stop_all(lifetime::StopReason::Quit); desktop.stop_all(lifetime::StopReason::Quit);
    }

    /// The fake paired transport: it hands the desktop's calls to the host side over the fixture's real state. It
    /// proves protocol behaviour only (attribution, idempotence, refusals), never a second machine.
    struct FakeTransport { fixture: Arc<Fixture>, services: Arc<ServiceLifetime>, lose_next: Mutex<u32>, calls: Mutex<Vec<(String, Value)>>, offline: bool, device: String }
    impl FakeTransport {
        fn new(fixture: Arc<Fixture>, services: Arc<ServiceLifetime>) -> Self { Self { fixture, services, lose_next: Mutex::new(0), calls: Mutex::default(), offline: false, device: HOST.into() } }
    }
    impl Transport for FakeTransport {
        fn call<'a>(&'a self, device: &'a str, method: &'static str, params: Value) -> Call<'a> {
            Box::pin(async move {
                self.calls.lock().unwrap().push((method.to_owned(), params.clone()));
                if self.offline { return Err("That computer is offline.".into()); }
                if device != self.device { return Err("That computer is not on this account.".into()); }
                let packages = self.fixture.packages.0.lock().unwrap();
                let parts = self.fixture.parts(&self.services, &packages);
                let reply = match method {
                    SERVICES_METHOD => { if params["apiVersion"] != 1 { return Err(placement::UNSUPPORTED.into()); } Ok(host_snapshot(&parts)) }
                    CONTROL_METHOD => host_control(&parts, "Desk laptop", &params),
                    GRANT_METHOD => host_grant(&parts, "Desk laptop", &params),
                    _ => Err("Unknown method.".into()),
                };
                drop(packages);
                // The host ran the writer, but the reply was lost on the way back (a reconnect follows).
                let mut lose = self.lose_next.lock().unwrap();
                if *lose > 0 && method != SERVICES_METHOD { *lose -= 1; return Err(crate::remote::extension_placement::TIMED_OUT.into()); }
                reply
            })
        }
    }

    #[tokio::test]
    async fn the_desktop_reads_attributed_host_services_and_unavailable_hosts_stay_pending() {
        let fixture = Arc::new(Fixture::new());
        let services = Arc::new(ServiceLifetime::new(vec![fixture.dir.join("no-runtime")]));
        with_executor(Executor::Headless, || services.reconcile(&fixture.packages.0.lock().unwrap(), &fixture.grants));
        let seq = record_activity(ID, ActivityKind::Hook, "Denied Bash rm -rf in task 7\u{7}");
        record_activity("someone.else", ActivityKind::Hook, "not this host's package");
        let transport = FakeTransport::new(fixture.clone(), services.clone());
        let host = executor_services(&transport, HOST, "build-server").await;
        assert_eq!(host["reachable"], true, "{host}");
        assert_eq!(host["host"], json!({"placement": "remote", "deviceId": HOST, "name": "build-server", "platform": "linux", "headless": true}));
        let rows = host["services"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "only the workspace-kind package is placed beside the executor: {host}");
        assert_eq!(rows[0]["id"], ID);
        assert_eq!(rows[0]["attribution"], json!({"package": ID, "deviceId": HOST, "host": "build-server"}));
        assert!(rows[0]["granted"].as_array().unwrap().contains(&json!(lifetime::PERMISSION)));
        assert_eq!(host["ui"]["owners"], json!({ID: {"items": 2, "notices": 1}}), "live UI counts of the host's own packages only");
        let hook = host["activity"].as_array().unwrap().iter().find(|entry| entry["seq"] == seq).unwrap();
        assert_eq!((hook["owner"].as_str(), hook["kind"].as_str(), hook["summary"].as_str()), (Some(ID), Some("hook"), Some("Denied Bash rm -rf in task 7")));
        assert!(host["activity"].as_array().unwrap().iter().all(|entry| entry["owner"] == ID));
        assert_eq!(host["qualification"]["installed"], "pending", "the fake transport never qualifies placement");
        // A different computer answering, or a row attributed elsewhere, shows nothing.
        let mut foreign = host_snapshot(&fixture.parts(&services, &fixture.packages.0.lock().unwrap()));
        assert_eq!(read_host("another-device", &foreign).unwrap_err(), "StaleContext");
        foreign["services"][0]["attribution"]["deviceId"] = json!("another-device");
        assert_eq!(read_host(HOST, &foreign).unwrap_err(), "StaleContext");
        // Offline, unknown and older hosts are listed as unavailable: nothing delivered, nothing run here instead.
        let mut offline = FakeTransport::new(fixture.clone(), services.clone()); offline.offline = true;
        let gone = executor_services(&offline, HOST, "build-server").await;
        assert_eq!((gone["reachable"].as_bool(), gone["services"].as_array().map(Vec::len)), (Some(false), Some(0)));
        assert_eq!(gone["qualification"]["installed"], "pending");
        assert_eq!(executor_services(&transport, "old-host", "old").await["reachable"], false);
        assert_eq!(classify("Unknown method."), UNSUPPORTED_HOST);
        services.stop_all(lifetime::StopReason::Quit);
    }

    /// Writers are idempotent: a lost reply is retried once with the same `requestId` and the host answers it from
    /// memory, so Retry starts once and a revoke applies once. Foreign and undeclared requests stay refused.
    #[tokio::test]
    async fn control_and_grants_are_idempotent_attributed_and_refuse_foreign_requests() {
        let fixture = Arc::new(Fixture::new());
        let services = Arc::new(ServiceLifetime::new(vec![fixture.dir.join("no-runtime")]));
        let reconcile = || with_executor(Executor::Headless, || services.reconcile(&fixture.packages.0.lock().unwrap(), &fixture.grants));
        reconcile();
        let transport = FakeTransport::new(fixture.clone(), services.clone());
        let starts = || entry(&services, ID).map(|row| row["starts"].clone()).unwrap_or(Value::Null);
        let before = starts();
        // Retry, with the reply lost once: the desktop retries with the same id and the host replays.
        *transport.lose_next.lock().unwrap() = 1;
        let retried = with_executor(Executor::Headless, || futures_util::FutureExt::now_or_never(executor_control(&transport, HOST, ID, "retry", "retry-1"))).unwrap().unwrap();
        assert_eq!(retried["replayed"], true, "{retried}");
        assert_eq!(retried["attribution"]["from"], "Desk laptop");
        let after = starts();
        assert_ne!(before, after, "the retry started the service again once");
        let again = with_executor(Executor::Headless, || futures_util::FutureExt::now_or_never(executor_control(&transport, HOST, ID, "retry", "retry-1"))).unwrap().unwrap();
        assert_eq!(again["replayed"], true); assert_eq!(starts(), after, "a repeated requestId never applies twice");
        assert_eq!(transport.calls.lock().unwrap().iter().filter(|(method, _)| method == CONTROL_METHOD).count(), 3);
        // Revoke of runtime.service on the host: the grant goes, the service entry goes (no process to stop here).
        let revoked = with_executor(Executor::Headless, || futures_util::FutureExt::now_or_never(executor_grant(&transport, HOST, &json!({"op": "revoke", "id": ID, "permission": lifetime::PERMISSION, "requestId": "revoke-1"})))).unwrap().unwrap();
        assert!(!revoked["service"]["granted"].as_array().unwrap().contains(&json!(lifetime::PERMISSION)), "{revoked}");
        assert!(fixture.grants.check(ID, "1.0.0", lifetime::PERMISSION, &Default::default()).is_err());
        reconcile();
        assert!(entry(&services, ID).is_none_or(|row| row["state"] == "stopped"), "no service without the grant");
        // Grant it back: the service is started again by the host's own reconcile.
        with_executor(Executor::Headless, || futures_util::FutureExt::now_or_never(executor_grant(&transport, HOST, &json!({"op": "grant", "id": ID, "permission": lifetime::PERMISSION, "requestId": "grant-1"})))).unwrap().unwrap();
        assert!(fixture.grants.check(ID, "1.0.0", lifetime::PERMISSION, &Default::default()).is_ok());
        // Retained refusals: a ui package and an unknown package are not steered from another computer (NotFound),
        // an undeclared permission is PermissionDenied, a name outside the vocabulary UnsupportedCapability, and a
        // malformed request InvalidArguments.
        let refuse = |request: Value| futures_util::FutureExt::now_or_never(executor_grant(&transport, HOST, &request)).unwrap().unwrap_err();
        assert_eq!(refuse(json!({"op": "revoke", "id": UI_ID, "permission": lifetime::PERMISSION, "requestId": "r-ui"})), "NotFound");
        assert_eq!(refuse(json!({"op": "revoke", "id": "sample.unknown", "permission": lifetime::PERMISSION, "requestId": "r-unknown"})), "NotFound");
        assert_eq!(refuse(json!({"op": "grant", "id": ID, "permission": "tasks.start", "requestId": "r-undeclared"})), "PermissionDenied");
        assert_eq!(refuse(json!({"op": "grant", "id": ID, "permission": "credentials.read", "requestId": "r-read"})), "UnsupportedCapability");
        assert_eq!(refuse(json!({"op": "grant", "id": ID, "requestId": "r-missing"})), "InvalidArguments");
        assert_eq!(futures_util::FutureExt::now_or_never(executor_control(&transport, HOST, ID, "kill", "c-1")).unwrap().unwrap_err(), "InvalidArguments");
        // Activity attributes every change to the package and the device that asked.
        let host = futures_util::FutureExt::now_or_never(executor_services(&transport, HOST, "build-server")).unwrap();
        let summaries: Vec<&str> = host["activity"].as_array().unwrap().iter().filter_map(|entry| entry["summary"].as_str()).collect();
        assert!(summaries.contains(&"Retry requested from Desk laptop") && summaries.contains(&"runtime.service revoked from Desk laptop") && summaries.contains(&"runtime.service granted from Desk laptop"), "{summaries:?}");
        // The registry parses the same shapes.
        assert!(parse_services(&json!({"apiVersion": 2})).is_err());
        assert!(parse_control(&json!({"id": ID, "op": "stop", "requestId": "x"})).is_ok());
        assert!(parse_control(&json!({"id": "../x", "op": "stop", "requestId": "x"})).is_err());
        assert!(parse_grant(&json!({"id": ID, "op": "revokeAll", "requestId": "x"})).is_ok());
        assert!(parse_grant(&json!({"id": ID, "op": "grant", "requestId": "x"})).is_err());
        assert_eq!(REMOTE_METHODS.iter().map(|method| (method.name, method.access, method.read_only)).collect::<Vec<_>>(), vec![(SERVICES_METHOD, Access::View, true), (CONTROL_METHOD, Access::Control, false), (GRANT_METHOD, Access::Full, false)]);
        services.stop_all(lifetime::StopReason::Quit);
    }

    #[test]
    fn display_text_is_bounded_and_free_of_control_characters() {
        assert_eq!(bounded(" a\u{1b}[31mb \n", 10), "a [31mb");
        let long = "x".repeat(300);
        assert_eq!(bounded(&long, MAX_TEXT).chars().count(), MAX_TEXT);
        assert!(bounded(&long, MAX_TEXT).ends_with('…'));
    }

    /// Native fixture column (Windows x64, the pinned runtime): a real service runs beside a headless executor,
    /// reports itself through the host projection with the host's identity, stops from the desktop's request
    /// (held until Retry) and ends when the desktop revokes `runtime.service`. The fake transport carries the calls,
    /// so this is not cross-machine qualification.
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    mod installed {
        use super::*;
        use std::path::Path;

        fn runtime_dir() -> std::path::PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime") }
        async fn wait(services: &ServiceLifetime, check: impl Fn(&Value) -> bool) -> Value {
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                let row = entry(services, ID).unwrap_or(Value::Null);
                if check(&row) { return row; }
                assert!(Instant::now() < deadline, "timed out: {row}");
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn a_real_service_runs_beside_a_headless_executor_and_stops_and_ends_on_desktop_requests() {
            let fixture = Arc::new(Fixture::new());
            let services = Arc::new(ServiceLifetime::new(vec![runtime_dir()]));
            let reconcile = || with_executor(Executor::Headless, || services.reconcile(&fixture.packages.0.lock().unwrap(), &fixture.grants));
            reconcile();
            let running = wait(&services, |row| row["state"] == "running" && row["status"]["text"] == "Beside the executor").await;
            assert_eq!(running["reason"], "appStart");
            assert!(entry(&services, UI_ID).is_none(), "the ui package never starts on the headless host");
            let transport = FakeTransport::new(fixture.clone(), services.clone());
            let host = executor_services(&transport, HOST, "build-server").await;
            assert_eq!(host["services"][0]["state"], "running"); assert_eq!(host["services"][0]["status"], "Beside the executor");
            assert_eq!(host["host"]["headless"], true); assert_eq!(host["services"][0]["attribution"]["deviceId"], HOST);
            // Stop from the desktop: onStop("stop") runs, the process ends and stays held across reconciles.
            let stopped = executor_control(&transport, HOST, ID, "stop", "stop-1").await.unwrap();
            assert_eq!(stopped["applied"], true);
            wait(&services, |row| row["state"] == "stopped" && row["held"] == true).await;
            reconcile();
            assert_eq!(wait(&services, |_| true).await["state"], "stopped");
            assert_eq!(executor_control(&transport, HOST, ID, "stop", "stop-2").await.unwrap()["applied"], false, "stopping a stopped service applies nothing");
            // Retry, then revoke: the grant loss ends it with the reason `trust`.
            executor_control(&transport, HOST, ID, "retry", "retry-1").await.unwrap();
            wait(&services, |row| row["state"] == "running").await;
            executor_grant(&transport, HOST, &json!({"op": "revoke", "id": ID, "permission": lifetime::PERMISSION, "requestId": "revoke-1"})).await.unwrap();
            let ended = wait(&services, |row| row["state"] == "stopped" && row["held"] != true).await;
            assert_eq!(ended["lastStop"]["reason"], "trust");
            services.stop_all(lifetime::StopReason::Quit);
            assert!(services.wait_idle(Duration::from_secs(5)).await);
        }
    }
}
