//! The Running list of the Extensions page and the extension part of the quit account (runtime phase R1, slice R0107).
//!
//! Everything here is read from the native owners, never measured twice: the state, start reason, restarts, status
//! line, crash supervision and resident memory come from `ServiceLifetime::projection` (R0104/R0106), the running
//! owned tool jobs from `ExtensionJobs::running`. One row per service; each running job is counted once, on its
//! package. The host is always this computer here (`placement: "local"`); placement beside remote and headless
//! executors is R0108 and is never inferred from this projection.
//!
//! Controls: **Stop** ends a starting, running or restarting service with the stop reason `stop` and keeps it stopped
//! (`held`) until the user retries or enables it again; nothing else starts it, so another reconcile, a grant change
//! or an update leave it stopped. **Retry** clears a held, failed, parked or scheduled service and reconciles. **Data
//! size** measures the package's data directory (`<app data>/extension-data-v1/<id>`, R0105) on request, bounded and
//! without following links.
//!
//! Quit: `quit_packages` is the single extension input of `quit_guard::QuitAccount`. A package is named once when its
//! service reports `working: true` while it starts or runs, or when it owns running tool jobs, or both.
use crate::extensions::{jobs::ExtensionJobs, runtime_service_lifetime::{self as lifetime, ServiceLifetime}};
use crate::quit_guard::WorkingPackage;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};

/// The data directory root of every package (`runtime_code_folders::data_directory` writes below it).
const DATA: &str = "extension-data-v1";
/// The most entries a data size walk visits before it reports `truncated`.
pub const DATA_ENTRY_LIMIT: usize = 100_000;

/// The identity of the host the services of this projection run on: always this computer (R0108 adds the others).
pub fn local_host() -> Value { json!({"placement": "local", "name": host_name(), "platform": std::env::consts::OS}) }
/// The computer's name, by the same rule as the Connect device name (`remote::config::device_name`).
fn host_name() -> String {
    #[cfg(unix)]
    let name = {
        let mut buffer = [0u8; 256];
        // SAFETY: the buffer is valid for its length, and gethostname NUL-terminates within it.
        let ok = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0;
        let end = buffer.iter().position(|&b| b == 0).unwrap_or(0);
        ok.then(|| String::from_utf8_lossy(&buffer[..end]).into_owned())
    };
    #[cfg(not(unix))]
    let name = std::env::var("COMPUTERNAME").ok();
    let name = name.unwrap_or_default();
    let name = name.trim().trim_end_matches(".local").chars().filter(|c| !c.is_control()).take(64).collect::<String>();
    if name.is_empty() { "This computer".into() } else { name }
}

fn state(service: &Value) -> &str { service["state"].as_str().unwrap_or("stopped") }
/// A service is working while it starts or runs and its last status said `working: true`.
fn working(service: &Value) -> bool { matches!(state(service), "starting" | "running") && service["status"]["working"] == true }

/// The Running list (`extensions_service_status`), from the lifetime projection, the running jobs of each owner and
/// the host identity. Pure, so the counting rules are proven without a process.
pub fn status(lifetime: &Value, jobs: &BTreeMap<String, usize>, host: &Value) -> Value {
    let services: Vec<&Value> = lifetime["services"].as_array().into_iter().flatten().filter(|service| service["id"].is_string()).collect();
    let rows: Vec<Value> = services.iter().map(|service| {
        let id = service["id"].as_str().unwrap_or_default();
        let (state, held) = (state(service), service["held"] == true);
        let supervision = &service["supervision"];
        json!({
            "id": id, "version": service["version"], "state": state, "held": held, "reason": service["reason"],
            "restarts": service["restarts"].as_u64().unwrap_or(0), "status": service["status"], "working": working(service),
            "error": service["error"], "crashes": supervision["crashes"].as_u64().unwrap_or(0),
            "backoffMs": supervision["backoffMs"], "restartInMs": supervision["restartInMs"], "parked": supervision["parked"],
            "startup": supervision["startup"], "memory": supervision["memory"],
            "jobs": jobs.get(id).copied().unwrap_or(0), "host": host,
            "starts": service["starts"], "stops": service["stops"], "lastStop": service["lastStop"],
            "controls": {
                "stop": matches!(state, "starting" | "running" | "restarting"),
                "retry": matches!(state, "failed" | "parked" | "restarting") || (state == "stopped" && held),
            },
        })
    }).collect();
    // Jobs of packages without a service row are listed too, so every counted job is visible somewhere.
    let others: Vec<Value> = jobs.iter().filter(|(id, running)| **running > 0 && !services.iter().any(|service| service["id"] == id.as_str()))
        .map(|(id, running)| json!({"id": id, "running": running})).collect();
    let quit = quit_packages_from(lifetime, jobs);
    json!({
        "schemaVersion": 1, "available": lifetime["available"] == true, "host": host,
        "counts": {
            "services": services.iter().filter(|service| matches!(state(service), "starting" | "running" | "stopping")).count(),
            "working": services.iter().filter(|service| working(service)).count(),
            "jobs": jobs.values().sum::<usize>(),
            "quit": quit.len(),
        },
        "services": rows, "jobs": others,
        "quit": quit.iter().map(|package| json!({"id": package.id, "text": package.text, "jobs": package.jobs})).collect::<Vec<_>>(),
    })
}

/// The packages quitting would stop while they work, each once, in id order: a working service (with its status
/// line), running owned jobs, or both.
pub(crate) fn quit_packages_from(lifetime: &Value, jobs: &BTreeMap<String, usize>) -> Vec<WorkingPackage> {
    let mut packages: BTreeMap<String, WorkingPackage> = BTreeMap::new();
    for service in lifetime["services"].as_array().into_iter().flatten().filter(|service| working(service)) {
        let Some(id) = service["id"].as_str() else { continue };
        packages.insert(id.to_owned(), WorkingPackage { id: id.to_owned(), text: service["status"]["text"].as_str().map(str::to_owned), jobs: 0 });
    }
    for (id, running) in jobs.iter().filter(|(_, running)| **running > 0) {
        packages.entry(id.clone()).or_insert_with(|| WorkingPackage { id: id.clone(), text: None, jobs: 0 }).jobs = *running;
    }
    packages.into_values().collect()
}

/// The extension part of the quit account: what the app's services and jobs report right now.
pub(crate) fn quit_packages(app: &tauri::AppHandle) -> Vec<WorkingPackage> {
    use tauri::Manager;
    let lifetime = app.try_state::<ServiceLifetime>().map(|services| services.projection()).unwrap_or(Value::Null);
    let jobs = app.try_state::<ExtensionJobs>().map(|jobs| jobs.running()).unwrap_or_default();
    quit_packages_from(&lifetime, &jobs)
}

/// The same identity rule as package ids on disk (`runtime_code_folders`): never a path.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 160 && !id.contains("..") && !id.starts_with('.') && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}

/// The size of a package's data directory: regular files only, links neither followed nor counted, at most `limit`
/// entries visited (then `truncated`). A missing directory is empty.
pub fn data_size(app_data: &Path, id: &str, limit: usize) -> Result<Value, &'static str> {
    if !valid_id(id) { return Err("InvalidArguments"); }
    let root = app_data.join(DATA).join(id);
    let reply = |bytes: u64, files: u64, truncated: bool, exists: bool| json!({"schemaVersion": 1, "id": id, "bytes": bytes, "files": files, "truncated": truncated, "exists": exists});
    match std::fs::symlink_metadata(&root) {
        Err(_) => return Ok(reply(0, 0, false, false)),
        Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => return Err("StorageUnavailable"),
        Ok(_) => {}
    }
    let (mut bytes, mut files, mut visited) = (0u64, 0u64, 0usize);
    let mut pending = vec![root];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else { continue };
        for entry in entries.filter_map(Result::ok) {
            if visited >= limit { return Ok(reply(bytes, files, true, true)); }
            visited += 1;
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
            if meta.file_type().is_symlink() { continue; }
            if meta.is_dir() { pending.push(entry.path()); } else if meta.is_file() { bytes = bytes.saturating_add(meta.len()); files += 1; }
        }
    }
    Ok(reply(bytes, files, false, true))
}

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    Ok(())
}
fn current(app: &tauri::AppHandle) -> Value {
    use tauri::Manager;
    let lifetime = app.try_state::<ServiceLifetime>().map(|services| services.projection()).unwrap_or_else(|| json!({"schemaVersion": 1, "available": false, "services": []}));
    let jobs = app.try_state::<ExtensionJobs>().map(|jobs| jobs.running()).unwrap_or_default();
    status(&lifetime, &jobs, &local_host())
}

#[tauri::command]
pub fn extensions_service_status(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Value, String> {
    main_only(&window)?;
    Ok(current(&app))
}
/// The user's stop: the service gets `onStop("stop")`, ends, and stays stopped until retried or enabled again.
#[tauri::command]
pub fn extensions_service_stop(window: tauri::WebviewWindow, app: tauri::AppHandle, services: tauri::State<'_, ServiceLifetime>, id: String) -> Result<Value, String> {
    main_only(&window)?;
    services.stop(&id).map_err(String::from)?;
    Ok(current(&app))
}
/// Retry: a held, failed, parked or scheduled service starts again with a clean crash history when it is still
/// wanted (enabled, trusted, granted); the start itself is reported by the next status.
#[tauri::command]
pub fn extensions_service_retry(window: tauri::WebviewWindow, app: tauri::AppHandle, services: tauri::State<'_, ServiceLifetime>, id: String) -> Result<Value, String> {
    main_only(&window)?;
    if !services.projection()["services"].as_array().is_some_and(|services| services.iter().any(|service| service["id"] == id.as_str())) { return Err("NotFound".into()); }
    lifetime::retry_app(&app, &id);
    Ok(current(&app))
}
#[tauri::command]
pub async fn extensions_service_data_size(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String) -> Result<Value, String> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let app_data = app.state::<crate::extensions::packages::ExtensionPackages>().0.lock().map_err(|_| "HostUnavailable")?.app_data();
        data_size(&app_data, &id, DATA_ENTRY_LIMIT)
    }).await.map_err(|_| "HostUnavailable".to_owned())?.map_err(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quit_guard::{account_message, should_confirm, QuitAccount};

    fn service(id: &str, state: &str, working: bool, extra: Value) -> Value {
        let mut service = json!({
            "id": id, "version": "1.0.0", "state": state, "held": false, "reason": "enable", "restarts": 0,
            "status": {"text": format!("{id} status"), "working": working}, "error": null,
            "starts": {"enable": 1}, "stops": {}, "lastStop": null,
            "supervision": {"crashes": 0, "backoffMs": null, "restartInMs": null, "parked": null, "startup": null, "memory": {"residentBytes": 41_943_040, "peakBytes": 45_088_768, "samples": 3}},
        });
        for (key, value) in extra.as_object().into_iter().flatten() { service[key] = value.clone(); }
        service
    }
    fn lifetime(services: Vec<Value>) -> Value { json!({"schemaVersion": 1, "available": true, "services": services}) }

    /// Status counts services and their jobs once: a working service with two jobs is one service, one working
    /// package and two jobs; jobs of a package without a service are listed and counted once as well.
    #[test]
    fn status_counts_services_and_their_jobs_once() {
        let host = json!({"placement": "local", "name": "test-host", "platform": "windows"});
        let projection = lifetime(vec![
            service("a.working", "running", true, json!({})),
            service("b.idle", "running", false, json!({})),
            service("c.parked", "parked", true, json!({"status": null, "supervision": {"crashes": 5, "parked": "The service of c.parked was parked", "memory": null}})),
            service("d.held", "stopped", false, json!({"held": true, "status": null, "supervision": null, "version": null, "stops": {"stop": 1}, "lastStop": {"reason": "stop", "acknowledged": true}})),
            service("e.restarting", "restarting", true, json!({"supervision": {"crashes": 1, "backoffMs": 1000, "restartInMs": 400, "parked": null, "memory": null}})),
        ]);
        let jobs = BTreeMap::from([("a.working".to_owned(), 2), ("f.tools".to_owned(), 1), ("g.none".to_owned(), 0)]);
        let status = status(&projection, &jobs, &host);
        assert_eq!(status["counts"], json!({"services": 2, "working": 1, "jobs": 3, "quit": 2}), "{status}");
        assert_eq!(status["jobs"], json!([{"id": "f.tools", "running": 1}]), "jobs without a service row are listed once");
        assert_eq!(status["quit"], json!([{"id": "a.working", "text": "a.working status", "jobs": 2}, {"id": "f.tools", "text": null, "jobs": 1}]));
        let row = |id: &str| status["services"].as_array().unwrap().iter().find(|row| row["id"] == id).unwrap().clone();
        let working = row("a.working");
        assert_eq!((working["state"].as_str(), working["working"].as_bool(), working["jobs"].as_u64()), (Some("running"), Some(true), Some(2)));
        assert_eq!(working["memory"]["residentBytes"], 41_943_040); assert_eq!(working["host"], host);
        assert_eq!(working["controls"], json!({"stop": true, "retry": false}));
        assert_eq!(row("b.idle")["working"], false);
        assert_eq!(row("c.parked")["controls"], json!({"stop": false, "retry": true}));
        assert_eq!(row("c.parked")["crashes"], 5);
        assert_eq!(row("d.held")["controls"], json!({"stop": false, "retry": true}), "a stopped service is retried, not stopped");
        let restarting = row("e.restarting");
        assert_eq!((restarting["working"].as_bool(), restarting["restartInMs"].as_u64()), (Some(false), Some(400)), "a restarting service has no process and is not working");
        assert_eq!(restarting["controls"], json!({"stop": true, "retry": true}));
        // The same packages are the quit account's: named once each, in id order.
        let account = QuitAccount { agents: 0, packages: quit_packages_from(&projection, &jobs) };
        assert_eq!(account_message(&account), "Extensions still working: a.working (a.working status; 2 jobs running), f.tools (1 job running). Quitting stops them.");
    }

    /// Clearing the work removes the package from the quit question; a stopping service is no longer named.
    #[test]
    fn clearing_work_removes_the_quit_warning() {
        let none = BTreeMap::new();
        let working = lifetime(vec![service("a.one", "running", true, json!({}))]);
        assert!(should_confirm(&QuitAccount { agents: 0, packages: quit_packages_from(&working, &none) }, false, false, false, false));
        for cleared in [lifetime(vec![service("a.one", "running", false, json!({}))]), lifetime(vec![service("a.one", "stopping", true, json!({}))]), lifetime(vec![]), Value::Null] {
            let packages = quit_packages_from(&cleared, &none);
            assert!(packages.is_empty(), "{cleared}");
            assert!(!should_confirm(&QuitAccount { agents: 0, packages }, false, false, false, false));
        }
        let unavailable = status(&Value::Null, &none, &local_host());
        assert_eq!(unavailable["available"], false); assert_eq!(unavailable["services"], json!([]));
    }

    #[test]
    fn the_local_host_is_this_computer() {
        let host = local_host();
        assert_eq!(host["placement"], "local"); assert_eq!(host["platform"], std::env::consts::OS);
        let name = host["name"].as_str().unwrap();
        assert!(!name.is_empty() && name.chars().count() <= 64 && !name.chars().any(char::is_control));
    }

    /// The data size covers the package's own data directory only (the one `storage.directory` hands out), counts
    /// regular files, never follows a link and stops at the entry limit.
    #[test]
    fn data_size_measures_the_packages_own_data_directory() {
        let root = std::env::temp_dir().join(format!("pandacode-service-status-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let id = "sample.service-status";
        assert_eq!(data_size(&root, id, DATA_ENTRY_LIMIT).unwrap(), json!({"schemaVersion": 1, "id": id, "bytes": 0, "files": 0, "truncated": false, "exists": false}));
        let global = crate::extensions::packages::runtime_code_folders::data_directory(&root, id, "global", None).unwrap();
        let project = crate::extensions::packages::runtime_code_folders::data_directory(&root, id, "project", Some("project-1")).unwrap();
        assert!(global.starts_with(root.join(DATA).join(id)) && project.starts_with(root.join(DATA).join(id)), "the measured root is where storage.directory writes");
        std::fs::write(global.join("a.bin"), vec![0u8; 4096]).unwrap();
        std::fs::create_dir(global.join("nested")).unwrap();
        std::fs::write(global.join("nested").join("b.bin"), vec![1u8; 100]).unwrap();
        std::fs::write(project.join("c.bin"), vec![2u8; 4]).unwrap();
        // Another package's data is not counted.
        let other = crate::extensions::packages::runtime_code_folders::data_directory(&root, "other.package", "global", None).unwrap();
        std::fs::write(other.join("big.bin"), vec![3u8; 10_000]).unwrap();
        assert_eq!(data_size(&root, id, DATA_ENTRY_LIMIT).unwrap(), json!({"schemaVersion": 1, "id": id, "bytes": 4200, "files": 3, "truncated": false, "exists": true}));
        let truncated = data_size(&root, id, 2).unwrap();
        assert_eq!(truncated["truncated"], true); assert!(truncated["files"].as_u64().unwrap() < 3);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&other, global.join("link")).unwrap();
            assert_eq!(data_size(&root, id, DATA_ENTRY_LIMIT).unwrap()["bytes"], 4200, "a link is not followed");
        }
        for bad in ["", "..", "../other.package", "a/b", "a\\b", ".hidden"] { assert_eq!(data_size(&root, bad, DATA_ENTRY_LIMIT).unwrap_err(), "InvalidArguments", "{bad}"); }
        std::fs::remove_dir_all(&root).unwrap();
    }

    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-service-status/extension.json");
    const SOURCE: &str = include_str!("../../../tests/fixtures/extensions/runtime-service-status/main.cjs");
    const ID: &str = "sample.service-status";

    #[test]
    fn the_status_fixture_is_a_valid_service_package() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        assert_eq!(manifest["id"], ID);
        let checked = crate::extensions::contracts::validate_contract("packages", &json!([manifest]));
        assert_eq!(checked["ok"], true, "{checked}");
    }

    /// The user's stop and retry, without a runtime: a start that never reached a process cannot be stopped
    /// (`Conflict`), an unknown package is `NotFound`, and Retry clears the failed start.
    #[tokio::test]
    async fn stop_refuses_what_has_no_process_and_retry_clears_it() {
        use crate::extensions::{packages::ExtensionPackages, runtime_grants::{RuntimeGrants, Scope}};
        let dir = std::env::temp_dir().join(format!("pandacode-service-status-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let packages = ExtensionPackages::new(&dir, false);
        let grants = RuntimeGrants::open(&dir);
        let manager = ServiceLifetime::new(vec![dir.join("no-runtime")]);
        {
            let packages = packages.0.lock().unwrap();
            packages.install(&tests_support::archive(MANIFEST, SOURCE)).unwrap();
            let digest = serde_json::to_value(packages.snapshot()).unwrap()["packages"][0]["executable"]["digest"].as_str().unwrap().to_owned();
            packages.trust(ID, &digest, true).unwrap(); packages.enable(ID, true).unwrap();
        }
        // A grant needs the package registered in the grants file (the app syncs it on install); `reconcile` is not
        // called first, so that it stays the app start.
        grants.sync(&serde_json::to_value(packages.0.lock().unwrap().snapshot()).unwrap()).unwrap();
        grants.grant(ID, lifetime::PERMISSION, Scope::default()).unwrap();
        manager.reconcile(&packages.0.lock().unwrap(), &grants);
        let failed = tests_support::wait(&manager, |row| row["state"] == "failed").await;
        assert_eq!(failed["controls"], json!({"stop": false, "retry": true}));
        assert_eq!(manager.stop(ID), Err("Conflict"));
        assert_eq!(manager.stop("sample.unknown"), Err("NotFound"));
        manager.retry(ID); manager.reconcile(&packages.0.lock().unwrap(), &grants);
        // The first reconcile of a manager is the app start; the retried start is `enable`.
        tests_support::wait(&manager, |row| row["state"] == "failed" && row["starts"] == json!({"appStart": 1, "enable": 1})).await;
        drop(manager);
        let _ = std::fs::remove_dir_all(&dir);
    }

    pub(super) mod tests_support {
        use super::*;
        use std::{io::Write, time::{Duration, Instant}};
        pub fn archive(manifest: &str, source: &str) -> Vec<u8> {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            for (name, bytes) in [("extension.json", manifest.as_bytes()), ("main.cjs", source.as_bytes())] {
                writer.start_file(name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap().into_inner()
        }
        /// The Running row of the fixture once `check` holds (tests only: the product never polls natively).
        pub async fn wait(manager: &ServiceLifetime, check: impl Fn(&Value) -> bool) -> Value {
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                let status = status(&manager.projection(), &BTreeMap::new(), &local_host());
                let row = status["services"].as_array().unwrap().iter().find(|row| row["id"] == ID).cloned().unwrap_or(Value::Null);
                if check(&row) { return row; }
                assert!(Instant::now() < deadline, "timed out: {row}");
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }

    /// Native fixture column (Windows x64, the pinned runtime): an installed service driven by the canonical B1 fake
    /// daemon changes its working state, is measured, is named on quit while working and not after, stops with
    /// `stop` and stays stopped across reconciles, and starts again on retry.
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    mod installed {
        use super::*;
        use super::tests_support::{archive, wait};
        use crate::extensions::{packages::ExtensionPackages, runtime_grants::{RuntimeGrants, Scope}, supervisor};
        use std::{path::PathBuf, process::Stdio, time::Duration};
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

        fn runtime_dir() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime") }
        struct B1 { _child: tokio::process::Child, _stdin: Option<tokio::process::ChildStdin>, socket: String, control: String }
        impl B1 {
            async fn start(runtime: &supervisor::Runtime) -> Self {
                let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/extensions/backends/fake-daemon/fake-daemon.mjs");
                let mut child = tokio::process::Command::new(&runtime.binary).arg(script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).creation_flags(0x08000000).spawn().unwrap();
                let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
                let ready: Value = serde_json::from_str(&tokio::time::timeout(Duration::from_secs(10), lines.next_line()).await.unwrap().unwrap().unwrap()).unwrap();
                assert_eq!(ready["ready"], true);
                Self { _stdin: child.stdin.take(), _child: child, socket: ready["socket"].as_str().unwrap().to_owned(), control: ready["control"].as_str().unwrap().to_owned() }
            }
            async fn http(&self, method: &str, path: &str, body: &Value) -> Value {
                let address = self.control.trim_start_matches("http://").trim_end_matches('/');
                let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
                let body = if method == "GET" { String::new() } else { body.to_string() };
                stream.write_all(format!("{method} {path} HTTP/1.0\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                let mut response = Vec::new(); stream.read_to_end(&mut response).await.unwrap();
                serde_json::from_str(String::from_utf8(response).unwrap().split_once("\r\n\r\n").unwrap().1).unwrap()
            }
            async fn status(&self, text: &str, working: bool) { self.http("POST", "/control/signal", &json!({"name": "status", "payload": {"text": text, "working": working}})).await; }
            async fn reasons(&self) -> Vec<String> {
                self.http("GET", "/control/log", &Value::Null).await.as_array().unwrap().iter()
                    .filter(|entry| entry["transport"] == "tcp" && entry["request"]["op"] == "issues.create")
                    .filter_map(|entry| entry["request"]["params"]["title"].as_str().map(str::to_owned)).collect()
            }
        }
        fn quit(manager: &ServiceLifetime) -> QuitAccount { QuitAccount { agents: 0, packages: quit_packages_from(&manager.projection(), &BTreeMap::new()) } }

        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn the_running_row_follows_native_state_names_a_working_service_on_quit_and_stop_holds_until_retry() {
            let runtime = supervisor::Runtime::packaged(&runtime_dir()).expect("pinned runtime (see docs/extensions/runtime-service-lifetime.md)");
            let b1 = B1::start(&runtime).await;
            let dir = std::env::temp_dir().join(format!("pandacode-service-status-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let packages = ExtensionPackages::new(&dir, false);
            let grants = RuntimeGrants::open(&dir);
            let manager = ServiceLifetime::new(vec![runtime_dir()]).with_env(&[("PANDA_FIXTURE_B1", &b1.socket)]);
            {
                let packages = packages.0.lock().unwrap();
                packages.install(&archive(MANIFEST, SOURCE)).unwrap();
                let digest = serde_json::to_value(packages.snapshot()).unwrap()["packages"][0]["executable"]["digest"].as_str().unwrap().to_owned();
                packages.trust(ID, &digest, true).unwrap(); packages.enable(ID, true).unwrap();
            }
            // A grant needs the package registered in the grants file (the app syncs it on install).
            grants.sync(&serde_json::to_value(packages.0.lock().unwrap().snapshot()).unwrap()).unwrap();
            for permission in [lifetime::PERMISSION, "storage.private"] { grants.grant(ID, permission, Scope::default()).unwrap(); }
            let reconcile = || manager.reconcile(&packages.0.lock().unwrap(), &grants);
            reconcile();
            // Running, idle, measured, on this computer.
            let running = wait(&manager, |row| row["state"] == "running" && row["status"]["text"] == "Idle" && row["memory"]["residentBytes"].as_u64().is_some_and(|bytes| bytes > 0)).await;
            assert_eq!((running["restarts"].as_u64(), running["working"].as_bool(), running["held"].as_bool()), (Some(0), Some(false), Some(false)));
            assert_eq!(running["host"], local_host()); assert_eq!(running["host"]["placement"], "local");
            assert_eq!(running["controls"], json!({"stop": true, "retry": false}));
            assert!(!should_confirm(&quit(&manager), false, false, false, false), "an idle service does not hold the quit");
            // The service keeps a 4096-byte file in its data directory: the data size control measures it.
            let mut size = Value::Null;
            for _ in 0..200 { size = data_size(&dir, ID, DATA_ENTRY_LIMIT).unwrap(); if size["bytes"] == 4096 { break; } tokio::time::sleep(Duration::from_millis(25)).await; }
            assert_eq!(size["bytes"], 4096, "{size}"); assert_eq!(size["files"], 1);
            // Working: named on quit with its status line.
            b1.status("Indexing 3 files", true).await;
            let busy = wait(&manager, |row| row["working"] == true).await;
            assert_eq!(busy["status"], json!({"text": "Indexing 3 files", "working": true}));
            let account = quit(&manager);
            assert!(should_confirm(&account, false, false, false, false));
            assert_eq!(account_message(&account), "Extension still working: sample.service-status (Indexing 3 files). Quitting stops it.");
            // Clearing the work removes the warning.
            b1.status("Idle", false).await;
            wait(&manager, |row| row["working"] == false && row["status"]["text"] == "Idle").await;
            assert!(quit(&manager).packages.is_empty());
            // Stop: onStop("stop") runs, the process ends, and the service stays stopped across reconciles.
            b1.status("Indexing again", true).await;
            wait(&manager, |row| row["working"] == true).await;
            manager.stop(ID).unwrap();
            let stopped = wait(&manager, |row| row["state"] == "stopped").await;
            assert_eq!((stopped["held"].as_bool(), stopped["working"].as_bool()), (Some(true), Some(false)));
            assert_eq!(stopped["stops"], json!({"stop": 1})); assert_eq!(stopped["lastStop"], json!({"reason": "stop", "acknowledged": true}));
            assert_eq!(stopped["controls"], json!({"stop": false, "retry": true}));
            assert!(quit(&manager).packages.is_empty(), "a stopped service is not named on quit");
            assert_eq!(manager.stop(ID), Err("Conflict"), "nothing left to stop");
            reconcile(); tokio::time::sleep(Duration::from_millis(500)).await; reconcile();
            assert_eq!(wait(&manager, |_| true).await["starts"], json!({"appStart": 1}), "a held service is not started by another reconcile");
            // Retry starts it again.
            manager.retry(ID); reconcile();
            let again = wait(&manager, |row| row["state"] == "running" && row["status"]["text"] == "Idle").await;
            assert_eq!((again["held"].as_bool(), again["reason"].as_str()), (Some(false), Some("enable")));
            assert_eq!(again["starts"], json!({"appStart": 1, "enable": 1}));
            manager.stop_all(lifetime::StopReason::Quit);
            assert!(manager.wait_idle(Duration::from_secs(5)).await);
            assert_eq!(b1.reasons().await, ["start:appStart", "stop:stop", "start:enable", "stop:quit"]);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
