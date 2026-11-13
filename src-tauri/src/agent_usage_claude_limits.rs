//! Rate limits on Claude's usage endpoint. After a 429 the endpoint is left
//! alone until its `Retry-After` (clamped to 5 min–1 h), even on a manual
//! refresh, and the last good reading is shown, marked stale. That reading is
//! kept per profile in `claude-usage-last.json` in PandaCode's app data
//! folder (limits, plan and check time only, never credentials), so it also
//! survives a restart, and it also stands in (marked stale) for any other
//! transient error. A reading is shown only for the account it was taken
//! with: an HMAC of the signed-in email under a random per-install key kept
//! beside it (0600), so the file alone does not reveal the email. Without a
//! known account no saved reading is shown.

use crate::agent_usage::{Usage, UsageWindow};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock, PoisonError},
    time::{Duration, Instant, SystemTime},
};

const FILE: &str = "claude-usage-last.json";
const KEY_FILE: &str = "claude-usage-key";
const FILE_LIMIT: u64 = 64 * 1024;
const PROFILES: usize = 32;
const WINDOWS: usize = 16;
const MIN_WAIT: Duration = Duration::from_secs(5 * 60);
const MAX_WAIT: Duration = Duration::from_secs(60 * 60);

/// One Claude profile's place for its last reading: a hash of where its login
/// lives, so the file holds no paths.
#[derive(Clone)]
pub(crate) struct Profile {
    pub key: String,
    /// Hash of the signed-in account, when Claude Code's files name one.
    pub account: Option<String>,
    pub dir: Option<PathBuf>,
}

fn hash(text: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(text))[..16].to_owned()
}

/// The per-install key: 32 random bytes, made once and kept owner-only.
fn install_key(dir: &Path) -> Option<Vec<u8>> {
    static KEYS: OnceLock<Mutex<HashMap<PathBuf, Vec<u8>>>> = OnceLock::new();
    let mut keys = KEYS.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(key) = keys.get(dir) {
        return Some(key.clone());
    }
    let path = dir.join(KEY_FILE);
    // Only an absent key is made: a transient read error must not replace
    // it (that would orphan every saved reading).
    let key = match std::fs::read(&path) {
        Ok(key) if key.len() == 32 => key,
        Ok(_) => return None,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let key = [uuid::Uuid::new_v4().into_bytes(), uuid::Uuid::new_v4().into_bytes()].concat();
            crate::agent_usage_claude_store::write_file(&path, &key).ok()?;
            key
        }
        Err(_) => return None,
    };
    keys.insert(dir.to_path_buf(), key.clone());
    Some(key)
}

/// An HMAC under the per-install key: the file shows neither paths nor emails.
fn keyed(dir: &Path, text: &str) -> Option<String> {
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(&install_key(dir)?).ok()?;
    mac.update(text.as_bytes());
    let digest = mac.finalize().into_bytes();
    Some(digest.iter().take(16).map(|b| format!("{b:02x}")).collect())
}

fn account_hint(dir: &Path, email: &str) -> Option<String> {
    keyed(dir, &email.trim().to_lowercase())
}

impl Profile {
    /// Blocking: may create the install key on first use.
    pub(crate) fn new(identity: &str, email: Option<String>, dir: Option<PathBuf>) -> Self {
        let account = dir.as_deref().zip(email).and_then(|(dir, email)| account_hint(dir, &email));
        // Where the login lives, keyed too; without a folder nothing is saved anyway.
        let key = dir.as_deref().and_then(|dir| keyed(dir, &format!("profile:{identity}"))).unwrap_or_else(|| hash(identity));
        Self { key, account, dir }
    }

    /// This profile, for the account `email` names now (none: no account).
    pub(crate) fn with_email(&self, email: Option<String>) -> Self {
        let account = self.dir.as_deref().zip(email).and_then(|(dir, email)| account_hint(dir, &email));
        Self { account, ..self.clone() }
    }
}

/// The server's `Retry-After`, in seconds or as an HTTP date; `None` when
/// absent or unreadable. At most an hour is honoured.
fn server_wait(retry_after: Option<&str>, now: SystemTime) -> Option<Duration> {
    let value = retry_after.map(str::trim).unwrap_or_default();
    let asked = value.parse::<u64>().ok().map(Duration::from_secs).or_else(|| {
        let at = chrono::DateTime::parse_from_rfc2822(value).ok()?;
        let at = SystemTime::UNIX_EPOCH + Duration::from_secs(at.timestamp().max(0) as u64);
        Some(at.duration_since(now).unwrap_or_default())
    });
    asked.map(|wait| wait.min(MAX_WAIT))
}

/// How long automatic checks wait after a 429: the server's wait, at least
/// five minutes and at most an hour (five minutes when it gave none).
pub(crate) fn wait(retry_after: Option<&str>, now: SystemTime) -> Duration {
    server_wait(retry_after, now).unwrap_or(MIN_WAIT).clamp(MIN_WAIT, MAX_WAIT)
}

/// A rate limit for one profile and account: when automatic checks, and when
/// a manual Refresh, may ask again.
#[derive(Clone, Copy)]
struct Block {
    automatic: Instant,
    manual: Instant,
}

fn blocks() -> std::sync::MutexGuard<'static, HashMap<String, Block>> {
    static BLOCKS: OnceLock<Mutex<HashMap<String, Block>>> = OnceLock::new();
    BLOCKS.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner)
}

fn block_key(profile: &Profile) -> String {
    format!("{}|{}", profile.key, profile.account.as_deref().unwrap_or(""))
}

/// When the endpoint may be asked again, if it is still rate limited. A
/// manual Refresh honours only the server's own `Retry-After`; the five-minute
/// floor is for automatic checks.
pub(crate) fn blocked(profile: &Profile, now: Instant, manual: bool) -> Option<Instant> {
    let block = blocks().get(&block_key(profile)).copied()?;
    Some(if manual { block.manual } else { block.automatic }).filter(|at| *at > now)
}

/// A successful read ends the block for this profile and account.
pub(crate) fn unblock(profile: &Profile) {
    blocks().remove(&block_key(profile));
}

/// Records a 429 and returns when automatic checks may ask again.
pub(crate) fn block(profile: &Profile, now: Instant, retry_after: Option<&str>) -> Instant {
    let clock = SystemTime::now();
    let block = Block {
        automatic: now + wait(retry_after, clock),
        manual: now + server_wait(retry_after, clock).unwrap_or_default(),
    };
    blocks().insert(block_key(profile), block);
    block.automatic
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SavedWindow {
    label: String,
    used_percent: f64,
    resets_at: Option<String>,
    /// The reset as Claude Code printed it, when there is no timestamp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Saved {
    #[serde(default)]
    account: Option<String>,
    checked_at: u64,
    plan: Option<String>,
    source: Option<String>,
    windows: Vec<SavedWindow>,
}

type Readings = BTreeMap<String, Saved>;

fn load(dir: &Path) -> Readings {
    let path = dir.join(FILE);
    let small = std::fs::metadata(&path).is_ok_and(|meta| meta.len() <= FILE_LIMIT);
    let Some(bytes) = small.then(|| std::fs::read(&path).ok()).flatten() else {
        return Readings::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_else(|_| {
        eprintln!("Ignoring an unreadable saved Claude usage reading ({FILE}).");
        Readings::default()
    })
}

fn store(dir: &Path, readings: &Readings) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(readings).map_err(std::io::Error::other)?;
    if bytes.len() as u64 > FILE_LIMIT {
        return Err(std::io::Error::other("too large"));
    }
    crate::agent_usage_claude_store::write_file(&dir.join(FILE), &bytes)
}

/// Keeps a ready reading for this profile; the oldest profiles drop out.
pub(crate) async fn remember(profile: &Profile, usage: &Usage) {
    let known = profile.account.is_some() && usage.status == "ready" && !usage.stale;
    let Some(dir) = profile.dir.clone().filter(|_| known) else {
        return;
    };
    let saved = Saved {
        account: profile.account.clone(),
        checked_at: usage.checked_at,
        plan: usage.plan.clone(),
        source: usage.source.clone(),
        windows: usage.windows.iter().take(WINDOWS).map(|w| SavedWindow {
            label: w.label.chars().take(80).collect(),
            used_percent: w.used_percent,
            resets_at: w.resets_at.clone(),
            detail: w.detail.as_ref().map(|detail| detail.chars().take(80).collect()),
        }).collect(),
    };
    let key = profile.key.clone();
    let _ = tokio::task::spawn_blocking(move || {
        static WRITE: Mutex<()> = Mutex::new(());
        let _write = WRITE.lock().unwrap_or_else(PoisonError::into_inner);
        let mut readings = load(&dir);
        readings.insert(key, saved);
        while readings.len() > PROFILES {
            let oldest = readings.iter().min_by_key(|(_, s)| s.checked_at).map(|(k, _)| k.clone());
            oldest.map(|key| readings.remove(&key));
        }
        if let Err(error) = store(&dir, &readings) {
            eprintln!("Could not save the last Claude usage reading: {error}");
        }
    })
    .await;
}

/// This profile's saved reading, marked stale, when it was taken with the
/// account signed in now (a known one).
pub(crate) async fn saved_reading(profile: &Profile) -> Option<Usage> {
    let account = profile.account.clone()?;
    let (dir, key) = (profile.dir.clone()?, profile.key.clone());
    let saved = tokio::task::spawn_blocking(move || load(&dir).remove(&key))
        .await
        .ok()
        .flatten()
        .filter(|saved| saved.account.as_deref() == Some(account.as_str()))?;
    let mut usage = Usage::empty("claude", "ready", "");
    usage.stale = true;
    usage.checked_at = saved.checked_at;
    usage.plan = saved.plan;
    usage.source = saved.source;
    usage.dashboard_url = Some("https://claude.ai/settings/usage".into());
    usage.windows = saved
        .windows
        .into_iter()
        .map(|w| UsageWindow { detail: w.detail, ..UsageWindow::new(w.label, w.used_percent, w.resets_at) })
        .collect();
    Some(usage)
}

/// Makes `profile`'s saved reading `ago` older (tests).
#[cfg(test)]
pub(crate) async fn age_saved(profile: &Profile, ago: Duration) {
    let mut saved = saved_reading(profile).await.expect("a saved reading");
    saved.stale = false;
    saved.checked_at = saved.checked_at.saturating_sub(ago.as_millis() as u64);
    remember(profile, &saved).await;
}

/// `at` as ms since the epoch.
fn epoch_ms(at: Instant) -> u64 {
    let wall = SystemTime::now() + at.saturating_duration_since(Instant::now());
    wall.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// What a rate-limited check shows: the last good reading, marked stale, or
/// when there is none, that it is rate limited (`action: rateLimited`). The
/// times go to the panel as numbers, formatted in the user's locale:
/// `retryAt` when a Refresh may ask again (the server's own `Retry-After`),
/// `autoRetryAt` when an automatic check (opening the panel) will.
pub(crate) async fn rate_limited(profile: &Profile) -> Usage {
    let now = Instant::now();
    let block = blocks().get(&block_key(profile)).copied().unwrap_or(Block { automatic: now + MIN_WAIT, manual: now });
    let mut usage = match saved_reading(profile).await {
        Some(mut usage) => {
            usage.message = Some("Claude's usage service is rate limited; showing the last good reading.".into());
            usage
        }
        None => Usage::empty("claude", "error", "Claude's usage service is rate limited, and there is no earlier reading for this account."),
    };
    usage.action = Some("rateLimited");
    usage.retry_at = Some(epoch_ms(block.manual));
    usage.auto_retry_at = Some(epoch_ms(block.automatic));
    usage
}

/// Any other transient error (status `error`, nothing to show) brings back
/// the saved reading, marked stale, with the error as its message. Signed
/// out, unavailable and another account's reading never do.
pub(crate) async fn or_saved(profile: &Profile, result: Usage) -> Usage {
    if result.status != "error" || !result.windows.is_empty() {
        return result;
    }
    match saved_reading(profile).await {
        Some(saved) => saved.standing_in_for(&result),
        None => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unreadable_install_key_is_not_replaced() {
        let dir = std::env::temp_dir().join(format!("pandacode-claude-key-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(KEY_FILE)).unwrap(); // reading it fails, but it exists
        assert_eq!(Profile::new("p", Some("me@example.com".into()), Some(dir.clone())).account, None);
        assert!(dir.join(KEY_FILE).is_dir(), "left alone");
        std::fs::remove_dir(dir.join(KEY_FILE)).unwrap();
        std::fs::write(dir.join(KEY_FILE), b"short").unwrap();
        assert_eq!(Profile::new("p", Some("me@example.com".into()), Some(dir.clone())).account, None);
        assert_eq!(std::fs::read(dir.join(KEY_FILE)).unwrap(), b"short", "not overwritten");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retry_after_is_read_as_seconds_or_a_date_and_clamped() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        assert_eq!(wait(Some("900"), now), Duration::from_secs(900));
        assert_eq!(wait(Some("1"), now), MIN_WAIT);
        assert_eq!(wait(Some("86400"), now), MAX_WAIT);
        assert_eq!(wait(None, now), MIN_WAIT);
        assert_eq!(wait(Some("soon"), now), MIN_WAIT);
        // 1_800_000_000 is Fri, 15 Jan 2027 08:00:00 GMT.
        assert_eq!(wait(Some("Fri, 15 Jan 2027 08:20:00 GMT"), now), Duration::from_secs(1200));
        assert_eq!(wait(Some("Fri, 15 Jan 2027 07:00:00 GMT"), now), MIN_WAIT);
    }

    #[test]
    fn a_rate_limit_is_per_account_and_a_manual_refresh_honours_only_the_servers_wait() {
        let profile = Profile { key: format!("p-{}", uuid::Uuid::new_v4()), account: Some("a".into()), dir: None };
        let now = Instant::now();
        let automatic = block(&profile, now, Some("30"));
        assert_eq!(automatic, now + MIN_WAIT, "automatic checks wait at least five minutes");
        assert!(blocked(&profile, now + Duration::from_secs(10), true).is_some(), "before Retry-After");
        assert_eq!(blocked(&profile, now + Duration::from_secs(31), true), None, "a manual refresh may ask once it passed");
        assert!(blocked(&profile, now + Duration::from_secs(31), false).is_some(), "an automatic one may not");
        let other = Profile { account: Some("b".into()), ..profile.clone() };
        assert_eq!(blocked(&other, now, false), None, "another account on the same profile is not blocked");
    }

    #[tokio::test]
    async fn the_last_reading_survives_a_restart_and_stays_bounded() {
        let dir = std::env::temp_dir().join(format!("pandacode-claude-limits-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let profile = Profile::new("/Users/me/.claude|Claude Code-credentials", Some("me@example.com".into()), Some(dir.clone()));
        let key = std::fs::read(dir.join(KEY_FILE)).unwrap();
        assert_eq!(key.len(), 32);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join(KEY_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(Profile::new("x", Some(" ME@example.com".into()), Some(dir.clone())).account, profile.account, "one key per install");
        assert_ne!(profile.account.as_deref(), Some(hash("me@example.com").as_str()), "keyed, not a bare hash");
        assert_ne!(profile.key, hash("/Users/me/.claude|Claude Code-credentials"), "the profile key is keyed too");
        let mut usage = Usage::empty("claude", "ready", "");
        usage.windows = vec![UsageWindow::new("Weekly", 35.0, Some("2026-11-16T00:59:59Z".into()))];
        usage.plan = Some("Max".into());
        remember(&profile, &usage).await;
        block(&profile, Instant::now(), Some("30"));
        let shown = rate_limited(&profile).await;
        assert_eq!((shown.status.as_str(), shown.stale), ("ready", true));
        assert_eq!(shown.windows[0].used_percent, 35.0);
        assert!(shown.message.unwrap().contains("rate limited; showing the last good reading"));
        // A Refresh may ask after the server's 30 s; an automatic check after the 5-minute floor.
        let (manual, automatic) = (shown.retry_at.unwrap(), shown.auto_retry_at.unwrap());
        assert!(manual > shown.checked_at && automatic >= manual + 4 * 60_000, "{manual} {automatic}");
        assert_eq!(shown.action, Some("rateLimited"));
        // Another account signed in on the same profile never sees it.
        let switched = Profile { account: Profile::new("", Some("other@example.com".into()), Some(dir.clone())).account, ..profile.clone() };
        let other_account = rate_limited(&switched).await;
        assert_eq!((other_account.status.as_str(), other_account.windows.len()), ("error", 0));
        assert!(other_account.retry_at.is_some());
        let file = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(!file.contains("/Users/me") && !file.contains("me@example.com"), "no paths, no emails, no secrets");
        // Another transient error brings the reading back with its own message.
        let errored = or_saved(&profile, Usage::empty("claude", "error", "Couldn't read the Keychain.")).await;
        assert_eq!((errored.stale, errored.windows.len(), errored.message.as_deref()), (true, 1, Some("Couldn't read the Keychain.")));
        let signed_out = or_saved(&profile, Usage::empty("claude", "signedOut", "Sign in.")).await;
        assert!(signed_out.windows.is_empty(), "never for a signed-out login");
        // Without a known account nothing is shown, even for the same profile.
        let unknown = Profile { account: None, ..profile.clone() };
        assert!(or_saved(&unknown, Usage::empty("claude", "error", "x")).await.windows.is_empty());
        for n in 0..40 {
            usage.checked_at = n;
            remember(&Profile::new(&format!("p{n}"), Some(format!("p{n}@example.com")), Some(dir.clone())), &usage).await;
        }
        assert_eq!(load(&dir).len(), PROFILES);
        std::fs::write(dir.join(FILE), b"{not json").unwrap();
        assert!(load(&dir).is_empty(), "a malformed file is ignored");
        let other = Profile::new("never-read", Some("me@example.com".into()), Some(dir.clone()));
        let empty = rate_limited(&other).await;
        assert_eq!(empty.status, "error");
        assert!(empty.windows.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
