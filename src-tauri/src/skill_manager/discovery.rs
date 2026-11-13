//! Narrow host discovery policy, not OS confinement of trusted extension code.
use serde_json::{json, Value};
use std::{collections::BTreeSet, fs, path::{Component, Path, PathBuf}};

pub(crate) const INSTALL_REASON: &str = "UnsupportedCapability: the pinned skills CLI has no reviewed adapter for this extension harness. Manage skills with its own tools.";
pub(crate) const SYNC_REASON: &str = "UnsupportedCapability: extension harness configuration sync is not supported; PandaCode never writes its agent configuration.";

pub(crate) fn valid_roots(id: &str, value: &Value) -> bool {
    if value.is_null() { return true; }
    let Some(roots) = value.as_array() else { return false; };
    if roots.len() > 6 { return false; }
    let mut seen = BTreeSet::new();
    roots.iter().all(|root| {
        let kind = root["kind"].as_str().unwrap_or_default();
        let scope = root["scope"].as_str().unwrap_or_default();
        let leaf = if kind == "config" { "settings.json" } else { kind };
        matches!(kind, "skills" | "rules" | "config") && matches!(scope, "user" | "project") &&
            seen.insert((scope, kind)) && root["path"] == format!(".panda-harnesses/{id}/{leaf}")
    })
}

/// Reject symlinks/junctions at every component, including the base and final file.
/// This is a best-effort inventory (no content is read for rule/config metadata).
pub(crate) fn unlinked(path: &Path) -> bool {
    let mut current = PathBuf::new();
    for part in path.components() {
        if matches!(part, Component::ParentDir | Component::CurDir) { return false; }
        current.push(part);
        let Ok(meta) = fs::symlink_metadata(&current) else { return false; };
        if meta.file_type().is_symlink() { return false; }
        #[cfg(windows)]
        { use std::os::windows::fs::MetadataExt;
          if meta.file_attributes() & 0x400 != 0 { return false; } }
    }
    true
}

pub(crate) fn roots(definition: &Value, kind: &str, home: &Path, project: Option<&Path>) -> Vec<(PathBuf, String)> {
    let id = definition["id"].as_str().unwrap_or_default();
    if crate::extensions::providers::extension_owner(id).is_none() || !valid_roots(id, &definition["discovery"]) { return vec![]; }
    definition["discovery"].as_array().into_iter().flatten().filter(|root| root["kind"] == kind).filter_map(|root| {
        let path = root["path"].as_str()?;
        let user = root["scope"] == "user";
        let base = if user { home } else { project? };
        let absolute = base.join(path);
        (unlinked(&absolute) && if kind == "config" { absolute.is_file() } else { absolute.is_dir() })
            .then(|| (absolute, if user { format!("~/{path}") } else { path.into() }))
    }).collect()
}

pub(crate) fn summary(definition: &Value) -> Value {
    json!({"name":definition["name"], "discovery":definition.get("discovery").cloned().unwrap_or(json!([])),
        "installReason":INSTALL_REASON, "syncable":false, "syncReason":SYNC_REASON})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill_manager as manager;
    #[test]
    fn dynamic_discovery_roots_reject_auth_config_traversal_and_foreign_paths() {
        let id = "sample.fake-harness/recorded";
        for path in ["/etc/passwd", "C:/Users/config.json", ".claude/auth.json", ".panda-harnesses/sample.fake-harness/other/settings.json", ".panda-harnesses/sample.fake-harness/recorded/../settings.json", "\\\\host\\auth.json"] {
            assert!(!valid_roots(id, &json!([{"kind":"config","scope":"user","path":path}])));
        }
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/fake-harness/extension.json")).unwrap();
        assert_eq!(crate::extensions::contracts::validate_contract("packages", &json!([manifest.clone()]))["ok"], true);
        let mut invalid_manifest = manifest.clone();
        invalid_manifest["contributes"]["providers"][0]["discovery"][0]["path"] = json!(".codex/auth.json");
        assert_eq!(crate::extensions::contracts::validate_contract("packages", &json!([invalid_manifest]))["ok"], false);
        let definition = &manifest["contributes"]["providers"][0];
        assert!(valid_roots(id, &definition["discovery"]));
        let mut duplicate = definition["discovery"].as_array().unwrap().clone();
        duplicate.push(duplicate[0].clone());
        assert!(!valid_roots(id, &json!(duplicate)));
        assert_eq!(manager::cli::agent_id(id), None);
        assert_eq!(manager::matrix::defaults(id), (manager::Mode::Asked, manager::Mode::None));
    }
    #[test]
    fn dynamic_discovery_inventory_reads_skills_but_never_config_content_or_installs() {
        use crate::skill_manager::{tests::Fixture, roots::Homes, Prefs};
        let fixture = Fixture::new();
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/fake-harness/extension.json")).unwrap();
        let definition = manifest["contributes"]["providers"][0].clone();
        let prefix = ".panda-harnesses/sample.fake-harness/recorded";
        fixture.skill(&format!("home/{prefix}/skills/example"), "---\nname: example\ndescription: Recorded discovery\n---\n");
        fs::write(fixture.0.join(format!("home/{prefix}/settings.json")), "SECRET_AUTH_CONTENT").unwrap();
        let home = fixture.0.join("home");
        let homes = Homes { dynamic: vec![definition.clone()], ..Homes::default() };
        let key = manager::scan_cache::key(&home, None, None, &fixture.0, &homes);
        assert_ne!(key, manager::scan_cache::key(&home, None, None, &fixture.0, &Homes::default()), "disable must invalidate cached switch inventories");
        let inventory = manager::inventory::inventory(&home, None, None, &Prefs::default(), &homes);
        assert_eq!(inventory.len(), 1);
        let data = serde_json::to_value(&inventory).unwrap();
        assert_eq!(data[0]["name"], "example");
        assert_eq!(data[0]["agents"][0]["harness"], "sample.fake-harness/recorded");
        assert!(!data.to_string().contains("SECRET_AUTH"));
        let harnesses = serde_json::to_value(manager::harnesses(&homes)).unwrap();
        let harness = harnesses.as_array().unwrap().iter().find(|h| h["id"] == definition["id"]).unwrap();
        assert_eq!(harness["installable"], false);
        assert_eq!(harness["syncable"], false);
        assert_eq!(harness["discovery"], definition["discovery"]);
        assert_eq!(harness["enforcement"], "asked");
        assert!(manager::cli::add_args("owner/repo", &["example".into()], &["sample.fake-harness/recorded".into()], true).unwrap_err().contains("UnsupportedCapability"));
        // A valid declaration does not authorize a different file, even within its directory.
        let mut invalid = definition.clone();
        invalid["discovery"][0]["path"] = json!(format!("{prefix}/auth.json"));
        assert!(roots(&invalid, "skills", &home, None).is_empty());
    }
    #[test]
    fn dynamic_discovery_denies_linked_roots_and_skill_files() {
        use crate::skill_manager::tests::Fixture;
        let fixture = Fixture::new();
        let target = fixture.0.join("target"); fs::create_dir_all(&target).unwrap();
        let link = fixture.0.join("linked");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let result = std::process::Command::new("cmd.exe").args(["/d", "/c", "mklink", "/J"]).arg(&link).arg(&target).creation_flags(0x08000000).output().unwrap();
            assert!(result.status.success(), "junction fixture must actually exist");
        }
        assert!(!unlinked(&link));
        fs::write(target.join("SKILL.md"), "SECRET").unwrap();
        assert!(!unlinked(&link.join("SKILL.md")));
    }
}
