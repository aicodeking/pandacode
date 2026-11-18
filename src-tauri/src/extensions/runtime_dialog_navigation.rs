//! Dialog answers and host navigation for background services (`ui.dynamic`, runtime phase R2, slice R0206).
//!
//! A trusted service asks the user a question with `panda.ui.showDialog(definition)` and waits for the answer, and it
//! moves what the window shows with `panda.ui.reveal(target)`. Both need the `ui.dynamic` grant, which is rechecked
//! against the grants file on every request (ADR-0005: a package that holds it is never asked again per action).
//!
//! Rules that are for predictability and fault isolation, never for trust:
//! - the definition goes through the same validator as a manifest dialog (`validate_contract("dialog")`);
//! - one dialog may be open per owner: a second request while one is open answers `Conflict` and leaves the first alone;
//! - the dialog resolves with `{status: "confirmed", values}` or `{status: "cancelled"}`; the service ending (disable,
//!   revoke, uninstall, safe mode, crash, quit) resolves a pending dialog as cancelled and closes its window;
//! - an answer names a dialog that is open; an answer for one that is gone (answered, cancelled or ended) is `NotFound`
//!   and reaches no service, and its values may only name fields the definition declared;
//! - `reveal` names a view or a settings page of the package, a task, or a file of a project that exist now; an unknown
//!   or stale target is `NotFound` and nothing is sent to any task (it never sends a message). A file path is relative
//!   to its project; the package's own editor (`editor`) must carry the package's prefix.
//!
//! The state is pure (injected world) so the bounds are deterministic to test. The process loop reaches it through
//! `serve` (`uiDialog` / `uiReveal` requests of the service); the main window learns of it by the events
//! `extensions-runtime-dialog`, `extensions-runtime-dialog-close` and `extensions-runtime-reveal` and answers with
//! `extensions_runtime_dialog_answer`. `src/extensions/runtime-dialog-navigation.ts` mirrors the rules for the preview.
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::{Component, Path, PathBuf}, sync::Mutex};
use tokio::sync::oneshot;

/// The named permission (granted with the trust decision, rechecked on every request).
pub const PERMISSION: &str = "ui.dynamic";
/// Largest answer the host accepts, in compact JSON bytes.
pub const ANSWER_BYTES: usize = 65_536;

pub fn failure(code: &str) -> Value { json!({"ok": false, "error": {"schemaVersion": 1, "code": code, "path": "$", "ids": []}}) }
fn ok(value: Value) -> Value { json!({"ok": true, "value": value}) }
fn cancelled() -> Value { json!({"status": "cancelled"}) }
fn owns(owner: &str, id: &str) -> bool { id.strip_prefix(owner).and_then(|rest| rest.strip_prefix('/')).is_some_and(|rest| !rest.is_empty()) }
fn ident(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control) }

struct Open { owner: String, dialog: Value, sender: Option<oneshot::Sender<Value>> }
#[derive(Default)]
struct Inner { open: BTreeMap<String, Open>, serial: u64 }

/// Every owner's open dialog (at most one each).
#[derive(Default)]
pub struct DialogSlots { inner: Mutex<Inner> }

impl DialogSlots {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, &'static str> { self.inner.lock().map_err(|_| "HostUnavailable") }

    /// Opens the owner's dialog: its id and the receiver the answer arrives on. A second one is `Conflict`.
    pub fn begin(&self, owner: &str, dialog: Value) -> Result<(String, oneshot::Receiver<Value>), &'static str> {
        let mut inner = self.lock()?;
        if inner.open.values().any(|open| open.owner == owner) { return Err("Conflict"); }
        inner.serial += 1;
        let id = format!("{owner}#dialog-{}", inner.serial);
        let (sender, receiver) = oneshot::channel();
        inner.open.insert(id.clone(), Open { owner: owner.to_owned(), dialog, sender: Some(sender) });
        Ok((id, receiver))
    }

    /// The interface answers the dialog `id`: `confirmed` with values of declared fields, or `cancelled`.
    pub fn answer(&self, id: &str, answer: &Value) -> Result<(), &'static str> {
        let mut inner = self.lock()?;
        let open = inner.open.get(id).ok_or("NotFound")?;
        let reply = match answer["status"].as_str() {
            Some("cancelled") if answer.as_object().is_some_and(|object| object.len() == 1) => cancelled(),
            Some("confirmed") => {
                let (object, values) = (answer.as_object().ok_or("InvalidShape")?, answer["values"].as_object().ok_or("InvalidShape")?);
                if object.len() != 2 { return Err("InvalidShape"); }
                if answer.to_string().len() > ANSWER_BYTES { return Err("LimitExceeded"); }
                let declared: Vec<&str> = open.dialog["fields"].as_array().into_iter().flatten().filter_map(|field| field["id"].as_str()).collect();
                if values.keys().any(|key| !declared.contains(&key.as_str())) { return Err("InvalidShape"); }
                json!({"status": "confirmed", "values": Value::Object(values.clone())})
            }
            _ => return Err("InvalidShape"),
        };
        if let Some(mut open) = inner.open.remove(id) { if let Some(sender) = open.sender.take() { let _ = sender.send(reply); } }
        Ok(())
    }

    /// The owner's dialog ends without an answer (its service stopped): the waiting call resolves as cancelled.
    pub fn cancel_owner(&self, owner: &str) -> Vec<String> {
        let Ok(mut inner) = self.inner.lock() else { return vec![] };
        let ids: Vec<String> = inner.open.iter().filter(|(_, open)| open.owner == owner).map(|(id, _)| id.clone()).collect();
        for id in &ids { if let Some(mut open) = inner.open.remove(id) { if let Some(sender) = open.sender.take() { let _ = sender.send(cancelled()); } } }
        ids
    }

    /// The waiting call went away on its own (its request was dropped): the slot is free again.
    pub fn forget(&self, id: &str) -> bool { self.inner.lock().is_ok_and(|mut inner| inner.open.remove(id).is_some()) }

    /// The dialogs the window shows or must show, oldest first (a window that opens late reads this).
    pub fn pending(&self) -> Value {
        let Ok(inner) = self.inner.lock() else { return json!([]) };
        let mut entries: Vec<(&String, &Open)> = inner.open.iter().collect();
        entries.sort_by_key(|(id, _)| id.rsplit('-').next().and_then(|serial| serial.parse::<u64>().ok()).unwrap_or(0));
        Value::Array(entries.into_iter().map(|(id, open)| json!({"id": id, "owner": open.owner, "dialog": open.dialog})).collect())
    }
    pub fn count(&self, owner: &str) -> usize { self.inner.lock().map_or(0, |inner| inner.open.values().filter(|open| open.owner == owner).count()) }
}

/// What the app answers about the world; tests give fixed answers.
pub struct World<'a> {
    /// The package holds `ui.dynamic` now (checked against the grants file on every request).
    pub granted: bool,
    /// View ids of the package (manifest and live) and its settings page ids.
    pub views: &'a [String],
    pub settings_pages: &'a [String],
    pub task_exists: &'a dyn Fn(&str) -> bool,
    /// The folder of a project, `None` when the project does not exist.
    pub project_dir: &'a dyn Fn(&str) -> Option<PathBuf>,
    pub file_exists: &'a dyn Fn(&Path) -> bool,
}

/// Checks a reveal target and answers it normalized (the event the window receives), or the failure code.
pub fn check_reveal(owner: &str, world: &World, raw: &Value) -> Result<Value, &'static str> {
    if !world.granted { return Err("PermissionDenied"); }
    let object = raw.as_object().ok_or("InvalidShape")?;
    let keys: Vec<&str> = object.keys().map(String::as_str).collect();
    let text = |key: &str| object.get(key).and_then(Value::as_str).filter(|value| ident(value)).ok_or("InvalidShape");
    match keys.as_slice() {
        ["view"] => {
            let id = text("view")?;
            if !owns(owner, id) { return Err("PermissionDenied"); }
            if world.views.iter().any(|view| view == id) { Ok(json!({"view": id})) } else { Err("NotFound") }
        }
        ["settingsPage"] => {
            let id = text("settingsPage")?;
            if !owns(owner, id) { return Err("PermissionDenied"); }
            if world.settings_pages.iter().any(|page| page == id) { Ok(json!({"settingsPage": id})) } else { Err("NotFound") }
        }
        ["taskId"] => { let id = text("taskId")?; if (world.task_exists)(id) { Ok(json!({"taskId": id})) } else { Err("NotFound") } }
        _ if object.contains_key("projectId") && object.contains_key("path") && keys.iter().all(|key| ["projectId", "path", "line", "editor"].contains(key)) => {
            let (project, path) = (text("projectId")?, text("path")?);
            let relative = Path::new(path);
            if relative.is_absolute() || relative.components().any(|part| !matches!(part, Component::Normal(_) | Component::CurDir)) { return Err("InvalidShape"); }
            let line = match object.get("line") { None => None, Some(value) => Some(value.as_u64().filter(|line| (1..=10_000_000).contains(line)).ok_or("InvalidShape")?) };
            let editor = match object.get("editor") { None => None, Some(_) => { let id = text("editor")?; if !owns(owner, id) { return Err("PermissionDenied"); } Some(id) } };
            let directory = (world.project_dir)(project).ok_or("NotFound")?;
            if !(world.file_exists)(&directory.join(relative)) { return Err("NotFound"); }
            let mut target = json!({"projectId": project, "path": path});
            if let Some(line) = line { target["line"] = json!(line); }
            if let Some(editor) = editor { target["editor"] = json!(editor); }
            Ok(target)
        }
        _ => Err("InvalidShape"),
    }
}

/// The app's one set of slots, managed as Tauri state.
pub fn state(app: &tauri::AppHandle) -> Option<tauri::State<'_, DialogSlots>> { use tauri::Manager; app.try_state::<DialogSlots>() }

/// What a service request needs from the installed package and the live grant: its version, views and settings pages.
struct Package { views: Vec<String>, settings_pages: Vec<String>, granted: bool }
fn package(app: &tauri::AppHandle, owner: &str) -> Result<Package, &'static str> {
    use tauri::Manager;
    let packages = app.state::<crate::extensions::packages::ExtensionPackages>();
    let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
    let version = super::runtime_service_lifetime::runtime_usage_resources::enabled_version(&packages, owner).ok_or("PermissionDenied")?;
    let snapshot = serde_json::to_value(packages.snapshot()).unwrap_or(Value::Null);
    let manifest = snapshot["packages"].as_array().into_iter().flatten().find(|package| package["manifest"]["id"] == owner).map(|package| package["manifest"].clone()).unwrap_or(Value::Null);
    let ids = |bucket: &str| manifest["contributes"][bucket].as_array().into_iter().flatten().filter_map(|entry| entry["id"].as_str().map(str::to_owned)).collect::<Vec<_>>();
    let mut views = ids("views");
    if let Some(items) = super::runtime_dynamic_items::state(app) { views.extend(items.snapshot()["owners"][owner]["views"].as_array().into_iter().flatten().filter_map(|view| view["id"].as_str().map(str::to_owned))); }
    let granted = app.try_state::<super::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(owner, &version, PERMISSION, &super::runtime_grants::Target::default()).is_ok());
    Ok(Package { views, settings_pages: ids("settings"), granted })
}

/// Removes the waiting dialog when its request is dropped (the service ended while it waited).
struct Waiting { app: tauri::AppHandle, id: String }
impl Drop for Waiting {
    fn drop(&mut self) {
        if state(&self.app).is_some_and(|slots| slots.forget(&self.id)) { close_event(&self.app, &self.id); }
    }
}
fn close_event(app: &tauri::AppHandle, id: &str) { use tauri::Emitter; let _ = app.emit("extensions-runtime-dialog-close", json!({"id": id})); }

/// Serves `uiDialog` and `uiReveal` of the service of `request.owner`.
pub async fn serve(app: tauri::AppHandle, request: super::runtime_service_lifetime::DispatchRequest) -> Value {
    use tauri::Emitter;
    let owner = request.owner.clone();
    let Some(slots) = state(&app) else { return failure("UnsupportedCapability") };
    let found = { let app = app.clone(); let owner = owner.clone(); tauri::async_runtime::spawn_blocking(move || package(&app, &owner)).await.unwrap_or(Err("HostUnavailable")) };
    let package = match found { Ok(package) => package, Err(code) => return failure(code) };
    if !package.granted { return failure("PermissionDenied"); }
    if request.method == "uiReveal" {
        let outcome = {
            use tauri::Manager;
            let task_exists = |id: &str| app.try_state::<crate::AppState>().is_some_and(|state| state.store.try_lock().is_ok_and(|store| store.session(id).is_ok()));
            let project_dir = |id: &str| app.try_state::<crate::AppState>().and_then(|state| state.store.try_lock().ok().and_then(|store| store.project(id).ok().map(|project| PathBuf::from(project.path))));
            let world = World { granted: true, views: &package.views, settings_pages: &package.settings_pages, task_exists: &task_exists, project_dir: &project_dir, file_exists: &|path| path.is_file() };
            check_reveal(&owner, &world, &request.params)
        };
        return match outcome {
            Ok(target) => { let _ = app.emit("extensions-runtime-reveal", json!({"owner": owner, "target": target})); ok(Value::Null) }
            Err(code) => failure(code),
        };
    }
    // `uiDialog`: the validated definition, one open dialog per owner, then the answer.
    let checked = super::contracts::validate_contract("dialog", &request.params);
    if checked["ok"] != true { return failure(checked["error"]["code"].as_str().unwrap_or("InvalidShape")); }
    let dialog = checked["value"].clone();
    let (id, receiver) = match slots.begin(&owner, dialog.clone()) { Ok(opened) => opened, Err(code) => return failure(code) };
    let _waiting = Waiting { app: app.clone(), id: id.clone() };
    let _ = app.emit("extensions-runtime-dialog", json!({"id": id, "owner": owner, "dialog": dialog}));
    ok(receiver.await.unwrap_or_else(|_| cancelled()))
}

/// The service of `owner` stopped (disable, revoke, uninstall, safe mode, crash, quit): its dialog resolves cancelled and closes.
pub fn service_stopped(app: &tauri::AppHandle, owner: &str) {
    let Some(slots) = state(app) else { return };
    for id in slots.cancel_owner(owner) { close_event(app, &id); }
}

/// The main window answers a dialog a service asked.
#[tauri::command]
pub fn extensions_runtime_dialog_answer(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String, answer: Value) -> Result<(), String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    let Some(slots) = state(&app) else { return Err("UnsupportedCapability".into()) };
    slots.answer(&id, &answer).map_err(str::to_owned)
}
/// The dialogs waiting for the window (read when the window starts and after a reload).
#[tauri::command]
pub fn extensions_runtime_dialogs(app: tauri::AppHandle) -> Value { state(&app).map_or_else(|| json!([]), |slots| slots.pending()) }

#[cfg(test)]
mod tests {
    use super::*;
    const OWNER: &str = "sample.dialog-navigation";
    fn dialog() -> Value { json!({"title": "Pick", "fields": [{"id": "name", "label": "Name", "kind": "text"}, {"id": "sure", "label": "Sure", "kind": "switch"}], "successMessage": "Done"}) }
    fn code(result: Result<impl std::fmt::Debug, &'static str>) -> &'static str { result.unwrap_err() }

    #[test]
    fn an_answer_reaches_the_waiting_call_once() {
        let slots = DialogSlots::default();
        let (id, mut receiver) = slots.begin(OWNER, dialog()).unwrap();
        assert_eq!(slots.count(OWNER), 1);
        assert_eq!(slots.pending()[0]["id"], id.as_str());
        slots.answer(&id, &json!({"status": "confirmed", "values": {"name": "Ada", "sure": true}})).unwrap();
        assert_eq!(receiver.try_recv().unwrap(), json!({"status": "confirmed", "values": {"name": "Ada", "sure": true}}));
        // The dialog is gone: a second answer is stale and reaches nobody.
        assert_eq!(code(slots.answer(&id, &json!({"status": "cancelled"}))), "NotFound");
        assert_eq!(slots.count(OWNER), 0);
        // A cancelled answer resolves as cancelled and frees the slot.
        let (id, mut receiver) = slots.begin(OWNER, dialog()).unwrap();
        slots.answer(&id, &json!({"status": "cancelled"})).unwrap();
        assert_eq!(receiver.try_recv().unwrap(), json!({"status": "cancelled"}));
    }

    #[test]
    fn a_second_dialog_of_the_same_owner_is_a_conflict_and_leaves_the_first_alone() {
        let slots = DialogSlots::default();
        let (first, mut receiver) = slots.begin(OWNER, dialog()).unwrap();
        assert_eq!(code(slots.begin(OWNER, dialog())), "Conflict");
        // Another owner has its own slot.
        let (other, _keep) = slots.begin("sample.other", dialog()).unwrap();
        assert_ne!(first, other);
        assert!(receiver.try_recv().is_err(), "the first dialog still waits");
        slots.answer(&first, &json!({"status": "cancelled"})).unwrap();
        assert!(slots.begin(OWNER, dialog()).is_ok(), "the slot is free after the answer");
    }

    #[test]
    fn the_service_ending_resolves_its_dialog_as_cancelled_and_only_its_own() {
        let slots = DialogSlots::default();
        let (id, mut receiver) = slots.begin(OWNER, dialog()).unwrap();
        let (_other, mut other_receiver) = slots.begin("sample.other", dialog()).unwrap();
        assert_eq!(slots.cancel_owner(OWNER), vec![id.clone()]);
        assert_eq!(receiver.try_recv().unwrap(), json!({"status": "cancelled"}));
        assert!(other_receiver.try_recv().is_err());
        assert_eq!(code(slots.answer(&id, &json!({"status": "cancelled"}))), "NotFound");
        assert!(slots.cancel_owner(OWNER).is_empty());
        // A request that went away on its own frees the slot too.
        let (gone, receiver) = slots.begin(OWNER, dialog()).unwrap();
        drop(receiver);
        assert!(slots.forget(&gone));
        assert!(!slots.forget(&gone));
    }

    #[test]
    fn malformed_answers_name_their_reason() {
        let slots = DialogSlots::default();
        let (id, _receiver) = slots.begin(OWNER, dialog()).unwrap();
        // Retained: an answer must be the declared shape, name only declared fields and stay bounded (predictability).
        for (answer, expected) in [(json!({"status": "maybe"}), "InvalidShape"), (json!({"status": "confirmed"}), "InvalidShape"), (json!({"status": "confirmed", "values": {"ghost": 1}}), "InvalidShape"),
            (json!({"status": "cancelled", "values": {}}), "InvalidShape"), (json!({"status": "confirmed", "values": {"name": "x".repeat(ANSWER_BYTES)}}), "LimitExceeded"), (json!("confirmed"), "InvalidShape")] {
            assert_eq!(code(slots.answer(&id, &answer)), expected, "{answer}");
        }
        assert_eq!(slots.count(OWNER), 1, "a refused answer leaves the dialog open");
    }

    struct Fixture { views: Vec<String>, pages: Vec<String>, root: PathBuf }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("pandacode-dialog-navigation-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(root.join("src")).unwrap(); std::fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
            Self { views: vec![format!("{OWNER}/board")], pages: vec![format!("{OWNER}/settings")], root }
        }
        fn reveal(&self, granted: bool, raw: Value) -> Result<Value, &'static str> {
            let root = self.root.clone();
            let task_exists = |id: &str| id == "t1";
            let project_dir = move |id: &str| (id == "A").then(|| root.clone());
            let world = World { granted, views: &self.views, settings_pages: &self.pages, task_exists: &task_exists, project_dir: &project_dir, file_exists: &|path| path.is_file() };
            check_reveal(OWNER, &world, &raw)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }

    #[test]
    fn reveal_names_a_view_a_task_a_file_or_a_settings_page_that_exist_now() {
        let world = Fixture::new();
        assert_eq!(world.reveal(true, json!({"view": format!("{OWNER}/board")})).unwrap(), json!({"view": format!("{OWNER}/board")}));
        assert_eq!(world.reveal(true, json!({"taskId": "t1"})).unwrap(), json!({"taskId": "t1"}));
        assert_eq!(world.reveal(true, json!({"settingsPage": format!("{OWNER}/settings")})).unwrap(), json!({"settingsPage": format!("{OWNER}/settings")}));
        assert_eq!(world.reveal(true, json!({"projectId": "A", "path": "src/main.rs", "line": 12})).unwrap(), json!({"projectId": "A", "path": "src/main.rs", "line": 12}));
        assert_eq!(world.reveal(true, json!({"projectId": "A", "path": "src/main.rs", "editor": format!("{OWNER}/editor")})).unwrap()["editor"], format!("{OWNER}/editor"));
    }

    #[test]
    fn reveal_refuses_unknown_and_stale_targets_with_a_reason() {
        let world = Fixture::new();
        // Unknown or stale context: the task or project is gone, the file is gone, the view or page is not the package's.
        for (raw, expected) in [(json!({"taskId": "ghost"}), "NotFound"), (json!({"view": format!("{OWNER}/ghost")}), "NotFound"), (json!({"settingsPage": format!("{OWNER}/ghost")}), "NotFound"),
            (json!({"projectId": "B", "path": "src/main.rs"}), "NotFound"), (json!({"projectId": "A", "path": "src/gone.rs"}), "NotFound"),
            // Foreign owner: another package's view, page or editor (an id names its own package's things).
            (json!({"view": "sample.other/board"}), "PermissionDenied"), (json!({"settingsPage": "sample.other/settings"}), "PermissionDenied"), (json!({"projectId": "A", "path": "src/main.rs", "editor": "sample.other/editor"}), "PermissionDenied"),
            // Shape: a path stays inside the project, a line is a positive number, one target at a time.
            (json!({"projectId": "A", "path": "../secret"}), "InvalidShape"), (json!({"projectId": "A", "path": "/etc/passwd"}), "InvalidShape"), (json!({"projectId": "A", "path": "src/main.rs", "line": 0}), "InvalidShape"),
            (json!({"taskId": "t1", "view": format!("{OWNER}/board")}), "InvalidShape"), (json!({}), "InvalidShape"), (json!("t1"), "InvalidShape"), (json!({"taskId": 7}), "InvalidShape")] {
            assert_eq!(code(world.reveal(true, raw.clone())), expected, "{raw}");
        }
        // No grant: nothing is revealed (an unauthorized request, refused natively).
        assert_eq!(code(world.reveal(false, json!({"taskId": "t1"}))), "PermissionDenied");
    }
}
