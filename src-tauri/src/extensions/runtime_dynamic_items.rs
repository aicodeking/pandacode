//! Scoped live contributions of background services (`ui.dynamic`, runtime phase R2, slice R0205).
//!
//! A trusted service registers menu items, commands, views and slash commands at run time (`panda.ui.register`),
//! changes them (`RuntimeItem.update`, `panda.ui.update` for an item of its own manifest, `panda.ui.updateView`) and
//! removes them (`RuntimeItem.dispose`). The items live in a run-time layer per owner that the interface merges over
//! the manifest snapshot; the layer is cleared when the service stops, so the manifest values come back.
//!
//! Rules that are for predictability and fault isolation, never for trust (ADR-0005):
//! - a registration is checked with the same validators as a manifest entry (`validate_contract`), its id must carry
//!   the owner's prefix and may not collide with a manifest id or a live item;
//! - at most 128 live items per owner and 20 applied updates per second per owner: beyond the rate the latest value of
//!   each field wins and is applied when the window has room (`tick`), never dropped;
//! - `scope` (`{taskId}` or `{projectId}`) exists only here, is fixed at registration and is checked when it is given;
//!   `forget_scope` removes the items of a task or project that is gone;
//! - `enabled` / `visible` replace the declared expression in this layer; `null` removes the override;
//! - a handle that was disposed (or never existed) answers `NotFound`.
//!
//! The state is pure (injected clock and checks) so the bounds are deterministic to test. The process loop reaches it
//! through `serve_app` (a `ui` request of the service) and the interface reads it through `extensions_runtime_items`;
//! `src/extensions/runtime-dynamic-items.ts` mirrors the rules for the browser preview.
use serde_json::{json, Map, Value};
use std::{collections::{BTreeMap, VecDeque}, sync::Mutex};

/// The named permission (granted with the trust decision, rechecked on every request).
pub const PERMISSION: &str = "ui.dynamic";
/// Live items per owner (the manifest limit for `menus`).
pub const MAX_ITEMS: usize = 128;
/// Applied updates per second per owner.
pub const MAX_UPDATES_PER_SECOND: usize = 20;
/// Fields `update` may change on any item; `id`, `kind`, `location` and `command` are never among them.
pub const PATCH_FIELDS: [&str; 13] = ["text", "badge", "icon", "tone", "tooltip", "progress", "enabled", "visible", "args", "items", "title", "controls", "toolbar"];
/// Fields `updateView` may change.
pub const VIEW_FIELDS: [&str; 4] = ["title", "text", "controls", "toolbar"];
pub const TONES: [&str; 5] = ["neutral", "info", "success", "warning", "danger"];
const ARGS_BYTES: usize = 4096;
const TOOLTIP_CHARS: usize = 1024;

/// What a registration is scoped to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope { Task(String), Project(String) }
impl Scope {
    pub fn parse(raw: &Value) -> Result<Self, &'static str> {
        let object = raw.as_object().filter(|object| object.len() == 1).ok_or("InvalidShape")?;
        match (object.get("taskId").and_then(Value::as_str), object.get("projectId").and_then(Value::as_str)) {
            (Some(id), None) if ident(id) => Ok(Self::Task(id.to_owned())),
            (None, Some(id)) if ident(id) => Ok(Self::Project(id.to_owned())),
            _ => Err("InvalidShape"),
        }
    }
    pub fn to_json(&self) -> Value { match self { Self::Task(id) => json!({"taskId": id}), Self::Project(id) => json!({"projectId": id}) } }
}
fn ident(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control) }

/// The four kinds of contribution a service registers, and where each lives in the manifest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind { Menu, Command, View, SlashCommand }
impl Kind {
    fn parse(name: &str) -> Option<Self> { Some(match name { "menu" => Self::Menu, "command" => Self::Command, "view" => Self::View, "slashCommand" => Self::SlashCommand, _ => return None }) }
    fn bucket(self) -> &'static str { match self { Self::Menu => "menus", Self::Command => "commands", Self::View => "views", Self::SlashCommand => "slashCommands" } }
}

/// What the app answers about the world; tests give fixed answers.
pub struct Checks<'a> {
    /// The package holds `ui.dynamic` now (checked against the grants file on every request).
    pub granted: bool,
    /// The installed manifest of the owner (`contributes` is read for ids and command references).
    pub manifest: &'a Value,
    /// A task or project of a scope exists.
    pub scope_exists: &'a dyn Fn(&Scope) -> bool,
    pub version: &'a str,
    pub now_ms: u64,
}

struct Item { kind: Kind, declared: Value, scope: Option<Scope> }
#[derive(Default)]
struct Layer {
    items: BTreeMap<String, Item>,
    /// Field overrides by id: a live item's own and those of a manifest item of the same package.
    overrides: BTreeMap<String, Map<String, Value>>,
    /// Instants (ms) of the updates applied in the last second.
    window: VecDeque<u64>,
    /// Updates waiting for room in the window, by id; the latest value of each field wins.
    pending: BTreeMap<String, Map<String, Value>>,
}

/// Every owner's run-time layer.
#[derive(Default)]
pub struct DynamicItems { inner: Mutex<Inner> }
#[derive(Default)]
struct Inner { layers: BTreeMap<String, Layer>, revision: u64 }

pub fn failure(code: &str) -> Value { json!({"ok": false, "error": {"schemaVersion": 1, "code": code, "path": "$", "ids": []}}) }
fn ok(value: Value) -> Value { json!({"ok": true, "value": value}) }

fn manifest_ids<'a>(manifest: &'a Value, bucket: &str) -> impl Iterator<Item = &'a str> { manifest["contributes"][bucket].as_array().into_iter().flatten().filter_map(|entry| entry["id"].as_str()) }
fn owns(owner: &str, id: &str) -> bool { id.strip_prefix(owner).and_then(|rest| rest.strip_prefix('/')).is_some_and(|rest| !rest.is_empty()) }
fn code_of(checked: &Value) -> String { checked["error"]["code"].as_str().unwrap_or("InvalidShape").to_owned() }

/// The effective value of a declared definition with its overrides: `null` clears a field.
fn effective(declared: &Value, overrides: Option<&Map<String, Value>>) -> Value {
    let mut value = declared.clone();
    if let (Some(object), Some(overrides)) = (value.as_object_mut(), overrides) {
        for (key, patch) in overrides { if patch.is_null() { object.remove(key); } else { object.insert(key.clone(), patch.clone()); } }
    }
    value
}

/// The fields every kind of patch shares: shape of `tone`, `tooltip`, `progress`, `args`, `enabled`, `visible`.
fn check_fields(object: &Map<String, Value>) -> Result<(), &'static str> {
    for (key, value) in object {
        match key.as_str() {
            "tone" if !value.is_null() && !value.as_str().is_some_and(|tone| TONES.contains(&tone)) => return Err("InvalidShape"),
            "tooltip" if !value.is_null() => match value.as_str() { Some(text) if text.chars().count() <= TOOLTIP_CHARS => {}, Some(_) => return Err("LimitExceeded"), None => return Err("InvalidShape") },
            "progress" if !value.is_null() && !value.as_u64().is_some_and(|progress| progress <= 100) => return Err("InvalidShape"),
            "args" if !value.is_null() && value.to_string().len() > ARGS_BYTES => return Err("LimitExceeded"),
            "enabled" | "visible" if !(value.is_null() || value.is_boolean() || value.is_object()) => return Err("InvalidShape"),
            _ => {}
        }
    }
    Ok(())
}

/// The same validators the manifest goes through, for one definition owned by `owner`.
fn validate(kind: Kind, owner: &str, checks: &Checks, definition: &Value) -> Result<(), String> {
    use crate::extensions::contracts::validate_contract;
    let registration = json!({"extensionId": owner, "version": checks.version, "activationId": "runtime-item"});
    let checked = match kind {
        Kind::Menu => validate_contract("contribution", &json!({"schemaVersion": 1, "owner": registration, "definition": definition})),
        Kind::Command => validate_contract("command", &json!({"schemaVersion": 1, "owner": registration, "definition": definition, "capability": "ui.contribute", "contexts": ["project"], "inputSchema": {"type": "null"}, "outputSchema": {"type": "null"}})),
        Kind::View => validate_contract("view", definition),
        Kind::SlashCommand => validate_contract("slashCommand", definition),
    };
    if checked["ok"] == true { Ok(()) } else { Err(code_of(&checked)) }
}

impl DynamicItems {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, &'static str> { self.inner.lock().map_err(|_| "HostUnavailable") }

    /// A counter that changes whenever any layer changes; the interface reads again when it moves.
    pub fn revision(&self) -> u64 { self.inner.lock().map_or(0, |inner| inner.revision) }
    /// Live items of `owner`.
    pub fn count(&self, owner: &str) -> usize { self.inner.lock().ok().and_then(|inner| inner.layers.get(owner).map(|layer| layer.items.len())).unwrap_or(0) }
    /// Updates waiting for room in the rate window.
    pub fn pending(&self, owner: &str) -> usize { self.inner.lock().ok().and_then(|inner| inner.layers.get(owner).map(|layer| layer.pending.len())).unwrap_or(0) }

    /// `panda.ui.register`: answers `{id}`.
    pub fn register(&self, owner: &str, checks: &Checks, raw: &Value) -> Result<Value, String> {
        if !checks.granted { return Err("PermissionDenied".into()); }
        let object = raw.as_object().ok_or("InvalidShape")?;
        let kind = object.get("kind").and_then(Value::as_str).and_then(Kind::parse).ok_or("InvalidShape")?;
        let id = object.get("id").and_then(Value::as_str).ok_or("InvalidShape")?.to_owned();
        if !owns(owner, &id) { return Err("PermissionDenied".into()); }
        let scope = object.get("scope").map(Scope::parse).transpose()?;
        let mut definition = object.clone();
        definition.remove("kind"); definition.remove("scope");
        check_fields(&definition)?;
        for key in ["enabled", "visible"] { if definition.get(key).is_some_and(Value::is_null) { return Err("InvalidShape".into()); } }
        let definition = Value::Object(definition);
        if checks.manifest["contributes"].as_object().into_iter().flat_map(|all| all.values()).flat_map(|list| list.as_array().into_iter().flatten()).any(|entry| entry["id"] == id.as_str()) { return Err("Conflict".into()); }
        if kind == Kind::Menu {
            // A menu item runs one of the package's own commands: a manifest command or one registered live.
            let command = definition["command"].as_str().unwrap_or_default();
            let live = self.lock()?.layers.get(owner).is_some_and(|layer| layer.items.get(command).is_some_and(|item| item.kind == Kind::Command));
            if !manifest_ids(checks.manifest, "commands").any(|known| known == command) && !live { return Err("UnknownReference".into()); }
        }
        validate(kind, owner, checks, &definition)?;
        if let Some(scope) = &scope { if !(checks.scope_exists)(scope) { return Err("NotFound".into()); } }
        let mut inner = self.lock()?;
        let layer = inner.layers.entry(owner.to_owned()).or_default();
        if layer.items.contains_key(&id) { return Err("Conflict".into()); }
        if layer.items.len() >= MAX_ITEMS { return Err("LimitExceeded".into()); }
        layer.items.insert(id.clone(), Item { kind, declared: definition, scope });
        inner.revision += 1;
        Ok(json!({"id": id}))
    }

    /// `RuntimeItem.update` and `panda.ui.update`: a live item of the owner, or an item of its own manifest.
    pub fn update(&self, owner: &str, checks: &Checks, id: &str, patch: &Value) -> Result<(), String> { self.change(owner, checks, id, patch, false) }
    /// `panda.ui.updateView`: `title`, `text`, `controls` and `toolbar` of a view of the owner.
    pub fn update_view(&self, owner: &str, checks: &Checks, id: &str, patch: &Value) -> Result<(), String> { self.change(owner, checks, id, patch, true) }

    fn change(&self, owner: &str, checks: &Checks, id: &str, patch: &Value, view_only: bool) -> Result<(), String> {
        if !checks.granted { return Err("PermissionDenied".into()); }
        let patch = patch.as_object().ok_or("InvalidShape")?;
        if patch.is_empty() { return Err("InvalidShape".into()); }
        check_fields(patch)?;
        if !owns(owner, id) { return Err("PermissionDenied".into()); }
        let mut inner = self.lock()?;
        let live = inner.layers.get(owner).and_then(|layer| layer.items.get(id)).map(|item| (item.kind, item.declared.clone()));
        // An item of the package's own manifest is changed in the override layer until the service stops.
        let (kind, declared) = match live {
            Some(found) => found,
            None => [("menus", Kind::Menu), ("views", Kind::View)].into_iter().find_map(|(bucket, kind)| checks.manifest["contributes"][bucket].as_array().into_iter().flatten().find(|entry| entry["id"] == id).map(|entry| (kind, entry.clone()))).ok_or("NotFound")?,
        };
        let allowed: &[&str] = if kind == Kind::View { &VIEW_FIELDS } else { &PATCH_FIELDS };
        if (view_only && kind != Kind::View) || !matches!(kind, Kind::Menu | Kind::View) || patch.keys().any(|key| !allowed.contains(&key.as_str())) { return Err("InvalidShape".into()); }
        let layer = inner.layers.entry(owner.to_owned()).or_default();
        // The rate bound: past 20 applied updates in a second the latest value of each field waits for room.
        while layer.window.front().is_some_and(|at| checks.now_ms.saturating_sub(*at) >= 1000) { layer.window.pop_front(); }
        if layer.window.len() >= MAX_UPDATES_PER_SECOND {
            let waiting = layer.pending.entry(id.to_owned()).or_default();
            for (key, value) in patch { waiting.insert(key.clone(), value.clone()); }
            return Ok(());
        }
        // The merged result must still be a valid definition, as a manifest entry would be.
        let mut overrides = layer.overrides.get(id).cloned().unwrap_or_default();
        Self::fold(&mut overrides, patch);
        validate(kind, owner, checks, &effective(&declared, Some(&overrides)))?;
        layer.window.push_back(checks.now_ms);
        layer.overrides.insert(id.to_owned(), overrides);
        inner.revision += 1;
        Ok(())
    }
    /// `enabled` / `visible` set to `null` remove their override; every other field keeps `null` as "cleared".
    fn fold(overrides: &mut Map<String, Value>, patch: &Map<String, Value>) {
        for (key, value) in patch { if value.is_null() && ["enabled", "visible"].contains(&key.as_str()) { overrides.remove(key); } else { overrides.insert(key.clone(), value.clone()); } }
    }

    /// Applies the updates that waited for room in the rate window. Answers `true` when something changed.
    pub fn tick(&self, owner: &str, checks: &Checks) -> bool {
        let Ok(mut inner) = self.lock() else { return false };
        let mut changed = false;
        let Some(layer) = inner.layers.get_mut(owner) else { return false };
        while layer.window.front().is_some_and(|at| checks.now_ms.saturating_sub(*at) >= 1000) { layer.window.pop_front(); }
        while layer.window.len() < MAX_UPDATES_PER_SECOND {
            let Some(id) = layer.pending.keys().next().cloned() else { break };
            let patch = layer.pending.remove(&id).unwrap_or_default();
            let target = layer.items.get(&id).map(|item| (item.kind, item.declared.clone()))
                .or_else(|| ["menus", "views"].into_iter().find_map(|bucket| checks.manifest["contributes"][bucket].as_array().into_iter().flatten().find(|entry| entry["id"] == id.as_str()).map(|entry| (if bucket == "views" { Kind::View } else { Kind::Menu }, entry.clone()))));
            let Some((kind, declared)) = target else { continue };
            let mut overrides = layer.overrides.get(&id).cloned().unwrap_or_default();
            Self::fold(&mut overrides, &patch);
            if validate(kind, owner, checks, &effective(&declared, Some(&overrides))).is_err() { continue; }
            layer.window.push_back(checks.now_ms);
            layer.overrides.insert(id, overrides);
            changed = true;
        }
        if changed { inner.revision += 1; }
        changed
    }

    /// `RuntimeItem.dispose`: a handle that is gone answers `NotFound`, never a second success.
    pub fn dispose(&self, owner: &str, checks: &Checks, id: &str) -> Result<(), String> {
        if !checks.granted { return Err("PermissionDenied".into()); }
        if !owns(owner, id) { return Err("PermissionDenied".into()); }
        let mut inner = self.lock()?;
        let layer = inner.layers.get_mut(owner).ok_or("NotFound")?;
        layer.items.remove(id).ok_or("NotFound")?;
        layer.overrides.remove(id); layer.pending.remove(id);
        inner.revision += 1;
        Ok(())
    }

    /// The service stopped (disable, uninstall, update, trust loss, safe mode, crash): every item and override goes and
    /// the manifest values return.
    pub fn clear(&self, owner: &str) {
        if let Ok(mut inner) = self.inner.lock() { if inner.layers.remove(owner).is_some() { inner.revision += 1; } }
    }
    /// A task or project is gone: the items bound to it go with it. Answers how many were removed.
    pub fn forget_scope(&self, gone: &Scope) -> usize {
        let Ok(mut inner) = self.inner.lock() else { return 0 };
        let mut removed = 0;
        for layer in inner.layers.values_mut() {
            let ids: Vec<String> = layer.items.iter().filter(|(_, item)| item.scope.as_ref() == Some(gone)).map(|(id, _)| id.clone()).collect();
            for id in ids { layer.items.remove(&id); layer.overrides.remove(&id); layer.pending.remove(&id); removed += 1; }
        }
        if removed > 0 { inner.revision += 1; }
        removed
    }

    /// What the interface merges: per owner `{menus, commands, views, slashCommands, overrides}` with each live item's
    /// effective definition and its `scope`; `overrides` holds the changes to the owner's own manifest items.
    pub fn snapshot(&self) -> Value {
        let Ok(inner) = self.inner.lock() else { return json!({"revision": 0, "owners": {}}) };
        let mut owners = Map::new();
        for (owner, layer) in &inner.layers {
            let mut entry = json!({"menus": [], "commands": [], "views": [], "slashCommands": [], "overrides": {}});
            for (id, item) in &layer.items {
                let mut definition = effective(&item.declared, layer.overrides.get(id));
                if let (Some(scope), Some(object)) = (&item.scope, definition.as_object_mut()) { object.insert("scope".into(), scope.to_json()); }
                if let Some(list) = entry[item.kind.bucket()].as_array_mut() { list.push(definition); }
            }
            for (id, overrides) in &layer.overrides { if !layer.items.contains_key(id) { entry["overrides"][id] = Value::Object(overrides.clone()); } }
            owners.insert(owner.clone(), entry);
        }
        json!({"revision": inner.revision, "owners": owners})
    }
}

/// A `ui` request of a service: `{op: register | update | updateView | dispose, ...}`. Answers the broker envelope.
pub fn serve(items: &DynamicItems, owner: &str, checks: &Checks, params: &Value) -> Value {
    let id = params["id"].as_str().unwrap_or_default();
    let result = match params["op"].as_str() {
        Some("register") => items.register(owner, checks, &params["item"]),
        Some("update") => items.update(owner, checks, id, &params["patch"]).map(|()| Value::Null),
        Some("updateView") => items.update_view(owner, checks, id, &params["patch"]).map(|()| Value::Null),
        Some("dispose") => items.dispose(owner, checks, id).map(|()| Value::Null),
        _ => Err("InvalidShape".into()),
    };
    match result { Ok(value) => ok(value), Err(code) => failure(&code) }
}

/// Unix milliseconds now.
pub fn now_millis() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64) }

/// The app's one set of layers, managed as Tauri state.
pub fn state(app: &tauri::AppHandle) -> Option<tauri::State<'_, DynamicItems>> { use tauri::Manager; app.try_state::<DynamicItems>() }

/// Serves a `ui` request of the service of `request.owner`, against the installed manifest, the live grant and the
/// store (a scope names a task or project that exists).
pub fn serve_app(app: &tauri::AppHandle, owner: &str, params: &Value) -> Value {
    use tauri::Manager;
    let Some(items) = state(app) else { return failure("UnsupportedCapability") };
    let packages = app.state::<crate::extensions::packages::ExtensionPackages>();
    let Ok(packages) = packages.0.try_lock() else { return failure("Timeout") };
    let snapshot = serde_json::to_value(packages.snapshot()).unwrap_or(Value::Null);
    let Some(package) = snapshot["packages"].as_array().into_iter().flatten().find(|package| package["manifest"]["id"] == owner && package["enabled"] == true) else { return failure("NotFound") };
    let (manifest, version) = (&package["manifest"], package["manifest"]["version"].as_str().unwrap_or_default());
    let granted = app.try_state::<crate::extensions::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(owner, version, PERMISSION, &crate::extensions::runtime_grants::Target::default()).is_ok());
    // R1001: an item put in the composer band needs `ui.presentation` as well, rechecked here on every registration.
    if params["op"] == "register" {
        let holds = app.try_state::<crate::extensions::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(owner, version, crate::extensions::runtime_composer_band::PERMISSION, &crate::extensions::runtime_grants::Target::default()).is_ok());
        if let Err(code) = crate::extensions::runtime_composer_band::gate(&params["item"], holds) { return failure(code); }
    }
    let scope_exists = |scope: &Scope| {
        let Some(state) = app.try_state::<crate::AppState>() else { return false };
        let Ok(store) = state.store.try_lock() else { return false };
        match scope { Scope::Task(id) => store.session(id).is_ok(), Scope::Project(id) => store.project(id).is_ok() }
    };
    let checks = Checks { granted, manifest, scope_exists: &scope_exists, version, now_ms: now_millis() };
    let reply = serve(&items, owner, &checks, params);
    if reply["ok"] == true { changed(app); }
    if items.pending(owner) > 0 {
        // Updates over the rate wait for room in the window; the next second applies the latest values.
        let (app, owner) = (app.clone(), owner.to_owned());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
            flush_app(&app, &owner);
        });
    }
    reply
}
fn flush_app(app: &tauri::AppHandle, owner: &str) {
    use tauri::Manager;
    let Some(items) = state(app) else { return };
    let packages = app.state::<crate::extensions::packages::ExtensionPackages>();
    let Ok(packages) = packages.0.try_lock() else { return };
    let snapshot = serde_json::to_value(packages.snapshot()).unwrap_or(Value::Null);
    let Some(package) = snapshot["packages"].as_array().into_iter().flatten().find(|package| package["manifest"]["id"] == owner) else { return };
    let (manifest, version) = (&package["manifest"], package["manifest"]["version"].as_str().unwrap_or_default());
    let checks = Checks { granted: true, manifest, scope_exists: &|_| true, version, now_ms: now_millis() };
    if items.tick(owner, &checks) { changed(app); }
    if items.pending(owner) > 0 {
        let (app, owner) = (app.clone(), owner.to_owned());
        tauri::async_runtime::spawn(async move { tokio::time::sleep(std::time::Duration::from_millis(1100)).await; flush_app(&app, &owner); });
    }
}

/// Tells every window the layer moved; they read it again with `extensions_runtime_items`.
pub fn changed(app: &tauri::AppHandle) { use tauri::Emitter; let _ = app.emit("extensions-runtime-items", state(app).map_or(0, |items| items.revision())); }

/// The service of `owner` stopped: its items go and the windows are told.
pub fn service_stopped(app: &tauri::AppHandle, owner: &str) {
    if let Some(items) = state(app) { items.clear(owner); }
    changed(app);
}
/// A task (or project) is gone: its scoped items go.
pub fn scope_gone(app: &tauri::AppHandle, scope: &Scope) {
    if state(app).is_some_and(|items| items.forget_scope(scope) > 0) { changed(app); }
}

/// The interface reads the whole layer: items, scopes and overrides of every owner whose service runs.
#[tauri::command]
pub fn extensions_runtime_items(app: tauri::AppHandle) -> Value {
    let mut layer = state(&app).map_or_else(|| json!({"revision": 0, "owners": {}}), |items| items.snapshot());
    strip_band(&app, &mut layer);
    layer
}

/// R1001: the band items of an owner that no longer holds `ui.presentation` leave the layer the interface reads, so a revoke
/// takes the band away at once without touching the composer or a running task.
fn strip_band(app: &tauri::AppHandle, layer: &mut Value) {
    use tauri::Manager;
    let Some(grants) = app.try_state::<crate::extensions::runtime_grants::RuntimeGrants>() else { return };
    let packages = app.state::<crate::extensions::packages::ExtensionPackages>();
    let Ok(packages) = packages.0.try_lock() else { return };
    let snapshot = serde_json::to_value(packages.snapshot()).unwrap_or(Value::Null);
    let holds = |owner: &str| {
        let version = snapshot["packages"].as_array().into_iter().flatten().find(|package| package["manifest"]["id"] == owner).and_then(|package| package["manifest"]["version"].as_str().map(str::to_owned));
        version.is_some_and(|version| grants.check(owner, &version, crate::extensions::runtime_composer_band::PERMISSION, &crate::extensions::runtime_grants::Target::default()).is_ok())
    };
    crate::extensions::runtime_composer_band::strip_ungranted(layer, &holds);
}

#[cfg(test)]
mod tests {
    use super::*;
    const OWNER: &str = "sample.dynamic-items";

    fn manifest() -> Value {
        json!({"id": OWNER, "version": "1.0.0", "contributes": {
            "commands": [{"id": "sample.dynamic-items/open", "title": "Open", "action": {"kind": "runCommand"}}],
            "menus": [{"id": "sample.dynamic-items/status", "location": "panda.status.items", "command": "sample.dynamic-items/open", "presentation": "status", "text": "idle"}],
            "views": [{"id": "sample.dynamic-items/board", "title": "Board", "text": "empty"}],
        }})
    }
    fn checks<'a>(manifest: &'a Value, scope_exists: &'a dyn Fn(&Scope) -> bool, now_ms: u64) -> Checks<'a> { Checks { granted: true, manifest, scope_exists, version: "1.0.0", now_ms } }
    fn menu(id: &str) -> Value { json!({"kind": "menu", "id": id, "location": "panda.status.items", "command": "sample.dynamic-items/open", "presentation": "status", "text": "3 builds failed"}) }
    fn code(result: Result<impl std::fmt::Debug, String>) -> String { result.unwrap_err() }

    #[test]
    fn register_update_dispose_and_the_stale_handle() {
        let (manifest, items) = (manifest(), DynamicItems::default());
        let exists = |_: &Scope| true;
        let checks = checks(&manifest, &exists, 1);
        assert_eq!(items.register(OWNER, &checks, &menu("sample.dynamic-items/alert")).unwrap(), json!({"id": "sample.dynamic-items/alert"}));
        assert_eq!(items.count(OWNER), 1);
        items.update(OWNER, &checks, "sample.dynamic-items/alert", &json!({"text": "4 builds failed", "badge": "4", "tone": "danger", "tooltip": "line 1\nline 2", "progress": 40, "enabled": false})).unwrap();
        let snapshot = items.snapshot();
        let live = &snapshot["owners"][OWNER]["menus"][0];
        assert_eq!((live["text"].as_str(), live["badge"].as_str(), live["tone"].as_str(), live["progress"].as_u64(), live["enabled"].as_bool()), (Some("4 builds failed"), Some("4"), Some("danger"), Some(40), Some(false)));
        // `null` takes the override off the condition; the declared one (none) applies again.
        items.update(OWNER, &checks, "sample.dynamic-items/alert", &json!({"enabled": null})).unwrap();
        assert!(items.snapshot()["owners"][OWNER]["menus"][0].get("enabled").is_none());
        items.dispose(OWNER, &checks, "sample.dynamic-items/alert").unwrap();
        // A disposed handle is stale: update and a second dispose answer NotFound, never a success.
        assert_eq!(code(items.update(OWNER, &checks, "sample.dynamic-items/alert", &json!({"text": "x"}))), "NotFound");
        assert_eq!(code(items.dispose(OWNER, &checks, "sample.dynamic-items/alert")), "NotFound");
        assert_eq!(items.count(OWNER), 0);
    }

    #[test]
    fn refusals_name_their_reason() {
        let (manifest, items) = (manifest(), DynamicItems::default());
        let exists = |_: &Scope| true;
        let checks = checks(&manifest, &exists, 1);
        // Foreign owner: another package's prefix is refused (the package may only name its own items).
        assert_eq!(code(items.register(OWNER, &checks, &menu("sample.other/alert"))), "PermissionDenied");
        // A manifest id and a live id are taken (an id names one thing).
        assert_eq!(code(items.register(OWNER, &checks, &menu("sample.dynamic-items/status"))), "Conflict");
        items.register(OWNER, &checks, &menu("sample.dynamic-items/a")).unwrap();
        assert_eq!(code(items.register(OWNER, &checks, &menu("sample.dynamic-items/a"))), "Conflict");
        // The command a menu item runs must exist; the location must be a public one.
        let mut unknown = menu("sample.dynamic-items/b"); unknown["command"] = json!("sample.dynamic-items/ghost");
        assert_eq!(code(items.register(OWNER, &checks, &unknown)), "UnknownReference");
        let mut elsewhere = menu("sample.dynamic-items/c"); elsewhere["location"] = json!("panda.nowhere");
        assert_eq!(code(items.register(OWNER, &checks, &elsewhere)), "InvalidShape");
        // Field shapes: tone is one of five, tooltip up to 1,024 characters, progress 0 to 100, args up to 4 KiB.
        for (patch, expected) in [(json!({"tone": "rainbow"}), "InvalidShape"), (json!({"tooltip": "x".repeat(1025)}), "LimitExceeded"), (json!({"progress": 101}), "InvalidShape"), (json!({"args": {"blob": "x".repeat(4100)}}), "LimitExceeded"),
            (json!({"id": "sample.dynamic-items/z"}), "InvalidShape"), (json!({"location": "panda.status.items"}), "InvalidShape"), (json!({"command": "sample.dynamic-items/open"}), "InvalidShape"), (json!({"kind": "menu"}), "InvalidShape"), (json!({}), "InvalidShape")] {
            assert_eq!(code(items.update(OWNER, &checks, "sample.dynamic-items/a", &patch)), expected, "{patch}");
        }
        // No grant: nothing is registered, updated or disposed.
        let denied = Checks { granted: false, ..checks };
        assert_eq!(code(items.register(OWNER, &denied, &menu("sample.dynamic-items/d"))), "PermissionDenied");
        assert_eq!(code(items.update(OWNER, &denied, "sample.dynamic-items/a", &json!({"text": "x"}))), "PermissionDenied");
        assert_eq!(code(items.dispose(OWNER, &denied, "sample.dynamic-items/a")), "PermissionDenied");
        // An update of a manifest item of another package is foreign; an unknown one of this package is NotFound.
        assert_eq!(code(items.update(OWNER, &checks, "sample.other/status", &json!({"text": "x"}))), "PermissionDenied");
        assert_eq!(code(items.update(OWNER, &checks, "sample.dynamic-items/ghost", &json!({"text": "x"}))), "NotFound");
    }

    #[test]
    fn a_manifest_item_changes_in_the_layer_and_comes_back_when_the_service_stops() {
        let (manifest, items) = (manifest(), DynamicItems::default());
        let exists = |_: &Scope| true;
        let checks = checks(&manifest, &exists, 1);
        items.update(OWNER, &checks, "sample.dynamic-items/status", &json!({"tone": "danger", "text": "failing"})).unwrap();
        items.update_view(OWNER, &checks, "sample.dynamic-items/board", &json!({"text": "3 rows", "controls": [{"kind": "table", "label": "Tables", "columns": ["name"], "rows": [["tracks"]]}]})).unwrap();
        assert_eq!(items.snapshot()["owners"][OWNER]["overrides"]["sample.dynamic-items/status"]["tone"], "danger");
        assert_eq!(items.snapshot()["owners"][OWNER]["overrides"]["sample.dynamic-items/board"]["text"], "3 rows");
        // `updateView` reaches only views; `update` may not rewrite what a view says about itself through menus.
        items.register(OWNER, &checks, &menu("sample.dynamic-items/m")).unwrap();
        assert_eq!(code(items.update_view(OWNER, &checks, "sample.dynamic-items/m", &json!({"text": "x"}))), "InvalidShape");
        items.clear(OWNER);
        assert_eq!(items.snapshot()["owners"], json!({}));
        assert_eq!(items.count(OWNER), 0);
    }

    #[test]
    fn a_scope_must_exist_and_goes_with_its_task_or_project() {
        let (manifest, items) = (manifest(), DynamicItems::default());
        let known = |scope: &Scope| matches!(scope, Scope::Task(id) if id == "t1") || matches!(scope, Scope::Project(id) if id == "A");
        let checks = checks(&manifest, &known, 1);
        let mark = |id: &str, scope: Value| { let mut item = json!({"kind": "menu", "id": id, "location": "panda.sidebar.task.marks", "command": "sample.dynamic-items/open", "presentation": "badge", "badge": "2"}); item["scope"] = scope; item };
        items.register(OWNER, &checks, &mark("sample.dynamic-items/m1", json!({"taskId": "t1"}))).unwrap();
        items.register(OWNER, &checks, &mark("sample.dynamic-items/m2", json!({"projectId": "A"}))).unwrap();
        assert_eq!(code(items.register(OWNER, &checks, &mark("sample.dynamic-items/m3", json!({"taskId": "ghost"})))), "NotFound");
        assert_eq!(code(items.register(OWNER, &checks, &mark("sample.dynamic-items/m4", json!({"taskId": "t1", "projectId": "A"})))), "InvalidShape");
        assert_eq!(items.snapshot()["owners"][OWNER]["menus"][0]["scope"], json!({"taskId": "t1"}));
        // The task is deleted: only the item bound to it goes.
        assert_eq!(items.forget_scope(&Scope::Task("t1".into())), 1);
        assert_eq!(items.count(OWNER), 1);
        assert_eq!(items.forget_scope(&Scope::Project("B".into())), 0);
        assert_eq!(items.forget_scope(&Scope::Project("A".into())), 1);
    }

    #[test]
    fn at_most_128_items_and_20_updates_a_second() {
        let (manifest, items) = (manifest(), DynamicItems::default());
        let exists = |_: &Scope| true;
        let first = checks(&manifest, &exists, 1000);
        for index in 0..MAX_ITEMS { items.register(OWNER, &first, &menu(&format!("sample.dynamic-items/i{index}"))).unwrap(); }
        assert_eq!(code(items.register(OWNER, &first, &menu("sample.dynamic-items/over"))), "LimitExceeded");
        // A disposed slot is free again.
        items.dispose(OWNER, &first, "sample.dynamic-items/i0").unwrap();
        items.register(OWNER, &first, &menu("sample.dynamic-items/over")).unwrap();
        // 20 updates in one second apply; the 21st and later wait with the latest value of each field winning.
        for count in 0..MAX_UPDATES_PER_SECOND { items.update(OWNER, &first, "sample.dynamic-items/i1", &json!({"badge": format!("{count}")})).unwrap(); }
        let before = items.revision();
        items.update(OWNER, &first, "sample.dynamic-items/i1", &json!({"badge": "late-1"})).unwrap();
        items.update(OWNER, &first, "sample.dynamic-items/i1", &json!({"badge": "late-2", "tone": "info"})).unwrap();
        assert_eq!((items.revision(), items.pending(OWNER)), (before, 1));
        let menus = |items: &DynamicItems| items.snapshot()["owners"][OWNER]["menus"].as_array().unwrap().iter().find(|menu| menu["id"] == "sample.dynamic-items/i1").cloned().unwrap();
        assert_eq!(menus(&items)["badge"], "19");
        // Half a second later the window is still full; a second later the waiting values apply.
        assert!(!items.tick(OWNER, &checks(&manifest, &exists, 1500)));
        assert!(items.tick(OWNER, &checks(&manifest, &exists, 2001)));
        assert_eq!((menus(&items)["badge"].as_str(), menus(&items)["tone"].as_str(), items.pending(OWNER)), (Some("late-2"), Some("info"), 0));
    }

    #[test]
    fn serve_answers_the_broker_envelope() {
        let (manifest, items) = (manifest(), DynamicItems::default());
        let exists = |_: &Scope| true;
        let checks = checks(&manifest, &exists, 1);
        assert_eq!(serve(&items, OWNER, &checks, &json!({"op": "register", "item": menu("sample.dynamic-items/s")})), json!({"ok": true, "value": {"id": "sample.dynamic-items/s"}}));
        assert_eq!(serve(&items, OWNER, &checks, &json!({"op": "update", "id": "sample.dynamic-items/s", "patch": {"text": "y"}})), json!({"ok": true, "value": null}));
        assert_eq!(serve(&items, OWNER, &checks, &json!({"op": "dispose", "id": "sample.dynamic-items/s"})), json!({"ok": true, "value": null}));
        assert_eq!(serve(&items, OWNER, &checks, &json!({"op": "dispose", "id": "sample.dynamic-items/s"}))["error"]["code"], "NotFound");
        assert_eq!(serve(&items, OWNER, &checks, &json!({"op": "explode"}))["error"]["code"], "InvalidShape");
    }
}
