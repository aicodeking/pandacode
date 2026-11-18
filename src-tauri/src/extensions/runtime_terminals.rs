//! Read and operate terminals with separate grants (`terminals.read`, `terminals.write`, runtime phase R4, slice R0409).
//!
//! A trusted service lists and reads terminals with `panda.terminals.list | read | onOutput` (`terminals.read`) and opens,
//! writes to and closes them with `panda.terminals.open | write | close` (`terminals.write`). The two grants are independent
//! (a package that reads cannot write, open or close; a package that writes cannot read what the terminal printed), both are
//! project scoped, both are rechecked natively on every request and neither asks again per action (ADR-0005).
//!
//! A terminal belongs to the project the package opened it for, or else to the project of the task it was opened for, or else
//! to the project whose folder contains its working directory. A terminal that belongs to no project is invisible to every
//! package. The refusals are the frozen ones:
//! - no grant, a revoked grant, a disabled package or a project outside the narrowed scope: `PermissionDenied`, with the
//!   permission name in `path`; a package that holds the permission for no project learns nothing about terminals;
//! - an unknown terminal, subscription, project or task, or a terminal that already ended (for a write): `NotFound`;
//! - an unknown field, a bad id, cursor or size: `InvalidShape`; input over 64 KiB, a ninth-sized subscription count: `LimitExceeded`.
//!
//! Output is paged: `read` answers at most 64 KiB (JSON-escaped, never splitting a character) after a byte `cursor` and says
//! what it skipped (`dropped`, the bytes that left the 256 KiB log before the package asked) so nothing is lost silently.
//! `onOutput` is a bounded subscription the service pumps: the host keeps the cursor, hands out at most one coalesced chunk per
//! 100 ms (ten chunks a second), and a chunk starts exactly where the previous ended, so output is neither repeated nor
//! skipped. Each poll rechecks the grant; closing the terminal, revoking, disabling or stopping the service ends the
//! subscription and removes its handle.
//!
//! The rules are pure (an injected clock and reader) so they are deterministic to test; the app half (`serve`) only adds the
//! grants file, the project store and the real terminals of `terminal.rs`.
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, sync::{LazyLock, Mutex}, time::Instant};

use super::runtime_tasks_start::{failure, Refusal};

pub const READ_PERMISSION: &str = "terminals.read";
pub const WRITE_PERMISSION: &str = "terminals.write";
/// One page of output: at most 64 KiB once JSON-escaped.
pub const PAGE_BYTES: usize = 64 * 1024;
/// The terminal's own bound on one write.
pub const INPUT_BYTES: usize = 64 * 1024;
/// `onOutput` is coalesced to ten chunks per second.
pub const TICK_MS: u64 = 100;
/// Subscriptions one package may hold at once.
pub const MAX_SUBSCRIPTIONS: usize = 16;
const MAX_OFFSET: u64 = 1 << 53;
const OPS: [&str; 8] = ["list", "read", "subscribe", "poll", "unsubscribe", "open", "write", "close"];

fn ident(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control) }
fn denied(permission: &str) -> Refusal { Refusal { code: "PermissionDenied".into(), path: permission.into(), ids: vec![] } }

/// The grant an operation needs: the three that change a terminal need `terminals.write`, the rest `terminals.read`.
pub fn permission_for(op: &str) -> &'static str { if matches!(op, "open" | "write" | "close") { WRITE_PERMISSION } else { READ_PERMISSION } }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    List { project: Option<String> },
    Read { terminal: String, cursor: u64 },
    Subscribe { terminal: String, cursor: Option<u64> },
    Poll { subscription: String },
    Unsubscribe { subscription: String },
    Open { project: String, task: Option<String>, cols: u16, rows: u16 },
    Write { terminal: String, data: String },
    Close { terminal: String },
}

/// The operation name of a call, checked before anything else so the grant it needs is known.
pub fn op_of(raw: &Value) -> Result<&str, Refusal> {
    raw.as_object().and_then(|object| object.get("op")).and_then(Value::as_str).filter(|op| OPS.contains(op)).ok_or_else(|| "InvalidShape".into())
}

fn id_field(object: &Map<String, Value>, key: &str) -> Result<Option<String>, Refusal> {
    match object.get(key) { None | Some(Value::Null) => Ok(None), Some(Value::String(text)) if ident(text) => Ok(Some(text.clone())), Some(_) => Err("InvalidShape".into()) }
}
fn need(object: &Map<String, Value>, key: &str) -> Result<String, Refusal> { id_field(object, key)?.ok_or_else(|| "InvalidShape".into()) }
fn offset(object: &Map<String, Value>, key: &str) -> Result<Option<u64>, Refusal> {
    match object.get(key) { None | Some(Value::Null) => Ok(None), Some(value) => value.as_u64().filter(|number| *number <= MAX_OFFSET).map(Some).ok_or_else(|| "InvalidShape".into()) }
}
fn dimension(object: &Map<String, Value>, key: &str, default: u16, min: u64, max: u64) -> Result<u16, Refusal> {
    match object.get(key) { None | Some(Value::Null) => Ok(default), Some(value) => value.as_u64().filter(|number| (min..=max).contains(number)).map(|number| number as u16).ok_or_else(|| "InvalidShape".into()) }
}

/// Reads a call: `{op, ...fields}`. Nothing is looked up here.
pub fn read_request(raw: &Value) -> Result<Request, Refusal> {
    let object = raw.as_object().ok_or("InvalidShape")?;
    let op = op_of(raw)?;
    let allowed: &[&str] = match op {
        "list" => &["projectId"],
        "read" | "subscribe" => &["terminalId", "cursor"],
        "poll" | "unsubscribe" => &["subscriptionId"],
        "open" => &["projectId", "taskId", "cols", "rows"],
        "write" => &["terminalId", "data"],
        _ => &["terminalId"],
    };
    if object.keys().any(|key| key.as_str() != "op" &&!allowed.contains(&key.as_str())) { return Err("InvalidShape".into()); }
    Ok(match op {
        "list" => Request::List { project: id_field(object, "projectId")? },
        "read" => Request::Read { terminal: need(object, "terminalId")?, cursor: offset(object, "cursor")?.unwrap_or(0) },
        "subscribe" => Request::Subscribe { terminal: need(object, "terminalId")?, cursor: offset(object, "cursor")? },
        "poll" => Request::Poll { subscription: need(object, "subscriptionId")? },
        "unsubscribe" => Request::Unsubscribe { subscription: need(object, "subscriptionId")? },
        "open" => Request::Open { project: need(object, "projectId")?, task: id_field(object, "taskId")?, cols: dimension(object, "cols", 80, 10, 500)?, rows: dimension(object, "rows", 24, 2, 200)? },
        "write" => {
            let terminal = need(object, "terminalId")?;
            let data = object.get("data").and_then(Value::as_str).filter(|data| !data.is_empty()).ok_or("InvalidShape")?;
            if data.len() > INPUT_BYTES { return Err("LimitExceeded".into()); }
            Request::Write { terminal, data: data.to_owned() }
        }
        _ => Request::Close { terminal: need(object, "terminalId")? },
    })
}

/// The grant for the project a terminal or call reaches. `holds` is "the package holds this permission for any project":
/// without it the answer is the permission itself whatever the target, so a refusal never says whether a terminal exists.
pub fn gate(permission: &str, holds: bool, project: Option<&str>, granted: &dyn Fn(&str) -> bool) -> Result<String, Refusal> {
    if !holds { return Err(denied(permission)); }
    match project { None => Err("NotFound".into()), Some(project) if granted(project) => Ok(project.to_owned()), Some(_) => Err(denied(permission)) }
}

// ---- Which project a terminal belongs to -------------------------------------------------------------------------------

/// What `terminal.rs` knows about a terminal, without its private bookkeeping.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listed { pub id: String, pub title: String, pub cwd: String, pub session_id: Option<String>, pub kind: String, pub running: bool, pub exit_code: Option<i32> }

/// The three sources of a terminal's project, in order: opened by a package for a project, opened for a task, and the folder
/// of a project that contains the working directory (the longest folder wins).
pub struct Attribution<'a> { pub owners: &'a BTreeMap<String, String>, pub sessions: &'a BTreeMap<String, String>, pub projects: &'a [(String, String)] }

fn fold(path: &str) -> String {
    let mut text = path.replace('\\', "/");
    while text.len() > 1 && text.ends_with('/') { text.pop(); }
    if cfg!(windows) { text.to_lowercase() } else { text }
}
fn within(cwd: &str, root: &str) -> bool {
    let (cwd, root) = (fold(cwd), fold(root));
    !root.is_empty() && (cwd == root || cwd.starts_with(&format!("{}/", root.trim_end_matches('/'))))
}
pub fn attribute(attribution: &Attribution, terminal: &Listed) -> Option<String> {
    if let Some(project) = attribution.owners.get(&terminal.id) { return Some(project.clone()); }
    if let Some(project) = terminal.session_id.as_deref().and_then(|session| attribution.sessions.get(session)) { return Some(project.clone()); }
    attribution.projects.iter().filter(|(_, root)| within(&terminal.cwd, root)).max_by_key(|(_, root)| root.len()).map(|(id, _)| id.clone())
}

/// What `list` shows of one terminal.
pub fn terminal_value(terminal: &Listed, project: &str) -> Value {
    json!({"id": terminal.id, "title": terminal.title, "cwd": terminal.cwd, "projectId": project, "taskId": terminal.session_id, "kind": terminal.kind, "running": terminal.running, "exitCode": terminal.exit_code})
}

/// `list`: the terminals of every project the grant reaches (or of one `project`, which must be in the grant), newest first as
/// the registry gives them.
pub fn list_value(terminals: &[(Listed, Option<String>)], project: Option<&str>, granted: &dyn Fn(&str) -> bool) -> Value {
    Value::Array(terminals.iter().filter_map(|(terminal, owner)| {
        let owner = owner.as_deref()?;
        (project.is_none_or(|wanted| wanted == owner) && granted(owner)).then(|| terminal_value(terminal, owner))
    }).collect())
}

// ---- Pages -------------------------------------------------------------------------------------------------------------

/// One page of output as `terminal.rs` reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page { pub data: String, pub next: u64, pub dropped: u64, pub exited: bool, pub exit_code: Option<i32> }

/// `{schemaVersion, data, cursor, nextCursor, dropped, exited, exitCode}`: `cursor` is where `data` starts and `nextCursor` where the
/// next page does, so consecutive pages join without a gap or a repeat; `dropped` counts the bytes that were gone before the
/// package asked.
pub fn page_value(page: &Page) -> Value {
    let from = page.next.saturating_sub(page.data.len() as u64);
    json!({"schemaVersion": 1, "data": page.data, "cursor": from, "nextCursor": page.next, "dropped": page.dropped, "exited": page.exited, "exitCode": page.exit_code})
}

// ---- Subscriptions and handles -----------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Sub { pub owner: String, pub version: String, pub terminal: String, pub project: String, pub cursor: u64, pub last: Option<u64> }

#[derive(Default)]
struct Inner { owners: BTreeMap<String, (String, String)>, subs: BTreeMap<String, Sub>, serial: u64 }

/// The terminals packages opened (terminal, package and project) and the output subscriptions of the running services.
#[derive(Default)]
pub struct TerminalState { inner: Mutex<Inner> }
impl TerminalState {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, Refusal> { self.inner.lock().map_err(|_| Refusal::new("HostUnavailable")) }
    /// A package opened `terminal` for `project`.
    pub fn record_owner(&self, terminal: &str, owner: &str, project: &str) {
        if let Ok(mut inner) = self.inner.lock() { inner.owners.insert(terminal.to_owned(), (owner.to_owned(), project.to_owned())); }
    }
    /// Terminal to project, for the attribution.
    pub fn projects(&self) -> BTreeMap<String, String> {
        self.inner.lock().map(|inner| inner.owners.iter().map(|(terminal, (_, project))| (terminal.clone(), project.clone())).collect()).unwrap_or_default()
    }
    /// A subscription starting at `cursor`. A seventeenth of one package is `LimitExceeded`.
    pub fn subscribe(&self, owner: &str, version: &str, terminal: &str, project: &str, cursor: u64) -> Result<String, Refusal> {
        let mut inner = self.lock()?;
        if inner.subs.values().filter(|sub| sub.owner == owner).count() >= MAX_SUBSCRIPTIONS { return Err("LimitExceeded".into()); }
        inner.serial += 1;
        let id = format!("{owner}#term-{}", inner.serial);
        inner.subs.insert(id.clone(), Sub { owner: owner.to_owned(), version: version.to_owned(), terminal: terminal.to_owned(), project: project.to_owned(), cursor, last: None });
        Ok(id)
    }
    /// The package stops listening. Idempotent; another package's id is `NotFound`-silent (nothing is removed).
    pub fn unsubscribe(&self, owner: &str, id: &str) -> bool {
        let Ok(mut inner) = self.inner.lock() else { return false };
        if inner.subs.get(id).is_some_and(|sub| sub.owner == owner) { inner.subs.remove(id).is_some() } else { false }
    }
    /// The terminal ended or was closed: no subscription and no handle of it stays.
    pub fn forget_terminal(&self, terminal: &str) -> usize {
        let Ok(mut inner) = self.inner.lock() else { return 0 };
        inner.owners.remove(terminal);
        let before = inner.subs.len();
        inner.subs.retain(|_, sub| sub.terminal != terminal);
        before - inner.subs.len()
    }
    /// The service of `owner` stopped (disable, revoke, uninstall, safe mode, crash, quit): its subscriptions go. The terminals it
    /// opened keep running for the user, who owns them from then on.
    pub fn cancel_owner(&self, owner: &str) -> usize {
        let Ok(mut inner) = self.inner.lock() else { return 0 };
        let before = inner.subs.len();
        inner.subs.retain(|_, sub| sub.owner != owner);
        inner.owners.retain(|_, (package, _)| package != owner);
        before - inner.subs.len()
    }
    /// The package no longer holds the read grant: every subscription of it goes (the handles of terminals it opened stay).
    pub fn drop_subscriptions(&self, owner: &str) -> usize {
        let Ok(mut inner) = self.inner.lock() else { return 0 };
        let before = inner.subs.len();
        inner.subs.retain(|_, sub| sub.owner != owner);
        before - inner.subs.len()
    }
    pub fn count(&self, owner: &str) -> usize { self.inner.lock().map_or(0, |inner| inner.subs.values().filter(|sub| sub.owner == owner).count()) }
    pub fn handles(&self, owner: &str) -> usize { self.inner.lock().map_or(0, |inner| inner.owners.values().filter(|(package, _)| package == owner).count()) }

    /// One pump of a subscription at time `now` (milliseconds). Inside a tick nothing is read (`retryMs` says how long to wait);
    /// otherwise the cursor moves to the end of one page of at most 64 KiB, so the chunks of a subscription join exactly.
    /// `allowed` rechecks the grant of the subscription's package for its project: a subscription that is no longer allowed is
    /// removed and answers `PermissionDenied`. `read` answers `None` once the terminal is closed, which ends the subscription.
    pub fn poll(&self, id: &str, owner: &str, now: u64, allowed: &dyn Fn(&Sub) -> bool, read: &dyn Fn(&str, u64) -> Option<Page>) -> Result<Value, Refusal> {
        let mut inner = self.lock()?;
        let Some(sub) = inner.subs.get(id).filter(|sub| sub.owner == owner).cloned() else { return Err("NotFound".into()) };
        if !allowed(&sub) { inner.subs.remove(id); return Err(denied(READ_PERMISSION)); }
        if let Some(last) = sub.last { if now < last + TICK_MS { return Ok(json!({"chunk": null, "ended": false, "retryMs": last + TICK_MS - now})); } }
        let Some(page) = read(&sub.terminal, sub.cursor) else {
            inner.subs.remove(id);
            return Ok(json!({"chunk": null, "ended": true, "reason": "closed"}));
        };
        if let Some(entry) = inner.subs.get_mut(id) { entry.cursor = page.next; entry.last = Some(now); }
        let ended = page.exited;
        if ended { inner.subs.remove(id); }
        let has = !page.data.is_empty() || page.dropped > 0 || page.exited;
        Ok(json!({"chunk": if has { page_value(&page) } else { Value::Null }, "ended": ended, "retryMs": TICK_MS}))
    }
}

static STATE: LazyLock<TerminalState> = LazyLock::new(TerminalState::default);
static CLOCK: LazyLock<Instant> = LazyLock::new(Instant::now);
fn now_ms() -> u64 { CLOCK.elapsed().as_millis() as u64 }
/// The state of the running app.
pub fn state() -> &'static TerminalState { &STATE }

// ---- The app ---------------------------------------------------------------------------------------------------------

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

/// Every terminal with its project (`None` when it belongs to none).
fn load(app: &tauri::AppHandle) -> Result<Vec<(Listed, Option<String>)>, Refusal> {
    use tauri::Manager;
    let infos = crate::terminal::output_list();
    let listed: Vec<Listed> = infos.iter().map(|info| Listed { id: info.id.clone(), title: info.title.clone(), cwd: info.cwd.clone(), session_id: info.session_id.clone(), kind: info.kind.to_owned(), running: info.running, exit_code: info.exit_code }).collect();
    let mut projects: Vec<(String, String)> = vec![];
    let mut sessions: BTreeMap<String, String> = BTreeMap::new();
    if let Some(state) = app.try_state::<crate::AppState>() {
        let store = state.store.try_lock().map_err(|_| Refusal::new("Timeout"))?;
        if let Ok(mut query) = store.db.prepare("SELECT id, path FROM projects") {
            if let Ok(rows) = query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) { projects = rows.flatten().collect(); }
        }
        for session in listed.iter().filter_map(|terminal| terminal.session_id.as_deref()) {
            if let Ok(project) = store.db.query_row("SELECT project_id FROM sessions WHERE id=?1", [session], |row| row.get::<_, String>(0)) {
                if !project.is_empty() { sessions.insert(session.to_owned(), project); }
            }
        }
    }
    let owners = state().projects();
    let attribution = Attribution { owners: &owners, sessions: &sessions, projects: &projects };
    Ok(listed.into_iter().map(|terminal| { let project = attribute(&attribution, &terminal); (terminal, project) }).collect())
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, Refusal> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|_| Refusal::new("HostUnavailable"))
}

/// A page of terminal `id` after `cursor`, or `None` when the terminal is closed.
fn read_page(id: &str, cursor: u64) -> Option<Page> {
    let chunk = crate::terminal::read_output(id, cursor, PAGE_BYTES).ok()?;
    Some(Page { data: chunk.data, next: chunk.next, dropped: chunk.dropped, exited: chunk.exited, exit_code: chunk.exit_code })
}

/// Serves `terminals` of the service of `request.owner`.
pub async fn serve(app: tauri::AppHandle, request: super::runtime_service_lifetime::DispatchRequest) -> Value {
    let owner = request.owner.clone();
    let op = match op_of(&request.params) { Ok(op) => op.to_owned(), Err(refusal) => return refusal.envelope() };
    let permission = permission_for(&op);
    let version = { let app = app.clone(); let owner = owner.clone(); tauri::async_runtime::spawn_blocking(move || version_of(&app, &owner)).await.unwrap_or(Err("HostUnavailable")) };
    let version = match version { Ok(version) => version, Err("PermissionDenied") => return denied(permission).envelope(), Err(code) => return failure(code) };
    match run(&app, &owner, &version, permission, &request.params).await { Ok(value) => json!({"ok": true, "value": value}), Err(refusal) => refusal.envelope() }
}

async fn run(app: &tauri::AppHandle, owner: &str, version: &str, permission: &'static str, params: &Value) -> Result<Value, Refusal> {
    use tauri::Manager;
    // Stopping a subscription is cleanup, never a power: it needs no grant and cannot touch another package's.
    if op_of(params)? == "unsubscribe" {
        if let Request::Unsubscribe { subscription } = read_request(params)? { state().unsubscribe(owner, &subscription); }
        return Ok(Value::Null);
    }
    let any = holds(app, owner, version, permission);
    if !any {
        // A package that lost the read grant altogether has no listener left.
        if permission == READ_PERMISSION { state().drop_subscriptions(owner); }
        return Err(denied(permission));
    }
    let request = read_request(params)?;
    let check = |project: &str| granted(app, owner, version, permission, project);
    // Revoke, narrowing and disable are read again just before anything changes or is handed over.
    let still = |project: &str| version_of(app, owner).is_ok() && check(project);
    match request {
        Request::List { project } => {
            if let Some(project) = &project { gate(permission, any, Some(project.as_str()), &check)?; }
            let all = { let app = app.clone(); blocking(move || load(&app)).await?? };
            Ok(list_value(&all, project.as_deref(), &check))
        }
        Request::Read { terminal, cursor } => {
            let project = locate(app, &terminal, permission, any, &check).await?;
            let work = begin(app, owner, version, permission, &project)?;
            let page = { let terminal = terminal.clone(); blocking(move || read_page(&terminal, cursor)).await? }.ok_or("NotFound")?;
            if work.is_cancelled() || !still(&project) { return Err(denied(permission)); }
            Ok(page_value(&page))
        }
        Request::Subscribe { terminal, cursor } => {
            let project = locate(app, &terminal, permission, any, &check).await?;
            // From the end by default (what the terminal prints from now on); an explicit cursor replays from there.
            let start = match cursor { Some(cursor) => cursor, None => { let terminal = terminal.clone(); blocking(move || read_page(&terminal, u64::MAX)).await?.ok_or("NotFound")?.next } };
            let id = state().subscribe(owner, version, &terminal, &project, start)?;
            Ok(json!({"subscriptionId": id, "cursor": start, "intervalMs": TICK_MS}))
        }
        Request::Poll { subscription } => {
            let (owner_id, version_id) = (owner.to_owned(), version.to_owned());
            let app_check = app.clone();
            let allowed = move |sub: &Sub| sub.version == version_id && granted(&app_check, &owner_id, &sub.version, READ_PERMISSION, &sub.project) && version_of(&app_check, &owner_id).is_ok();
            let (owner_id, subscription) = (owner.to_owned(), subscription.clone());
            blocking(move || state().poll(&subscription, &owner_id, now_ms(), &allowed, &read_page)).await?
        }
        Request::Unsubscribe { subscription } => { state().unsubscribe(owner, &subscription); Ok(Value::Null) }
        Request::Open { project, task, cols, rows } => {
            let project = gate(permission, any, Some(project.as_str()), &check)?;
            let work = begin(app, owner, version, permission, &project)?;
            let id = { let (app, project, task) = (app.clone(), project.clone(), task.clone()); blocking(move || open_terminal(&app, &project, task.as_deref(), cols, rows)).await?? };
            state().record_owner(&id, owner, &project);
            if work.is_cancelled() {
                // The grant went away while the shell started: it is closed again, as if the call never ran.
                if let Some(app_state) = app.try_state::<crate::AppState>() { let _ = crate::terminal::close(&app_state.terminals, &id); }
                state().forget_terminal(&id);
                return Err(denied(permission));
            }
            Ok(json!({"id": id, "projectId": project, "taskId": task}))
        }
        Request::Write { terminal, data } => {
            let project = locate(app, &terminal, permission, any, &check).await?;
            let work = begin(app, owner, version, permission, &project)?;
            if !still(&project) || work.is_cancelled() { return Err(denied(permission)); }
            let app_state = app.clone();
            blocking(move || { let state = app_state.state::<crate::AppState>(); crate::terminal::write(&state.terminals, &terminal, &data) }).await?
                .map_err(|message| Refusal::new(if message.contains("closed") { "NotFound" } else { "HostUnavailable" }))?;
            Ok(Value::Null)
        }
        Request::Close { terminal } => {
            let project = locate(app, &terminal, permission, any, &check).await?;
            let work = begin(app, owner, version, permission, &project)?;
            if !still(&project) || work.is_cancelled() { return Err(denied(permission)); }
            let app_state = app.clone();
            let id = terminal.clone();
            blocking(move || { let state = app_state.state::<crate::AppState>(); crate::terminal::close(&state.terminals, &id) }).await?.map_err(|_| Refusal::new("HostUnavailable"))?;
            state().forget_terminal(&terminal);
            Ok(Value::Null)
        }
    }
}

/// Registers privileged work for the project: a revoke or narrowing cancels it.
fn begin(app: &tauri::AppHandle, owner: &str, version: &str, permission: &str, project: &str) -> Result<super::runtime_grants::Work, Refusal> {
    use tauri::Manager;
    app.try_state::<super::runtime_grants::RuntimeGrants>().ok_or("HostUnavailable")?
        .begin(owner, version, permission, &super::runtime_grants::Target::project(project)).map_err(|_| denied(permission))
}

/// The project of terminal `id`, once the grant for it holds.
async fn locate(app: &tauri::AppHandle, id: &str, permission: &str, any: bool, check: &(dyn Fn(&str) -> bool + Sync)) -> Result<String, Refusal> {
    let all = { let app = app.clone(); blocking(move || load(&app)).await?? };
    let project = all.iter().find(|(terminal, _)| terminal.id == id).and_then(|(_, project)| project.as_deref());
    gate(permission, any, project, check)
}

/// Starts a shell the way the Terminal tab does (`start_terminal`): in the project's folder, or the task's worktree.
fn open_terminal(app: &tauri::AppHandle, project: &str, task: Option<&str>, cols: u16, rows: u16) -> Result<String, Refusal> {
    use std::sync::atomic::Ordering;
    use tauri::{Emitter, Manager};
    let state = app.state::<crate::AppState>();
    if state.shutdown.load(Ordering::SeqCst) != 0 { return Err("HostUnavailable".into()); }
    let root = state.root(project, task).map_err(|_| Refusal::new("NotFound"))?;
    let terms = state.terminals.clone();
    let id = {
        let _admission = crate::run_requests::lock_agents(&state.agents).map_err(|_| Refusal::new("HostUnavailable"))?;
        crate::agent_updates::ensure_not_installing().map_err(|_| Refusal::new("HostUnavailable"))?;
        crate::terminal::start(app.clone(), terms, &root, cols, rows).map_err(|_| Refusal::new("HostUnavailable"))?
    };
    if let Some(task) = task { crate::terminal::tag_output(&id, task); }
    // The Terminal tab adopts a shell it did not open itself.
    let _ = app.emit("terminal-opened", json!({"terminalId": id, "projectId": project, "sessionId": task}));
    Ok(id)
}

/// The service of `owner` stopped: its output subscriptions and handles go; the shells it opened stay for the user.
pub fn service_stopped(_app: &tauri::AppHandle, owner: &str) { state().cancel_owner(owner); }

#[cfg(test)]
mod tests {
    use super::*;

    fn code(result: Result<Request, Refusal>) -> String { result.unwrap_err().code }
    fn listed(id: &str, cwd: &str, session: Option<&str>) -> Listed { Listed { id: id.into(), title: "sh".into(), cwd: cwd.into(), session_id: session.map(str::to_owned), kind: "shell".into(), running: true, exit_code: None } }
    fn page(data: &str, next: u64) -> Page { Page { data: data.into(), next, dropped: 0, exited: false, exit_code: None } }

    #[test]
    fn every_call_reads_its_fields_and_refuses_the_rest_as_invalid_shape() {
        assert_eq!(read_request(&json!({"op": "list"})).unwrap(), Request::List { project: None });
        assert_eq!(read_request(&json!({"op": "list", "projectId": "A"})).unwrap(), Request::List { project: Some("A".into()) });
        assert_eq!(read_request(&json!({"op": "read", "terminalId": "t1"})).unwrap(), Request::Read { terminal: "t1".into(), cursor: 0 });
        assert_eq!(read_request(&json!({"op": "read", "terminalId": "t1", "cursor": 7})).unwrap(), Request::Read { terminal: "t1".into(), cursor: 7 });
        assert_eq!(read_request(&json!({"op": "subscribe", "terminalId": "t1"})).unwrap(), Request::Subscribe { terminal: "t1".into(), cursor: None });
        assert_eq!(read_request(&json!({"op": "open", "projectId": "A"})).unwrap(), Request::Open { project: "A".into(), task: None, cols: 80, rows: 24 });
        assert_eq!(read_request(&json!({"op": "open", "projectId": "A", "taskId": "t", "cols": 100, "rows": 30})).unwrap(), Request::Open { project: "A".into(), task: Some("t".into()), cols: 100, rows: 30 });
        assert_eq!(read_request(&json!({"op": "write", "terminalId": "t1", "data": "ls\r"})).unwrap(), Request::Write { terminal: "t1".into(), data: "ls\r".into() });
        assert_eq!(read_request(&json!({"op": "close", "terminalId": "t1"})).unwrap(), Request::Close { terminal: "t1".into() });
        for raw in [
            json!("x"), json!({}), json!({"op": "kill", "terminalId": "t1"}), json!({"op": "read"}), json!({"op": "read", "terminalId": ""}), json!({"op": "read", "terminalId": "t1", "cursor": -1}),
            json!({"op": "read", "terminalId": "t1", "extra": 1}), json!({"op": "list", "terminalId": "t1"}), json!({"op": "open"}), json!({"op": "open", "projectId": "A", "cols": 1}),
            json!({"op": "open", "projectId": "A", "rows": 500}), json!({"op": "write", "terminalId": "t1"}), json!({"op": "write", "terminalId": "t1", "data": ""}), json!({"op": "write", "terminalId": "t1", "data": 3}),
            json!({"op": "close", "terminalId": "t1", "force": true}), json!({"op": "poll"}),
        ] { assert_eq!(code(read_request(&raw)), "InvalidShape", "{raw}"); }
        assert_eq!(code(read_request(&json!({"op": "write", "terminalId": "t1", "data": "x".repeat(INPUT_BYTES + 1)}))), "LimitExceeded");
        assert!(read_request(&json!({"op": "write", "terminalId": "t1", "data": "x".repeat(INPUT_BYTES)})).is_ok());
    }

    #[test]
    fn reading_and_writing_are_separate_grants_by_operation() {
        for op in ["list", "read", "subscribe", "poll", "unsubscribe"] { assert_eq!(permission_for(op), "terminals.read", "{op}"); }
        for op in ["open", "write", "close"] { assert_eq!(permission_for(op), "terminals.write", "{op}"); }
        assert_eq!(op_of(&json!({"op": "poll"})).unwrap(), "poll");
        assert_eq!(op_of(&json!({"op": "x"})).unwrap_err().code, "InvalidShape");
    }

    #[test]
    fn the_grant_answers_first_and_names_the_permission_and_an_unknown_terminal_is_not_found_only_to_a_holder() {
        let all = |_: &str| true;
        let only_b = |project: &str| project == "B";
        let none = gate(READ_PERMISSION, false, None, &all).unwrap_err();
        assert_eq!((none.code.as_str(), none.path.as_str()), ("PermissionDenied", "terminals.read"));
        assert_eq!(gate(WRITE_PERMISSION, false, Some("A"), &all).unwrap_err().path, "terminals.write");
        assert_eq!(gate(READ_PERMISSION, true, None, &all).unwrap_err().code, "NotFound");
        assert_eq!(gate(WRITE_PERMISSION, true, Some("A"), &only_b).unwrap_err().path, "terminals.write");
        assert_eq!(gate(READ_PERMISSION, true, Some("B"), &only_b).unwrap(), "B");
    }

    #[test]
    fn a_terminal_belongs_to_the_package_project_then_the_task_project_then_the_longest_folder() {
        let owners = BTreeMap::from([("opened".to_owned(), "B".to_owned())]);
        let sessions = BTreeMap::from([("s1".to_owned(), "A".to_owned())]);
        let projects = vec![("A".to_owned(), "C:\\work\\a".to_owned()), ("N".to_owned(), "C:/work/a/nested".to_owned()), ("Z".to_owned(), "C:/work/zz".to_owned())];
        let attribution = Attribution { owners: &owners, sessions: &sessions, projects: &projects };
        assert_eq!(attribute(&attribution, &listed("opened", "C:/work/a", Some("s1"))).as_deref(), Some("B"));
        assert_eq!(attribute(&attribution, &listed("t", "C:/elsewhere", Some("s1"))).as_deref(), Some("A"));
        assert_eq!(attribute(&attribution, &listed("t", "C:/work/a/src", None)).as_deref(), Some("A"));
        assert_eq!(attribute(&attribution, &listed("t", "C:/work/a/nested/deep", None)).as_deref(), Some("N"));
        // A folder that only shares a prefix is not inside the project, and a terminal of no project is nobody's.
        assert_eq!(attribute(&attribution, &listed("t", "C:/work/aa", None)), None);
        assert_eq!(attribute(&attribution, &listed("t", "D:/tmp", None)), None);
    }

    #[test]
    fn list_shows_only_the_terminals_of_granted_projects() {
        let all = vec![(listed("a1", "/a", None), Some("A".to_owned())), (listed("b1", "/b", None), Some("B".to_owned())), (listed("x", "/x", None), None)];
        let only_a = |project: &str| project == "A";
        let shown = list_value(&all, None, &only_a);
        assert_eq!(shown.as_array().unwrap().len(), 1);
        assert_eq!(shown[0]["id"], "a1");
        assert_eq!(shown[0]["projectId"], "A");
        assert_eq!(list_value(&all, Some("B"), &only_a), json!([]));
        assert_eq!(list_value(&all, None, &|_: &str| true).as_array().unwrap().len(), 2);
    }

    #[test]
    fn consecutive_pages_join_without_a_gap_or_a_repeat_and_say_what_was_dropped() {
        let first = page_value(&page("hello", 5));
        let second = page_value(&page(" world", 11));
        assert_eq!((first["cursor"].clone(), first["nextCursor"].clone()), (json!(0), json!(5)));
        assert_eq!((second["cursor"].clone(), second["nextCursor"].clone()), (json!(5), json!(11)));
        let lost = page_value(&Page { data: "tail".into(), next: 300_004, dropped: 40_000, exited: true, exit_code: Some(0) });
        assert_eq!((lost["dropped"].clone(), lost["cursor"].clone(), lost["exited"].clone(), lost["exitCode"].clone(), lost["schemaVersion"].clone()), (json!(40_000), json!(300_000), json!(true), json!(0), json!(1)));
    }

    /// A fake log: the bytes of `text` from offset `start`, read in pages of `budget`.
    fn log_reader(text: &'static str, budget: usize) -> impl Fn(&str, u64) -> Option<Page> {
        move |terminal: &str, cursor: u64| {
            if terminal == "gone" { return None; }
            let from = (cursor as usize).min(text.len());
            let to = (from + budget).min(text.len());
            Some(Page { data: text[from..to].to_owned(), next: to as u64, dropped: 0, exited: false, exit_code: None })
        }
    }

    #[test]
    fn a_subscription_delivers_at_most_ten_chunks_a_second_and_joins_them_exactly() {
        let state = TerminalState::default();
        let id = state.subscribe("sample.terminals", "1.0.0", "t1", "A", 0).unwrap();
        let allowed = |_: &Sub| true;
        let read = log_reader("0123456789abcdefghij", 6);
        let mut seen = String::new();
        let mut chunks = 0;
        // Poll every millisecond for a second: only one read per tick may happen.
        for now in 1..=1000u64 {
            let answer = state.poll(&id, "sample.terminals", now, &allowed, &read).unwrap();
            if let Some(data) = answer["chunk"]["data"].as_str() { seen.push_str(data); chunks += 1; }
            if now < 100 && chunks > 1 { panic!("a second chunk inside one tick"); }
        }
        assert_eq!(seen, "0123456789abcdefghij");
        assert!(chunks <= 10, "{chunks}");
        // A tick that has not elapsed reads nothing and says how long to wait.
        let fresh = state.subscribe("sample.terminals", "1.0.0", "t1", "A", 0).unwrap();
        assert_eq!(state.poll(&fresh, "sample.terminals", 5, &allowed, &read).unwrap()["chunk"]["data"], "012345");
        let waiting = state.poll(&fresh, "sample.terminals", 50, &allowed, &read).unwrap();
        assert_eq!((waiting["chunk"].clone(), waiting["retryMs"].clone()), (Value::Null, json!(55)));
    }

    #[test]
    fn a_closed_terminal_a_foreign_id_and_a_revoked_grant_end_the_subscription() {
        let state = TerminalState::default();
        let read = log_reader("abc", 64);
        let allowed = |_: &Sub| true;
        let id = state.subscribe("sample.terminals", "1.0.0", "t1", "A", 0).unwrap();
        // Another package cannot pump or remove it.
        assert_eq!(state.poll(&id, "sample.other", 1, &allowed, &read).unwrap_err().code, "NotFound");
        assert!(!state.unsubscribe("sample.other", &id));
        assert_eq!(state.count("sample.terminals"), 1);
        // The grant went: the next pump removes the subscription and names the permission.
        let revoked = |_: &Sub| false;
        let refusal = state.poll(&id, "sample.terminals", 1, &revoked, &read).unwrap_err();
        assert_eq!((refusal.code.as_str(), refusal.path.as_str()), ("PermissionDenied", "terminals.read"));
        assert_eq!(state.count("sample.terminals"), 0);
        // The terminal was closed: the subscription ends with a closed marker and is removed.
        let gone = state.subscribe("sample.terminals", "1.0.0", "gone", "A", 0).unwrap();
        let ended = state.poll(&gone, "sample.terminals", 1, &allowed, &read).unwrap();
        assert_eq!((ended["ended"].clone(), ended["reason"].clone()), (json!(true), json!("closed")));
        assert_eq!(state.poll(&gone, "sample.terminals", 2, &allowed, &read).unwrap_err().code, "NotFound");
        // A terminal that exited delivers its last bytes and the exit code once, then the subscription is gone.
        let done = state.subscribe("sample.terminals", "1.0.0", "t1", "A", 0).unwrap();
        let exiting = |_: &str, _: u64| Some(Page { data: "bye".into(), next: 3, dropped: 0, exited: true, exit_code: Some(2) });
        let last = state.poll(&done, "sample.terminals", 1, &allowed, &exiting).unwrap();
        assert_eq!((last["ended"].clone(), last["chunk"]["exitCode"].clone(), last["chunk"]["data"].clone()), (json!(true), json!(2), json!("bye")));
        assert_eq!(state.count("sample.terminals"), 0);
    }

    #[test]
    fn dropped_output_is_reported_never_skipped_silently_and_an_idle_tick_is_empty() {
        let state = TerminalState::default();
        let allowed = |_: &Sub| true;
        let id = state.subscribe("sample.terminals", "1.0.0", "t1", "A", 0).unwrap();
        let missed = |_: &str, _: u64| Some(Page { data: "tail".into(), next: 300_004, dropped: 300_000, exited: false, exit_code: None });
        let answer = state.poll(&id, "sample.terminals", 1, &allowed, &missed).unwrap();
        assert_eq!((answer["chunk"]["dropped"].clone(), answer["chunk"]["cursor"].clone()), (json!(300_000), json!(300_000)));
        let idle = |_: &str, cursor: u64| Some(Page { data: String::new(), next: cursor, dropped: 0, exited: false, exit_code: None });
        let answer = state.poll(&id, "sample.terminals", 200, &allowed, &idle).unwrap();
        assert_eq!((answer["chunk"].clone(), answer["ended"].clone()), (Value::Null, json!(false)));
    }

    #[test]
    fn subscriptions_are_bounded_per_package_and_end_with_the_service_the_terminal_or_unsubscribe() {
        let state = TerminalState::default();
        let mut ids = vec![];
        for _ in 0..MAX_SUBSCRIPTIONS { ids.push(state.subscribe("sample.terminals", "1.0.0", "t1", "A", 0).unwrap()); }
        assert_eq!(state.subscribe("sample.terminals", "1.0.0", "t1", "A", 0).unwrap_err().code, "LimitExceeded");
        assert!(state.subscribe("sample.other", "1.0.0", "t1", "A", 0).is_ok());
        assert!(state.unsubscribe("sample.terminals", &ids[0]));
        assert!(!state.unsubscribe("sample.terminals", &ids[0]));
        assert!(state.subscribe("sample.terminals", "1.0.0", "t2", "A", 0).is_ok());
        state.record_owner("t1", "sample.terminals", "A");
        state.record_owner("t9", "sample.other", "B");
        assert_eq!((state.handles("sample.terminals"), state.projects().get("t1").cloned()), (1, Some("A".to_owned())));
        // Closing one terminal removes its subscriptions and its handle; the service ending removes the rest.
        assert_eq!(state.forget_terminal("t1"), MAX_SUBSCRIPTIONS - 1 + 1);
        assert_eq!(state.handles("sample.terminals"), 0);
        assert_eq!(state.drop_subscriptions("sample.other"), 0);
        assert_eq!(state.cancel_owner("sample.terminals"), 1);
        assert_eq!((state.count("sample.terminals"), state.count("sample.other"), state.handles("sample.other")), (0, 0, 1));
    }
}
