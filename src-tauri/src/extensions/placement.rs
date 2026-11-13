//! Placement is host authority, not permission to install packages or transfer secrets.
use serde_json::{json, Value};

pub const UNSUPPORTED: &str = "UnsupportedCapability: this remote host does not support extension API 1 workspace providers. History and core commands remain available. Run locally or update the host explicitly.";
pub const MISSING: &str = "MissingProvider: enable and explicitly trust this provider's workspace extension on the owning computer. No package or credentials are copied. History remains available.";

pub fn workspace(manifest: &Value) -> bool {
    matches!(manifest["extensionKind"].as_str(), Some("workspace" | "split"))
}

pub fn local_context(store: &crate::storage::Store, context: &Value) -> Result<(), &'static str> {
    use rusqlite::OptionalExtension;
    if let Some(session) = context["sessionId"].as_str() {
        let (project, remote): (String, bool) = store.db.query_row("SELECT project_id,remote_device IS NOT NULL FROM sessions WHERE id=?1", [session], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional().map_err(|_| "HostUnavailable")?.ok_or("NotFound")?;
        if context["projectId"] != project { return Err("PermissionDenied"); }
        if remote { return Err("UnsupportedCapability"); }
    }
    Ok(())
}

/// Recomputed for every request. Advertisements never authorize a later operation.
pub fn capabilities(device: &str, headless: bool) -> Value {
    let providers: Vec<Value> = crate::providers::dynamic_adapter::discover_workspace().into_iter()
        .filter(|provider| provider.installed)
        .map(|provider| json!({"id":provider.id,"version":provider.version,"apiVersion":1}))
        .take(512).collect();
    json!({"apiVersion":1,"deviceId":device,"headless":headless,
        "placements":["workspace"],"protocols":["conversation.v1"],
        "providers":providers,"automaticInstall":false,"credentialTransfer":false})
}

pub fn negotiate(value: &Value, device: &str, provider: &str) -> crate::Result<()> {
    if value.to_string().len() > 180 * 1024 || value["apiVersion"] != 1 || value["deviceId"] != device
        || !value["placements"].as_array().is_some_and(|values| values.iter().any(|value| value == "workspace"))
        || !value["protocols"].as_array().is_some_and(|values| values.iter().any(|value| value == "conversation.v1")) {
        return Err(UNSUPPORTED.into());
    }
    if !value["providers"].as_array().is_some_and(|providers| providers.len() <= 512 && providers.iter().any(|entry| entry["id"] == provider && entry["apiVersion"] == 1)) {
        return Err(MISSING.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_peer_fixture_matrix() {
        let cases: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/remote-peers.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let result = negotiate(&case["peer"], "host-a", "sample.fake-harness/recorded");
            assert_eq!(result.is_ok(), case["supported"].as_bool().unwrap(), "{}", case["name"]);
        }
        assert!(!workspace(&json!({"extensionKind":"ui"})));
        assert!(workspace(&json!({"extensionKind":"workspace"})));
        assert!(workspace(&json!({"extensionKind":"split"})));
    }
}
