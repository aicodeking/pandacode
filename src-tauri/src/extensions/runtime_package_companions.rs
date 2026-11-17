//! Package companions use the installed archive, executable trust and native grant store.
use std::{collections::{BTreeMap, BTreeSet}, path::Path};
use serde::{Serialize, Deserialize};
use serde_json::{json, Value};
use super::{runtime_companion_lifetime::{self as lifetime, InstalledApi, Profile, Resources}, runtime_grants::{RuntimeGrants, Target, Work}, packages::{Packages, runtime_code_folders}};
pub const PERMISSION: &str = "harness.companions";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Declaration { pub id: String, pub title: String, pub harness: String, pub file: String }
pub struct Refusal { pub code: &'static str, pub at: &'static str, pub ids: Vec<String> }
pub fn check(manifest: &Value) -> Result<Vec<Declaration>, Refusal> {
    let owner = manifest["id"].as_str().unwrap_or_default();
    let fail = |code, id: &str| Refusal { code, at: "contributes/companions", ids: vec![id.into()] };
    let Some(value) = manifest["contributes"].get("companions") else { return Ok(vec![]) };
    let rows = value.as_array().ok_or_else(|| fail("InvalidShape", owner))?;
    if rows.len() > 16 { return Err(fail("LimitExceeded", owner)); }
    let mut ids = BTreeSet::new(); let mut out = Vec::new();
    for row in rows {
        let declaration: Declaration = serde_json::from_value(row.clone()).map_err(|_| fail("InvalidShape", owner))?;
        let id = &declaration.id;
        if !id.starts_with(&format!("{owner}/")) || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b)) { return Err(fail("InvalidId", owner)); }
        if id.starts_with("panda.") { return Err(fail("ReservedId", id)); }
        if !ids.insert(id.clone()) { return Err(fail("DuplicateId", id)); }
        if declaration.title.trim().is_empty() || declaration.title.chars().count() > 200 || !crate::providers::PROVIDERS.iter().any(|(id, _)| *id == declaration.harness) { return Err(fail("InvalidShape", id)); }
        let file = &declaration.file;
        if file.len() > 512 || file.contains(['\\', ':']) || file.split('/').any(|p| p.is_empty() || p == "." || p == ".." || p.chars().any(char::is_control)) || !runtime_code_folders::in_code_folder(manifest, file) { return Err(fail("UnsafeAsset", id)); }
        out.push(declaration);
    }
    if !out.is_empty() && !manifest["permissions"].as_array().into_iter().flatten().any(|p| p == PERMISSION) { return Err(fail("PermissionDenied", owner)); }
    Ok(out)
}
pub fn profile(installed: &InstalledApi) -> Option<Profile> {
    let profile = if installed.harness == "kilo" { super::runtime_kilo_companion::profile(installed) } else { super::runtime_opencode_companion::profile(installed) }?;
    profile.id.ends_with(".v1").then_some(profile)
}
/// The live snapshot is re-read on every selection. Disabled/untrusted/out-of-project packages disappear.
pub fn listing(snapshot: &Value, project: Option<&str>, installed: &InstalledApi, granted: impl Fn(&str, &str) -> bool) -> Vec<Value> {
    if snapshot["safeMode"] == true { return vec![]; }
    let mut out = Vec::new();
    for item in snapshot["packages"].as_array().into_iter().flatten() {
        if item["enabled"] != true || item["executable"]["trusted"] != true { continue; }
        if item["projects"].as_array().is_some_and(|projects| project.is_none_or(|id| !projects.iter().any(|p| p == id))) { continue; }
        let manifest = &item["manifest"]; let owner = manifest["id"].as_str().unwrap_or_default(); let version = manifest["version"].as_str().unwrap_or_default();
        if !granted(owner, version) { continue; }
        let Ok(declarations) = check(manifest) else { continue };
        for declaration in declarations.into_iter().filter(|d| d.harness == installed.harness) {
            let capability = lifetime::negotiate(installed, profile(installed).as_ref());
            let mut row = serde_json::to_value(declaration).unwrap();
            row["owner"] = json!(owner); row["packageName"] = json!(manifest["name"].as_str().unwrap_or(owner)); row["version"] = json!(version);
            row["code"] = json!(capability.code); row["qualification"] = json!(if capability.code.is_some() { "unsupported" } else { "sourceFeasible" });
            row["modelRequest"] = json!("notReported"); row["compaction"] = json!("notReported"); out.push(row);
        }
    }
    out
}
pub fn selected(packages: &Packages, grants: &RuntimeGrants, project: &str, installed: &InstalledApi) -> Vec<Value> {
    let Ok(snapshot) = serde_json::to_value(packages.snapshot()) else { return vec![] };
    if grants.sync(&snapshot).is_err() { return vec![]; }
    listing(&snapshot, Some(project), installed, |owner, version| grants.check(owner, version, PERMISSION, &Target::default()).is_ok())
}
pub fn owners(app: &tauri::AppHandle, project: &str, harness: &str) -> Vec<String> {
    use tauri::Manager;
    let (Some(packages), Some(grants)) = (app.try_state::<super::packages::ExtensionPackages>(), app.try_state::<RuntimeGrants>()) else { return vec![] };
    let Ok(packages) = packages.0.lock() else { return vec![] };
    let installed = InstalledApi { harness: harness.into(), version: None, apis: vec![] };
    selected(&packages, &grants, project, &installed).iter().filter_map(|r| r["owner"].as_str().map(str::to_owned)).collect::<BTreeSet<_>>().into_iter().collect()
}
fn task_project(app: &tauri::AppHandle, task: &str) -> Result<String, String> {
    use tauri::Manager;
    let state = app.try_state::<crate::AppState>().ok_or("HostUnavailable")?;
    let store = state.store.lock().map_err(|_| "HostUnavailable")?;
    Ok(store.session(task).map_err(|_| "StaleContext")?.project_id)
}
pub fn task_owners(app: &tauri::AppHandle, task: &str, harness: &str) -> Vec<String> {
    task_project(app, task).map(|project| owners(app, &project, harness)).unwrap_or_default()
}
/// Launch admission. The production caller cannot reach this factory until it discovers an exact API.
/// A provider must also pass its merged inline document before claiming installed qualification.
pub fn prepare_app(app: &tauri::AppHandle, task: &str, installed: &InstalledApi, previous: &str) -> Result<Box<dyn Resources>, String> {
    use tauri::Manager;
    let project = task_project(app, task)?;
    let data = app.path().app_data_dir().map_err(|_| "HostUnavailable")?;
    let (Some(packages), Some(grants)) = (app.try_state::<super::packages::ExtensionPackages>(), app.try_state::<RuntimeGrants>()) else { return Err("HostUnavailable".into()) };
    let packages = packages.0.lock().map_err(|_| "HostUnavailable")?;
    prepare(&packages, &grants, &data, &project, installed, previous, false)
}
struct PackageResources { env: BTreeMap<String, String>, work: Vec<Work> }
impl Resources for PackageResources {
    fn environment(&self) -> BTreeMap<String, String> { if self.work.iter().any(Work::is_cancelled) { BTreeMap::new() } else { self.env.clone() } }
    fn close(&mut self) -> Result<(), String> { self.env.clear(); self.work.clear(); Ok(()) }
}
/// Only exact V1 source profiles currently accept arbitrary package modules. No package code is evaluated here.
/// Materialization reuses the checksum-qualified immutable code cache; the lease owns injection, not that cache.
pub fn prepare(packages: &Packages, grants: &RuntimeGrants, app_data: &Path, project: &str, installed: &InstalledApi, previous: &str, pure: bool) -> Result<Box<dyn Resources>, String> {
    if pure || lifetime::negotiate(installed, profile(installed).as_ref()).code.is_some() { return Err("UnsupportedCapability".into()); }
    let rows = selected(packages, grants, project, installed); if rows.is_empty() { return Err("UnsupportedCapability".into()); }
    let mut content = previous.to_owned(); let mut work = Vec::new();
    for row in rows {
        let owner = row["owner"].as_str().ok_or("InvalidShape")?; let version = row["version"].as_str().ok_or("InvalidShape")?;
        work.push(grants.begin(owner, version, PERMISSION, &Target::default())?);
        let (checksum, files) = packages.code_files(owner)?;
        let file = row["file"].as_str().ok_or("InvalidShape")?;
        if !files.iter().any(|(name, _)| name == file) { return Err("UnsafeAsset".into()); }
        let directory = runtime_code_folders::materialize(app_data, owner, &checksum, &files)?;
        let url = reqwest::Url::from_file_path(directory.join(file)).map_err(|_| "InvalidShape")?;
        content = if installed.harness == "kilo" { super::runtime_kilo_companion::inline(url.as_str(), &content)? } else { super::runtime_opencode_companion::inline(super::runtime_opencode_companion::Generation::V1, url.as_str(), &content)? }.to_string();
    }
    if work.iter().any(Work::is_cancelled) { return Err("PermissionDenied".into()); }
    let variable = if installed.harness == "kilo" { "KILO_CONFIG_CONTENT" } else { "OPENCODE_CONFIG_CONTENT" };
    Ok(Box::new(PackageResources { env: BTreeMap::from([(variable.into(), content)]), work }))
}
pub fn coverage(harness: &str) -> Value {
    let adapter = match harness {
        "claude" | "glm" | "mimo" | "alibaba" => Some("runtime_callback_companions (initialize callbacks)"),
        "pi" | "omp" => Some("runtime_callback_companions (existing extension bridge)"),
        "codex" => Some("runtime_codex_companion"), "opencode" => Some("runtime_opencode_companion"), "kilo" => Some("runtime_kilo_companion"), _ => None,
    };
    let reason = if adapter.is_some() { "Source adapter exists; installed version/API, launch and platform qualification pending." } else { match harness {
        "kimi" => "No demonstrated per-run native hook injection API.", "antigravity" => "Host permission bridge only; no demonstrated per-run plugin API.",
        "grok" => "Hook files require user/project configuration; no per-run loader.", "deepseek" => "Sandbox escalation bridge only; no verified hook interception API.",
        "commandcode" => "Configuration-file hooks only; Plan skips them.", "cline" => "SDK pluginPaths does not establish per-run ACP plugin loading.",
        "github-copilot" => "Hook directories/settings are global or project configuration; ACP loader unverified.", "hermes" => "Plugin enablement edits profile configuration; ACP hook execution unverified.",
        "zcode" => "Permission bridge exists; no verified native companion API.", "devin" => "Permission bridge covers only requested operations; no per-run hook loader.",
        "muse" => "Sandbox permission bridge only; no demonstrated companion API.", "cursor" => "Configuration-file hooks do not establish a per-run ACP loader.", _ => "No host adapter for this harness.",
    }};
    json!({"harness":harness,"adapter":adapter,"code":"UnsupportedCapability","reason":reason,"source":if adapter.is_some(){"sourceFeasible"}else{"unsupported"},"fake":"written, not run","recorded":"no live companion capture","installed":"not authorized or qualified","modelRequest":"notReported","compaction":"notReported"})
}
