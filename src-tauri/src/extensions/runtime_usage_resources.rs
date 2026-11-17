//! Usage, limits, accounts and metrics for background services (runtime phase R2, slice R0204).
//!
//! Four read-only resources of `panda.context.query`, each behind its own named permission, plus one request:
//! - `usage` (`tasks.usage.read`, per project): the LAST report of every turn of one task. The host records each
//!   `usage` event of a run in `extension_turn_usage` (one row per task and turn, `reports` counts how many reports
//!   that turn made), so the figures survive reopening the app. `input` and `output` are absent: a provider event
//!   carries only the used tokens and the window, and nothing is invented.
//! - `limits` (`harnesses.limits.read`): the windows the built-in usage view last read, per harness and account.
//!   It serves the cache and never starts a check; a harness nobody has read yet has no row.
//! - `accounts` (`harnesses.accounts.read`): one row per account the harness can run with (its own setup and each
//!   saved connection): label, plan, whether it is signed in when a reading says so. Never a credential value
//!   (ADR-0006): connections are projected field by field and their environment, secrets and folders are not read.
//! - `metrics` (`metrics.read`): totals the host measures now (core resident memory, agents, terminals, database
//!   size) and the resident memory of each running service. Per-task figures need a collector that does not exist,
//!   so `tasks` is absent and `unmeasured` says so; a value the platform cannot measure is omitted, never `0`.
//! - `limitsRefresh` (`panda.harnesses.refreshLimits`, `harnesses.limits.read`): asks the built-in usage view to
//!   read again, at most once per harness per 60 s across the whole app (`LimitExceeded` before that).
//!
//! The grant is checked natively on every call, registered as work, and checked again before the result is returned,
//! so revocation or narrowing during a read or a refresh wins over its result. The new resources cannot be
//! subscribed to (`ContextResource` is unchanged): a package that wants to follow them reads again after an event.
//! Limits are for stability and predictability only: a page is at most 50 items and 256 KiB.
//! `src/extensions/runtime-usage-resources.ts` mirrors the rules for the browser preview.
use crate::extensions::{runtime_grants::{RuntimeGrants, Target}, runtime_service_lifetime::{runtime_content_resources as content, DispatchRequest}};
use crate::storage::{ContextUsage, Store};
use serde_json::{json, Value};
use std::{collections::{BTreeSet, HashMap}, sync::Mutex, time::Duration};

/// Items in one page and bytes of one page: the same bounds as the task content resources.
pub const PAGE_ITEMS: u32 = content::PAGE_ITEMS;
pub const PAGE_BYTES: usize = content::PAGE_BYTES;
const MAX_CURSOR: u32 = 1_000_000;
/// How soon one harness may be refreshed again.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(60);
/// The resources this module answers and the permission each one needs.
pub const RESOURCES: [(&str, &str); 4] = [
    ("usage", "tasks.usage.read"), ("limits", "harnesses.limits.read"), ("accounts", "harnesses.accounts.read"), ("metrics", "metrics.read"),
];
const LIMITS: &str = "harnesses.limits.read";

type Reply = Result<Value, &'static str>;

// ---------------------------------------------------------------------------------------------------------------
// The per-turn ledger.

const LEDGER: &str = "CREATE TABLE IF NOT EXISTS extension_turn_usage(
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn INTEGER NOT NULL CHECK(turn >= 0),
    used_tokens INTEGER NOT NULL CHECK(used_tokens >= 0 AND used_tokens <= 1000000000),
    context_window INTEGER CHECK(context_window > 0 AND context_window <= 1000000000),
    reports INTEGER NOT NULL CHECK(reports >= 1),
    at INTEGER NOT NULL,
    PRIMARY KEY(session_id, turn)
) WITHOUT ROWID";

/// Records one `usage` report of a run: the turn is the number of user messages the task has now (the numbering of
/// the transcript), the row of that turn keeps the LAST report and counts them. The table is created on first use and
/// is removed with its task. A failure never fails the run that reported.
pub fn record(store: &Store, session_id: &str, usage: &ContextUsage) -> rusqlite::Result<()> {
    store.db.execute_batch(LEDGER)?;
    let turn: i64 = store.db.query_row("SELECT COUNT(*) FROM messages WHERE session_id=?1 AND role='user'", [session_id], |row| row.get(0))?;
    store.db.execute(
        "INSERT INTO extension_turn_usage(session_id,turn,used_tokens,context_window,reports,at) VALUES(?1,?2,?3,?4,1,?5)
         ON CONFLICT(session_id,turn) DO UPDATE SET used_tokens=excluded.used_tokens, context_window=excluded.context_window, reports=reports+1, at=excluded.at",
        rusqlite::params![session_id, turn, usage.used_tokens as i64, usage.context_window.map(|window| window as i64), crate::storage::now()],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// The throttle of `refreshLimits`.

/// When each harness was last admitted for a refresh, on a clock the caller supplies (monotonic time since a start).
#[derive(Default)]
pub struct Throttle { last: Mutex<HashMap<String, Duration>> }
impl Throttle {
    /// Admits a refresh of `harness` at `now`, or answers how long it must still wait. The boundary is exact: at
    /// 60 s after the last admitted refresh the next one is admitted.
    pub fn admit(&self, harness: &str, now: Duration) -> Result<(), Duration> {
        let Ok(mut last) = self.last.lock() else { return Ok(()) };
        if let Some(at) = last.get(harness) {
            let waited = now.saturating_sub(*at);
            if waited < REFRESH_INTERVAL { return Err(REFRESH_INTERVAL - waited); }
        }
        last.insert(harness.to_owned(), now);
        Ok(())
    }
    /// The harnesses of `targets` admitted at `now`; `LimitExceeded` when there were targets and none was admitted.
    pub fn plan(&self, targets: &[String], now: Duration) -> Result<Vec<String>, &'static str> {
        let admitted: Vec<String> = targets.iter().filter(|harness| self.admit(harness, now).is_ok()).cloned().collect();
        if admitted.is_empty() && !targets.is_empty() { Err("LimitExceeded") } else { Ok(admitted) }
    }
}
fn app_throttle() -> (&'static Throttle, Duration) {
    use std::sync::OnceLock;
    static THROTTLE: OnceLock<(Throttle, std::time::Instant)> = OnceLock::new();
    let (throttle, start) = THROTTLE.get_or_init(|| (Throttle::default(), std::time::Instant::now()));
    (throttle, start.elapsed())
}

// ---------------------------------------------------------------------------------------------------------------
// Row builders, pure so that they are proven without the app.

/// `windows` entries of a reading: a stable id from the label, the label, the used percent and the reset time.
pub(crate) fn limit_row(harness: &str, account: &str, usage: &crate::agent_usage::Usage) -> Value {
    let mut seen = BTreeSet::new();
    let windows: Vec<Value> = usage.windows.iter().take(32).enumerate().map(|(index, window)| {
        let mut id: String = window.label.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
        id = id.trim_matches('-').chars().take(48).collect();
        if id.is_empty() || !seen.insert(id.clone()) { id = format!("{id}-{index}"); seen.insert(id.clone()); }
        let mut item = json!({"id": id, "label": window.label.chars().take(120).collect::<String>(), "usedPercent": window.used_percent});
        if let Some(resets) = &window.resets_at { item["resetsAt"] = json!(resets); }
        item
    }).collect();
    json!({"harness": harness, "account": account, "status": usage.status, "stale": usage.stale, "windows": windows, "readAt": usage.checked_at})
}

/// Whether a reading proves the account signed in (`true`), signed out (`false`) or neither (`None`).
fn signed_in(status: &str) -> Option<bool> { match status { "ready" => Some(true), "signedOut" => Some(false), _ => None } }

/// One account row. `label` is what the user named a connection, or the account e-mail a reading shows; `plan` the
/// plan a reading shows. Only these projected fields are read: nothing else of a connection reaches a package.
pub(crate) fn account_row(harness: &str, id: &str, active: bool, name: Option<&str>, reading: Option<&crate::agent_usage::Usage>) -> Value {
    let mut row = json!({"harness": harness, "id": id, "active": active, "signedIn": reading.and_then(|usage| signed_in(&usage.status)), "status": reading.map_or("unchecked", |usage| usage.status.as_str())});
    let label = name.map(str::to_owned).or_else(|| reading.and_then(|usage| usage.email.clone()));
    if let Some(label) = label { row["label"] = json!(label.chars().take(120).collect::<String>()); }
    if let Some(plan) = reading.and_then(|usage| usage.plan.as_ref()) { row["plan"] = json!(plan.chars().take(64).collect::<String>()); }
    row
}

/// The `metrics` item: the measured app totals and the services' resident memory. A figure that could not be
/// measured is absent, `tasks` is absent because nothing collects per-task figures, and `unmeasured` says so.
pub(crate) fn metrics_item(core_rss: Option<u64>, agents: Option<usize>, terminals: Option<usize>, database: Option<u64>, services: &Value) -> Value {
    let mut app = serde_json::Map::new();
    let mut unmeasured = vec![json!("tasks")];
    for (name, value) in [("coreRssBytes", core_rss), ("activeAgents", agents.map(|n| n as u64)), ("activeTerminals", terminals.map(|n| n as u64)), ("databaseBytes", database)] {
        match value { Some(value) => { app.insert(name.into(), json!(value)); } None => unmeasured.push(json!(format!("app.{name}"))) }
    }
    let rows: Vec<Value> = services["services"].as_array().into_iter().flatten()
        .filter(|service| matches!(service["state"].as_str(), Some("running" | "starting" | "stopping")) || service["supervision"]["memory"].is_object())
        .filter_map(|service| {
            let mut row = json!({"package": service["id"]});
            match service["supervision"]["memory"]["residentBytes"].as_u64() { Some(bytes) => row["rssBytes"] = json!(bytes), None => unmeasured.push(json!(format!("services.{}", service["id"].as_str()?))) }
            Some(row)
        }).collect();
    json!({"app": app, "services": rows, "unmeasured": unmeasured})
}

/// The resident set of this process, `None` where nothing measures it.
fn core_rss() -> Option<u64> {
    #[cfg(unix)]
    { std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).and_then(|s| s.trim().parse::<u64>().ok()).map(|kib| kib * 1024) }
    #[cfg(not(unix))]
    { crate::extensions::runtime_service_lifetime::runtime_service_supervision::resident_bytes(&[std::process::id()]) }
}

// ---------------------------------------------------------------------------------------------------------------
// The data behind the three non-task resources.

/// What the app knows right now; the live implementation reads the usage cache, the saved connections and the
/// running services, tests supply fixed rows.
pub trait Facts {
    fn limits(&self, harness: Option<&str>) -> Vec<Value>;
    fn accounts(&self, harness: Option<&str>) -> Vec<Value>;
    fn metrics(&self, store: &Store) -> Value;
}

fn known_harness(id: &str) -> bool { crate::providers::PROVIDERS.iter().any(|(known, _)| *known == id) || crate::extensions::runtime_provider_state::is_published(id) }
fn harness_ids(only: Option<&str>) -> Vec<&'static str> {
    crate::providers::PROVIDERS.iter().map(|(id, _)| *id).filter(|id| only.is_none_or(|only| only == *id)).collect()
}

struct Live<'a> { app: &'a tauri::AppHandle }
impl Facts for Live<'_> {
    fn limits(&self, harness: Option<&str>) -> Vec<Value> {
        let mut rows = Vec::new();
        for id in harness_ids(harness) {
            if let Some(usage) = crate::agent_usage::peek(id) { rows.push(limit_row(id, "default", &usage)); }
            for connection in crate::connections::pool_members(id) {
                if let Some(usage) = crate::agent_usage::peek_connection(&connection.id, connection.revision) { rows.push(limit_row(id, &connection.id, &usage)); }
            }
        }
        // Providers of packages whose service published limits (R0806): one source with the model picker's roster.
        rows.extend(crate::extensions::runtime_provider_state::limit_rows(harness));
        rows
    }
    fn accounts(&self, harness: Option<&str>) -> Vec<Value> {
        let mut rows = Vec::new();
        for id in harness_ids(harness) {
            // The active account is the one a package switched to (R0805, `credentials.use`), else the harness's own setup.
            let active = crate::extensions::runtime_service_lifetime::runtime_held_credentials::active_account(id);
            rows.push(account_row(id, "default", active.is_none(), None, crate::agent_usage::peek(id).as_ref()));
            for connection in crate::connections::pool_members(id) {
                rows.push(account_row(id, &connection.id, active.as_deref() == Some(connection.id.as_str()), Some(&connection.name), crate::agent_usage::peek_connection(&connection.id, connection.revision).as_ref()));
            }
        }
        rows.extend(crate::extensions::runtime_provider_state::account_rows(harness));
        rows
    }
    fn metrics(&self, store: &Store) -> Value {
        use tauri::Manager;
        let state = self.app.state::<crate::AppState>();
        let agents = crate::run_requests::lock_agents(&state.agents).ok().map(|agents| agents.len());
        let terminals = state.terminals.lock().ok().map(|terminals| terminals.len());
        let path = store.path.clone();
        let database = Some(std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) + std::fs::metadata(format!("{}-wal", path.display())).map(|m| m.len()).unwrap_or(0));
        let services = self.app.try_state::<crate::extensions::runtime_service_lifetime::ServiceLifetime>().map_or(json!({}), |services| services.projection());
        metrics_item(core_rss(), agents, terminals, database, &services)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The query.

/// `true` when the package holds `permission` for any scope (the project is checked per task afterwards).
fn holds(grants: &RuntimeGrants, owner: &str, version: &str, permission: &str) -> bool {
    grants.projection()["packages"].as_array().into_iter().flatten().any(|package| {
        package["id"] == owner && package["version"] == version && package["authorized"] == true
            && package["grants"].as_array().into_iter().flatten().any(|grant| grant["permission"] == permission)
    })
}

fn listing(items: Vec<Value>, (limit, cursor): (u32, u32), expected: Option<&str>) -> Reply {
    let revision = format!("{:x}", content::settings_revision(&Value::Array(items.clone())));
    if expected.is_some_and(|expected| expected != revision) { return Err("StaleContext"); }
    let total = items.len();
    let mut page: Vec<Value> = items.into_iter().skip(cursor as usize).take(limit as usize).collect();
    let mut more = cursor as usize + page.len() < total;
    while page.len() > 1 && json!(page).to_string().len() > PAGE_BYTES { page.pop(); more = true; }
    let next = more.then(|| cursor as usize + page.len());
    Ok(json!({"schemaVersion": 1, "state": "Ready", "revision": revision, "items": page, "nextCursor": next}))
}

fn turns(store: &Store, task: &str, (limit, cursor): (u32, u32), expected: Option<&str>) -> Reply {
    store.db.execute_batch(LEDGER).map_err(|_| "HostUnavailable")?;
    let (count, reports): (i64, i64) = store.db.query_row("SELECT COUNT(*), COALESCE(SUM(reports),0) FROM extension_turn_usage WHERE session_id=?1", [task], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|_| "HostUnavailable")?;
    let revision = format!("u{count}.{reports}");
    if expected.is_some_and(|expected| expected != revision) { return Err("StaleContext"); }
    let mut statement = store.db.prepare("SELECT turn, used_tokens, context_window, reports, at FROM extension_turn_usage WHERE session_id=?1 ORDER BY turn LIMIT ?2 OFFSET ?3").map_err(|_| "HostUnavailable")?;
    let rows = statement.query_map(rusqlite::params![task, i64::from(limit) + 1, i64::from(cursor)], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, Option<i64>>(2)?, row.get::<_, i64>(3)?, row.get::<_, i64>(4)?))).map_err(|_| "HostUnavailable")?;
    let mut items = Vec::new(); let mut more = false;
    for row in rows {
        let (turn, used, window, reports, at) = row.map_err(|_| "HostUnavailable")?;
        if items.len() == limit as usize { more = true; break; }
        let mut item = json!({"taskId": task, "turn": turn, "usedTokens": used, "reports": reports, "at": at});
        if let Some(window) = window { item["contextWindow"] = json!(window); }
        items.push(item);
    }
    while items.len() > 1 && json!(items).to_string().len() > PAGE_BYTES { items.pop(); more = true; }
    let next = more.then(|| cursor + items.len() as u32);
    Ok(json!({"schemaVersion": 1, "state": "Ready", "revision": revision, "items": items, "nextCursor": next}))
}

/// One `panda.context.query` for `usage`, `limits`, `accounts` or `metrics`, for the package `owner` at `version`.
pub fn query(grants: &RuntimeGrants, store: &Store, facts: &dyn Facts, owner: &str, version: &str, params: &Value) -> Reply {
    let object = params.as_object().ok_or("InvalidShape")?;
    const KEYS: [&str; 6] = ["resource", "taskId", "harness", "limit", "cursor", "revision"];
    if object.keys().any(|key| !KEYS.contains(&key.as_str())) { return Err("InvalidShape"); }
    let resource = object.get("resource").and_then(Value::as_str).ok_or("InvalidShape")?;
    let permission = RESOURCES.iter().find(|(name, _)| *name == resource).map(|(_, permission)| *permission).ok_or("UnsupportedCapability")?;
    let limit = match object.get("limit") { None => 10, Some(value) => value.as_u64().filter(|limit| (1..=u64::from(PAGE_ITEMS)).contains(limit)).ok_or("LimitExceeded")? as u32 };
    let cursor = match object.get("cursor") { None | Some(Value::Null) => 0, Some(value) => value.as_u64().filter(|cursor| *cursor <= u64::from(MAX_CURSOR)).ok_or("LimitExceeded")? as u32 };
    let expected = match object.get("revision") { None | Some(Value::Null) => None, Some(value) => Some(value.as_str().filter(|text| text.len() <= 64).ok_or("LimitExceeded")?) };
    let present = |key: &str| object.get(key).is_some_and(|value| !value.is_null());
    let harness = match object.get("harness") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_str().filter(|id| !id.is_empty() && id.len() <= 64).ok_or("InvalidShape")?),
    };
    // Which selectors a resource takes; anything else is a malformed request, before any lookup.
    match resource {
        "usage" if present("harness") => return Err("InvalidShape"),
        "limits" | "accounts" if present("taskId") => return Err("InvalidShape"),
        "metrics" if present("taskId") || present("harness") => return Err("InvalidShape"),
        _ => {}
    }
    // Holding the permission at all comes first, so a package without it learns nothing about the data.
    if !holds(grants, owner, version, permission) { return Err("PermissionDenied"); }
    if resource == "usage" {
        let task = object.get("taskId").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 256).ok_or("InvalidShape")?;
        let project: String = store.db.query_row("SELECT project_id FROM sessions WHERE id=?1 AND draft=0", [task], |row| row.get(0))
            .map_err(|error| if matches!(error, rusqlite::Error::QueryReturnedNoRows) { "NotFound" } else { "HostUnavailable" })?;
        let target = Target::project(&project);
        let work = grants.begin(owner, version, permission, &target).map_err(|_| "PermissionDenied")?;
        let page = turns(store, task, (limit, cursor), expected)?;
        if work.is_cancelled() || grants.check(owner, version, permission, &target).is_err() { return Err("PermissionDenied"); }
        return Ok(page);
    }
    if let Some(id) = harness { if !known_harness(id) { return Err("NotFound"); } }
    let target = Target::default();
    let work = grants.begin(owner, version, permission, &target).map_err(|_| "PermissionDenied")?;
    let page = match resource {
        "limits" => listing(facts.limits(harness), (limit, cursor), expected)?,
        "accounts" => listing(facts.accounts(harness), (limit, cursor), expected)?,
        _ => listing(vec![facts.metrics(store)], (limit, cursor), expected)?,
    };
    if work.is_cancelled() || grants.check(owner, version, permission, &target).is_err() { return Err("PermissionDenied"); }
    Ok(page)
}

/// The harnesses `refreshLimits` targets: the one named, or every harness the usage view already read.
fn refresh_targets(params: &Value, cached: impl Fn(&str) -> bool) -> Result<Vec<String>, &'static str> {
    let object = match params { Value::Null => None, other => Some(other.as_object().ok_or("InvalidArguments")?) };
    if object.is_some_and(|object| object.keys().any(|key| key != "harness")) { return Err("InvalidArguments"); }
    match object.and_then(|object| object.get("harness")) {
        None | Some(Value::Null) => Ok(harness_ids(None).into_iter().filter(|id| cached(id)).map(str::to_owned).collect()),
        Some(value) => { let id = value.as_str().filter(|id| !id.is_empty() && id.len() <= 64).ok_or("InvalidArguments")?; if known_harness(id) { Ok(vec![id.to_owned()]) } else { Err("NotFound") } }
    }
}

/// The installed version of `owner` while it is enabled and safe mode is off.
pub(crate) fn enabled_version(packages: &crate::extensions::packages::Packages, owner: &str) -> Option<String> {
    let snapshot = packages.snapshot();
    if snapshot.safe_mode { return None; }
    snapshot.packages.iter().find(|package| package.enabled && package.manifest["id"] == owner).and_then(|package| package.manifest["version"].as_str().map(str::to_owned))
}

fn reply(result: Reply) -> Value {
    match result { Ok(value) => json!({"ok": true, "value": value}), Err(code) => crate::extensions::context::failure(code) }
}

/// Serves `usageQuery` and `limitsRefresh`. Anything else is not this module's.
pub async fn serve(app: tauri::AppHandle, request: DispatchRequest) -> Value {
    use tauri::Manager;
    let prepared = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<Prepared, &'static str> {
            let packages = app.state::<crate::extensions::packages::ExtensionPackages>();
            let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
            let version = enabled_version(&packages, &request.owner).ok_or("PermissionDenied")?;
            let grants = app.state::<RuntimeGrants>();
            match request.method.as_str() {
                "usageQuery" => {
                    let state = app.state::<crate::AppState>();
                    let store = state.store.try_lock().map_err(|_| "Timeout")?;
                    query(&grants, &store, &Live { app: &app }, &request.owner, &version, &request.params).map(Prepared::Page)
                }
                "limitsRefresh" => {
                    let work = grants.begin(&request.owner, &version, LIMITS, &Target::default()).map_err(|_| "PermissionDenied")?;
                    let targets = refresh_targets(&request.params, |id| crate::agent_usage::peek(id).is_some())?;
                    let (throttle, now) = app_throttle();
                    let admitted = throttle.plan(&targets, now)?;
                    Ok(Prepared::Refresh { owner: request.owner.clone(), version, harnesses: admitted, work })
                }
                _ => Err("UnsupportedCapability"),
            }
        }).await.unwrap_or(Err("HostUnavailable"))
    };
    match prepared {
        Err(code) => reply(Err(code)),
        Ok(Prepared::Page(page)) => reply(Ok(page)),
        Ok(Prepared::Refresh { owner, version, harnesses, work }) => {
            let mut set = tokio::task::JoinSet::new();
            for harness in harnesses { set.spawn(async move { let _ = crate::agent_usage::query_usage(harness, true).await; }); }
            while set.join_next().await.is_some() {}
            // Revocation or narrowing while the readings were taken wins over the refresh.
            let grants = app.state::<RuntimeGrants>();
            if work.is_cancelled() || grants.check(&owner, &version, LIMITS, &Target::default()).is_err() { return reply(Err("PermissionDenied")); }
            reply(Ok(Value::Null))
        }
    }
}

enum Prepared { Page(Value), Refresh { owner: String, version: String, harnesses: Vec<String>, work: crate::extensions::runtime_grants::Work } }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_usage::{Usage, UsageWindow};
    use crate::extensions::runtime_grants::Scope;

    struct Dir(std::path::PathBuf);
    impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-usage-test-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    const A: &str = "sample.usage-resources";
    const B: &str = "sample.other";
    const PERMISSIONS: [&str; 4] = ["tasks.usage.read", "harnesses.limits.read", "harnesses.accounts.read", "metrics.read"];

    fn projects(names: &[&str]) -> Scope { Scope { projects: Some(names.iter().map(|name| (*name).to_owned()).collect()), ..Scope::default() } }
    fn grants(dir: &Dir) -> RuntimeGrants {
        let grants = RuntimeGrants::open(&dir.0);
        for id in [A, B] { grants.register_package(id, "1.0.0", &PERMISSIONS, Some("digest")).unwrap(); grants.trust(id, true).unwrap(); }
        grants
    }
    fn store() -> Store {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        store.db.execute("INSERT INTO projects(id,name,path) VALUES ('A','Alpha','/a'),('B','Beta','/b')", []).unwrap();
        for (id, project) in [("a1", "A"), ("b1", "B")] {
            store.db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at) VALUES (?1,?2,'t','claude','opus','ask','pending',1,1)", [id, project]).unwrap();
        }
        store
    }
    fn reading(status: &str) -> Usage {
        let mut usage = Usage::empty("claude", status, "");
        usage.windows = vec![UsageWindow::new("5 hour window", 42.5, Some("2026-11-17T00:00:00Z".into())), UsageWindow::new("Weekly", 10.0, None), UsageWindow::new("Weekly", 11.0, None)];
        usage.email = Some("person@example.test".into()); usage.plan = Some("Max".into()); usage.checked_at = 1234;
        usage
    }
    struct Fixed;
    impl Facts for Fixed {
        fn limits(&self, harness: Option<&str>) -> Vec<Value> { (if harness.is_none_or(|h| h == "claude") { vec![limit_row("claude", "default", &reading("ready"))] } else { vec![] }).into_iter().collect() }
        fn accounts(&self, harness: Option<&str>) -> Vec<Value> { (if harness.is_none_or(|h| h == "claude") { vec![account_row("claude", "default", true, None, Some(&reading("ready")))] } else { vec![] }).into_iter().collect() }
        fn metrics(&self, _: &Store) -> Value { metrics_item(Some(100), Some(2), Some(1), Some(4096), &json!({"services": [{"id": A, "state": "running", "supervision": {"memory": {"residentBytes": 777}}}]})) }
    }
    fn ask(grants: &RuntimeGrants, store: &Store, owner: &str, params: Value) -> Reply { query(grants, store, &Fixed, owner, "1.0.0", &params) }
    fn say(store: &Store, task: &str, role: &str) { store.insert_message(task, role, "x").unwrap(); }
    fn usage(used: u64, window: Option<u64>) -> ContextUsage { ContextUsage { used_tokens: used, context_window: window } }

    #[test]
    fn the_last_report_of_each_turn_is_kept_and_survives_reopening() {
        let dir = Dir::new(); let path = dir.0.join("panda.db");
        {
            let store = Store::open(&path).unwrap();
            store.db.execute("INSERT INTO projects(id,name,path) VALUES ('A','Alpha','/a')", []).unwrap();
            store.db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at) VALUES ('a1','A','t','claude','opus','ask','pending',1,1)", []).unwrap();
            say(&store, "a1", "user");
            record(&store, "a1", &usage(1000, Some(200_000))).unwrap();
            record(&store, "a1", &usage(1500, Some(200_000))).unwrap();
            say(&store, "a1", "assistant"); say(&store, "a1", "user");
            record(&store, "a1", &usage(4000, None)).unwrap();
        }
        let store = Store::open(&path).unwrap();
        let grants = grants(&dir);
        grants.grant(A, "tasks.usage.read", projects(&["A"])).unwrap();
        let page = ask(&grants, &store, A, json!({"resource": "usage", "taskId": "a1"})).unwrap();
        let items = page["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        // Turn 1: the LAST of its two reports; turn 2 has no window and says nothing about it; input/output are absent.
        assert_eq!((items[0]["turn"].as_i64(), items[0]["usedTokens"].as_i64(), items[0]["contextWindow"].as_i64(), items[0]["reports"].as_i64()), (Some(1), Some(1500), Some(200_000), Some(2)));
        assert_eq!((items[1]["turn"].as_i64(), items[1]["usedTokens"].as_i64(), items[1]["reports"].as_i64()), (Some(2), Some(4000), Some(1)));
        assert!(items[1].get("contextWindow").is_none() && items.iter().all(|item| item.get("input").is_none() && item.get("output").is_none() && item["taskId"] == "a1"));
        // The rows leave with their task.
        store.db.execute("DELETE FROM sessions WHERE id='a1'", []).unwrap();
        let left: i64 = store.db.query_row("SELECT COUNT(*) FROM extension_turn_usage", [], |row| row.get(0)).unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn usage_needs_its_grant_for_the_project_of_the_task_and_revocation_wins() {
        let dir = Dir::new(); let grants = grants(&dir); let store = store();
        say(&store, "a1", "user"); say(&store, "b1", "user");
        record(&store, "a1", &usage(10, None)).unwrap(); record(&store, "b1", &usage(20, None)).unwrap();
        let params = json!({"resource": "usage", "taskId": "a1"});
        // No grant: refused before any lookup, even for a task that does not exist.
        for task in ["a1", "ghost"] { assert_eq!(ask(&grants, &store, A, json!({"resource": "usage", "taskId": task})), Err("PermissionDenied")); }
        // The other read permissions do not reach usage.
        for permission in ["harnesses.limits.read", "harnesses.accounts.read", "metrics.read", "tasks.summary"] { let _ = grants.grant(A, permission, Scope::default()); }
        assert_eq!(ask(&grants, &store, A, params.clone()), Err("PermissionDenied"));
        grants.grant(A, "tasks.usage.read", projects(&["A"])).unwrap();
        assert_eq!(ask(&grants, &store, A, params.clone()).unwrap()["items"][0]["usedTokens"], 10);
        assert_eq!(ask(&grants, &store, A, json!({"resource": "usage", "taskId": "b1"})), Err("PermissionDenied"));
        assert_eq!(ask(&grants, &store, A, json!({"resource": "usage", "taskId": "ghost"})), Err("NotFound"));
        assert_eq!(ask(&grants, &store, B, params.clone()), Err("PermissionDenied"));
        assert_eq!(query(&grants, &store, &Fixed, A, "0.9.0", &params), Err("PermissionDenied"));
        grants.revoke(A, "tasks.usage.read").unwrap();
        assert_eq!(ask(&grants, &store, A, params), Err("PermissionDenied"));
    }

    #[test]
    fn a_new_report_makes_a_continued_usage_page_stale() {
        let dir = Dir::new(); let grants = grants(&dir); let store = store();
        grants.grant(A, "tasks.usage.read", Scope::default()).unwrap();
        for _ in 0..3 { say(&store, "a1", "user"); record(&store, "a1", &usage(5, None)).unwrap(); }
        let first = ask(&grants, &store, A, json!({"resource": "usage", "taskId": "a1", "limit": 2})).unwrap();
        assert_eq!((first["items"].as_array().unwrap().len(), first["nextCursor"].as_u64()), (2, Some(2)));
        let rest = ask(&grants, &store, A, json!({"resource": "usage", "taskId": "a1", "limit": 2, "cursor": 2, "revision": first["revision"]})).unwrap();
        assert_eq!((rest["items"].as_array().unwrap().len(), rest["nextCursor"].clone()), (1, Value::Null));
        record(&store, "a1", &usage(9, None)).unwrap();
        assert_eq!(ask(&grants, &store, A, json!({"resource": "usage", "taskId": "a1", "limit": 2, "cursor": 2, "revision": first["revision"]})), Err("StaleContext"));
    }

    #[test]
    fn limits_accounts_and_metrics_each_need_their_own_grant() {
        let dir = Dir::new(); let grants = grants(&dir); let store = store();
        for resource in ["limits", "accounts", "metrics"] { assert_eq!(ask(&grants, &store, A, json!({"resource": resource})), Err("PermissionDenied"), "{resource}"); }
        grants.grant(A, "harnesses.limits.read", Scope::default()).unwrap();
        assert!(ask(&grants, &store, A, json!({"resource": "limits"})).is_ok());
        assert_eq!(ask(&grants, &store, A, json!({"resource": "accounts"})), Err("PermissionDenied"));
        assert_eq!(ask(&grants, &store, A, json!({"resource": "metrics"})), Err("PermissionDenied"));
        grants.grant(A, "harnesses.accounts.read", Scope::default()).unwrap(); grants.grant(A, "metrics.read", Scope::default()).unwrap();
        assert!(ask(&grants, &store, A, json!({"resource": "accounts"})).is_ok() && ask(&grants, &store, A, json!({"resource": "metrics"})).is_ok());
        assert_eq!(ask(&grants, &store, B, json!({"resource": "metrics"})), Err("PermissionDenied"));
        grants.revoke(A, "metrics.read").unwrap();
        assert_eq!(ask(&grants, &store, A, json!({"resource": "metrics"})), Err("PermissionDenied"));
        assert!(ask(&grants, &store, A, json!({"resource": "limits"})).is_ok());
    }

    #[test]
    fn selectors_and_pages_are_validated_before_anything_is_read() {
        let dir = Dir::new(); let grants = grants(&dir); let store = store();
        for permission in PERMISSIONS { grants.grant(A, permission, Scope::default()).unwrap(); }
        for (params, code) in [
            (json!({"resource": "usage"}), "InvalidShape"),
            (json!({"resource": "usage", "taskId": "a1", "harness": "claude"}), "InvalidShape"),
            (json!({"resource": "limits", "taskId": "a1"}), "InvalidShape"),
            (json!({"resource": "accounts", "taskId": "a1"}), "InvalidShape"),
            (json!({"resource": "metrics", "harness": "claude"}), "InvalidShape"),
            (json!({"resource": "metrics", "taskId": "a1"}), "InvalidShape"),
            (json!({"resource": "limits", "harness": 7}), "InvalidShape"),
            (json!({"resource": "limits", "extra": 1}), "InvalidShape"),
            (json!({"resource": "transcript", "taskId": "a1"}), "UnsupportedCapability"),
            (json!({"resource": "limits", "limit": 51}), "LimitExceeded"),
            (json!({"resource": "limits", "limit": 0}), "LimitExceeded"),
            (json!({"resource": "limits", "harness": "not-a-harness"}), "NotFound"),
        ] { assert_eq!(ask(&grants, &store, A, params.clone()), Err(code), "{params}"); }
    }

    #[test]
    fn limits_serve_the_windows_of_a_reading_and_never_its_account() {
        let dir = Dir::new(); let grants = grants(&dir); let store = store();
        grants.grant(A, "harnesses.limits.read", Scope::default()).unwrap();
        let page = ask(&grants, &store, A, json!({"resource": "limits", "harness": "claude"})).unwrap();
        let item = &page["items"][0];
        assert_eq!((item["harness"].as_str(), item["account"].as_str(), item["status"].as_str(), item["readAt"].as_u64()), (Some("claude"), Some("default"), Some("ready"), Some(1234)));
        assert_eq!(item["windows"][0], json!({"id": "5-hour-window", "label": "5 hour window", "usedPercent": 42.5, "resetsAt": "2026-11-17T00:00:00Z"}));
        // Two windows with one label get distinct ids.
        assert_eq!((item["windows"][1]["id"].as_str(), item["windows"][2]["id"].as_str()), (Some("weekly"), Some("weekly-2")));
        // The account e-mail and plan belong to the accounts grant.
        assert!(!page.to_string().contains("person@example.test") && !page.to_string().contains("Max"));
        // A harness nobody has read has no row, not an invented empty one.
        assert_eq!(ask(&grants, &store, A, json!({"resource": "limits", "harness": "codex"})).unwrap()["items"], json!([]));
    }

    /// Connections are projected field by field: none of their environment, secrets or folders can reach a package.
    #[test]
    fn accounts_name_each_account_and_carry_no_credential_value() {
        let connection = crate::connections::Connection {
            id: "conn-1".into(), provider: "claude".into(), name: "Work".into(), executable: Some("SECRET_PATH".into()), args: vec!["SECRET_ARG".into()],
            env: std::collections::BTreeMap::from([("SECRET_ENV".into(), "SECRET_VALUE".into())]), secret_env: vec!["SECRET_AUTH".into()], config_dir: Some("SECRET_DIR".into()), revision: 3,
        };
        let rows = [
            account_row("claude", "default", true, None, Some(&reading("ready"))),
            account_row("claude", &connection.id, false, Some(&connection.name), None),
            account_row("codex", "default", true, None, Some(&reading("signedOut"))),
            account_row("grok", "default", true, None, Some(&reading("error"))),
        ];
        assert_eq!(rows[0], json!({"harness": "claude", "id": "default", "active": true, "signedIn": true, "status": "ready", "label": "person@example.test", "plan": "Max"}));
        assert_eq!(rows[1], json!({"harness": "claude", "id": "conn-1", "active": false, "signedIn": null, "status": "unchecked", "label": "Work"}));
        assert_eq!(rows[2]["signedIn"], false);
        // A reading that proves nothing about the sign-in says so; it is never turned into a false.
        assert_eq!(rows[3]["signedIn"], Value::Null);
        assert!(!json!(rows).to_string().contains("SECRET"));
        // A reading's own message and dashboard address are not part of a row either.
        let mut noisy = reading("ready"); noisy.message = Some("token=abc".into()); noisy.dashboard_url = Some("https://example.test/secret".into());
        assert!(!account_row("claude", "default", true, None, Some(&noisy)).to_string().contains("abc") && !limit_row("claude", "default", &noisy).to_string().contains("secret"));
    }

    #[test]
    fn metrics_report_what_is_measured_and_name_what_is_not() {
        let services = json!({"services": [
            {"id": "sample.measured", "state": "running", "supervision": {"memory": {"residentBytes": 5000}}},
            {"id": "sample.fresh", "state": "running", "supervision": {"memory": null}},
            {"id": "sample.stopped", "state": "stopped", "supervision": null},
        ]});
        let item = metrics_item(Some(10), Some(2), None, Some(0), &services);
        assert_eq!(item["app"], json!({"coreRssBytes": 10, "activeAgents": 2, "databaseBytes": 0}));
        assert_eq!(item["services"], json!([{"package": "sample.measured", "rssBytes": 5000}, {"package": "sample.fresh"}]));
        assert!(item.get("tasks").is_none());
        let unmeasured: Vec<&str> = item["unmeasured"].as_array().unwrap().iter().map(|name| name.as_str().unwrap()).collect();
        assert_eq!(unmeasured, ["tasks", "app.activeTerminals", "services.sample.fresh"]);
        // A figure that cannot be read is absent, never 0.
        assert!(metrics_item(None, None, None, None, &json!({}))["app"].as_object().unwrap().is_empty());
    }

    #[test]
    fn refresh_is_admitted_once_per_harness_per_sixty_seconds() {
        let throttle = Throttle::default();
        let at = Duration::from_millis;
        assert_eq!(throttle.admit("claude", at(1_000)), Ok(()));
        // 59.999 s later it is refused with the time left; exactly 60 s later it is admitted again.
        assert_eq!(throttle.admit("claude", at(60_999)), Err(at(1)));
        assert_eq!(throttle.admit("claude", at(61_000)), Ok(()));
        // The refusal does not move the window: 60 s after the ADMITTED one counts.
        assert_eq!(throttle.admit("claude", at(120_999)), Err(at(1)));
        assert_eq!(throttle.admit("claude", at(121_000)), Ok(()));
        // Another harness is independent.
        assert_eq!(throttle.admit("codex", at(121_001)), Ok(()));
        // A plan keeps the admitted ones and is `LimitExceeded` only when every target was refused.
        let targets = ["claude".to_owned(), "codex".to_owned(), "kimi".to_owned()];
        assert_eq!(throttle.plan(&targets, at(122_000)), Ok(vec!["kimi".to_owned()]));
        assert_eq!(throttle.plan(&targets, at(123_000)), Err("LimitExceeded"));
        assert_eq!(throttle.plan(&[], at(123_000)), Ok(vec![]));
        assert_eq!(throttle.plan(&targets, at(182_000)), Ok(vec!["claude".to_owned(), "codex".to_owned(), "kimi".to_owned()]));
    }

    #[test]
    fn refresh_targets_are_the_named_harness_or_the_cached_ones() {
        assert_eq!(refresh_targets(&json!({"harness": "claude"}), |_| false), Ok(vec!["claude".to_owned()]));
        assert_eq!(refresh_targets(&Value::Null, |id| id == "codex" || id == "kimi"), Ok(vec!["codex".to_owned(), "kimi".to_owned()]));
        assert_eq!(refresh_targets(&json!({}), |_| false), Ok(vec![]));
        assert_eq!(refresh_targets(&json!({"harness": "nope"}), |_| true), Err("NotFound"));
        for bad in [json!({"harness": 3}), json!({"harness": ""}), json!({"harness": "claude", "force": true}), json!("claude")] { assert_eq!(refresh_targets(&bad, |_| true), Err("InvalidArguments"), "{bad}"); }
    }

    /// The fixture service under the pinned runtime reads the four resources and asks for a refresh through the same
    /// dispatch the app uses (a test-owned store, grants file, facts and throttle clock).
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    mod installed {
        use super::*;
        use crate::extensions::{packages::ExtensionPackages, runtime_service_lifetime::{Dispatch, ServiceLifetime}};
        use std::{future::Future, pin::Pin, sync::{Arc, Mutex}, time::Instant};
        fn archive(manifest: &str, source: &str) -> Vec<u8> {
            use std::io::Write;
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            for (name, bytes) in [("extension.json", manifest.as_bytes()), ("main.cjs", source.as_bytes())] {
                writer.start_file(name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap().into_inner()
        }
        fn digest(packages: &crate::extensions::packages::Packages) -> String { serde_json::to_value(packages.snapshot()).unwrap()["packages"][0]["executable"]["digest"].as_str().unwrap().to_owned() }

        const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-usage-resources/extension.json");
        const SOURCE: &str = include_str!("../../../tests/fixtures/extensions/runtime-usage-resources/main.cjs");
        const CONTROL: &str = "sample.usage-resources/control";
        fn runtime_dir() -> std::path::PathBuf { std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime") }
        async fn control(manager: &ServiceLifetime, args: Value) -> Value { manager.call_command(A, CONTROL, args, None).await.unwrap() }

        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn the_service_reads_usage_limits_accounts_and_metrics_and_refreshes_at_the_throttle() {
            let dir = Dir::new();
            let packages = ExtensionPackages::new(&dir.0, false);
            let grants = Arc::new(RuntimeGrants::open(&dir.0));
            { let packages = packages.0.lock().unwrap(); packages.install(&archive(MANIFEST, SOURCE)).unwrap(); let digest = digest(&packages); packages.trust(A, &digest, true).unwrap(); packages.enable(A, true).unwrap(); }
            let store = Arc::new(Mutex::new(store()));
            { let store = store.lock().unwrap(); say(&store, "a1", "user"); record(&store, "a1", &usage(100, Some(1000))).unwrap(); record(&store, "a1", &usage(300, Some(1000))).unwrap(); say(&store, "b1", "user"); record(&store, "b1", &usage(7, None)).unwrap(); }
            let clock = Arc::new(Mutex::new(Duration::from_secs(1)));
            let throttle = Arc::new(Throttle::default());
            let refreshed = Arc::new(Mutex::new(Vec::<String>::new()));
            let dispatch: Dispatch = { let (grants, store, clock, throttle, refreshed) = (grants.clone(), store.clone(), clock.clone(), throttle.clone(), refreshed.clone()); Arc::new(move |request: DispatchRequest| {
                let (grants, store, clock, throttle, refreshed) = (grants.clone(), store.clone(), clock.clone(), throttle.clone(), refreshed.clone());
                Box::pin(async move {
                    let result = match request.method.as_str() {
                        "usageQuery" => query(&grants, &store.lock().unwrap(), &Fixed, &request.owner, "1.0.0", &request.params),
                        "limitsRefresh" => (|| {
                            grants.check(&request.owner, "1.0.0", LIMITS, &Target::default()).map_err(|_| "PermissionDenied")?;
                            let targets = refresh_targets(&request.params, |_| false)?;
                            let admitted = throttle.plan(&targets, *clock.lock().unwrap())?;
                            refreshed.lock().unwrap().extend(admitted);
                            Ok(Value::Null)
                        })(),
                        _ => Err("UnsupportedCapability"),
                    };
                    reply(result)
                }) as Pin<Box<dyn Future<Output = Value> + Send>>
            }) };
            let manager = ServiceLifetime::new(vec![runtime_dir()]);
            manager.set_dispatch(dispatch);
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            grants.grant(A, "runtime.service", Scope::default()).unwrap();
            grants.grant(A, "tasks.usage.read", projects(&["A"])).unwrap();
            grants.grant(A, "harnesses.limits.read", Scope::default()).unwrap();
            grants.grant(A, "harnesses.accounts.read", Scope::default()).unwrap();
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            let deadline = Instant::now() + Duration::from_secs(20);
            while !manager.serves(A, CONTROL) { assert!(Instant::now() < deadline, "the service never became ready"); tokio::time::sleep(Duration::from_millis(25)).await; }

            let ask = |query: Value| { let manager = &manager; async move { control(manager, json!({"op": "query", "query": query})).await } };
            // Usage of the granted project: the last report of the turn; the other project and the ungranted metrics are refused.
            let usage_page = ask(json!({"resource": "usage", "taskId": "a1"})).await;
            assert_eq!(usage_page["ok"], true, "{usage_page}");
            assert_eq!((usage_page["value"]["items"][0]["usedTokens"].as_i64(), usage_page["value"]["items"][0]["reports"].as_i64()), (Some(300), Some(2)));
            assert_eq!(ask(json!({"resource": "usage", "taskId": "b1"})).await, json!({"ok": false, "code": "PermissionDenied"}));
            assert_eq!(ask(json!({"resource": "metrics"})).await, json!({"ok": false, "code": "PermissionDenied"}));
            assert_eq!(ask(json!({"resource": "limits"})).await["value"]["items"][0]["windows"][0]["id"], "5-hour-window");
            let accounts = ask(json!({"resource": "accounts"})).await;
            assert_eq!(accounts["value"]["items"][0]["label"], "person@example.test");
            // refreshLimits: the first call is admitted, a second inside 60 s is `LimitExceeded`, at 60 s it is admitted again.
            let refresh = |harness: &str| { let manager = &manager; let harness = harness.to_owned(); async move { control(manager, json!({"op": "refresh", "harness": harness})).await } };
            assert_eq!(refresh("claude").await, json!({"ok": true, "value": null}));
            *clock.lock().unwrap() = Duration::from_millis(60_999);
            assert_eq!(refresh("claude").await, json!({"ok": false, "code": "LimitExceeded"}));
            *clock.lock().unwrap() = Duration::from_millis(61_000);
            assert_eq!(refresh("claude").await, json!({"ok": true, "value": null}));
            assert_eq!(*refreshed.lock().unwrap(), ["claude", "claude"]);
            // Revocation is refused natively on the very next call.
            grants.revoke(A, "harnesses.limits.read").unwrap();
            assert_eq!(refresh("codex").await, json!({"ok": false, "code": "PermissionDenied"}));
            assert_eq!(ask(json!({"resource": "limits"})).await, json!({"ok": false, "code": "PermissionDenied"}));
            manager.stop_all(crate::extensions::runtime_service_lifetime::StopReason::Quit);
            assert!(manager.wait_idle(Duration::from_secs(5)).await);
        }
    }
}
