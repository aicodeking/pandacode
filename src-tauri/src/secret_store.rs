//! App secrets. On macOS they live in `secrets.json`, a 0600 JSON file in the app data dir
//! keyed `"<service>/<account>"`: PandaCode has no Apple Team ID, so a Keychain item is pinned
//! to the build that made it and every update asked for the login password on each read.
//! Items saved in the Keychain by earlier versions move to the file on first use, at most one
//! prompt per item, ever. Linux and Windows keep the OS store (Secret Service, Credential
//! Manager). Values never enter prompts, logs, the database or the webview.
use serde::{de::DeserializeOwned, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const FILE: &str = "secrets.json";
const LABEL: &str = "PandaCode secrets";

static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Sets the app data dir once, at startup before anything reads a secret (and in the cloud
/// bridge process, which reads provider keys).
pub(crate) fn setup(dir: &Path) {
    let _ = DIR.set(dir.to_owned());
}

/// The dir given to `setup`, for child processes that read secrets.
pub(crate) fn dir() -> Option<&'static Path> {
    DIR.get().map(PathBuf::as_path)
}

fn key(service: &str, account: &str) -> String {
    format!("{service}/{account}")
}

#[cfg(test)]
fn memory() -> &'static Mutex<std::collections::HashMap<String, String>> {
    static STORE: OnceLock<Mutex<std::collections::HashMap<String, String>>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}

pub(crate) fn set(service: &str, account: &str, value: &str) -> crate::Result<()> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err("That secret looks empty or malformed.".into());
    }
    #[cfg(test)]
    {
        memory().lock().unwrap().insert(key(service, account), value.to_owned());
        Ok(())
    }
    #[cfg(all(not(test), target_os = "macos"))]
    {
        file_set(app_dir()?, service, account, Some(value))
    }
    #[cfg(all(not(test), any(target_os = "linux", target_os = "windows")))]
    {
        keyring::Entry::new(service, account).and_then(|entry| entry.set_password(value)).map_err(|_| "Could not save the secret in secure storage.".into())
    }
    #[cfg(all(not(test), not(any(target_os = "macos", target_os = "linux", target_os = "windows"))))]
    {
        let _ = (service, account, value);
        Err("Secure storage is not available on this platform.".into())
    }
}

pub(crate) fn get(service: &str, account: &str) -> Option<String> {
    #[cfg(test)]
    {
        memory().lock().unwrap().get(&key(service, account)).cloned()
    }
    #[cfg(all(not(test), target_os = "macos"))]
    {
        let dir = app_dir().map_err(|error| eprintln!("{error}")).ok()?;
        file_get(dir, service, account, &legacy::Keychain)
    }
    #[cfg(all(not(test), any(target_os = "linux", target_os = "windows")))]
    {
        keyring::Entry::new(service, account).and_then(|entry| entry.get_password()).ok()
    }
    #[cfg(all(not(test), not(any(target_os = "macos", target_os = "linux", target_os = "windows"))))]
    {
        let _ = (service, account);
        None
    }
}

/// The file's value only: no Keychain access of any kind (background usage checks).
#[cfg(target_os = "macos")]
pub(crate) fn peek(service: &str, account: &str) -> Option<String> {
    #[cfg(test)]
    {
        get(service, account)
    }
    #[cfg(not(test))]
    {
        load::<Map>(&app_dir().ok()?.join(FILE), LABEL).ok()?.get(&key(service, account)).cloned()
    }
}

pub(crate) fn remove(service: &str, account: &str) {
    #[cfg(test)]
    {
        memory().lock().unwrap().remove(&key(service, account));
    }
    #[cfg(all(not(test), target_os = "macos"))]
    {
        match app_dir().and_then(|dir| file_set(dir, service, account, None)) {
            Ok(()) => legacy::forget(&legacy::Keychain, service, account),
            Err(error) => eprintln!("{error}"),
        }
    }
    #[cfg(all(not(test), any(target_os = "linux", target_os = "windows")))]
    {
        if let Ok(entry) = keyring::Entry::new(service, account) {
            let _ = entry.delete_credential();
        }
    }
    #[cfg(all(not(test), not(any(target_os = "macos", target_os = "linux", target_os = "windows"))))]
    {
        let _ = (service, account);
    }
}

#[cfg(all(not(test), target_os = "macos"))]
fn app_dir() -> crate::Result<&'static Path> {
    dir().ok_or_else(|| "PandaCode secrets are not available yet.".into())
}

type Map = BTreeMap<String, String>;

/// The file's value, else a legacy Keychain item moved into the file.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn file_get(dir: &Path, service: &str, account: &str, keychain: &impl legacy::Legacy) -> Option<String> {
    let name = key(service, account);
    // A corrupt or unreadable file reads as none and skips migration, which could not save.
    let map: Map = load(&dir.join(FILE), LABEL).map_err(|error| eprintln!("{error}")).ok()?;
    if let Some(value) = map.get(&name) {
        return Some(value.clone());
    }
    legacy::migrate(keychain, service, account, |value| file_set(dir, service, account, Some(value)))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn file_set(dir: &Path, service: &str, account: &str, value: Option<&str>) -> crate::Result<()> {
    let name = key(service, account);
    update::<Map>(dir, FILE, LABEL, |mut map| {
        match value {
            Some(value) => map.insert(name, value.to_owned()),
            None => map.remove(&name),
        };
        map
    })
}

/// Serializes read-modify-write of every secrets file in this process.
static WRITE: Mutex<()> = Mutex::new(());

/// A JSON secrets file's contents. Missing means default; any other failure is an error.
pub(crate) fn load<T: DeserializeOwned + Default>(path: &Path, label: &str) -> crate::Result<T> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
        Err(error) => return Err(format!("Could not read {label} at {}: {error}", path.display())),
    };
    serde_json::from_str(&text).map_err(|error| format!("{label} at {} are corrupt: {error}", path.display()))
}

/// Replaces `dir/file` with `change(current)` atomically (0600 temp, fsync, rename) under this
/// process's lock and an advisory lock on `<name>.lock`, so app processes cannot interleave.
/// A default result deletes the file; a file that could not be read is never replaced.
pub(crate) fn update<T: Serialize + DeserializeOwned + Default + PartialEq>(dir: &Path, file: &str, label: &str, change: impl FnOnce(T) -> T) -> crate::Result<()> {
    let _guard = WRITE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let lock_name = format!("{}.lock", file.trim_end_matches(".json"));
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(lock_name))
        .and_then(|file| file.lock().map(|_| file))
        .map_err(|e| format!("Could not lock {label}: {e}"))?;
    let path = dir.join(file);
    let next = change(load(&path, label)?);
    let saved = if next == T::default() {
        match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(format!("Could not remove {label}: {error}")),
            _ => Ok(()),
        }
    } else {
        let text = serde_json::to_vec(&next).map_err(|e| e.to_string())?;
        write_atomic(dir, &path, file, &text).map_err(|e| format!("Could not save {label}: {e}"))
    };
    drop(lock);
    saved
}

fn write_atomic(dir: &Path, path: &Path, file: &str, bytes: &[u8]) -> std::io::Result<()> {
    let temp = dir.join(format!("{file}.{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(&temp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    let renamed = written.and_then(|_| std::fs::rename(&temp, path));
    if renamed.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    renamed
}

/// Keychain items saved by PandaCode before secrets moved to the file.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod legacy {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    pub(super) trait Legacy {
        /// Attributes only, never the data, so it cannot prompt.
        fn exists(&self, service: &str, account: &str) -> bool;
        /// The one read that may prompt.
        fn read(&self, service: &str, account: &str) -> Option<String>;
        fn delete(&self, service: &str, account: &str);
    }

    /// Each item read this launch, by key (none when the read failed or was denied), so no
    /// item is read twice in one launch. The file is always checked first.
    fn tried() -> &'static Mutex<HashMap<String, Option<String>>> {
        static TRIED: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
        TRIED.get_or_init(Default::default)
    }

    /// Moves one item into the file: missing costs one attributes query, an item is read once,
    /// saved, then deleted; a failed read is remembered until the next launch.
    pub(super) fn migrate(keychain: &impl Legacy, service: &str, account: &str, save: impl FnOnce(&str) -> crate::Result<()>) -> Option<String> {
        let name = super::key(service, account);
        let mut tried = tried().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(outcome) = tried.get(&name) {
            return outcome.clone();
        }
        if !keychain.exists(service, account) {
            return None;
        }
        let value = keychain.read(service, account);
        match value.as_deref().map(save) {
            Some(Ok(())) => keychain.delete(service, account),
            Some(Err(error)) => eprintln!("{error}"),
            None => eprintln!("Could not move the Keychain item {service} to PandaCode secrets; it stays until the next launch."),
        }
        // Kept even after a save, so a caller that waited on this lock gets the value too.
        tried.insert(name, value.clone());
        value
    }

    /// After a removal: no stale value from this launch, and no legacy item to migrate back.
    pub(super) fn forget(keychain: &impl Legacy, service: &str, account: &str) {
        tried().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&super::key(service, account));
        if keychain.exists(service, account) {
            keychain.delete(service, account);
        }
    }

    #[cfg(all(not(test), target_os = "macos"))]
    pub(super) struct Keychain;

    #[cfg(all(not(test), target_os = "macos"))]
    impl Legacy for Keychain {
        fn exists(&self, service: &str, account: &str) -> bool {
            use security_framework::item::{ItemClass, ItemSearchOptions};
            ItemSearchOptions::new()
                .class(ItemClass::generic_password())
                .service(service)
                .account(account)
                .load_attributes(true)
                .search()
                .is_ok_and(|found| !found.is_empty())
        }

        fn read(&self, service: &str, account: &str) -> Option<String> {
            match security_framework::passwords::get_generic_password(service, account) {
                Ok(bytes) => String::from_utf8(bytes).ok(),
                Err(error) => {
                    eprintln!("Keychain read for {service} failed ({}): {error}", error.code());
                    None
                }
            }
        }

        fn delete(&self, service: &str, account: &str) {
            let _ = security_framework::passwords::delete_generic_password(service, account);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pandacode-secrets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A fake Keychain counting each call.
    #[derive(Default)]
    struct Fake {
        item: RefCell<Option<Option<String>>>,
        probes: Cell<u32>,
        reads: Cell<u32>,
        deletes: Cell<u32>,
    }

    impl Fake {
        /// `Some(None)` is an item whose read is denied.
        fn with(item: Option<Option<&str>>) -> Self {
            Fake { item: RefCell::new(item.map(|value| value.map(str::to_owned))), ..Fake::default() }
        }
    }

    impl legacy::Legacy for Fake {
        fn exists(&self, _: &str, _: &str) -> bool {
            self.probes.set(self.probes.get() + 1);
            self.item.borrow().is_some()
        }
        fn read(&self, _: &str, _: &str) -> Option<String> {
            self.reads.set(self.reads.get() + 1);
            self.item.borrow().clone().flatten()
        }
        fn delete(&self, _: &str, _: &str) {
            self.deletes.set(self.deletes.get() + 1);
            *self.item.borrow_mut() = None;
        }
    }

    fn unique(prefix: &str) -> String {
        format!("{prefix}-{}", uuid::Uuid::new_v4())
    }

    #[test]
    fn file_round_trip_is_private_and_removing_the_last_key_removes_the_file() {
        let dir = temp_dir();
        let none = Fake::with(None);
        file_set(&dir, "app.pandacode.bots", "c/token", Some("t")).unwrap();
        file_set(&dir, "app.pandacode.cloud", "settings", Some("{}")).unwrap();
        assert_eq!(file_get(&dir, "app.pandacode.bots", "c/token", &none).as_deref(), Some("t"));
        let map: Map = serde_json::from_str(&std::fs::read_to_string(dir.join(FILE)).unwrap()).unwrap();
        assert_eq!(map.get("app.pandacode.cloud/settings").map(String::as_str), Some("{}"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        file_set(&dir, "app.pandacode.bots", "c/token", None).unwrap();
        file_set(&dir, "app.pandacode.cloud", "settings", None).unwrap();
        assert!(!dir.join(FILE).exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_file_reads_as_none_skips_migration_and_is_kept() {
        let dir = temp_dir();
        std::fs::write(dir.join(FILE), "{not json").unwrap();
        let keychain = Fake::with(Some(Some("old")));
        assert_eq!(file_get(&dir, "s", &unique("a"), &keychain), None);
        assert_eq!((keychain.probes.get(), keychain.reads.get()), (0, 0));
        assert!(file_set(&dir, "s", "a", Some("v")).unwrap_err().contains("corrupt"));
        assert_eq!(std::fs::read_to_string(dir.join(FILE)).unwrap(), "{not json");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_legacy_item_is_read_once_saved_then_deleted() {
        let dir = temp_dir();
        let account = unique("migrate");
        let keychain = Fake::with(Some(Some("old")));
        assert_eq!(file_get(&dir, "s", &account, &keychain).as_deref(), Some("old"));
        assert_eq!(file_get(&dir, "s", &account, &keychain).as_deref(), Some("old"));
        assert_eq!((keychain.probes.get(), keychain.reads.get(), keychain.deletes.get()), (1, 1, 1));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_legacy_item_is_never_read() {
        let dir = temp_dir();
        let keychain = Fake::with(None);
        assert_eq!(file_get(&dir, "s", &unique("missing"), &keychain), None);
        assert_eq!((keychain.probes.get(), keychain.reads.get(), keychain.deletes.get()), (1, 0, 0));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_read_is_not_retried_this_launch() {
        let dir = temp_dir();
        let account = unique("denied");
        let keychain = Fake::with(Some(None));
        for _ in 0..3 {
            assert_eq!(file_get(&dir, "s", &account, &keychain), None);
        }
        assert_eq!((keychain.probes.get(), keychain.reads.get(), keychain.deletes.get()), (1, 1, 0));
        // A removal forgets the failure and deletes the item, so nothing comes back.
        legacy::forget(&keychain, "s", &account);
        assert_eq!(keychain.deletes.get(), 1);
        assert_eq!(file_get(&dir, "s", &account, &keychain), None);
        assert_eq!(keychain.reads.get(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn concurrent_writers_keep_every_key() {
        let dir = temp_dir();
        std::thread::scope(|scope| {
            for thread in 0..8 {
                let dir = &dir;
                scope.spawn(move || {
                    for n in 0..10 {
                        file_set(dir, "s", &format!("{thread}-{n}"), Some("v")).unwrap();
                    }
                });
            }
        });
        let map: Map = load(&dir.join(FILE), LABEL).unwrap();
        assert_eq!(map.len(), 80);
        let mut names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        names.sort();
        assert_eq!(names, vec![std::ffi::OsString::from(FILE), std::ffi::OsString::from("secrets.lock")]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
