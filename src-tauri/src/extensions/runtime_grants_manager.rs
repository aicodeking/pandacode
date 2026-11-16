//! Native proof of the grants review and management flow (runtime phase R1, slice R0101B).
//!
//! The Extensions page (`src/extensions/runtime-grants-manager.ts`) only draws `RuntimeGrants::projection` and sends
//! the user's changes to `extensions_runtime_grant`; the authority stays in `runtime_grants.rs`. These tests drive
//! the same store the commands use, through the same `extensions_snapshot` JSON, and compare what the page would
//! display with what a direct native call answers before and after each change.
#![cfg(test)]
use super::runtime_grants::{RuntimeGrants, Scope, Target};
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::PathBuf};

const FIXTURE: &str = include_str!("../../../tests/fixtures/extensions/runtime-grants-manager/extension.json");
const UPDATE: &str = include_str!("../../../tests/fixtures/extensions/runtime-grants-manager/update.json");
const PLAIN: &str = include_str!("../../../tests/fixtures/extensions/runtime-grants-manager/plain.json");

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-grants-manager-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) }
}
impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

fn set(values: &[&str]) -> Option<BTreeSet<String>> { Some(values.iter().map(|value| (*value).to_owned()).collect()) }
/// One `extensions_snapshot` package, as the native manager reports it.
fn package(manifest: &str, digest: Option<&str>, trusted: bool, enabled: bool) -> Value {
    let manifest: Value = serde_json::from_str(manifest).unwrap();
    json!({"manifest": manifest, "enabled": enabled, "executable": digest.map(|digest| json!({"digest": digest, "trusted": trusted}))})
}
fn snapshot(packages: Vec<Value>) -> Value { json!({"safeMode": false, "packages": packages}) }
fn projected<'a>(projection: &'a Value, id: &str) -> &'a Value { projection["packages"].as_array().unwrap().iter().find(|item| item["id"] == id).unwrap() }
/// What the page shows as granted for a permission: the persisted scope, or nothing.
fn displayed(projection: &Value, id: &str, permission: &str) -> Option<Value> {
    let item = projected(projection, id);
    if item["authorized"] != true { return None; }
    item["grants"].as_array().unwrap().iter().find(|grant| grant["permission"] == permission).map(|grant| grant["scope"].clone())
}
/// The page's reading of a grant against a direct native call: they must agree for every probe.
fn agrees(grants: &RuntimeGrants, id: &str, version: &str, permission: &str, probes: &[(Target, bool)]) {
    let shown = displayed(&grants.projection(), id, permission);
    for (target, expected) in probes {
        let direct = grants.check(id, version, permission, target).is_ok();
        assert_eq!(direct, *expected, "{permission} direct call");
        if shown.is_none() { assert!(!direct, "{permission} is not displayed as granted, so a direct call must be refused"); }
    }
}

#[test]
fn install_grant_one_project_tool_kind_and_item_and_the_projection_is_what_a_direct_call_gets() {
    let dir = Dir::new(); let grants = RuntimeGrants::open(&dir.0);
    let manifest: Value = serde_json::from_str(FIXTURE).unwrap();
    let (id, version) = (manifest["id"].as_str().unwrap(), manifest["version"].as_str().unwrap());
    grants.sync(&snapshot(vec![package(FIXTURE, Some("digest-a"), true, true)])).unwrap();
    // Installed and trusted, nothing granted yet: every declared name is listed, none is effective.
    let before = grants.projection();
    assert_eq!(projected(&before, id)["declared"], json!(["credentials.use", "harness.hooks.decide", "tasks.start"]));
    assert_eq!(projected(&before, id)["grants"], json!([]));
    agrees(&grants, id, version, "tasks.start", &[(Target::project("A"), false)]);
    grants.grant(id, "tasks.start", Scope { projects: set(&["A"]), ..Scope::default() }).unwrap();
    grants.grant(id, "harness.hooks.decide", Scope { projects: set(&["A"]), tool_kinds: set(&["shell"]), items: None }).unwrap();
    grants.grant(id, "credentials.use", Scope { items: set(&["github"]), ..Scope::default() }).unwrap();
    let after = grants.projection();
    assert_eq!(displayed(&after, id, "tasks.start"), Some(json!({"projects": ["A"]})));
    assert_eq!(displayed(&after, id, "harness.hooks.decide"), Some(json!({"projects": ["A"], "toolKinds": ["shell"]})));
    assert_eq!(displayed(&after, id, "credentials.use"), Some(json!({"items": ["github"]})));
    agrees(&grants, id, version, "tasks.start", &[(Target::project("A"), true), (Target::project("B"), false), (Target::default(), false)]);
    agrees(&grants, id, version, "harness.hooks.decide", &[(Target::tool("A", "shell"), true), (Target::tool("A", "edit"), false), (Target::tool("B", "shell"), false)]);
    agrees(&grants, id, version, "credentials.use", &[(Target::item("github"), true), (Target::item("openai"), false)]);
    // The grant is the persisted one: a new process reads the same projection.
    let restarted = RuntimeGrants::open(&dir.0);
    assert_eq!(restarted.projection()["packages"], after["packages"]);
    // The decided vocabulary has no credential read, and a held grant needs no per-action confirmation: a repeated
    // check answers the same without any state change (the revision does not move).
    let revision = restarted.projection()["revision"].clone();
    for _ in 0..3 { restarted.check(id, version, "tasks.start", &Target::project("A")).unwrap(); }
    assert_eq!(restarted.projection()["revision"], revision);
}

#[test]
fn a_permissionless_package_keeps_its_flow() {
    let dir = Dir::new(); let grants = RuntimeGrants::open(&dir.0);
    let plain: Value = serde_json::from_str(PLAIN).unwrap();
    let id = plain["id"].as_str().unwrap();
    grants.sync(&snapshot(vec![package(PLAIN, None, false, true)])).unwrap();
    let item = projected(&grants.projection(), id).clone();
    assert_eq!(item["declared"], json!([])); assert_eq!(item["grants"], json!([])); assert_eq!(item["authorized"], true);
    // Nothing to grant: any name is refused, and an unknown one is not a vocabulary name.
    assert_eq!(grants.grant(id, "tasks.start", Scope::default()).unwrap_err(), "PermissionDenied");
    assert_eq!(grants.grant(id, "credentials.read", Scope::default()).unwrap_err(), "UnsupportedCapability");
    grants.revoke_all(id).unwrap();
}

#[test]
fn an_update_that_adds_a_permission_cannot_use_it_before_review() {
    let dir = Dir::new(); let grants = RuntimeGrants::open(&dir.0);
    grants.sync(&snapshot(vec![package(FIXTURE, Some("digest-a"), true, true)])).unwrap();
    let id = "sample.grants-manager";
    grants.grant(id, "tasks.start", Scope { projects: set(&["A"]), ..Scope::default() }).unwrap();
    // The new version reaches the store through the snapshot, exactly as an applied update does.
    grants.sync(&snapshot(vec![package(UPDATE, Some("digest-a"), true, true)])).unwrap();
    let projection = grants.projection();
    assert!(projected(&projection, id)["declared"].as_array().unwrap().contains(&json!("tasks.message")));
    assert_eq!(displayed(&projection, id, "tasks.message"), None);
    assert_eq!(grants.check(id, "1.1.0", "tasks.message", &Target::project("A")).unwrap_err(), "PermissionDenied");
    assert!(grants.begin(id, "1.1.0", "tasks.message", &Target::project("A")).is_err());
    // The grants the package already held survive for the version that declares them; the old version is stale.
    grants.check(id, "1.1.0", "tasks.start", &Target::project("A")).unwrap();
    assert_eq!(grants.check(id, "1.0.0", "tasks.start", &Target::project("A")).unwrap_err(), "PermissionDenied");
    // Review is the user's explicit grant; only then does the call pass.
    grants.grant(id, "tasks.message", Scope { projects: set(&["A"]), ..Scope::default() }).unwrap();
    grants.check(id, "1.1.0", "tasks.message", &Target::project("A")).unwrap();
    // An update that changes the executable content also needs the trust decision again before any grant carries weight.
    grants.sync(&snapshot(vec![package(UPDATE, Some("digest-b"), false, true)])).unwrap();
    assert_eq!(grants.check(id, "1.1.0", "tasks.start", &Target::project("A")).unwrap_err(), "PermissionDenied");
    assert_eq!(projected(&grants.projection(), id)["authorized"], false);
    grants.sync(&snapshot(vec![package(UPDATE, Some("digest-b"), true, true)])).unwrap();
    grants.check(id, "1.1.0", "tasks.start", &Target::project("A")).unwrap();
}

#[test]
fn narrowing_and_revoking_cancel_open_work_and_the_projection_follows() {
    let dir = Dir::new(); let grants = RuntimeGrants::open(&dir.0);
    grants.sync(&snapshot(vec![package(FIXTURE, Some("digest-a"), true, true)])).unwrap();
    let (id, version) = ("sample.grants-manager", "1.0.0");
    grants.grant(id, "tasks.start", Scope { projects: set(&["A", "B"]), ..Scope::default() }).unwrap();
    grants.grant(id, "credentials.use", Scope { items: set(&["github", "openai"]), ..Scope::default() }).unwrap();
    let a = grants.begin(id, version, "tasks.start", &Target::project("A")).unwrap();
    let b = grants.begin(id, version, "tasks.start", &Target::project("B")).unwrap();
    let github = grants.begin(id, version, "credentials.use", &Target::item("github")).unwrap();
    let openai = grants.begin(id, version, "credentials.use", &Target::item("openai")).unwrap();
    grants.narrow(id, "tasks.start", Scope { projects: set(&["A"]), ..Scope::default() }).unwrap();
    assert!(!a.is_cancelled() && b.is_cancelled());
    assert_eq!(displayed(&grants.projection(), id, "tasks.start"), Some(json!({"projects": ["A"]})));
    agrees(&grants, id, version, "tasks.start", &[(Target::project("A"), true), (Target::project("B"), false)]);
    // Narrowing never widens, and it never starts work.
    assert_eq!(grants.narrow(id, "tasks.start", Scope { projects: set(&["A", "B"]), ..Scope::default() }).unwrap_err(), "InvalidArguments");
    grants.narrow(id, "credentials.use", Scope { items: set(&["github"]), ..Scope::default() }).unwrap();
    assert!(!github.is_cancelled() && openai.is_cancelled());
    grants.revoke(id, "tasks.start").unwrap();
    assert!(a.is_cancelled() && !github.is_cancelled());
    assert_eq!(displayed(&grants.projection(), id, "tasks.start"), None);
    agrees(&grants, id, version, "tasks.start", &[(Target::project("A"), false)]);
    grants.revoke_all(id).unwrap();
    assert!(github.is_cancelled());
    assert_eq!(projected(&grants.projection(), id)["grants"], json!([]));
    agrees(&grants, id, version, "credentials.use", &[(Target::item("github"), false)]);
}

#[test]
fn a_safe_mode_snapshot_suspends_grants_and_never_erases_them() {
    let dir = Dir::new(); let grants = RuntimeGrants::open(&dir.0);
    let id = "sample.grants-manager";
    grants.sync(&snapshot(vec![package(FIXTURE, Some("digest-a"), true, true)])).unwrap();
    grants.grant(id, "tasks.start", Scope { projects: set(&["A"]), ..Scope::default() }).unwrap();
    let work = grants.begin(id, "1.0.0", "tasks.start", &Target::project("A")).unwrap();
    // Safe mode reports an empty package list.
    grants.sync(&json!({"safeMode": true, "packages": []})).unwrap();
    assert!(work.is_cancelled());
    assert_eq!(projected(&grants.projection(), id)["authorized"], false);
    assert_eq!(grants.check(id, "1.0.0", "tasks.start", &Target::project("A")).unwrap_err(), "PermissionDenied");
    // The next normal launch restores the grant untouched.
    grants.sync(&snapshot(vec![package(FIXTURE, Some("digest-a"), true, true)])).unwrap();
    assert_eq!(displayed(&grants.projection(), id, "tasks.start"), Some(json!({"projects": ["A"]})));
    grants.check(id, "1.0.0", "tasks.start", &Target::project("A")).unwrap();
}

#[test]
fn a_request_cannot_forge_authority_for_another_package_or_an_undeclared_name() {
    let dir = Dir::new(); let grants = RuntimeGrants::open(&dir.0);
    grants.sync(&snapshot(vec![package(FIXTURE, Some("digest-a"), true, true), package(PLAIN, None, false, true)])).unwrap();
    let id = "sample.grants-manager";
    grants.grant(id, "tasks.start", Scope::default()).unwrap();
    // A package that never declared a name gets no grant of it; an unknown package gets nothing; the name outside the vocabulary is never a grant.
    assert_eq!(grants.grant("sample.grants-plain", "tasks.start", Scope::default()).unwrap_err(), "PermissionDenied");
    assert_eq!(grants.grant("sample.unknown", "tasks.start", Scope::default()).unwrap_err(), "PermissionDenied");
    assert_eq!(grants.grant(id, "tasks.control", Scope::default()).unwrap_err(), "PermissionDenied");
    assert_eq!(grants.grant(id, "credentials.read", Scope::default()).unwrap_err(), "UnsupportedCapability");
    // A scope the permission does not have is refused rather than ignored.
    assert_eq!(grants.grant(id, "tasks.start", Scope { items: set(&["x"]), ..Scope::default() }).unwrap_err(), "InvalidArguments");
    // The other package's calls, and a foreign owner's name, still meet the gate.
    assert_eq!(grants.check("sample.grants-plain", "1.0.0", "tasks.start", &Target::project("A")).unwrap_err(), "PermissionDenied");
    assert_eq!(grants.check("sample.unknown", "1.0.0", "tasks.start", &Target::project("A")).unwrap_err(), "PermissionDenied");
    // Uninstall removes the package and every grant with it.
    grants.sync(&snapshot(vec![])).unwrap();
    assert_eq!(grants.projection()["packages"], json!([]));
    assert_eq!(grants.check(id, "1.0.0", "tasks.start", &Target::project("A")).unwrap_err(), "PermissionDenied");
}
