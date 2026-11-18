//! R0601: run-bound companion lifecycle, tied to native launch and extension teardown.
//! Profiles/resources come from host adapters, never extension JSON or the webview.
//! Lease IDs are correlation identities, NOT callback credentials. No listener is opened here.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{LazyLock, Mutex};
use std::path::{Path, PathBuf};
use std::io::Write;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunKey { pub task_id: String, pub run_id: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApi { pub harness: String, pub version: Option<String>, pub apis: Vec<String> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String, pub harness: String, pub versions: Vec<String>, pub api: String,
    pub protocol: u32, pub evidence: Evidence,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Evidence { Synthetic, SourceFeasible, InstalledQualified, Unsupported }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason { RunEnded, Disabled, Revoked, ServiceFailure, SafeMode, HostShutdown }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub state: String, pub code: Option<String>, pub reason: Option<String>, pub harness: String,
    pub version: Option<String>, pub profile: Option<String>, pub evidence: Evidence,
    pub ordinary_approvals: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease { #[serde(flatten)] pub key: RunKey, pub lease_id: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32, #[serde(flatten)] pub lease: Lease, pub profile: String, pub protocol: u32,
}

/// Exact profiles avoid treating a source pin or a future major as installed qualification.
/// An adapter probes its installed executable/API and supplies a matching host-owned profile.
pub fn negotiate(installed: &InstalledApi, profile: Option<&Profile>) -> Capability {
    let reason = match profile {
        None => Some("No host companion profile for this harness."),
        Some(p) if p.harness != installed.harness => Some("No host companion profile for this harness."),
        Some(p) if p.protocol != 1 => Some("The host does not implement this companion protocol."),
        Some(p) if installed.version.as_ref().is_none_or(|version| !p.versions.contains(version)) => Some("The installed version has no qualified companion profile."),
        Some(p) if !installed.apis.contains(&p.api) => Some("The installed harness does not expose the required per-run API."),
        Some(_) => None,
    };
    Capability {
        state: if reason.is_some() { "unsupported" } else { "ready" }.into(),
        code: reason.map(|_| "UnsupportedCapability".into()), reason: reason.map(str::to_owned),
        harness: installed.harness.clone(), version: installed.version.clone(), profile: profile.map(|p| p.id.clone()),
        evidence: if reason.is_some() { Evidence::Unsupported } else { profile.unwrap().evidence },
        ordinary_approvals: "unchanged".into(),
    }
}

/// A host adapter owns its per-run directory and any handlers. close MUST be idempotent and retryable,
/// withdraw injection before closing handlers, cancel pending work, and remove only its owned files.
/// No code here writes user/project configuration. Failed factories must roll back partial resources.
/// Methods/factories must not reenter the lifecycle mutex. No callback listener is implemented here.
pub trait Resources: Send {
    fn environment(&self) -> BTreeMap<String, String>;
    fn close(&mut self) -> Result<(), String>;
}

/// Filesystem delivery for a bundled host artifact. The parent MUST already be an app-owned per-run root;
/// caller grants admission before constructing it. No search for, read of, or merge into CLI configs occurs.
/// Names are flat so cleanup needs no recursive traversal. V2 directory packages can contain package.json/index.js.
pub struct DirectoryResources { directory: PathBuf, files: Vec<PathBuf>, descriptor: PathBuf }
impl DirectoryResources {
    pub fn prepare(root: &Path, manifest: &Manifest, artifacts: &[(&str, &[u8])]) -> Result<Self, String> {
        if !root.is_absolute() || !root.is_dir() || artifacts.is_empty() { return Err("Invalid companion directory or bundle.".into()); }
        let mut names = BTreeSet::new();
        for (name, _) in artifacts {
            if name.is_empty() || name.len() > 128 || *name == "run.json" || name.starts_with('.')
                || !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
                || !names.insert(*name) { return Err("Invalid or duplicate companion artifact name.".into()); }
        }
        let directory = root.join(format!("companion-{}", uuid::Uuid::new_v4()));
        let builder = std::fs::DirBuilder::new();
        #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
        builder.create(&directory).map_err(|_| "Could not create companion directory.")?;
        let descriptor = directory.join("run.json");
        let mut resource = Self { directory, files: vec![descriptor.clone()], descriptor };
        // Register every path before writing: even a short write is covered by teardown.
        let populated = (|| -> std::io::Result<()> {
            for (name, bytes) in artifacts {
                let file = resource.directory.join(name); resource.files.push(file.clone());
                private_file(&file, bytes)?;
            }
            let bytes = serde_json::to_vec(manifest).map_err(std::io::Error::other)?;
            private_file(&resource.descriptor, &bytes)?; Ok(())
        })();
        if populated.is_err() {
            return Err(if resource.close().is_err() { "Companion preparation and owned-file cleanup failed." } else { "Could not prepare companion bundle." }.into());
        }
        Ok(resource)
    }
}
fn private_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    options.open(path)?.write_all(bytes)
}
impl Resources for DirectoryResources {
    fn environment(&self) -> BTreeMap<String, String> { BTreeMap::from([("PANDACODE_COMPANION_MANIFEST".into(), self.descriptor.to_string_lossy().into_owned())]) }
    fn close(&mut self) -> Result<(), String> {
        // The descriptor is always first. Windows may hold a loaded artifact; report pending and retry it later.
        for file in &self.files {
            if let Err(error) = std::fs::remove_file(file) { if error.kind() != std::io::ErrorKind::NotFound { return Err("Companion file cleanup pending.".into()); } }
        }
        if let Err(error) = std::fs::remove_dir(&self.directory) { if error.kind() != std::io::ErrorKind::NotFound { return Err("Companion directory cleanup pending.".into()); } }
        Ok(())
    }
}
impl Drop for DirectoryResources { fn drop(&mut self) { let _ = self.close(); } }
pub struct Launch { pub lease: Lease, pub env: BTreeMap<String, String>, pub capability: Capability }
struct Entry {
    lease: Lease, owners: BTreeSet<String>, capability: Capability, active: bool,
    reason: Option<StopReason>, resources: Option<Box<dyn Resources>>, cleanup_pending: bool,
}
pub struct Companions {
    host_instance: String, sequence: u64, revision: u64, safe_mode: bool, shutdown: bool,
    entries: BTreeMap<RunKey, Entry>, capabilities: BTreeMap<String, Capability>,
}
impl Default for Companions {
    fn default() -> Self { Self {
        host_instance: uuid::Uuid::new_v4().to_string(), sequence: 0, revision: 0, safe_mode: false, shutdown: false,
        entries: BTreeMap::new(), capabilities: BTreeMap::new(),
    } }
}
fn valid_id(value: &str) -> bool { !value.is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control) }
impl Companions {
    pub fn begin(&mut self, key: RunKey, owners: &[String], installed: &InstalledApi, profile: Option<&Profile>,
        create: impl FnOnce(&Manifest) -> Result<Box<dyn Resources>, String>) -> Result<Launch, &'static str> {
        if !valid_id(&key.task_id) || !valid_id(&key.run_id) || owners.is_empty() || owners.iter().any(|owner| !valid_id(owner)) { return Err("InvalidShape"); }
        if self.safe_mode || self.shutdown { return Err("HostUnavailable"); }
        if self.entries.contains_key(&key) { return Err("Conflict"); }
        let capability = negotiate(installed, profile);
        self.capabilities.insert(installed.harness.clone(), capability.clone()); self.revision += 1;
        if capability.code.is_some() { return Err("UnsupportedCapability"); }
        self.sequence = self.sequence.checked_add(1).ok_or("HostUnavailable")?;
        let lease = Lease { key: key.clone(), lease_id: format!("{}:{}", self.host_instance, self.sequence) };
        let profile = profile.ok_or("UnsupportedCapability")?;
        let manifest = Manifest { schema_version: 1, lease: lease.clone(), profile: profile.id.clone(), protocol: profile.protocol };
        let resources = create(&manifest).map_err(|_| "HostUnavailable")?;
        let env = resources.environment();
        let active = Capability { state: "active".into(), ..capability };
        self.entries.insert(key, Entry { lease: lease.clone(), owners: owners.iter().cloned().collect(), capability: active.clone(), active: true, reason: None, resources: Some(resources), cleanup_pending: false });
        self.capabilities.insert(installed.harness.clone(), active.clone()); self.revision += 1;
        Ok(Launch { lease, env, capability: active })
    }
    /// Use the host's expected key, not a key claimed by an incoming frame. Recheck after awaiting decisions.
    pub fn current(&self, expected: &RunKey, presented: &Lease) -> bool {
        !self.safe_mode && !self.shutdown && presented.key == *expected
            && self.entries.get(expected).is_some_and(|entry| entry.active && entry.lease == *presented)
    }
    pub fn injection(&self, lease: &Lease) -> Result<BTreeMap<String, String>, &'static str> {
        if !self.current(&lease.key, lease) { return Err("StaleContext"); }
        self.entries.get(&lease.key).and_then(|entry| entry.resources.as_ref()).map(|resources| resources.environment()).ok_or("StaleContext")
    }
    pub fn end(&mut self, key: &RunKey, reason: StopReason) {
        let Some(entry) = self.entries.get_mut(key) else {
            // A cancelled launch's delayed probe must not reopen this run.
            self.entries.insert(key.clone(), Entry {
                lease: Lease { key: key.clone(), lease_id: String::new() }, owners: BTreeSet::new(),
                capability: Capability { state: "ended".into(), code: None, reason: Some(reason_text(reason).into()), harness: String::new(), version: None, profile: None, evidence: Evidence::Unsupported, ordinary_approvals: "unchanged".into() },
                active: false, reason: Some(reason), resources: None, cleanup_pending: false,
            }); self.revision += 1; return;
        };
        if entry.active {
            entry.active = false; entry.reason = Some(reason); // revoke before any close side effect
            entry.capability.state = "ended".into(); entry.capability.reason = Some(reason_text(reason).into());
            self.revision += 1;
        }
        if entry.resources.is_some() { cleanup(entry); self.revision += 1; }
        let ended = entry.capability.clone();
        if self.capabilities.get(&ended.harness).is_some_and(|shown| shown.state == "active")
            && !self.entries.values().any(|other| other.active && other.capability.harness == ended.harness)
        { self.capabilities.insert(ended.harness.clone(), ended); }
    }
    pub fn retry_cleanup(&mut self) {
        for entry in self.entries.values_mut().filter(|entry| !entry.active && entry.cleanup_pending) { cleanup(entry); self.revision += 1; }
    }
    /// Invalidate the entire shared run lease when one contributing service disappears. Others keep ordinary approvals;
    /// no companion is reinstalled into the same process. New runs recompute all hook owners and their grants.
    pub fn end_owner(&mut self, owner: &str, reason: StopReason) {
        let keys: Vec<_> = self.entries.iter().filter(|(_, entry)| entry.active && entry.owners.contains(owner)).map(|(key, _)| key.clone()).collect();
        for key in keys { self.end(&key, reason); }
    }
    pub fn set_safe_mode(&mut self, enabled: bool) {
        if self.safe_mode == enabled { return; }
        self.safe_mode = enabled; self.revision += 1;
        if enabled { self.end_all(StopReason::SafeMode); }
    }
    pub fn stop(&mut self) {
        if self.shutdown { return; }
        self.shutdown = true; self.revision += 1; self.end_all(StopReason::HostShutdown);
    }
    pub fn end_all(&mut self, reason: StopReason) {
        let keys: Vec<_> = self.entries.iter().filter(|(_, entry)| entry.active).map(|(key, _)| key.clone()).collect();
        for key in keys { self.end(&key, reason); }
    }
    pub fn capability(&self, harness: &str) -> Option<Capability> {
        let mut shown = self.capabilities.get(harness)?.clone();
        let active = self.entries.values().any(|entry| entry.active && entry.capability.harness == harness);
        if shown.code.is_none() {
            shown.state = if active { "active" } else if shown.state == "active" { "ended" } else { &shown.state }.into();
        }
        Some(shown)
    }
    /// Public projection never contains env, paths, lease IDs or credentials.
    pub fn report(&self) -> Value {
        json!({"schemaVersion": 1, "revision": self.revision, "safeMode": self.safe_mode, "shutdown": self.shutdown,
            "harnesses": self.capabilities.keys().filter_map(|id| self.capability(id)).collect::<Vec<_>>(),
            "activeRuns": self.entries.values().filter(|entry| entry.active).count(),
            "cleanupPending": self.entries.values().filter(|entry| entry.cleanup_pending).count()})
    }
}
fn cleanup(entry: &mut Entry) {
    if let Some(resource) = entry.resources.as_mut() {
        // Error strings may include private paths, so retain only a pending bit in the public projection.
        entry.cleanup_pending = resource.close().is_err();
        if !entry.cleanup_pending { entry.resources = None; }
    }
}
fn reason_text(reason: StopReason) -> &'static str { match reason {
    StopReason::RunEnded => "runEnded", StopReason::Disabled => "disabled", StopReason::Revoked => "revoked",
    StopReason::ServiceFailure => "serviceFailure", StopReason::SafeMode => "safeMode", StopReason::HostShutdown => "hostShutdown",
} }
impl Drop for Companions { fn drop(&mut self) { self.stop(); self.retry_cleanup(); } }
static REGISTRY: LazyLock<Mutex<Companions>> = LazyLock::new(|| Mutex::new(Companions::default()));
pub fn registry() -> &'static Mutex<Companions> { &REGISTRY }

/// Put this guard in the owning run future, outside provider/warm-agent ownership. Drop covers cancellation/panic.
pub struct RunGuard { key: RunKey }
impl RunGuard { pub fn new(key: RunKey) -> Self { Self { key } } }
impl Drop for RunGuard {
    fn drop(&mut self) { if let Ok(mut registry) = registry().lock() { registry.end(&self.key, StopReason::RunEnded); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    const FIXTURE: &str = include_str!("../../../tests/fixtures/extensions/runtime-companion-lifetime/scenarios.json");
    struct FakeResources { closed: Arc<AtomicUsize>, failures: usize }
    impl Resources for FakeResources {
        fn environment(&self) -> BTreeMap<String, String> { BTreeMap::from([("PANDACODE_COMPANION_MANIFEST".into(), "fixture-owned/run.json".into())]) }
        fn close(&mut self) -> Result<(), String> {
            if self.failures > 0 { self.failures -= 1; return Err("synthetic I/O failure".into()); }
            self.closed.fetch_add(1, Ordering::SeqCst); Ok(())
        }
    }
    fn fixture() -> (Value, Profile, InstalledApi) {
        let data: Value = serde_json::from_str(FIXTURE).unwrap();
        (data.clone(), serde_json::from_value(data["profile"].clone()).unwrap(), serde_json::from_value(data["installed"].clone()).unwrap())
    }
    fn key(run: &str) -> RunKey { RunKey { task_id: "task-a".into(), run_id: run.into() } }
    fn factory(closed: Arc<AtomicUsize>, failures: usize) -> impl FnOnce(&Manifest) -> Result<Box<dyn Resources>, String> {
        move |manifest| { assert_eq!(manifest.schema_version, 1); Ok(Box::new(FakeResources { closed, failures })) }
    }
    #[test]
    fn exact_version_and_api_negotiation_agrees_with_shared_fixture() {
        let (data, profile, _) = fixture();
        for case in data["negotiation"].as_array().unwrap() {
            let installed = serde_json::from_value(case["installed"].clone()).unwrap();
            let shown = negotiate(&installed, if case["noProfile"] == true { None } else { Some(&profile) });
            assert_eq!(shown.state, case["state"].as_str().unwrap());
            assert_eq!(shown.ordinary_approvals, "unchanged");
            if shown.state == "unsupported" { assert_eq!(shown.code.as_deref(), Some("UnsupportedCapability")); assert!(shown.reason.is_some()); }
        }
    }
    #[test]
    fn one_run_one_companion_ended_cross_run_and_cross_host_leases_never_match() {
        let (_, profile, installed) = fixture(); let closed = Arc::new(AtomicUsize::new(0));
        let mut registry = Companions::default();
        let first = registry.begin(key("r1"), &["sample.guard".into()], &installed, Some(&profile), factory(closed.clone(), 0)).unwrap();
        assert!(registry.current(&key("r1"), &first.lease));
        assert!(!registry.current(&key("r2"), &first.lease));
        assert_eq!(registry.begin(key("r1"), &["sample.guard".into()], &installed, Some(&profile), factory(closed.clone(), 0)).err(), Some("Conflict"));
        registry.end(&key("r1"), StopReason::RunEnded);
        assert!(!registry.current(&key("r1"), &first.lease)); assert_eq!(closed.load(Ordering::SeqCst), 1);
        assert_eq!(registry.injection(&first.lease), Err("StaleContext"));
        assert_eq!(registry.begin(key("r1"), &["sample.guard".into()], &installed, Some(&profile), factory(closed.clone(), 0)).err(), Some("Conflict"));
        let mut other = Companions::default();
        let second = other.begin(key("r1"), &["sample.guard".into()], &installed, Some(&profile), factory(closed, 0)).unwrap();
        assert_ne!(first.lease.lease_id, second.lease.lease_id); assert!(!other.current(&key("r1"), &first.lease));
    }
    #[test]
    fn every_stop_invalidates_before_retrying_cleanup_and_unrelated_runs_survive() {
        let (_, profile, installed) = fixture();
        for reason in [StopReason::RunEnded, StopReason::Disabled, StopReason::Revoked, StopReason::ServiceFailure, StopReason::SafeMode, StopReason::HostShutdown] {
            let closed = Arc::new(AtomicUsize::new(0)); let mut registry = Companions::default();
            let lease = registry.begin(key("r1"), &["sample.guard".into()], &installed, Some(&profile), factory(closed.clone(), 1)).unwrap().lease;
            let other = registry.begin(key("r2"), &["sample.other".into()], &installed, Some(&profile), factory(closed.clone(), 0)).unwrap().lease;
            match reason {
                StopReason::SafeMode => registry.set_safe_mode(true), StopReason::HostShutdown => registry.stop(),
                StopReason::RunEnded => registry.end(&key("r1"), reason), _ => registry.end_owner("sample.guard", reason),
            }
            assert!(!registry.current(&key("r1"), &lease)); assert_eq!(registry.report()["cleanupPending"], 1);
            if !matches!(reason, StopReason::SafeMode | StopReason::HostShutdown) { assert!(registry.current(&key("r2"), &other)); }
            registry.retry_cleanup(); assert_eq!(registry.report()["cleanupPending"], 0);
            registry.end(&key("r1"), reason); // successful teardown is not repeated
        }
    }
    #[test]
    fn end_before_start_and_safe_mode_exit_do_not_resurrect_a_run() {
        let (_, profile, installed) = fixture(); let mut registry = Companions::default();
        registry.end(&key("r1"), StopReason::RunEnded); registry.set_safe_mode(true); registry.set_safe_mode(false);
        assert_eq!(registry.begin(key("r1"), &["sample.guard".into()], &installed, Some(&profile), |_| panic!("must not prepare")).err(), Some("Conflict"));
        let mut missing = installed; missing.apis.clear();
        assert_eq!(registry.begin(key("r2"), &["sample.guard".into()], &missing, Some(&profile), |_| panic!("must not prepare")).err(), Some("UnsupportedCapability"));
        assert_eq!(registry.capability(&missing.harness).unwrap().code.as_deref(), Some("UnsupportedCapability"));
    }
    #[test]
    fn native_directory_delivery_never_touches_fixture_user_or_project_configuration() {
        let root = std::env::temp_dir().join(format!("pandacode-companion-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let user = root.join("user.json"); let project = root.join("project.json");
        let original = b"{\r\n  \"plugins\": [\"keep\"]\r\n}\r\n";
        std::fs::write(&user, original).unwrap(); std::fs::write(&project, original).unwrap();
        let (_, profile, installed) = fixture(); let mut registry = Companions::default();
        let launch = registry.begin(key("r1"), &["sample.guard".into()], &installed, Some(&profile), |manifest| {
            DirectoryResources::prepare(&root, manifest, &[("companion.cjs", include_bytes!("../../../tests/fixtures/extensions/runtime-companion-lifetime/companion.cjs"))]).map(|resource| Box::new(resource) as Box<dyn Resources>)
        }).unwrap();
        let descriptor = PathBuf::from(&launch.env["PANDACODE_COMPANION_MANIFEST"]);
        let loaded: Manifest = serde_json::from_slice(&std::fs::read(&descriptor).unwrap()).unwrap();
        assert_eq!(loaded.lease, launch.lease);
        registry.end(&key("r1"), StopReason::RunEnded);
        assert!(!descriptor.parent().unwrap().exists());
        assert_eq!(std::fs::read(&user).unwrap(), original); assert_eq!(std::fs::read(&project).unwrap(), original);
        // Exact test-owned files only; no recursive cleanup and no user CLI paths.
        std::fs::remove_file(user).unwrap(); std::fs::remove_file(project).unwrap(); std::fs::remove_dir(root).unwrap();
    }
}
