//! Host-owned isolated presentation. No package URLs/options or core service lifetime ownership.
use super::packages::{ExtensionPackages, Snapshot};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Mutex};
use tauri::Manager;

const CHANNEL: &str = include_str!("../../../src/extensions/rich-view-channel.js");
const CLIENT: &str = include_str!("../../../src/extensions/rich-view-client.js");
const HOST: &str = include_str!("../../../src/extensions/rich-view-host.js");
pub const UNSUPPORTED: &str = "Rich HTML views are disabled: installed native isolation qualification is pending. Use the host-rendered view instead.";

/// No installed WebView target has passed E16 yet. Not configurable by packages/env/trust.
pub fn native_qualified() -> bool { false }

#[derive(Clone, PartialEq, Serialize)]
pub struct RichAssets { pub html: String, pub css: String, pub script: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenRequest { view_id: String, version: String }
struct Presentation { owner: String, version: String, view: Value, assets: RichAssets }
#[derive(Default)]
pub struct RichViews(Mutex<BTreeMap<String, Presentation>>);

fn resolve(snapshot: &Snapshot, request: &OpenRequest) -> Result<Presentation, String> {
    if snapshot.safe_mode || request.view_id.len() > 160 || request.version.len() > 32 { return Err("PermissionDenied".into()); }
    for package in snapshot.packages.iter().filter(|package| package.enabled && package.manifest["version"] == request.version) {
        let permissions = package.manifest["permissions"].as_array().ok_or("PermissionDenied")?;
        if !permissions.contains(&json!("ui.contribute")) || !permissions.contains(&json!("ui.richViews")) { continue; }
        if let Some(view) = package.manifest["contributes"]["views"].as_array().into_iter().flatten().find(|view| view["id"] == request.view_id && view.get("rich").is_some()) {
            let assets = package.rich_assets.get(&request.view_id).ok_or("UnsafeAsset")?.clone();
            return Ok(Presentation { owner: package.manifest["id"].as_str().ok_or("PermissionDenied")?.into(), version: request.version.clone(), view: view.clone(), assets });
        }
    }
    Err("PermissionDenied".into())
}
fn hash(source: &str) -> String { format!("'sha256-{}'", STANDARD.encode(Sha256::digest(source.as_bytes()))) }
fn still_current(snapshot: &Snapshot, old: &Presentation) -> bool {
    resolve(snapshot, &OpenRequest { view_id: old.view["id"].as_str().unwrap_or_default().into(), version: old.version.clone() })
        .is_ok_and(|new| new.owner == old.owner && new.assets == old.assets && new.view == old.view)
}
fn escaped_json(value: &Value) -> String { value.to_string().replace('<', "\\u003c").replace('>', "\\u003e").replace('&', "\\u0026") }
fn document(presentation: &Presentation, label: &str, session: &str, dark: bool) -> String {
    let bootstrap = format!("{CHANNEL}\n{CLIENT}"); let shell = format!("{CHANNEL}\n{HOST}");
    let assets = &presentation.assets;
    let policy = format!("default-src 'none'; script-src {} {} {}; script-src-attr 'none'; style-src {}; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src about:; worker-src 'none'", hash(&bootstrap), hash(&assets.script), hash(&shell), hash(&assets.css));
    let meta = format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{policy}\"><meta name=\"referrer\" content=\"no-referrer\">");
    let session_json = escaped_json(&json!(session));
    let child = format!("<!doctype html><html><head>{meta}<style>{}</style></head><body>{}<script type=\"application/json\" id=\"panda-view-session\">{session_json}</script><script>{bootstrap}</script><script>{}</script></body></html>", assets.css, assets.html, assets.script);
    let config = escaped_json(&json!({"session":session, "document":child, "dto":{"schemaVersion":1,"owner":presentation.owner,"version":presentation.version,"viewId":presentation.view["id"],"windowId":label,"title":presentation.view["title"],"text":presentation.view["text"]},"theme":{"schemaVersion":1,"colorScheme":if dark { "dark" } else { "light" }}}));
    format!("<!doctype html><html><head>{meta}<title>Extension view</title></head><body><script type=\"application/json\" id=\"panda-view-config\">{config}</script><script>{shell}</script></body></html>")
}

#[tauri::command]
pub async fn extensions_rich_view_open(window: tauri::WebviewWindow, app: tauri::AppHandle, request: OpenRequest) -> Result<Value, String> {
    if window.label() != "main" { return Err("PermissionDenied".into()); }
    let snapshot = app.state::<ExtensionPackages>().0.lock().map_err(|_| "HostUnavailable")?.snapshot();
    let presentation = resolve(&snapshot, &request)?;
    if !native_qualified() { return Ok(json!({"opened":false,"reason":UNSUPPORTED})); }
    let label = format!("extension-view-{}", uuid::Uuid::new_v4());
    let session = uuid::Uuid::new_v4().to_string();
    let html = document(&presentation, &label, &session, window.theme().is_ok_and(|theme| theme == tauri::Theme::Dark));
    let url = format!("data:text/html;base64,{}", STANDARD.encode(html));
    let navigation = url.clone();
    let url = url.parse().map_err(|_| "UnsafeAsset")?;
    let state = app.state::<RichViews>();
    let mut views = state.0.lock().map_err(|_| "HostUnavailable")?;
    if views.len() >= 8 { return Err("LimitExceeded".into()); }
    views.insert(label.clone(), presentation); drop(views);
    let result = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
        .title("Extension view — experimental").inner_size(760.0, 560.0).min_inner_size(360.0, 240.0)
        .devtools(false).disable_drag_drop_handler()
        .on_navigation(move |next| next.as_str() == navigation)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build();
    let created = match result {
        Ok(created) => created,
        Err(_) => { state.0.lock().map_err(|_| "HostUnavailable")?.remove(&label); return Err("HostUnavailable".into()); }
    };
    // Revocation may have removed the reserved record before the OS window existed.
    // Reconcile after creation AND check the reservation: never leave that window orphaned.
    reconcile(&app);
    let retained = state.0.lock().map(|views| views.contains_key(&label)).unwrap_or(false);
    if !retained { let _ = created.close(); return Err("StaleContext".into()); }
    Ok(json!({"opened":true,"windowId":label}))
}

pub fn window_closed(app: &tauri::AppHandle, label: &str) {
    let Some(state) = app.try_state::<RichViews>() else { return };
    let Ok(mut views) = state.0.lock() else { return };
    if label != "main" { views.remove(label); return; }
    let close: Vec<_> = views.keys().cloned().collect(); views.clear(); drop(views);
    for label in close { if let Some(window) = app.get_webview_window(&label) { let _ = window.close(); } }
}
/// Revalidation also catches a same-version development reload; unrelated owners stay open.
pub fn reconcile(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<RichViews>() else { return };
    let Some(packages) = app.try_state::<ExtensionPackages>() else { return };
    let Ok(packages) = packages.0.lock() else { return }; let snapshot = packages.snapshot(); drop(packages);
    let Ok(mut views) = state.0.lock() else { return };
    let mut close = vec![];
    views.retain(|label, old| {
        let keep = still_current(&snapshot, old);
        if !keep { close.push(label.clone()); } keep
    });
    drop(views);
    for label in close { if let Some(window) = app.get_webview_window(&label) { let _ = window.close(); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_owner_version_grant_and_lifecycle_are_native_policy_not_payload_claims() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/rich-view/extension.json")).unwrap();
        let mut snapshot = super::super::packages::context_test_snapshot(manifest);
        snapshot.packages[0].rich_assets.insert("sample.rich-view/report".into(), RichAssets { html: "<p>report</p>".into(), css: String::new(), script: String::new() });
        let request = OpenRequest { view_id: "sample.rich-view/report".into(), version: "1.0.0".into() };
        let old = resolve(&snapshot, &request).unwrap(); assert_eq!(old.owner, "sample.rich-view");
        assert!(still_current(&snapshot, &old));
        snapshot.packages[0].rich_assets.get_mut(&request.view_id).unwrap().script = "changed same-version code".into();
        assert!(!still_current(&snapshot, &old));
        snapshot.packages[0].rich_assets.get_mut(&request.view_id).unwrap().script.clear();
        snapshot.packages[0].manifest["contributes"]["views"][0]["title"] = json!("Changed title");
        assert!(!still_current(&snapshot, &old));
        assert!(resolve(&snapshot, &OpenRequest { version: "1.0.1".into(), view_id: request.view_id.clone() }).is_err());
        snapshot.safe_mode = true; assert!(resolve(&snapshot, &request).is_err()); snapshot.safe_mode = false;
        snapshot.packages[0].enabled = false; assert!(resolve(&snapshot, &request).is_err()); snapshot.packages[0].enabled = true;
        snapshot.packages[0].manifest["permissions"] = json!(["ui.contribute"]); assert!(resolve(&snapshot, &request).is_err());
    }
    #[test]
    fn unqualified_targets_and_forged_window_options_fail_closed() {
        assert!(!native_qualified());
        let request = json!({"viewId":"sample.rich-view/report","version":"1.0.0"});
        assert!(serde_json::from_value::<OpenRequest>(request.clone()).is_ok());
        for key in ["owner", "windowId", "url", "capabilities", "session", "width", "projectId"] {
            let mut forged = request.clone(); forged[key] = json!("main"); assert!(serde_json::from_value::<OpenRequest>(forged).is_err());
        }
        for command in ["extensions_rich_view_open", "extensions_runtime", "extensions_context", "read_file", "plugin:event|emit", "plugin:window|create"] { assert!(!super::super::windows::command_allowed("extension-view-canary", command)); }
    }
    #[test]
    fn composed_document_has_no_broad_csp_and_escapes_package_data_in_host_config() {
        let presentation = Presentation { owner: "sample.rich-view".into(), version: "1.0.0".into(), view: json!({"id":"sample.rich-view/report","title":"</script><script>hostAttack()</script>","text":"fallback"}), assets: RichAssets { html: "<h1>Local</h1>".into(), css: "body{}".into(), script: "window.canary = true;".into() } };
        let html = document(&presentation, "extension-view-test", "session-test", false);
        assert!(html.contains("sandbox") && html.contains("allow-scripts"));
        assert!(html.contains("connect-src 'none'") && html.contains("form-action 'none'") && html.contains("worker-src 'none'"));
        assert!(!html.contains("unsafe-eval") && !html.contains("unsafe-inline") && !html.contains("blob:") && !html.contains("https:"));
        assert!(!html.contains("<script>hostAttack()"));
        assert!(html.contains("\\u003c/script\\u003e"));
        assert!(html.contains(&hash(&presentation.assets.script)));
    }
}
