//! The existing M3 settings file also owns private API state. No core database handle.
//! This is supported-API isolation, NOT a filesystem sandbox for trusted native code.
use super::*;

const META: &str = "__privateStorageV1";
const MAX_NAMESPACE: usize = 24 * 1024;
const MAX_VALUE: usize = 16 * 1024;
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct State { schema_version: u8, grant_version: Option<String>, namespaces: BTreeMap<String, Namespace> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Namespace { data_version: u32, revision: u64, values: BTreeMap<String, Value>, changes: Vec<Change> }
impl Default for Namespace {
    fn default() -> Self { Self { data_version: 1, revision: 0, values: BTreeMap::new(), changes: vec![] } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::tests::{Storage, archive};
    const ID: &str = "sample.storage-laboratory";
    const OTHER: &str = "other.storage-laboratory";
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/storage-laboratory/extension.json");
    fn install(packages: &Packages, id: &str) {
        packages.install(&archive(&[("extension.json", MANIFEST.replace(ID, id).as_bytes())])).unwrap();
        packages.enable(id, true).unwrap(); packages.storage_grant(id, true).unwrap();
    }
    fn call(packages: &Packages, id: &str, project: Option<&str>, request: Value) -> Result<Value> { packages.storage_call(id, "1.0.0", project, id, request) }
    fn get(packages: &Packages, id: &str, project: Option<&str>, scope: &str) -> Value { call(packages, id, project, json!({"op":"get","scope":scope,"key":"same"})).unwrap()["value"].clone() }
    #[test]
    fn storage_owner_project_global_settings_and_events_survive_restart() {
        let disk = Storage::new(); let packages = disk.packages(false); install(&packages, ID); install(&packages, OTHER);
        packages.settings_set(ID, &format!("{ID}/preferences"), &json!({"label":"M3 retained"})).unwrap();
        for (id, project, scope, value) in [(ID, Some("A"), "global", "global A"), (ID, Some("A"), "project", "project A"), (ID, Some("B"), "project", "project B"), (OTHER, Some("A"), "global", "global other")] {
            call(&packages, id, project, json!({"op":"set","scope":scope,"key":"same","value":value})).unwrap();
        }
        let packages = disk.packages(false);
        assert_eq!(get(&packages, ID, Some("B"), "global"), "global A");
        assert_eq!(get(&packages, ID, Some("A"), "project"), "project A");
        assert_eq!(get(&packages, ID, Some("B"), "project"), "project B");
        assert_eq!(get(&packages, OTHER, Some("A"), "global"), "global other");
        assert_eq!(packages.settings_get(ID, &format!("{ID}/preferences")).unwrap()["label"], "M3 retained");
        let stream = call(&packages, ID, Some("A"), json!({"op":"subscribe","scope":"project"})).unwrap();
        call(&packages, OTHER, Some("A"), json!({"op":"set","scope":"project","key":"other-only","value":1})).unwrap();
        call(&packages, ID, Some("B"), json!({"op":"set","scope":"project","key":"b-only","value":1})).unwrap();
        call(&packages, ID, Some("A"), json!({"op":"set","scope":"project","key":"a-only","value":1})).unwrap();
        let events = json!({"op":"events","scope":"project","subscription":stream["subscription"],"cursor":stream["cursor"]});
        assert!(call(&packages, OTHER, Some("A"), events.clone()).is_err());
        assert!(call(&packages, ID, Some("B"), events.clone()).is_err());
        let reply = call(&packages, ID, Some("A"), events).unwrap();
        assert_eq!(reply["events"], json!([{"sequence":2,"keys":["a-only"]}]));
        assert_eq!(call(&packages, ID, None, json!({"op":"snapshot","scope":"project"})).unwrap_err(), "NoProject");
        assert!(call(&packages, ID, None, json!({"op":"get","scope":"global","key":"same","owner":OTHER})).is_err());
    }
    #[test]
    fn storage_quota_malformed_stage_and_failed_migrations_keep_previous_bytes() {
        let disk = Storage::new(); let packages = disk.packages(false); install(&packages, ID);
        call(&packages, ID, None, json!({"op":"set","scope":"global","key":"same","value":"previous"})).unwrap();
        let path = packages.settings_path(ID).unwrap(); let before = std::fs::read(&path).unwrap();
        for request in [
            json!({"op":"set","scope":"global","key":"same","value":"x".repeat(MAX_VALUE+1)}),
            json!({"op":"set","scope":"global","key":"same","value":null,"projectId":"other"}),
            json!({"op":"migrate","scope":"global","revision":0,"fromVersion":1,"toVersion":2,"rollbackCompatible":true,"values":{}}),
            json!({"op":"migrate","scope":"global","revision":1,"fromVersion":1,"toVersion":2,"rollbackCompatible":false,"values":{}}),
            json!({"op":"migrate","scope":"global","revision":1,"fromVersion":1,"toVersion":2,"rollbackCompatible":true,"values":{"same":"x".repeat(MAX_VALUE+1)}}),
        ] { assert!(call(&packages, ID, None, request).is_err()); assert_eq!(std::fs::read(&path).unwrap(), before); }
        // A crash after staging but before promotion: never mistake partial output for committed data.
        std::fs::write(path.with_extension("stage"), b"{partial").unwrap();
        assert_eq!(call(&packages, ID, None, json!({"op":"set","scope":"global","key":"same","value":"new"})).unwrap_err(), "StorageUnavailable");
        assert_eq!(std::fs::read(&path).unwrap(), before); assert_eq!(get(&disk.packages(false), ID, None, "global"), "previous");
        // Corrupt input is retained for recovery, not silently replaced by an empty record.
        std::fs::write(&path, b"{malformed").unwrap();
        assert!(call(&packages, ID, None, json!({"op":"set","scope":"global","key":"same","value":"lost"})).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{malformed");
    }
    #[test]
    fn storage_migration_cas_gap_resync_and_core_sqlite_are_independent() {
        let disk = Storage::new(); let packages = disk.packages(false); install(&packages, ID);
        let store = crate::storage::Store::open(&disk.0.join("history.sqlite")).unwrap();
        store.db.execute("INSERT INTO projects(id,name,path) VALUES ('sentinel','Core history','unchanged')", []).unwrap();
        let history = std::fs::read(disk.0.join("history.sqlite")).unwrap();
        let stream = call(&packages, ID, None, json!({"op":"subscribe","scope":"global"})).unwrap();
        call(&packages, ID, None, json!({"op":"migrate","scope":"global","revision":0,"fromVersion":1,"toVersion":2,"rollbackCompatible":true,"values":{"same":"migrated"}})).unwrap();
        for i in 0..33 { call(&packages, ID, None, json!({"op":"set","scope":"global","key":"same","value":i})).unwrap(); }
        let reply = call(&packages, ID, None, json!({"op":"events","scope":"global","subscription":stream["subscription"],"cursor":stream["cursor"]})).unwrap();
        assert_eq!(reply["resync"], true); assert_eq!(reply["snapshot"]["dataVersion"], 2); assert_eq!(reply["snapshot"]["values"]["same"], 32);
        assert_eq!(std::fs::read(disk.0.join("history.sqlite")).unwrap(), history);
        assert_eq!(store.db.query_row("SELECT name FROM projects WHERE id='sentinel'", [], |row| row.get::<_, String>(0)).unwrap(), "Core history");
    }
    #[test]
    fn storage_namespace_total_quota_schema_and_activation_limits_fail_closed() {
        let disk = Storage::new(); let packages = disk.packages(false); install(&packages, ID);
        for index in 0..2 { call(&packages, ID, None, json!({"op":"set","scope":"global","key":format!("key-{index}"),"value":"x".repeat(10 * 1024)})).unwrap(); }
        let path = packages.settings_path(ID).unwrap(); let before = std::fs::read(&path).unwrap();
        assert_eq!(call(&packages, ID, None, json!({"op":"set","scope":"global","key":"key-3","value":"x".repeat(10 * 1024)})).unwrap_err(), "QuotaExceeded");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        // Individual namespaces fit, but this owner's shared M3 + state file has one total cap.
        let mut exceeded = false;
        for index in 0..8 {
            let before = std::fs::read(&path).unwrap();
            if let Err(code) = call(&packages, ID, Some(&format!("project-{index}")), json!({"op":"set","scope":"project","key":"same","value":"x".repeat(16 * 1024 - 2)})) {
                assert_eq!(code, "QuotaExceeded"); assert_eq!(std::fs::read(&path).unwrap(), before); exceeded = true; break;
            }
        }
        assert!(exceeded);
        for _ in 0..8 { call(&packages, ID, None, json!({"op":"subscribe","scope":"global"})).unwrap(); }
        assert_eq!(call(&packages, ID, None, json!({"op":"subscribe","scope":"global"})).unwrap_err(), "LimitExceeded");
        packages.storage_dispose(Some(ID), Some(ID)); assert!(packages.streams.lock().unwrap().is_empty());
        assert!(packages.storage_call(ID, "2.0.0", None, "foreign", json!({"op":"snapshot","scope":"global"})).is_err());
        let mut record = packages.settings_record(ID).unwrap(); record[META]["schemaVersion"] = json!(2);
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap(); let before = std::fs::read(&path).unwrap();
        assert_eq!(call(&packages, ID, None, json!({"op":"set","scope":"global","key":"same","value":"lost"})).unwrap_err(), "MalformedData");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
    #[test]
    fn storage_revocation_disable_uninstall_retention_and_explicit_own_data_removal() {
        let disk = Storage::new(); let packages = disk.packages(false); install(&packages, ID); install(&packages, OTHER);
        call(&packages, ID, None, json!({"op":"set","scope":"global","key":"same","value":"keep"})).unwrap();
        call(&packages, OTHER, None, json!({"op":"set","scope":"global","key":"same","value":"other"})).unwrap();
        call(&packages, ID, None, json!({"op":"subscribe","scope":"global"})).unwrap();
        packages.storage_grant(ID, false).unwrap(); assert!(packages.streams.lock().unwrap().is_empty());
        assert!(call(&packages, ID, None, json!({"op":"get","scope":"global","key":"same"})).is_err());
        packages.storage_grant(ID, true).unwrap(); packages.enable(ID, false).unwrap(); packages.storage_dispose(Some(ID), None);
        assert!(call(&packages, ID, None, json!({"op":"snapshot","scope":"global"})).is_err());
        packages.enable(ID, true).unwrap(); assert_eq!(get(&packages, ID, None, "global"), "keep");
        assert!(packages.storage_remove_own_data(ID).is_err()); packages.uninstall(ID).unwrap();
        install(&packages, ID); assert_eq!(get(&packages, ID, None, "global"), "keep");
        let stage = packages.settings_path(ID).unwrap().with_extension("stage"); std::fs::write(&stage, b"interrupted private output").unwrap();
        packages.uninstall(ID).unwrap(); packages.storage_remove_own_data(ID).unwrap(); assert!(!stage.exists()); install(&packages, ID);
        assert_eq!(get(&packages, ID, None, "global"), Value::Null); assert_eq!(get(&packages, OTHER, None, "global"), "other");
        assert!(packages.storage_remove_own_data("../history").is_err());
    }
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    #[tokio::test]
    async fn real_trusted_sdk_storage_uses_captured_identity_and_immediate_grant_revocation() {
        use crate::extensions::{context::ContextBroker, supervisor};
        use std::sync::{Arc, atomic::AtomicBool};
        let disk = Storage::new(); let packages = disk.packages(false);
        let source = r#"exports.activate=async panda=>{
          try { await panda.storage.get({scope:'project',key:'same'}); throw new Error('Unexpected grant'); }
          catch(error) { if(error.message!=='PermissionDenied') throw error; }
          await panda.storage.set({scope:'project',key:'same',value:'native SDK'});
          const before=await panda.storage.snapshot({scope:'project'});
          try { (()=>{throw new Error('migration transform failed');})(); } catch {}
          const after=await panda.storage.snapshot({scope:'project'});
          if(JSON.stringify(before)!==JSON.stringify(after)) throw new Error('Migration damaged state');
          await panda.storage.subscribe({scope:'project'});
          try { await panda.storage.set({scope:'project',key:'same',value:'revoked'}); throw new Error('Revocation lost'); }
          catch(error) { if(error.message!=='PermissionDenied') throw error; }
        };"#;
        let mut manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        manifest["runtime"] = json!({"kind":"node","entrypoint":"main.cjs","activationEvents":[format!("{ID}/inspect")]});
        manifest["contributes"]["commands"][0]["action"] = json!({"kind":"runCommand"});
        packages.install(&archive(&[("extension.json", &serde_json::to_vec(&manifest).unwrap()), ("main.cjs", source.as_bytes())])).unwrap();
        let digest = packages.snapshot().packages[0].executable.as_ref().unwrap().digest.clone();
        packages.trust(ID, &digest, true).unwrap(); packages.enable(ID, true).unwrap();
        let broker = ContextBroker::default(); let store = crate::storage::Store::open(Path::new(":memory:")).unwrap();
        let snapshot = packages.snapshot();
        let captured = broker.test_call(&snapshot, &store, json!({"op":"capture","id":format!("{ID}/inspect"),"version":"1.0.0","context":{"schemaVersion":1,"windowId":"main","surfaceId":"panda.commands","projectId":"A","revision":1}}));
        let handle = captured["value"]["handle"].as_str().unwrap();
        let (owner, version, context) = broker.runtime_binding(&snapshot, handle).unwrap();
        let runtime = supervisor::Runtime::packaged(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")).unwrap();
        let mut calls = 0;
        let result = supervisor::run(&runtime, source, context.clone(), Arc::new(AtomicBool::new(false)), |method, params| {
            assert_eq!(method, "storage"); calls += 1;
            broker.runtime_binding(&packages.snapshot(), handle).unwrap();
            let subscribed = params["op"] == "subscribe";
            let result = packages.storage_call(&owner, &version, context["projectId"].as_str(), handle, params);
            // Synthetic host UI consent/revocation between real process protocol calls.
            if calls == 1 { packages.storage_grant(ID, true).unwrap(); }
            if subscribed { packages.storage_grant(ID, false).unwrap(); }
            match result { Ok(value) => json!({"ok":true,"value":value}), Err(code) => crate::extensions::context::failure(&code) }
        }).await.unwrap();
        assert!(result.is_empty()); assert_eq!(calls, 6); assert!(packages.streams.lock().unwrap().is_empty());
        broker.runtime_release(handle); packages.storage_dispose(Some(ID), Some(handle));
        packages.storage_grant(ID, true).unwrap(); assert_eq!(get(&disk.packages(false), ID, Some("A"), "project"), "native SDK");
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Change { sequence: u64, keys: Vec<String> }
pub(super) struct Stream { owner: String, binding: String, namespace: String, cursor: u64, expires: std::time::Instant }
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Get { scope: String, key: String },
    Set { scope: String, key: String, value: Value },
    Remove { scope: String, key: String },
    Snapshot { scope: String },
    Subscribe { scope: String },
    Events { scope: String, subscription: String, cursor: u64 },
    Unsubscribe { scope: String, subscription: String },
    Migrate { scope: String, revision: u64, #[serde(rename = "fromVersion")] from_version: u32, #[serde(rename = "toVersion")] to_version: u32, #[serde(rename = "rollbackCompatible")] rollback_compatible: bool, values: BTreeMap<String, Value> },
}
fn key_valid(key: &str) -> bool { !key.is_empty() && key.len() <= 128 && !key.chars().any(char::is_control) }
fn values_valid(values: &BTreeMap<String, Value>) -> bool {
    values.len() <= 128 && values.iter().all(|(key, value)| key_valid(key) && value.to_string().len() <= MAX_VALUE)
        && serde_json::to_vec(values).is_ok_and(|bytes| bytes.len() <= MAX_NAMESPACE)
}
fn decode(record: &Value) -> Result<State> {
    let Some(raw) = record.get(META) else { return Ok(State { schema_version: 1, ..State::default() }); };
    let state: State = serde_json::from_value(raw.clone()).map_err(|_| "MalformedData")?;
    if state.schema_version != 1 || state.namespaces.len() > 33 || state.namespaces.keys().filter(|name| name.starts_with("project:")).count() > 32 || state.grant_version.as_ref().is_some_and(|version| version.len() > 32)
        || state.namespaces.iter().any(|(name, data)| {
            !(name == "global" || name.len() == 72 && name.starts_with("project:") && name[8..].bytes().all(|b| b.is_ascii_hexdigit()))
                || data.data_version == 0 || data.revision > 9_007_199_254_740_991 || !values_valid(&data.values) || data.changes.len() > 32
                || data.changes.iter().any(|change| change.sequence > data.revision || change.keys.len() > 128 || change.keys.iter().any(|key| !key_valid(key)))
                || data.changes.last().map_or(data.revision != 0, |change| change.sequence != data.revision)
                || data.changes.windows(2).any(|pair| pair[0].sequence.checked_add(1) != Some(pair[1].sequence))
        }) { return Err("MalformedData".into()); }
    Ok(state)
}
fn namespace(scope: &str, project: Option<&str>) -> Result<String> {
    match scope {
        "global" => Ok("global".into()),
        "project" => project.filter(|id| !id.is_empty() && id.len() <= 256).map(|id| format!("project:{:x}", Sha256::digest(id.as_bytes()))).ok_or_else(|| "NoProject".into()),
        _ => Err("InvalidShape".into()),
    }
}
fn snapshot(data: &Namespace) -> Value { json!({"schemaVersion":1,"dataVersion":data.data_version,"revision":data.revision,"values":data.values}) }
impl Packages {
    pub(super) fn storage_is_granted(&self, manifest: &Value) -> bool {
        let Some(id) = manifest["id"].as_str() else { return false; };
        // Do not create data directories merely to list installed packages.
        if !self.root.with_file_name("extension-settings-v1").exists() { return false; }
        self.settings_record(id).and_then(|record| decode(&record)).is_ok_and(|state| state.grant_version.as_deref() == manifest["version"].as_str())
    }
    pub(in crate::extensions) fn storage_grant(&self, id: &str, allow: bool) -> Result<()> {
        if self.safe || !safe_name(id) || id.contains('/') { return Err("PermissionDenied".into()); }
        let (_, package) = self.record(&self.root.join(format!("{id}.json")))?;
        if !package.manifest["permissions"].as_array().is_some_and(|permissions| permissions.iter().any(|value| value == "storage.private")) { return Err("PermissionDenied".into()); }
        let mut record = self.settings_record(id)?; let mut state = decode(&record)?;
        state.grant_version = if allow { package.manifest["version"].as_str().map(str::to_owned) } else { None };
        record[META] = serde_json::to_value(state).map_err(|_| "MalformedData")?;
        self.settings_write(id, &record)?;
        if !allow { self.storage_dispose(Some(id), None); }
        Ok(())
    }
    pub(in crate::extensions) fn storage_dispose(&self, owner: Option<&str>, binding: Option<&str>) {
        if let Ok(mut streams) = self.streams.lock() { streams.retain(|_, stream| !(owner.is_none_or(|owner| owner == stream.owner) && binding.is_none_or(|binding| binding == stream.binding))); }
    }
    /// Host-only explicit own-data removal, including the original M3 settings pages.
    /// Installation must already be absent. No wildcard, project path or SQLite operation.
    pub(in crate::extensions) fn storage_remove_own_data(&self, id: &str) -> Result<()> {
        if self.safe || !safe_name(id) || id.contains('/') || self.root.join(format!("{id}.json")).symlink_metadata().is_ok() || self.development_selected(id) { return Err("PermissionDenied".into()); }
        let path = self.settings_path(id)?;
        let stage = path.with_extension("stage");
        // Explicit removal covers only this owner's committed and interrupted private record.
        // Inspect the complete pair before removing either; never follow a substituted link.
        for candidate in [&path, &stage] { if candidate.symlink_metadata().is_ok() { regular(candidate)?; } }
        for candidate in [&path, &stage] { if candidate.symlink_metadata().is_ok() { std::fs::remove_file(candidate).map_err(|_| "StorageUnavailable")?; } }
        self.storage_dispose(Some(id), None); Ok(())
    }
    /// Identity, version, project and activation binding come ONLY from the captured host handle.
    pub(in crate::extensions) fn storage_call(&self, owner: &str, version: &str, project: Option<&str>, binding: &str, raw: Value) -> Result<Value> {
        if self.safe || !safe_name(owner) || owner.contains('/') { return Err("PermissionDenied".into()); }
        if raw.to_string().len() > 32 * 1024 { return Err("LimitExceeded".into()); }
        let (_, package) = self.record(&self.root.join(format!("{owner}.json"))).map_err(|_| "PermissionDenied")?;
        if !package.enabled || package.manifest["version"] != version || !package.manifest["permissions"].as_array().is_some_and(|permissions| permissions.iter().any(|value| value == "storage.private")) { return Err("PermissionDenied".into()); }
        let mut record = self.settings_record(owner).map_err(|_| "MalformedData")?; let mut state = decode(&record)?;
        if state.grant_version.as_deref() != Some(version) { return Err("PermissionDenied".into()); }
        let request: Request = serde_json::from_value(raw).map_err(|_| "InvalidShape")?;
        let scope = match &request { Request::Get { scope, .. } | Request::Set { scope, .. } | Request::Remove { scope, .. } | Request::Snapshot { scope } | Request::Subscribe { scope } | Request::Events { scope, .. } | Request::Unsubscribe { scope, .. } | Request::Migrate { scope, .. } => scope };
        let name = namespace(scope, project)?;
        let mut data = state.namespaces.get(&name).cloned().unwrap_or_default();
        let changed = match request {
            Request::Get { key, .. } => { if !key_valid(&key) { return Err("InvalidShape".into()); } return Ok(json!({"schemaVersion":1,"revision":data.revision,"value":data.values.get(&key)})); }
            Request::Snapshot { .. } => return Ok(snapshot(&data)),
            Request::Subscribe { .. } => {
                let mut streams = self.streams.lock().map_err(|_| "StorageUnavailable")?;
                streams.retain(|_, stream| stream.expires > std::time::Instant::now());
                if streams.len() >= 64 || streams.values().filter(|stream| stream.binding == binding).count() >= 8 { return Err("LimitExceeded".into()); }
                let id = uuid::Uuid::new_v4().to_string();
                streams.insert(id.clone(), Stream { owner: owner.into(), binding: binding.into(), namespace: name, cursor: data.revision, expires: std::time::Instant::now() + std::time::Duration::from_secs(300) });
                return Ok(json!({"schemaVersion":1,"subscription":id,"cursor":data.revision,"snapshot":snapshot(&data),"events":[],"resync":false}));
            }
            Request::Events { subscription, cursor, .. } => {
                let mut streams = self.streams.lock().map_err(|_| "StorageUnavailable")?;
                let stream = streams.get_mut(&subscription).filter(|stream| stream.owner == owner && stream.binding == binding && stream.namespace == name && stream.expires > std::time::Instant::now()).ok_or("StaleContext")?;
                let mut resync = cursor != stream.cursor || cursor > data.revision || data.revision > cursor && data.changes.first().is_none_or(|change| change.sequence > cursor.saturating_add(1));
                let mut events: Vec<_> = if resync { vec![] } else { data.changes.iter().filter(|change| change.sequence > cursor).cloned().collect() };
                if serde_json::to_vec(&events).map_err(|_| "MalformedData")?.len() > MAX_NAMESPACE { resync = true; events.clear(); }
                stream.cursor = data.revision;
                return Ok(json!({"schemaVersion":1,"cursor":data.revision,"events":events,"resync":resync,"snapshot":if resync { snapshot(&data) } else { Value::Null }}));
            }
            Request::Unsubscribe { subscription, .. } => {
                let mut streams = self.streams.lock().map_err(|_| "StorageUnavailable")?;
                if streams.get(&subscription).is_some_and(|stream| stream.owner != owner || stream.binding != binding || stream.namespace != name) { return Err("PermissionDenied".into()); }
                streams.remove(&subscription); return Ok(Value::Null);
            }
            Request::Set { key, value, .. } => { if !key_valid(&key) { return Err("InvalidShape".into()); } data.values.insert(key.clone(), value); vec![key] }
            Request::Remove { key, .. } => { if !key_valid(&key) { return Err("InvalidShape".into()); } data.values.remove(&key); vec![key] }
            Request::Migrate { revision, from_version, to_version, rollback_compatible, values, .. } => {
                // Transform runs in the qualified trusted host, never as a core callback. Only
                // bounded, optimistic, explicitly rollback-compatible output can be committed.
                if revision != data.revision || from_version != data.data_version || from_version.checked_add(1) != Some(to_version) || !rollback_compatible { return Err("MigrationRejected".into()); }
                let keys = data.values.keys().chain(values.keys()).cloned().collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>();
                if keys.len() > 128 { return Err("QuotaExceeded".into()); }
                data.values = values; data.data_version = to_version; keys
            }
        };
        if !values_valid(&data.values) || !state.namespaces.contains_key(&name) && (state.namespaces.len() >= 33 || name.starts_with("project:") && state.namespaces.keys().filter(|name| name.starts_with("project:")).count() >= 32) { return Err("QuotaExceeded".into()); }
        if data.revision >= 9_007_199_254_740_991 { return Err("LimitExceeded".into()); }
        data.revision += 1;
        data.changes.push(Change { sequence: data.revision, keys: changed });
        if data.changes.len() > 32 { data.changes.remove(0); }
        let revision = data.revision;
        state.namespaces.insert(name, data);
        record[META] = serde_json::to_value(state).map_err(|_| "MalformedData")?;
        if record.to_string().len() > 128 * 1024 { return Err("QuotaExceeded".into()); }
        self.settings_write(owner, &record).map_err(|_| "StorageUnavailable")?;
        Ok(json!({"schemaVersion":1,"revision":revision}))
    }
}
