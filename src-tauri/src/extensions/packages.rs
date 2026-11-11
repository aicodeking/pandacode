//! No extraction, executable runtime, install scripts or automatic network traffic.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, io::{Cursor, Read, Write}, path::{Path, PathBuf}, sync::Mutex};

const MAX_ARCHIVE: u64 = 2 * 1024 * 1024;
const MAX_FILE: u64 = 256 * 1024;
const MAX_EXPANDED: u64 = 1024 * 1024;
const MAX_FILES: usize = 64;
const MAX_PACKAGES: usize = 64;
const MAX_RECORD: u64 = 3 * 1024 * 1024;
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record { schema: u8, archive: String, checksum: String, enabled: bool }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Package { manifest: Value, icons: BTreeMap<String, String>, enabled: bool, reason: Option<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot { safe_mode: bool, packages: Vec<Package>, diagnostics: Vec<String> }
pub struct Packages { root: PathBuf, safe: bool }
pub struct ExtensionPackages(pub Mutex<Packages>);
impl ExtensionPackages {
    pub fn new(dir: &Path, safe: bool) -> Self { Self(Mutex::new(Packages { root: dir.join("extensions-v1"), safe })) }
}

fn regular(path: &Path) -> Result<()> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| "Extension storage is unavailable.")?;
    if meta.file_type().is_symlink() || !meta.is_file() { return Err("Extension storage must contain regular files only.".into()); }
    Ok(())
}
fn read_bounded(path: &Path, max: u64) -> Result<Vec<u8>> {
    regular(path)?;
    let file = std::fs::File::open(path).map_err(|_| "Cannot open extension package.")?;
    if file.metadata().map_err(|_| "Cannot inspect extension package.")?.len() > max { return Err("Extension size limit exceeded.".into()); }
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes).map_err(|_| "Cannot read extension package.")?;
    if bytes.len() as u64 > max { return Err("Extension size limit exceeded.".into()); }
    Ok(bytes)
}
fn safe_name(name: &str) -> bool {
    name.len() <= 160 && !name.is_empty() && name.split('/').all(|part| !part.is_empty() && part != "." && part != ".." && !part.ends_with('.') && part.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c)))
}

/// A deliberately small static SVG grammar, not a sanitizer that tries to repair hostile XML.
/// No entities, namespaces (except the fixed root xmlns), CSS, URLs, text or active elements.
fn static_svg(bytes: &[u8]) -> Result<String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Icon is not UTF-8 SVG.")?.trim();
    if text.len() > 32768 || text.contains(['&', '!', '?']) { return Err("Unsafe SVG icon.".into()); }
    let token = regex::Regex::new(r#"^<(/?)([a-zA-Z]+)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*(/?)>"#).unwrap();
    let attr = regex::Regex::new(r#"\s+([a-zA-Z-]+)="([^"]*)""#).unwrap();
    let mut remaining = text;
    let mut stack = Vec::new();
    let mut roots = 0;
    while !remaining.trim_start().is_empty() {
        remaining = remaining.trim_start();
        let caps = token.captures(remaining).ok_or("Malformed SVG icon.")?;
        let tag = &caps[2];
        if !["svg", "g", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse"].contains(&tag) { return Err("Unsupported SVG element.".into()); }
        if &caps[1] == "/" {
            if !caps[3].is_empty() || !caps[4].is_empty() || stack.pop().as_deref() != Some(tag) { return Err("Malformed SVG nesting.".into()); }
        } else {
            if stack.is_empty() { roots += 1; if tag != "svg" || roots != 1 { return Err("SVG needs one root.".into()); } }
            else if tag == "svg" { return Err("Nested SVG is unsupported.".into()); }
            let mut seen = BTreeSet::new();
            for field in attr.captures_iter(&caps[3]) {
                let key = &field[1]; let value = &field[2];
                if !seen.insert(key.to_string()) { return Err("Duplicate SVG attribute.".into()); }
                let valid = match key {
                    "xmlns" => tag == "svg" && value == "http://www.w3.org/2000/svg",
                    "fill" | "stroke" => ["none", "currentColor"].contains(&value),
                    "stroke-linecap" => ["round", "butt", "square"].contains(&value),
                    "stroke-linejoin" => ["round", "miter", "bevel"].contains(&value),
                    "viewBox" | "width" | "height" | "cx" | "cy" | "r" | "rx" | "ry" | "x" | "y" | "x1" | "x2" | "y1" | "y2" | "stroke-width" | "opacity" | "points" => !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit() || b" .,+-eE".contains(&b)),
                    "d" => !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit() || b" .,+-eEMmZzLlHhVvCcSsQqTtAa".contains(&b)),
                    _ => false,
                };
                if !valid { return Err("Unsafe SVG attribute.".into()); }
            }
            if caps[4].is_empty() { stack.push(tag.to_owned()); if stack.len() > 16 { return Err("SVG nesting limit exceeded.".into()); } }
        }
        remaining = &remaining[caps.get(0).unwrap().end()..];
    }
    if roots != 1 || !stack.is_empty() { return Err("Malformed SVG document.".into()); }
    Ok(text.to_string())
}

fn validate(bytes: &[u8]) -> Result<Package> {
    if bytes.len() as u64 > MAX_ARCHIVE { return Err("Archive size limit exceeded.".into()); }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "Invalid extension ZIP.")?;
    if zip.len() > MAX_FILES { return Err("Archive file-count limit exceeded.".into()); }
    let mut files = BTreeMap::new(); let mut expanded = 0;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|_| "Invalid ZIP entry.")?;
        let name = file.name().to_owned();
        // Check EVERY entry, including undeclared assets; never normalize an unsafe path.
        let directory = file.is_dir();
        let kind = file.unix_mode().unwrap_or(0) & 0o170000;
        if !safe_name(if directory { name.strip_suffix('/').unwrap_or(&name) } else { &name }) || ![0, 0o100000, 0o040000].contains(&kind) || (!directory && kind == 0o040000) { return Err("Unsafe archive entry.".into()); }
        if directory { if file.size() != 0 { return Err("Invalid archive directory.".into()); } continue; }
        if file.size() > MAX_FILE { return Err("Archive file limit exceeded.".into()); }
        let mut content = Vec::new();
        file.by_ref().take(MAX_FILE + 1).read_to_end(&mut content).map_err(|_| "Invalid compressed entry.")?;
        expanded += content.len() as u64;
        if content.len() as u64 > MAX_FILE || expanded > MAX_EXPANDED { return Err("Archive expansion limit exceeded.".into()); }
        if files.insert(name.to_ascii_lowercase(), (name, content)).is_some() { return Err("Duplicate archive ownership.".into()); }
    }
    let raw: Value = serde_json::from_slice(&files.get("extension.json").ok_or("Missing extension.json.")?.1).map_err(|_| "Malformed extension.json.")?;
    let checked = super::contracts::validate_contract("packages", &json!([raw]));
    if checked["ok"] != true { return Err(format!("Invalid manifest: {}", checked["error"]["code"])); }
    let manifest = checked["value"]["packages"][0].clone();
    let contributions = &manifest["contributes"];
    if contributions["views"].as_array().is_some_and(|a| !a.is_empty()) || contributions["commands"].as_array().into_iter().flatten().any(|c| c["action"]["kind"] != "showMessage") { return Err("This delivery supports declarative showMessage only.".into()); }
    let mut allowed = BTreeSet::from(["extension.json".to_string()]); let mut icons = BTreeMap::new();
    for icon in contributions["icons"].as_array().into_iter().flatten() {
        let asset = icon["asset"].as_str().unwrap();
        if !asset.ends_with(".svg") { return Err("This delivery supports static SVG icons only.".into()); }
        let (name, content) = files.get(&asset.to_ascii_lowercase()).ok_or("Missing declared icon.")?;
        if name != asset { return Err("Icon path case mismatch.".into()); }
        icons.insert(icon["id"].as_str().unwrap().to_owned(), static_svg(content)?); allowed.insert(asset.to_owned());
    }
    if files.values().any(|(name, _)| !allowed.contains(name)) { return Err("Undeclared package file; executable files and install hooks are unsupported.".into()); }
    Ok(Package { manifest, icons, enabled: false, reason: None })
}

impl Packages {
    fn directory(&self) -> Result<()> {
        if self.root.exists() {
            let meta = std::fs::symlink_metadata(&self.root).map_err(|_| "Cannot inspect extension storage.")?;
            if meta.file_type().is_symlink() || !meta.is_dir() { return Err("Unsafe extension storage directory.".into()); }
        } else { std::fs::create_dir(&self.root).map_err(|_| "Cannot create extension storage.")?; }
        Ok(())
    }
    fn record(&self, path: &Path) -> Result<(Record, Package)> {
        let record: Record = serde_json::from_slice(&read_bounded(path, MAX_RECORD)?).map_err(|_| "Corrupt extension record.")?;
        let bytes = STANDARD.decode(&record.archive).map_err(|_| "Corrupt extension archive.")?;
        if record.schema != 1 || format!("{:x}", Sha256::digest(&bytes)) != record.checksum { return Err("Extension checksum mismatch.".into()); }
        let mut package = validate(&bytes)?;
        if path.file_stem().and_then(|p| p.to_str()) != package.manifest["id"].as_str() { return Err("Extension record ownership mismatch.".into()); }
        package.enabled = record.enabled;
        Ok((record, package))
    }
    fn snapshot(&self) -> Snapshot {
        let mut result = Snapshot { safe_mode: self.safe, packages: vec![], diagnostics: vec![] };
        // This return is BEFORE ANY storage operation, including enumeration and deserialization.
        if self.safe || !self.root.exists() { return result; }
        if let Err(error) = self.directory() { result.diagnostics.push(error); return result; }
        match std::fs::read_dir(&self.root) {
            Ok(entries) => {
                let paths: Vec<_> = entries.take(MAX_PACKAGES + 1).filter_map(|e| e.ok().map(|e| e.path())).collect();
                if paths.len() > MAX_PACKAGES { result.diagnostics.push("Installed package limit exceeded; activation bypassed.".into()); return result; }
                for path in paths { match self.record(&path) {
                    Ok((_, package)) => {
                        for menu in package.manifest["contributes"]["menus"].as_array().into_iter().flatten() {
                            if menu["icon"].as_str().is_none() {
                                result.diagnostics.push(format!("{}: missing icon; using a safe fallback host icon.", menu["id"].as_str().unwrap_or("Action")));
                            }
                        }
                        result.packages.push(package);
                    },
                    Err(error) => {
                        result.diagnostics.push(error.clone());
                        // A failed record remains manageable without trusting its contents.
                        if path.extension().and_then(|s| s.to_str()) == Some("json") {
                            if let Some(id) = path.file_stem().and_then(|s| s.to_str()).filter(|id| safe_name(id)) {
                                result.packages.push(Package { manifest: json!({"id": id, "version": "unknown", "contributes": {}}), icons: BTreeMap::new(), enabled: false, reason: Some(error) });
                            }
                        }
                    }
                } }
            },
            Err(_) => result.diagnostics.push("Cannot enumerate extension storage.".into()),
        }
        result.packages.sort_by(|a, b| a.manifest["id"].as_str().cmp(&b.manifest["id"].as_str()));
        result
    }
    fn write(&self, path: &Path, record: &Record) -> Result<()> {
        let stage = self.root.join(format!("{}.stage", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = std::fs::OpenOptions::new().create_new(true).write(true).open(&stage).map_err(|_| "Cannot stage extension.")?;
            file.write_all(&serde_json::to_vec(record).map_err(|_| "Cannot serialize extension.")?).map_err(|_| "Cannot write extension.")?;
            file.sync_all().map_err(|_| "Cannot flush extension.")?;
            std::fs::rename(&stage, path).map_err(|_| "Cannot promote extension.")
        })();
        if result.is_err() { let _ = std::fs::remove_file(stage); }
        Ok(result?)
    }
    fn install(&self, bytes: &[u8]) -> Result<()> {
        if self.safe { return Err("Safe mode: package loading is bypassed.".into()); }
        let package = validate(bytes)?;
        self.directory()?;
        let path = self.root.join(format!("{}.json", package.manifest["id"].as_str().unwrap()));
        if path.symlink_metadata().is_ok() { return Err("Duplicate package ownership; already installed.".into()); }
        if std::fs::read_dir(&self.root).map_err(|_| "Cannot inspect extension storage.")?.count() >= MAX_PACKAGES { return Err("Installed package limit exceeded.".into()); }
        self.write(&path, &Record { schema: 1, archive: STANDARD.encode(bytes), checksum: format!("{:x}", Sha256::digest(bytes)), enabled: false })
    }
    fn enable(&self, id: &str, enabled: bool) -> Result<()> {
        if self.safe { return Err("Safe mode: activation is bypassed.".into()); }
        if !safe_name(id) || id.contains('/') { return Err("Invalid extension identity.".into()); }
        self.directory()?;
        let path = self.root.join(format!("{id}.json"));
        let (mut record, package) = self.record(&path)?;
        if enabled {
            let mut manifests: Vec<Value> = self.snapshot().packages.into_iter().filter(|p| p.enabled && p.manifest["id"] != id).map(|p| p.manifest).collect();
            manifests.push(package.manifest);
            let checked = super::contracts::validate_contract("packages", &json!(manifests));
            if checked["ok"] != true { return Err(format!("Activation rejected: {}", checked["error"]["code"])); }
        }
        record.enabled = enabled; self.write(&path, &record)
    }
    fn uninstall(&self, id: &str) -> Result<()> {
        if self.safe { return Err("Safe mode: package changes are bypassed.".into()); }
        if !safe_name(id) || id.contains('/') { return Err("Invalid extension identity.".into()); }
        self.directory()?;
        let path = self.root.join(format!("{id}.json"));
        regular(&path)?;
        // Only this installation record. Core storage and extension data are separate.
        std::fs::remove_file(path).map_err(|_| "Cannot uninstall extension.".into())
    }
}

#[tauri::command]
pub fn extensions_snapshot(state: tauri::State<'_, ExtensionPackages>) -> Result<Snapshot> { Ok(state.0.lock().map_err(|_| "Extension manager unavailable.")?.snapshot()) }
#[tauri::command]
pub fn extensions_install(state: tauri::State<'_, ExtensionPackages>, path: String) -> Result<Snapshot> {
    let state = state.0.lock().map_err(|_| "Extension manager unavailable.")?;
    if state.safe { return Err("Safe mode: package loading is bypassed.".into()); }
    state.install(&read_bounded(Path::new(&path), MAX_ARCHIVE)?)?; Ok(state.snapshot())
}
#[tauri::command]
pub fn extensions_enable(state: tauri::State<'_, ExtensionPackages>, id: String, enabled: bool) -> Result<Snapshot> {
    let state = state.0.lock().map_err(|_| "Extension manager unavailable.")?; state.enable(&id, enabled)?; Ok(state.snapshot())
}
#[tauri::command]
pub fn extensions_uninstall(state: tauri::State<'_, ExtensionPackages>, id: String) -> Result<Snapshot> {
    let state = state.0.lock().map_err(|_| "Extension manager unavailable.")?; state.uninstall(&id)?; Ok(state.snapshot())
}
#[tauri::command]
pub fn extensions_safe_mode(state: tauri::State<'_, ExtensionPackages>) -> Result<Snapshot> {
    let mut state = state.0.lock().map_err(|_| "Extension manager unavailable.")?; state.safe = true; Ok(state.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/sample-project-helper/extension.json");
    const SVG: &str = include_str!("../../../tests/fixtures/extensions/sample-project-helper/assets/info.svg");
    struct Storage(PathBuf);
    impl Storage {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("pandacode-extension-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap(); Self(path)
        }
        fn packages(&self, safe: bool) -> Packages { Packages { root: self.0.join("extensions-v1"), safe } }
    }
    impl Drop for Storage { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in files { writer.start_file(*name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).unwrap(); writer.write_all(bytes).unwrap(); }
        writer.finish().unwrap().into_inner()
    }
    fn sample() -> Vec<u8> { archive(&[("extension.json", MANIFEST.as_bytes()), ("assets/info.svg", SVG.as_bytes())]) }
    #[test]
    fn ordinary_zip_directory_entries_work_without_extraction() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer.add_directory("assets/", zip::write::SimpleFileOptions::default()).unwrap();
        for (name, bytes) in [("extension.json", MANIFEST.as_bytes()), ("assets/info.svg", SVG.as_bytes())] {
            writer.start_file(name, zip::write::SimpleFileOptions::default()).unwrap(); writer.write_all(bytes).unwrap();
        }
        let storage = Storage::new(); storage.packages(false).install(&writer.finish().unwrap().into_inner()).unwrap();
        assert!(!storage.0.join("assets").exists());
        assert_eq!(std::fs::read_dir(storage.0.join("extensions-v1")).unwrap().count(), 1);
    }
    fn rejected(bytes: &[u8]) -> String {
        let storage = Storage::new(); let packages = storage.packages(false);
        let error = packages.install(bytes).expect_err("malicious package must fail");
        assert!(!packages.root.exists(), "validation must precede any storage write");
        assert_eq!(std::fs::read_dir(&storage.0).unwrap().count(), 0, "no outside/staging writes");
        error
    }
    #[test]
    fn install_enable_restart_disable_and_corruption_recovery() {
        let storage = Storage::new(); let packages = storage.packages(false);
        assert!(packages.snapshot().packages.is_empty());
        packages.install(&sample()).unwrap();
        assert!(!packages.snapshot().packages[0].enabled);
        assert!(packages.install(&sample()).unwrap_err().contains("Duplicate"));
        assert_eq!(std::fs::read_dir(&packages.root).unwrap().count(), 1);
        packages.enable("sample.project-helper", true).unwrap();
        assert!(storage.packages(false).snapshot().packages[0].enabled);
        packages.enable("sample.project-helper", false).unwrap();
        assert!(!storage.packages(false).snapshot().packages[0].enabled);
        let path = packages.root.join("sample.project-helper.json");
        let (mut record, _) = packages.record(&path).unwrap(); record.checksum = "corrupted".into();
        packages.write(&path, &record).unwrap();
        let recovered = packages.snapshot(); assert!(!recovered.packages[0].enabled); assert!(recovered.packages[0].reason.is_some()); assert_eq!(recovered.diagnostics, ["Extension checksum mismatch."]);
        assert!(packages.enable("sample.project-helper", true).is_err());
        assert!(std::fs::read_dir(&packages.root).unwrap().all(|entry| !entry.unwrap().path().to_string_lossy().ends_with(".stage")));
    }
    #[test]
    fn safe_mode_returns_before_loading_or_touching_storage() {
        let storage = Storage::new(); let packages = storage.packages(true);
        // An invalid directory target proves even metadata/enumeration/creation is skipped.
        std::fs::write(&packages.root, b"not a directory").unwrap();
        let snapshot = packages.snapshot(); assert!(snapshot.safe_mode); assert!(snapshot.packages.is_empty()); assert!(snapshot.diagnostics.is_empty());
        assert!(packages.install(&sample()).is_err()); assert!(packages.enable("sample.project-helper", true).is_err());
        assert_eq!(std::fs::read(&packages.root).unwrap(), b"not a directory");
    }
    #[test]
    fn uninstall_is_owner_scoped_preserves_data_and_can_remove_a_failed_record() {
        let storage = Storage::new(); let packages = storage.packages(false);
        packages.install(&sample()).unwrap(); packages.enable("sample.project-helper", true).unwrap();
        let other = MANIFEST.replace("sample.project-helper", "other.project-helper");
        packages.install(&archive(&[("extension.json", other.as_bytes()), ("assets/info.svg", SVG.as_bytes())])).unwrap();
        packages.enable("other.project-helper", true).unwrap();
        // Synthetic core/data sentinels; manager has no handle to the app database.
        for name in ["projects", "drafts", "history", "extension-data"] { std::fs::write(storage.0.join(name), b"retain exactly").unwrap(); }
        packages.uninstall("sample.project-helper").unwrap();
        let restarted = storage.packages(false).snapshot();
        assert_eq!(restarted.packages.len(), 1); assert_eq!(restarted.packages[0].manifest["id"], "other.project-helper"); assert!(restarted.packages[0].enabled);
        for name in ["projects", "drafts", "history", "extension-data"] { assert_eq!(std::fs::read(storage.0.join(name)).unwrap(), b"retain exactly"); }
        packages.install(&sample()).unwrap(); assert!(!packages.snapshot().packages.iter().find(|p| p.manifest["id"] == "sample.project-helper").unwrap().enabled);
        std::fs::write(packages.root.join("sample.project-helper.json"), b"{broken").unwrap();
        assert!(packages.snapshot().packages.iter().any(|p| p.reason.is_some()));
        assert!(packages.enable("sample.project-helper", true).is_err());
        assert!(packages.uninstall("../drafts").is_err());
        packages.uninstall("sample.project-helper").unwrap();
        assert_eq!(packages.snapshot().packages.len(), 1);
    }
    #[test]
    fn missing_optional_icon_has_a_diagnostic_and_retry_revalidates_repaired_storage() {
        let storage = Storage::new(); let packages = storage.packages(false);
        let mut manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        for menu in manifest["contributes"]["menus"].as_array_mut().unwrap() { menu.as_object_mut().unwrap().remove("icon"); }
        packages.install(&archive(&[("extension.json", &serde_json::to_vec(&manifest).unwrap()), ("assets/info.svg", SVG.as_bytes())])).unwrap();
        packages.enable("sample.project-helper", true).unwrap();
        let snapshot = packages.snapshot(); assert_eq!(snapshot.diagnostics.len(), 2); assert!(snapshot.diagnostics.iter().all(|d| d.contains("safe fallback"))); assert!(snapshot.packages[0].enabled);
        let path = packages.root.join("sample.project-helper.json"); let original = std::fs::read(&path).unwrap();
        std::fs::write(&path, b"{broken").unwrap(); assert!(packages.enable("sample.project-helper", true).is_err());
        std::fs::write(&path, original).unwrap(); packages.enable("sample.project-helper", true).unwrap();
        assert!(packages.snapshot().packages[0].reason.is_none());
    }
    #[test]
    fn rejects_traversal_absolute_windows_names_and_duplicate_entries() {
        for name in ["../escape", "/absolute", "C:/outside", "C:\\outside", "assets/../../escape", "assets//info.svg", "assets/./info.svg"] {
            assert!(rejected(&archive(&[("extension.json", MANIFEST.as_bytes()), (name, b"bad")])).contains("Unsafe"), "{name}");
        }
        assert!(rejected(&archive(&[("extension.json", MANIFEST.as_bytes()), ("EXTENSION.JSON", MANIFEST.as_bytes())])).contains("Duplicate"));
    }
    #[test]
    fn rejects_symlinks_and_expansion_file_count_and_raw_limits() {
        let complete = sample();
        assert!(rejected(&complete[..complete.len() / 2]).contains("Invalid extension ZIP"));
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer.add_symlink("assets/info.svg", "../../outside", zip::write::SimpleFileOptions::default()).unwrap();
        assert!(rejected(&writer.finish().unwrap().into_inner()).contains("Unsafe"));
        assert!(rejected(&vec![0; MAX_ARCHIVE as usize + 1]).contains("size"));
        let names: Vec<String> = (0..=MAX_FILES).map(|i| format!("file{i}")).collect();
        let entries: Vec<_> = names.iter().map(|name| (name.as_str(), b"".as_slice())).collect();
        assert!(rejected(&archive(&entries)).contains("file-count"));
        assert!(rejected(&archive(&[("large", &vec![0; MAX_FILE as usize + 1])])).contains("file limit"));
        let data = vec![0; MAX_FILE as usize];
        assert!(rejected(&archive(&[("a", &data), ("b", &data), ("c", &data), ("d", &data), ("e", &data)])).contains("expansion"));
    }
    #[test]
    fn rejects_malformed_or_active_svg_and_undeclared_executables() {
        for svg in ["<svg>", "<svg><path></svg>", "<svg/><svg/>", "<svg><script/></svg>", "<!DOCTYPE svg><svg/>", "<svg onload=\"alert(1)\"/>", "<svg><image href=\"https://example.com/icon\"/></svg>", "<svg><path fill=\"url(https://example.com)\"/></svg>", "<svg xmlns=\"https://evil.invalid\"/>", "<svg>&external;</svg>", "<svg style=\"color:red\"/>"] {
            rejected(&archive(&[("extension.json", MANIFEST.as_bytes()), ("assets/info.svg", svg.as_bytes())]));
        }
        rejected(&archive(&[("extension.json", MANIFEST.as_bytes()), ("assets/info.svg", SVG.as_bytes()), ("install.js", b"throw new Error('never execute')")]));
        let mut manifest: Value = serde_json::from_str(MANIFEST).unwrap(); manifest["scripts"] = json!({"install": "do not execute"});
        assert!(rejected(&archive(&[("extension.json", &serde_json::to_vec(&manifest).unwrap())])).contains("UnsupportedRuntime"));
        rejected(&archive(&[("extension.json", b"{broken")]));
    }
    #[test]
    fn rejects_duplicate_contribution_ownership_missing_icons_and_untrusted_record_paths() {
        let mut manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let command = manifest["contributes"]["commands"][0].clone(); manifest["contributes"]["commands"].as_array_mut().unwrap().push(command);
        assert!(rejected(&archive(&[("extension.json", &serde_json::to_vec(&manifest).unwrap())])).contains("DuplicateId"));
        assert!(rejected(&archive(&[("extension.json", MANIFEST.as_bytes())])).contains("Missing declared icon"));
        let storage = Storage::new(); let packages = storage.packages(false); packages.install(&sample()).unwrap();
        assert!(packages.enable("../outside", true).is_err());
        let original = packages.root.join("sample.project-helper.json");
        std::fs::copy(&original, packages.root.join("forged.owner.json")).unwrap();
        let snapshot = packages.snapshot(); assert_eq!(snapshot.packages.iter().filter(|p| p.reason.is_none()).count(), 1); assert_eq!(snapshot.diagnostics, ["Extension record ownership mismatch."]);
        assert_eq!(std::fs::read_dir(&storage.0).unwrap().count(), 1);
    }
}
