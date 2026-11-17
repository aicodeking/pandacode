//! Host-owned isolated presentation. No package URLs/options or core service lifetime ownership.
use super::packages::{ExtensionPackages, Snapshot};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Mutex};
use tauri::Manager;
// R0301: the host mounts of rich panels live beside the window that shares their isolation (`rich_views::runtime_rich_mount`).
// The module uses `crate::extensions::` paths, so it may move to mod.rs unchanged; never declare it in both places.
#[path = "runtime_rich_mount.rs"]
pub mod runtime_rich_mount;
// R0302: panel folders, remote pages and per-package origins (`rich_views::runtime_rich_assets`); same rule as above.
#[path = "runtime_rich_assets.rs"]
pub mod runtime_rich_assets;
// R0303: panel instances and the panel-service channel (`rich_views::runtime_rich_channel`); same rule as above.
#[path = "runtime_rich_channel.rs"]
pub mod runtime_rich_channel;
// R0304: panel focus, forwarded keys, kept-alive hidden panels and minimum size (`rich_views::runtime_rich_focus`).
#[path = "runtime_rich_focus.rs"]
pub mod runtime_rich_focus;
// R0305: a package with panels and no service: its page work and the keyboard of an ending panel (`rich_views::runtime_panel_only`).
#[path = "runtime_panel_only.rs"]
pub mod runtime_panel_only;
use runtime_rich_assets::Source;

const CHANNEL: &str = include_str!("../../../src/extensions/rich-view-channel.js");
const CLIENT: &str = include_str!("../../../src/extensions/rich-view-client.js");
const HOST: &str = include_str!("../../../src/extensions/rich-view-host.js");
pub const UNSUPPORTED: &str = "Rich HTML views are disabled: installed native isolation qualification is pending. Use the host-rendered view instead.";

/// The per-platform functional qualification (R0301): a code table in `runtime_rich_mount`, turned on by that
/// platform's own evidence. Not configurable by packages, the environment or trust.
pub fn native_qualified() -> bool { runtime_rich_mount::platform_qualified() }

#[derive(Clone, PartialEq, Serialize)]
pub struct RichAssets { pub html: String, pub css: String, pub script: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenRequest { view_id: String, version: String }
/// What a view shows: the legacy inline triple (composed into a data document), or a folder or remote page served
/// from the package's own origin (R0302, `runtime_rich_assets`).
#[derive(Clone, PartialEq)]
enum Content { Inline(RichAssets), Served(Source) }
/// `generation` is the archive digest of a served view (its files are read from the archive at mount time).
struct Presentation { owner: String, version: String, view: Value, content: Content, generation: String }
#[derive(Default)]
pub struct RichViews(Mutex<BTreeMap<String, Presentation>>);

fn resolve(snapshot: &Snapshot, request: &OpenRequest) -> Result<Presentation, String> {
    if snapshot.safe_mode || request.view_id.len() > 160 || request.version.len() > 32 { return Err("PermissionDenied".into()); }
    for package in snapshot.packages.iter().filter(|package| package.enabled && package.manifest["version"] == request.version) {
        let permissions = package.manifest["permissions"].as_array().ok_or("PermissionDenied")?;
        if !permissions.contains(&json!("ui.contribute")) || !permissions.contains(&json!("ui.richViews")) { continue; }
        if let Some(view) = package.manifest["contributes"]["views"].as_array().into_iter().flatten().find(|view| view["id"] == request.view_id && view.get("rich").is_some()) {
            let owner: String = package.manifest["id"].as_str().ok_or("PermissionDenied")?.into();
            let (content, generation) = match runtime_rich_assets::source(&view["rich"]).map_err(|_| "UnsafeAsset")? {
                None => (Content::Inline(package.rich_assets.get(&request.view_id).ok_or("UnsafeAsset")?.clone()), String::new()),
                Some(source) => (Content::Served(source), package.executable_digest().ok_or("ExecutableTrustRequired")?.to_owned()),
            };
            return Ok(Presentation { owner, version: request.version.clone(), view: view.clone(), content, generation });
        }
    }
    Err("PermissionDenied".into())
}
/// What a mounted panel is pinned to: its owner, version and a fingerprint of the view and its assets (the archive
/// digest for a served folder), so a same-version reload, an update or a changed view ends the mount
/// (`runtime_rich_mount::reconcile`).
pub(super) struct Pinned { pub owner: String, pub version: String, pub fingerprint: String }
fn pinned(presentation: &Presentation) -> Pinned {
    let mut digest = Sha256::new();
    let parts = match &presentation.content {
        Content::Inline(assets) => vec![presentation.view.to_string(), assets.html.clone(), assets.css.clone(), assets.script.clone()],
        Content::Served(_) => vec![presentation.view.to_string(), presentation.generation.clone()],
    };
    for part in parts { digest.update((part.len() as u64).to_le_bytes()); digest.update(part.as_bytes()); }
    Pinned { owner: presentation.owner.clone(), version: presentation.version.clone(), fingerprint: format!("{:x}", digest.finalize()) }
}
/// Resolves a view for a host mount without composing it.
pub(super) fn pin(snapshot: &Snapshot, view_id: &str, version: &str) -> Result<Pinned, String> {
    Ok(pinned(&resolve(snapshot, &OpenRequest { view_id: view_id.into(), version: version.into() })?))
}
/// The composed panel document for a host mount of a legacy inline view (the same shell and isolation as the
/// separate window). The mounts open `panel_target`; tests read the composed document.
#[cfg(test)]
pub(super) fn panel_document(snapshot: &Snapshot, view_id: &str, version: &str, label: &str, dark: bool) -> Result<(Pinned, String), String> {
    let presentation = resolve(snapshot, &OpenRequest { view_id: view_id.into(), version: version.into() })?;
    let Content::Inline(assets) = &presentation.content else { return Err("UnsupportedContribution: a served panel opens through panel_target.".into()) };
    let session = uuid::Uuid::new_v4().to_string();
    Ok((pinned(&presentation), document(&presentation, assets, label, &session, dark)))
}
/// The address a host mount opens (R0302): a data document for a legacy inline view, else the shell on the
/// package's own origin (`runtime_rich_assets::prepare`, which registers the mount `label`; every teardown releases it).
pub(super) fn panel_target(app: &tauri::AppHandle, snapshot: &Snapshot, view_id: &str, version: &str, label: &str, dark: bool) -> Result<(Pinned, String), String> {
    let presentation = resolve(snapshot, &OpenRequest { view_id: view_id.into(), version: version.into() })?;
    Ok((pinned(&presentation), target(app, &presentation, label, dark)?))
}
fn target(app: &tauri::AppHandle, presentation: &Presentation, label: &str, dark: bool) -> Result<String, String> {
    match &presentation.content {
        Content::Inline(assets) => Ok(format!("data:text/html;base64,{}", STANDARD.encode(document(presentation, assets, label, &uuid::Uuid::new_v4().to_string(), dark)))),
        Content::Served(source) => runtime_rich_assets::prepare(app, &presentation.owner, &presentation.version, &presentation.generation, &presentation.view, source, label, dark),
    }
}
fn hash(source: &str) -> String { format!("'sha256-{}'", STANDARD.encode(Sha256::digest(source.as_bytes()))) }
fn still_current(snapshot: &Snapshot, old: &Presentation) -> bool {
    resolve(snapshot, &OpenRequest { view_id: old.view["id"].as_str().unwrap_or_default().into(), version: old.version.clone() })
        .is_ok_and(|new| new.owner == old.owner && new.content == old.content && new.view == old.view && new.generation == old.generation)
}
fn escaped_json(value: &Value) -> String { value.to_string().replace('<', "\\u003c").replace('>', "\\u003e").replace('&', "\\u0026") }
fn document(presentation: &Presentation, assets: &RichAssets, label: &str, session: &str, dark: bool) -> String {
    let bootstrap = format!("{CHANNEL}\n{CLIENT}"); let shell = format!("{CHANNEL}\n{HOST}");
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
    // R0301: executable trust and the `ui.richViews` grant, rechecked natively before any window exists.
    runtime_rich_mount::authorize_app(&app, &snapshot, &presentation.owner, &presentation.version)?;
    if !native_qualified() { return Ok(json!({"opened":false,"reason":UNSUPPORTED})); }
    let label = format!("extension-view-{}", uuid::Uuid::new_v4());
    if app.state::<RichViews>().0.lock().map_err(|_| "HostUnavailable")?.len() >= 8 { return Err("LimitExceeded".into()); }
    // R0302: a legacy view opens its data document; a folder or remote page opens the shell on the package origin.
    let url = target(&app, &presentation, &label, window.theme().is_ok_and(|theme| theme == tauri::Theme::Dark))?;
    // R0304: the shell keeps `rich.minSize` (its address fragment), and the window is never smaller than it.
    let (min_width, min_height) = runtime_rich_focus::min_size(&presentation.view);
    let url = runtime_rich_focus::sized(&url, (min_width, min_height));
    let navigation = url.clone();
    let url = match url.parse() { Ok(url) => url, Err(_) => { runtime_rich_assets::release(&label); return Err("UnsafeAsset".into()); } };
    let state = app.state::<RichViews>();
    let mut views = state.0.lock().map_err(|_| "HostUnavailable")?;
    if views.len() >= 8 { drop(views); runtime_rich_assets::release(&label); return Err("LimitExceeded".into()); }
    views.insert(label.clone(), presentation); drop(views);
    let result = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
        .title("Extension view — experimental").inner_size(760f64.max(min_width as f64), 560f64.max(min_height as f64)).min_inner_size(360f64.max(min_width as f64), 240f64.max(min_height as f64))
        // The package origin's scheme is pinned (its storage is keyed by it).
        .use_https_scheme(false)
        .devtools(false).disable_drag_drop_handler()
        .on_navigation(move |next| next.as_str() == navigation)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_document_title_changed(|view, title| runtime_rich_mount::observe_title(view.app_handle(), view.label(), &title))
        .build();
    let created = match result {
        Ok(created) => created,
        Err(_) => { runtime_rich_assets::release(&label); state.0.lock().map_err(|_| "HostUnavailable")?.remove(&label); return Err("HostUnavailable".into()); }
    };
    // Revocation may have removed the reserved record before the OS window existed.
    // Reconcile after creation AND check the reservation: never leave that window orphaned.
    reconcile(&app);
    let retained = state.0.lock().map(|views| views.contains_key(&label)).unwrap_or(false);
    if !retained { runtime_rich_assets::release(&label); let _ = created.close(); return Err("StaleContext".into()); }
    runtime_rich_mount::watch(&app, &label, runtime_rich_mount::Kind::Window);
    Ok(json!({"opened":true,"windowId":label}))
}

pub fn window_closed(app: &tauri::AppHandle, label: &str) {
    runtime_rich_mount::window_closed(app, label);
    let Some(state) = app.try_state::<RichViews>() else { return };
    let Ok(mut views) = state.0.lock() else { return };
    if label != "main" { views.remove(label); return; }
    let close: Vec<_> = views.keys().cloned().collect(); views.clear(); drop(views);
    for label in close { runtime_rich_mount::forget(app, &label); if let Some(window) = app.get_webview_window(&label) { let _ = window.close(); } }
}
/// Revalidation also catches a same-version development reload; unrelated owners stay open.
pub fn reconcile(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<RichViews>() else { return };
    let Some(packages) = app.try_state::<ExtensionPackages>() else { return };
    let Ok(packages) = packages.0.lock() else { return }; let snapshot = packages.snapshot(); drop(packages);
    let Ok(mut views) = state.0.lock() else { return };
    let mut close = vec![];
    views.retain(|label, old| {
        // Disable, safe mode, a changed view, an untrusted digest or a revoked `ui.richViews` all close the window.
        let keep = still_current(&snapshot, old) && runtime_rich_mount::authorize_app(app, &snapshot, &old.owner, &old.version).is_ok();
        if !keep { close.push(label.clone()); } keep
    });
    drop(views);
    for label in close { runtime_rich_mount::forget(app, &label); if let Some(window) = app.get_webview_window(&label) { let _ = window.close(); } }
    runtime_rich_mount::reconcile(app);
    // R0303: closed panel instances of packages that may no longer show panels lose their state.
    runtime_rich_channel::reconcile(app);
    // R0305: the work of pages of packages without a service ends with their panel authority, even if a panel failed.
    runtime_panel_only::reconcile(app);
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
        // R0301: the gate is a per-platform table; targets without their own evidence stay closed.
        assert_eq!(native_qualified(), super::runtime_rich_mount::qualified_for(super::super::runtime_platform_qualification::current_target()));
        // Q025 (R0306): changed for the permissioned path: Windows x64 opens rich panels and windows for a trusted
        // package holding `ui.richViews` (its installed record: docs/extensions/runtime-windows-panels.md). Retained:
        // macOS and Linux answer UnsupportedRuntime (predictability: no installed evidence there, never inferred); the
        // forged request fields below fail as InvalidShape (interface stability: the host takes the address and size
        // from the manifest, `rich.minSize` is the permissioned size); an `extension-view-*` label gets no command
        // (fault isolation, interface stability: panels use the channel). None of these is a security limit.
        assert!(super::runtime_rich_mount::qualified_for(Some("windows-x64")));
        for target in ["macos-arm64", "macos-x64", "linux-x64", "linux-arm64"] { assert!(!super::runtime_rich_mount::qualified_for(Some(target)), "{target}"); }
        assert!(!super::runtime_rich_mount::qualified_for(None));
        let request = json!({"viewId":"sample.rich-view/report","version":"1.0.0"});
        assert!(serde_json::from_value::<OpenRequest>(request.clone()).is_ok());
        for key in ["owner", "windowId", "url", "capabilities", "session", "width", "projectId"] {
            let mut forged = request.clone(); forged[key] = json!("main"); assert!(serde_json::from_value::<OpenRequest>(forged).is_err());
        }
        for command in ["extensions_rich_view_open", "extensions_runtime", "extensions_context", "read_file", "plugin:event|emit", "plugin:window|create"] { assert!(!super::super::windows::command_allowed("extension-view-canary", command)); }
    }
    #[test]
    fn composed_document_has_no_broad_csp_and_escapes_package_data_in_host_config() {
        // Q026 (R0302): retained for the legacy inline form, whose host-composed document inlines the package's files
        // and pins them by hash (predictability of that composition, not a security limit). The permissioned path
        // with network, workers and eval is a folder or remote panel on its own origin, which gets no host policy
        // (`runtime_rich_assets::tests::package_files_carry_media_types_and_no_content_policy_...`).
        let assets = RichAssets { html: "<h1>Local</h1>".into(), css: "body{}".into(), script: "window.canary = true;".into() };
        let presentation = Presentation { owner: "sample.rich-view".into(), version: "1.0.0".into(), view: json!({"id":"sample.rich-view/report","title":"</script><script>hostAttack()</script>","text":"fallback"}), content: Content::Inline(assets.clone()), generation: String::new() };
        let html = document(&presentation, &assets, "extension-view-test", "session-test", false);
        assert!(html.contains("sandbox") && html.contains("allow-scripts"));
        assert!(html.contains("connect-src 'none'") && html.contains("form-action 'none'") && html.contains("worker-src 'none'"));
        assert!(!html.contains("unsafe-eval") && !html.contains("unsafe-inline") && !html.contains("blob:") && !html.contains("https:"));
        assert!(!html.contains("<script>hostAttack()"));
        assert!(html.contains("\\u003c/script\\u003e"));
        assert!(html.contains(&hash(&assets.script)));
    }
}
