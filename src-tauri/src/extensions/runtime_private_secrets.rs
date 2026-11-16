//! Private secrets of trusted packages (`secrets.private`, runtime slice R0802).
//!
//! A package keeps its own secrets (an API token it was given, a refresh token it obtained) through
//! `panda.secrets.get/set/delete/list`. They live in the host's secret store area, in a 0600 file written by the
//! same atomic helpers as `secret_store.rs`, keyed by the caller's package id. The package id never comes from the
//! request: the dispatcher passes the identity of the connection, so a package cannot name another package's keys,
//! and a request that carries any field beyond the documented ones is `InvalidArguments`.
//!
//! Rules (ADR-0006, docs/extensions/runtime-private-secrets.md):
//! - Service only. A panel asking is `UnsupportedCapability`; a secret never reaches a webview.
//! - Every call is rechecked natively against the grant (`RuntimeGrants::begin`): revoke, narrowing, untrust, disable
//!   (archive), a stale version and safe mode answer `PermissionDenied`. A write that loses the grant while it runs is
//!   not applied. Stored values are kept across revoke, disable and update.
//! - Keys match `^[a-z][a-z0-9-]{0,63}$`; a value is 1 to 16384 bytes; 64 keys per package (`LimitExceeded`).
//! - A package-owned secret is distinct from a credential PandaCode holds (`credentials.use`): this file is not the
//!   host credential store, and no call here or anywhere reads the latter (there is no `credentials.read`).
//! - Removed with the package (uninstall). Values never enter logs, errors, projections or diagnostics.
use crate::extensions::runtime_grants::{RuntimeGrants, Target};
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, path::{Path, PathBuf}};

type Result<T> = std::result::Result<T, String>;

/// The permission a package must hold.
pub const PERMISSION: &str = "secrets.private";
/// Keys per package.
pub const MAX_KEYS: usize = 64;
/// Bytes per value.
pub const MAX_VALUE: usize = 16 * 1024;
const FILE: &str = "secrets.json";
const LABEL: &str = "package secrets";
const DIRECTORY: &str = "extension-secrets-v1";

/// Who is calling. Only a background service may use package secrets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller { Service, Panel }

type Store = BTreeMap<String, BTreeMap<String, String>>;

/// Native owner of every package's private secrets. Managed as Tauri state.
pub struct PrivateSecrets { dir: PathBuf }

fn valid_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    (1..=64).contains(&bytes.len()) && bytes[0].is_ascii_lowercase() && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// The request object, with exactly the allowed fields.
fn fields<'a>(params: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    let map = match params { Value::Null => EMPTY.get_or_init(Map::new), Value::Object(map) => map, _ => return Err("InvalidArguments".into()) };
    if map.keys().any(|name| !allowed.contains(&name.as_str())) { return Err("InvalidArguments".into()); }
    Ok(map)
}
fn key_of(map: &Map<String, Value>) -> Result<&str> {
    map.get("key").and_then(Value::as_str).filter(|key| valid_key(key)).ok_or_else(|| "InvalidArguments".into())
}

impl PrivateSecrets {
    /// `<dir>/extension-secrets-v1/secrets.json` in the app data directory; created on the first write.
    pub fn open(dir: &Path) -> Self { Self { dir: dir.join(DIRECTORY) } }

    fn read(&self) -> Result<Store> { crate::secret_store::load::<Store>(&self.dir.join(FILE), LABEL).map_err(|_| "HostUnavailable".to_owned()) }
    fn change(&self, change: impl FnOnce(Store) -> Store) -> Result<()> {
        std::fs::create_dir_all(&self.dir).map_err(|_| "HostUnavailable")?;
        crate::secret_store::update::<Store>(&self.dir, FILE, LABEL, change).map_err(|_| "HostUnavailable".to_owned())
    }

    /// The one entry of the dispatcher: `method` is the SDK name (`secrets.get`, `secrets.set`, `secrets.delete`,
    /// `secrets.list`); `id` and `version` are the caller's identity, never read from `params`.
    pub fn handle(&self, grants: &RuntimeGrants, id: &str, version: &str, caller: Caller, method: &str, params: &Value) -> Result<Value> {
        let operation = match method { "secrets.get" | "secrets.set" | "secrets.delete" | "secrets.list" => method, _ => return Err("UnsupportedCapability".into()) };
        if caller != Caller::Service { return Err("UnsupportedCapability".into()); }
        let work = grants.begin(id, version, PERMISSION, &Target::default())?;
        match operation {
            "secrets.get" => {
                let key = key_of(fields(params, &["key"])?)?;
                let value = self.read()?.get(id).and_then(|owned| owned.get(key)).cloned();
                if work.is_cancelled() { return Err("PermissionDenied".into()); }
                Ok(json!({ "value": value }))
            }
            "secrets.list" => {
                fields(params, &[])?;
                let keys: Vec<String> = self.read()?.get(id).map(|owned| owned.keys().cloned().collect()).unwrap_or_default();
                if work.is_cancelled() { return Err("PermissionDenied".into()); }
                Ok(json!({ "keys": keys }))
            }
            "secrets.set" => {
                let map = fields(params, &["key", "value"])?;
                let key = key_of(map)?.to_owned();
                let value = map.get("value").and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or("InvalidArguments")?;
                if value.len() > MAX_VALUE { return Err("LimitExceeded".into()); }
                let mut outcome: Result<()> = Ok(());
                self.change(|mut store| {
                    if work.is_cancelled() { outcome = Err("PermissionDenied".into()); return store; }
                    let owned = store.entry(id.to_owned()).or_default();
                    if !owned.contains_key(&key) && owned.len() >= MAX_KEYS { outcome = Err("LimitExceeded".into()); return store; }
                    owned.insert(key, value.to_owned());
                    store
                })?;
                outcome.map(|()| Value::Null)
            }
            _ => {
                let key = key_of(fields(params, &["key"])?)?.to_owned();
                let mut outcome: Result<()> = Ok(());
                self.change(|mut store| {
                    if work.is_cancelled() { outcome = Err("PermissionDenied".into()); return store; }
                    if let Some(owned) = store.get_mut(id) { owned.remove(&key); if owned.is_empty() { store.remove(id); } }
                    store
                })?;
                outcome.map(|()| Value::Null)
            }
        }
    }

    /// Removes everything the package owns (uninstall). Safe to call for a package without secrets.
    pub fn remove_package(&self, id: &str) -> Result<()> {
        if !self.read()?.contains_key(id) { return Ok(()); }
        self.change(|mut store| { store.remove(id); store })
    }

    /// The read projection the webview gets: which packages hold how many keys, with their names. Never a value.
    pub fn projection(&self) -> Value {
        let Ok(store) = self.read() else { return json!({"schemaVersion":1,"available":false,"kind":"package-owned","limits":{"keys":MAX_KEYS,"valueBytes":MAX_VALUE},"packages":[]}); };
        let packages: Vec<Value> = store.iter().map(|(id, owned)| json!({"id": id, "count": owned.len(), "keys": owned.keys().collect::<Vec<_>>()})).collect();
        json!({"schemaVersion":1,"available":true,"kind":"package-owned","limits":{"keys":MAX_KEYS,"valueBytes":MAX_VALUE},"packages":packages})
    }
}

/// Package-owned secrets as the webview may see them (main window only; key names and counts, never a value).
#[tauri::command]
pub fn extensions_private_secrets(window: tauri::WebviewWindow, secrets: tauri::State<'_, PrivateSecrets>) -> Result<Value> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    Ok(secrets.projection())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::runtime_grants::Scope;

    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-private-secrets/extension.json");
    const SOURCE: &str = include_str!("../../../tests/fixtures/extensions/runtime-private-secrets/main.cjs");
    const A: &str = "sample.private-secrets";
    const B: &str = "sample.other-package";
    /// Built from parts so this file never holds a realistic token; the tests look for it in every output.
    fn canary() -> String { ["canary", "secret", "value", "r0802"].join("-") }
    struct Dir(PathBuf);
    impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-private-secrets-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    fn setup(dir: &Dir) -> (PrivateSecrets, RuntimeGrants) {
        let grants = RuntimeGrants::open(&dir.0);
        for id in [A, B] {
            grants.register_package(id, "1.0.0", &["runtime.service", PERMISSION], Some("digest")).unwrap();
            grants.trust(id, true).unwrap();
            grants.grant(id, PERMISSION, Scope::default()).unwrap();
        }
        (PrivateSecrets::open(&dir.0), grants)
    }
    fn call(secrets: &PrivateSecrets, grants: &RuntimeGrants, id: &str, method: &str, params: Value) -> Result<Value> {
        secrets.handle(grants, id, "1.0.0", Caller::Service, method, &params)
    }

    #[test]
    fn the_fixture_manifest_is_valid_and_declares_the_permission() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        assert_eq!(manifest["id"], A);
        assert!(manifest["permissions"].as_array().unwrap().iter().any(|name| name == PERMISSION));
        assert_eq!(crate::extensions::contracts::validate_contract("packages", &json!([manifest]))["ok"], true);
        assert!(SOURCE.contains("panda.secrets.set") && SOURCE.contains("panda.secrets.list"));
    }

    #[test]
    fn a_package_writes_reads_lists_and_removes_its_own_secret_and_never_sees_another_packages_key() {
        let dir = Dir::new();
        let (secrets, grants) = setup(&dir);
        let value = canary();
        assert_eq!(call(&secrets, &grants, A, "secrets.set", json!({"key":"api-token","value":value})).unwrap(), Value::Null);
        assert_eq!(call(&secrets, &grants, A, "secrets.get", json!({"key":"api-token"})).unwrap(), json!({"value": value}));
        assert_eq!(call(&secrets, &grants, A, "secrets.list", Value::Null).unwrap(), json!({"keys":["api-token"]}));
        assert_eq!(call(&secrets, &grants, A, "secrets.get", json!({"key":"missing"})).unwrap(), json!({"value": null}));
        // The other package, also granted, meets nothing of A's through any direct native call.
        assert_eq!(call(&secrets, &grants, B, "secrets.get", json!({"key":"api-token"})).unwrap(), json!({"value": null}));
        assert_eq!(call(&secrets, &grants, B, "secrets.list", json!({})).unwrap(), json!({"keys":[]}));
        for extra in [json!({"key":"api-token","id":A}), json!({"key":"api-token","owner":A}), json!({"key":"api-token","package":A}), json!({"key":"a/../api-token"}), json!({"key":"../x"}), json!("api-token")] {
            assert_eq!(call(&secrets, &grants, B, "secrets.get", extra).unwrap_err(), "InvalidArguments");
        }
        call(&secrets, &grants, B, "secrets.set", json!({"key":"api-token","value":"other"})).unwrap();
        call(&secrets, &grants, B, "secrets.delete", json!({"key":"api-token"})).unwrap();
        assert_eq!(call(&secrets, &grants, A, "secrets.get", json!({"key":"api-token"})).unwrap(), json!({"value": value}), "B's write and delete never touched A");
        call(&secrets, &grants, A, "secrets.set", json!({"key":"api-token","value":"replaced"})).unwrap();
        assert_eq!(call(&secrets, &grants, A, "secrets.get", json!({"key":"api-token"})).unwrap(), json!({"value":"replaced"}));
        call(&secrets, &grants, A, "secrets.delete", json!({"key":"api-token"})).unwrap();
        call(&secrets, &grants, A, "secrets.delete", json!({"key":"api-token"})).unwrap();
        assert_eq!(call(&secrets, &grants, A, "secrets.list", Value::Null).unwrap(), json!({"keys":[]}));
        assert!(secrets.projection()["packages"].as_array().unwrap().is_empty());
    }

    #[test]
    fn limits_are_explicit_and_a_failure_changes_nothing() {
        let dir = Dir::new();
        let (secrets, grants) = setup(&dir);
        for index in 0..MAX_KEYS { call(&secrets, &grants, A, "secrets.set", json!({"key":format!("key-{index}"),"value":"v"})).unwrap(); }
        assert_eq!(call(&secrets, &grants, A, "secrets.set", json!({"key":"one-more","value":"v"})).unwrap_err(), "LimitExceeded");
        call(&secrets, &grants, A, "secrets.set", json!({"key":"key-0","value":"overwrite is not a new key"})).unwrap();
        assert_eq!(call(&secrets, &grants, A, "secrets.list", Value::Null).unwrap()["keys"].as_array().unwrap().len(), MAX_KEYS);
        call(&secrets, &grants, B, "secrets.set", json!({"key":"big","value":"x".repeat(MAX_VALUE)})).unwrap();
        assert_eq!(call(&secrets, &grants, B, "secrets.set", json!({"key":"big","value":"x".repeat(MAX_VALUE + 1)})).unwrap_err(), "LimitExceeded");
        assert_eq!(call(&secrets, &grants, B, "secrets.get", json!({"key":"big"})).unwrap()["value"].as_str().unwrap().len(), MAX_VALUE, "the refused write left the old value");
        for (params, why) in [(json!({"key":"k","value":""}), "empty value"), (json!({"key":"k"}), "no value"), (json!({"key":"k","value":5}), "non-string value"), (json!({"key":"Upper","value":"v"}), "uppercase"),
            (json!({"key":"1abc","value":"v"}), "leading digit"), (json!({"key":"a".repeat(65),"value":"v"}), "65 characters"), (json!({"key":"","value":"v"}), "empty key"), (json!({"value":"v"}), "no key"), (json!({"key":"k","value":"v","extra":1}), "extra field")] {
            assert_eq!(call(&secrets, &grants, B, "secrets.set", params).unwrap_err(), "InvalidArguments", "{why}");
        }
        call(&secrets, &grants, B, "secrets.set", json!({"key":"a".repeat(64),"value":"v"})).unwrap();
        assert_eq!(call(&secrets, &grants, B, "secrets.list", json!({"x":1})).unwrap_err(), "InvalidArguments");
    }

    #[test]
    fn revoke_disable_untrust_stale_version_and_safe_mode_deny_before_any_read_and_keep_the_data() {
        let dir = Dir::new();
        let (secrets, grants) = setup(&dir);
        let value = canary();
        call(&secrets, &grants, A, "secrets.set", json!({"key":"api-token","value":value})).unwrap();
        let read = |grants: &RuntimeGrants| call(&secrets, grants, A, "secrets.get", json!({"key":"api-token"}));
        grants.revoke(A, PERMISSION).unwrap();
        assert_eq!(read(&grants).unwrap_err(), "PermissionDenied");
        assert_eq!(call(&secrets, &grants, A, "secrets.list", Value::Null).unwrap_err(), "PermissionDenied");
        assert_eq!(call(&secrets, &grants, A, "secrets.set", json!({"key":"other","value":"v"})).unwrap_err(), "PermissionDenied");
        assert_eq!(call(&secrets, &grants, A, "secrets.delete", json!({"key":"api-token"})).unwrap_err(), "PermissionDenied");
        grants.grant(A, PERMISSION, Scope::default()).unwrap();
        assert_eq!(read(&grants).unwrap(), json!({"value": value}), "revoke keeps the data");
        grants.archive(A, true).unwrap(); // a disabled package, or safe mode
        assert_eq!(read(&grants).unwrap_err(), "PermissionDenied");
        grants.archive(A, false).unwrap();
        grants.trust(A, false).unwrap();
        assert_eq!(read(&grants).unwrap_err(), "PermissionDenied");
        grants.trust(A, true).unwrap();
        assert_eq!(secrets.handle(&grants, A, "0.9.0", Caller::Service, "secrets.get", &json!({"key":"api-token"})).unwrap_err(), "PermissionDenied");
        assert_eq!(read(&grants).unwrap(), json!({"value": value}));
        // A package the host has never heard of, and a declared but ungranted permission.
        assert_eq!(secrets.handle(&grants, "sample.unknown", "1.0.0", Caller::Service, "secrets.list", &Value::Null).unwrap_err(), "PermissionDenied");
        grants.register_package("sample.ungranted", "1.0.0", &[PERMISSION], None).unwrap();
        assert_eq!(secrets.handle(&grants, "sample.ungranted", "1.0.0", Caller::Service, "secrets.list", &Value::Null).unwrap_err(), "PermissionDenied");
        // Work that was open when the grant went away is cancelled and never writes.
        let work = grants.begin(A, "1.0.0", PERMISSION, &Target::default()).unwrap();
        grants.revoke(A, PERMISSION).unwrap();
        assert!(work.is_cancelled());
    }

    #[test]
    fn service_only_no_credentials_read_and_a_package_secret_is_not_a_host_credential() {
        let dir = Dir::new();
        let (secrets, grants) = setup(&dir);
        assert_eq!(secrets.handle(&grants, A, "1.0.0", Caller::Panel, "secrets.get", &json!({"key":"api-token"})).unwrap_err(), "UnsupportedCapability");
        for method in ["credentials.read", "credentials.get", "secrets.credentials", "secrets.export", "secrets.getAll", ""] {
            assert_eq!(secrets.handle(&grants, A, "1.0.0", Caller::Service, method, &Value::Null).unwrap_err(), "UnsupportedCapability", "{method}");
        }
        assert!(!crate::extensions::runtime_grants::PERMISSIONS.contains(&"credentials.read"));
        assert_eq!(grants.check(A, "1.0.0", "credentials.read", &Target::default()).unwrap_err(), "UnsupportedCapability");
        // A host-held credential with the same account name is a different store: it never appears here.
        crate::secret_store::set("pandacode-test-credential", "api-token", "host-held-credential-value").unwrap();
        call(&secrets, &grants, A, "secrets.set", json!({"key":"api-token","value":"package-value"})).unwrap();
        assert_eq!(call(&secrets, &grants, B, "secrets.get", json!({"key":"api-token"})).unwrap(), json!({"value": null}));
        assert_eq!(call(&secrets, &grants, A, "secrets.get", json!({"key":"api-token"})).unwrap(), json!({"value":"package-value"}));
        assert_eq!(crate::secret_store::get("pandacode-test-credential", "api-token").as_deref(), Some("host-held-credential-value"), "the package's write did not touch the host credential");
        crate::secret_store::remove("pandacode-test-credential", "api-token");
        assert_eq!(secrets.projection()["kind"], "package-owned");
    }

    #[test]
    fn values_persist_are_removed_with_the_package_and_never_appear_in_projection_or_errors() {
        let dir = Dir::new();
        let (secrets, grants) = setup(&dir);
        let value = canary();
        call(&secrets, &grants, A, "secrets.set", json!({"key":"api-token","value":value})).unwrap();
        call(&secrets, &grants, B, "secrets.set", json!({"key":"session","value":"b-value"})).unwrap();
        let reopened = PrivateSecrets::open(&dir.0);
        assert_eq!(call(&reopened, &grants, A, "secrets.get", json!({"key":"api-token"})).unwrap(), json!({"value": value}), "kept across a restart");
        let projection = reopened.projection().to_string();
        assert!(projection.contains("api-token") && projection.contains(A) && !projection.contains(&value) && !projection.contains("b-value"), "{projection}");
        let mut errors = vec![];
        errors.push(call(&secrets, &grants, A, "secrets.set", json!({"key":"BAD","value":value})).unwrap_err());
        errors.push(call(&secrets, &grants, A, "secrets.set", json!({"key":"k","value":"x".repeat(MAX_VALUE + 1)})).unwrap_err());
        errors.push(secrets.handle(&grants, A, "9.9.9", Caller::Service, "secrets.set", &json!({"key":"k","value":value})).unwrap_err());
        errors.push(secrets.handle(&grants, A, "1.0.0", Caller::Panel, "secrets.set", &json!({"key":"k","value":value})).unwrap_err());
        assert!(errors.iter().all(|error| !error.contains(&value)), "{errors:?}");
        // Uninstall removes the owner's secrets and only the owner's.
        secrets.remove_package(A).unwrap();
        secrets.remove_package("sample.nobody").unwrap();
        assert_eq!(call(&secrets, &grants, A, "secrets.list", Value::Null).unwrap(), json!({"keys":[]}));
        assert_eq!(call(&secrets, &grants, B, "secrets.get", json!({"key":"session"})).unwrap(), json!({"value":"b-value"}));
        secrets.remove_package(B).unwrap();
        assert!(!dir.0.join(DIRECTORY).join(FILE).exists(), "an empty store leaves no file");
    }

    #[test]
    fn a_corrupt_store_is_reported_unavailable_and_never_replaced() {
        let dir = Dir::new();
        let (secrets, grants) = setup(&dir);
        std::fs::create_dir_all(dir.0.join(DIRECTORY)).unwrap();
        std::fs::write(dir.0.join(DIRECTORY).join(FILE), b"{ not json").unwrap();
        assert_eq!(call(&secrets, &grants, A, "secrets.list", Value::Null).unwrap_err(), "HostUnavailable");
        assert_eq!(call(&secrets, &grants, A, "secrets.set", json!({"key":"k","value":"v"})).unwrap_err(), "HostUnavailable");
        assert_eq!(std::fs::read(dir.0.join(DIRECTORY).join(FILE)).unwrap(), b"{ not json");
        assert_eq!(secrets.projection()["available"], false);
    }
}
