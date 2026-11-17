//! Recipes and wake-ups for background services (`workspace.recipes`, `workspace.wakeups`, runtime phase R4, slice R0406B).
//!
//! A trusted service manages the app's workflow recipes and its wake-ups (task schedules) with
//! `panda.workspace.recipes.list`, `save`, `remove`, `run` and `panda.workspace.wakeups.list`, `create`, `update`,
//! `remove`. Each call is a thin adapter over the native operation the interface already uses, with its input as that
//! operation takes it, in camelCase:
//!
//! | Call | Native operation |
//! |---|---|
//! | `recipes.list({projectId?})` | `recipes_list` (`recipes::list_dir` of the project and of the global folder) |
//! | `recipes.save({scope, projectId?, name, description?, steps})` | `recipes_save` (`recipes::save`, which validates) |
//! | `recipes.remove(recipeId)` | `recipes_delete` (`recipes::delete`) |
//! | `recipes.run(recipeId, {taskId})` | `recipes_dry_run` of the task's harness and slash commands, then `queue_add` of each message, as the Run button does |
//! | `wakeups.list({taskId?})` | `schedules_list` |
//! | `wakeups.create(input)` | `schedule_create` (`ScheduleInput`: `sessionId`, `title`, `prompt`, `kind`, `intervalMinutes`, `timeOfDay`, `days`, `runAt`, `watchSessionId`, `onlyOnSuccess`, `maxRuns`, `workflowId`, `chainFromId`) |
//! | `wakeups.update(wakeupId, input)` | `schedule_update` |
//! | `wakeups.remove(wakeupId)` | `schedule_delete` |
//!
//! A recipe id is `global:<name>` or `project:<projectId>:<name>`; a wake-up id is the schedule's id. There is no
//! `wakeups.run`: a wake-up fires on its own cadence, and a one-off message to a task is `tasks.message` (R0402).
//!
//! One permission, `workspace.manage` (project scoped), is rechecked natively on every request and once more right
//! before each write (under the store's lock for wake-ups, between messages for a recipe run), so a revoke or a
//! narrowing in between stops the work. A project recipe or wake-up is checked against its project (a wake-up that
//! watches another task, or moves to another task, against both projects); a global recipe against an unscoped grant.
//! A package that holds it is never asked per action (ADR-0005), with one exception that is not about trust:
//! `recipes.remove` and `wakeups.remove` are irreversible, so the host asks the user first by default, showing what will
//! be removed and which package asks. The user turns that off per package (`FamilyConsents`, `preferences.confirmDeletions`);
//! a refusal answers `Cancelled`.
//!
//! Refusals (the grant always answers first, so nothing about a task or project is revealed without it): an unknown
//! project, task, recipe or wake-up is `NotFound`; a shape the call does not take is `InvalidShape`; a size or count bound
//! `LimitExceeded`; a recipe whose steps the task's harness cannot run (a blocked step) is `UnsupportedCapability` with
//! the step numbers in `ids`, and nothing is queued in its place. The bounds are for predictability and fault isolation.
//!
//! Attribution (file-backed, independent of SQLite): every recipe and wake-up a package saved or created carries its name
//! (`workspace-schedule-origins.json`, read by the window through `extensions_workspace_origins`); every message a recipe
//! run queues carries it as a queue chip and the thread shows one labelled line. Pairing a machine, signing in to the
//! cloud and approving access stay with the user: nothing here reaches them, and no call hands out a credential.
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, path::{Path, PathBuf}, sync::Mutex};

/// The named permission (project scoped, granted with the trust decision, rechecked on every request).
pub const PERMISSION: &str = "workspace.manage";
pub const SCHEMA_VERSION: u64 = 1;
/// Recipes and wake-ups a list answers.
pub const MAX_LIST: usize = 1024;
/// Entries of the attribution ledger.
pub const MAX_ORIGINS: usize = 4096;
/// The input fields of a wake-up (the native `ScheduleInput`, camelCase).
pub const WAKEUP_FIELDS: [&str; 13] = [
    "sessionId", "title", "prompt", "kind", "intervalMinutes", "timeOfDay", "days", "runAt", "watchSessionId", "onlyOnSuccess", "maxRuns", "workflowId", "chainFromId",
];
const STEP_FIELDS: [&str; 4] = ["kind", "text", "command", "requires"];
const RECIPE_FIELDS: [&str; 5] = ["scope", "projectId", "name", "description", "steps"];
const MAX_STEPS_SEEN: usize = 1000;

// ---- Refusals ------------------------------------------------------------------------------------------------------

/// A refusal in the broker envelope: `code`, the `path` it names and the `ids` it carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal { pub code: String, pub path: String, pub ids: Vec<String> }
impl Refusal {
    pub fn new(code: &str) -> Self { Self { code: code.to_owned(), path: "$".into(), ids: vec![] } }
    pub fn at(code: &str, path: &str) -> Self { Self { code: code.to_owned(), path: path.chars().filter(|c| !c.is_control()).take(128).collect(), ids: vec![] } }
    pub fn with_ids(mut self, ids: Vec<String>) -> Self { self.ids = ids; self }
    pub fn envelope(&self) -> Value { json!({"ok": false, "error": {"schemaVersion": 1, "code": self.code, "path": self.path, "ids": self.ids}}) }
}
pub fn denied() -> Refusal { Refusal::at("PermissionDenied", PERMISSION) }
fn ok(value: Value) -> Value { json!({"ok": true, "value": value}) }

/// The refusal code of a native operation's message (the interface shows the text; a service gets the code).
pub fn code_of_text(error: &str) -> &'static str {
    let error = error.to_lowercase();
    if error.contains("no longer exists") || error.contains("not found") || error.contains("does not exist") { "NotFound" }
    else if error.contains("unknown harness") { "UnsupportedCapability" }
    else if error.contains("too ") || error.contains("under ") || error.contains(" 1 to ") || error.contains("max runs") { "LimitExceeded" }
    else { "InvalidShape" }
}
/// A code a native helper answered as a bare word (`Cancelled`, `PermissionDenied`, ...), kept only when it looks like one.
fn wire(code: &str) -> &str { if !code.is_empty() && code.len() <= 64 && code.chars().next().is_some_and(|c| c.is_ascii_uppercase()) && code.chars().all(|c| c.is_ascii_alphabetic()) { code } else { "HostUnavailable" } }

// ---- Shapes --------------------------------------------------------------------------------------------------------

fn ident(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control) }
fn exact(params: &Value, allowed: &[&str]) -> Result<(), Refusal> {
    let map = params.as_object().ok_or_else(|| Refusal::new("InvalidShape"))?;
    match map.keys().find(|key| !allowed.contains(&key.as_str())) { Some(key) => Err(Refusal::at("InvalidShape", key)), None => Ok(()) }
}
fn required_ident(params: &Value, key: &str) -> Result<String, Refusal> {
    params.get(key).and_then(Value::as_str).filter(|text| ident(text)).map(str::to_owned).ok_or_else(|| Refusal::at("InvalidShape", key))
}
/// `refusal` as seen from inside `prefix` (`recipe`, `input`, `options`): the path names the field in the caller's own shape.
fn nested(prefix: &str, refusal: Refusal) -> Refusal {
    if refusal.path == "$" { Refusal::at(&refusal.code, prefix) } else { Refusal::at(&refusal.code, &format!("{prefix}.{}", refusal.path)) }
}
fn optional_ident(params: &Value, key: &str) -> Result<Option<String>, Refusal> {
    match params.get(key) { None | Some(Value::Null) => Ok(None), Some(Value::String(text)) if ident(text) => Ok(Some(text.clone())), _ => Err(Refusal::at("InvalidShape", key)) }
}

/// Where a recipe lives.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecipeScope { Global, Project(String) }
impl RecipeScope {
    pub fn project(&self) -> Option<&str> { match self { RecipeScope::Global => None, RecipeScope::Project(id) => Some(id) } }
    pub fn name(&self) -> &'static str { match self { RecipeScope::Global => "global", RecipeScope::Project(_) => "project" } }
}
/// `global:<name>` or `project:<projectId>:<name>`.
pub fn recipe_id(scope: &RecipeScope, name: &str) -> String {
    match scope { RecipeScope::Global => format!("global:{name}"), RecipeScope::Project(project) => format!("project:{project}:{name}") }
}
/// The scope and name a recipe id names (a malformed id is `InvalidShape`; whether it exists is `NotFound`, later).
pub fn parse_recipe_id(id: &str) -> Result<(RecipeScope, String), Refusal> {
    let bad = || Refusal::at("InvalidShape", "recipeId");
    if let Some(name) = id.strip_prefix("global:") {
        return if crate::recipes::valid_name(name) { Ok((RecipeScope::Global, name.to_owned())) } else { Err(bad()) };
    }
    let rest = id.strip_prefix("project:").ok_or_else(bad)?;
    let (project, name) = rest.rsplit_once(':').ok_or_else(bad)?;
    if ident(project) && crate::recipes::valid_name(name) { Ok((RecipeScope::Project(project.to_owned()), name.to_owned())) } else { Err(bad()) }
}

/// A recipe save: where it goes and the recipe, validated as the interface validates it.
pub fn admit_recipe_save(raw: &Value) -> Result<(RecipeScope, crate::recipes::Recipe), Refusal> {
    exact(raw, &RECIPE_FIELDS).map_err(|refusal| nested("recipe", refusal))?;
    let scope = match raw.get("scope").and_then(Value::as_str) {
        Some("global") => { if raw.get("projectId").is_some_and(|id| !id.is_null()) { return Err(Refusal::at("InvalidShape", "recipe.projectId")); } RecipeScope::Global }
        Some("project") => RecipeScope::Project(required_ident(raw, "projectId").map_err(|_| Refusal::at("InvalidShape", "recipe.projectId"))?),
        _ => return Err(Refusal::at("InvalidShape", "recipe.scope")),
    };
    let name = raw.get("name").and_then(Value::as_str).ok_or_else(|| Refusal::at("InvalidShape", "recipe.name"))?.to_owned();
    let description = match raw.get("description") { None | Some(Value::Null) => String::new(), Some(Value::String(text)) => text.clone(), _ => return Err(Refusal::at("InvalidShape", "recipe.description")) };
    let steps = raw.get("steps").and_then(Value::as_array).ok_or_else(|| Refusal::at("InvalidShape", "recipe.steps"))?;
    if steps.len() > MAX_STEPS_SEEN { return Err(Refusal::at("LimitExceeded", "recipe.steps")); }
    let mut parsed = Vec::with_capacity(steps.len());
    for (index, step) in steps.iter().enumerate() {
        exact(step, &STEP_FIELDS).map_err(|_| Refusal::at("InvalidShape", &format!("recipe.steps[{index}]")))?;
        parsed.push(serde_json::from_value::<crate::recipes::Step>(step.clone()).map_err(|_| Refusal::at("InvalidShape", &format!("recipe.steps[{index}]")))?);
    }
    let recipe = crate::recipes::Recipe { name, description, steps: parsed, scope: String::new() };
    crate::recipes::validate(&recipe).map_err(|error| Refusal::at(code_of_text(&error), "recipe"))?;
    Ok((scope, recipe))
}

/// A wake-up input, as `ScheduleInput` takes it. The task and the cadence are checked natively when it is written.
pub fn admit_wakeup(raw: &Value) -> Result<crate::schedules::ScheduleInput, Refusal> {
    exact(raw, &WAKEUP_FIELDS).map_err(|refusal| nested("input", refusal))?;
    required_ident(raw, "sessionId").map_err(|_| Refusal::at("InvalidShape", "input.sessionId"))?;
    serde_json::from_value::<crate::schedules::ScheduleInput>(raw.clone()).map_err(|_| Refusal::at("InvalidShape", "input"))
}

/// One recipe as a service reads it.
pub fn recipe_view(scope: &RecipeScope, recipe: &crate::recipes::Recipe, by: Option<&Origin>) -> Value {
    json!({
        "id": recipe_id(scope, &recipe.name), "scope": scope.name(), "projectId": scope.project(), "name": recipe.name, "description": recipe.description,
        "steps": serde_json::to_value(&recipe.steps).unwrap_or_else(|_| json!([])), "by": by.map(|origin| origin.package.clone()),
    })
}

// ---- Attribution ---------------------------------------------------------------------------------------------------

/// Who saved a recipe or created a wake-up: the package id and the name it showed, kept after the package is gone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin { pub owner: String, pub package: String, pub at: u64 }

/// The attribution ledger, persisted next to the grants (file-backed, independent of SQLite). Keys are `recipe:<id>` and `wakeup:<id>`.
pub struct Origins { inner: Mutex<BTreeMap<String, Origin>>, file: Option<PathBuf> }
impl Default for Origins { fn default() -> Self { Self { inner: Mutex::new(BTreeMap::new()), file: None } } }
impl Origins {
    /// Opens (or starts) the ledger in `dir`; an unreadable file starts empty and is replaced on the next change.
    pub fn open(dir: &Path) -> Self {
        let file = dir.join("workspace-schedule-origins.json");
        let mut entries = BTreeMap::new();
        if let Some(root) = std::fs::read_to_string(&file).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()) {
            for (key, row) in root["entries"].as_object().into_iter().flatten().take(MAX_ORIGINS) {
                if let (Some(owner), Some(package)) = (row["owner"].as_str(), row["package"].as_str()) {
                    entries.insert(key.clone(), Origin { owner: owner.to_owned(), package: package.to_owned(), at: row["at"].as_u64().unwrap_or(0) });
                }
            }
        }
        Self { inner: Mutex::new(entries), file: Some(file) }
    }
    fn save(&self, entries: &BTreeMap<String, Origin>) {
        let Some(file) = &self.file else { return };
        let rows: Map<String, Value> = entries.iter().map(|(key, origin)| (key.clone(), json!({"owner": origin.owner, "package": origin.package, "at": origin.at}))).collect();
        let temporary = file.with_extension("json.tmp");
        if std::fs::write(&temporary, json!({"schemaVersion": SCHEMA_VERSION, "entries": rows}).to_string()).is_ok() { let _ = std::fs::rename(&temporary, file); }
    }
    pub fn record(&self, key: &str, origin: Origin) {
        let Ok(mut entries) = self.inner.lock() else { return };
        entries.insert(key.to_owned(), origin);
        while entries.len() > MAX_ORIGINS {
            let Some(oldest) = entries.iter().min_by_key(|(_, origin)| origin.at).map(|(key, _)| key.clone()) else { break };
            entries.remove(&oldest);
        }
        self.save(&entries);
    }
    pub fn forget(&self, key: &str) -> bool {
        let Ok(mut entries) = self.inner.lock() else { return false };
        let removed = entries.remove(key).is_some();
        if removed { self.save(&entries); }
        removed
    }
    pub fn get(&self, key: &str) -> Option<Origin> { self.inner.lock().ok().and_then(|entries| entries.get(key).cloned()) }
    pub fn len(&self) -> usize { self.inner.lock().map_or(0, |entries| entries.len()) }
    pub fn is_empty(&self) -> bool { self.len() == 0 }
    /// What the window reads to label recipes and wake-ups with the package that made them.
    pub fn snapshot(&self) -> Value {
        let Ok(entries) = self.inner.lock() else { return json!({"schemaVersion": SCHEMA_VERSION, "entries": {}}) };
        let rows: Map<String, Value> = entries.iter().map(|(key, origin)| (key.clone(), json!({"owner": origin.owner, "package": origin.package, "at": origin.at}))).collect();
        json!({"schemaVersion": SCHEMA_VERSION, "entries": rows})
    }
}

// ---- The app -------------------------------------------------------------------------------------------------------

#[derive(Clone)]
struct Caller { owner: String, version: String, name: String }

pub fn origins(app: &tauri::AppHandle) -> Option<tauri::State<'_, Origins>> { use tauri::Manager; app.try_state::<Origins>() }

fn caller(app: &tauri::AppHandle, owner: &str) -> Result<Caller, &'static str> {
    use tauri::Manager;
    let packages = app.try_state::<crate::extensions::packages::ExtensionPackages>().ok_or("UnsupportedCapability")?;
    let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
    let version = crate::extensions::runtime_service_lifetime::runtime_usage_resources::enabled_version(&packages, owner).ok_or("PermissionDenied")?;
    let snapshot = serde_json::to_value(packages.snapshot()).unwrap_or(Value::Null);
    let name = snapshot["packages"].as_array().into_iter().flatten().find(|package| package["manifest"]["id"] == owner)
        .and_then(|package| package["manifest"]["name"].as_str().filter(|name| !name.trim().is_empty()).map(str::to_owned)).unwrap_or_else(|| owner.to_owned());
    Ok(Caller { owner: owner.to_owned(), version, name })
}
fn caller_still(app: &tauri::AppHandle, caller: &Caller) -> bool { self::caller(app, &caller.owner).is_ok() }
fn held(app: &tauri::AppHandle, caller: &Caller, project: Option<&str>) -> bool {
    use crate::extensions::runtime_grants::{RuntimeGrants, Target};
    use tauri::Manager;
    let target = project.map_or_else(Target::default, Target::project);
    app.try_state::<RuntimeGrants>().is_some_and(|grants| grants.check(&caller.owner, &caller.version, PERMISSION, &target).is_ok())
}
/// The grant, asked now (the package enabled, outside safe mode, and `workspace.manage` held for the project).
fn require(app: &tauri::AppHandle, caller: &Caller, project: Option<&str>) -> Result<(), Refusal> {
    if caller_still(app, caller) && held(app, caller, project) { Ok(()) } else { Err(denied()) }
}
fn with_store<T>(app: &tauri::AppHandle, run: impl FnOnce(&crate::storage::Store) -> Result<T, Refusal>) -> Result<T, Refusal> {
    use tauri::Manager;
    let state = app.try_state::<crate::AppState>().ok_or_else(|| Refusal::new("HostUnavailable"))?;
    let store = state.store.lock().map_err(|_| Refusal::new("HostUnavailable"))?;
    run(&store)
}
async fn off<T: Send + 'static>(work: impl FnOnce() -> Result<T, Refusal> + Send + 'static) -> Result<T, Refusal> {
    tauri::async_runtime::spawn_blocking(work).await.unwrap_or_else(|_| Err(Refusal::new("HostUnavailable")))
}
fn record(app: &tauri::AppHandle, caller: &Caller, key: &str) {
    if let Some(ledger) = origins(app) { ledger.record(key, Origin { owner: caller.owner.clone(), package: caller.name.clone(), at: crate::extensions::runtime_notifications::now_millis() }); }
}
fn by(app: &tauri::AppHandle, key: &str) -> Option<Origin> { origins(app).and_then(|ledger| ledger.get(key)) }

fn recipe_dir(app: &tauri::AppHandle, scope: &RecipeScope) -> Result<PathBuf, Refusal> {
    use tauri::Manager;
    match scope {
        RecipeScope::Global => app.path().app_data_dir().map(|dir| dir.join("recipes")).map_err(|_| Refusal::new("HostUnavailable")),
        RecipeScope::Project(id) => with_store(app, |store| store.workspace_root(id, None).map(|root| crate::recipes::project_dir(&root)).map_err(|_| Refusal::at("NotFound", "projectId"))),
    }
}

/// Serves `workspaceRecipes` and `workspaceWakeups` of the service of `request.owner`.
pub async fn serve(app: tauri::AppHandle, request: crate::extensions::runtime_service_lifetime::DispatchRequest) -> Value {
    let found = { let app = app.clone(); let owner = request.owner.clone(); tauri::async_runtime::spawn_blocking(move || caller(&app, &owner)).await.unwrap_or(Err("HostUnavailable")) };
    let caller = match found {
        Ok(caller) => caller,
        Err(code) => return if code == "PermissionDenied" { denied().envelope() } else { Refusal::new(code).envelope() },
    };
    let result = match request.method.as_str() {
        "workspaceRecipes" => recipes_call(&app, &caller, &request.params).await,
        "workspaceWakeups" => wakeups_call(&app, &caller, &request.params).await,
        _ => Err(Refusal::new("UnsupportedCapability")),
    };
    match result { Ok(value) => ok(value), Err(refusal) => refusal.envelope() }
}

// ---- The host confirmation of an irreversible removal --------------------------------------------------------------

/// Removes the waiting dialog when its request is dropped (the service ended while it waited).
struct Waiting { app: tauri::AppHandle, id: String }
impl Drop for Waiting {
    fn drop(&mut self) {
        use tauri::Emitter;
        if crate::extensions::runtime_dialog_navigation::state(&self.app).is_some_and(|slots| slots.forget(&self.id)) { let _ = self.app.emit("extensions-runtime-dialog-close", json!({"id": self.id})); }
    }
}

/// Asks to remove something: nothing when the user turned the confirmation off for this package, else the host's
/// confirmation (showing the package and what will be destroyed). A refusal is `Cancelled`; the authority is read again
/// once the answer arrives, because it may have been revoked while the dialog was open.
async fn confirm(app: &tauri::AppHandle, caller: &Caller, action: &str, project: Option<&str>, what: &str) -> Result<(), Refusal> {
    use crate::extensions::{runtime_family_consents::{Delete, FamilyConsents}, runtime_grants::RuntimeGrants};
    use tauri::{Emitter, Manager};
    let grants = app.try_state::<RuntimeGrants>().ok_or_else(|| Refusal::new("UnsupportedCapability"))?;
    let consents = app.try_state::<FamilyConsents>().ok_or_else(|| Refusal::new("UnsupportedCapability"))?;
    let gate = consents.delete(&grants, &caller.owner, action, project, what).map_err(|code| Refusal::at(wire(&code), PERMISSION))?;
    let (ticket, shown) = match gate { Delete::Proceed => return Ok(()), Delete::Confirm { ticket, what } => (ticket, what) };
    let slots = crate::extensions::runtime_dialog_navigation::state(app).ok_or_else(|| Refusal::new("UnsupportedCapability"))?;
    let dialog = json!({
        "title": format!("{} wants to remove {}", caller.name, shown), "fields": [], "confirmLabel": "Remove",
        "confirmation": "This cannot be undone.", "successMessage": "Removed.", "cancelMessage": "Kept.",
    });
    let (id, receiver) = match slots.begin(&caller.owner, dialog.clone()) {
        Ok(opened) => opened,
        Err(code) => { let _ = consents.answer(&grants, &ticket, false); return Err(Refusal::new(code)); }
    };
    let _waiting = Waiting { app: app.clone(), id: id.clone() };
    let _ = app.emit("extensions-runtime-dialog", json!({"id": id, "owner": caller.owner, "dialog": dialog}));
    let reply = receiver.await.unwrap_or_else(|_| json!({"status": "cancelled"}));
    consents.answer(&grants, &ticket, reply["status"] == "confirmed").map_err(|code| Refusal::at(wire(&code), if code == "Cancelled" { "$" } else { PERMISSION }))
}

// ---- Recipes -------------------------------------------------------------------------------------------------------

async fn recipes_call(app: &tauri::AppHandle, caller: &Caller, params: &Value) -> Result<Value, Refusal> {
    match params["op"].as_str().unwrap_or_default() {
        "list" => recipes_list(app, caller, params).await,
        "save" => recipes_save(app, caller, params).await,
        "remove" => recipes_remove(app, caller, params).await,
        "run" => recipes_run(app, caller, params).await,
        _ => Err(Refusal::new("InvalidShape")),
    }
}

async fn recipes_list(app: &tauri::AppHandle, caller: &Caller, params: &Value) -> Result<Value, Refusal> {
    exact(params, &["op", "projectId"])?;
    let project = optional_ident(params, "projectId")?;
    let mut scopes: Vec<(RecipeScope, PathBuf)> = vec![];
    if let Some(project) = &project {
        require(app, caller, Some(project))?;
        let scope = RecipeScope::Project(project.clone());
        scopes.push((scope.clone(), recipe_dir(app, &scope)?));
    }
    // A global recipe is shown to a package whose grant is not narrowed to chosen projects.
    if caller_still(app, caller) && held(app, caller, None) { scopes.push((RecipeScope::Global, recipe_dir(app, &RecipeScope::Global)?)); }
    if scopes.is_empty() { return Err(denied()); }
    let listed = off(move || Ok(scopes.into_iter().flat_map(|(scope, dir)| crate::recipes::list_dir(&dir, scope.name()).into_iter().map(move |recipe| (scope.clone(), recipe))).collect::<Vec<_>>())).await?;
    let views: Vec<Value> = listed.iter().take(MAX_LIST).map(|(scope, recipe)| recipe_view(scope, recipe, by(app, &format!("recipe:{}", recipe_id(scope, &recipe.name))).as_ref())).collect();
    Ok(Value::Array(views))
}

async fn recipes_save(app: &tauri::AppHandle, caller: &Caller, params: &Value) -> Result<Value, Refusal> {
    exact(params, &["op", "recipe"])?;
    let (scope, recipe) = admit_recipe_save(&params["recipe"])?;
    let project = scope.project().map(str::to_owned);
    require(app, caller, project.as_deref())?;
    let dir = recipe_dir(app, &scope)?;
    let id = recipe_id(&scope, &recipe.name);
    {
        let (app, caller, project) = (app.clone(), caller.clone(), project.clone());
        // The grant is read again right before the file is written: a revoke or a narrowing in between saves nothing.
        off(move || { require(&app, &caller, project.as_deref())?; crate::recipes::save(&dir, &recipe).map_err(|error| Refusal::at(code_of_text(&error), "recipe")) }).await?;
    }
    record(app, caller, &format!("recipe:{id}"));
    Ok(json!({"id": id}))
}

async fn recipes_remove(app: &tauri::AppHandle, caller: &Caller, params: &Value) -> Result<Value, Refusal> {
    exact(params, &["op", "recipeId"])?;
    let (scope, name) = parse_recipe_id(&required_ident(params, "recipeId")?)?;
    let project = scope.project().map(str::to_owned);
    require(app, caller, project.as_deref())?;
    let dir = recipe_dir(app, &scope)?;
    let exists = { let (dir, name) = (dir.clone(), name.clone()); off(move || Ok(crate::recipes::list_dir(&dir, "").iter().any(|recipe| recipe.name == name))).await? };
    if !exists { return Err(Refusal::at("NotFound", "recipeId")); }
    confirm(app, caller, "recipes.remove", project.as_deref(), &format!("recipe \u{201c}{name}\u{201d}")).await?;
    {
        let (app, caller, project, name, dir) = (app.clone(), caller.clone(), project.clone(), name.clone(), dir);
        off(move || { require(&app, &caller, project.as_deref())?; crate::recipes::delete(&dir, &name).map_err(|error| Refusal::at(code_of_text(&error), "recipeId")) }).await?;
    }
    if let Some(ledger) = origins(app) { ledger.forget(&format!("recipe:{}", recipe_id(&scope, &name))); }
    Ok(Value::Null)
}

/// Runs a recipe in a task the way the Run button does: the task's harness and slash commands decide the dry run, and a
/// blocked step queues nothing. Each message is queued as an ordinary one (the queue row shows the package), and the grant
/// is read again before each, so a revoke in the middle leaves what was already queued and queues no more.
async fn recipes_run(app: &tauri::AppHandle, caller: &Caller, params: &Value) -> Result<Value, Refusal> {
    use tauri::{Emitter, Manager};
    exact(params, &["op", "recipeId", "options"])?;
    let (scope, name) = parse_recipe_id(&required_ident(params, "recipeId")?)?;
    exact(&params["options"], &["taskId"]).map_err(|refusal| nested("options", refusal))?;
    let task_id = required_ident(&params["options"], "taskId").map_err(|_| Refusal::at("InvalidShape", "options.taskId"))?;
    let (provider, project, cwd) = with_store(app, |store| {
        let task = store.session(&task_id).map_err(|_| Refusal::at("NotFound", "taskId"))?;
        let cwd = store.workspace_root(&task.project_id, Some(&task_id)).map_err(|_| Refusal::new("HostUnavailable"))?;
        Ok((task.provider.clone(), task.project_id.clone(), cwd))
    })?;
    require(app, caller, Some(&project))?;
    if scope.project().is_some_and(|recipe_project| recipe_project != project) { return Err(Refusal::at("NotFound", "recipeId")); }
    let dir = recipe_dir(app, &scope)?;
    let recipe = { let name = name.clone(); off(move || Ok(crate::recipes::list_dir(&dir, "").into_iter().find(|recipe| recipe.name == name))).await? }.ok_or_else(|| Refusal::at("NotFound", "recipeId"))?;
    let slash: Vec<String> = crate::slash_commands::catalog(&provider, &cwd, false).await.map_err(|_| Refusal::new("HostUnavailable"))?.commands.into_iter().map(|command| command.name).collect();
    let plan = crate::recipes::plan(&recipe, &provider, &slash).map_err(|error| Refusal::at(code_of_text(&error), "recipeId"))?;
    let blocked: Vec<String> = plan.steps.iter().filter(|step| step.status == "blocked").map(|step| format!("step-{}", step.index + 1)).collect();
    if !blocked.is_empty() { return Err(Refusal::at("UnsupportedCapability", "recipeId").with_ids(blocked)); }
    let mut entries: Vec<String> = vec![];
    for text in &plan.messages {
        require(app, caller, Some(&project)).map_err(|refusal| refusal.with_ids(entries.clone()))?;
        match crate::message_queue::queue_add(app.state::<crate::AppState>(), task_id.clone(), text.clone(), None).await {
            Ok(entry) => {
                if let Some(messages) = crate::extensions::runtime_tasks_messages::messages(app) {
                    messages.record_entry(&entry.id, crate::extensions::runtime_tasks_messages::EntryOrigin { task_id: task_id.clone(), owner: caller.owner.clone(), package: caller.name.clone(), at: crate::extensions::runtime_notifications::now_millis(), changed_by: None });
                    let _ = app.emit("extensions-runtime-message-origins", messages.revision_of_ledger());
                }
                entries.push(entry.id.clone());
            }
            Err(error) => return Err(Refusal::new(crate::extensions::runtime_tasks_messages::queue_code(&error)).with_ids(entries)),
        }
    }
    let _ = app.emit("queue-changed", json!({"sessionId": task_id}));
    crate::headless::queue_changed(app, &task_id);
    // One labelled line in the thread: which package ran which recipe. It is not part of any prompt.
    if let Some(state) = app.try_state::<crate::AppState>() {
        if let Ok(store) = state.store.lock() { let _ = store.insert_message(&task_id, "system", &format!("Recipe \u{201c}{}\u{201d} run by {}: {} queued", recipe.name, caller.name, entries.len())); }
    }
    let _ = app.emit("sessions-changed", ());
    let steps = serde_json::to_value(&plan.steps).unwrap_or_else(|_| json!([]));
    Ok(json!({"recipeId": recipe_id(&scope, &name), "taskId": task_id, "queued": entries.len(), "entries": entries, "steps": steps}))
}

// ---- Wake-ups ------------------------------------------------------------------------------------------------------

async fn wakeups_call(app: &tauri::AppHandle, caller: &Caller, params: &Value) -> Result<Value, Refusal> {
    match params["op"].as_str().unwrap_or_default() {
        "list" => wakeups_list(app, caller, params).await,
        "create" => wakeups_create(app, caller, params).await,
        "update" => wakeups_update(app, caller, params).await,
        "remove" => wakeups_remove(app, caller, params).await,
        _ => Err(Refusal::new("InvalidShape")),
    }
}

fn schedule_view(app: &tauri::AppHandle, schedule: &crate::schedules::TaskSchedule) -> Value {
    let mut view = serde_json::to_value(schedule).unwrap_or(Value::Null);
    if let Some(map) = view.as_object_mut() { map.insert("by".into(), by(app, &format!("wakeup:{}", schedule.id)).map_or(Value::Null, |origin| json!(origin.package))); }
    view
}
/// The projects a wake-up input touches: its task's, and the watched task's when it has one. An unknown task is `NotFound`.
fn projects_of(app: &tauri::AppHandle, input: &crate::schedules::ScheduleInput) -> Result<Vec<String>, Refusal> {
    with_store(app, |store| {
        let mut projects = vec![store.session(&input.session_id).map_err(|_| Refusal::at("NotFound", "input.sessionId"))?.project_id];
        if let Some(watch) = input.watch_session_id.as_deref().filter(|watch| !watch.is_empty()) {
            let project = store.session(watch).map_err(|_| Refusal::at("NotFound", "input.watchSessionId"))?.project_id;
            if !projects.contains(&project) { projects.push(project); }
        }
        Ok(projects)
    })
}
fn require_all(app: &tauri::AppHandle, caller: &Caller, projects: &[String]) -> Result<(), Refusal> {
    for project in projects { require(app, caller, Some(project))?; }
    Ok(())
}

async fn wakeups_list(app: &tauri::AppHandle, caller: &Caller, params: &Value) -> Result<Value, Refusal> {
    exact(params, &["op", "taskId"])?;
    let task = optional_ident(params, "taskId")?;
    let (schedules, projects) = with_store(app, |store| {
        if let Some(task) = &task {
            let project = store.session(task).map_err(|_| Refusal::at("NotFound", "taskId"))?.project_id;
            let list = crate::schedules::list(store, Some(task)).map_err(|_| Refusal::new("HostUnavailable"))?;
            Ok((list, vec![project]))
        } else {
            let list = crate::schedules::list(store, None).map_err(|_| Refusal::new("HostUnavailable"))?;
            let projects = store.projects().map_err(|_| Refusal::new("HostUnavailable"))?.into_iter().map(|project| project.id).collect();
            Ok((list, projects))
        }
    })?;
    let visible: Vec<String> = projects.into_iter().filter(|project| require(app, caller, Some(project)).is_ok()).collect();
    if task.is_some() && visible.is_empty() { return Err(denied()); }
    if task.is_none() && visible.is_empty() && !(caller_still(app, caller) && held(app, caller, None)) { return Err(denied()); }
    let views: Vec<Value> = schedules.iter().filter(|schedule| visible.contains(&schedule.project_id)).take(MAX_LIST).map(|schedule| schedule_view(app, schedule)).collect();
    Ok(Value::Array(views))
}

async fn wakeups_create(app: &tauri::AppHandle, caller: &Caller, params: &Value) -> Result<Value, Refusal> {
    exact(params, &["op", "input"])?;
    let input = admit_wakeup(&params["input"])?;
    let projects = projects_of(app, &input)?;
    require_all(app, caller, &projects)?;
    let schedule = {
        let (app, caller) = (app.clone(), caller.clone());
        off(move || with_store(&app, |store| {
            // Under the store's lock, right before the write: a revoke or a narrowing in between creates nothing.
            require_all(&app, &caller, &projects)?;
            crate::schedules::create(store, &input, "user", None, crate::storage::now()).map_err(|error| Refusal::at(code_of_text(&error), "input"))
        })).await?
    };
    record(app, caller, &format!("wakeup:{}", schedule.id));
    crate::schedules::changed(app, Some(&schedule.session_id));
    Ok(schedule_view(app, &schedule))
}

async fn wakeups_update(app: &tauri::AppHandle, caller: &Caller, params: &Value) -> Result<Value, Refusal> {
    exact(params, &["op", "wakeupId", "input"])?;
    let id = required_ident(params, "wakeupId")?;
    let input = admit_wakeup(&params["input"])?;
    let before = with_store(app, |store| crate::schedules::get(store, &id).map_err(|_| Refusal::at("NotFound", "wakeupId")))?;
    let mut projects = vec![before.project_id.clone()];
    for project in projects_of(app, &input)? { if !projects.contains(&project) { projects.push(project); } }
    require_all(app, caller, &projects)?;
    let schedule = {
        let (app, caller, id) = (app.clone(), caller.clone(), id.clone());
        off(move || with_store(&app, |store| {
            require_all(&app, &caller, &projects)?;
            crate::schedules::update(store, &id, &input, crate::storage::now()).map_err(|error| Refusal::at(code_of_text(&error), "input"))
        })).await?
    };
    // Moving a wake-up to another task changes both tasks' lists.
    crate::schedules::changed(app, (before.session_id == schedule.session_id).then_some(schedule.session_id.as_str()));
    Ok(schedule_view(app, &schedule))
}

async fn wakeups_remove(app: &tauri::AppHandle, caller: &Caller, params: &Value) -> Result<Value, Refusal> {
    exact(params, &["op", "wakeupId"])?;
    let id = required_ident(params, "wakeupId")?;
    let schedule = with_store(app, |store| crate::schedules::get(store, &id).map_err(|_| Refusal::at("NotFound", "wakeupId")))?;
    require(app, caller, Some(&schedule.project_id))?;
    confirm(app, caller, "wakeups.remove", Some(&schedule.project_id), &format!("wake-up \u{201c}{}\u{201d}", schedule.title)).await?;
    {
        let (app, caller, id, project) = (app.clone(), caller.clone(), id.clone(), schedule.project_id.clone());
        off(move || with_store(&app, |store| {
            require(&app, &caller, Some(&project))?;
            crate::schedules::delete(store, &id).map(|_| ()).map_err(|error| Refusal::at(code_of_text(&error), "wakeupId"))
        })).await?;
    }
    if let Some(ledger) = origins(app) { ledger.forget(&format!("wakeup:{id}")); }
    crate::schedules::changed(app, Some(&schedule.session_id));
    Ok(Value::Null)
}

/// The main window reads who saved each recipe and created each wake-up (it labels them with the package's name).
#[tauri::command]
pub fn extensions_workspace_origins(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Value, String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    Ok(origins(&app).map_or_else(|| json!({"schemaVersion": SCHEMA_VERSION, "entries": {}}), |ledger| ledger.snapshot()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(kind: &str, text: &str) -> Value { json!({"kind": kind, "text": text}) }
    fn recipe(scope: &str) -> Value {
        let mut value = json!({"scope": scope, "name": "review-diff", "description": "Review the diff", "steps": [step("prompt", "Review the diff"), {"kind": "slash", "command": "/review", "text": "Review it", "requires": ["slash:review"]}]});
        if scope == "project" { value["projectId"] = json!("project-1"); }
        value
    }

    #[test]
    fn recipe_ids_round_trip_and_malformed_ids_are_invalid_shape() {
        for (scope, name) in [(RecipeScope::Global, "a"), (RecipeScope::Project("project-1".into()), "review_diff"), (RecipeScope::Project("p:q".into()), "x-1")] {
            let id = recipe_id(&scope, name);
            assert_eq!(parse_recipe_id(&id).unwrap(), (scope, name.to_owned()), "{id}");
        }
        for id in ["", "global:", "global:Upper", "project:review", "project::a", "project:p:", "other:a", "global:a:b", "project:p:Bad"] {
            assert_eq!(parse_recipe_id(id).unwrap_err().code, "InvalidShape", "{id}");
        }
    }

    #[test]
    fn a_recipe_save_takes_the_interfaces_shape_and_its_validation() {
        let (scope, saved) = admit_recipe_save(&recipe("project")).unwrap();
        assert_eq!((scope, saved.name.as_str(), saved.steps.len(), saved.scope.as_str()), (RecipeScope::Project("project-1".into()), "review-diff", 2, ""));
        assert_eq!(admit_recipe_save(&recipe("global")).unwrap().0, RecipeScope::Global);
        let mut cases: Vec<(Value, &str, &str)> = vec![];
        let with = |edit: &dyn Fn(&mut Value)| { let mut value = recipe("project"); edit(&mut value); value };
        cases.push((with(&|v| { v["scope"] = json!("user"); }), "InvalidShape", "recipe.scope"));
        cases.push((with(&|v| { v.as_object_mut().unwrap().remove("projectId"); }), "InvalidShape", "recipe.projectId"));
        cases.push((with(&|v| { v["extra"] = json!(1); }), "InvalidShape", "recipe.extra"));
        cases.push((with(&|v| { v["name"] = json!("Bad Name"); }), "InvalidShape", "recipe"));
        cases.push((with(&|v| { v["steps"] = json!([]); }), "LimitExceeded", "recipe"));
        cases.push((with(&|v| { v["steps"] = json!([{"kind": "teleport", "text": "x"}]); }), "InvalidShape", "recipe"));
        cases.push((with(&|v| { v["steps"] = json!([{"kind": "prompt", "text": "x", "secret": 1}]); }), "InvalidShape", "recipe.steps[0]"));
        cases.push((with(&|v| { v["steps"] = json!(vec![step("prompt", "x"); MAX_STEPS_SEEN + 1]); }), "LimitExceeded", "recipe.steps"));
        cases.push((with(&|v| { v["description"] = json!(5); }), "InvalidShape", "recipe.description"));
        for (value, code, path) in cases { let refusal = admit_recipe_save(&value).unwrap_err(); assert_eq!((refusal.code.as_str(), refusal.path.as_str()), (code, path), "{value}"); }
        let mut global = recipe("global");
        global["projectId"] = json!("project-1");
        assert_eq!(admit_recipe_save(&global).unwrap_err().path, "recipe.projectId");
    }

    #[test]
    fn a_wakeup_input_takes_only_the_native_schedule_fields() {
        let input = admit_wakeup(&json!({"sessionId": "t1", "title": "Nightly", "prompt": "Continue", "kind": "daily", "timeOfDay": "09:30", "days": [1, 2], "maxRuns": 3, "onlyOnSuccess": false})).unwrap();
        assert_eq!((input.session_id.as_str(), input.kind.as_str(), input.time_of_day.as_deref(), input.days.clone(), input.max_runs), ("t1", "daily", Some("09:30"), vec![1, 2], Some(3)));
        for (value, path) in [
            (json!({"prompt": "x"}), "input.sessionId"), (json!({"sessionId": "t1", "createdBy": "agent"}), "input.createdBy"),
            (json!({"sessionId": "t1", "days": "mon"}), "input"), (json!({"sessionId": "t1", "maxRuns": "3"}), "input"), (json!("t1"), "input"),
        ] { let refusal = admit_wakeup(&value).unwrap_err(); assert_eq!((refusal.code.as_str(), refusal.path.as_str()), ("InvalidShape", path), "{value}"); }
    }

    #[test]
    fn native_messages_map_to_codes_and_foreign_codes_are_not_passed_on() {
        for (text, code) in [
            ("That thread no longer exists.", "NotFound"), ("This schedule no longer exists.", "NotFound"), ("Unknown harness.", "UnsupportedCapability"),
            ("Too many recipes here.", "LimitExceeded"), ("Keep the title under 120 characters.", "LimitExceeded"), ("A recipe has 1 to 50 steps.", "LimitExceeded"),
            ("Max runs must be 1 to 1000, or empty to run until removed.", "LimitExceeded"), ("Use a 24-hour local time like 09:30.", "InvalidShape"), ("Step 1: add the text to send.", "InvalidShape"),
        ] { assert_eq!(code_of_text(text), code, "{text}"); }
        assert_eq!((wire("Cancelled"), wire("PermissionDenied"), wire("some text"), wire("")), ("Cancelled", "PermissionDenied", "HostUnavailable", "HostUnavailable"));
    }

    #[test]
    fn the_refusal_envelope_names_the_code_the_path_and_the_ids() {
        assert_eq!(denied().envelope(), json!({"ok": false, "error": {"schemaVersion": 1, "code": "PermissionDenied", "path": "workspace.manage", "ids": []}}));
        assert_eq!(Refusal::at("UnsupportedCapability", "recipeId").with_ids(vec!["step-2".into()]).envelope()["error"]["ids"], json!(["step-2"]));
    }

    #[test]
    fn the_ledger_attributes_forgets_evicts_and_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("pandacode-workspace-origins-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        {
            let ledger = Origins::open(&dir);
            ledger.record("recipe:global:a", Origin { owner: "sample.pkg".into(), package: "Sample".into(), at: 5 });
            ledger.record("wakeup:s1", Origin { owner: "sample.pkg".into(), package: "Sample".into(), at: 6 });
            assert!(ledger.forget("wakeup:s1") && !ledger.forget("wakeup:s1"));
        }
        let again = Origins::open(&dir);
        assert_eq!((again.len(), again.get("recipe:global:a").map(|origin| origin.package)), (1, Some("Sample".to_owned())));
        assert_eq!(again.snapshot()["entries"]["recipe:global:a"]["owner"], "sample.pkg");
        let bounded = Origins::default();
        for index in 0..(MAX_ORIGINS + 5) { bounded.record(&format!("wakeup:{index}"), Origin { owner: "o".into(), package: "p".into(), at: index as u64 }); }
        assert_eq!(bounded.len(), MAX_ORIGINS);
        assert!(bounded.get("wakeup:0").is_none() && bounded.get(&format!("wakeup:{}", MAX_ORIGINS + 4)).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
