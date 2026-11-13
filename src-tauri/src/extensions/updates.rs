//! One-record package/state transactions and provider-owned drain leases.
use super::*;
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
pub(crate) fn configure_notifications(app: tauri::AppHandle) { let _ = APP.set(app); }
pub(crate) fn updates_changed() { if let Some(app) = APP.get() { super::super::windows::changed(app); } }
pub(super) fn prepare_enable(record: &mut Record, enabled: bool, executable: bool) {
    if enabled && executable && record.lifecycle.previous.is_some() { record.lifecycle.probation = true; }
    if !enabled { record.lifecycle.probation = false; }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(super) struct Lifecycle {
    pub state: Option<Value>,
    staged: Option<Box<Record>>,
    previous: Option<Box<Record>>,
    approved: bool,
    probation: bool,
    pub failed: bool,
    pub removing: bool,
    pub reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::tests::{Storage, archive};
    const ID: &str = "sample.storage-laboratory";
    fn bytes(version: &str, executable: bool) -> Vec<u8> {
        let mut manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/storage-laboratory/extension.json")).unwrap();
        manifest["version"] = json!(version);
        if executable {
            manifest["runtime"] = json!({"kind":"node","entrypoint":"main.cjs","activationEvents":[format!("{ID}/inspect")]});
            manifest["contributes"]["commands"][0]["action"] = json!({"kind":"runCommand"});
        }
        let encoded = serde_json::to_vec(&manifest).unwrap();
        if executable { archive(&[("extension.json", &encoded), ("main.cjs", b"exports.activate=async()=>{};")]) } else { archive(&[("extension.json", &encoded)]) }
    }
    fn install(packages: &Packages, executable: bool) {
        packages.install(&bytes("1.0.0", executable)).unwrap();
        if executable { let digest = packages.raw_record(ID).unwrap().unwrap().checksum; packages.trust(ID, &digest, true).unwrap(); }
        packages.enable(ID, true).unwrap(); packages.storage_grant(ID, true).unwrap();
        packages.storage_call(ID, "1.0.0", None, "binding", json!({"op":"set","scope":"global","key":"sentinel","value":"prior state"})).unwrap();
    }
    fn review(packages: &Packages) { let digest = packages.raw_record(ID).unwrap().unwrap().lifecycle.staged.unwrap().checksum; packages.review_update(ID, &digest).unwrap(); }
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    #[tokio::test]
    async fn update_real_supervised_process_keeps_its_pinned_version_until_completion() {
        use crate::extensions::supervisor;
        use std::sync::{Arc, atomic::AtomicBool};
        let disk = Storage::new(); let packages = Arc::new(Mutex::new(disk.packages(false)));
        let digest = { let packages = packages.lock().unwrap(); install(&packages, true); packages.executable_source(ID).unwrap().0 };
        let lease = pin(&packages, ID, &digest).unwrap();
        let runtime = supervisor::Runtime::packaged(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")).unwrap();
        let source = "exports.activate=async panda=>{const reply=await panda.context.query({resource:'projects',limit:1});if(reply.state!=='kept')throw new Error('Lost pinned source');};";
        let mut calls = 0;
        let result = supervisor::run(&runtime, source, json!({}), Arc::new(AtomicBool::new(false)), |method, _params| {
            assert_eq!(method, "context"); calls += 1;
            let packages = packages.lock().unwrap(); packages.stage_update_bytes(ID, &bytes("1.1.0", true)).unwrap(); review(&packages);
            assert_eq!(packages.executable_source(ID).unwrap().0, digest);
            assert_eq!(packages.snapshot().packages[0].manifest["version"], "1.0.0");
            json!({"ok":true,"value":{"state":"kept","items":[]}})
        }).await.unwrap();
        assert!(result.is_empty()); assert_eq!(calls, 1);
        assert_eq!(packages.lock().unwrap().snapshot().packages[0].manifest["version"], "1.0.0"); drop(lease);
        assert_eq!(packages.lock().unwrap().snapshot().packages[0].manifest["version"], "1.1.0");
    }
    #[test]
    fn update_dependency_activation_failure_and_disable_during_drain_preserve_user_choice() {
        let disk = Storage::new(); let packages = std::sync::Arc::new(Mutex::new(disk.packages(false)));
        let digest = { let packages = packages.lock().unwrap(); install(&packages, true); packages.executable_source(ID).unwrap().0 };
        {
            let packages = packages.lock().unwrap();
            let mut manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/storage-laboratory/extension.json")).unwrap();
            manifest["version"] = json!("1.1.0"); manifest["dependencies"] = json!({"missing.package":"^1.0.0"});
            packages.stage_update_bytes(ID, &archive(&[("extension.json", &serde_json::to_vec(&manifest).unwrap())])).unwrap();
            let digest = packages.raw_record(ID).unwrap().unwrap().lifecycle.staged.unwrap().checksum;
            assert!(packages.review_update(ID, &digest).is_err());
            let snapshot = packages.snapshot(); assert_eq!(snapshot.packages[0].manifest["version"], "1.0.0");
            assert!(snapshot.packages[0].reason.as_ref().unwrap().contains("Quarantined"));
            packages.rollback_update(ID, "Discard incompatible candidate").unwrap();
        }
        let lease = pin(&packages, ID, &digest).unwrap();
        { let packages = packages.lock().unwrap(); packages.stage_update_bytes(ID, &bytes("1.2.0", true)).unwrap(); review(&packages); packages.enable(ID, false).unwrap(); }
        drop(lease);
        let packages = packages.lock().unwrap(); let snapshot = packages.snapshot();
        assert_eq!(snapshot.packages[0].manifest["version"], "1.2.0"); assert!(!snapshot.packages[0].enabled);
        assert!(packages.executable_source(ID).is_err());
        // A newly enabled dependent cannot lock a provisional update out of automatic rollback.
        packages.enable(ID, true).unwrap();
        let mut dependent: Value = serde_json::from_str(&include_str!("../../../tests/fixtures/extensions/storage-laboratory/extension.json").replace(ID, "other.storage-laboratory")).unwrap();
        dependent["dependencies"] = json!({(ID):"^1.2.0"});
        packages.install(&archive(&[("extension.json", &serde_json::to_vec(&dependent).unwrap())])).unwrap();
        assert!(packages.enable("other.storage-laboratory", true).unwrap_err().contains("provisional rollback"));
        let digest = packages.executable_source(ID).unwrap().0; packages.activation_finished(ID, &digest, false).unwrap();
        assert_eq!(packages.snapshot().packages.iter().find(|p| p.manifest["id"] == ID).unwrap().manifest["version"], "1.0.0");
    }
    #[test]
    fn update_review_drain_pins_exact_source_and_uninstall_waits_for_last_lease() {
        let disk = Storage::new(); let packages = std::sync::Arc::new(Mutex::new(disk.packages(false)));
        let digest = { let packages = packages.lock().unwrap(); install(&packages, true); packages.executable_source(ID).unwrap().0 };
        let first = pin(&packages, ID, &digest).unwrap(); let second = pin(&packages, ID, &digest).unwrap();
        {
            let packages = packages.lock().unwrap(); packages.stage_update_bytes(ID, &bytes("1.1.0", true)).unwrap();
            assert_eq!(packages.snapshot().packages[0].manifest["version"], "1.0.0");
            assert!(packages.review_update(ID, "stale-digest").is_err()); review(&packages);
            assert_eq!(packages.executable_source(ID).unwrap().0, digest);
            assert_eq!(packages.snapshot().packages[0].update.as_ref().unwrap().pinned, 2);
            assert!(packages.executable_admission(ID).is_err());
            assert!(packages.provider_registrations().is_empty());
        }
        assert!(pin(&packages, ID, &digest).is_err()); drop(first);
        assert_eq!(packages.lock().unwrap().snapshot().packages[0].manifest["version"], "1.0.0");
        drop(second);
        {
            let packages = packages.lock().unwrap(); assert_eq!(packages.snapshot().packages[0].manifest["version"], "1.1.0");
            assert!(packages.executable_admission(ID).is_ok());
            let digest = packages.executable_source(ID).unwrap().0; packages.activation_finished(ID, &digest, true).unwrap();
        }
        let digest = packages.lock().unwrap().executable_source(ID).unwrap().0;
        let lease = pin(&packages, ID, &digest).unwrap();
        packages.lock().unwrap().uninstall(ID).unwrap();
        assert!(packages.lock().unwrap().snapshot().packages[0].enabled);
        assert!(pin(&packages, ID, &digest).is_err()); drop(lease);
        assert!(packages.lock().unwrap().snapshot().packages.is_empty());
        assert_eq!(packages.lock().unwrap().settings_record(ID).unwrap()["__privateStorageV1"]["namespaces"]["global"]["values"]["sentinel"], "prior state");
    }
    #[test]
    fn update_failed_activation_migration_interruption_and_manual_rollback_restore_package_and_state() {
        let disk = Storage::new(); let packages = disk.packages(false); install(&packages, true);
        let history = disk.0.join("core-history-sentinel"); std::fs::write(&history, b"unchanged core work").unwrap();
        let previous = packages.settings_record(ID).unwrap();
        packages.stage_update_bytes(ID, &bytes("1.1.0", true)).unwrap(); review(&packages);
        packages.storage_grant(ID, true).unwrap();
        let request = json!({"op":"migrate","scope":"global","revision":1,"fromVersion":1,"toVersion":2,"rollbackCompatible":false,"values":{}});
        assert_eq!(packages.storage_call(ID, "1.1.0", None, "new", request).unwrap_err(), "MigrationRejected");
        packages.storage_call(ID, "1.1.0", None, "new", json!({"op":"set","scope":"global","key":"sentinel","value":"failed new state"})).unwrap();
        let digest = packages.executable_source(ID).unwrap().0; packages.activation_finished(ID, &digest, false).unwrap();
        assert_eq!(packages.snapshot().packages[0].manifest["version"], "1.0.0"); assert_eq!(packages.settings_record(ID).unwrap(), previous);
        assert!(packages.snapshot().packages[0].reason.as_ref().unwrap().contains("Quarantined"));
        packages.stage_update_bytes(ID, &bytes("1.2.0", true)).unwrap(); review(&packages);
        // Simulate a process exit before provisional activation is acknowledged.
        let restarted = disk.packages(false);
        assert_eq!(restarted.snapshot().packages[0].manifest["version"], "1.0.0"); assert_eq!(restarted.settings_record(ID).unwrap(), previous);
        restarted.stage_update_bytes(ID, &bytes("1.3.0", true)).unwrap(); review(&restarted);
        let digest = restarted.executable_source(ID).unwrap().0; restarted.activation_finished(ID, &digest, true).unwrap();
        restarted.rollback_update(ID, "Manual rollback").unwrap();
        assert_eq!(restarted.snapshot().packages[0].manifest["version"], "1.0.0"); assert_eq!(restarted.settings_record(ID).unwrap(), previous);
        assert_eq!(std::fs::read(history).unwrap(), b"unchanged core work");
    }
    #[test]
    fn update_invalid_partial_archives_permission_diff_and_safe_mode_never_replace_committed_work() {
        let disk = Storage::new(); let packages = disk.packages(false); install(&packages, false);
        let path = packages.root.join(format!("{ID}.json")); let before = std::fs::read(&path).unwrap();
        assert!(packages.stage_update_bytes(ID, b"partial ZIP").is_err()); assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::write(packages.root.join("interrupted.stage"), b"partial record").unwrap();
        assert_eq!(disk.packages(false).snapshot().packages.len(), 1);
        let mut manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/storage-laboratory/extension.json")).unwrap();
        manifest["version"] = json!("1.1.0"); manifest["permissions"] = json!(["ui.contribute","storage.private","projects.summary"]);
        let candidate = archive(&[("extension.json", &serde_json::to_vec(&manifest).unwrap())]);
        packages.stage_update_bytes(ID, &candidate).unwrap();
        assert_eq!(packages.snapshot().packages[0].update.as_ref().unwrap().added_permissions, vec!["projects.summary"]);
        assert!(packages.stage_update_bytes(ID, &candidate).is_err());
        let safe = disk.packages(true); assert!(safe.snapshot().packages.is_empty()); assert!(safe.stage_update_bytes(ID, &candidate).is_err());
        packages.rollback_update(ID, "Discard").unwrap(); assert_eq!(packages.snapshot().packages[0].manifest["version"], "1.0.0");
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Status {
    version: Option<String>, digest: Option<String>, added_permissions: Vec<String>,
    executable: bool, pub draining: bool, pinned: usize, rollback: bool, reason: String,
}

/// Acquired while holding the package lock, before copying source. No reverse lock order.
pub(crate) struct ProviderPin { packages: std::sync::Weak<Mutex<Packages>>, owner: String }
impl Drop for ProviderPin {
    fn drop(&mut self) {
        let mut changed = false;
        if let Some(packages) = self.packages.upgrade() { if let Ok(packages) = packages.lock() {
            let selected = || packages.record(&packages.root.join(format!("{}.json", self.owner))).ok().map(|(record, _)| record.checksum);
            let before = selected();
            if let Ok(mut pins) = packages.pins.lock() { if let Some(count) = pins.get_mut(&self.owner) { *count = count.saturating_sub(1); } }
            // Failed promotion retains the selected version and a quarantined candidate.
            let _ = packages.drain_update(&self.owner);
            changed = before != selected();
        } }
        if changed { if let Some(app) = APP.get() { super::super::runtime::package_changed(app, &self.owner); } }
        updates_changed();
    }
}
pub(crate) fn pin(packages: &std::sync::Arc<Mutex<Packages>>, owner: &str, digest: &str) -> Result<ProviderPin> {
    let state = packages.lock().map_err(|_| "HostUnavailable")?;
    let (record, _) = state.record(&state.root.join(format!("{owner}.json")))?;
    if record.lifecycle.removing || record.lifecycle.approved || record.lifecycle.failed || state.executable_source(owner)?.0 != digest { return Err("StaleContext".into()); }
    *state.pins.lock().map_err(|_| "HostUnavailable")?.entry(owner.into()).or_default() += 1;
    Ok(ProviderPin { packages: std::sync::Arc::downgrade(packages), owner: owner.into() })
}
impl Packages {
    pub(in crate::extensions) fn executable_admission(&self, id: &str) -> Result<(String, String)> {
        let (record, _) = self.record(&self.root.join(format!("{id}.json")))?;
        if record.lifecycle.approved || record.lifecycle.removing || record.lifecycle.failed { return Err("Conflict: package is draining".into()); }
        self.executable_source(id)
    }
    /// Do not admit a dependent that would make automatic probation rollback incompatible.
    pub(super) fn validate_rollback_graph(&self, manifests: &[Value]) -> Result<()> {
        for manifest in manifests {
            let Some(id) = manifest["id"].as_str() else { return Err("InvalidIdentity".into()); };
            let Some(record) = self.raw_record(id)? else { continue; };
            if !record.lifecycle.probation { continue; }
            let Some(previous) = record.lifecycle.previous else { continue; };
            let prior = validate(&STANDARD.decode(&previous.archive).map_err(|_| "InvalidPackage")?)?;
            let mut rollback: Vec<_> = manifests.iter().filter(|manifest| manifest["id"] != id).cloned().collect();
            rollback.push(prior.manifest);
            if super::super::contracts::validate_contract("packages", &json!(rollback))["ok"] != true { return Err("Activation rejected: dependent would prevent provisional rollback".into()); }
        }
        Ok(())
    }
    pub(super) fn raw_record(&self, id: &str) -> Result<Option<Record>> {
        if !safe_name(id) || id.contains('/') { return Err("Invalid extension identity.".into()); }
        let path = self.root.join(format!("{id}.json"));
        if !path.exists() { return Ok(None); }
        serde_json::from_slice(&read_bounded(&path, MAX_RECORD)?).map(Some).map_err(|_| "Corrupt extension record.".into())
    }
    pub(crate) fn pin_count(&self, id: &str) -> usize { self.pins.lock().map(|pins| pins.get(id).copied().unwrap_or(0)).unwrap_or(usize::MAX) }
    pub(super) fn update_status(&self, record: &Record, manifest: &Value) -> Result<Option<Status>> {
        let id = manifest["id"].as_str().ok_or("Invalid identity")?;
        let pinned = self.pin_count(id);
        let candidate = record.lifecycle.staged.as_ref().map(|record| STANDARD.decode(&record.archive).map_err(|_| "Corrupt staged archive.".to_owned()).and_then(|bytes| validate(&bytes))).transpose()?;
        if candidate.is_none() && record.lifecycle.previous.is_none() && !record.lifecycle.removing && pinned == 0 { return Ok(None); }
        let added_permissions = candidate.as_ref().map(|candidate| candidate.manifest["permissions"].as_array().into_iter().flatten().filter(|permission| !manifest["permissions"].as_array().is_some_and(|old| old.contains(permission))).filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
        Ok(Some(Status {
            version: candidate.as_ref().and_then(|candidate| candidate.manifest["version"].as_str().map(str::to_owned)),
            digest: record.lifecycle.staged.as_ref().map(|record| record.checksum.clone()),
            added_permissions, executable: candidate.as_ref().is_some_and(|candidate| candidate.executable.is_some()),
            draining: record.lifecycle.approved || record.lifecycle.removing || record.lifecycle.failed, pinned, rollback: record.lifecycle.previous.is_some(),
            reason: if record.lifecycle.removing { "Uninstall pending: active provider version pinned".into() } else if record.lifecycle.failed { "Quarantined: failed activation waiting for provider drain or compatible rollback".into() } else if record.lifecycle.approved { "Reviewed update waiting for provider runs to finish".into() } else if candidate.is_some() { record.lifecycle.reason.clone().unwrap_or_else(|| "Staged: explicit permission and executable review required".into()) } else if record.lifecycle.probation { "Provisional: first activation must succeed".into() } else if pinned > 0 && record.lifecycle.previous.is_none() { "Active provider version pinned".into() } else { "Prior compatible package/state available for manual rollback".into() },
        }))
    }
    pub(in crate::extensions) fn stage_update(&self, id: &str, path: &Path) -> Result<()> { self.stage_update_bytes(id, &read_bounded(path, MAX_ARCHIVE)?) }
    fn stage_update_bytes(&self, id: &str, bytes: &[u8]) -> Result<()> {
        if self.safe || self.development_selected(id) { return Err("PermissionDenied".into()); }
        let package = validate(bytes)?;
        if package.manifest["id"] != id { return Err("Package ownership mismatch".into()); }
        let path = self.root.join(format!("{id}.json")); let (mut record, _) = self.record(&path)?;
        if record.lifecycle.staged.is_some() || record.lifecycle.removing || record.lifecycle.probation { return Err("Conflict: finish or discard the pending update first".into()); }
        let checksum = format!("{:x}", Sha256::digest(bytes));
        if record.checksum == checksum { return Err("Identical package content".into()); }
        record.lifecycle.reason = None;
        record.lifecycle.staged = Some(Box::new(Record { schema: 1, archive: STANDARD.encode(bytes), checksum, enabled: record.enabled, executable_trust: None, lifecycle: Lifecycle::default() }));
        self.write(&path, &record)
    }
    pub(in crate::extensions) fn review_update(&self, id: &str, digest: &str) -> Result<()> {
        if self.safe || !safe_name(id) || id.contains('/') { return Err("PermissionDenied".into()); }
        let path = self.root.join(format!("{id}.json")); let (mut record, _) = self.record(&path)?;
        let candidate = record.lifecycle.staged.as_mut().ok_or("StaleContext")?;
        if candidate.checksum != digest { return Err("StaleContext".into()); }
        candidate.executable_trust = Some(digest.into()); record.lifecycle.approved = true;
        self.write(&path, &record)?; self.drain_update(id)
    }
    fn drain_update(&self, id: &str) -> Result<()> {
        let result = self.drain_update_inner(id);
        if result.is_err() { if let Ok(Some(mut record)) = self.raw_record(id) {
            if record.lifecycle.staged.is_some() { record.lifecycle.approved = false; record.lifecycle.reason = Some("Quarantined staged update: activation/state validation or promotion failed; prior package retained".into()); let _ = self.write(&self.root.join(format!("{id}.json")), &record); }
        } }
        result
    }
    fn drain_update_inner(&self, id: &str) -> Result<()> {
        if self.safe { return Ok(()); }
        if self.pin_count(id) != 0 { return Ok(()); }
        let path = self.root.join(format!("{id}.json")); let (mut record, _) = self.record(&path)?;
        if record.lifecycle.removing { return self.uninstall(id); }
        if record.lifecycle.failed { return self.rollback_update(id, "Quarantined update: activation failed; prior compatible package/state restored"); }
        if !record.lifecycle.approved { return Ok(()); }
        let mut candidate = *record.lifecycle.staged.take().ok_or("StaleContext")?;
        // Disable/revocation during drain must not be undone by the earlier staged preference.
        candidate.enabled = record.enabled;
        // Revalidate graph before committing. Failed activation validation leaves old bytes selected.
        let package = validate(&STANDARD.decode(&candidate.archive).map_err(|_| "InvalidPackage")?)?;
        let executable = package.executable.is_some();
        let mut manifests: Vec<_> = self.snapshot().packages.into_iter().filter(|p| p.enabled && p.manifest["id"] != id).map(|p| p.manifest).collect();
        if candidate.enabled { manifests.push(package.manifest); }
        if super::super::contracts::validate_contract("packages", &json!(manifests))["ok"] != true { return Err("Activation rejected: incompatible update/dependency graph".into()); }
        self.validate_rollback_graph(&manifests)?;
        let state = self.settings_record(id)?;
        record.lifecycle = Lifecycle { state: Some(state.clone()), ..Lifecycle::default() };
        candidate.lifecycle = Lifecycle { state: Some(state), previous: Some(Box::new(record)), probation: candidate.enabled && executable, ..Lifecycle::default() };
        self.storage_dispose(Some(id), None);
        self.write(&path, &candidate)
    }
    pub(in crate::extensions) fn rollback_update(&self, id: &str, reason: &str) -> Result<()> {
        if self.safe || !safe_name(id) || id.contains('/') || self.pin_count(id) != 0 { return Err("Conflict: provider version is pinned".into()); }
        let path = self.root.join(format!("{id}.json")); let (mut record, _) = self.record(&path)?;
        if record.lifecycle.staged.take().is_some() { record.lifecycle.approved = false; return self.write(&path, &record); }
        if let Some(mut previous) = record.lifecycle.previous.take() {
            let package = validate(&STANDARD.decode(&previous.archive).map_err(|_| "InvalidPackage")?)?;
            let mut manifests: Vec<_> = self.snapshot().packages.into_iter().filter(|p| p.enabled && p.manifest["id"] != id).map(|p| p.manifest).collect();
            if previous.enabled { manifests.push(package.manifest); }
            if super::super::contracts::validate_contract("packages", &json!(manifests))["ok"] != true { return Err("Rollback rejected: incompatible dependency graph".into()); }
            previous.lifecycle.reason = Some(reason.into()); self.storage_dispose(Some(id), None); self.write(&path, &previous)
        } else { Err("No prior compatible package".into()) }
    }
    pub(crate) fn activation_finished(&self, id: &str, digest: &str, success: bool) -> Result<()> {
        let path = self.root.join(format!("{id}.json")); let (mut record, _) = self.record(&path)?;
        if record.checksum != digest || !record.lifecycle.probation { return Ok(()); }
        if success && !record.lifecycle.failed { record.lifecycle.probation = false; self.write(&path, &record) }
        else { record.lifecycle.failed = true; self.write(&path, &record)?; self.drain_update(id) }
    }
    pub(super) fn recover_updates(&self) -> bool {
        if self.safe || !self.root.exists() { return true; }
        if self.directory().is_err() { return false; }
        let mut recovered = true;
        if let Ok(entries) = std::fs::read_dir(&self.root) { for path in entries.filter_map(|entry| entry.ok().map(|entry| entry.path())).filter(|path| path.extension().is_some_and(|ext| ext == "json")).take(MAX_PACKAGES) {
            let Some(id) = path.file_stem().and_then(|id| id.to_str()) else { continue; };
            if let Ok(Some(record)) = self.raw_record(id) {
                if record.lifecycle.probation { recovered &= self.rollback_update(id, "Interrupted provisional activation: prior compatible package/state restored").is_ok(); }
                else if record.lifecycle.removing || record.lifecycle.approved { let _ = self.drain_update(id); }
            }
        } }
        recovered
    }
}
