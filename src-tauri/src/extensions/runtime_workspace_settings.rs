//! The settled workspace settings (`workspace.settings`, runtime phase R4, slice R0407).
//!
//! A trusted service reads and changes the app's own workspace settings with `panda.workspace.settings.list()`,
//! `get(key)` and `set(key, value, { revision })`. The permission `workspace.settings` is global (it is not project
//! scoped), granted with the trust decision and checked against the grants file on every call and once more right
//! before a write, so a revoke between the two changes nothing. A package that holds it is never asked per action
//! (ADR-0005). The keys are a frozen set:
//!
//! `sidebar.sort`, `sidebar.filter`, `sidebar.scope`, `sidebar.order`, `view.open`, `tiles.layout`, `find.query`,
//! `projects.search`, `tokenSaver`, `council`, `bot:<id>`, `channel:<id>`, `team.profiles`, `widgets`,
//! `machines.orchestration`, `appearance.compact` and `appearance.theme`.
//!
//! Anything else answers `NotFound`, including the names in `EXCLUDED`: the telemetry opt-outs, the routing opt-in and
//! the GitHub switch (rules of the original project: no telemetry, no traffic before opt-in), safe mode, updates and
//! extension trust (recovery), pairing and remote access (they stay with the user). A package therefore cannot reach
//! through a setting what the original project's rules protect: those switches are not settings keys at all.
//!
//! Every key has a revision. `set` with a `revision` that is not the key's current one answers `StaleContext`
//! (a read-modify-write race); without a `revision` the write is unconditional. A value the key does not take is
//! `InvalidShape`, one over the bound `LimitExceeded`. Size, depth and entry bounds are for predictability and fault
//! isolation only.
//!
//! This store is the settled record. The main window owns the live state (its own storage): it publishes the values
//! it holds (`extensions_workspace_settings_publish`), applies a package's change when it is told of one
//! (`extensions-workspace-setting`, `extensions_workspace_settings_pending`) and then acknowledges it
//! (`extensions_workspace_settings_ack`). A package's change that the window has not applied yet is never overwritten
//! by the window's older value. Every change records the package that made it (`by`) and is reported to services
//! that subscribed to `settings.changed` as page `workspace.<key>` with the store's revision.
//!
//! The state is pure (no app handle), so the rules are deterministic to test; the app half (`serve` and the three
//! commands) only adds the grants file, the window and the events.
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, path::{Path, PathBuf}, sync::Mutex};

/// The named permission (global, granted with trust, rechecked on every call).
pub const PERMISSION: &str = "workspace.settings";
pub const SCHEMA_VERSION: u64 = 1;
/// The fixed keys. `bot:<id>` and `channel:<id>` are the two keyed families.
pub const KEYS: [&str; 15] = [
    "sidebar.sort", "sidebar.filter", "sidebar.scope", "sidebar.order", "view.open", "tiles.layout", "find.query", "projects.search",
    "tokenSaver", "council", "team.profiles", "widgets", "machines.orchestration", "appearance.compact", "appearance.theme",
];
pub const FAMILIES: [&str; 2] = ["bot:", "channel:"];
/// What is deliberately not a settings key, and why (each stays with the user or with the original project's rules).
pub const EXCLUDED: [(&str, &str); 9] = [
    ("telemetry", "rules of the original project: no telemetry"),
    ("routing", "rules of the original project: no traffic before opt-in"),
    ("github", "rules of the original project: the GitHub switch is the user's"),
    ("safeMode", "recovery"),
    ("updates", "recovery"),
    ("trust", "recovery: trust in an extension is the user's record"),
    ("pairing", "pairing a machine stays with the user"),
    ("remoteAccess", "granting remote access stays with the user"),
    ("credentials", "ADR-0006: a held credential is never handed to a package"),
];
/// Bytes of one value, as JSON.
pub const MAX_VALUE_BYTES: usize = 64 * 1024;
/// Nesting depth of a free-form value.
pub const MAX_DEPTH: usize = 8;
/// Entries of the keyed families together.
pub const MAX_FAMILY_ENTRIES: usize = 1024;
const MAX_IDS: usize = 512;
const MAX_TEXT: usize = 512;

/// A refusal in the broker envelope: `code`, the `path` it names and the `ids` it carries.
pub fn failure_with(code: &str, path: &str, ids: &[String]) -> Value { json!({"ok": false, "error": {"schemaVersion": 1, "code": code, "path": path, "ids": ids}}) }
fn ok(value: Value) -> Value { json!({"ok": true, "value": value}) }

// ---- Keys and values ---------------------------------------------------------------------------------------------

fn ident(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control) }

/// The keyed family of `key` (`bot:` or `channel:`) when it names an id.
pub fn family_of(key: &str) -> Option<&'static str> {
    FAMILIES.iter().copied().find(|prefix| key.strip_prefix(prefix).is_some_and(ident))
}
/// Whether `key` is in the frozen set (the keyed families by shape).
pub fn is_key(key: &str) -> bool { KEYS.contains(&key) || family_of(key).is_some() }

fn text(value: &Value, limit: usize) -> Result<(), &'static str> {
    let text = value.as_str().ok_or("InvalidShape")?;
    if text.chars().any(char::is_control) { return Err("InvalidShape"); }
    if text.chars().count() > limit { return Err("LimitExceeded"); }
    Ok(())
}
fn one_of(value: &Value, options: &[&str]) -> Result<(), &'static str> {
    if value.as_str().is_some_and(|text| options.contains(&text)) { Ok(()) } else { Err("InvalidShape") }
}
fn id_list(value: &Value, limit: usize) -> Result<(), &'static str> {
    let items = value.as_array().ok_or("InvalidShape")?;
    if items.len() > limit { return Err("LimitExceeded"); }
    let mut seen = std::collections::BTreeSet::new();
    for item in items {
        let id = item.as_str().filter(|id| ident(id)).ok_or("InvalidShape")?;
        if !seen.insert(id) { return Err("InvalidShape"); }
    }
    Ok(())
}
fn depth(value: &Value, level: usize) -> bool {
    if level > MAX_DEPTH { return false; }
    match value { Value::Array(items) => items.iter().all(|item| depth(item, level + 1)), Value::Object(map) => map.values().all(|item| depth(item, level + 1)), _ => true }
}
/// An object with only `allowed` fields (the fields are optional unless `required` lists them).
fn fields(value: &Value, allowed: &[&str], required: &[&str]) -> Result<(), &'static str> {
    let map = value.as_object().ok_or("InvalidShape")?;
    if map.keys().any(|key| !allowed.contains(&key.as_str())) || required.iter().any(|key| !map.contains_key(*key)) { return Err("InvalidShape"); }
    Ok(())
}
fn number_in(value: &Value, options: &[f64]) -> bool { value.as_f64().is_some_and(|number| options.iter().any(|option| (*option - number).abs() < f64::EPSILON)) }

/// Checks `value` against what `key` takes. A free-form object (`team.profiles`, `widgets`, `machines.orchestration`)
/// takes any JSON object within the depth and size bounds: those stores are owned by their own surfaces.
pub fn validate(key: &str, value: &Value) -> Result<(), &'static str> {
    if value.to_string().len() > MAX_VALUE_BYTES { return Err("LimitExceeded"); }
    if !depth(value, 0) { return Err("LimitExceeded"); }
    if family_of(key).is_some() {
        fields(value, &["pinned", "order"], &[])?;
        let map = value.as_object().ok_or("InvalidShape")?;
        if map.get("pinned").is_some_and(|pinned| !pinned.is_boolean()) { return Err("InvalidShape"); }
        if map.get("order").is_some_and(|order| !order.is_null() && !order.as_u64().is_some_and(|number| number < 100_000)) { return Err("InvalidShape"); }
        return Ok(());
    }
    match key {
        "sidebar.sort" => {
            fields(value, &["tasks", "projects", "group"], &["tasks", "projects", "group"])?;
            one_of(&value["tasks"], &["manual", "recent", "created"])?;
            one_of(&value["projects"], &["recent", "added", "name", "manual"])?;
            one_of(&value["group"], &["project", "flat"])
        }
        "sidebar.scope" => if number_in(value, &[3.0, 6.0, 10.0, 15.0]) && value.is_u64() { Ok(()) } else { Err("InvalidShape") },
        "sidebar.filter" => text(value, 128),
        "sidebar.order" => id_list(value, MAX_IDS),
        "view.open" => one_of(value, &["conversation", "board", "github"]),
        "tiles.layout" => id_list(value, 6),
        "find.query" | "projects.search" => text(value, MAX_TEXT),
        "tokenSaver" => {
            fields(value, &["defaults", "threads"], &[])?;
            if value.get("defaults").is_some_and(|defaults| !defaults.is_null() && !defaults.is_object()) || value.get("threads").is_some_and(|threads| !threads.is_object()) { return Err("InvalidShape"); }
            Ok(())
        }
        "council" => {
            fields(value, &["target", "maxRounds", "reviewers", "newThreads"], &[])?;
            if value.get("target").is_some_and(|target| !number_in(target, &[7.0, 8.0, 8.5, 9.0, 9.5, 10.0]))
                || value.get("maxRounds").is_some_and(|rounds| !number_in(rounds, &[3.0, 5.0, 10.0, 25.0]))
                || value.get("reviewers").is_some_and(|reviewers| !number_in(reviewers, &[0.0, 2.0, 3.0, 4.0, 5.0]))
                || value.get("newThreads").is_some_and(|on| !on.is_boolean()) { return Err("InvalidShape"); }
            Ok(())
        }
        "team.profiles" | "widgets" | "machines.orchestration" => if value.is_object() { Ok(()) } else { Err("InvalidShape") },
        "appearance.compact" => if value.is_boolean() { Ok(()) } else { Err("InvalidShape") },
        "appearance.theme" => one_of(value, &["light", "dark"]),
        _ => Err("NotFound"),
    }
}

// ---- The store -----------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
struct Entry { value: Value, revision: u64, applied: bool, by: Option<String> }
#[derive(Default)]
struct State { revision: u64, entries: BTreeMap<String, Entry> }

/// What a successful `set` changed: the key, its new revision and the store's revision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change { pub key: String, pub revision: u64, pub store_revision: u64 }

/// The settled values and their revisions, persisted next to the grants (file-backed, independent of SQLite).
pub struct WorkspaceSettings { inner: Mutex<State>, file: Option<PathBuf> }
impl Default for WorkspaceSettings { fn default() -> Self { Self { inner: Mutex::new(State::default()), file: None } } }

impl WorkspaceSettings {
    /// Opens (or starts) the store in `dir`; an unreadable file starts empty and is replaced on the next change.
    pub fn open(dir: &Path) -> Self {
        let file = dir.join("workspace-settings.json");
        let mut state = State::default();
        if let Ok(text) = std::fs::read_to_string(&file) {
            if let Ok(root) = serde_json::from_str::<Value>(&text) {
                state.revision = root["revision"].as_u64().unwrap_or(0);
                for (key, row) in root["entries"].as_object().into_iter().flatten() {
                    if !is_key(key) || validate(key, &row["value"]).is_err() { continue; }
                    state.entries.insert(key.clone(), Entry { value: row["value"].clone(), revision: row["revision"].as_u64().unwrap_or(1), applied: row["applied"] != false, by: row["by"].as_str().map(str::to_owned) });
                }
            }
        }
        Self { inner: Mutex::new(state), file: Some(file) }
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, &'static str> { self.inner.lock().map_err(|_| "HostUnavailable") }
    fn save(&self, state: &State) {
        let Some(file) = &self.file else { return };
        let entries: Map<String, Value> = state.entries.iter().map(|(key, entry)| (key.clone(), json!({"value": entry.value, "revision": entry.revision, "applied": entry.applied, "by": entry.by}))).collect();
        let temporary = file.with_extension("json.tmp");
        if std::fs::write(&temporary, json!({"schemaVersion": SCHEMA_VERSION, "revision": state.revision, "entries": entries}).to_string()).is_ok() { let _ = std::fs::rename(&temporary, file); }
    }
    fn family_count(state: &State) -> usize { state.entries.keys().filter(|key| family_of(key).is_some()).count() }
    pub fn revision(&self) -> u64 { self.inner.lock().map_or(0, |state| state.revision) }

    /// The keys a package can name now: the fixed ones, then each keyed entry the window has published.
    pub fn list(&self) -> Result<Vec<String>, &'static str> {
        let state = self.lock()?;
        let mut keys: Vec<String> = KEYS.iter().map(|key| (*key).to_owned()).collect();
        keys.extend(state.entries.keys().filter(|key| family_of(key).is_some()).cloned());
        Ok(keys)
    }
    /// `{key, value, revision}`. A fixed key nobody has written yet is `null` at revision 0; an unpublished `bot:` or
    /// `channel:` id and any name outside the frozen set are `NotFound`.
    pub fn get(&self, key: &str) -> Result<Value, &'static str> {
        if !is_key(key) { return Err("NotFound"); }
        let state = self.lock()?;
        match state.entries.get(key) {
            Some(entry) => Ok(json!({"key": key, "value": entry.value, "revision": entry.revision})),
            None if KEYS.contains(&key) => Ok(json!({"key": key, "value": Value::Null, "revision": 0})),
            None => Err("NotFound"),
        }
    }
    /// A package's write. `still_granted` is asked under the store's lock, right before the write. Answers `None`
    /// when the value is the one already held (nothing changed, nothing is reported).
    pub fn set(&self, key: &str, value: &Value, revision: Option<u64>, by: &str, still_granted: &dyn Fn() -> bool) -> Result<Option<Change>, &'static str> {
        if !is_key(key) { return Err("NotFound"); }
        let mut state = self.lock()?;
        let current = state.entries.get(key);
        // A keyed entry exists only once the window published it (a bot or channel that is not there is not found).
        if family_of(key).is_some() && current.is_none() { return Err("NotFound"); }
        validate(key, value)?;
        if revision.is_some_and(|expected| expected != current.map_or(0, |entry| entry.revision)) { return Err("StaleContext"); }
        if !still_granted() { return Err("PermissionDenied"); }
        if current.is_some_and(|entry| &entry.value == value) { return Ok(None); }
        let next = current.map_or(0, |entry| entry.revision) + 1;
        state.revision += 1;
        let store_revision = state.revision;
        state.entries.insert(key.to_owned(), Entry { value: value.clone(), revision: next, applied: false, by: Some(by.to_owned()) });
        self.save(&state);
        Ok(Some(Change { key: key.to_owned(), revision: next, store_revision }))
    }
    /// The window publishes what its own storage holds, and the keyed entries that no longer exist (`forget`).
    /// A package's change the window has not applied yet is kept: the window's older value never overwrites it.
    /// Answers the keys that changed.
    pub fn publish(&self, values: &Map<String, Value>, forget: &[String]) -> Result<Vec<String>, &'static str> {
        let mut state = self.lock()?;
        let mut changed = Vec::new();
        for (key, value) in values {
            if !is_key(key) || validate(key, value).is_err() { continue; }
            match state.entries.get(key) {
                Some(entry) if !entry.applied => continue,
                Some(entry) if &entry.value == value => continue,
                None if family_of(key).is_some() && Self::family_count(&state) >= MAX_FAMILY_ENTRIES => continue,
                _ => {}
            }
            let next = state.entries.get(key).map_or(0, |entry| entry.revision) + 1;
            state.entries.insert(key.clone(), Entry { value: value.clone(), revision: next, applied: true, by: None });
            changed.push(key.clone());
        }
        for key in forget {
            if family_of(key).is_some() && state.entries.remove(key).is_some() { changed.push(key.clone()); }
        }
        if !changed.is_empty() { state.revision += 1; self.save(&state); }
        Ok(changed)
    }
    /// The package changes the window has not applied yet, oldest key first.
    pub fn pending(&self) -> Value {
        let Ok(state) = self.inner.lock() else { return json!({"schemaVersion": SCHEMA_VERSION, "revision": 0, "pending": []}) };
        let pending: Vec<Value> = state.entries.iter().filter(|(_, entry)| !entry.applied).map(|(key, entry)| json!({"key": key, "value": entry.value, "revision": entry.revision, "by": entry.by})).collect();
        json!({"schemaVersion": SCHEMA_VERSION, "revision": state.revision, "pending": pending})
    }
    /// The window applied `key` at `revision`. A newer package change stays pending.
    pub fn ack(&self, key: &str, revision: u64) -> bool {
        let Ok(mut state) = self.inner.lock() else { return false };
        let Some(entry) = state.entries.get_mut(key) else { return false };
        if entry.revision != revision || entry.applied { return false; }
        entry.applied = true;
        self.save(&state);
        true
    }
}

// ---- The app -------------------------------------------------------------------------------------------------------

pub fn state(app: &tauri::AppHandle) -> Option<tauri::State<'_, WorkspaceSettings>> { use tauri::Manager; app.try_state::<WorkspaceSettings>() }

fn changed(app: &tauri::AppHandle, change: &Change, by: &str) {
    use tauri::Emitter;
    let _ = app.emit("extensions-workspace-setting", json!({"key": change.key, "revision": change.revision, "by": by}));
    // Services that subscribed to `settings.changed` hear it as the page `workspace.<key>`.
    crate::extensions::runtime_service_lifetime::runtime_workspace_events::publish_app(
        app, &json!({"kind": "settings.changed", "page": format!("workspace.{}", change.key), "revision": change.store_revision}), None,
    );
}

/// Serves `workspaceSettings` `{op: "list" | "get" | "set", key?, value?, revision?}` of the service of `request.owner`.
pub fn serve(app: &tauri::AppHandle, request: crate::extensions::runtime_service_lifetime::DispatchRequest) -> Value {
    use tauri::Manager;
    let owner = request.owner.clone();
    let version = {
        let Some(packages) = app.try_state::<crate::extensions::packages::ExtensionPackages>() else { return failure_with("UnsupportedCapability", "$", &[]) };
        let Ok(packages) = packages.0.try_lock() else { return failure_with("Timeout", "$", &[]) };
        let snapshot = packages.snapshot();
        let version = if snapshot.safe_mode { None } else { snapshot.packages.iter().find(|package| package.enabled && package.manifest["id"] == owner.as_str()).and_then(|package| package.manifest["version"].as_str().map(str::to_owned)) };
        match version { Some(version) => version, None => return failure_with("PermissionDenied", PERMISSION, &[]) }
    };
    let granted = |app: &tauri::AppHandle| app.try_state::<crate::extensions::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(&owner, &version, PERMISSION, &crate::extensions::runtime_grants::Target::default()).is_ok());
    if !granted(app) { return failure_with("PermissionDenied", PERMISSION, &[]); }
    let Some(store) = state(app) else { return failure_with("UnsupportedCapability", "$", &[]) };
    let params = &request.params;
    let op = params["op"].as_str().unwrap_or_default();
    let key = || params["key"].as_str().ok_or("InvalidShape");
    let result: Result<Value, &'static str> = match op {
        "list" => store.list().map(|keys| json!(keys)),
        "get" => key().and_then(|key| store.get(key)),
        "set" => (|| {
            let key = key()?;
            if !params.as_object().is_some_and(|object| object.keys().all(|name| matches!(name.as_str(), "op" | "key" | "value" | "revision"))) || params.get("value").is_none() { return Err("InvalidShape"); }
            let revision = match params.get("revision") { None | Some(Value::Null) => None, Some(number) => Some(number.as_u64().ok_or("InvalidShape")?) };
            let change = store.set(key, &params["value"], revision, &owner, &|| granted(app))?;
            if let Some(change) = change { changed(app, &change, &owner); }
            Ok(Value::Null)
        })(),
        _ => Err("InvalidShape"),
    };
    match result {
        Ok(value) => ok(value),
        Err(code) => failure_with(code, if code == "PermissionDenied" { PERMISSION } else { params["key"].as_str().filter(|key| ident(key)).unwrap_or("$") }, &[]),
    }
}

/// The main window publishes the values its storage holds (`values`: key to value) and the bots and channels that are
/// gone (`forget`). Answers the keys that changed.
#[tauri::command]
pub fn extensions_workspace_settings_publish(window: tauri::WebviewWindow, app: tauri::AppHandle, values: Value, forget: Option<Vec<String>>) -> Result<Vec<String>, String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    let Some(store) = state(&app) else { return Err("UnsupportedCapability".into()) };
    let values = values.as_object().cloned().ok_or("InvalidShape")?;
    let forget = forget.unwrap_or_default();
    if values.len() > MAX_FAMILY_ENTRIES + KEYS.len() || forget.len() > MAX_FAMILY_ENTRIES { return Err("LimitExceeded".into()); }
    store.publish(&values, &forget).map_err(str::to_owned)
}
/// The package changes the main window has not applied yet (it asks when it starts and when it is told of a change).
#[tauri::command]
pub fn extensions_workspace_settings_pending(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Value, String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    Ok(state(&app).map_or_else(|| json!({"schemaVersion": SCHEMA_VERSION, "revision": 0, "pending": []}), |store| store.pending()))
}
/// The main window applied a package's change.
#[tauri::command]
pub fn extensions_workspace_settings_ack(window: tauri::WebviewWindow, app: tauri::AppHandle, key: String, revision: u64) -> Result<bool, String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    Ok(state(&app).is_some_and(|store| store.ack(&key, revision)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn always() -> bool { true }
    fn sample(key: &str) -> Value {
        match key {
            "sidebar.sort" => json!({"tasks": "recent", "projects": "name", "group": "flat"}),
            "sidebar.filter" => json!("project-1"),
            "sidebar.scope" => json!(10),
            "sidebar.order" => json!(["b", "a"]),
            "view.open" => json!("board"),
            "tiles.layout" => json!(["t1", "t2"]),
            "find.query" | "projects.search" => json!("needle"),
            "tokenSaver" => json!({"defaults": {"packs": [], "level": "full"}, "threads": {}}),
            "council" => json!({"target": 8.5, "maxRounds": 5, "reviewers": 3, "newThreads": true}),
            "team.profiles" | "widgets" | "machines.orchestration" => json!({"items": [1, 2]}),
            "appearance.compact" => json!(true),
            "appearance.theme" => json!("light"),
            _ => json!({"pinned": true, "order": 2}),
        }
    }
    fn seeded() -> WorkspaceSettings {
        let store = WorkspaceSettings::default();
        let mut values = Map::new();
        values.insert("bot:b1".into(), json!({"pinned": false}));
        values.insert("channel:c1".into(), json!({}));
        store.publish(&values, &[]).unwrap();
        store
    }

    #[test]
    fn every_frozen_key_round_trips_with_a_new_revision() {
        let store = seeded();
        let mut keys: Vec<&str> = KEYS.to_vec();
        keys.extend(["bot:b1", "channel:c1"]);
        for key in keys {
            let before = store.get(key).unwrap()["revision"].as_u64().unwrap();
            let change = store.set(key, &sample(key), Some(before), "sample.pkg", &always).unwrap().unwrap();
            assert_eq!(change.revision, before + 1, "{key}");
            let read = store.get(key).unwrap();
            assert_eq!((read["value"].clone(), read["revision"].as_u64()), (sample(key), Some(before + 1)), "{key}");
        }
        assert_eq!(store.list().unwrap().len(), KEYS.len() + 2);
    }

    #[test]
    fn unknown_and_excluded_keys_are_not_found_and_never_listed() {
        let store = seeded();
        for (name, _) in EXCLUDED { for key in [name.to_owned(), format!("{name}.enabled")] {
            assert_eq!(store.get(&key).unwrap_err(), "NotFound", "{key}");
            assert_eq!(store.set(&key, &json!(true), None, "p", &always).unwrap_err(), "NotFound", "{key}");
            assert!(!is_key(&key));
        } }
        for key in ["", "sidebar", "sidebar.sorts", "bot:", "bot", "robot:x", "bot:ghost"] {
            assert_eq!(store.get(key).unwrap_err(), "NotFound", "{key}");
        }
        assert!(store.list().unwrap().iter().all(|key| KEYS.contains(&key.as_str()) || family_of(key).is_some()));
        assert_eq!(store.set("bot:ghost", &json!({}), None, "p", &always).unwrap_err(), "NotFound");
    }

    #[test]
    fn a_stale_revision_is_stale_context_and_changes_nothing() {
        let store = WorkspaceSettings::default();
        assert_eq!(store.get("view.open").unwrap()["revision"], 0);
        store.set("view.open", &json!("board"), Some(0), "a", &always).unwrap();
        // A second writer that read revision 0 lost the race.
        assert_eq!(store.set("view.open", &json!("github"), Some(0), "b", &always).unwrap_err(), "StaleContext");
        assert_eq!(store.get("view.open").unwrap()["value"], "board");
        store.set("view.open", &json!("github"), Some(1), "b", &always).unwrap();
        // Without a revision the write is unconditional.
        store.set("view.open", &json!("conversation"), None, "b", &always).unwrap();
        assert_eq!(store.get("view.open").unwrap()["revision"], 3);
        // The same value changes nothing and reports nothing.
        assert_eq!(store.set("view.open", &json!("conversation"), None, "b", &always).unwrap(), None);
        assert_eq!(store.get("view.open").unwrap()["revision"], 3);
    }

    #[test]
    fn values_the_key_does_not_take_are_refused_with_their_reason() {
        let store = seeded();
        for (key, value, code) in [
            ("sidebar.sort", json!({"tasks": "recent"}), "InvalidShape"), ("sidebar.sort", json!({"tasks": "random", "projects": "name", "group": "flat"}), "InvalidShape"),
            ("sidebar.scope", json!(7), "InvalidShape"), ("sidebar.scope", json!("6"), "InvalidShape"), ("sidebar.order", json!(["a", "a"]), "InvalidShape"),
            ("view.open", json!("settings"), "InvalidShape"), ("tiles.layout", json!(["1", "2", "3", "4", "5", "6", "7"]), "LimitExceeded"),
            ("find.query", json!("x".repeat(MAX_TEXT + 1)), "LimitExceeded"), ("find.query", json!(5), "InvalidShape"),
            ("council", json!({"target": 7.5}), "InvalidShape"), ("council", json!({"mystery": 1}), "InvalidShape"), ("tokenSaver", json!({"threads": []}), "InvalidShape"),
            ("widgets", json!([]), "InvalidShape"), ("widgets", json!({"blob": "x".repeat(MAX_VALUE_BYTES)}), "LimitExceeded"),
            ("appearance.compact", json!("true"), "InvalidShape"), ("appearance.theme", json!("sepia"), "InvalidShape"), ("bot:b1", json!({"token": "x"}), "InvalidShape"),
            ("bot:b1", json!({"pinned": "yes"}), "InvalidShape"),
        ] { assert_eq!(store.set(key, &value, None, "p", &always).unwrap_err(), code, "{key} {value}"); }
        let mut deep = json!(1);
        for _ in 0..=MAX_DEPTH { deep = json!({"a": deep}); }
        assert_eq!(store.set("widgets", &deep, None, "p", &always).unwrap_err(), "LimitExceeded");
    }

    #[test]
    fn a_revoke_between_admission_and_the_write_changes_nothing() {
        let store = WorkspaceSettings::default();
        assert_eq!(store.set("appearance.compact", &json!(true), None, "p", &|| false).unwrap_err(), "PermissionDenied");
        assert_eq!(store.get("appearance.compact").unwrap()["value"], Value::Null);
        assert_eq!(store.revision(), 0);
    }

    #[test]
    fn the_windows_older_value_never_overwrites_an_unapplied_package_change() {
        let store = WorkspaceSettings::default();
        let mut window = Map::new();
        window.insert("appearance.theme".into(), json!("dark"));
        assert_eq!(store.publish(&window, &[]).unwrap(), vec!["appearance.theme".to_owned()]);
        let change = store.set("appearance.theme", &json!("light"), Some(1), "pkg", &always).unwrap().unwrap();
        // The window still holds "dark" and publishes it again: the package's change stays.
        assert!(store.publish(&window, &[]).unwrap().is_empty());
        let pending = store.pending();
        assert_eq!((pending["pending"][0]["key"].clone(), pending["pending"][0]["value"].clone(), pending["pending"][0]["by"].clone()), (json!("appearance.theme"), json!("light"), json!("pkg")));
        // An acknowledgement of an older revision does nothing; the right one settles it.
        assert!(!store.ack("appearance.theme", change.revision - 1));
        assert!(store.ack("appearance.theme", change.revision));
        assert!(store.pending()["pending"].as_array().unwrap().is_empty());
        // Now the window's own change is the newer one.
        window.insert("appearance.theme".into(), json!("dark"));
        assert_eq!(store.publish(&window, &[]).unwrap(), vec!["appearance.theme".to_owned()]);
        assert_eq!(store.get("appearance.theme").unwrap()["revision"], 3);
    }

    #[test]
    fn keyed_entries_follow_the_windows_bots_and_channels() {
        let store = seeded();
        assert!(store.list().unwrap().contains(&"bot:b1".to_owned()));
        let mut empty = Map::new();
        // The window cannot forget a fixed key; a published bot that was removed disappears.
        assert_eq!(store.publish(&empty, &["bot:b1".into(), "view.open".into()]).unwrap(), vec!["bot:b1".to_owned()]);
        assert_eq!(store.get("bot:b1").unwrap_err(), "NotFound");
        empty.insert("bot:".into(), json!({}));
        empty.insert("channel:x".into(), json!({"order": -1}));
        assert!(store.publish(&empty, &[]).unwrap().is_empty());
    }

    #[test]
    fn the_store_survives_a_restart_with_revisions_and_unapplied_changes() {
        let dir = std::env::temp_dir().join(format!("pandacode-workspace-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        {
            let store = WorkspaceSettings::open(&dir);
            store.set("appearance.compact", &json!(true), None, "pkg", &always).unwrap();
            let mut values = Map::new();
            values.insert("sidebar.scope".into(), json!(15));
            store.publish(&values, &[]).unwrap();
        }
        let again = WorkspaceSettings::open(&dir);
        assert_eq!(again.get("sidebar.scope").unwrap()["value"], 15);
        assert_eq!(again.get("appearance.compact").unwrap()["revision"], 1);
        assert_eq!(again.pending()["pending"][0]["key"], "appearance.compact");
        assert_eq!(again.revision(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_refusal_envelope_names_the_code_and_the_path() {
        assert_eq!(failure_with("NotFound", "telemetry", &[]), json!({"ok": false, "error": {"schemaVersion": 1, "code": "NotFound", "path": "telemetry", "ids": []}}));
    }
}
