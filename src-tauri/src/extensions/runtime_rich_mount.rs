//! Trusted rich panels mounted in host surfaces (R0301, ADR-0001).
//!
//! A view with `rich` content mounts where a host-rendered view mounts: the inspector, as a child webview of the
//! main window placed over the inspector's panel element (the app's content policy keeps `frame-src 'none'`, so an
//! installed panel is never an iframe of the app document). The separate window of `rich_views.rs` stays and shares
//! the same authorization, qualification, watchdog and teardown:
//!
//! - **Qualification.** A per-platform code table (`RICH_TARGETS`), turned on by that platform's own evidence;
//!   every other target answers `UnsupportedRuntime` and the view keeps its host-rendered `text`.
//! - **Authorization.** The package is enabled, outside safe mode, its executable content is trusted (a package with
//!   rich content is code, ADR-0001) and it holds `ui.richViews` in the grants file, checked natively on every open
//!   and again on every lifecycle change (`reconcile`).
//! - **Isolation.** The panel webview carries no command grant (`windows::command_allowed` refuses every label but
//!   the main and auxiliary ones, and no capability names `extension-panel-*`). This is fault isolation and
//!   interface stability (ADR-0005), not a security limit.
//! - **Fault containment.** The panel shell reports a heartbeat through its document title (no IPC). A panel that
//!   reports a failure, never starts or stops beating is destroyed and the main window is told
//!   (`extensions-rich-mount-ended`), so it shows the failure with a reload control; tasks, terminals and the draft
//!   are never touched.
use crate::extensions::{packages::{ExtensionPackages, Snapshot}, rich_views, runtime_grants::{RuntimeGrants, Target}, runtime_platform_qualification as platform, rich_views::runtime_rich_channel as channel, rich_views::runtime_rich_focus as focus};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::{Duration, Instant}};
use tauri::{Emitter, Manager};

pub const PERMISSION: &str = "ui.richViews";
/// Targets whose installed qualification turned rich panels on. Windows x64 first (the runtime lane's order).
pub const RICH_TARGETS: &[&str] = &["windows-x64"];
pub const PANEL_PREFIX: &str = "extension-panel-";
pub const ENDED_EVENT: &str = "extensions-rich-mount-ended";
pub const UNQUALIFIED: &str = "UnsupportedRuntime: rich panels are not qualified on this platform yet. The host-rendered view stays available.";
/// Live inspector mounts in the whole application (memory of the webviews); the eight windows are counted apart.
pub const MOUNT_LIMIT: usize = 8;
pub const FIRST_BEAT: Duration = Duration::from_secs(10);
pub const SILENCE: Duration = Duration::from_secs(6);
const TICK: Duration = Duration::from_secs(1);
const DENIED: &str = "PermissionDenied";
const TRUST: &str = "ExecutableTrustRequired: review this version and its executable content first.";

pub fn qualified_for(target: Option<&str>) -> bool { target.is_some_and(|target| RICH_TARGETS.contains(&target) && platform::MATRIX.contains(&target)) }
pub fn platform_qualified() -> bool { qualified_for(platform::current_target()) }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind { Panel, Window }
struct Watch { kind: Kind, started: Instant, last_beat: Option<Instant>, failed: Option<String>, paused: bool }
#[derive(Clone)]
struct Panel { owner: String, version: String, view_id: String, fingerprint: String }
#[derive(Default)]
struct Inner { panels: BTreeMap<String, Panel>, watches: BTreeMap<String, Watch> }
#[derive(Default)]
pub struct RichMounts { inner: Mutex<Inner>, running: AtomicBool }

/// What the panel shell writes in its document title. Nothing else in the title means anything.
#[derive(Debug, PartialEq, Eq)]
pub enum Signal { Beat(u64), Failed(String) }
pub fn signal(title: &str) -> Option<Signal> {
    if let Some(count) = title.strip_prefix("panda-view:alive:") { return count.parse().ok().map(Signal::Beat); }
    let reason = title.strip_prefix("panda-view:failed:")?;
    (!reason.is_empty() && reason.len() <= 32 && reason.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'-')).then(|| Signal::Failed(reason.into()))
}

#[derive(Debug, PartialEq, Eq)]
pub enum Liveness { Starting, Alive, Failed(String), Unresponsive }
/// A pure function of the watch, so the timeline is tested without a webview.
pub fn liveness(started: Instant, last_beat: Option<Instant>, failed: Option<&str>, paused: bool, now: Instant) -> Liveness {
    if let Some(reason) = failed { return Liveness::Failed(reason.into()); }
    if paused { return if last_beat.is_some() { Liveness::Alive } else { Liveness::Starting }; }
    match last_beat {
        None if now.saturating_duration_since(started) > FIRST_BEAT => Liveness::Unresponsive,
        None => Liveness::Starting,
        Some(beat) if now.saturating_duration_since(beat) > SILENCE => Liveness::Unresponsive,
        Some(_) => Liveness::Alive,
    }
}

/// The authority behind every open and every kept mount.
pub fn authorize(snapshot: &Snapshot, grants: Option<&RuntimeGrants>, owner: &str, version: &str) -> Result<(), String> {
    if snapshot.safe_mode { return Err(DENIED.into()); }
    let package = snapshot.packages.iter().find(|package| package.manifest["id"] == owner && package.manifest["version"] == version).ok_or(DENIED)?;
    if !package.enabled { return Err(DENIED.into()); }
    if package.executable_trusted() != Some(true) { return Err(TRUST.into()); }
    grants.ok_or(DENIED)?.check(owner, version, PERMISSION, &Target::default())
}
fn synced_grants<'a>(app: &'a tauri::AppHandle, snapshot: &Snapshot) -> Option<tauri::State<'a, RuntimeGrants>> {
    let grants = app.try_state::<RuntimeGrants>()?;
    if let Ok(value) = serde_json::to_value(snapshot) { let _ = grants.sync(&value); }
    Some(grants)
}
pub fn authorize_app(app: &tauri::AppHandle, snapshot: &Snapshot, owner: &str, version: &str) -> Result<(), String> {
    let grants = synced_grants(app, snapshot);
    authorize(snapshot, grants.as_ref().map(|grants| grants.inner()), owner, version)
}
/// Why a mount must end now, or `None` while it is still current and authorized.
fn end_reason(snapshot: &Snapshot, grants: Option<&RuntimeGrants>, panel: &Panel) -> Option<&'static str> {
    if snapshot.safe_mode { return Some("safe-mode"); }
    match rich_views::pin(snapshot, &panel.view_id, &panel.version) {
        Err(_) => return Some("disabled"),
        Ok(pinned) if pinned.owner != panel.owner || pinned.fingerprint != panel.fingerprint => return Some("changed"),
        Ok(_) => {}
    }
    match authorize(snapshot, grants, &panel.owner, &panel.version) {
        Ok(()) => None,
        Err(error) if error.starts_with("ExecutableTrustRequired") => Some("untrusted"),
        Err(_) => Some("revoked"),
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Bounds { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }
/// Logical points of the main window. The page measures them; anything else is refused, never clamped silently.
pub fn bounded(bounds: Bounds) -> Result<Bounds, String> {
    let values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if !values.iter().all(|value| value.is_finite() && *value <= 32768.0) || bounds.x < 0.0 || bounds.y < 0.0 || bounds.width < 1.0 || bounds.height < 1.0 { return Err("InvalidShape".into()); }
    Ok(bounds)
}
/// Placements of this slice. `window` is the existing separate window; `floating` waits for the editor window.
pub fn placement(value: &str) -> Result<(), String> {
    match value {
        "inspector" => Ok(()),
        "window" => Err("UnsupportedContribution: the separate window opens through extensions_rich_view_open.".into()),
        "floating" => Err("UnsupportedContribution: the floating placement waits for the editor window.".into()),
        _ => Err("InvalidShape".into()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MountRequest { view_id: String, version: String, placement: String, bounds: Bounds }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoundsRequest { mount_id: String, bounds: Bounds, visible: bool }

fn rect(bounds: Bounds) -> tauri::Rect {
    tauri::Rect { position: tauri::LogicalPosition::new(bounds.x, bounds.y).into(), size: tauri::LogicalSize::new(bounds.width, bounds.height).into() }
}
/// R0304: the view of a live inspector mount (`None` for any other label).
pub fn panel_view(app: &tauri::AppHandle, label: &str) -> Option<String> {
    app.try_state::<RichMounts>()?.inner.lock().ok()?.panels.get(label).map(|panel| panel.view_id.clone())
}
fn owned(app: &tauri::AppHandle, label: &str) -> bool {
    label.starts_with(PANEL_PREFIX) && app.try_state::<RichMounts>().is_some_and(|state| state.inner.lock().is_ok_and(|inner| inner.panels.contains_key(label)))
}

#[tauri::command]
pub async fn extensions_rich_mount_open(caller: tauri::Webview, app: tauri::AppHandle, request: MountRequest) -> Result<Value, String> {
    if caller.label() != "main" || request.view_id.len() > 160 || request.version.len() > 32 { return Err(DENIED.into()); }
    placement(&request.placement)?;
    let bounds = bounded(request.bounds)?;
    let snapshot = app.state::<ExtensionPackages>().0.lock().map_err(|_| "HostUnavailable")?.snapshot();
    let pinned = rich_views::pin(&snapshot, &request.view_id, &request.version)?;
    authorize_app(&app, &snapshot, &pinned.owner, &pinned.version)?;
    if !platform_qualified() { return Ok(json!({"mounted": false, "reason": UNQUALIFIED})); }
    let window = caller.window();
    let label = format!("{PANEL_PREFIX}{}", uuid::Uuid::new_v4());
    let dark = window.theme().is_ok_and(|theme| theme == tauri::Theme::Dark);
    // R0302: a legacy inline view opens its data document; a folder or remote page opens the shell on the package's
    // own origin (`runtime_rich_assets`), registered under `label` until `forget` releases it.
    let (pinned, url) = rich_views::panel_target(&app, &snapshot, &request.view_id, &request.version, &label, dark)?;
    // R0304: the shell keeps `rich.minSize` and scrolls (its address fragment; the webview covers only what is visible).
    let size = focus::declared_view(&snapshot, &pinned.owner, &pinned.version, &request.view_id).map_or((focus::MIN_WIDTH, focus::MIN_HEIGHT), focus::min_size);
    let url = focus::sized(&url, size);
    let navigation = url.clone();
    let Ok(parsed) = url.parse() else { forget(&app, &label); return Err("UnsafeAsset".into()) };
    {
        let state = app.state::<RichMounts>();
        let mut inner = state.inner.lock().map_err(|_| "HostUnavailable")?;
        if inner.panels.len() >= MOUNT_LIMIT { drop(inner); forget(&app, &label); return Err("LimitExceeded".into()); }
        inner.panels.insert(label.clone(), Panel { owner: pinned.owner, version: pinned.version, view_id: request.view_id.clone(), fingerprint: pinned.fingerprint });
    }
    let builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed))
        // The package origin's scheme is pinned (its page storage is keyed by it).
        .use_https_scheme(false)
        .devtools(false)
        .disable_drag_drop_handler()
        // The panel may not navigate away from its own document nor open windows (a panel cannot replace the app).
        .on_navigation(move |next| next.as_str() == navigation)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .on_document_title_changed(|view, title| observe_title(view.app_handle(), view.label(), &title));
    let created = match window.add_child(builder, tauri::LogicalPosition::new(bounds.x, bounds.y), tauri::LogicalSize::new(bounds.width, bounds.height)) {
        Ok(view) => view,
        Err(_) => { forget(&app, &label); return Err("HostUnavailable".into()); }
    };
    // A disable, revoke or safe mode that raced the creation wins: never leave an orphaned panel webview.
    reconcile(&app);
    if !owned(&app, &label) { let _ = created.close(); return Err("StaleContext".into()); }
    watch(&app, &label, Kind::Panel);
    Ok(json!({"mounted": true, "mountId": label}))
}

#[tauri::command]
pub async fn extensions_rich_mount_bounds(caller: tauri::Webview, app: tauri::AppHandle, request: BoundsRequest) -> Result<(), String> {
    if caller.label() != "main" { return Err(DENIED.into()); }
    let bounds = bounded(request.bounds)?;
    if !owned(&app, &request.mount_id) { return Err("StaleContext".into()); }
    let view = app.get_webview(&request.mount_id).ok_or("StaleContext")?;
    view.set_bounds(rect(bounds)).map_err(|_| "HostUnavailable")?;
    // R0304: a parked panel stays hidden until it is resumed (a late bounds call of its old slot must not show it).
    let visible = request.visible && !focus::parked(&request.mount_id);
    if visible { view.show() } else { view.hide() }.map_err(|_| "HostUnavailable")?;
    pause(&app, &request.mount_id, !visible);
    Ok(())
}

#[tauri::command]
pub async fn extensions_rich_mount_close(caller: tauri::Webview, app: tauri::AppHandle, mount_id: String) -> Result<(), String> {
    if caller.label() != "main" || !mount_id.starts_with(PANEL_PREFIX) { return Err(DENIED.into()); }
    // R0303: a closed inspector panel keeps its instance's state for a reopen in this run.
    forget_keeping(&app, &mount_id, true);
    if let Some(view) = app.get_webview(&mount_id) { let _ = view.close(); }
    Ok(())
}

/// Called by the title callback of every panel and separate window (main thread): records a beat or a failure.
pub fn observe_title(app: &tauri::AppHandle, label: &str, title: &str) {
    // R0304: the inline shell's forwarded keys and releaseFocus share this channel.
    if focus::observe_title(app, label, title) { return; }
    let Some(signal) = signal(title) else { return };
    let Some(state) = app.try_state::<RichMounts>() else { return };
    let Ok(mut inner) = state.inner.lock() else { return };
    if let Some(watch) = inner.watches.get_mut(label) {
        match signal { Signal::Beat(_) => watch.last_beat = Some(Instant::now()), Signal::Failed(reason) => watch.failed = Some(reason) }
    }
}
pub fn watch(app: &tauri::AppHandle, label: &str, kind: Kind) {
    let Some(state) = app.try_state::<RichMounts>() else { return };
    if let Ok(mut inner) = state.inner.lock() { inner.watches.insert(label.into(), Watch { kind, started: Instant::now(), last_beat: None, failed: None, paused: false }); } else { return; }
    if state.running.swap(true, Ordering::SeqCst) { return; }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("rich-panel-watchdog".into()).spawn(move || loop {
        std::thread::sleep(TICK);
        if !tick(&app) { return; }
    });
    if spawned.is_err() { state.running.store(false, Ordering::SeqCst); }
}
/// A hidden panel's timers may be throttled: its watch pauses and restarts its clock when shown again.
pub fn pause(app: &tauri::AppHandle, label: &str, paused: bool) {
    let Some(state) = app.try_state::<RichMounts>() else { return };
    {
        let Ok(mut inner) = state.inner.lock() else { return };
        if let Some(watch) = inner.watches.get_mut(label) {
            if watch.paused && !paused { if watch.last_beat.is_some() { watch.last_beat = Some(Instant::now()); } else { watch.started = Instant::now(); } }
            watch.paused = paused;
        }
    }
    // R0303: the instance and its service hear a change of visibility (once per change).
    channel::visibility(app, label, !paused);
}
/// One watchdog pass; `false` ends the thread when nothing is watched. Window state is read without holding the lock
/// (the main thread takes it in `observe_title`).
fn tick(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<RichMounts>() else { return false };
    let windows: Vec<String> = match state.inner.lock() {
        Ok(inner) => {
            if inner.watches.is_empty() { state.running.store(false, Ordering::SeqCst); return false; }
            inner.watches.iter().filter(|(_, watch)| watch.kind == Kind::Window).map(|(label, _)| label.clone()).collect()
        }
        Err(_) => { state.running.store(false, Ordering::SeqCst); return false; }
    };
    let away: Vec<(String, bool)> = windows.into_iter().map(|label| {
        let away = app.get_webview_window(&label).is_some_and(|window| window.is_minimized().unwrap_or(false) || !window.is_visible().unwrap_or(true));
        (label, away)
    }).collect();
    for (label, away) in away { pause(app, &label, away); }
    let now = Instant::now();
    let mut ended = vec![];
    if let Ok(mut inner) = state.inner.lock() {
        for (label, watch) in inner.watches.iter_mut() {
            match liveness(watch.started, watch.last_beat, watch.failed.as_deref(), watch.paused, now) {
                Liveness::Unresponsive => ended.push((label.clone(), watch.kind, "unresponsive".to_string())),
                // A separate window shows its own failure and reload control; its watch starts over.
                Liveness::Failed(_) if watch.kind == Kind::Window => { watch.failed = None; watch.last_beat = None; watch.started = now; }
                Liveness::Failed(reason) => ended.push((label.clone(), watch.kind, reason)),
                Liveness::Starting | Liveness::Alive => {}
            }
        }
    }
    for (label, kind, reason) in ended { end(app, &label, kind, &reason); }
    true
}
fn end(app: &tauri::AppHandle, label: &str, kind: Kind, reason: &str) {
    // R0303: a failed panel keeps its instance's state for the reload; a lifecycle end drops it.
    forget_keeping(app, label, matches!(reason, "unresponsive" | "error" | "timeout" | "origin"));
    match kind {
        Kind::Panel => {
            if let Some(view) = app.get_webview(label) { let _ = view.close(); }
            let _ = app.emit_to("main", ENDED_EVENT, json!({"mountId": label, "reason": reason}));
        }
        Kind::Window => { if let Some(window) = app.get_webview_window(label) { let _ = window.close(); } }
    }
}
pub fn forget(app: &tauri::AppHandle, label: &str) { forget_keeping(app, label, false); }
/// Every teardown: the served folder goes with its last mount (R0302); the instance closes, keeping its state for a
/// reopen when `keep` (R0303).
pub fn forget_keeping(app: &tauri::AppHandle, label: &str, keep: bool) {
    rich_views::runtime_rich_assets::release(label);
    // R0304: a parked panel that ends is no longer counted.
    focus::forget(label);
    channel::detach(app, label, keep);
    let Some(state) = app.try_state::<RichMounts>() else { return };
    let Ok(mut inner) = state.inner.lock() else { return };
    inner.panels.remove(label); inner.watches.remove(label);
}
/// The main window going away takes every panel with it; a separate window only forgets its own watch.
pub fn window_closed(app: &tauri::AppHandle, label: &str) {
    if label != "main" { forget(app, label); return; }
    let Some(state) = app.try_state::<RichMounts>() else { return };
    let panels: Vec<String> = match state.inner.lock() {
        Ok(mut inner) => { let panels: Vec<String> = inner.panels.keys().cloned().collect(); for label in &panels { inner.watches.remove(label); } inner.panels.clear(); panels }
        Err(_) => return,
    };
    for label in panels { rich_views::runtime_rich_assets::release(&label); focus::forget(&label); channel::detach(app, &label, false); if let Some(view) = app.get_webview(&label) { let _ = view.close(); } }
}
/// Disable, uninstall, update, safe mode, untrust and revoke end the mounts they no longer allow (`rich_views::reconcile`
/// calls this after every lifecycle change; the grant command calls `sweep_app`).
pub fn reconcile(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<RichMounts>() else { return };
    let Some(packages) = app.try_state::<ExtensionPackages>() else { return };
    let snapshot = match packages.0.lock() { Ok(packages) => packages.snapshot(), Err(_) => return };
    let panels: Vec<(String, Panel)> = match state.inner.lock() { Ok(inner) => inner.panels.iter().map(|(label, panel)| (label.clone(), panel.clone())).collect(), Err(_) => return };
    if panels.is_empty() { return; }
    let grants = synced_grants(app, &snapshot);
    let ended: Vec<(String, &'static str)> = panels.iter().filter_map(|(label, panel)| end_reason(&snapshot, grants.as_ref().map(|grants| grants.inner()), panel).map(|reason| (label.clone(), reason))).collect();
    for (label, reason) in ended { end(app, &label, Kind::Panel, reason); }
}
/// After a grant change: the separate windows and the inspector mounts.
pub fn sweep_app(app: &tauri::AppHandle) { rich_views::reconcile(app); }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::runtime_grants::Scope;
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-rich-mount/extension.json");
    const VIEW: &str = "sample.rich-mount/board";
    struct Dir(std::path::PathBuf);
    impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-rich-mount-test-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn snapshot(trusted: Option<bool>) -> Snapshot {
        let mut snapshot = crate::extensions::packages::context_test_snapshot(serde_json::from_str(MANIFEST).unwrap());
        snapshot.packages[0].rich_assets.insert(VIEW.into(), rich_views::RichAssets { html: "<p id=\"board\"></p>".into(), css: String::new(), script: String::new() });
        snapshot.packages[0].set_executable_for_test(trusted);
        snapshot
    }
    fn granted(dir: &Dir) -> RuntimeGrants {
        let grants = RuntimeGrants::open(&dir.0);
        grants.register_package("sample.rich-mount", "1.0.0", &["ui.contribute", "ui.richViews"], Some("digest-a")).unwrap();
        grants.trust("sample.rich-mount", true).unwrap();
        grants.grant("sample.rich-mount", PERMISSION, Scope::default()).unwrap();
        grants
    }
    fn panel(snapshot: &Snapshot) -> Panel {
        let pinned = rich_views::pin(snapshot, VIEW, "1.0.0").unwrap();
        Panel { owner: pinned.owner, version: pinned.version, view_id: VIEW.into(), fingerprint: pinned.fingerprint }
    }

    #[test]
    fn qualification_is_a_per_platform_table_and_unlisted_targets_stay_unsupported() {
        assert!(qualified_for(Some("windows-x64")));
        for target in ["macos-arm64", "macos-x64", "linux-x64", "linux-arm64", "plan9-mips"] { assert!(!qualified_for(Some(target)), "{target}"); }
        assert!(!qualified_for(None));
        assert_eq!(platform_qualified(), qualified_for(platform::current_target()));
        assert!(UNQUALIFIED.starts_with("UnsupportedRuntime"));
    }

    #[test]
    fn a_mount_needs_enabled_trusted_granted_content_outside_safe_mode() {
        let dir = Dir::new(); let grants = granted(&dir);
        // A rich package without trust answers ExecutableTrustRequired, and no grant answers PermissionDenied.
        assert!(authorize(&snapshot(Some(false)), Some(&grants), "sample.rich-mount", "1.0.0").unwrap_err().starts_with("ExecutableTrustRequired"));
        assert!(authorize(&snapshot(None), Some(&grants), "sample.rich-mount", "1.0.0").unwrap_err().starts_with("ExecutableTrustRequired"));
        assert_eq!(authorize(&snapshot(Some(true)), None, "sample.rich-mount", "1.0.0").unwrap_err(), DENIED);
        authorize(&snapshot(Some(true)), Some(&grants), "sample.rich-mount", "1.0.0").unwrap();
        // Stale version and foreign owner stay refused (predictability: the grant belongs to the installed version).
        assert_eq!(authorize(&snapshot(Some(true)), Some(&grants), "sample.rich-mount", "1.0.1").unwrap_err(), DENIED);
        assert_eq!(authorize(&snapshot(Some(true)), Some(&grants), "sample.other", "1.0.0").unwrap_err(), DENIED);
        let mut disabled = snapshot(Some(true)); disabled.packages[0].enabled = false;
        assert_eq!(authorize(&disabled, Some(&grants), "sample.rich-mount", "1.0.0").unwrap_err(), DENIED);
        let mut safe = snapshot(Some(true)); safe.safe_mode = true;
        assert_eq!(authorize(&safe, Some(&grants), "sample.rich-mount", "1.0.0").unwrap_err(), DENIED);
        grants.revoke("sample.rich-mount", PERMISSION).unwrap();
        assert_eq!(authorize(&snapshot(Some(true)), Some(&grants), "sample.rich-mount", "1.0.0").unwrap_err(), DENIED);
    }

    #[test]
    fn disable_revoke_untrust_change_and_safe_mode_each_end_a_live_mount() {
        let dir = Dir::new(); let grants = granted(&dir);
        let live = snapshot(Some(true)); let mounted = panel(&live);
        assert_eq!(end_reason(&live, Some(&grants), &mounted), None);
        let mut safe = snapshot(Some(true)); safe.safe_mode = true;
        assert_eq!(end_reason(&safe, Some(&grants), &mounted), Some("safe-mode"));
        let mut disabled = snapshot(Some(true)); disabled.packages[0].enabled = false;
        assert_eq!(end_reason(&disabled, Some(&grants), &mounted), Some("disabled"));
        let mut changed = snapshot(Some(true)); changed.packages[0].rich_assets.get_mut(VIEW).unwrap().script = "changed same-version code".into();
        assert_eq!(end_reason(&changed, Some(&grants), &mounted), Some("changed"));
        assert_eq!(end_reason(&snapshot(Some(false)), Some(&grants), &mounted), Some("untrusted"));
        grants.revoke("sample.rich-mount", PERMISSION).unwrap();
        assert_eq!(end_reason(&live, Some(&grants), &mounted), Some("revoked"));
    }

    #[test]
    fn heartbeat_titles_and_liveness_timeline_contain_throwing_and_looping_panels() {
        assert_eq!(signal("panda-view:alive:7"), Some(Signal::Beat(7)));
        assert_eq!(signal("panda-view:failed:error"), Some(Signal::Failed("error".into())));
        for title in ["Extension view", "panda-view:alive:x", "panda-view:failed:", "panda-view:failed:Error", "panda-view:failed:a b", &format!("panda-view:failed:{}", "a".repeat(33))] { assert_eq!(signal(title), None, "{title}"); }
        let start = Instant::now();
        assert_eq!(liveness(start, None, None, false, start + Duration::from_secs(2)), Liveness::Starting);
        // Never started (a panel that loops before its first beat).
        assert_eq!(liveness(start, None, None, false, start + FIRST_BEAT + TICK), Liveness::Unresponsive);
        let beat = start + Duration::from_secs(3);
        assert_eq!(liveness(start, Some(beat), None, false, beat + Duration::from_secs(2)), Liveness::Alive);
        // Stopped beating (a panel that loops later).
        assert_eq!(liveness(start, Some(beat), None, false, beat + SILENCE + TICK), Liveness::Unresponsive);
        // A hidden panel's throttled timers are not a failure.
        assert_eq!(liveness(start, Some(beat), None, true, beat + SILENCE * 10), Liveness::Alive);
        // A panel that throws reports it itself.
        assert_eq!(liveness(start, Some(beat), Some("error"), false, beat), Liveness::Failed("error".into()));
    }

    #[test]
    fn installed_inspector_mount_is_a_webview_because_the_app_policy_forbids_frames() {
        // The browser preview mounts an iframe; the installed app cannot (frame-src 'none'), and its policy stays as is.
        let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let csp = config["app"]["security"]["csp"].as_str().unwrap();
        assert!(csp.contains("frame-src 'none'") && !csp.contains("unsafe-eval") && !csp.contains("blob:"));
        assert!(PANEL_PREFIX != "main" && !PANEL_PREFIX.is_empty());
    }
    #[test]
    fn placement_bounds_and_forged_mount_requests_fail_closed() {
        placement("inspector").unwrap();
        assert!(placement("window").unwrap_err().starts_with("UnsupportedContribution"));
        assert!(placement("floating").unwrap_err().starts_with("UnsupportedContribution"));
        assert_eq!(placement("band").unwrap_err(), "InvalidShape");
        let ok = Bounds { x: 10.0, y: 20.0, width: 320.0, height: 240.0 };
        assert_eq!(bounded(ok).unwrap(), ok);
        for bad in [Bounds { x: f64::NAN, ..ok }, Bounds { x: -1.0, ..ok }, Bounds { width: 0.5, ..ok }, Bounds { height: f64::INFINITY, ..ok }, Bounds { width: 40000.0, ..ok }] { assert!(bounded(bad).is_err()); }
        let request = json!({"viewId": VIEW, "version": "1.0.0", "placement": "inspector", "bounds": {"x": 0, "y": 0, "width": 320, "height": 240}});
        assert!(serde_json::from_value::<MountRequest>(request.clone()).is_ok());
        for key in ["owner", "url", "windowId", "label", "session", "capabilities", "projectId"] {
            let mut forged = request.clone(); forged[key] = json!("main"); assert!(serde_json::from_value::<MountRequest>(forged).is_err(), "{key}");
        }
        let mut forged = request.clone(); forged["bounds"]["z"] = json!(1); assert!(serde_json::from_value::<MountRequest>(forged).is_err());
        assert!(serde_json::from_value::<BoundsRequest>(json!({"mountId": "extension-panel-a", "bounds": request["bounds"], "visible": true, "owner": "x"})).is_err());
    }

    #[test]
    fn panel_webviews_have_no_command_grant_and_their_document_matches_the_window_isolation() {
        for command in ["extensions_rich_mount_open", "extensions_rich_mount_bounds", "extensions_rich_mount_close", "extensions_rich_view_open", "extensions_runtime", "read_file", "send_message", "stop_session", "plugin:event|emit"] {
            assert!(!crate::extensions::windows::command_allowed("extension-panel-canary", command), "{command}");
        }
        assert!(!crate::extensions::windows::AUXILIARY.iter().any(|label| label.starts_with(PANEL_PREFIX)));
        let (pinned, html) = rich_views::panel_document(&snapshot(Some(true)), VIEW, "1.0.0", "extension-panel-test", false).unwrap();
        assert_eq!((pinned.owner.as_str(), pinned.version.as_str()), ("sample.rich-mount", "1.0.0"));
        assert!(html.contains("sandbox") && html.contains("allow-scripts") && html.contains("extension-panel-test"));
        assert!(!html.contains("unsafe-eval") && !html.contains("blob:"));
        // The same view and assets pin to the same fingerprint; a changed asset does not.
        let mut changed = snapshot(Some(true)); changed.packages[0].rich_assets.get_mut(VIEW).unwrap().css = "p{}".into();
        assert_ne!(rich_views::pin(&changed, VIEW, "1.0.0").unwrap().fingerprint, pinned.fingerprint);
        assert_eq!(rich_views::pin(&snapshot(Some(true)), VIEW, "1.0.0").unwrap().fingerprint, pinned.fingerprint);
    }
}
