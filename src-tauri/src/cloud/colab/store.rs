//! What PandaCode keeps about Google Colab between calls, so the app and the separate cloud
//! bridge process (`PANDACODE_CLOUD_BRIDGE`) see the same state with nothing held only in
//! memory:
//!
//! - the Google sign-in, one compact JSON secret (`colab_oauth`) in the secure store;
//! - the runtimes PandaCode knows (friendly name, runtime-proxy URL and token, kernel), in
//!   `colab-sessions.json` beside the secrets file, mode 0600, replaced atomically. Every
//!   read-modify-write holds an exclusive lock on `colab-sessions.json.lock` (`flock` on
//!   Unix, `LockFileEx` on Windows), so the app and a bridge never overwrite each other.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

type Result<T> = std::result::Result<T, String>;

pub const SESSIONS_FILE: &str = "colab-sessions.json";
const SIGN_IN: &str = "Sign in to Google Colab in Settings → Cloud first.";

/// One Colab runtime PandaCode has seen, keyed by its endpoint.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionRecord {
    pub name: String,
    pub endpoint: String,
    /// The runtime proxy's base URL (`https://…`), host of the Jupyter and SSH endpoints.
    pub url: String,
    /// Runtime-proxy token; it expires, so `token_expires_at` says when to fetch a new one.
    pub token: String,
    pub token_expires_at: i64,
    pub accelerator: String,
    /// DEFAULT, GPU or TPU.
    pub variant: String,
    /// STANDARD or HIGH_RAM.
    pub machine_shape: String,
    pub kernel_id: Option<String>,
    /// When PandaCode created the runtime (seconds): an assignment list fetched before then
    /// may not hold it yet, so reconciling with that list keeps it.
    pub created_at: i64,
    /// The thread that created or used the runtime, so its indicator still shows the
    /// runtime after PandaCode restarts. Unset for a Cloud Agent's own runtime.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

pub type Records = BTreeMap<String, SessionRecord>;

/// Serializes read-modify-write of the sessions file inside one process; the lock file
/// serializes it between processes.
static LOCK: Mutex<()> = Mutex::new(());
const SAVE_FAILED: &str = "Could not save the Colab runtimes.";

pub fn path() -> Result<PathBuf> {
    crate::secret_store::dir().map(|dir| dir.join(SESSIONS_FILE)).ok_or_else(|| "PandaCode secrets are not available yet.".into())
}

pub fn load(path: &Path) -> Records {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    read(path)
}

/// Replace the records with what `change` makes of them, and hand back its value. The
/// read, the change and the write happen under one in-process and one cross-process lock.
pub fn update<T>(path: &Path, change: impl FnOnce(Records) -> (Records, T)) -> Result<T> {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _file_lock = lock_file(path)?;
    let (next, value) = change(read(path));
    write(path, &next)?;
    Ok(value)
}

/// `<sessions>.lock`, locked exclusively until the returned handle drops. It is never
/// removed: deleting a lock file lets two holders race.
fn lock_file(path: &Path) -> Result<std::fs::File> {
    let mut name = path.as_os_str().to_owned();
    name.push(".lock");
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(PathBuf::from(name)).map_err(|_| SAVE_FAILED.to_string())?;
    file.lock().map_err(|_| SAVE_FAILED.to_string())?;
    Ok(file)
}

/// Marks the runtime as `session_id`'s unless another thread already has it. True when the
/// record changed.
pub fn claim(path: &Path, endpoint: &str, session_id: &str) -> Result<bool> {
    update(path, |mut records| {
        let changed = match records.get_mut(endpoint) {
            Some(record) if record.session_id.is_none() => {
                record.session_id = Some(session_id.to_string());
                true
            }
            _ => false,
        };
        (records, changed)
    })
}

/// The runtime is no longer `session_id`'s (the thread dismissed it).
pub fn disown(path: &Path, endpoint: &str, session_id: &str) -> Result<()> {
    update(path, |mut records| {
        if let Some(record) = records.get_mut(endpoint).filter(|record| record.session_id.as_deref() == Some(session_id)) {
            record.session_id = None;
        }
        (records, ())
    })
}

/// The threads were deleted: every runtime saved as one of theirs is free for another
/// thread to claim. The file is left untouched when none of them owned a runtime.
pub fn disown_sessions(path: &Path, session_ids: &[String]) -> Result<()> {
    let owned = |record: &SessionRecord| record.session_id.as_ref().is_some_and(|sid| session_ids.contains(sid));
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if session_ids.is_empty() || !read(path).values().any(owned) {
        return Ok(());
    }
    let _file_lock = lock_file(path)?;
    let next: Records = read(path)
        .into_iter()
        .map(|(endpoint, record)| match owned(&record) {
            true => (endpoint, SessionRecord { session_id: None, ..record }),
            false => (endpoint, record),
        })
        .collect();
    write(path, &next)
}

pub fn remove(path: &Path, endpoint: &str) -> Result<()> {
    update(path, |records| (records.into_iter().filter(|(key, _)| key != endpoint).collect(), ()))
}

fn read(path: &Path) -> Records {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn write(path: &Path, records: &Records) -> Result<()> {
    let json = serde_json::to_vec(records).map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    write_private(&temporary, &json).and_then(|()| std::fs::rename(&temporary, path).map_err(|_| SAVE_FAILED.to_string())).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
}

fn write_private(file: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut handle = options.open(file).map_err(|_| SAVE_FAILED.to_string())?;
    handle.write_all(bytes).map_err(|_| SAVE_FAILED.to_string())
}

/// The Google sign-in. In ADC mode only the access token is kept here; the refresh token
/// stays in gcloud's own credentials file.
#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct OAuthSecret {
    pub client_id: String,
    pub client_secret: String,
    pub refresh_token: String,
    pub access_token: String,
    pub expires_at: i64,
}

impl std::fmt::Debug for OAuthSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OAuthSecret").field("expires_at", &self.expires_at).finish_non_exhaustive()
    }
}

impl OAuthSecret {
    pub fn load() -> Option<Self> {
        super::super::secret(super::SECRET).and_then(|json| serde_json::from_str(&json).ok())
    }
    /// One line: the secure store rejects newlines.
    pub fn save(&self) -> Result<()> {
        super::super::set_secret(super::SECRET, &serde_json::to_string(self).map_err(|e| e.to_string())?)
    }
    /// Usable for at least `margin` more seconds.
    pub fn fresh(&self, now: i64, margin: i64) -> bool {
        !self.access_token.is_empty() && self.expires_at - now > margin
    }
}

/// gcloud's Application Default Credentials file: `GOOGLE_APPLICATION_CREDENTIALS`, else the
/// gcloud config dir (`CLOUDSDK_CONFIG`, `%APPDATA%\gcloud`, `~/.config/gcloud`).
pub fn adc_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("GOOGLE_APPLICATION_CREDENTIALS").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(path));
    }
    let config = std::env::var_os("CLOUDSDK_CONFIG").filter(|p| !p.is_empty()).map(PathBuf::from).or_else(|| {
        if cfg!(windows) {
            std::env::var_os("APPDATA").map(|dir| PathBuf::from(dir).join("gcloud"))
        } else {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config/gcloud"))
        }
    })?;
    Some(config.join("application_default_credentials.json"))
}

/// The refreshable user credentials in an ADC file.
pub fn parse_adc(text: &str) -> Result<OAuthSecret> {
    #[derive(Deserialize)]
    struct Adc {
        #[serde(rename = "type", default)]
        kind: String,
        #[serde(default)]
        client_id: String,
        #[serde(default)]
        client_secret: String,
        #[serde(default)]
        refresh_token: String,
    }
    let adc: Adc = serde_json::from_str(text).map_err(|_| "The gcloud application default credentials file is not readable JSON.".to_string())?;
    if adc.kind != "authorized_user" || adc.client_id.is_empty() || adc.refresh_token.is_empty() {
        return Err("Google Colab needs user credentials from `gcloud auth application-default login`, not a service account.".into());
    }
    Ok(OAuthSecret { client_id: adc.client_id, client_secret: adc.client_secret, refresh_token: adc.refresh_token, ..OAuthSecret::default() })
}

pub fn load_adc() -> Result<OAuthSecret> {
    let path = adc_path().ok_or("No gcloud application default credentials were found.")?;
    let text = std::fs::read_to_string(&path).map_err(|_| "No gcloud application default credentials were found. Run `gcloud auth application-default login` or sign in with Google again.".to_string())?;
    parse_adc(&text)
}

pub fn signed_in() -> Result<OAuthSecret> {
    OAuthSecret::load().ok_or_else(|| SIGN_IN.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pandacode-colab-store-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(SESSIONS_FILE)
    }

    #[test]
    fn sessions_round_trip_privately_and_atomically() {
        let path = temp();
        assert!(load(&path).is_empty());
        let record = SessionRecord { name: "pc-a".into(), endpoint: "gpu-t4-s-1".into(), token: "t".into(), ..SessionRecord::default() };
        update(&path, |records| {
            let mut next = records;
            next.insert(record.endpoint.clone(), record.clone());
            (next, ())
        })
        .unwrap();
        assert_eq!(load(&path).get("gpu-t4-s-1"), Some(&record));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        remove(&path, "gpu-t4-s-1").unwrap();
        assert!(load(&path).is_empty());
        let leftovers = std::fs::read_dir(path.parent().unwrap()).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains("tmp")).count();
        assert_eq!(leftovers, 0);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_runtime_remembers_its_thread_until_disowned() {
        let path = temp();
        let record = SessionRecord { name: "pc-a".into(), endpoint: "gpu-t4-s-1".into(), ..SessionRecord::default() };
        update(&path, |_| (Records::from([(record.endpoint.clone(), record.clone())]), ())).unwrap();
        let bytes = std::fs::read_to_string(&path).unwrap();
        assert!(!bytes.contains("sessionId"), "an unclaimed record writes no thread: {bytes}");
        assert!(!claim(&path, "missing", "s1").unwrap(), "only a known runtime is claimed");
        assert!(claim(&path, "gpu-t4-s-1", "s1").unwrap());
        assert!(!claim(&path, "gpu-t4-s-1", "s2").unwrap(), "the first thread keeps it");
        assert_eq!(load(&path)["gpu-t4-s-1"].session_id.as_deref(), Some("s1"));
        assert!(std::fs::read_to_string(&path).unwrap().contains(r#""sessionId":"s1""#));
        disown(&path, "gpu-t4-s-1", "s2").unwrap();
        assert_eq!(load(&path)["gpu-t4-s-1"].session_id.as_deref(), Some("s1"), "another thread cannot disown it");
        disown(&path, "gpu-t4-s-1", "s1").unwrap();
        assert_eq!(load(&path)["gpu-t4-s-1"].session_id, None);
        // Records written before the field existed still load.
        std::fs::write(&path, r#"{"ep":{"name":"n","endpoint":"ep"}}"#).unwrap();
        assert_eq!(load(&path)["ep"].session_id, None);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn deleting_a_thread_frees_its_runtimes_for_another() {
        let path = temp();
        let rec = |endpoint: &str, sid: Option<&str>| SessionRecord { endpoint: endpoint.into(), session_id: sid.map(str::to_owned), ..SessionRecord::default() };
        let initial = Records::from([
            ("a".into(), rec("a", Some("s1"))),
            ("b".into(), rec("b", Some("s1"))),
            ("c".into(), rec("c", Some("s3"))),
            ("d".into(), rec("d", None)),
        ]);
        update(&path, |_| (initial.clone(), ())).unwrap();
        let modified = || std::fs::metadata(&path).unwrap().modified().unwrap();
        // Nothing owned: the file is not rewritten.
        let before = modified();
        std::thread::sleep(std::time::Duration::from_millis(20));
        disown_sessions(&path, &["nobody".into()]).unwrap();
        disown_sessions(&path, &[]).unwrap();
        assert_eq!(modified(), before, "no matching claim, no write");
        assert_eq!(load(&path), initial);

        disown_sessions(&path, &["s1".into(), "s2".into()]).unwrap();
        let records = load(&path);
        assert_eq!((records["a"].session_id.as_deref(), records["b"].session_id.as_deref()), (None, None));
        assert_eq!(records["c"].session_id.as_deref(), Some("s3"), "other threads keep theirs");
        // A second thread can now claim the runtime, and it persists for that thread.
        assert!(claim(&path, "a", "s2").unwrap());
        assert_eq!(load(&path)["a"].session_id.as_deref(), Some("s2"));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn concurrent_updates_never_lose_a_record() {
        let path = temp();
        let threads: Vec<_> = (0..8)
            .map(|n| {
                let path = path.clone();
                std::thread::spawn(move || {
                    update(&path, |records| {
                        let mut next = records;
                        let endpoint = format!("m-{n}");
                        next.insert(endpoint.clone(), SessionRecord { endpoint, ..SessionRecord::default() });
                        (next, ())
                    })
                    .unwrap();
                })
            })
            .collect();
        threads.into_iter().for_each(|thread| thread.join().unwrap());
        assert_eq!(load(&path).len(), 8);
        assert!(path.with_file_name(format!("{SESSIONS_FILE}.lock")).exists(), "the lock file stays beside the sessions");
        // The lock is released once an update returns: a second handle can take it at once.
        let other = std::fs::OpenOptions::new().read(true).write(true).open(path.with_file_name(format!("{SESSIONS_FILE}.lock"))).unwrap();
        other.try_lock().unwrap();
        // Close the handle first: Windows will not delete a folder holding an open file.
        drop(other);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_damaged_sessions_file_reads_as_empty() {
        let path = temp();
        std::fs::write(&path, "{not json").unwrap();
        assert!(load(&path).is_empty());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn the_secret_is_one_line_and_never_debug_printed() {
        let secret = OAuthSecret { client_id: "id".into(), client_secret: "shh".into(), refresh_token: "r".into(), access_token: "a".into(), expires_at: 10 };
        let json = serde_json::to_string(&secret).unwrap();
        assert!(!json.contains('\n'));
        assert!(json.contains(r#""clientId":"id""#) && json.contains(r#""expiresAt":10"#));
        assert!(!format!("{secret:?}").contains("shh"));
        assert!(secret.fresh(0, 5) && !secret.fresh(6, 5));
    }

    #[test]
    fn reads_only_user_adc_credentials() {
        let user = parse_adc(r#"{"type":"authorized_user","client_id":"c","client_secret":"s","refresh_token":"r"}"#).unwrap();
        assert_eq!((user.client_id.as_str(), user.refresh_token.as_str()), ("c", "r"));
        assert!(parse_adc(r#"{"type":"service_account","client_id":"c"}"#).unwrap_err().contains("service account"));
        assert!(parse_adc("nope").is_err());
    }
}
