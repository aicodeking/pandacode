//! Native, file-backed extension grants (runtime phase R1).
//!
//! One file, `extension-grants-v1/grants.json` in the app data directory, holds what the user granted to each
//! package: the permission names of the decided vocabulary, narrowed per project, per tool kind or per credential
//! item where the permission has such a scope. It is independent of SQLite and of `storage::SCHEMA_VERSION`.
//! Every native call site asks `RuntimeGrants::check`, so a webview or a package that skips the user interface
//! still meets `PermissionDenied`. Revoking, narrowing, untrusting or archiving cancels the privileged work that is
//! open and refuses new calls before any code starts. There is no `credentials.read` (ADR-0006): a credential is
//! only ever attached by the host (`credentials.use`), and its value never appears here.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex},
};

type Result<T> = std::result::Result<T, String>;

/// The decided vocabulary: ten existing, nine extended and thirty-one new names. The order is the one of
/// `MANIFEST_CAPABILITIES` in `contracts.ts` and of `permissions` in `tests/fixtures/extensions/examples-v1.json`.
pub const PERMISSIONS: [&str; 50] = [
    "btw.content", "btw.taskControl", "services.call", "connections.request", "tools.execute", "ui.contribute", "ui.customize", "ui.richViews", "storage.private",
    "projects.summary", "tasks.summary", "harnesses.inventory", "connections.summary", "jobs.summary", "projects.files.metadata", "projects.files.read", "projects.git.read",
    "tasks.transcript.read", "tasks.tools.read",
    "runtime.service", "events.workspace", "ui.dynamic", "ui.notify", "ui.presentation", "tasks.start", "tasks.message", "tasks.draft", "tasks.control", "tasks.usage.read",
    "harnesses.limits.read", "harnesses.accounts.read", "harness.hooks.observe", "harness.hooks.decide", "harness.hooks.context", "harness.companions", "harness.console",
    "tools.model", "models.call", "secrets.private", "credentials.use", "auth.signIn", "documents.editors", "workspace.manage", "workspace.settings", "terminals.read",
    "terminals.write", "guests.control", "projects.checks.run", "metrics.read", "internal.unstable",
];
/// Permissions the user can narrow to chosen projects.
pub(super) const PROJECT_SCOPED: [&str; 26] = [
    "btw.content", "btw.taskControl", "connections.request", "projects.summary", "tasks.summary", "projects.files.metadata", "projects.files.read", "projects.git.read",
    "tasks.transcript.read", "tasks.tools.read", "events.workspace", "tasks.start", "tasks.message", "tasks.draft", "tasks.control", "tasks.usage.read", "harness.hooks.observe",
    "harness.hooks.decide", "harness.hooks.context", "harness.console", "tools.model", "documents.editors", "workspace.manage", "terminals.read", "terminals.write",
    "projects.checks.run",
];
/// Permissions the user can narrow to tool kinds.
const TOOL_KIND_SCOPED: [&str; 1] = ["harness.hooks.decide"];
/// Permissions the user can narrow to named credential items.
const ITEM_SCOPED: [&str; 1] = ["credentials.use"];
const MAX_FILE: u64 = 4 * 1024 * 1024;
const MAX_SET: usize = 256;
const DENIED: &str = "PermissionDenied";

/// What a grant reaches. `None` in a dimension means every project, tool kind or item.
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Scope {
    #[serde(default, skip_serializing_if = "Option::is_none")] pub projects: Option<BTreeSet<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub tool_kinds: Option<BTreeSet<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub items: Option<BTreeSet<String>>,
}
/// What one native call is about to touch.
#[derive(Clone, Default)]
pub struct Target { pub project: Option<String>, pub tool_kind: Option<String>, pub item: Option<String> }
impl Target {
    pub fn project(id: &str) -> Self { Self { project: Some(id.into()), ..Self::default() } }
    pub fn tool(project: &str, kind: &str) -> Self { Self { project: Some(project.into()), tool_kind: Some(kind.into()), item: None } }
    pub fn item(item: &str) -> Self { Self { item: Some(item.into()), ..Self::default() } }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct File {
    schema_version: u8, revision: u64, packages: BTreeMap<String, Record>,
    /// Legacy consents already adopted, per package: permission names. A name here is never adopted again, so a
    /// later revoke or narrowing by the user is not undone by repeating the migration (`runtime_native_consents`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")] migrations: BTreeMap<String, BTreeSet<String>>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Record {
    version: String,
    declared: BTreeSet<String>,
    /// Digest of the package's executable content; `None` for a package that has none.
    #[serde(default)] digest: Option<String>,
    /// The digest the user trusted. A changed digest is untrusted until reviewed again.
    #[serde(default)] trusted_digest: Option<String>,
    /// Archived, disabled or in safe mode: grants are kept but carry no authority.
    #[serde(default)] archived: bool,
    grants: BTreeMap<String, Scope>,
}
impl Record {
    fn authorized(&self) -> bool { !self.archived && (self.digest.is_none() || self.digest == self.trusted_digest) }
}
struct Loaded { file: File, corrupt: bool }
struct Open { token: u64, id: String, version: String, permission: String, target: Target, cancelled: Arc<AtomicBool> }
type Registry = Arc<Mutex<Vec<Open>>>;

/// Privileged work admitted by `begin`. It is cancelled when the authority behind it goes away.
pub struct Work { token: u64, cancelled: Arc<AtomicBool>, registry: Registry }
impl Work {
    pub fn is_cancelled(&self) -> bool { self.cancelled.load(Ordering::SeqCst) }
}
impl Drop for Work {
    fn drop(&mut self) { if let Ok(mut open) = self.registry.lock() { open.retain(|item| item.token != self.token); } }
}

pub struct RuntimeGrants { path: PathBuf, state: Mutex<Loaded>, work: Registry, next: AtomicU64 }

fn known(permission: &str) -> bool { PERMISSIONS.contains(&permission) }
fn set_ok(set: &BTreeSet<String>) -> bool { !set.is_empty() && set.len() <= MAX_SET && set.iter().all(|value| !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)) }
fn scope_valid(permission: &str, scope: &Scope) -> Result<()> {
    if !known(permission) { return Err("UnsupportedCapability".into()); }
    let allowed = |list: &[&str]| list.contains(&permission);
    for (set, scoped) in [(&scope.projects, allowed(&PROJECT_SCOPED)), (&scope.tool_kinds, allowed(&TOOL_KIND_SCOPED)), (&scope.items, allowed(&ITEM_SCOPED))] {
        if let Some(set) = set { if !scoped || !set_ok(set) { return Err("InvalidArguments".into()); } }
    }
    Ok(())
}
fn within(allowed: &Option<BTreeSet<String>>, value: &Option<String>) -> bool {
    match allowed { None => true, Some(set) => value.as_ref().is_some_and(|value| set.contains(value)) }
}
fn subset(old: &Option<BTreeSet<String>>, new: &Option<BTreeSet<String>>) -> bool {
    match (old, new) { (None, _) => true, (Some(_), None) => false, (Some(old), Some(new)) => new.is_subset(old) }
}
fn allowed(file: &File, id: &str, version: &str, permission: &str, target: &Target) -> Result<()> {
    if !known(permission) { return Err("UnsupportedCapability".into()); }
    let record = file.packages.get(id).ok_or(DENIED)?;
    if record.version != version || !record.authorized() { return Err(DENIED.into()); }
    let scope = record.grants.get(permission).ok_or(DENIED)?;
    if within(&scope.projects, &target.project) && within(&scope.tool_kinds, &target.tool_kind) && within(&scope.items, &target.item) { Ok(()) } else { Err(DENIED.into()) }
}
fn valid(file: &File) -> bool {
    file.schema_version == 1 && file.migrations.iter().all(|(id, done)| id.len() <= 128 && done.iter().all(|name| known(name))) && file.packages.iter().all(|(id, record)| {
        !id.is_empty() && id.len() <= 128 && record.declared.iter().all(|name| known(name))
            && record.grants.iter().all(|(name, scope)| record.declared.contains(name) && scope_valid(name, scope).is_ok())
    })
}

impl RuntimeGrants {
    /// Opens `<dir>/extension-grants-v1/grants.json`. A missing file is an empty store; an unreadable or malformed
    /// one is kept as it is, answers `PermissionDenied` to every check and refuses every change.
    pub fn open(dir: &Path) -> Self {
        let path = dir.join("extension-grants-v1").join("grants.json");
        let loaded = match std::fs::metadata(&path) {
            Err(_) => Loaded { file: File { schema_version: 1, ..File::default() }, corrupt: false },
            Ok(meta) if meta.len() > MAX_FILE => Loaded { file: File::default(), corrupt: true },
            Ok(_) => match std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<File>(&bytes).ok()).filter(valid) {
                Some(file) => Loaded { file, corrupt: false },
                None => Loaded { file: File::default(), corrupt: true },
            },
        };
        Self { path, state: Mutex::new(loaded), work: Arc::default(), next: AtomicU64::new(1) }
    }
    fn write(&self, file: &File) -> Result<()> {
        let parent = self.path.parent().ok_or("StorageUnavailable")?;
        std::fs::create_dir_all(parent).map_err(|_| "StorageUnavailable")?;
        let stage = self.path.with_extension("stage");
        std::fs::write(&stage, serde_json::to_vec(file).map_err(|_| "MalformedData")?).map_err(|_| "StorageUnavailable")?;
        std::fs::rename(&stage, &self.path).map_err(|_| "StorageUnavailable".to_string())
    }
    /// Applies `change` to a copy, writes it, then swaps it in and cancels work the new state no longer allows.
    /// Nothing changes when the change or the write fails. A change that alters nothing is not written.
    fn mutate<T>(&self, change: impl FnOnce(&mut File) -> Result<T>) -> Result<T> {
        let mut state = self.state.lock().map_err(|_| "StorageUnavailable")?;
        if state.corrupt { return Err("MalformedData".into()); }
        let mut next = File { schema_version: 1, revision: state.file.revision, packages: state.file.packages.clone(), migrations: state.file.migrations.clone() };
        let value = change(&mut next)?;
        let before = serde_json::to_vec(&(&state.file.packages, &state.file.migrations)).map_err(|_| "MalformedData")?;
        if serde_json::to_vec(&(&next.packages, &next.migrations)).map_err(|_| "MalformedData")? == before { return Ok(value); }
        next.revision += 1;
        self.write(&next)?;
        state.file = next;
        if let Ok(mut open) = self.work.lock() {
            open.retain(|item| {
                let keep = allowed(&state.file, &item.id, &item.version, &item.permission, &item.target).is_ok();
                if !keep { item.cancelled.store(true, Ordering::SeqCst); }
                keep
            });
        }
        Ok(value)
    }

    /// Registers or updates one installed package. An update keeps the grants of names it still declares, drops the
    /// others, and leaves new names ungranted; a changed executable digest is untrusted until reviewed again.
    fn register(file: &mut File, id: &str, version: &str, declared: &BTreeSet<String>, digest: Option<&str>) -> Result<()> {
        if id.is_empty() || id.len() > 128 { return Err("InvalidArguments".into()); }
        if let Some(name) = declared.iter().find(|name| !known(name)) { return Err(format!("UnsupportedCapability: {name}")); }
        let digest = digest.map(str::to_owned);
        let record = file.packages.entry(id.to_owned()).or_insert_with(|| Record { version: version.into(), declared: BTreeSet::new(), digest: digest.clone(), trusted_digest: None, archived: false, grants: BTreeMap::new() });
        record.version = version.into();
        record.grants.retain(|name, _| declared.contains(name));
        if let Some(done) = file.migrations.get_mut(id) { done.retain(|name| declared.contains(name)); }
        record.declared = declared.clone();
        if record.digest != digest { record.digest = digest; }
        if record.trusted_digest.is_some() && record.trusted_digest != record.digest { record.trusted_digest = None; }
        Ok(())
    }
    /// Brings the store in line with `extensions_snapshot` JSON: installs, updates, trust, enabled state and uninstalls.
    /// A package that is disabled, untrusted or in safe mode keeps its grants but has no authority.
    pub fn sync(&self, snapshot: &Value) -> Result<()> {
        let safe = snapshot["safeMode"] == true;
        let packages = snapshot["packages"].as_array().ok_or("InvalidShape")?;
        self.mutate(|file| {
            let mut present = BTreeSet::new();
            for package in packages {
                let manifest = &package["manifest"];
                let (Some(id), Some(version)) = (manifest["id"].as_str(), manifest["version"].as_str()) else { continue };
                let mut declared = BTreeSet::new();
                for key in ["permissions", "requiredCapabilities"] { for name in manifest[key].as_array().into_iter().flatten().filter_map(Value::as_str) { declared.insert(name.to_owned()); } }
                let digest = package["executable"]["digest"].as_str();
                if Self::register(file, id, version, &declared, digest).is_err() { continue; }
                present.insert(id.to_owned());
                let record = file.packages.get_mut(id).ok_or("InvalidArguments")?;
                record.trusted_digest = if package["executable"]["trusted"] == true { digest.map(str::to_owned) } else { None };
                record.archived = safe || package["enabled"] != true;
            }
            // Safe mode reports no packages: that is a suspension, not an uninstall, so every record is kept
            // (archived) and its grants come back with the next normal launch.
            if safe { for record in file.packages.values_mut() { record.archived = true; } return Ok(()); }
            file.packages.retain(|id, _| present.contains(id));
            file.migrations.retain(|id, done| present.contains(id) && !done.is_empty());
            Ok(())
        })
    }
    /// Adopts legacy consents as grants in ONE write: every entry is validated first and nothing changes if any fails
    /// or the write fails. An entry whose package or permission is not declared is skipped, as is one already adopted
    /// (`migrations`) or already granted; the user's later revoke is therefore never undone. Answers the adopted entries.
    pub(super) fn adopt(&self, entries: &[(String, String, Scope)]) -> Result<Vec<(String, String)>> {
        for (_, permission, scope) in entries { scope_valid(permission, scope)?; }
        self.mutate(|file| {
            let mut adopted = vec![];
            for (id, permission, scope) in entries {
                let Some(record) = file.packages.get_mut(id) else { continue };
                if !record.declared.contains(permission) { continue; }
                if !file.migrations.entry(id.clone()).or_default().insert(permission.clone()) { continue; }
                if record.grants.contains_key(permission) { continue; }
                record.grants.insert(permission.clone(), scope.clone());
                adopted.push((id.clone(), permission.clone()));
            }
            file.migrations.retain(|_, done| !done.is_empty());
            Ok(adopted)
        })
    }
    /// Registers or updates a package directly (install and update review use this with the user's decision).
    pub fn register_package(&self, id: &str, version: &str, declared: &[&str], digest: Option<&str>) -> Result<()> {
        let declared: BTreeSet<String> = declared.iter().map(|name| (*name).to_owned()).collect();
        self.mutate(|file| Self::register(file, id, version, &declared, digest))
    }
    pub fn trust(&self, id: &str, allow: bool) -> Result<()> {
        self.mutate(|file| { let record = file.packages.get_mut(id).ok_or(DENIED)?; record.trusted_digest = if allow { record.digest.clone() } else { None }; Ok(()) })
    }
    pub fn archive(&self, id: &str, archived: bool) -> Result<()> {
        self.mutate(|file| { file.packages.get_mut(id).ok_or(DENIED)?.archived = archived; Ok(()) })
    }
    /// Gives `permission` to a package that declares it, replacing any earlier scope (the user may widen).
    pub fn grant(&self, id: &str, permission: &str, scope: Scope) -> Result<()> {
        scope_valid(permission, &scope)?;
        self.mutate(|file| {
            let record = file.packages.get_mut(id).ok_or(DENIED)?;
            if !record.declared.contains(permission) { return Err(DENIED.into()); }
            record.grants.insert(permission.to_owned(), scope);
            Ok(())
        })
    }
    /// Reduces an existing grant; never widens it.
    pub fn narrow(&self, id: &str, permission: &str, scope: Scope) -> Result<()> {
        scope_valid(permission, &scope)?;
        self.mutate(|file| {
            let record = file.packages.get_mut(id).ok_or(DENIED)?;
            let current = record.grants.get_mut(permission).ok_or(DENIED)?;
            if !subset(&current.projects, &scope.projects) || !subset(&current.tool_kinds, &scope.tool_kinds) || !subset(&current.items, &scope.items) { return Err("InvalidArguments".into()); }
            *current = scope;
            Ok(())
        })
    }
    pub fn revoke(&self, id: &str, permission: &str) -> Result<()> {
        if !known(permission) { return Err("UnsupportedCapability".into()); }
        self.mutate(|file| { file.packages.get_mut(id).ok_or(DENIED)?.grants.remove(permission); Ok(()) })
    }
    pub fn revoke_all(&self, id: &str) -> Result<()> {
        self.mutate(|file| { file.packages.get_mut(id).ok_or(DENIED)?.grants.clear(); Ok(()) })
    }

    /// The one gate of every native call site. Missing, revoked, narrowed-out, stale-version, archived and untrusted
    /// all answer `PermissionDenied`; a name outside the vocabulary (including `credentials.read`) is `UnsupportedCapability`.
    pub fn check(&self, id: &str, version: &str, permission: &str, target: &Target) -> Result<()> {
        let state = self.state.lock().map_err(|_| DENIED)?;
        if state.corrupt { return Err(DENIED.into()); }
        allowed(&state.file, id, version, permission, target)
    }
    /// Checks, then registers privileged work that revoke, narrowing, untrust or archive will cancel.
    pub fn begin(&self, id: &str, version: &str, permission: &str, target: &Target) -> Result<Work> {
        let state = self.state.lock().map_err(|_| DENIED)?;
        if state.corrupt { return Err(DENIED.into()); }
        allowed(&state.file, id, version, permission, target)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let token = self.next.fetch_add(1, Ordering::SeqCst);
        self.work.lock().map_err(|_| DENIED)?.push(Open { token, id: id.into(), version: version.into(), permission: permission.into(), target: target.clone(), cancelled: cancelled.clone() });
        Ok(Work { token, cancelled, registry: self.work.clone() })
    }
    /// The read projection the webview gets: names, scopes and state, never anything secret.
    pub fn projection(&self) -> Value {
        let Ok(state) = self.state.lock() else { return json!({"schemaVersion":1,"available":false,"revision":0,"vocabulary":PERMISSIONS.as_slice(),"packages":[]}); };
        let packages: Vec<Value> = state.file.packages.iter().map(|(id, record)| {
            let authorized = record.authorized();
            json!({
                "id": id, "version": record.version, "declared": record.declared, "archived": record.archived, "authorized": authorized,
                "trusted": record.digest.is_none() || record.digest == record.trusted_digest,
                "grants": record.grants.iter().map(|(permission, scope)| json!({"permission": permission, "scope": scope})).collect::<Vec<_>>(),
                "uiCustomize": authorized && record.grants.contains_key("ui.customize"),
            })
        }).collect();
        json!({"schemaVersion":1,"available":!state.corrupt,"revision":state.file.revision,"vocabulary":PERMISSIONS.as_slice(),"packages":packages})
    }
}

#[tauri::command]
pub fn extensions_runtime_grants(packages: tauri::State<'_, super::packages::ExtensionPackages>, grants: tauri::State<'_, RuntimeGrants>) -> Result<Value> {
    let snapshot = serde_json::to_value(packages.0.lock().map_err(|_| "Extension manager unavailable.")?.snapshot()).map_err(|_| "MalformedData")?;
    grants.sync(&snapshot)?;
    Ok(grants.projection())
}
/// `{ op: 'grant' | 'narrow' | 'revoke' | 'revokeAll', id, permission?, scope? }`; answers the new projection.
#[tauri::command]
pub fn extensions_runtime_grant(app: tauri::AppHandle, packages: tauri::State<'_, super::packages::ExtensionPackages>, grants: tauri::State<'_, RuntimeGrants>, request: Value) -> Result<Value> {
    let snapshot = serde_json::to_value(packages.0.lock().map_err(|_| "Extension manager unavailable.")?.snapshot()).map_err(|_| "MalformedData")?;
    grants.sync(&snapshot)?;
    let id = request["id"].as_str().ok_or("InvalidArguments")?;
    let permission = request["permission"].as_str();
    let scope = || serde_json::from_value::<Scope>(request.get("scope").cloned().unwrap_or_else(|| json!({}))).map_err(|_| "InvalidArguments".to_string());
    match (request["op"].as_str(), permission) {
        (Some("grant"), Some(permission)) => grants.grant(id, permission, scope()?)?,
        (Some("narrow"), Some(permission)) => grants.narrow(id, permission, scope()?)?,
        (Some("revoke"), Some(permission)) => grants.revoke(id, permission)?,
        (Some("revokeAll"), _) => grants.revoke_all(id)?,
        _ => return Err("InvalidArguments".into()),
    }
    if matches!(request["op"].as_str(), Some("narrow" | "revoke" | "revokeAll"))
        && (request["op"] == "revokeAll"
            || permission.is_some_and(|name| matches!(name,
                "harness.hooks.observe" | "harness.hooks.decide" | "harness.companions" | "runtime.service")))
    {
        if let Ok(mut companions) = super::runtime_companion_lifetime::registry().lock() {
            companions.end_owner(id, super::runtime_companion_lifetime::StopReason::Revoked);
        }
    }
    // A new `runtime.service` grant starts the service; a revoked one already cancelled its grant work.
    super::runtime_service_lifetime::reconcile_app(&app);
    // A revoked or narrowed ui.notify takes the package's notices off both surfaces at once (R0207).
    super::runtime_notifications::sweep_app(&app);
    // A revoked or narrowed ui.dynamic returns the package's providers to their manifest values (R0806).
    super::runtime_provider_state::sweep_app(&app);
    // A revoked ui.richViews destroys the package's panels and separate windows (R0301).
    super::rich_views::runtime_rich_mount::sweep_app(&app);
    // A revoked tasks.draft grant empties the package's draft ghosts and pending asks (R0403).
    super::runtime_tasks_drafts::sweep_app(&app);
    Ok(grants.projection())
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIXTURE: &str = include_str!("../../../tests/fixtures/extensions/runtime-grants/scenario.json");
    const EXAMPLES: &str = include_str!("../../../tests/fixtures/extensions/examples-v1.json");
    struct Dir(PathBuf);
    impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-grants-test-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn set(values: &[&str]) -> Option<BTreeSet<String>> { Some(values.iter().map(|value| (*value).to_owned()).collect()) }
    fn projects(values: &[&str]) -> Scope { Scope { projects: set(values), ..Scope::default() } }
    const ID: &str = "sample.grants-laboratory";
    const START: [&str; 5] = ["ui.customize", "tasks.start", "harness.hooks.decide", "credentials.use", "projects.checks.run"];
    fn install(grants: &RuntimeGrants) { grants.register_package(ID, "1.0.0", &START, Some("digest-a")).unwrap(); grants.trust(ID, true).unwrap(); }

    #[test]
    fn vocabulary_is_fifty_unique_names_without_credentials_read_and_matches_the_corpus() {
        assert_eq!(PERMISSIONS.iter().collect::<BTreeSet<_>>().len(), 50);
        assert!(PERMISSIONS.contains(&"projects.checks.run") && PERMISSIONS.contains(&"ui.customize") && PERMISSIONS.contains(&"credentials.use"));
        assert!(!PERMISSIONS.iter().any(|name| name.starts_with("credentials.read")));
        let corpus: Value = serde_json::from_str(EXAMPLES).unwrap();
        let listed: Vec<&str> = corpus["permissions"].as_array().unwrap().iter().map(|value| value.as_str().unwrap()).collect();
        assert_eq!(listed, PERMISSIONS.to_vec());
        for name in PROJECT_SCOPED.iter().chain(&TOOL_KIND_SCOPED).chain(&ITEM_SCOPED) { assert!(known(name), "{name}"); }
    }

    #[test]
    fn a_name_outside_the_vocabulary_never_registers_grants_or_checks() {
        let dir = Dir::new(); let grants = RuntimeGrants::open(&dir.0);
        assert!(grants.register_package(ID, "1.0.0", &["credentials.read"], None).unwrap_err().starts_with("UnsupportedCapability"));
        install(&grants);
        assert_eq!(grants.grant(ID, "credentials.read", Scope::default()).unwrap_err(), "UnsupportedCapability");
        assert_eq!(grants.check(ID, "1.0.0", "credentials.read", &Target::default()).unwrap_err(), "UnsupportedCapability");
        assert!(!std::fs::read_to_string(dir.0.join("extension-grants-v1").join("grants.json")).unwrap().contains("credentials.read"));
    }

    #[test]
    fn ui_customize_is_persisted_projected_and_survives_restart_and_update() {
        let dir = Dir::new(); let grants = RuntimeGrants::open(&dir.0); install(&grants);
        assert!(!grants.projection()["packages"][0]["uiCustomize"].as_bool().unwrap());
        grants.grant(ID, "ui.customize", Scope::default()).unwrap();
        grants.grant(ID, "tasks.start", projects(&["A"])).unwrap();
        assert!(grants.projection()["packages"][0]["uiCustomize"].as_bool().unwrap());
        // restart
        let grants = RuntimeGrants::open(&dir.0);
        assert!(grants.projection()["packages"][0]["uiCustomize"].as_bool().unwrap());
        grants.check(ID, "1.0.0", "ui.customize", &Target::default()).unwrap();
        grants.check(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap();
        // update with the same executable: grants of the names it still declares survive, a removed name is dropped, a new one is not granted
        grants.register_package(ID, "1.1.0", &["ui.customize", "tasks.start", "tasks.message"], Some("digest-a")).unwrap();
        assert_eq!(grants.check(ID, "1.0.0", "ui.customize", &Target::default()).unwrap_err(), "PermissionDenied");
        grants.check(ID, "1.1.0", "ui.customize", &Target::default()).unwrap();
        grants.check(ID, "1.1.0", "tasks.start", &Target::project("A")).unwrap();
        assert_eq!(grants.check(ID, "1.1.0", "tasks.start", &Target::project("B")).unwrap_err(), "PermissionDenied");
        assert_eq!(grants.check(ID, "1.1.0", "tasks.message", &Target::project("A")).unwrap_err(), "PermissionDenied");
        assert_eq!(grants.check(ID, "1.1.0", "credentials.use", &Target::item("x")).unwrap_err(), "PermissionDenied");
        let grants = RuntimeGrants::open(&dir.0);
        grants.check(ID, "1.1.0", "ui.customize", &Target::default()).unwrap();
        // a changed executable keeps the grants but must be trusted again before any code starts
        grants.register_package(ID, "1.2.0", &["ui.customize", "tasks.start"], Some("digest-b")).unwrap();
        assert_eq!(grants.check(ID, "1.2.0", "ui.customize", &Target::default()).unwrap_err(), "PermissionDenied");
        grants.trust(ID, true).unwrap();
        grants.check(ID, "1.2.0", "ui.customize", &Target::default()).unwrap();
    }

    #[test]
    fn narrowing_projects_tool_kinds_and_credential_items_refuses_a_direct_native_bypass() {
        let dir = Dir::new(); let grants = RuntimeGrants::open(&dir.0); install(&grants);
        grants.grant(ID, "tasks.start", projects(&["A", "B"])).unwrap();
        grants.grant(ID, "harness.hooks.decide", Scope { projects: set(&["A"]), tool_kinds: set(&["shell", "edit"]), items: None }).unwrap();
        grants.grant(ID, "credentials.use", Scope { items: set(&["github", "openai"]), ..Scope::default() }).unwrap();
        grants.grant(ID, "projects.checks.run", projects(&["A"])).unwrap();
        grants.narrow(ID, "tasks.start", projects(&["A"])).unwrap();
        grants.narrow(ID, "harness.hooks.decide", Scope { projects: set(&["A"]), tool_kinds: set(&["shell"]), items: None }).unwrap();
        grants.narrow(ID, "credentials.use", Scope { items: set(&["github"]), ..Scope::default() }).unwrap();
        let denied = |permission: &str, target: Target| assert_eq!(grants.check(ID, "1.0.0", permission, &target).unwrap_err(), "PermissionDenied", "{permission}");
        grants.check(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap();
        denied("tasks.start", Target::project("B")); denied("tasks.start", Target::default());
        grants.check(ID, "1.0.0", "harness.hooks.decide", &Target::tool("A", "shell")).unwrap();
        denied("harness.hooks.decide", Target::tool("A", "edit")); denied("harness.hooks.decide", Target::tool("B", "shell"));
        grants.check(ID, "1.0.0", "credentials.use", &Target::item("github")).unwrap();
        denied("credentials.use", Target::item("openai")); denied("credentials.use", Target::default());
        grants.check(ID, "1.0.0", "projects.checks.run", &Target::project("A")).unwrap(); denied("projects.checks.run", Target::project("B"));
        // narrowing never widens; a scope the permission does not have is refused; an undeclared permission cannot be granted
        assert_eq!(grants.narrow(ID, "tasks.start", projects(&["A", "C"])).unwrap_err(), "InvalidArguments");
        assert_eq!(grants.narrow(ID, "tasks.start", Scope::default()).unwrap_err(), "InvalidArguments");
        assert_eq!(grants.grant(ID, "ui.customize", projects(&["A"])).unwrap_err(), "InvalidArguments");
        assert_eq!(grants.grant(ID, "tasks.control", Scope::default()).unwrap_err(), "PermissionDenied");
        let grants = RuntimeGrants::open(&dir.0);
        assert_eq!(grants.check(ID, "1.0.0", "tasks.start", &Target::project("B")).unwrap_err(), "PermissionDenied");
        assert_eq!(grants.check("other.package", "1.0.0", "tasks.start", &Target::project("A")).unwrap_err(), "PermissionDenied");
    }

    #[test]
    fn revoke_cancels_open_work_and_prevents_new_calls_while_other_work_continues() {
        let dir = Dir::new(); let grants = RuntimeGrants::open(&dir.0); install(&grants);
        grants.grant(ID, "tasks.start", projects(&["A", "B"])).unwrap(); grants.grant(ID, "ui.customize", Scope::default()).unwrap();
        let a = grants.begin(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap();
        let b = grants.begin(ID, "1.0.0", "tasks.start", &Target::project("B")).unwrap();
        let other = grants.begin(ID, "1.0.0", "ui.customize", &Target::default()).unwrap();
        grants.narrow(ID, "tasks.start", projects(&["A"])).unwrap();
        assert!(!a.is_cancelled() && b.is_cancelled() && !other.is_cancelled());
        grants.revoke(ID, "tasks.start").unwrap();
        assert!(a.is_cancelled() && !other.is_cancelled());
        assert_eq!(grants.begin(ID, "1.0.0", "tasks.start", &Target::project("A")).err().unwrap(), "PermissionDenied");
        grants.revoke_all(ID).unwrap(); assert!(other.is_cancelled());
        drop((a, b, other)); assert!(grants.work.lock().unwrap().is_empty());
        let grants = RuntimeGrants::open(&dir.0);
        assert_eq!(grants.check(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap_err(), "PermissionDenied");
        assert_eq!(grants.check(ID, "1.0.0", "ui.customize", &Target::default()).unwrap_err(), "PermissionDenied");
    }

    #[test]
    fn trust_archive_and_snapshot_changes_invalidate_authority_before_code_starts() {
        let dir = Dir::new(); let grants = RuntimeGrants::open(&dir.0); install(&grants);
        grants.grant(ID, "tasks.start", Scope::default()).unwrap();
        let work = grants.begin(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap();
        grants.trust(ID, false).unwrap(); assert!(work.is_cancelled());
        assert_eq!(grants.check(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap_err(), "PermissionDenied");
        grants.trust(ID, true).unwrap(); grants.check(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap();
        let work = grants.begin(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap();
        grants.archive(ID, true).unwrap(); assert!(work.is_cancelled());
        assert_eq!(grants.check(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap_err(), "PermissionDenied");
        assert!(!grants.projection()["packages"][0]["authorized"].as_bool().unwrap());
        grants.archive(ID, false).unwrap(); grants.check(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap();
        // the same transitions through `extensions_snapshot` JSON: safe mode, disabled-and-untrusted, then an uninstall
        let package = |trusted: bool, enabled: bool| json!({"manifest":{"id":ID,"version":"1.0.0","permissions":["tasks.start"]},"enabled":enabled,"executable":{"digest":"digest-a","trusted":trusted}});
        grants.sync(&json!({"safeMode":false,"packages":[package(true, true)]})).unwrap();
        grants.check(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap();
        grants.sync(&json!({"safeMode":true,"packages":[package(true, true)]})).unwrap();
        assert_eq!(grants.check(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap_err(), "PermissionDenied");
        grants.sync(&json!({"safeMode":false,"packages":[package(false, false)]})).unwrap();
        assert_eq!(grants.check(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap_err(), "PermissionDenied");
        grants.sync(&json!({"safeMode":false,"packages":[package(true, true)]})).unwrap();
        grants.check(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap();
        grants.sync(&json!({"safeMode":false,"packages":[]})).unwrap();
        assert_eq!(grants.projection()["packages"], json!([]));
    }

    #[test]
    fn a_corrupt_or_unwritable_store_fails_closed_and_keeps_its_bytes() {
        let dir = Dir::new(); let grants = RuntimeGrants::open(&dir.0); install(&grants);
        grants.grant(ID, "tasks.start", Scope::default()).unwrap();
        let path = dir.0.join("extension-grants-v1").join("grants.json");
        std::fs::write(&path, b"{malformed").unwrap();
        let grants = RuntimeGrants::open(&dir.0);
        assert_eq!(grants.check(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap_err(), "PermissionDenied");
        assert_eq!(grants.grant(ID, "tasks.start", Scope::default()).unwrap_err(), "MalformedData");
        assert_eq!(grants.projection()["available"], false);
        assert_eq!(std::fs::read(&path).unwrap(), b"{malformed");
        // a file that names an unknown permission is malformed, not silently trimmed
        std::fs::write(&path, br#"{"schemaVersion":1,"revision":1,"packages":{"x.y":{"version":"1.0.0","declared":["credentials.read"],"grants":{}}}}"#).unwrap();
        assert_eq!(RuntimeGrants::open(&dir.0).projection()["available"], false);
        // a failed write leaves the store as it was
        std::fs::write(&path, br#"{"schemaVersion":1,"revision":0,"packages":{}}"#).unwrap();
        let grants = RuntimeGrants::open(&dir.0); install(&grants);
        std::fs::create_dir(path.with_extension("stage")).unwrap();
        assert_eq!(grants.grant(ID, "tasks.start", Scope::default()).unwrap_err(), "StorageUnavailable");
        assert_eq!(grants.check(ID, "1.0.0", "tasks.start", &Target::project("A")).unwrap_err(), "PermissionDenied");
    }

    #[test]
    fn two_project_fixture_scenario_runs_grant_restart_direct_call_revoke_and_repeat() {
        let scenario: Value = serde_json::from_str(FIXTURE).unwrap();
        let dir = Dir::new(); let mut grants = RuntimeGrants::open(&dir.0);
        let manifest = &scenario["package"];
        let declared: Vec<&str> = manifest["permissions"].as_array().unwrap().iter().map(|value| value.as_str().unwrap()).collect();
        let (id, version) = (manifest["id"].as_str().unwrap(), manifest["version"].as_str().unwrap());
        grants.register_package(id, version, &declared, Some("fixture-digest")).unwrap(); grants.trust(id, true).unwrap();
        for step in scenario["steps"].as_array().unwrap() {
            let permission = step["permission"].as_str().unwrap_or("");
            let scope: Scope = serde_json::from_value(step.get("scope").cloned().unwrap_or_else(|| json!({}))).unwrap();
            let target = Target { project: step["project"].as_str().map(str::to_owned), tool_kind: step["toolKind"].as_str().map(str::to_owned), item: step["item"].as_str().map(str::to_owned) };
            match step["op"].as_str().unwrap() {
                "grant" => grants.grant(id, permission, scope).unwrap(),
                "narrow" => grants.narrow(id, permission, scope).unwrap(),
                "revoke" => grants.revoke(id, permission).unwrap(),
                "restart" => grants = RuntimeGrants::open(&dir.0),
                "check" => {
                    let result = grants.check(id, version, permission, &target);
                    match step["expect"].as_str().unwrap() { "ok" => result.unwrap(), expected => assert_eq!(result.unwrap_err(), expected, "{step}") }
                }
                other => panic!("unknown step {other}"),
            }
        }
    }

    #[test]
    fn every_native_check_name_is_also_a_manifest_name() {
        // The validator and the store share one list: a permission the store grants is one a manifest may declare.
        let source = include_str!("contracts.rs");
        assert!(source.contains("runtime_grants::PERMISSIONS"));
        assert!(!source.contains("\"tasks.tools.read\"].contains"));
    }
}
