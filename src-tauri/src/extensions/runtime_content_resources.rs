//! Package settings and content resources for background services (runtime phase R2, slice R0203).
//!
//! Two requests a service makes to the host, both answered natively from the grants file and never from a
//! webview consent:
//! - `settingsGet`: `panda.settings.get({ page })` answers the values and revision of one of the package's OWN
//!   settings pages. It needs only the `ui.contribute` that declares the page; another package's page, an unknown
//!   page and a disabled package are `NotFound`.
//! - `contentQuery`: `panda.context.query` for `tasks` (the extended summary row), `transcript`, `tools` and
//!   `changes`. Each resource names its exact read permission, checked for the project of the task it reads on every
//!   call, and revocation or narrowing that happens while the read runs wins over the result.
//!
//! Limits are for stability and predictability, never for trust: a page is at most 50 items and 256 KiB, one text
//! field is cut at 64 KiB and says so, and a page continued after the data changed is `StaleContext`. What the store
//! holds for a tool call is the display preview, so `inputComplete` and `outputComplete` are always `false`.
//! `src/extensions/runtime-content-resources.ts` mirrors the rules for the browser preview.
use crate::extensions::{runtime_grants::{RuntimeGrants, Target}, runtime_service_lifetime::DispatchRequest};
use crate::storage::Store;
use serde_json::{json, Map, Value};

/// Items in one page.
pub const PAGE_ITEMS: u32 = 50;
/// Serialized bytes of one page.
pub const PAGE_BYTES: usize = 256 * 1024;
/// Bytes of one text field before it is cut.
pub const TEXT_BYTES: usize = 64 * 1024;
const MAX_CURSOR: u32 = 1_000_000;
/// The resources this module answers and the permission each one needs.
pub const RESOURCES: [(&str, &str); 4] = [
    ("tasks", "tasks.summary"), ("transcript", "tasks.transcript.read"), ("tools", "tasks.tools.read"), ("changes", "tasks.tools.read"),
];

type Reply = Result<Value, &'static str>;

/// The revision of a settings page: FNV-1a 64 of the compact JSON of its values (keys sorted), kept to 53 bits so it is an exact
/// JavaScript number. It changes exactly when the values do and is the same after a restart.
pub fn settings_revision(values: &Value) -> u64 {
    fn canonical(value: &Value, out: &mut String) {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect(); keys.sort();
                out.push('{');
                for (index, key) in keys.into_iter().enumerate() { if index > 0 { out.push(','); } out.push_str(&Value::String(key.clone()).to_string()); out.push(':'); canonical(&map[key], out); }
                out.push('}');
            }
            Value::Array(items) => { out.push('['); for (index, item) in items.iter().enumerate() { if index > 0 { out.push(','); } canonical(item, out); } out.push(']'); }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut text = String::new(); canonical(values, &mut text);
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.bytes() { hash ^= u64::from(byte); hash = hash.wrapping_mul(0x100000001b3); }
    hash & ((1u64 << 53) - 1)
}

/// The reply of `panda.settings.get`: `{ schemaVersion: 1, revision, values }`.
pub fn settings_reply(values: Value) -> Value { json!({"schemaVersion": 1, "revision": settings_revision(&values), "values": values}) }

/// Reports that a page of `owner` changed; the service reads it again. Never fails the save that caused it.
pub fn settings_changed(app: &tauri::AppHandle, owner: &str, page: &str, values: &Value) {
    super::runtime_workspace_events::publish_app(
        app, &json!({"kind": "settings.changed", "page": page, "revision": settings_revision(values)}), Some(owner),
    );
}

/// Serves the two requests. Anything else is not this module's.
pub fn serve(app: &tauri::AppHandle, request: DispatchRequest) -> Value {
    use tauri::Manager;
    let result = (|| -> Reply {
        let packages = app.state::<crate::extensions::packages::ExtensionPackages>();
        let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
        match request.method.as_str() {
            "settingsGet" => {
                let page = settings_page(&request.params)?;
                packages.settings_values(&request.owner, &page).map(settings_reply).map_err(|_| "NotFound")
            }
            "contentQuery" => {
                let version = enabled_version(&packages, &request.owner).ok_or("PermissionDenied")?;
                let grants = app.state::<RuntimeGrants>();
                let state = app.state::<crate::AppState>();
                let store = state.store.try_lock().map_err(|_| "Timeout")?;
                query(&grants, &store, &request.owner, &version, &request.params)
            }
            _ => Err("UnsupportedCapability"),
        }
    })();
    match result { Ok(value) => json!({"ok": true, "value": value}), Err(code) => crate::extensions::context::failure(code) }
}

/// The installed version of `owner` while it is enabled and safe mode is off.
fn enabled_version(packages: &crate::extensions::packages::Packages, owner: &str) -> Option<String> {
    let snapshot = packages.snapshot();
    if snapshot.safe_mode { return None; }
    snapshot.packages.iter().find(|package| package.enabled && package.manifest["id"] == owner).and_then(|package| package.manifest["version"].as_str().map(str::to_owned))
}

fn settings_page(params: &Value) -> Result<String, &'static str> {
    let object = params.as_object().ok_or("InvalidArguments")?;
    if object.len() != 1 { return Err("InvalidArguments"); }
    match object.get("page").and_then(Value::as_str) { Some(page) if !page.is_empty() && page.len() <= 256 => Ok(page.to_owned()), _ => Err("InvalidArguments") }
}

fn revision(store: &Store) -> Result<String, &'static str> {
    let external: i64 = store.db.query_row("PRAGMA data_version", [], |row| row.get(0)).map_err(|_| "HostUnavailable")?;
    Ok(format!("{external}:{}", store.db.total_changes()))
}

/// `text` cut at `TEXT_BYTES` on a character boundary, and whether it was cut.
pub fn cut(text: String) -> (String, bool) {
    if text.len() <= TEXT_BYTES { return (text, false); }
    let mut end = TEXT_BYTES;
    while !text.is_char_boundary(end) { end -= 1; }
    (text[..end].to_owned(), true)
}

/// A column read as text, bounded in the query (4 bytes per character at most) so a huge row is never loaded whole.
const WINDOW: i64 = TEXT_BYTES as i64 + 1;

/// Tool kind derived from the stored name (the store keeps the provider's name only).
pub fn tool_kind(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.contains("__") { "mcp" }
    else if ["bash", "shell", "command", "powershell", "terminal", "exec"].iter().any(|word| lower == *word || lower.starts_with(&format!("{word}_"))) { "shell" }
    else if ["edit", "write", "patch", "notebook"].iter().any(|word| lower.contains(word)) { "edit" }
    else if ["read", "view", "open"].iter().any(|word| lower.contains(word)) { "read" }
    else if ["grep", "glob", "search", "find", "list"].iter().any(|word| lower.contains(word)) { "search" }
    else if ["web", "fetch", "browse", "http"].iter().any(|word| lower.contains(word)) { "web" }
    else { "other" }
}

/// One `panda.context.query` for `tasks`, `transcript`, `tools` or `changes`, for the package `owner` at `version`.
pub fn query(grants: &RuntimeGrants, store: &Store, owner: &str, version: &str, params: &Value) -> Reply {
    let object = params.as_object().ok_or("InvalidShape")?;
    const KEYS: [&str; 6] = ["resource", "taskId", "harness", "limit", "cursor", "revision"];
    if object.keys().any(|key| !KEYS.contains(&key.as_str())) { return Err("InvalidShape"); }
    let resource = object.get("resource").and_then(Value::as_str).ok_or("InvalidShape")?;
    let permission = RESOURCES.iter().find(|(name, _)| *name == resource).map(|(_, permission)| *permission).ok_or("UnsupportedCapability")?;
    let limit = match object.get("limit") { None => 10, Some(value) => value.as_u64().filter(|limit| (1..=u64::from(PAGE_ITEMS)).contains(limit)).ok_or("LimitExceeded")? as u32 };
    let cursor = match object.get("cursor") { None | Some(Value::Null) => 0, Some(value) => value.as_u64().filter(|cursor| *cursor <= u64::from(MAX_CURSOR)).ok_or("LimitExceeded")? as u32 };
    let expected = match object.get("revision") { None | Some(Value::Null) => None, Some(value) => Some(value.as_str().filter(|text| text.len() <= 64).ok_or("LimitExceeded")?) };
    if object.get("harness").is_some_and(|value| !value.is_null()) { return Err("InvalidShape"); }
    // Holding the permission at all comes first, so a package without it learns nothing about the data.
    if !holds(grants, owner, version, permission) { return Err("PermissionDenied"); }
    let current = revision(store)?;
    if resource == "tasks" {
        if object.get("taskId").is_some_and(|value| !value.is_null()) { return Err("InvalidShape"); }
        let page = tasks(grants, store, owner, version, (limit, cursor))?;
        return finish(store, &current, expected, cursor, page);
    }
    let task_id = object.get("taskId").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 256).ok_or("InvalidShape")?;
    let project: String = store.db.query_row("SELECT project_id FROM sessions WHERE id=?1 AND draft=0", [task_id], |row| row.get(0))
        .map_err(|error| if matches!(error, rusqlite::Error::QueryReturnedNoRows) { "NotFound" } else { "HostUnavailable" })?;
    let work = grants.begin(owner, version, permission, &Target::project(&project)).map_err(|_| "PermissionDenied")?;
    let page = match resource {
        "transcript" => transcript(store, task_id, (limit, cursor))?,
        "tools" => tools(store, task_id, (limit, cursor))?,
        _ => changes(store, task_id, (limit, cursor))?,
    };
    // Revocation or narrowing during the read wins over its result.
    if work.is_cancelled() || grants.check(owner, version, permission, &Target::project(&project)).is_err() { return Err("PermissionDenied"); }
    finish(store, &current, expected, cursor, page)
}

/// `true` when the package holds `permission` for any project (the scope is checked per project afterwards).
fn holds(grants: &RuntimeGrants, owner: &str, version: &str, permission: &str) -> bool {
    grants.projection()["packages"].as_array().into_iter().flatten().any(|package| {
        package["id"] == owner && package["version"] == version && package["authorized"] == true
            && package["grants"].as_array().into_iter().flatten().any(|grant| grant["permission"] == permission)
    })
}

/// Rows read for one page: at most `limit` items and whether more follow.
struct Rows { items: Vec<Value>, more: bool }

fn finish(store: &Store, current: &str, expected: Option<&str>, cursor: u32, mut rows: Rows) -> Reply {
    if expected.is_some_and(|expected| expected != current) { return Err("StaleContext"); }
    // An external writer may change the database despite the Store lock; never mix revisions.
    if revision(store)? != current { return Err("StaleContext"); }
    while rows.items.len() > 1 && json!(rows.items).to_string().len() > PAGE_BYTES { rows.items.pop(); rows.more = true; }
    let next = rows.more.then(|| cursor + rows.items.len() as u32);
    Ok(json!({"schemaVersion": 1, "state": "Ready", "revision": current, "items": rows.items, "nextCursor": next}))
}

fn window(text: Option<String>, whole: i64) -> (String, bool) {
    let text = text.unwrap_or_default();
    let (cut_text, cut_bytes) = cut(text);
    (cut_text, cut_bytes || whole > WINDOW - 1)
}

fn tasks(grants: &RuntimeGrants, store: &Store, owner: &str, version: &str, (limit, cursor): (u32, u32)) -> Result<Rows, &'static str> {
    let mut statement = store.db.prepare("SELECT id FROM projects ORDER BY id").map_err(|_| "HostUnavailable")?;
    let projects: Vec<String> = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|_| "HostUnavailable")?
        .filter_map(Result::ok).filter(|project| grants.check(owner, version, "tasks.summary", &Target::project(project)).is_ok()).collect();
    if projects.is_empty() { return Ok(Rows { items: vec![], more: false }); }
    let marks = vec!["?"; projects.len()].join(",");
    let sql = format!("SELECT id, project_id, status, substr(title,1,{WINDOW}), length(title), provider, model, mode, task_stage FROM sessions WHERE draft=0 AND project_id IN ({marks}) ORDER BY id LIMIT ? OFFSET ?");
    let mut statement = store.db.prepare(&sql).map_err(|_| "HostUnavailable")?;
    let mut values: Vec<rusqlite::types::Value> = projects.into_iter().map(rusqlite::types::Value::Text).collect();
    values.push(i64::from(limit + 1).into()); values.push(i64::from(cursor).into());
    let rows = statement.query_map(rusqlite::params_from_iter(values), |row| Ok((
        row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, i64>(4)?,
        row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?,
    ))).map_err(|_| "HostUnavailable")?;
    let mut items = Vec::new(); let mut more = false;
    for row in rows {
        let (id, project, status, title, title_length, provider, model, mode, stage) = row.map_err(|_| "HostUnavailable")?;
        if items.len() == limit as usize { more = true; break; }
        let (title, cut_title) = window(title, title_length);
        let mut item = json!({"id": id, "projectId": project, "status": status, "title": title, "harness": provider, "model": model, "mode": mode, "stage": stage, "startedBy": "user"});
        if cut_title { item["truncated"] = json!(true); }
        items.push(item);
    }
    Ok(Rows { items, more })
}

fn role(stored: &str) -> &'static str {
    match stored { "user" => "user", "assistant" => "assistant", "system" => "system", _ => "note" }
}

fn transcript(store: &Store, task: &str, (limit, cursor): (u32, u32)) -> Result<Rows, &'static str> {
    let sql = format!("SELECT m.id, m.role, substr(m.content,1,{WINDOW}), length(m.content), m.created_at,
        (SELECT COUNT(*) FROM messages u WHERE u.session_id=m.session_id AND u.role='user' AND u.id<=m.id)
        FROM messages m WHERE m.session_id=?1 AND m.role NOT IN ('tool','changes') ORDER BY m.id LIMIT ?2 OFFSET ?3");
    let mut statement = store.db.prepare(&sql).map_err(|_| "HostUnavailable")?;
    let rows = statement.query_map(rusqlite::params![task, i64::from(limit) + 1, i64::from(cursor)], |row| Ok((
        row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, i64>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?,
    ))).map_err(|_| "HostUnavailable")?;
    let mut attachments = store.db.prepare("SELECT id, kind, name, bytes FROM message_attachments WHERE message_id=?1 AND session_id=?2 ORDER BY id LIMIT 64").map_err(|_| "HostUnavailable")?;
    let mut items = Vec::new(); let mut more = false;
    for row in rows {
        let (id, stored, text, length, at, turn) = row.map_err(|_| "HostUnavailable")?;
        if items.len() == limit as usize { more = true; break; }
        let (text, truncated) = window(text, length);
        let mut item = json!({"id": id.to_string(), "turn": turn, "role": role(&stored), "text": text, "at": at});
        if truncated { item["truncated"] = json!(true); }
        let files: Vec<Value> = attachments.query_map(rusqlite::params![id, task], |row| Ok(json!({"id": row.get::<_, String>(0)?, "kind": row.get::<_, String>(1)?, "name": row.get::<_, String>(2)?, "bytes": row.get::<_, i64>(3)?})))
            .map_err(|_| "HostUnavailable")?.filter_map(Result::ok).collect();
        if !files.is_empty() { item["attachments"] = json!(files); }
        items.push(item);
    }
    Ok(Rows { items, more })
}

fn tool_text(value: Option<&Value>) -> (String, bool) {
    match value { None | Some(Value::Null) => (String::new(), false), Some(Value::String(text)) => cut(text.clone()), Some(other) => cut(other.to_string()) }
}

fn tools(store: &Store, task: &str, (limit, cursor): (u32, u32)) -> Result<Rows, &'static str> {
    let sql = "SELECT m.id, m.tool_id, m.content, (SELECT COUNT(*) FROM messages u WHERE u.session_id=m.session_id AND u.role='user' AND u.id<=m.id)
        FROM messages m WHERE m.session_id=?1 AND m.role='tool' ORDER BY m.id LIMIT ?2 OFFSET ?3";
    let mut statement = store.db.prepare(sql).map_err(|_| "HostUnavailable")?;
    let rows = statement.query_map(rusqlite::params![task, i64::from(limit) + 1, i64::from(cursor)], |row| Ok((
        row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?,
    ))).map_err(|_| "HostUnavailable")?;
    let mut items = Vec::new(); let mut more = false;
    for row in rows {
        let (id, tool_id, content, turn) = row.map_err(|_| "HostUnavailable")?;
        if items.len() == limit as usize { more = true; break; }
        let stored: Value = serde_json::from_str(&content).unwrap_or(Value::Null);
        let name = stored["name"].as_str().unwrap_or("unknown").to_owned();
        let (input, cut_input) = tool_text(stored.get("input"));
        let (output, cut_output) = if stored.is_null() { cut(content) } else { tool_text(stored.get("output")) };
        let mut item = Map::new();
        item.insert("callId".into(), json!(stored["id"].as_str().map(str::to_owned).or(tool_id).unwrap_or_else(|| id.to_string())));
        item.insert("turn".into(), json!(turn));
        item.insert("tool".into(), json!({"kind": tool_kind(&name), "name": name}));
        item.insert("status".into(), json!(stored["status"].as_str().unwrap_or("unknown")));
        item.insert("input".into(), json!(input)); item.insert("output".into(), json!(output));
        // The store keeps the display preview, never the complete input or output.
        item.insert("inputComplete".into(), json!(false)); item.insert("outputComplete".into(), json!(false));
        if let Some(paths) = stored["writePaths"].as_array() { item.insert("writePaths".into(), Value::Array(paths.iter().filter(|path| path.is_string()).take(256).cloned().collect())); }
        if cut_input || cut_output { item.insert("truncated".into(), json!(true)); }
        items.push(Value::Object(item));
    }
    Ok(Rows { items, more })
}

fn changes(store: &Store, task: &str, (limit, cursor): (u32, u32)) -> Result<Rows, &'static str> {
    let sql = format!("SELECT f.path, substr(COALESCE(json_extract(f.detail,'$.patch'),''),1,{WINDOW}), length(COALESCE(json_extract(f.detail,'$.patch'),'')),
        (SELECT COUNT(*) FROM messages u WHERE u.session_id=c.session_id AND u.role='user' AND u.id<=c.message_id)
        FROM turn_changes c JOIN turn_change_files f ON f.change_id=c.id WHERE c.session_id=?1 ORDER BY c.message_id, f.path LIMIT ?2 OFFSET ?3");
    let mut statement = store.db.prepare(&sql).map_err(|_| "HostUnavailable")?;
    let rows = statement.query_map(rusqlite::params![task, i64::from(limit) + 1, i64::from(cursor)], |row| Ok((
        row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?,
    ))).map_err(|_| "HostUnavailable")?;
    let mut items = Vec::new(); let mut more = false;
    for row in rows {
        let (path, patch, length, turn) = row.map_err(|_| "HostUnavailable")?;
        if items.len() == limit as usize { more = true; break; }
        let (patch, truncated) = window(patch, length);
        let mut item = json!({"turn": turn, "path": path, "patch": patch});
        if truncated { item["truncated"] = json!(true); }
        items.push(item);
    }
    Ok(Rows { items, more })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::runtime_grants::Scope;

    struct Dir(std::path::PathBuf);
    impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-content-test-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    const A: &str = "sample.content-resources";
    const B: &str = "sample.other";
    const PERMISSIONS: [&str; 3] = ["tasks.summary", "tasks.transcript.read", "tasks.tools.read"];

    fn projects(names: &[&str]) -> Scope { Scope { projects: Some(names.iter().map(|name| (*name).to_owned()).collect()), ..Scope::default() } }
    fn grants(dir: &Dir) -> RuntimeGrants {
        let grants = RuntimeGrants::open(&dir.0);
        for id in [A, B] {
            let declared: Vec<&str> = PERMISSIONS.to_vec();
            grants.register_package(id, "1.0.0", &declared, Some("digest")).unwrap(); grants.trust(id, true).unwrap();
        }
        grants
    }
    fn store() -> Store {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        store.db.execute("INSERT INTO projects(id,name,path) VALUES ('A','Alpha','/a'),('B','Beta','/b')", []).unwrap();
        for (id, project, title) in [("a1", "A", "First"), ("a2", "A", "Second"), ("b1", "B", "Foreign")] {
            store.db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at) VALUES (?1,?2,?3,'claude','opus','ask','pending',1,1)", [id, project, title]).unwrap();
        }
        store
    }
    fn say(store: &Store, task: &str, role: &str, content: &str) -> i64 { store.insert_message(task, role, content).unwrap() }
    fn ask(grants: &RuntimeGrants, store: &Store, owner: &str, params: Value) -> Reply { query(grants, store, owner, "1.0.0", &params) }

    #[test]
    fn settings_revision_is_pinned_and_changes_with_the_values() {
        assert_eq!(settings_revision(&json!({"label": "Local report", "enabled": true})), settings_revision(&json!({"label": "Local report", "enabled": true})));
        assert_ne!(settings_revision(&json!({"label": "a"})), settings_revision(&json!({"label": "b"})));
        // The same numbers as `settingsRevision` in the preview model (tests/extensions-runtime-content-resources.spec.ts).
        assert_eq!(settings_revision(&json!({})), 5_711_996_017_187_365);
        assert_eq!(settings_revision(&json!({"label": "Local report", "enabled": true})), 2_677_978_762_292_769);
        assert!(settings_revision(&json!({"label": "x"})) < (1 << 53));
        let reply = settings_reply(json!({"label": "x"}));
        assert_eq!(reply["schemaVersion"], 1); assert_eq!(reply["values"], json!({"label": "x"})); assert_eq!(reply["revision"], settings_revision(&json!({"label": "x"})));
    }

    #[test]
    fn a_resource_needs_its_exact_read_grant_for_the_project_of_the_task() {
        let dir = Dir::new(); let grants = grants(&dir); let store = store();
        let user = say(&store, "a1", "user", "hello"); say(&store, "a1", "assistant", "hi there");
        let _ = user;
        let transcript = json!({"resource": "transcript", "taskId": "a1"});
        // Nothing granted: refused before any lookup, and the answer is the same for a task that does not exist.
        for task in ["a1", "ghost"] { assert_eq!(ask(&grants, &store, A, json!({"resource": "transcript", "taskId": task})), Err("PermissionDenied")); }
        // The summary grant does not reach the transcript, and the tools grant does not either.
        grants.grant(A, "tasks.summary", Scope::default()).unwrap(); grants.grant(A, "tasks.tools.read", Scope::default()).unwrap();
        assert_eq!(ask(&grants, &store, A, transcript.clone()), Err("PermissionDenied"));
        grants.grant(A, "tasks.transcript.read", projects(&["A"])).unwrap();
        let page = ask(&grants, &store, A, transcript.clone()).unwrap();
        assert_eq!(page["state"], "Ready"); assert_eq!(page["schemaVersion"], 1);
        let items = page["items"].as_array().unwrap();
        assert_eq!((items[0]["role"].as_str(), items[0]["text"].as_str(), items[0]["turn"].as_i64()), (Some("user"), Some("hello"), Some(1)));
        assert_eq!((items[1]["role"].as_str(), items[1]["turn"].as_i64()), (Some("assistant"), Some(1)));
        // A task of a project outside the grant, a task that does not exist, a package that holds nothing.
        assert_eq!(ask(&grants, &store, A, json!({"resource": "transcript", "taskId": "b1"})), Err("PermissionDenied"));
        assert_eq!(ask(&grants, &store, A, json!({"resource": "transcript", "taskId": "ghost"})), Err("NotFound"));
        assert_eq!(ask(&grants, &store, B, transcript.clone()), Err("PermissionDenied"));
        // A stale version and revocation are refused natively, every call.
        assert_eq!(query(&grants, &store, A, "0.9.0", &transcript), Err("PermissionDenied"));
        grants.revoke(A, "tasks.transcript.read").unwrap();
        assert_eq!(ask(&grants, &store, A, transcript), Err("PermissionDenied"));
    }

    #[test]
    fn a_selector_a_resource_and_a_page_are_validated_before_anything_is_read() {
        let dir = Dir::new(); let grants = grants(&dir); let store = store();
        for permission in PERMISSIONS { grants.grant(A, permission, Scope::default()).unwrap(); }
        for (params, code) in [
            (json!({"resource": "transcript"}), "InvalidShape"),
            (json!({"resource": "transcript", "taskId": "a1", "harness": "claude"}), "InvalidShape"),
            (json!({"resource": "tasks", "taskId": "a1"}), "InvalidShape"),
            (json!({"resource": "transcript", "taskId": "a1", "extra": 1}), "InvalidShape"),
            (json!({"resource": "usage", "taskId": "a1"}), "UnsupportedCapability"),
            (json!({"resource": "projects"}), "UnsupportedCapability"),
            (json!({"resource": "transcript", "taskId": "a1", "limit": 51}), "LimitExceeded"),
            (json!({"resource": "transcript", "taskId": "a1", "limit": 0}), "LimitExceeded"),
            (json!({"resource": "transcript", "taskId": "a1", "revision": "x".repeat(65)}), "LimitExceeded"),
        ] { assert_eq!(ask(&grants, &store, A, params.clone()), Err(code), "{params}"); }
    }

    #[test]
    fn tasks_carry_the_extended_row_only_for_projects_the_grant_reaches() {
        let dir = Dir::new(); let grants = grants(&dir); let store = store();
        assert_eq!(ask(&grants, &store, A, json!({"resource": "tasks"})), Err("PermissionDenied"));
        grants.grant(A, "tasks.summary", projects(&["A"])).unwrap();
        let page = ask(&grants, &store, A, json!({"resource": "tasks", "limit": 1})).unwrap();
        assert_eq!(page["items"], json!([{"id": "a1", "projectId": "A", "status": "pending", "title": "First", "harness": "claude", "model": "opus", "mode": "ask", "stage": "pending", "startedBy": "user"}]));
        assert_eq!(page["nextCursor"], 1);
        let second = ask(&grants, &store, A, json!({"resource": "tasks", "limit": 5, "cursor": 1, "revision": page["revision"]})).unwrap();
        assert_eq!(second["items"].as_array().unwrap().iter().map(|item| item["id"].as_str().unwrap()).collect::<Vec<_>>(), ["a2"]);
        assert_eq!(second["nextCursor"], Value::Null);
        // The foreign project's task never appears, and the page text carries no other project's data.
        assert!(!page.to_string().contains("Foreign") && !second.to_string().contains("b1"));
        grants.grant(A, "tasks.summary", projects(&["B"])).unwrap();
        assert_eq!(ask(&grants, &store, A, json!({"resource": "tasks"})).unwrap()["items"][0]["id"], "b1");
        // A change after the first page makes the continuation stale.
        store.db.execute("UPDATE sessions SET status='completed' WHERE id='b1'", []).unwrap();
        assert_eq!(ask(&grants, &store, A, json!({"resource": "tasks", "cursor": 1, "revision": page["revision"]})), Err("StaleContext"));
    }

    #[test]
    fn stored_tool_calls_are_incomplete_previews_and_changes_are_patches_per_turn() {
        let dir = Dir::new(); let grants = grants(&dir); let store = store();
        say(&store, "a1", "user", "run it");
        store.tool_message("a1", "call-1", &json!({"type": "tool_activity", "version": 1, "id": "call-1", "name": "Bash", "status": "completed", "input": "npm test", "output": "PASS", "writePaths": []}).to_string()).unwrap();
        store.tool_message("a1", "call-2", &json!({"type": "tool_activity", "version": 1, "id": "call-2", "name": "Edit", "status": "running", "input": "{\"file\":\"a.rs\"}", "output": "", "writePaths": ["a.rs"]}).to_string()).unwrap();
        say(&store, "a1", "user", "again");
        let marker = say(&store, "a1", "changes", "");
        store.db.execute("INSERT INTO turn_changes(id,session_id,message_id,summary,created_at) VALUES ('c1','a1',?1,'{}',1)", [marker]).unwrap();
        store.db.execute("INSERT INTO turn_change_files(change_id,path,detail) VALUES ('c1','a.rs',?1)", [json!({"patch": "@@ -1 +1 @@\n-a\n+b"}).to_string()]).unwrap();
        // Tools and changes share one permission; the transcript permission alone reaches neither.
        grants.grant(A, "tasks.transcript.read", Scope::default()).unwrap();
        for resource in ["tools", "changes"] { assert_eq!(ask(&grants, &store, A, json!({"resource": resource, "taskId": "a1"})), Err("PermissionDenied")); }
        grants.grant(A, "tasks.tools.read", Scope::default()).unwrap();
        let tools = ask(&grants, &store, A, json!({"resource": "tools", "taskId": "a1"})).unwrap();
        let items = tools["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], json!({"callId": "call-1", "turn": 1, "tool": {"kind": "shell", "name": "Bash"}, "status": "completed", "input": "npm test", "output": "PASS", "inputComplete": false, "outputComplete": false, "writePaths": []}));
        assert_eq!(items[1]["tool"], json!({"kind": "edit", "name": "Edit"})); assert_eq!(items[1]["writePaths"], json!(["a.rs"]));
        assert!(items.iter().all(|item| item["inputComplete"] == false && item["outputComplete"] == false));
        let changes = ask(&grants, &store, A, json!({"resource": "changes", "taskId": "a1"})).unwrap();
        assert_eq!(changes["items"], json!([{"turn": 2, "path": "a.rs", "patch": "@@ -1 +1 @@\n-a\n+b"}]));
        // The transcript holds the conversation, not the tool rows or the change marker.
        let transcript = ask(&grants, &store, A, json!({"resource": "transcript", "taskId": "a1"})).unwrap();
        assert_eq!(transcript["items"].as_array().unwrap().iter().map(|item| item["text"].as_str().unwrap()).collect::<Vec<_>>(), ["run it", "again"]);
    }

    #[test]
    fn pages_are_fifty_items_and_256_kib_and_text_is_cut_at_64_kib() {
        let dir = Dir::new(); let grants = grants(&dir); let store = store();
        grants.grant(A, "tasks.transcript.read", Scope::default()).unwrap();
        for index in 0..60 { say(&store, "a1", "user", &format!("m{index}")); }
        let first = ask(&grants, &store, A, json!({"resource": "transcript", "taskId": "a1", "limit": 50})).unwrap();
        assert_eq!((first["items"].as_array().unwrap().len(), first["nextCursor"].as_u64()), (50, Some(50)));
        let last = ask(&grants, &store, A, json!({"resource": "transcript", "taskId": "a1", "limit": 50, "cursor": 50, "revision": first["revision"]})).unwrap();
        assert_eq!((last["items"].as_array().unwrap().len(), last["nextCursor"].clone()), (10, Value::Null));
        // One text field is cut at 64 KiB on a character boundary and says so.
        store.db.execute("DELETE FROM messages", []).unwrap();
        say(&store, "a1", "assistant", &"é".repeat(40_000));
        let one = ask(&grants, &store, A, json!({"resource": "transcript", "taskId": "a1"})).unwrap();
        let text = one["items"][0]["text"].as_str().unwrap();
        assert_eq!((text.len(), one["items"][0]["truncated"].clone()), (65_536, json!(true)));
        // A full page of cut texts is trimmed to 256 KiB: the continuation starts where the page stopped.
        store.db.execute("DELETE FROM messages", []).unwrap();
        for _ in 0..8 { say(&store, "a1", "assistant", &"x".repeat(100_000)); }
        let big = ask(&grants, &store, A, json!({"resource": "transcript", "taskId": "a1", "limit": 50})).unwrap();
        let count = big["items"].as_array().unwrap().len();
        assert!((3..8).contains(&count), "{count}");
        assert!(big.to_string().len() <= PAGE_BYTES + 1024);
        assert_eq!(big["nextCursor"], count as u64);
        // The text cut helper: exact limit passes, one over is cut.
        assert!(!cut("a".repeat(TEXT_BYTES)).1); assert_eq!(cut("a".repeat(TEXT_BYTES + 1)).0.len(), TEXT_BYTES);
    }

    #[test]
    fn a_changed_source_makes_a_continued_page_stale() {
        let dir = Dir::new(); let grants = grants(&dir); let store = store();
        grants.grant(A, "tasks.transcript.read", Scope::default()).unwrap();
        say(&store, "a1", "user", "one"); say(&store, "a1", "assistant", "two");
        let first = ask(&grants, &store, A, json!({"resource": "transcript", "taskId": "a1", "limit": 1})).unwrap();
        say(&store, "a1", "user", "three");
        assert_eq!(ask(&grants, &store, A, json!({"resource": "transcript", "taskId": "a1", "limit": 1, "cursor": 1, "revision": first["revision"]})), Err("StaleContext"));
        // The same page again without the old revision is served from the new state.
        assert!(ask(&grants, &store, A, json!({"resource": "transcript", "taskId": "a1", "limit": 1, "cursor": 1})).is_ok());
    }

    #[test]
    fn tool_kind_is_derived_from_the_stored_name() {
        for (name, kind) in [("Bash", "shell"), ("Command", "shell"), ("Edit", "edit"), ("MultiEdit", "edit"), ("Read", "read"), ("Grep", "search"), ("WebFetch", "web"), ("mcp__x__y", "mcp"), ("Thing", "other")] {
            assert_eq!(tool_kind(name), kind, "{name}");
        }
    }

    /// The service sees another package's page, an unknown page and a disabled package as `NotFound`; its own page
    /// answers stored values or the declared defaults, with the revision of the values.
    #[test]
    fn settings_are_the_packages_own_page_only() {
        use crate::extensions::packages::ExtensionPackages;
        let dir = Dir::new();
        let packages = ExtensionPackages::new(&dir.0, false);
        let packages = packages.0.lock().unwrap();
        let manifest = include_str!("../../../tests/fixtures/extensions/runtime-content-resources/extension.json");
        let other = manifest.replace("sample.content-resources", "sample.content-other");
        for text in [manifest.to_owned(), other] {
            let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            archive.start_file("extension.json", zip::write::SimpleFileOptions::default()).unwrap();
            std::io::Write::write_all(&mut archive, text.as_bytes()).unwrap();
            archive.start_file("main.cjs", zip::write::SimpleFileOptions::default()).unwrap();
            std::io::Write::write_all(&mut archive, include_str!("../../../tests/fixtures/extensions/runtime-content-resources/main.cjs").as_bytes()).unwrap();
            packages.install(&archive.finish().unwrap().into_inner()).unwrap();
        }
        for id in [A, "sample.content-other"] {
            let digest = serde_json::to_value(packages.snapshot()).unwrap()["packages"].as_array().unwrap().iter().find(|package| package["manifest"]["id"] == id).unwrap()["executable"]["digest"].as_str().unwrap().to_owned();
            packages.trust(id, &digest, true).unwrap(); packages.enable(id, true).unwrap();
        }
        let page = format!("{A}/preferences"); let foreign = "sample.content-other/preferences";
        // Defaults come from the declared `value` of each field; nothing is stored yet.
        assert_eq!(packages.settings_values(A, &page).unwrap(), json!({"label": "Local report", "enabled": true, "format": ""}));
        assert!(packages.settings_values(A, foreign).is_err());
        assert!(packages.settings_values(A, "sample.content-resources/missing").is_err());
        let before = settings_revision(&packages.settings_values(A, &page).unwrap());
        let values = json!({"label": "Changed", "enabled": false, "format": "long"});
        packages.settings_set(A, &page, &values).unwrap();
        assert_eq!(packages.settings_values(A, &page).unwrap(), values);
        assert_ne!(settings_revision(&values), before);
        // The other package's values are its own.
        assert_eq!(packages.settings_values("sample.content-other", foreign).unwrap()["label"], "Local report");
        assert!(packages.settings_values("sample.content-other", &page).is_err());
        packages.enable(A, false).unwrap();
        assert!(enabled_version(&packages, A).is_none()); assert!(packages.settings_values(A, &page).is_err());
        assert_eq!(settings_page(&json!({"page": page})).unwrap(), page);
        for bad in [json!({}), json!({"page": ""}), json!({"page": page, "owner": "x"}), json!("x"), json!({"page": 1})] { assert_eq!(settings_page(&bad), Err("InvalidArguments"), "{bad}"); }
    }

    /// The fixture service under the pinned runtime: it reads its own settings revision and refreshes on
    /// `settings.changed`, another package's page is `NotFound`, and the task reads obey the grants (the dispatch here
    /// is the app's `serve` with a test-owned store and grants file).
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    mod installed {
        use super::*;
        use crate::extensions::{packages::ExtensionPackages, runtime_service_lifetime::{Dispatch, ServiceLifetime}};
        use std::{future::Future, pin::Pin, sync::{Arc, Mutex}, time::{Duration, Instant}};
        use super::super::super::tests::{archive, digest};

        const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-content-resources/extension.json");
        const SOURCE: &str = include_str!("../../../tests/fixtures/extensions/runtime-content-resources/main.cjs");
        const CONTROL: &str = "sample.content-resources/control";
        fn runtime_dir() -> std::path::PathBuf { std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime") }

        async fn control(manager: &ServiceLifetime, args: Value) -> Value { manager.call_command(A, CONTROL, args, None).await.unwrap() }

        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn the_service_reads_its_settings_and_the_task_content_under_its_grants() {
            let dir = Dir::new();
            let packages = ExtensionPackages::new(&dir.0, false);
            let grants = Arc::new(RuntimeGrants::open(&dir.0));
            { let packages = packages.0.lock().unwrap(); packages.install(&archive(MANIFEST, SOURCE)).unwrap(); let digest = digest(&packages); packages.trust(A, &digest, true).unwrap(); packages.enable(A, true).unwrap(); }
            let store = Arc::new(Mutex::new(store()));
            { let store = store.lock().unwrap(); say(&store, "a1", "user", "hello"); say(&store, "a1", "assistant", "hi there"); say(&store, "b1", "user", "foreign"); }
            let dispatch: Dispatch = { let (packages, grants, store) = (packages.0.clone(), grants.clone(), store.clone()); Arc::new(move |request: DispatchRequest| {
                let (packages, grants, store) = (packages.clone(), grants.clone(), store.clone());
                Box::pin(async move {
                    let result = match request.method.as_str() {
                        "settingsGet" => settings_page(&request.params).and_then(|page| packages.lock().unwrap().settings_values(&request.owner, &page).map(settings_reply).map_err(|_| "NotFound")),
                        "contentQuery" => query(&grants, &store.lock().unwrap(), &request.owner, "1.0.0", &request.params),
                        _ => Err("UnsupportedCapability"),
                    };
                    match result { Ok(value) => json!({"ok": true, "value": value}), Err(code) => crate::extensions::context::failure(code) }
                }) as Pin<Box<dyn Future<Output = Value> + Send>>
            }) };
            let manager = ServiceLifetime::new(vec![runtime_dir()]);
            manager.set_dispatch(dispatch);
            let gated = grants.clone();
            manager.events().set_gate(Arc::new(move |owner, version, project| super::super::super::runtime_workspace_events::allowed(&gated, owner, version, project)));
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            grants.grant(A, "runtime.service", Scope::default()).unwrap();
            grants.grant(A, "events.workspace", Scope::default()).unwrap();
            grants.grant(A, "tasks.summary", projects(&["A"])).unwrap();
            grants.grant(A, "tasks.transcript.read", projects(&["A"])).unwrap();
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            let deadline = Instant::now() + Duration::from_secs(20);
            while !manager.serves(A, CONTROL) || manager.events().listeners(A) < 1 { assert!(Instant::now() < deadline, "the service never became ready"); tokio::time::sleep(Duration::from_millis(25)).await; }

            // Its own page: the declared defaults and the revision of those values; a foreign or unknown page is NotFound.
            let page = format!("{A}/preferences");
            let first = control(&manager, json!({"op": "settings"})).await;
            let defaults = json!({"label": "Local report", "enabled": true, "format": ""});
            assert_eq!(first["value"], json!({"schemaVersion": 1, "revision": settings_revision(&defaults), "values": defaults}), "{first}");
            for other in ["sample.content-other/preferences", "sample.content-resources/missing"] {
                assert_eq!(control(&manager, json!({"op": "settings", "page": other})).await, json!({"ok": false, "code": "NotFound"}));
            }
            // A save reports `settings.changed` to this package only; the service reads again and sees the new revision.
            let saved = json!({"label": "Changed", "enabled": false, "format": "long"});
            packages.0.lock().unwrap().settings_set(A, &page, &saved).unwrap();
            assert_eq!(manager.events().publish(&json!({"kind": "settings.changed", "page": page, "revision": settings_revision(&saved)}), Some("sample.someone-else"), 1).unwrap().queued, 0);
            assert_eq!(manager.events().publish(&json!({"kind": "settings.changed", "page": page, "revision": settings_revision(&saved)}), Some(A), 2).unwrap().queued, 1);
            let deadline = Instant::now() + Duration::from_secs(20);
            let seen = loop {
                let seen = control(&manager, json!({"op": "changes"})).await["seen"].as_array().cloned().unwrap_or_default();
                if !seen.is_empty() { break seen; }
                assert!(Instant::now() < deadline, "settings.changed never arrived");
                tokio::time::sleep(Duration::from_millis(50)).await;
            };
            assert_eq!(seen[0]["revision"], settings_revision(&saved));
            assert_eq!(seen[0]["reread"]["value"], json!({"schemaVersion": 1, "revision": settings_revision(&saved), "values": saved}));

            // Task content: the granted project reads, the other project and the ungranted tools resource are refused.
            let ask = |query: Value| { let manager = &manager; async move { control(manager, json!({"op": "query", "query": query})).await } };
            let transcript = ask(json!({"resource": "transcript", "taskId": "a1"})).await;
            assert_eq!(transcript["ok"], true, "{transcript}");
            assert_eq!(transcript["value"]["items"].as_array().unwrap().iter().map(|item| item["text"].as_str().unwrap()).collect::<Vec<_>>(), ["hello", "hi there"]);
            assert_eq!(ask(json!({"resource": "transcript", "taskId": "b1"})).await, json!({"ok": false, "code": "PermissionDenied"}));
            assert_eq!(ask(json!({"resource": "tools", "taskId": "a1"})).await, json!({"ok": false, "code": "PermissionDenied"}));
            assert_eq!(ask(json!({"resource": "tasks"})).await["value"]["items"].as_array().unwrap().len(), 2);
            grants.revoke(A, "tasks.transcript.read").unwrap();
            assert_eq!(ask(json!({"resource": "transcript", "taskId": "a1"})).await, json!({"ok": false, "code": "PermissionDenied"}));
            manager.stop_all(super::super::super::StopReason::Quit);
            assert!(manager.wait_idle(Duration::from_secs(5)).await);
        }
    }
}
