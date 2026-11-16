//! Code folders, the service environment and the package data directory (runtime phase R1, slice R0105).
//!
//! - **Code folders (`runtime.files`).** Up to eight archive folders whose files of any type belong to the package
//!   code. Before a service starts, the host writes the entry point and those folders to
//!   `<app data>/extension-code-v1/<package id>/<archive checksum>/` and runs the service there, so relative
//!   `require`, `import()`, worker threads and WebAssembly resolve. The directory is verified against the stored
//!   archive on every start (a changed or extra file rebuilds it), replaced when the checksum changes (update,
//!   rollback) and removed on uninstall. Nothing is downloaded and no install script runs.
//! - **Service environment.** A service inherits the user's environment (the app's PATH is already widened to the
//!   installed-tool locations at startup), except `NODE_OPTIONS` (stability: the pinned runtime's flags are the
//!   host's) and the host's own `PANDACODE_*` variables (ADR-0006: nothing the host holds is handed over).
//! - **Data directory (`panda.storage.directory`, under `storage.private`).** `<app data>/extension-data-v1/<package
//!   id>/global` or `.../project-<sha256 of the project id>`. Kept across disable, update and uninstall; removed by
//!   "remove own data". Service only; `scope: 'project'` needs the call's project context and answers
//!   `StaleContext` without one.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, ffi::OsString, path::{Path, PathBuf}};

/// The permission `storage.directory` needs (the package's private storage).
pub const STORAGE_PERMISSION: &str = "storage.private";
/// At most this many code folders (`runtime.files`).
pub const MAX_FOLDERS: usize = 8;
const CODE: &str = "extension-code-v1";
const DATA: &str = "extension-data-v1";
type Failure = &'static str;
/// The code of one generation: archive names (the entry point and the code-folder files) and their bytes.
pub type CodeFiles = Vec<(String, Vec<u8>)>;

/// `^[a-z0-9][a-z0-9_-]*$`, at most 64 characters (the schema's `runtime.files` item).
pub fn valid_folder(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().next().is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && name.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-')
}
/// The declared code folders of a manifest (only well-formed names; the validator refuses the rest).
pub fn folders(manifest: &Value) -> Vec<&str> {
    manifest["runtime"]["files"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|name| valid_folder(name)).take(MAX_FOLDERS).collect()
}
/// `true` when the archive file `name` lies inside a declared code folder (exact, case-sensitive prefix).
pub fn in_code_folder(manifest: &Value, name: &str) -> bool {
    name.split_once('/').is_some_and(|(folder, rest)| !rest.is_empty() && folders(manifest).contains(&folder))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 160 && !id.contains("..") && !id.starts_with('.') && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}
fn valid_checksum(checksum: &str) -> bool { checksum.len() == 64 && checksum.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) }
/// Creates `path` as a real directory, or accepts it when it already is one (never a link).
fn directory(path: &Path) -> Result<(), Failure> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Ok(()),
        Ok(_) => Err("StorageUnavailable"),
        Err(_) => std::fs::create_dir(path).or_else(|_| if path.is_dir() { Ok(()) } else { Err("StorageUnavailable") }),
    }
}
/// The relative files under `root`, or `None` when anything is not a regular file or directory.
fn listing(root: &Path) -> Option<BTreeMap<String, PathBuf>> {
    let mut found = BTreeMap::new();
    let mut pending = vec![(root.to_path_buf(), String::new())];
    while let Some((path, prefix)) = pending.pop() {
        for entry in std::fs::read_dir(&path).ok()? {
            let entry = entry.ok()?;
            let meta = std::fs::symlink_metadata(entry.path()).ok()?;
            let name = format!("{prefix}{}", entry.file_name().to_str()?);
            if meta.file_type().is_symlink() { return None; }
            if meta.is_dir() { pending.push((entry.path(), format!("{name}/"))); } else if meta.is_file() { found.insert(name, entry.path()); } else { return None; }
        }
    }
    Some(found)
}
/// `true` when `root` holds exactly `files`, byte for byte.
fn matches(root: &Path, files: &[(String, Vec<u8>)]) -> bool {
    let Some(found) = listing(root) else { return false };
    found.len() == files.len() && files.iter().all(|(name, bytes)| found.get(name).is_some_and(|path| std::fs::read(path).is_ok_and(|content| content == *bytes)))
}
fn write_tree(root: &Path, files: &[(String, Vec<u8>)]) -> Result<(), Failure> {
    std::fs::create_dir(root).map_err(|_| "StorageUnavailable")?;
    for (name, bytes) in files {
        let path = name.split('/').fold(root.to_path_buf(), |path, part| path.join(part));
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|_| "StorageUnavailable")?; }
        std::fs::write(&path, bytes).map_err(|_| "StorageUnavailable")?;
    }
    Ok(())
}
fn remove_entry(path: &Path) {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => { let _ = std::fs::remove_dir_all(path); }
        Ok(meta) if meta.file_type().is_symlink() => { let _ = std::fs::remove_file(path).or_else(|_| std::fs::remove_dir(path)); }
        Ok(_) => { let _ = std::fs::remove_file(path); }
        Err(_) => {}
    }
}

/// The checksum-qualified code directory of a package (whether or not it exists yet).
pub fn code_directory(app_data: &Path, id: &str, checksum: &str) -> PathBuf { app_data.join(CODE).join(id).join(checksum) }

/// Writes (or verifies and reuses) the code directory of `id` at `checksum` with `files` (the entry point and the
/// code folders, from `Packages::code_files`) and removes every other generation of the package. A directory still
/// in use (a process of the previous generation that has not ended yet) is left for the next start.
pub fn materialize(app_data: &Path, id: &str, checksum: &str, files: &[(String, Vec<u8>)]) -> Result<PathBuf, Failure> {
    if !valid_id(id) || !valid_checksum(checksum) || !files.iter().any(|(name, _)| name == "main.cjs") { return Err("PermissionDenied"); }
    let target = code_directory(app_data, id, checksum);
    let package = app_data.join(CODE).join(id);
    directory(&app_data.join(CODE))?; directory(&package)?;
    if !matches(&target, files) {
        remove_entry(&target);
        let stage = package.join(format!("{checksum}.stage-{}", uuid::Uuid::new_v4()));
        let written = write_tree(&stage, files).and_then(|()| std::fs::rename(&stage, &target).map_err(|_| "StorageUnavailable"));
        if written.is_err() { remove_entry(&stage); }
        written?;
    }
    for entry in std::fs::read_dir(&package).map_err(|_| "StorageUnavailable")?.filter_map(Result::ok) {
        if entry.file_name().to_str() != Some(checksum) { remove_entry(&entry.path()); }
    }
    Ok(target)
}
/// Removes every extracted generation of `id` (uninstall). Best effort: a directory a running process still uses is
/// removed when its service has stopped.
pub fn remove_code(app_data: &Path, id: &str) {
    if valid_id(id) { remove_entry(&app_data.join(CODE).join(id)); }
}

/// The environment of a background service: the user's (`parent`), without `NODE_OPTIONS` and the host's own
/// `PANDACODE_*` variables. Names compare without case, as Windows does.
pub fn service_environment(parent: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<(OsString, OsString)> {
    parent.into_iter().filter(|(name, _)| {
        let name = name.to_string_lossy().to_ascii_uppercase();
        name != "NODE_OPTIONS" && !name.starts_with("PANDACODE_")
    }).collect()
}
/// Gives `command` exactly the service environment of `parent` (then the AppImage clean-up of every external spawn).
pub fn apply_service_environment(command: &mut tokio::process::Command, parent: impl IntoIterator<Item = (OsString, OsString)>) {
    command.env_clear();
    for (name, value) in service_environment(parent) { command.env(name, value); }
    crate::child_env::sanitize(command);
}

/// The data directory of `id` for `scope`, created when missing. `project` is the project of the call's context.
pub fn data_directory(app_data: &Path, id: &str, scope: &str, project: Option<&str>) -> Result<PathBuf, Failure> {
    if !valid_id(id) { return Err("PermissionDenied"); }
    let leaf = match scope {
        "global" => "global".to_owned(),
        "project" => format!("project-{:x}", Sha256::digest(project.filter(|id| !id.is_empty() && id.len() <= 256).ok_or("StaleContext")?.as_bytes())),
        _ => return Err("InvalidShape"),
    };
    let package = app_data.join(DATA).join(id);
    directory(&app_data.join(DATA))?; directory(&package)?;
    let path = package.join(leaf);
    directory(&path)?;
    Ok(path)
}
/// The reply to a service's `storageDirectory` request (`panda.storage.directory({ scope })`). `granted` is the
/// package's live `storage.private` grant; `project` the project of the call's context (none for a service until
/// the duplex channel brings call contexts).
pub fn storage_directory_reply(app_data: &Path, id: &str, params: &Value, granted: bool, project: Option<&str>) -> Value {
    if !granted { return super::super::context::failure("PermissionDenied"); }
    let Some(scope) = params.as_object().filter(|options| options.len() == 1).and_then(|options| options.get("scope")).and_then(Value::as_str) else { return super::super::context::failure("InvalidShape") };
    match data_directory(app_data, id, scope, project) {
        Ok(path) => json!({"ok": true, "value": {"schemaVersion": 1, "path": path.to_string_lossy()}}),
        Err(code) => super::super::context::failure(code),
    }
}
/// "Remove own data": the whole data directory of `id`, every scope. A substituted link is refused, never followed.
pub fn remove_data(app_data: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) { return Err("PermissionDenied".into()); }
    let path = app_data.join(DATA).join(id);
    match std::fs::symlink_metadata(&path) {
        Err(_) => Ok(()),
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => std::fs::remove_dir_all(&path).map_err(|_| "StorageUnavailable".into()),
        Ok(_) => Err("StorageUnavailable".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::tests::{archive, Storage};
    use std::{io::Write, time::Instant};

    pub(crate) const ID: &str = "sample.code-folders";
    fn fixture_dir() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/extensions/runtime-code-folders") }
    /// The fixture package as archive entries (every file under the fixture folder), with `edit` applied.
    pub(crate) fn fixture_files(edit: impl Fn(&str, Vec<u8>) -> Vec<u8>) -> Vec<(String, Vec<u8>)> {
        let root = fixture_dir();
        listing(&root).unwrap().into_iter().map(|(name, path)| { let bytes = edit(&name, std::fs::read(path).unwrap()); (name, bytes) }).collect()
    }
    pub(crate) fn fixture_archive(edit: impl Fn(&str, Vec<u8>) -> Vec<u8>) -> Vec<u8> {
        let files = fixture_files(edit);
        archive(&files.iter().map(|(name, bytes)| (name.as_str(), bytes.as_slice())).collect::<Vec<_>>())
    }
    fn manifest() -> Value { serde_json::from_slice(&std::fs::read(fixture_dir().join("extension.json")).unwrap()).unwrap() }
    fn without_files(name: &str, bytes: Vec<u8>) -> Vec<u8> {
        if name != "extension.json" { return bytes; }
        let mut manifest: Value = serde_json::from_slice(&bytes).unwrap();
        manifest["runtime"].as_object_mut().unwrap().remove("files");
        serde_json::to_vec(&manifest).unwrap()
    }

    #[test]
    fn code_folder_names_and_membership_follow_the_declared_folders() {
        for name in ["lib", "wasm", "node_modules", "a", "0-x_y"] { assert!(valid_folder(name), "{name}"); }
        for name in ["", "Lib", "-lib", "_lib", "lib/x", "lib.x", "..", &"a".repeat(65)] { assert!(!valid_folder(name), "{name}"); }
        let manifest = manifest();
        assert_eq!(folders(&manifest), ["lib", "wasm"]);
        assert!(in_code_folder(&manifest, "lib/helper.cjs") && in_code_folder(&manifest, "lib/nested/deep.mjs") && in_code_folder(&manifest, "wasm/add.wasm"));
        for name in ["lib", "lib/", "LIB/helper.cjs", "library/x.cjs", "other/x.cjs", "main.cjs", "extension.json"] { assert!(!in_code_folder(&manifest, name), "{name}"); }
    }

    /// Q045 (R0105): files inside a declared code folder are package code of any type; a file outside every declared
    /// folder stays "Undeclared package file" (retained, predictability: the archive is exactly what the manifest
    /// declares, so the reviewed content is what runs), and an invalid folder name is refused by the schema.
    #[test]
    fn archives_carry_declared_code_folders_and_still_refuse_undeclared_files() {
        let disk = Storage::new(); let packages = disk.packages(false);
        packages.install(&fixture_archive(|_, bytes| bytes)).unwrap();
        packages.uninstall(ID).unwrap();
        let error = packages.install(&fixture_archive(without_files)).unwrap_err();
        assert!(error.starts_with("Undeclared package file"), "{error}");
        let mut files = fixture_files(|_, bytes| bytes); files.push(("other/x.cjs".into(), b"module.exports = 1;".to_vec()));
        let error = packages.install(&archive(&files.iter().map(|(name, bytes)| (name.as_str(), bytes.as_slice())).collect::<Vec<_>>())).unwrap_err();
        assert!(error.starts_with("Undeclared package file"), "{error}");
        let error = packages.install(&fixture_archive(|name, bytes| if name == "extension.json" { String::from_utf8(bytes).unwrap().replace("\"wasm\"", "\"Wasm\"").into_bytes() } else { bytes })).unwrap_err();
        assert!(error.starts_with("Invalid manifest"), "{error}");
        let error = packages.install(&fixture_archive(|name, bytes| if name == "extension.json" { String::from_utf8(bytes).unwrap().replace("[\"lib\", \"wasm\"]", "[\"a\",\"b\",\"c\",\"d\",\"e\",\"f\",\"g\",\"h\",\"lib\",\"wasm\"]").into_bytes() } else { bytes })).unwrap_err();
        assert!(error.starts_with("Invalid manifest"), "nine or more folders: {error}");
        // The code of an enabled, trusted package: the entry point and its folders, never the manifest.
        packages.install(&fixture_archive(|_, bytes| bytes)).unwrap();
        assert_eq!(packages.code_files(ID).unwrap_err(), "PermissionDenied");
        let digest = packages.snapshot().packages[0].executable.as_ref().unwrap().digest.clone();
        packages.trust(ID, &digest, true).unwrap(); packages.enable(ID, true).unwrap();
        let (checksum, code) = packages.code_files(ID).unwrap();
        assert_eq!(checksum, digest);
        let names: Vec<&str> = code.iter().map(|(name, _)| name.as_str()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        assert_eq!(names, ["lib/esm.mjs", "lib/helper.cjs", "lib/shared.mjs", "lib/worker.cjs", "main.cjs", "wasm/add.wasm"]);
    }

    #[test]
    fn the_code_directory_is_checksum_qualified_verified_replaced_and_removed() {
        let disk = Storage::new();
        let (a, b) = ("a".repeat(64), "b".repeat(64));
        let files = fixture_files(|_, bytes| bytes).into_iter().filter(|(name, _)| name != "extension.json").collect::<Vec<_>>();
        let first = materialize(&disk.0, ID, &a, &files).unwrap();
        assert_eq!(first, disk.0.join("extension-code-v1").join(ID).join(&a));
        assert!(matches(&first, &files) && first.join("wasm").join("add.wasm").is_file());
        // A changed or an extra file is rebuilt from the archive; an intact directory is reused as is.
        std::fs::write(first.join("lib").join("helper.cjs"), b"exports.generation = 666;").unwrap();
        std::fs::write(first.join("planted.cjs"), b"").unwrap();
        assert_eq!(materialize(&disk.0, ID, &a, &files).unwrap(), first);
        assert!(matches(&first, &files) && !first.join("planted.cjs").exists());
        let modified = std::fs::metadata(first.join("main.cjs")).unwrap().modified().unwrap();
        materialize(&disk.0, ID, &a, &files).unwrap();
        assert_eq!(std::fs::metadata(first.join("main.cjs")).unwrap().modified().unwrap(), modified, "an intact directory is not rewritten");
        // A new checksum is a new generation; the old one is removed.
        let second = materialize(&disk.0, ID, &b, &files).unwrap();
        assert!(second.is_dir() && !first.exists());
        assert_eq!(std::fs::read_dir(disk.0.join("extension-code-v1").join(ID)).unwrap().count(), 1);
        // Refusals: no entry point, a malformed checksum or identity.
        assert_eq!(materialize(&disk.0, ID, &a, &files[1..].iter().filter(|(name, _)| name != "main.cjs").cloned().collect::<Vec<_>>()).unwrap_err(), "PermissionDenied");
        assert_eq!(materialize(&disk.0, ID, "../x", &files).unwrap_err(), "PermissionDenied");
        assert_eq!(materialize(&disk.0, "../history", &a, &files).unwrap_err(), "PermissionDenied");
        remove_code(&disk.0, ID);
        assert!(!disk.0.join("extension-code-v1").join(ID).exists());
    }

    #[test]
    fn uninstall_removes_code_and_keeps_own_data_until_remove_own_data() {
        let disk = Storage::new(); let packages = disk.packages(false);
        packages.install(&fixture_archive(|_, bytes| bytes)).unwrap();
        let digest = packages.snapshot().packages[0].executable.as_ref().unwrap().digest.clone();
        packages.trust(ID, &digest, true).unwrap(); packages.enable(ID, true).unwrap();
        let (checksum, files) = packages.code_files(ID).unwrap();
        let code = materialize(&packages.app_data(), ID, &checksum, &files).unwrap();
        let data = data_directory(&packages.app_data(), ID, "global", None).unwrap();
        std::fs::write(data.join("probe.json"), b"{}").unwrap();
        assert_eq!(data, disk.0.join("extension-data-v1").join(ID).join("global"));
        packages.enable(ID, false).unwrap();
        assert!(code.is_dir() && data.join("probe.json").is_file(), "disable keeps code and data");
        packages.uninstall(ID).unwrap();
        assert!(!disk.0.join("extension-code-v1").join(ID).exists(), "uninstall removes the code");
        assert!(data.join("probe.json").is_file(), "uninstall keeps own data");
        packages.storage_remove_own_data(ID).unwrap();
        assert!(!disk.0.join("extension-data-v1").join(ID).exists(), "remove own data removes the data directory");
    }

    /// The service environment: the user's (PATH and every other variable), without NODE_OPTIONS or the host's own
    /// `PANDACODE_*` variables (ADR-0006).
    #[test]
    fn the_service_environment_is_the_users_without_node_options_or_host_variables() {
        let parent = [("Path", "C:\\tools;C:\\bin"), ("HOME", "/home/me"), ("node_options", "--title=x"), ("NODE_OPTIONS", "--require=evil"), ("PANDACODE_SECRETS_FILE", "1"), ("PandaCode_Token", "canary"), ("GH_PAGER", "cat")];
        let kept: Vec<(String, String)> = service_environment(parent.iter().map(|(name, value)| (OsString::from(name), OsString::from(value))))
            .into_iter().map(|(name, value)| (name.into_string().unwrap(), value.into_string().unwrap())).collect();
        assert_eq!(kept, [("Path".to_owned(), "C:\\tools;C:\\bin".to_owned()), ("HOME".into(), "/home/me".into()), ("GH_PAGER".into(), "cat".into())]);
    }

    /// `panda.storage.directory`: global and project folders, `StaleContext` without a project, the live grant, and
    /// Q036 (R0105 part): the data directory is not capped, unlike the bounded key-value record (retained,
    /// stability: that record is one JSON file rewritten atomically).
    #[test]
    fn storage_directory_answers_global_and_project_folders_and_stale_context_without_a_project() {
        let disk = Storage::new();
        let reply = storage_directory_reply(&disk.0, ID, &json!({"scope": "global"}), true, None);
        assert_eq!(reply["ok"], true); assert_eq!(reply["value"]["schemaVersion"], 1);
        let global = PathBuf::from(reply["value"]["path"].as_str().unwrap());
        assert_eq!(global, disk.0.join("extension-data-v1").join(ID).join("global")); assert!(global.is_dir());
        std::fs::write(global.join("large.bin"), vec![7u8; 1024 * 1024]).unwrap();
        assert_eq!(storage_directory_reply(&disk.0, ID, &json!({"scope": "project"}), true, None)["error"]["code"], "StaleContext");
        let project = storage_directory_reply(&disk.0, ID, &json!({"scope": "project"}), true, Some("project-1"));
        assert_eq!(PathBuf::from(project["value"]["path"].as_str().unwrap()), disk.0.join("extension-data-v1").join(ID).join(format!("project-{:x}", Sha256::digest(b"project-1"))));
        assert_eq!(storage_directory_reply(&disk.0, ID, &json!({"scope": "global"}), false, None)["error"]["code"], "PermissionDenied");
        for params in [json!({"scope": "other"}), json!({}), json!(null), json!({"scope": "global", "path": "/etc"})] {
            assert_eq!(storage_directory_reply(&disk.0, ID, &params, true, None)["error"]["code"], "InvalidShape", "{params}");
        }
        assert_eq!(storage_directory_reply(&disk.0, "../history", &json!({"scope": "global"}), true, None)["error"]["code"], "PermissionDenied");
        remove_data(&disk.0, ID).unwrap();
        assert!(!disk.0.join("extension-data-v1").join(ID).exists());
        remove_data(&disk.0, ID).unwrap();
    }

    /// Deterministic incompressible bytes (no random-number dependency).
    fn noise(length: usize, seed: u64) -> Vec<u8> {
        let mut state = seed | 1;
        (0..length).map(|_| { state ^= state << 13; state ^= state >> 7; state ^= state << 17; state as u8 }).collect()
    }
    /// A stored (uncompressed) archive of the fixture plus `blobs` incompressible files in `lib/`.
    fn heavy_archive(version: &str, blobs: &[usize], seed: u64) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in fixture_files(|name, bytes| if name == "extension.json" { String::from_utf8(bytes).unwrap().replace("\"1.0.0\"", &format!("\"{version}\"")).into_bytes() } else { bytes }) {
            writer.start_file(name, stored).unwrap(); writer.write_all(&bytes).unwrap();
        }
        for (index, length) in blobs.iter().enumerate() { writer.start_file(format!("lib/blob-{index}.bin"), stored).unwrap(); writer.write_all(&noise(*length, seed + index as u64)).unwrap(); }
        writer.finish().unwrap().into_inner()
    }
    fn timed<T>(what: &str, timings: &mut Vec<(String, u128)>, run: impl FnOnce() -> T) -> T { let started = Instant::now(); let value = run(); timings.push((what.to_owned(), started.elapsed().as_millis())); value }

    /// The measured package limits: every boundary, and whether two base64 archives fit the record with rollback
    /// intact. Prints `PACKAGE_LIMITS` with the sizes and timings recorded in docs/extensions/runtime-code-folders.md.
    #[test]
    fn package_limits_hold_at_every_boundary_and_two_archives_fit_the_record_with_rollback_intact() {
        use super::super::{MAX_ARCHIVE, MAX_EXPANDED, MAX_FILE, MAX_FILES, MAX_RECORD};
        assert_eq!((MAX_ARCHIVE, MAX_FILE, MAX_EXPANDED, MAX_FILES), (16 << 20, 8 << 20, 64 << 20, 1024));
        let disk = Storage::new(); let packages = disk.packages(false);
        let install = |bytes: &[u8]| { let result = packages.install(bytes); if result.is_ok() { packages.uninstall(ID).unwrap(); } result };
        let mut timings = Vec::new();
        // File count: 1,024 entries pass (the fixture plus empty code files), 1,025 do not.
        let base = fixture_files(|_, bytes| bytes);
        let count = |total: usize| { let mut files: Vec<(String, Vec<u8>)> = base.clone(); for index in 0..total - base.len() { files.push((format!("lib/f{index}.cjs"), vec![])); } archive(&files.iter().map(|(name, bytes)| (name.as_str(), bytes.as_slice())).collect::<Vec<_>>()) };
        timed("files1024", &mut timings, || install(&count(MAX_FILES))).unwrap();
        assert_eq!(install(&count(MAX_FILES + 1)).unwrap_err(), "Archive file-count limit exceeded.");
        // Single file: 8 MiB passes, one byte more does not.
        timed("file8MiB", &mut timings, || install(&heavy_archive("1.0.0", &[MAX_FILE as usize], 1))).unwrap();
        assert_eq!(install(&heavy_archive("1.0.0", &[MAX_FILE as usize + 1], 1)).unwrap_err(), "Archive file limit exceeded.");
        // Expanded: eight files at the file limit compress to almost nothing yet expand to 64 MiB; one more byte fails.
        let zeros = |extra: usize| { let mut files: Vec<(String, Vec<u8>)> = base.clone(); let used: usize = base.iter().map(|(_, bytes)| bytes.len()).sum(); let mut left = MAX_EXPANDED as usize - used + extra; let mut index = 0; while left > 0 { let size = left.min(MAX_FILE as usize); files.push((format!("lib/z{index}.bin"), vec![0; size])); left -= size; index += 1; } archive(&files.iter().map(|(name, bytes)| (name.as_str(), bytes.as_slice())).collect::<Vec<_>>()) };
        timed("expanded64MiB", &mut timings, || install(&zeros(0))).unwrap();
        assert_eq!(install(&zeros(1)).unwrap_err(), "Archive expansion limit exceeded.");
        // Archive: the largest archive under 16 MiB passes; anything over it fails before it is opened.
        let blobs = |total: usize| { let half = (total - 64 * 1024) / 2; [half, total - 64 * 1024 - half] };
        let largest = heavy_archive("1.0.0", &blobs(MAX_ARCHIVE as usize - 8 * 1024), 3);
        assert!(largest.len() as u64 <= MAX_ARCHIVE && largest.len() as u64 > MAX_ARCHIVE - 256 * 1024, "{}", largest.len());
        assert_eq!(install(&vec![0; MAX_ARCHIVE as usize + 1]).unwrap_err(), "Archive size limit exceeded.");

        // Two generations in one record: install A (16 MiB), stage and review B (16 MiB), then roll back to A.
        timed("install16MiB", &mut timings, || packages.install(&largest)).unwrap();
        let record = disk.0.join("extensions-v1").join(format!("{ID}.json"));
        let digest = |packages: &super::super::Packages| packages.snapshot().packages[0].executable.as_ref().unwrap().digest.clone();
        let a = digest(&packages);
        packages.trust(ID, &a, true).unwrap(); packages.enable(ID, true).unwrap();
        timed("snapshot16MiB", &mut timings, || packages.snapshot());
        let (_, files) = timed("codeFiles16MiB", &mut timings, || packages.code_files(ID)).unwrap();
        timed("materialize16MiB", &mut timings, || materialize(&packages.app_data(), ID, &a, &files)).unwrap();
        timed("materializeVerify16MiB", &mut timings, || materialize(&packages.app_data(), ID, &a, &files)).unwrap();
        let next = heavy_archive("1.1.0", &blobs(MAX_ARCHIVE as usize - 8 * 1024), 5);
        let staged = disk.0.join("next.zip"); std::fs::write(&staged, &next).unwrap();
        timed("stage16MiB", &mut timings, || packages.stage_update(ID, &staged)).unwrap();
        let staged_record = std::fs::metadata(&record).unwrap().len();
        let b = serde_json::to_value(packages.snapshot()).unwrap()["packages"][0]["update"]["digest"].as_str().unwrap().to_owned();
        timed("promote16MiB", &mut timings, || packages.review_update(ID, &b)).unwrap();
        let promoted_record = std::fs::metadata(&record).unwrap().len();
        assert_eq!(digest(&packages), b);
        assert!(staged_record <= MAX_RECORD && promoted_record <= MAX_RECORD, "{staged_record} {promoted_record} {MAX_RECORD}");
        // A third generation (staging C beside B and its rollback A) does not fit: refused, record and rollback intact.
        let third = disk.0.join("third.zip"); std::fs::write(&third, heavy_archive("1.2.0", &blobs(MAX_ARCHIVE as usize - 8 * 1024), 7)).unwrap();
        packages.activation_finished(ID, &b, true).unwrap();
        let before = std::fs::read(&record).unwrap();
        assert_eq!(packages.stage_update(ID, &third).unwrap_err(), "Extension record limit exceeded.");
        assert_eq!(std::fs::read(&record).unwrap(), before, "a refused stage leaves the record untouched");
        timed("rollback16MiB", &mut timings, || packages.rollback_update(ID, "Manual rollback")).unwrap();
        assert_eq!(digest(&packages), a);
        assert!(packages.snapshot().packages[0].executable.as_ref().unwrap().trusted, "rollback restores the reviewed generation");
        println!("PACKAGE_LIMITS {}", json!({
            "archive": largest.len(), "maxRecord": MAX_RECORD, "recordWithStaged": staged_record, "recordWithRollback": promoted_record,
            "timingsMs": timings.iter().map(|(name, ms)| (name.clone(), json!(ms))).collect::<serde_json::Map<String, Value>>(),
        }));
    }

    /// Real runtime acceptance (pinned Node, Windows x64): the installed fixture service imports CJS, ESM, a worker
    /// and Wasm relatively from its code folders, reads the user's environment without NODE_OPTIONS or the host's
    /// variables, answers its data directory, and keeps its data across update, rollback and uninstall.
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    mod installed {
        use super::*;
        use crate::extensions::{runtime_grants::{RuntimeGrants, Scope}, runtime_service_lifetime::{ServiceLifetime, StopReason, STOP_GRACE}, supervisor};
        use std::{sync::{atomic::AtomicBool, Arc}, time::Duration};

        fn runtime_dir() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime") }
        fn service(manager: &ServiceLifetime) -> Value {
            manager.projection()["services"].as_array().unwrap().iter().find(|service| service["id"] == ID).cloned().unwrap_or(Value::Null)
        }
        /// Waits for a projection condition (tests only; the product never polls).
        async fn wait_for(manager: &ServiceLifetime, what: &str, check: impl Fn(&Value) -> bool) -> Value {
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                let current = service(manager);
                if check(&current) { return current; }
                assert!(Instant::now() < deadline, "timed out waiting for {what}: {current}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        fn probe(disk: &Storage) -> Value { serde_json::from_slice(&std::fs::read(disk.0.join(DATA).join(ID).join("global").join("probe.json")).unwrap()).unwrap() }
        fn generation(version: &'static str, generation: u32) -> impl Fn(&str, Vec<u8>) -> Vec<u8> {
            move |name, bytes| match name {
                "extension.json" => String::from_utf8(bytes).unwrap().replace("\"1.0.0\"", &format!("\"{version}\"")).into_bytes(),
                "lib/helper.cjs" => String::from_utf8(bytes).unwrap().replace("generation = 1", &format!("generation = {generation}")).into_bytes(),
                _ => bytes,
            }
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn installed_code_folder_service_imports_cjs_esm_worker_and_wasm_and_keeps_its_data_across_update_rollback_and_uninstall() {
            supervisor::Runtime::packaged(&runtime_dir()).unwrap();
            let disk = Storage::new(); let packages = disk.packages(false); let grants = RuntimeGrants::open(&disk.0);
            let canaries = [("NODE_OPTIONS", "--title=leaked-node-options"), ("PANDACODE_FIXTURE_CREDENTIAL", "canary-held-credential"), ("PANDA_FIXTURE_USER", "user-environment")];
            let parent: Vec<(OsString, OsString)> = std::env::vars_os().filter(|(name, _)| !name.eq_ignore_ascii_case("NODE_OPTIONS"))
                .chain(canaries.iter().map(|(name, value)| (OsString::from(name), OsString::from(value)))).collect();
            let manager = ServiceLifetime::new(vec![runtime_dir()]).with_parent_env(parent);
            let reconcile = || manager.reconcile(&packages, &grants);
            let started = Instant::now();
            packages.install(&fixture_archive(|_, bytes| bytes)).unwrap();
            let a = packages.snapshot().packages[0].executable.as_ref().unwrap().digest.clone();
            packages.trust(ID, &a, true).unwrap(); packages.enable(ID, true).unwrap();
            // The first reconcile syncs the grants file with the installed package; only then can the grants be given.
            reconcile(); assert_eq!(service(&manager), Value::Null, "no runtime.service grant yet");
            grants.grant(ID, "runtime.service", Scope::default()).unwrap();
            grants.grant(ID, "storage.private", Scope::default()).unwrap();
            reconcile();
            wait_for(&manager, "generation 1", |service| service["state"] == "running" && service["status"]["text"] == "probe generation 1").await;
            let first_start = started.elapsed().as_millis();
            let first = probe(&disk);
            let code_a = code_directory(&disk.0, ID, &a);
            let global = disk.0.join(DATA).join(ID).join("global");
            assert_eq!((first["generation"].clone(), first["cjs"].clone(), first["esm"].clone(), first["worker"].clone(), first["wasm"].clone()), (json!(1), json!("cjs"), json!("esm:shared"), json!(42), json!(42)), "{first}");
            assert_eq!(PathBuf::from(first["dirname"].as_str().unwrap()), code_a);
            assert_eq!(PathBuf::from(first["cwd"].as_str().unwrap()), code_a);
            assert_eq!(first["env"], json!({"path": true, "nodeOptions": null, "credential": null, "user": "user-environment"}));
            assert_eq!(first["storage"], json!({"schemaVersion": 1, "path": global.to_string_lossy(), "project": "StaleContext"}));
            assert_eq!((first["previous"].clone(), first["runs"].clone(), first["reason"].clone()), (Value::Null, json!(1), json!("enable")));

            // Update: a reviewed new archive is a new code generation; the old one is removed; own data is reopened.
            let staged = disk.0.join("update.zip"); std::fs::write(&staged, fixture_archive(generation("1.1.0", 2))).unwrap();
            packages.stage_update(ID, &staged).unwrap();
            let b = serde_json::to_value(packages.snapshot()).unwrap()["packages"][0]["update"]["digest"].as_str().unwrap().to_owned();
            packages.review_update(ID, &b).unwrap();
            reconcile();
            wait_for(&manager, "generation 2", |service| service["reason"] == "update" && service["status"]["text"] == "probe generation 2").await;
            let second = probe(&disk);
            assert_eq!(PathBuf::from(second["dirname"].as_str().unwrap()), code_directory(&disk.0, ID, &b));
            assert_eq!((second["generation"].clone(), second["previous"]["generation"].clone(), second["runs"].clone()), (json!(2), json!(1), json!(2)));
            assert!(!code_a.exists(), "the previous code generation is removed");

            // Rollback: the reviewed previous generation comes back, re-extracted, with the same data.
            packages.rollback_update(ID, "Manual rollback").unwrap();
            reconcile();
            wait_for(&manager, "generation 1 again", |service| service["reason"] == "update" && service["status"]["text"] == "probe generation 1").await;
            let third = probe(&disk);
            assert_eq!(PathBuf::from(third["dirname"].as_str().unwrap()), code_a);
            assert_eq!((third["generation"].clone(), third["previous"]["generation"].clone(), third["runs"].clone()), (json!(1), json!(2), json!(3)));
            assert!(!code_directory(&disk.0, ID, &b).exists());

            // Uninstall removes the code once the service has stopped and keeps own data; "remove own data" removes it.
            packages.uninstall(ID).unwrap(); reconcile();
            wait_for(&manager, "uninstall", |service| service["state"] == "stopped" && service["lastStop"] == json!({"reason": "uninstall", "acknowledged": true})).await;
            let deadline = Instant::now() + Duration::from_secs(5);
            while disk.0.join(CODE).join(ID).exists() { assert!(Instant::now() < deadline, "the code directory survived uninstall"); tokio::time::sleep(Duration::from_millis(50)).await; }
            assert_eq!(probe(&disk)["runs"], 3, "uninstall keeps own data");
            packages.storage_remove_own_data(ID).unwrap();
            assert!(!disk.0.join(DATA).join(ID).exists());
            let last = service(&manager);
            assert_eq!(last["starts"], json!({"enable": 1, "update": 2})); assert_eq!(last["stops"], json!({"update": 2, "uninstall": 1}));
            println!("CODE_FOLDERS {}", json!({"firstStartMs": first_start, "elapsedMs": started.elapsed().as_millis(), "starts": last["starts"], "stops": last["stops"]}));
            manager.stop_all(StopReason::Quit); assert!(manager.wait_idle(STOP_GRACE + Duration::from_secs(1)).await);
        }

        /// `storage.directory` is service only: a short activation is answered `UnsupportedCapability` without a host call.
        #[tokio::test]
        async fn a_short_activation_has_no_storage_directory() {
            let runtime = supervisor::Runtime::packaged(&runtime_dir()).unwrap();
            let source = "exports.activate=async panda=>{try{await panda.storage.directory({scope:'global'});}catch(error){if(error.message==='UnsupportedCapability')return;throw error;}throw new Error('answered');};";
            let result = supervisor::run(&runtime, source, Value::Null, Arc::new(AtomicBool::new(false)), |method, _| panic!("unexpected host call {method}")).await;
            assert_eq!(result.unwrap(), Vec::<Value>::new());
        }
    }
}
