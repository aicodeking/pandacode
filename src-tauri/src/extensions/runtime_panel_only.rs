//! A package with panels and no background service (R0305, ADR-0001, contract G4).
//!
//! A package may ship only panels: no `runtime`, no service, nothing in the Running list, no process. It needs
//! executable trust (a panel is code) and `ui.richViews`, like every rich panel. Its pages use `pandaView.panda`
//! exactly as a service package's pages do: the proxied calls go through the same server as a service's requests
//! (`runtime_rich_channel::serve_post`, kind `call`), which never needs a running process, so every call the
//! package holds a grant for works and is checked natively per call. What has nobody to receive it answers
//! `UnsupportedCapability`: `pandaView.postMessage` (`runtime_rich_channel::NO_SERVICE`) and the service-only calls,
//! `storage.directory` included (`runtime_rich_channel::SERVICE_ONLY`).
//!
//! **Page work.** What a page of such a package made through the host (notices, live items, a dialog or a task start
//! waiting for the user) lives while the package may show panels, as a service's work lives while its process runs.
//! A disable, uninstall, update, untrust, safe mode or a revoke of `ui.richViews` ends it once (`reconcile`, called by
//! `rich_views::reconcile` after every lifecycle change), whether a panel is still mounted, was closed, or failed:
//! the work is the package's, never the document's, so a failed or hung panel cannot keep it alive.
//!
//! **Focus.** A panel that ends while it had the keyboard (a lifecycle end, or a failure the watchdog ends) gives it
//! back to the main window, which focuses the control that had it before the panel (`release_focus`, the same
//! `release` the panel's own Escape sends). These rules are for predictability and fault isolation (ADR-0005), not
//! for security.
use crate::extensions::{packages::{ExtensionPackages, Snapshot}, rich_views::{runtime_rich_channel as channel, runtime_rich_focus as focus, runtime_rich_mount as mount}, runtime_service_lifetime};
use serde_json::{json, Value};
use std::{collections::BTreeSet, sync::{LazyLock, Mutex}};

/// The recorder reason of notices removed when a page's work ends.
pub const PAGE_ENDED: &str = "panel-ended";

/// `true` for a package that declares at least one rich view and no background service.
pub fn panel_only(manifest: &Value) -> bool {
    !runtime_service_lifetime::declares_service(manifest)
        && manifest["contributes"]["views"].as_array().is_some_and(|views| views.iter().any(|view| view.get("rich").is_some()))
}

/// Packages (`owner`, `version`) whose pages made at least one host call. Pure: the app applies what `ended` answers.
#[derive(Default, Debug)]
pub struct PageWork { pages: BTreeSet<(String, String)> }
impl PageWork {
    /// A page of `owner@version` made a host call; `true` the first time.
    pub fn note(&mut self, owner: &str, version: &str) -> bool { self.pages.insert((owner.to_owned(), version.to_owned())) }
    /// The pages whose package may no longer show panels: each ends once and is forgotten. Answers the owners.
    pub fn ended(&mut self, allowed: impl Fn(&str, &str) -> bool) -> Vec<String> {
        let gone: Vec<(String, String)> = self.pages.iter().filter(|(owner, version)| !allowed(owner, version)).cloned().collect();
        for page in &gone { self.pages.remove(page); }
        let mut owners: Vec<String> = gone.into_iter().map(|(owner, _)| owner).collect();
        owners.dedup();
        owners
    }
    pub fn pages(&self) -> Vec<(String, String)> { self.pages.iter().cloned().collect() }
    pub fn is_empty(&self) -> bool { self.pages.is_empty() }
}

/// Whether the installed package `owner` (any version) declares a service: its own service's end clears its work,
/// so a page of it never does (a service keeps running while only `ui.richViews` is revoked).
fn has_service(snapshot: &Snapshot, owner: &str) -> bool {
    snapshot.packages.iter().any(|package| package.manifest["id"] == owner && runtime_service_lifetime::declares_service(&package.manifest))
}

// ---- the app ----------------------------------------------------------------------------------------------------

static PAGES: LazyLock<Mutex<PageWork>> = LazyLock::new(Mutex::default);

/// A page of `owner@version` made a proxied call (`runtime_rich_channel::serve_post`, kind `call`).
pub fn note_call(owner: &str, version: &str) { if let Ok(mut pages) = PAGES.lock() { pages.note(owner, version); } }

/// After every lifecycle change (`rich_views::reconcile`): the work of pages whose package may no longer show panels
/// ends, once. Authorization is read before the page lock is taken (it syncs the grants file).
pub fn reconcile(app: &tauri::AppHandle) {
    use tauri::Manager;
    let tracked = match PAGES.lock() { Ok(pages) if !pages.is_empty() => pages.pages(), _ => return };
    let Some(packages) = app.try_state::<ExtensionPackages>() else { return };
    let snapshot = match packages.0.lock() { Ok(packages) => packages.snapshot(), Err(_) => return };
    let allowed: Vec<(String, String)> = tracked.into_iter().filter(|(owner, version)| mount::authorize_app(app, &snapshot, owner, version).is_ok()).collect();
    let ended = match PAGES.lock() { Ok(mut pages) => pages.ended(|owner, version| allowed.iter().any(|(o, v)| o == owner && v == version)), Err(_) => return };
    for owner in ended.into_iter().filter(|owner| !has_service(&snapshot, owner)) { page_ended(app, &owner); }
}

/// Ends what the pages of `owner` made through the host: the same per-owner teardown as a service's end, for the
/// calls a panel can make (live items, a dialog or a task start waiting for the user, notices).
pub fn page_ended(app: &tauri::AppHandle, owner: &str) {
    crate::extensions::runtime_dynamic_items::service_stopped(app, owner);
    crate::extensions::runtime_dialog_navigation::service_stopped(app, owner);
    crate::extensions::runtime_tasks_start::service_stopped(app, owner);
    if crate::extensions::runtime_notifications::state(app).is_some_and(|notices| notices.clear(owner, PAGE_ENDED)) { crate::extensions::runtime_notifications::changed(app); }
}

/// A panel mount `label` is ending (`runtime_rich_mount::end`): if its page had the keyboard, the main window gets it
/// back and focuses the control that had it before the panel. Nothing happens for a panel without focus.
pub fn release_focus(app: &tauri::AppHandle, label: &str) {
    use tauri::{Emitter, Manager};
    if !channel::focused(label) { return; }
    if let Some(window) = app.get_webview_window("main") { let _ = window.set_focus(); }
    if let Some(view) = app.get_webview("main") { let _ = view.set_focus(); }
    let _ = app.emit_to("main", focus::FOCUS_EVENT, json!({"mountId": label, "kind": "release"}));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::{packages::Packages, rich_views, runtime_grants::{RuntimeGrants, Scope}, runtime_notifications::{Checks, Notices}, runtime_service_lifetime::ServiceLifetime};
    use std::{io::Write, path::{Path, PathBuf}, time::Instant};

    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-panel-only/extension.json");
    const OWNER: &str = "sample.panel-only";
    const VIEW: &str = "sample.panel-only/sketch";
    const DECLARED: [&str; 5] = ["ui.contribute", "ui.richViews", "ui.notify", "ui.dynamic", "storage.private"];

    struct Dir(PathBuf);
    impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-panel-only-test-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn manifest() -> Value { serde_json::from_str(MANIFEST).unwrap() }
    /// Every file of the fixture package folder, as archive entries.
    fn files() -> Vec<(String, Vec<u8>)> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/extensions/runtime-panel-only");
        let mut found = vec![]; let mut pending = vec![(root, String::new())];
        while let Some((path, prefix)) = pending.pop() {
            for entry in std::fs::read_dir(path).unwrap() {
                let entry = entry.unwrap(); let name = format!("{prefix}{}", entry.file_name().to_str().unwrap());
                if entry.file_type().unwrap().is_dir() { pending.push((entry.path(), format!("{name}/"))); } else { found.push((name, std::fs::read(entry.path()).unwrap())); }
            }
        }
        found.sort(); found
    }
    fn archive(files: &[(String, Vec<u8>)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, bytes) in files { writer.start_file(name.as_str(), zip::write::SimpleFileOptions::default()).unwrap(); writer.write_all(bytes).unwrap(); }
        writer.finish().unwrap().into_inner()
    }
    fn installed(dir: &Dir) -> (ExtensionPackages, RuntimeGrants) {
        let packages = ExtensionPackages::new(&dir.0, false);
        let grants = RuntimeGrants::open(&dir.0);
        {
            let store: std::sync::MutexGuard<'_, Packages> = packages.0.lock().unwrap();
            store.install(&archive(&files())).unwrap();
            let digest = store.snapshot().packages[0].executable_digest().expect("a panel is executable content").to_owned();
            store.trust(OWNER, &digest, true).unwrap();
            store.enable(OWNER, true).unwrap();
            grants.sync(&serde_json::to_value(store.snapshot()).unwrap()).unwrap();
        }
        (packages, grants)
    }
    fn snapshot(trusted: bool) -> Snapshot {
        let mut snapshot = crate::extensions::packages::context_test_snapshot(manifest());
        snapshot.packages[0].set_executable_for_test(Some(trusted));
        snapshot
    }
    fn granted(dir: &Dir) -> RuntimeGrants {
        let grants = RuntimeGrants::open(&dir.0);
        grants.register_package(OWNER, "1.0.0", &DECLARED, Some("test-digest")).unwrap();
        grants.trust(OWNER, true).unwrap();
        grants.grant(OWNER, mount::PERMISSION, Scope::default()).unwrap();
        grants
    }
    fn origin() -> channel::Origin { channel::Origin { owner: OWNER.into(), version: "1.0.0".into(), view_id: VIEW.into() } }

    #[test]
    fn the_canvas_fixture_is_a_valid_package_with_a_panel_and_no_service() {
        let manifest = manifest();
        assert_eq!(manifest["id"], OWNER);
        let checked = crate::extensions::contracts::validate_contract("packages", &json!([manifest.clone()]));
        assert_eq!(checked["ok"], true, "{checked}");
        assert!(manifest.get("runtime").is_none(), "no runtime, no process");
        assert!(panel_only(&manifest));
        assert_eq!(manifest["contributes"]["views"][0]["rich"]["folder"], "canvas");
        // A service package is not panel-only, and neither is a package without a rich view.
        let mut service = manifest.clone(); service["runtime"] = json!({"kind": "node", "entrypoint": "main.cjs", "service": {"start": "onEnable"}});
        assert!(!panel_only(&service));
        let mut plain = manifest; plain["contributes"]["views"][0].as_object_mut().unwrap().remove("rich");
        assert!(!panel_only(&plain));
    }

    /// The criterion's falsifier: installed through the real validator, trusted, enabled and granted everything it
    /// declares, the package's panel is authorized and served while no service is wanted and none is started.
    #[test]
    fn installed_trusted_enabled_and_granted_it_shows_its_panel_with_zero_service_spawns() {
        let dir = Dir::new();
        let (packages, grants) = installed(&dir);
        for permission in DECLARED.iter().filter(|permission| **permission != "ui.contribute") { grants.grant(OWNER, permission, Scope::default()).unwrap(); }
        // `runtime.service` is not declared, so it cannot even be granted.
        assert!(grants.grant(OWNER, runtime_service_lifetime::PERMISSION, Scope::default()).is_err());
        let store = packages.0.lock().unwrap();
        let snapshot = store.snapshot();
        mount::authorize(&snapshot, Some(&grants), OWNER, "1.0.0").unwrap();
        assert_eq!(rich_views::pin(&snapshot, VIEW, "1.0.0").unwrap().owner, OWNER);
        let (_, served) = store.panel_files(OWNER, "canvas").unwrap();
        let names: Vec<&str> = served.iter().map(|(name, _)| name.as_str()).collect();
        assert!(names.contains(&"index.html") && names.contains(&"app.js"), "{names:?}");
        // Even with every grant assumed, no service is wanted.
        let value = serde_json::to_value(&snapshot).unwrap();
        assert!(runtime_service_lifetime::desired(&value, |_, _| true).is_empty());
        // The app start and a later lifecycle change reconcile; nothing is spawned, nothing appears in the list.
        let manager = ServiceLifetime::new(vec![dir.0.join("no-runtime")]);
        manager.reconcile(&store, &grants);
        manager.reconcile(&store, &grants);
        assert_eq!(manager.projection()["services"], json!([]), "zero service spawns");
    }

    #[test]
    fn page_calls_route_like_a_service_while_messaging_and_storage_directory_answer_unsupported_capability() {
        let manifest = manifest();
        let mut channel = channel::Channel::default();
        let (init, _) = channel.hello("extension-panel-a", "s", origin()).unwrap();
        assert_eq!(init["restored"], false);
        // Page state: kept across a reload (a new mount of the same slot), with no service anywhere.
        channel.set_state("extension-panel-a", json!({"strokes": [[10, 10, 80, 90]]})).unwrap();
        channel.detach("extension-panel-a", true);
        let (again, _) = channel.hello("extension-panel-b", "s2", origin()).unwrap();
        assert_eq!((again["restored"].clone(), again["state"]["strokes"][0][2].clone()), (json!(true), json!(80)));
        // Calls available in a panel route to the service request server, which needs no process.
        for (path, args, method) in [
            ("ui.notify", vec![json!({"key": "sketch", "text": "2 strokes saved"})], "notice"),
            ("ui.register", vec![json!({"kind": "menu", "id": "sample.panel-only/strokes"})], "ui"),
            ("ui.showDialog", vec![json!({})], "uiDialog"),
            ("settings.get", vec![json!({})], "settingsGet"),
            ("tasks.start", vec![json!({"projectId": "p", "prompt": "draw"})], "tasksStart"),
        ] {
            channel.call("extension-panel-b", path).unwrap();
            assert_eq!(channel::route(path, &args).unwrap().0, method, "{path}");
        }
        // Service-only calls, the data directory first, are refused before anything runs.
        for path in ["storage.directory", "secrets.get", "auth.signIn", "views.post", "events.on", "commands.register"] {
            assert!(channel.call("extension-panel-b", path).unwrap_err().starts_with("UnsupportedCapability"), "{path}");
        }
        // `postMessage` has nobody to receive it: `serve_post` answers NO_SERVICE for a package that declares none.
        assert!(!runtime_service_lifetime::declares_service(&manifest));
        assert!(channel::NO_SERVICE.starts_with("UnsupportedCapability"));
        let (owner, _) = channel.from_panel("extension-panel-b", json!({"kind": "saved"}), Instant::now()).unwrap();
        assert_eq!(owner, OWNER);
        // A page's notice is the package's: granted `ui.notify` is checked per call, as for a service.
        let notices = Notices::default();
        notices.notify(OWNER, &Checks { granted: true, package: "Panel-only sketch", now_ms: 1 }, &json!({"key": "sketch", "text": "2 strokes saved"})).unwrap();
        assert_eq!(notices.count(OWNER), 1);
        assert_eq!(notices.notify(OWNER, &Checks { granted: false, package: "Panel-only sketch", now_ms: 2 }, &json!({"key": "x", "text": "y"})).unwrap_err(), "PermissionDenied");
    }

    /// Disable, safe mode, untrust and a revoke of `ui.richViews` end the page's work once, whether a panel is mounted,
    /// closed or failed; the focused instance is known so the keyboard goes back to the app.
    #[test]
    fn disable_safe_mode_untrust_and_revoke_end_page_work_once_even_after_the_panel_failed() {
        fn allowed<'a>(snapshot: &'a Snapshot, grants: &'a RuntimeGrants) -> impl Fn(&str, &str) -> bool + 'a { move |owner, version| mount::authorize(snapshot, Some(grants), owner, version).is_ok() }
        let dir = Dir::new(); let grants = granted(&dir);
        let live = snapshot(true);
        let mut work = PageWork::default();
        assert!(work.note(OWNER, "1.0.0") && !work.note(OWNER, "1.0.0"));
        assert!(work.ended(allowed(&live, &grants)).is_empty(), "allowed: the work stays");
        let mut disabled = snapshot(true); disabled.packages[0].enabled = false;
        assert_eq!(work.ended(allowed(&disabled, &grants)), vec![OWNER.to_owned()]);
        assert!(work.ended(allowed(&disabled, &grants)).is_empty() && work.is_empty(), "once");
        let mut safe = snapshot(true); safe.safe_mode = true;
        work.note(OWNER, "1.0.0");
        assert_eq!(work.ended(allowed(&safe, &grants)), vec![OWNER.to_owned()]);
        work.note(OWNER, "1.0.0");
        assert_eq!(work.ended(allowed(&snapshot(false), &grants)), vec![OWNER.to_owned()], "untrusted");
        work.note(OWNER, "1.0.0");
        grants.revoke(OWNER, mount::PERMISSION).unwrap();
        assert_eq!(work.ended(allowed(&live, &grants)), vec![OWNER.to_owned()], "ui.richViews revoked");
        // A package that declares a service is left to its service's end.
        let mut service = snapshot(true); service.packages[0].manifest["runtime"] = json!({"service": {"start": "onEnable"}});
        assert!(has_service(&service, OWNER) && !has_service(&live, OWNER));

        // The panel failed (its mount ended keeping the instance's state): the work still ends with the package, the
        // kept state goes with the lifecycle purge, and a focused instance is reported until it is detached.
        let mut channel = channel::Channel::default();
        channel.hello("extension-panel-f", "s", origin()).unwrap();
        channel.set_focus("extension-panel-f", true).unwrap();
        assert!(channel.focused("extension-panel-f"));
        channel.detach("extension-panel-f", true);
        assert!(!channel.focused("extension-panel-f"));
        assert_eq!(channel.dormant(), 1);
        channel.purge(|_| false);
        assert_eq!(channel.dormant(), 0);
        let notices = Notices::default();
        notices.notify(OWNER, &Checks { granted: true, package: "Panel-only sketch", now_ms: 1 }, &json!({"key": "sketch", "text": "saved"})).unwrap();
        assert!(notices.clear(OWNER, PAGE_ENDED) && notices.count(OWNER) == 0);
        assert_eq!(notices.recorder().as_array().unwrap().last().unwrap()["reason"], PAGE_ENDED);
    }
}
