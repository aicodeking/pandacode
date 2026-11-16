//! Migration of the legacy API-1 consents into native grants (runtime phase R1), and the native checker the legacy
//! call sites ask.
//!
//! Before the runtime there were two kinds of consent: private storage, which the package settings record already keeps
//! across restarts (`storageGranted` in `extensions_snapshot`), and transient per-handle consents (context summaries,
//! project files and Git, jobs, connections, services) that lived only as long as one captured invocation. Both
//! families now map to a permission name of the decided vocabulary and to one grant in `RuntimeGrants`.
//!
//! Rules: only an explicit allow becomes a grant (a denial, a missing decision or a stale version never does);
//! the whole batch is one write, so a failure changes nothing; every adopted name is remembered inside the grants
//! file, so repeating the migration never undoes a later revoke or narrowing. Until a package holds the native grant,
//! the legacy call site keeps its previous behavior (`Gate::Prompt`: the user is asked, per handle, as before); with
//! the grant it is never asked (ADR-0005). The adoption of a transient consent never widens beyond its project for a
//! permission the user can narrow by project.
use super::runtime_grants::{RuntimeGrants, Scope, Target, PERMISSIONS, PROJECT_SCOPED};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

type Result<T> = std::result::Result<T, String>;

/// The permission each legacy consent family maps to: context summaries, project files and Git, jobs (`tools.execute`),
/// connections, services and private storage.
pub const LEGACY_PERMISSIONS: [&str; 12] = [
    "projects.summary", "tasks.summary", "harnesses.inventory", "connections.summary", "jobs.summary",
    "projects.files.metadata", "projects.files.read", "projects.git.read",
    "tools.execute", "connections.request", "services.call", "storage.private",
];

/// One legacy decision. `allow: false` is a denial and never becomes a grant.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyConsent { pub id: String, pub permission: String, #[serde(default)] pub project: Option<String>, pub allow: bool }

/// What the legacy call site does for a native check.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Gate {
    /// The package holds the grant: proceed without asking.
    Granted,
    /// No grant: the previous per-handle prompt applies, unchanged.
    Prompt,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report { pub adopted: Vec<(String, String)>, pub skipped: usize }

fn legacy(permission: &str) -> bool { LEGACY_PERMISSIONS.contains(&permission) && PERMISSIONS.contains(&permission) }

/// The persisted storage decisions of an `extensions_snapshot`: one allow per package whose stored consent matches the
/// installed version and whose manifest declares `storage.private`. A package without one has no decision at all.
pub fn persisted_storage(snapshot: &Value) -> Vec<LegacyConsent> {
    snapshot["packages"].as_array().into_iter().flatten().filter_map(|package| {
        let id = package["manifest"]["id"].as_str()?;
        let declared = ["permissions", "requiredCapabilities"].iter().any(|key| package["manifest"][key].as_array().is_some_and(|names| names.iter().any(|name| name == "storage.private")));
        (package["storageGranted"] == true && declared).then(|| LegacyConsent { id: id.into(), permission: "storage.private".into(), project: None, allow: true })
    }).collect()
}

/// Folds decisions into grants: allows only, one scope per package and permission. A permission the user can narrow by
/// project keeps the projects it was consented in; an allow without a project for such a permission is dropped rather
/// than widened. A denial for a pair removes nothing already allowed by another handle but is never itself a grant.
type Entries = Vec<(String, String, Scope)>;
fn fold(consents: &[LegacyConsent]) -> Result<(Entries, usize)> {
    let mut grants: BTreeMap<(String, String), Option<BTreeSet<String>>> = BTreeMap::new();
    let mut skipped = 0;
    for consent in consents {
        if !legacy(&consent.permission) { return Err(format!("UnsupportedCapability: {}", consent.permission)); }
        if !consent.allow { skipped += 1; continue; }
        let scoped = PROJECT_SCOPED.contains(&consent.permission.as_str());
        let key = (consent.id.clone(), consent.permission.clone());
        match (scoped, &consent.project) {
            (true, None) => { skipped += 1; }
            (true, Some(project)) => { if let Some(set) = grants.entry(key).or_insert_with(|| Some(BTreeSet::new())) { set.insert(project.clone()); } }
            (false, _) => { grants.insert(key, None); }
        }
    }
    Ok((grants.into_iter().map(|((id, permission), projects)| (id, permission, Scope { projects, ..Scope::default() })).collect(), skipped))
}

/// Brings the store in line with `snapshot`, then adopts the persisted storage consents of the snapshot and `transient`
/// in one write. Repeating it adopts nothing new; `Err` leaves the store unchanged.
pub fn migrate(grants: &RuntimeGrants, snapshot: &Value, transient: &[LegacyConsent]) -> Result<Report> {
    grants.sync(snapshot)?;
    let mut all = persisted_storage(snapshot);
    all.extend(transient.iter().cloned());
    let (entries, skipped) = fold(&all)?;
    let adopted = grants.adopt(&entries)?;
    Ok(Report { skipped: skipped + entries.len() - adopted.len(), adopted })
}

fn target(project: Option<&str>) -> Target { project.map_or_else(Target::default, Target::project) }

/// The native checker for a legacy call site. Unknown names are `UnsupportedCapability`; a missing, revoked,
/// narrowed-out, stale, archived or untrusted grant answers `Prompt`, which is exactly the previous behavior.
pub fn gate(grants: &RuntimeGrants, id: &str, version: &str, permission: &str, project: Option<&str>) -> Result<Gate> {
    if !legacy(permission) { return Err("UnsupportedCapability".into()); }
    Ok(if grants.check(id, version, permission, &target(project)).is_ok() { Gate::Granted } else { Gate::Prompt })
}
/// Whether a legacy call may proceed: the native grant, or else the consent the user gave this handle.
pub fn allows(grants: &RuntimeGrants, id: &str, version: &str, permission: &str, project: Option<&str>, handle_consent: bool) -> Result<bool> {
    Ok(gate(grants, id, version, permission, project)? == Gate::Granted || handle_consent)
}

/// `extensions_runtime_native_consents`: runs the migration (repeatable) and answers the report with the projection.
#[tauri::command]
pub fn extensions_runtime_native_consents(packages: tauri::State<'_, super::packages::ExtensionPackages>, grants: tauri::State<'_, RuntimeGrants>) -> Result<Value> {
    let snapshot = serde_json::to_value(packages.0.lock().map_err(|_| "Extension manager unavailable.")?.snapshot()).map_err(|_| "MalformedData")?;
    let report = migrate(&grants, &snapshot, &[])?;
    Ok(json!({"schemaVersion":1,"adopted":report.adopted.iter().map(|(id, permission)| json!({"id":id,"permission":permission})).collect::<Vec<_>>(),"skipped":report.skipped,"grants":grants.projection()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    const FIXTURE: &str = include_str!("../../../tests/fixtures/extensions/runtime-native-consents/scenario.json");
    struct Dir(PathBuf);
    impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-consents-test-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } fn file(&self) -> PathBuf { self.0.join("extension-grants-v1").join("grants.json") } }
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn scenario() -> Value { serde_json::from_str(FIXTURE).unwrap() }
    fn snapshot(scenario: &Value) -> Value { json!({"safeMode":false,"packages":scenario["packages"]}) }
    fn transient(scenario: &Value) -> Vec<LegacyConsent> { serde_json::from_value(scenario["legacy"].clone()).unwrap() }
    fn names(scenario: &Value, key: &str) -> Vec<(String, String)> {
        scenario["expect"][key].as_array().unwrap().iter().map(|value| { let (id, permission) = value.as_str().unwrap().split_once('/').unwrap(); (id.to_owned(), permission.to_owned()) }).collect()
    }
    fn version<'a>(scenario: &'a Value, id: &str) -> &'a str { scenario["packages"].as_array().unwrap().iter().find(|package| package["manifest"]["id"] == id).unwrap()["manifest"]["version"].as_str().unwrap() }
    fn held(grants: &RuntimeGrants, scenario: &Value, id: &str, permission: &str, project: Option<&str>) -> bool { grants.check(id, version(scenario, id), permission, &target(project)).is_ok() }

    #[test]
    fn the_fixture_families_map_to_the_legacy_permissions() {
        let scenario = scenario();
        let kinds: Vec<&str> = scenario["kinds"].as_array().unwrap().iter().map(|kind| kind["permission"].as_str().unwrap()).collect();
        assert_eq!(kinds, LEGACY_PERMISSIONS.to_vec());
        assert!(LEGACY_PERMISSIONS.iter().all(|name| PERMISSIONS.contains(name)));
    }

    #[test]
    fn persisted_storage_consent_survives_upgrade_and_restart_and_denied_or_missing_never_become_grants() {
        let scenario = scenario(); let dir = Dir::new();
        let grants = RuntimeGrants::open(&dir.0);
        let report = migrate(&grants, &snapshot(&scenario), &transient(&scenario)).unwrap();
        for (id, permission) in names(&scenario, "granted") { assert!(report.adopted.contains(&(id.clone(), permission.clone())), "{id}/{permission}"); }
        // restart: a new process reads the file; the decision is the same
        let grants = RuntimeGrants::open(&dir.0);
        for (id, permission) in names(&scenario, "granted") {
            let project = (permission != "storage.private" && permission != "services.call" && permission != "tools.execute").then_some("project-a");
            assert!(held(&grants, &scenario, &id, &permission, project), "{id}/{permission}");
        }
        for (id, permission) in names(&scenario, "neverGranted") { for project in [None, Some("project-a")] { assert!(!held(&grants, &scenario, &id, &permission, project), "{id}/{permission}"); } }
        // the project of a transient consent bounds the grant
        let projection = grants.projection();
        let granted = projection["packages"].as_array().unwrap().iter().find(|package| package["id"] == "sample.consent-granted").unwrap();
        let summary = granted["grants"].as_array().unwrap().iter().find(|grant| grant["permission"] == "projects.summary").unwrap();
        assert_eq!(summary["scope"]["projects"], scenario["expect"]["projectsSummaryProjects"]);
        assert!(!held(&grants, &scenario, "sample.consent-granted", "projects.summary", Some("project-c")));
        // upgrade: a package that updates keeps its grant only while the version it was consented for still applies
        let mut upgraded = scenario.clone();
        upgraded["packages"][0]["manifest"]["version"] = json!("1.1.0");
        upgraded["packages"][0]["storageGranted"] = json!(false);
        migrate(&grants, &snapshot(&upgraded), &[]).unwrap();
        assert!(grants.check("sample.consent-granted", "1.1.0", "storage.private", &Target::default()).is_ok());
        assert!(grants.check("sample.consent-granted", "1.0.0", "storage.private", &Target::default()).is_err());
    }

    #[test]
    fn migration_is_repeatable_and_never_undoes_a_revoke() {
        let scenario = scenario(); let dir = Dir::new(); let grants = RuntimeGrants::open(&dir.0);
        migrate(&grants, &snapshot(&scenario), &transient(&scenario)).unwrap();
        let first = std::fs::read(dir.file()).unwrap();
        let again = migrate(&grants, &snapshot(&scenario), &transient(&scenario)).unwrap();
        assert!(again.adopted.is_empty());
        assert_eq!(std::fs::read(dir.file()).unwrap(), first, "a second run writes nothing");
        // the user revokes storage; the persisted consent is still `true`, yet it is not adopted again
        grants.revoke("sample.consent-granted", "storage.private").unwrap();
        assert!(!held(&grants, &scenario, "sample.consent-granted", "storage.private", None));
        for _ in 0..2 { assert!(migrate(&RuntimeGrants::open(&dir.0), &snapshot(&scenario), &transient(&scenario)).unwrap().adopted.is_empty()); }
        assert!(!held(&RuntimeGrants::open(&dir.0), &scenario, "sample.consent-granted", "storage.private", None));
        // a narrowing sticks as well
        grants.narrow("sample.consent-granted", "projects.summary", Scope { projects: Some(["project-a".to_owned()].into()), ..Scope::default() }).unwrap();
        migrate(&grants, &snapshot(&scenario), &transient(&scenario)).unwrap();
        assert!(!held(&grants, &scenario, "sample.consent-granted", "projects.summary", Some("project-b")));
        // an old store without the marker field still opens
        let old = r#"{"schemaVersion":1,"revision":0,"packages":{}}"#;
        std::fs::write(dir.file(), old).unwrap();
        assert_eq!(RuntimeGrants::open(&dir.0).projection()["available"], true);
    }

    #[test]
    fn migration_is_transactional_a_malformed_entry_or_a_failed_write_changes_nothing() {
        let scenario = scenario(); let dir = Dir::new(); let grants = RuntimeGrants::open(&dir.0);
        grants.sync(&snapshot(&scenario)).unwrap();
        let before = std::fs::read(dir.file()).unwrap();
        let mut bad = transient(&scenario);
        bad.push(LegacyConsent { id: "sample.consent-granted".into(), permission: "credentials.read".into(), project: None, allow: true });
        assert!(migrate(&grants, &snapshot(&scenario), &bad).unwrap_err().starts_with("UnsupportedCapability"));
        assert_eq!(std::fs::read(dir.file()).unwrap(), before);
        assert!(!held(&grants, &scenario, "sample.consent-granted", "projects.summary", Some("project-a")));
        // a failed write: nothing is adopted, no marker is kept, and a later run adopts everything
        std::fs::create_dir(dir.file().with_extension("stage")).unwrap();
        assert_eq!(migrate(&grants, &snapshot(&scenario), &transient(&scenario)).unwrap_err(), "StorageUnavailable");
        assert!(!held(&grants, &scenario, "sample.consent-granted", "storage.private", None));
        std::fs::remove_dir(dir.file().with_extension("stage")).unwrap();
        assert!(!migrate(&grants, &snapshot(&scenario), &transient(&scenario)).unwrap().adopted.is_empty());
        assert!(held(&grants, &scenario, "sample.consent-granted", "storage.private", None));
        // a corrupt store refuses the migration and keeps its bytes
        std::fs::write(dir.file(), b"{malformed").unwrap();
        let corrupt = RuntimeGrants::open(&dir.0);
        assert!(migrate(&corrupt, &snapshot(&scenario), &transient(&scenario)).is_err());
        assert_eq!(std::fs::read(dir.file()).unwrap(), b"{malformed");
    }

    #[test]
    fn context_files_git_jobs_connections_and_services_grant_deny_and_revoke_directly_in_native() {
        let scenario = scenario(); let dir = Dir::new(); let grants = RuntimeGrants::open(&dir.0);
        let id = "sample.consent-granted"; let v = version(&scenario, id);
        grants.sync(&snapshot(&scenario)).unwrap();
        let scoped = |permission: &str| PROJECT_SCOPED.contains(&permission);
        for (permission, family) in [("projects.summary", "context"), ("jobs.summary", "context"), ("projects.files.read", "files"), ("projects.git.read", "git"), ("tools.execute", "jobs"), ("connections.request", "connections"), ("services.call", "services"), ("storage.private", "storage")] {
            let project = scoped(permission).then_some("project-a");
            // no decision: the legacy prompt applies and a handle consent is what lets the call through
            assert_eq!(gate(&grants, id, v, permission, project).unwrap(), Gate::Prompt, "{family}");
            assert!(!allows(&grants, id, v, permission, project, false).unwrap(), "{family}");
            assert!(allows(&grants, id, v, permission, project, true).unwrap(), "{family}");
            // a denial is not a grant
            let mut unconsented = snapshot(&scenario);
            for package in unconsented["packages"].as_array_mut().unwrap() { package["storageGranted"] = json!(false); }
            migrate(&grants, &unconsented, &[LegacyConsent { id: id.into(), permission: permission.into(), project: project.map(str::to_owned), allow: false }]).unwrap();
            assert_eq!(gate(&grants, id, v, permission, project).unwrap(), Gate::Prompt, "{family}");
            // the grant answers without a prompt, bounded to its project where the permission has one
            grants.grant(id, permission, if scoped(permission) { Scope { projects: Some(["project-a".to_owned()].into()), ..Scope::default() } } else { Scope::default() }).unwrap();
            assert_eq!(gate(&grants, id, v, permission, project).unwrap(), Gate::Granted, "{family}");
            assert!(allows(&grants, id, v, permission, project, false).unwrap(), "{family}");
            if scoped(permission) { assert_eq!(gate(&grants, id, v, permission, Some("project-b")).unwrap(), Gate::Prompt, "{family}"); }
            // revocation: the very next call is back to the prompt, with open work cancelled
            let work = grants.begin(id, v, permission, &target(project)).unwrap();
            grants.revoke(id, permission).unwrap();
            assert!(work.is_cancelled(), "{family}");
            assert_eq!(gate(&grants, id, v, permission, project).unwrap(), Gate::Prompt, "{family}");
            assert!(!allows(&grants, id, v, permission, project, false).unwrap(), "{family}");
        }
        assert_eq!(gate(&grants, id, v, "credentials.read", None).unwrap_err(), "UnsupportedCapability");
        assert_eq!(gate(&grants, id, v, "tasks.start", None).unwrap_err(), "UnsupportedCapability");
        // a stale version, an archived package and an untrusted digest are prompts too, never grants
        grants.grant(id, "services.call", Scope::default()).unwrap();
        assert_eq!(gate(&grants, id, "9.9.9", "services.call", None).unwrap(), Gate::Prompt);
        grants.archive(id, true).unwrap();
        assert_eq!(gate(&grants, id, v, "services.call", None).unwrap(), Gate::Prompt);
    }
}
