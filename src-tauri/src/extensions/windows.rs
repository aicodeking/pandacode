//! Native identity and dispatch policy for the actual auxiliary webviews. No main grants are shared.
use super::{contracts, packages::{ExtensionPackages, Snapshot}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

pub const AUXILIARY: [&str; 3] = ["tray", "launcher", "agents-dock"];
pub fn surface_window(surface: &str) -> Option<&'static str> {
    match surface {
        "panda.tray.actions" | "panda.tray.menu" => Some("tray"),
        "panda.launcher.actions" => Some("launcher"),
        "panda.agentsDock.actions" => Some("agents-dock"),
        _ => None,
    }
}

/// Called before the real generate_handler dispatch, not merely by tests or frontend metadata.
pub fn command_allowed(label: &str, command: &str) -> bool {
    if label == "main" { return true; }
    if !AUXILIARY.contains(&label) { return false; }
    if matches!(command, "extensions_window_snapshot" | "extensions_window_action" | "extensions_window_recover") { return true; }
    match label {
        "tray" => matches!(command, "tray_snapshot" | "tray_open" | "tray_refresh_usage" | "tray_show_app" | "tray_hide" | "tray_quit" | "tray_resize"),
        "launcher" => matches!(command, "overlay_snapshot" | "overlay_thread" | "overlay_launch" | "overlay_select_model" | "overlay_hide" | "overlay_open_task" | "fork_session_at_message" | "get_message_content" | "list_providers" | "list_provider_models" | "search_files" | "open_external_url"),
        "agents-dock" => matches!(command, "agents_dock_snapshot" | "agents_dock_unpin" | "agents_dock_set_expanded" | "agents_dock_open_task"),
        _ => false,
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionRequest { pub surface_id: String, pub id: String, pub version: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAction { owner: String, context: Value, pub action: Value }
fn allows(value: &Value, context: &Value) -> bool {
    ["visible", "enabled"].iter().all(|key| value.get(key).is_none_or(|condition| contracts::evaluate_condition(condition, context)["value"] == true))
}
fn find_leaf<'a>(items: &'a [Value], id: &str, context: &Value) -> Option<&'a Value> {
    for item in items {
        if !allows(item, context) { continue; }
        if item["id"] == id && item["kind"] != "submenu" && item["kind"] != "separator" { return Some(item); }
        if let Some(found) = item["items"].as_array().and_then(|children| find_leaf(children, id, context)) { return Some(found); }
    }
    None
}
pub fn resolve(snapshot: &Snapshot, actual_label: &str, request: &ActionRequest) -> Result<ResolvedAction, String> {
    if checked_packages(snapshot)["ok"] != true { return Err("PermissionDenied".into()); }
    resolve_checked(snapshot, actual_label, request)
}
fn checked_packages(snapshot: &Snapshot) -> Value {
    contracts::validate_contract("packages", &Value::Array(snapshot.packages.iter().filter(|package| package.enabled).map(|package| package.manifest.clone()).collect()))
}
fn resolve_checked(snapshot: &Snapshot, actual_label: &str, request: &ActionRequest) -> Result<ResolvedAction, String> {
    let window = surface_window(&request.surface_id).ok_or("PermissionDenied")?;
    if actual_label != window || snapshot.safe_mode || request.id.len() > 160 || request.version.len() > 32 { return Err("PermissionDenied".into()); }
    let context = json!({"schemaVersion":1, "windowId":window, "surfaceId":request.surface_id, "revision":1});
    for package in snapshot.packages.iter().filter(|package| package.enabled && package.manifest["version"] == request.version) {
        let contributes = &package.manifest["contributes"];
        for menu in contributes["menus"].as_array().into_iter().flatten().filter(|menu| menu["location"] == request.surface_id && allows(menu, &context)) {
            if matches!(menu["presentation"].as_str(), Some("status" | "badge")) { continue; }
            let command_id = if let Some(children) = menu["items"].as_array() {
                match find_leaf(children, &request.id, &context) { Some(leaf) => &leaf["command"], None => continue }
            } else if menu["id"] == request.id { &menu["command"] } else { continue };
            if let Some(command) = contributes["commands"].as_array().into_iter().flatten().find(|command| &command["id"] == command_id && allows(command, &context)) {
                if matches!(command["action"]["kind"].as_str(), Some("showMessage" | "showDialog")) {
                    return Ok(ResolvedAction { owner: package.manifest["id"].as_str().unwrap_or_default().into(), context, action: command["action"].clone() });
                }
            }
        }
    }
    Err("PermissionDenied".into())
}
fn current(app: &tauri::AppHandle) -> Result<Snapshot, String> {
    Ok(app.state::<ExtensionPackages>().0.lock().map_err(|_| "Extension manager unavailable.")?.snapshot())
}
#[tauri::command]
pub fn extensions_window_snapshot(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Value, String> {
    if !AUXILIARY.contains(&window.label()) { return Err("PermissionDenied".into()); }
    Ok(json!({"windowId": window.label(), "snapshot": current(&app)?}))
}
#[tauri::command]
pub fn extensions_window_action(window: tauri::WebviewWindow, app: tauri::AppHandle, request: ActionRequest) -> Result<Value, String> {
    let resolved = resolve(&current(&app)?, window.label(), &request)?;
    if resolved.action["kind"] == "showDialog" {
        forward(&app, &request)?;
        Ok(Value::Null)
    } else { Ok(resolved.action) }
}
/// The main host can present only declared auxiliary UI data, never a forwarded core/native command.
#[tauri::command]
pub fn extensions_present_action(window: tauri::WebviewWindow, app: tauri::AppHandle, request: ActionRequest) -> Result<ResolvedAction, String> {
    if window.label() != "main" { return Err("PermissionDenied".into()); }
    resolve(&current(&app)?, surface_window(&request.surface_id).ok_or("PermissionDenied")?, &request)
}
pub fn forward(app: &tauri::AppHandle, request: &ActionRequest) -> Result<(), String> {
    crate::tray::show(app);
    app.emit_to("main", "extensions-present-action", request).map_err(|error| error.to_string())
}
pub fn changed(app: &tauri::AppHandle) {
    crate::tray::refresh_extension_menu(app);
    for label in ["main", "tray", "launcher", "agents-dock"] { let _ = app.emit_to(label, "extensions-changed", ()); }
}
/// A destroyed compact window owns no workspace services or global package registrations.
pub fn window_closed(app: &tauri::AppHandle, label: &str) {
    if AUXILIARY.contains(&label) { let _ = app.emit_to("main", "extensions-origin-closed", json!({"windowId":label})); }
}
pub fn recover(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<ExtensionPackages>().0.lock().map_err(|_| "Extension manager unavailable.")?.safe = true;
    changed(app); crate::tray::show(app); Ok(())
}
#[tauri::command]
pub fn extensions_window_recover(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    if !AUXILIARY.contains(&window.label()) { return Err("PermissionDenied".into()); }
    recover(&app)
}

/// Native menu model used by both the OS adapter and deterministic native policy tests.
#[derive(Clone, Serialize)]
pub struct NativeItem { pub id: String, pub title: String, pub enabled: bool, pub separator: bool, pub children: Vec<NativeItem>, pub request: Option<ActionRequest> }
pub fn native_items(snapshot: &Snapshot) -> Vec<NativeItem> {
    let mut output = Vec::new();
    if snapshot.safe_mode { return output; }
    let checked = checked_packages(snapshot);
    if checked["ok"] != true { return output; }
    let context = json!({"schemaVersion":1,"windowId":"tray","surfaceId":"panda.tray.menu","revision":1});
    fn children(items: &[Value], snapshot: &Snapshot, version: &str, context: &Value) -> Vec<NativeItem> {
        let mut output = Vec::new();
        for item in items.iter().filter(|item| item.get("visible").is_none_or(|condition| contracts::evaluate_condition(condition, context)["value"] == true)) {
            let nested = item["items"].as_array().map(|items| children(items, snapshot, version, context)).unwrap_or_default();
            if item["kind"] == "submenu" && nested.is_empty() { continue; }
            // Native check/radio entries are explicitly advertised as plain command actions.
            let request = ActionRequest { surface_id: "panda.tray.menu".into(), id: item["id"].as_str().unwrap_or_default().into(), version: version.into() };
            let enabled = if item["kind"] == "submenu" { allows(item, context) } else { resolve_checked(snapshot, "tray", &request).is_ok() };
            let separator = item["kind"] == "separator";
            if separator && output.last().is_none_or(|previous: &NativeItem| previous.separator) { continue; }
            output.push(NativeItem { id: format!("extension:{}", request.id), title: item["title"].as_str().unwrap_or("—").into(), enabled, separator, children: nested, request: (item["kind"] != "submenu" && !separator).then_some(request) });
        }
        if output.last().is_some_and(|item| item.separator) { output.pop(); }
        output
    }
    for package in snapshot.packages.iter().filter(|package| package.enabled) {
        let version = package.manifest["version"].as_str().unwrap_or_default();
        for menu in package.manifest["contributes"]["menus"].as_array().into_iter().flatten().filter(|menu| menu["location"] == "panda.tray.menu" && menu.get("visible").is_none_or(|condition| contracts::evaluate_condition(condition, &context)["value"] == true)) {
            let title = package.manifest["contributes"]["commands"].as_array().into_iter().flatten().find(|command| command["id"] == menu["command"]).and_then(|command| command["title"].as_str()).unwrap_or("Extension action");
            let nested = menu["items"].as_array().map(|items| children(items, snapshot, version, &context)).unwrap_or_default();
            if menu["items"].is_array() && nested.is_empty() { continue; }
            let request = ActionRequest { surface_id: "panda.tray.menu".into(), id: menu["id"].as_str().unwrap_or_default().into(), version: version.into() };
            output.push(NativeItem { id: format!("extension:{}", request.id), title: title.into(), enabled: if menu["items"].is_array() { allows(menu, &context) } else { resolve_checked(snapshot, "tray", &request).is_ok() }, separator: false, children: nested, request: (!menu["items"].is_array()).then_some(request) });
        }
    }
    let order = checked["value"]["menuOrder"].as_array();
    output.sort_by_key(|item| order.and_then(|order| order.iter().position(|id| item.id.strip_prefix("extension:") == id.as_str())).unwrap_or(usize::MAX));
    fn size(item: &NativeItem) -> usize { 1 + item.children.iter().map(size).sum::<usize>() }
    // Reserve the three protected OS actions and one diagnostic within the shared 128-item budget.
    let mut remaining = 124; let mut omitted = 0;
    output.retain(|item| { let count = size(item); if count > remaining { omitted += 1; false } else { remaining -= count; true } });
    if omitted > 0 { output.push(NativeItem { id: "extension-menu-limit".into(), title: format!("{omitted} extension groups unavailable (native menu limit)"), enabled: false, separator: false, children: vec![], request: None }); }
    output
}
pub fn menu_snapshot(app: &tauri::AppHandle) -> Vec<NativeItem> { current(app).map(|snapshot| native_items(&snapshot)).unwrap_or_default() }
pub fn native_selected(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    fn find(items: Vec<NativeItem>, id: &str) -> Option<ActionRequest> {
        for item in items {
            if !item.enabled { continue; }
            if item.id == id { return item.request; }
            if let Some(found) = find(item.children, id) { return Some(found); }
        }
        None
    }
    let snapshot = current(app)?;
    let request = find(native_items(&snapshot), id).ok_or("PermissionDenied")?;
    resolve(&snapshot, "tray", &request)?;
    forward(app, &request)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_dispatch_policy_never_inherits_main_or_other_window_grants() {
        for window in AUXILIARY {
            for command in ["extensions_window_snapshot", "extensions_window_action", "extensions_window_recover"] { assert!(command_allowed(window, command)); }
            for command in ["extensions_install", "extensions_snapshot", "extensions_enable", "extensions_uninstall", "extensions_settings_get", "extensions_settings_set", "extensions_safe_mode", "extensions_present_action", "read_file", "send_message", "run_process", "plugin:process|restart", "plugin:dialog|open"] { assert!(!command_allowed(window, command), "{window}: {command}"); }
        }
        assert!(command_allowed("tray", "tray_quit")); assert!(!command_allowed("launcher", "tray_quit"));
        assert!(command_allowed("launcher", "overlay_launch")); assert!(!command_allowed("tray", "overlay_launch"));
        assert!(command_allowed("agents-dock", "agents_dock_unpin")); assert!(!command_allowed("tray", "agents_dock_unpin"));
        for unknown in ["overlay", "secondary", "browser", "browser-1", "main-forged", ""] { for command in ["extensions_window_snapshot", "extensions_window_action", "extensions_install", "tray_quit"] { assert!(!command_allowed(unknown, command)); } }
        assert!(command_allowed("main", "extensions_install"));
    }
    #[test]
    fn action_request_rejects_forged_identity_context_and_raw_commands() {
        let valid = json!({"surfaceId":"panda.tray.actions", "id":"sample.window-laboratory/tray-form", "version":"1.0.0"});
        assert!(serde_json::from_value::<ActionRequest>(valid.clone()).is_ok());
        for key in ["windowId", "projectId", "sessionId", "command", "action", "context"] {
            let mut forged = valid.clone(); forged[key] = json!("main"); assert!(serde_json::from_value::<ActionRequest>(forged).is_err(), "{key}");
        }
        for capability in [include_str!("../../capabilities/tray.json"), include_str!("../../capabilities/launcher.json"), include_str!("../../capabilities/agents-dock.json")] {
            let value: Value = serde_json::from_str(capability).unwrap();
            assert!(!value["webviews"].as_array().unwrap().iter().any(|label| label == "main" || label == "*"));
            assert!(value["permissions"].as_array().unwrap().iter().all(|permission| permission.as_str().is_some_and(|name| name == "core:event:allow-listen" || name == "core:event:allow-unlisten" || name == "core:window:allow-start-dragging")));
        }
    }
}
