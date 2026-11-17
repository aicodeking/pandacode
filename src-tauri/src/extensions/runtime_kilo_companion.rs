//! Independently pinned Kilo adapter; shared V1 code does not qualify an installed CLI.
use std::path::Path;
use super::runtime_companion_lifetime::{self as lifetime, Evidence, InstalledApi, Manifest, Profile, Resources};
use super::runtime_opencode_companion::{self as shared, Generation, Transport};
pub const SOURCE: &str = "37b2900fcb6223fec33c2bd5f59263e93682c670";
pub fn profile(installed: &InstalledApi) -> Option<Profile> {
    if installed.harness != "kilo" || installed.version.as_deref() != Some(SOURCE) { return None; }
    Some(Profile { id: "kilo.v1".into(), harness: "kilo".into(), versions: vec![SOURCE.into()], api: "kilo.plugin.v1".into(), protocol: 1, evidence: Evidence::SourceFeasible })
}
pub fn inline(file_url: &str, previous: &str) -> Result<serde_json::Value, &'static str> {
    let config: serde_json::Value = serde_json::from_str(previous).map_err(|_| "InvalidShape")?;
    if config.get("plugins").is_some() { return Err("UnsupportedCapability"); }
    shared::inline(Generation::V1, file_url, previous)
}
pub fn prepare(root: &Path, manifest: &Manifest, installed: &InstalledApi, pure: bool, previous: &str, transport: Option<&Transport>) -> Result<Box<dyn Resources>, String> {
    let profile = profile(installed).ok_or("UnsupportedCapability")?;
    if pure || manifest.profile != profile.id || lifetime::negotiate(installed, Some(&profile)).code.is_some() { return Err("UnsupportedCapability".into()); }
    // Validate Kilo's incompatible plural key before allocating any files.
    inline("file:///companion.mjs", previous)?;
    shared::prepare_bundle(root, manifest, Generation::V1, "kilo", "KILO_CONFIG_CONTENT", previous, transport)
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn kilo_is_independent_and_singular_only() {
        let installed = InstalledApi { harness: "kilo".into(), version: Some(SOURCE.into()), apis: vec!["opencode.plugin.v1".into()] };
        assert!(lifetime::negotiate(&installed, profile(&installed).as_ref()).code.is_some());
        assert!(inline("file:///run/module.mjs", r#"{"plugins":[]}"#).is_err());
        assert!(inline("file:///run/package/", "{}").is_err());
        let config = inline("file:///run/module.mjs", r#"{"model":"kept","plugin":["existing"]}"#).unwrap();
        assert_eq!(config["model"], "kept"); assert_eq!(config["plugin"][0], "existing");
    }
}
