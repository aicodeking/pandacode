//! Explicit folder snapshots, never live-path execution. Exactly the production ZIP validator.
use super::*;

fn folder_archive(path: &Path) -> Result<Vec<u8>> {
    // Reject symlinks/junctions in every ancestor, not merely the selected leaf.
    for ancestor in path.ancestors() {
        let meta = std::fs::symlink_metadata(ancestor).map_err(|_| "Development folder unavailable.")?;
        if meta.file_type().is_symlink() || !meta.is_dir() { return Err("Unsafe development folder.".into()); }
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 { return Err("Unsafe development reparse point.".into()); }
        }
    }
    let mut pending = vec![path.to_path_buf()];
    let mut files = BTreeMap::new(); let mut count = 0; let mut expanded = 0;
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory).map_err(|_| "Cannot read development folder.")? {
            count += 1; if count > MAX_FILES { return Err("Development file-count limit exceeded.".into()); }
            let entry = entry.map_err(|_| "Cannot read development entry.")?;
            let entry_path = entry.path();
            let meta = std::fs::symlink_metadata(&entry_path).map_err(|_| "Cannot inspect development entry.")?;
            if meta.file_type().is_symlink() { return Err("Unsafe development link.".into()); }
            #[cfg(windows)] {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 { return Err("Unsafe development reparse point.".into()); }
            }
            let name = entry_path.strip_prefix(path).map_err(|_| "Unsafe development path.")?.components().map(|p| p.as_os_str().to_str().ok_or("Invalid development filename.")).collect::<std::result::Result<Vec<_>, _>>()?.join("/");
            if !safe_name(&name) { return Err("Unsafe development path.".into()); }
            if meta.is_dir() { pending.push(entry_path); }
            else {
                let bytes = read_bounded(&entry_path, MAX_FILE)?;
                expanded += bytes.len() as u64;
                if expanded > MAX_EXPANDED { return Err("Development expansion limit exceeded.".into()); }
                files.insert(name, bytes);
            }
        }
    }
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        writer.start_file(name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).map_err(|_| "Cannot snapshot development folder.")?;
        writer.write_all(&bytes).map_err(|_| "Cannot snapshot development file.")?;
    }
    Ok(writer.finish().map_err(|_| "Cannot finish development snapshot.")?.into_inner())
}

impl Packages {
    pub(in crate::extensions) fn development_selected(&self, id: &str) -> bool {
        self.development.lock().is_ok_and(|selected| selected.contains_key(id))
    }
    /// Logs deliberately accept only host-owned phase labels: no source, path, stderr or values.
    /// This is stronger redaction than attempting to identify secrets in arbitrary package output.
    pub(in crate::extensions) fn development_log(&self, id: &str, phase: &'static str) {
        if let Ok(mut selected) = self.development.lock() {
            if let Some(dev) = selected.get_mut(id) {
                if dev.logs.len() == 32 { dev.logs.remove(0); }
                dev.logs.push(phase.to_owned());
            }
        }
    }
    pub(in crate::extensions) fn development_select(&self, path: &Path) -> Result<String> {
        if self.safe || !path.is_absolute() { return Err("PermissionDenied".into()); }
        let bytes = folder_archive(path)?; let package = validate(&bytes)?;
        let id = package.manifest["id"].as_str().ok_or("InvalidShape")?.to_owned();
        if package.executable.is_none() { return Err("Development requires an executable package.".into()); }
        if self.root.join(format!("{id}.json")).symlink_metadata().is_ok() { return Err("Duplicate package ownership; already installed.".into()); }
        let mut selected = self.development.lock().map_err(|_| "HostUnavailable")?;
        if selected.contains_key(&id) || selected.len() >= 8 { return Err("Conflict".into()); }
        selected.insert(id.clone(), Development { path: path.to_path_buf(), revision: 0, record: Record { schema: 1, archive: STANDARD.encode(&bytes), checksum: format!("{:x}", Sha256::digest(&bytes)), enabled: false, executable_trust: None }, logs: vec!["Validation passed; immutable folder snapshot selected. No code executed.".into(), "Executable trust and explicit enable required. Package output redacted.".into()] });
        Ok(id)
    }
    pub(in crate::extensions) fn development_reload(&self, id: &str) -> Result<()> {
        if self.safe { return Err("PermissionDenied".into()); }
        if let Some(dev) = self.development.lock().map_err(|_| "HostUnavailable")?.get_mut(id) { dev.revision = dev.revision.saturating_add(1); }
        let old = self.development.lock().map_err(|_| "HostUnavailable")?.get(id).map(|dev| (dev.path.clone(), dev.record.clone())).ok_or("Unknown development selection.")?;
        let checked = (|| {
            let bytes = folder_archive(&old.0)?; let package = validate(&bytes)?;
            if package.manifest["id"] != id || package.executable.is_none() { return Err("Development identity changed.".into()); }
            Ok(bytes)
        })();
        match checked {
            Ok(bytes) => {
                let digest = format!("{:x}", Sha256::digest(&bytes));
                let unchanged = digest == old.1.checksum;
                let mut selected = self.development.lock().map_err(|_| "HostUnavailable")?;
                let dev = selected.get_mut(id).ok_or("StaleContext")?;
                dev.record = Record { schema: 1, archive: STANDARD.encode(bytes), checksum: digest, enabled: unchanged && old.1.enabled, executable_trust: if unchanged { old.1.executable_trust } else { None } };
                drop(selected);
                self.development_log(id, if unchanged { "Reload validated; unchanged content retains trust. Activation remains lazy." } else { "Reload validated; changed content disabled. Review executable trust again." });
                Ok(())
            },
            Err(error) => {
                if let Some(dev) = self.development.lock().map_err(|_| "HostUnavailable")?.get_mut(id) { dev.record.enabled = false; dev.record.executable_trust = None; }
                self.development_log(id, "Reload validation failed; selection disabled. Package details redacted.");
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{Storage, EXECUTABLE_MANIFEST, EXECUTABLE_SOURCE, executable};
    use super::*;
    #[test]
    fn selected_folder_trust_reload_and_packaged_validation_are_identical() {
        let storage = Storage::new(); let packages = storage.packages(false);
        let folder = storage.0.join("selected"); std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("extension.json"), EXECUTABLE_MANIFEST).unwrap();
        std::fs::write(folder.join("main.cjs"), EXECUTABLE_SOURCE).unwrap();
        let id = packages.development_select(&folder).unwrap();
        assert!(packages.executable_source(&id).is_err());
        assert!(packages.enable(&id, true).unwrap_err().contains("ExecutableTrustRequired"));
        let digest = packages.snapshot().packages[0].executable.as_ref().unwrap().digest.clone();
        packages.trust(&id, &digest, true).unwrap(); packages.enable(&id, true).unwrap();
        assert_eq!(packages.executable_source(&id).unwrap().1, EXECUTABLE_SOURCE);
        packages.development_reload(&id).unwrap(); assert!(packages.snapshot().packages[0].enabled);
        // Another installed package retains state. No core/harness store is involved in reload.
        packages.install(&super::super::tests::sample()).unwrap(); packages.enable("sample.project-helper", true).unwrap();
        std::fs::write(folder.join("main.cjs"), "throw new Error('credential-canary')").unwrap();
        packages.development_reload(&id).unwrap();
        assert!(packages.executable_source(&id).is_err());
        assert!(packages.snapshot().packages.iter().find(|p| p.manifest["id"] == "sample.project-helper").unwrap().enabled);
        assert!(!serde_json::to_string(&packages.snapshot()).unwrap().contains("credential-canary"));
        assert!(packages.trust(&id, &digest, true).is_err());
        assert_eq!(storage.packages(false).snapshot().packages.len(), 1); // selections never persist.
        for (from, to) in [("^1.0.0", "^99.0.0"), ("projects.summary", "credentials.read")] {
            let invalid = EXECUTABLE_MANIFEST.replace(from, to);
            std::fs::write(folder.join("extension.json"), &invalid).unwrap();
            assert!(packages.development_reload(&id).is_err());
            assert!(validate(&super::super::tests::archive(&[("extension.json", invalid.as_bytes()), ("main.cjs", EXECUTABLE_SOURCE.as_bytes())])).is_err());
        }
        std::fs::write(folder.join("extension.json"), EXECUTABLE_MANIFEST).unwrap();
        std::fs::write(folder.join("undeclared.txt"), "secret").unwrap();
        assert!(packages.development_reload(&id).is_err());
        assert!(validate(&super::super::tests::archive(&[("../escape", b"bad")])).is_err());
        assert!(validate(&executable(EXECUTABLE_SOURCE)).is_ok());
    }
    #[test]
    fn development_assets_safe_mode_duplicates_and_bounds_fail_closed() {
        let storage = Storage::new(); let packages = storage.packages(false);
        let folder = storage.0.join("assets"); std::fs::create_dir(&folder).unwrap();
        std::fs::create_dir(folder.join("assets")).unwrap();
        let mut manifest: Value = serde_json::from_str(EXECUTABLE_MANIFEST).unwrap();
        manifest["contributes"]["icons"] = json!([{"id":"sample.project-summary/icon","asset":"assets/icon.svg"}]);
        let raw = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(folder.join("extension.json"), &raw).unwrap();
        std::fs::write(folder.join("main.cjs"), EXECUTABLE_SOURCE).unwrap();
        for svg in [b"<svg><script/></svg>".as_slice(), b"<svg><path fill=\"url(http://example.invalid)\"/></svg>"] {
            std::fs::write(folder.join("assets/icon.svg"), svg).unwrap();
            assert!(packages.development_select(&folder).is_err());
            assert!(validate(&super::super::tests::archive(&[("extension.json", &raw), ("main.cjs", EXECUTABLE_SOURCE.as_bytes()), ("assets/icon.svg", svg)])).is_err());
        }
        std::fs::write(folder.join("assets/icon.svg"), "<svg/>").unwrap();
        assert!(storage.packages(true).development_select(&folder).is_err());
        packages.development_select(&folder).unwrap();
        assert!(packages.development_select(&folder).is_err());
        std::fs::write(folder.join("main.cjs"), vec![b' '; MAX_FILE as usize + 1]).unwrap();
        assert!(packages.development_reload("sample.project-summary").is_err());
        assert!(!packages.snapshot().packages[0].enabled);
        #[cfg(windows)] {
            // Directory junctions need no symlink privilege. Target remains an owned test directory.
            let link = storage.0.join("junction");
            let status = std::process::Command::new("cmd.exe").args(["/c", "mklink", "/J"]).arg(&link).arg(&folder).output().unwrap();
            assert!(status.status.success());
            assert!(packages.development_select(&link).is_err());
            // Remove only the test junction, never its target.
            std::fs::remove_dir(link).unwrap();
        }
    }
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    #[tokio::test]
    async fn sdk_example_uses_real_supervised_broker_identically_in_both_modes() {
        use crate::extensions::{context::ContextBroker, supervisor};
        use std::sync::{Arc, atomic::AtomicBool};
        let runtime = supervisor::Runtime::packaged(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")).unwrap();
        let example = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/extensions/project-summary/package");
        let bytes = folder_archive(&example).unwrap();
        for development in [false, true] {
            let storage = Storage::new(); let packages = storage.packages(false);
            if development { packages.development_select(&example).unwrap(); } else { packages.install(&bytes).unwrap(); }
            let id = "sample.sdk-summary";
            assert!(packages.executable_source(id).is_err());
            let digest = packages.snapshot().packages[0].executable.as_ref().unwrap().digest.clone();
            packages.trust(id, &digest, true).unwrap(); packages.enable(id, true).unwrap();
            let snapshot = packages.snapshot();
            let store = crate::storage::Store::open(Path::new(":memory:")).unwrap();
            store.db.execute("INSERT INTO projects(id,name,path) VALUES ('project-1','orbit','/not-exposed')", []).unwrap();
            for consent in [false, true] {
                let broker = ContextBroker::default();
                let capture = broker.test_call(&snapshot, &store, json!({"op":"capture","id":"sample.sdk-summary/header","version":"1.0.0","context":{"schemaVersion":1,"windowId":"main","surfaceId":"panda.workspace.header.actions","projectId":"project-1","revision":1}}));
                let handle = capture["value"]["handle"].as_str().unwrap();
                if consent { assert_eq!(broker.test_call(&snapshot, &store, json!({"op":"consent","handle":handle,"capability":"projects.summary","allow":true}))["ok"], true); }
                for forged in [json!({"op":"consent","capability":"projects.summary","allow":true}), json!({"op":"query","resource":"projects","handle":"forged"}), json!({"op":"query","resource":"projects","extensionId":"panda.core"})] {
                    assert_eq!(broker.runtime_call(&snapshot, &store, handle, forged)["ok"], false);
                }
                let (_, _, context) = broker.runtime_binding(&snapshot, handle).unwrap();
                let start = std::time::Instant::now();
                let result = supervisor::run(&runtime, &packages.executable_source(id).unwrap().1, context, Arc::new(AtomicBool::new(false)), |method, params| {
                    if method == "dialog" {
                        assert_eq!(crate::extensions::contracts::validate_contract("dialog", &params)["ok"], true);
                        json!({"ok":true,"value":null})
                    } else { broker.runtime_call(&snapshot, &store, handle, params) }
                }).await;
                if consent { assert_eq!(result.unwrap()[0]["confirmation"], "Captured project project-1: orbit"); }
                else { assert_eq!(result.unwrap_err(), "HostUnavailable"); }
                println!("SDK_NATIVE mode={} consent={consent} elapsedMs={}", if development { "development" } else { "packaged" }, start.elapsed().as_millis());
                broker.runtime_release(handle); assert_eq!(broker.test_counts(), (0, 0));
            }
            // Same measured five-second budget even when code originates in a selected folder.
            let start = std::time::Instant::now();
            let result = supervisor::run(&runtime, "exports.activate=()=>{while(true){}}", Value::Null, Arc::new(AtomicBool::new(false)), |_, _| panic!("loop reached API")).await;
            assert_eq!(result.unwrap_err(), "Timeout");
            assert!(start.elapsed() < std::time::Duration::from_secs(7));
            println!("SDK_NATIVE_BUDGET development={development} elapsedMs={}", start.elapsed().as_millis());
        }
    }
}
