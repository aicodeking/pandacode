use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const SESSION_COOKIE: &str = "__Host-pandacode_session";
pub const CSRF_COOKIE: &str = "pandacode_csrf";
pub const SESSION_TTL: Duration = Duration::from_secs(12 * 60 * 60);
pub const PAIRING_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    csrf_hash: [u8; 32],
    expires_at: Option<Instant>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    id: String,
    remaining_seconds: Option<u64>,
}

impl Session {
    fn new(ttl: Option<Duration>) -> Result<(Self, String), &'static str> {
        let id = random_token()?;
        let csrf = random_token()?;
        Ok((
            Self {
                id,
                csrf_hash: hash(&csrf),
                expires_at: ttl.map(|ttl| Instant::now() + ttl),
            },
            csrf,
        ))
    }

    pub(crate) fn management_id(&self) -> String {
        URL_SAFE_NO_PAD.encode(hash(&self.id))
    }

    pub(crate) fn remaining_seconds(&self, now: Instant) -> Option<u64> {
        self.expires_at.map(|expiry| expiry.saturating_duration_since(now).as_secs())
    }

    pub fn valid(&self, now: Instant) -> bool {
        self.expires_at.is_none_or(|expiry| now < expiry)
    }

    pub fn check_csrf(&self, csrf: &str, now: Instant) -> Result<(), &'static str> {
        if !self.valid(now) {
            return Err("expired session");
        }
        if !constant_time_eq(&self.csrf_hash, &hash(csrf)) {
            return Err("invalid csrf token");
        }
        Ok(())
    }
}

pub struct SessionStore {
    sessions: HashMap<String, Session>,
    ttl: Option<Duration>,
    observed: HashMap<[u8; 32], String>,
    durable: Option<(rusqlite::Connection, [u8; 32])>,
}

impl Default for SessionStore {
    fn default() -> Self {
        Self { sessions: HashMap::new(), ttl: Some(SESSION_TTL), observed: HashMap::new(), durable: None }
    }
}

pub(crate) fn session_ttl(setting: &str) -> Result<Option<Duration>, String> {
    let hours = match setting {
        "12h" => 12,
        "24h" => 24,
        "2d" => 48,
        "7d" => 168,
        "none" => return Ok(None),
        _ => return Err("PANDACODE_WEB_SESSION_LIMIT must be 12h, 24h, 2d, 7d, or none.".into()),
    };
    Ok(Some(Duration::from_secs(hours * 3600)))
}

impl SessionStore {
    pub(crate) fn configured(
        ttl: Option<Duration>,
        path: &std::path::Path,
        origin: &str,
        password_hash: Option<&[u8; 32]>,
    ) -> Result<Self, String> {
        let mut store = Self { ttl, ..Self::default() };
        let open_error = |_| "Could not open persistent web sessions.";
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        if let Err(err) = options.open(path) {
            if err.kind() != std::io::ErrorKind::AlreadyExists {
                return Err("Could not create persistent web sessions.".into());
            }
        }
        let mut db = rusqlite::Connection::open(path).map_err(open_error)?;
        let tx = db.transaction().map_err(open_error)?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS session_scope (id INTEGER PRIMARY KEY CHECK(id=1), scope BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS web_sessions (id_hash BLOB PRIMARY KEY NOT NULL, csrf_hash BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS session_policy (id INTEGER PRIMARY KEY CHECK(id=1), setting TEXT NOT NULL);"
        ).map_err(open_error)?;
        let mut scope = Sha256::new();
        scope.update(b"pandacode-web-session-v1\0");
        scope.update(origin.as_bytes());
        scope.update([0, u8::from(password_hash.is_some()), u8::from(ttl.is_none())]);
        if let Some(password) = password_hash {
            scope.update(password);
        }
        let scope: [u8; 32] = scope.finalize().into();
        let changed = tx.execute(
            "INSERT INTO session_scope VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope WHERE scope != excluded.scope",
            [&scope[..]],
        ).map_err(open_error)?;
        if changed != 0 {
            tx.execute_batch("DELETE FROM web_sessions; DELETE FROM session_policy;").map_err(open_error)?;
        }
        use rusqlite::OptionalExtension as _;
        let setting: Option<String> = tx.query_row(
            "SELECT setting FROM session_policy WHERE id=1", [], |row| row.get(0),
        ).optional().map_err(open_error)?;
        if let Some(setting) = setting {
            store.ttl = session_ttl(&setting)?;
        }
        tx.commit().map_err(open_error)?;
        store.durable = Some((db, scope));
        Ok(store)
    }

    pub(crate) fn limit_seconds(&self) -> Option<u64> {
        self.ttl.map(|ttl| ttl.as_secs())
    }

    pub(crate) fn cookie_max_age(&self) -> u64 {
        // Browsers cap persistent cookies independently; this is not a server deadline.
        self.ttl.unwrap_or(Duration::from_secs(400 * 24 * 3600)).as_secs()
    }

    pub fn create(&mut self) -> Result<(Session, String), &'static str> {
        let (session, csrf) = Session::new(self.ttl)?;
        if let Some((db, scope)) = self.durable.as_ref().filter(|_| self.ttl.is_none()) {
            let written = db.execute(
                "INSERT INTO web_sessions SELECT ?1, ?2 FROM session_scope WHERE scope=?3",
                [&hash(&session.id)[..], &session.csrf_hash[..], &scope[..]],
            ).map_err(|_| "could not persist session")?;
            if written != 1 {
                return Err("persistent session configuration changed");
            }
        } else {
            self.sessions.insert(session.id.clone(), session.clone());
        }
        Ok((session, csrf))
    }

    pub fn authenticate(&self, id: &str, now: Instant) -> Result<Session, &'static str> {
        if let Some(session) = self.sessions.get(id) {
            return if session.valid(now) { Ok(session.clone()) } else { Err("expired session") };
        }
        if let Some((db, scope)) = &self.durable {
            let csrf: Vec<u8> = db.query_row(
                "SELECT csrf_hash FROM web_sessions WHERE id_hash=?1 AND EXISTS (SELECT 1 FROM session_scope WHERE scope=?2)",
                [&hash(id)[..], &scope[..]], |row| row.get(0),
            ).map_err(|_| "unauthenticated session")?;
            return Ok(Session {
                id: id.to_owned(),
                csrf_hash: csrf.try_into().map_err(|_| "unauthenticated session")?,
                expires_at: None,
            });
        }
        Err("unauthenticated session")
    }

    pub fn authenticate_csrf(
        &self,
        id: &str,
        csrf: &str,
        now: Instant,
    ) -> Result<Session, &'static str> {
        let session = self.authenticate(id, now)?;
        session.check_csrf(csrf, now)?;
        Ok(session)
    }

    pub fn remove(&mut self, id: &str) -> Result<(), &'static str> {
        if let Some((db, scope)) = &self.durable {
            db.execute("DELETE FROM web_sessions WHERE id_hash=?1 AND EXISTS (SELECT 1 FROM session_scope WHERE scope=?2)", [&hash(id)[..], &scope[..]])
                .map_err(|_| "could not revoke persistent session")?;
        }
        self.observed.remove(&hash(id));
        self.sessions.remove(id);
        Ok(())
    }

    pub(crate) fn set_limit(&mut self, setting: &str) -> Result<(), String> {
        let ttl = session_ttl(setting)?;
        let (db, scope) = self.durable.as_ref().ok_or("Session settings are unavailable.")?;
        let written = db.execute(
            "INSERT INTO session_policy SELECT 1, ?1 FROM session_scope WHERE scope=?2
             ON CONFLICT(id) DO UPDATE SET setting=excluded.setting",
            rusqlite::params![setting, &scope[..]],
        ).map_err(|_| "Could not save session duration.")?;
        if written != 1 {
            return Err("Session configuration changed.".into());
        }
        self.ttl = ttl;
        Ok(())
    }

    pub(crate) fn observe(&mut self, session: &Session) {
        if session.expires_at.is_none() {
            self.observed.insert(hash(&session.id), session.id.clone());
        }
    }

    pub(crate) fn list(&self, now: Instant) -> Result<Vec<SessionSummary>, String> {
        let mut sessions = self.sessions.values().filter(|session| session.valid(now))
            .map(|session| SessionSummary {
                id: session.management_id(),
                remaining_seconds: session.remaining_seconds(now),
            }).collect::<Vec<_>>();
        if let Some((db, scope)) = &self.durable {
            let error = |_| "Could not list browser sessions.";
            let mut query = db.prepare(
                "SELECT id_hash FROM web_sessions WHERE EXISTS (SELECT 1 FROM session_scope WHERE scope=?1)",
            ).map_err(error)?;
            let rows = query.query_map([&scope[..]], |row| row.get::<_, Vec<u8>>(0)).map_err(error)?;
            for row in rows {
                sessions.push(SessionSummary {
                    id: URL_SAFE_NO_PAD.encode(row.map_err(error)?),
                    remaining_seconds: None,
                });
            }
        }
        sessions.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(sessions)
    }

    pub(crate) fn revoke_by_id(&mut self, id: &str) -> Result<Option<String>, String> {
        let key: [u8; 32] = URL_SAFE_NO_PAD.decode(id).ok()
            .and_then(|bytes| bytes.try_into().ok()).ok_or("Invalid browser session ID.")?;
        let active = self.observed.get(&key).cloned()
            .or_else(|| self.sessions.keys().find(|raw| hash(raw) == key).cloned());
        if let Some(raw) = &active {
            self.remove(raw)?;
        } else if let Some((db, scope)) = &self.durable {
            db.execute(
                "DELETE FROM web_sessions WHERE id_hash=?1 AND EXISTS (SELECT 1 FROM session_scope WHERE scope=?2)",
                [&key[..], &scope[..]],
            ).map_err(|_| "Could not revoke browser session.")?;
        }
        Ok(active)
    }

    #[cfg(test)]
    pub(crate) fn expire_for_test(&mut self, id: &str) -> bool {
        let Some(session) = self.sessions.get_mut(id) else {
            return false;
        };
        session.expires_at = Some(Instant::now());
        true
    }

    /// Removes expired session records and returns their opaque ids so the gateway can revoke
    /// session-scoped resources and request identities under the same lifecycle boundary.
    pub fn remove_expired(&mut self, now: Instant) -> Vec<String> {
        let expired = self
            .sessions
            .iter()
            .filter_map(|(id, session)| (!session.valid(now)).then_some(id.clone()))
            .collect::<Vec<_>>();
        for id in &expired {
            self.sessions.remove(id);
        }
        expired
    }
}

#[derive(Default)]
pub struct Pairing {
    token_hash: Option<[u8; 32]>,
    expires_at: Option<Instant>,
    failed_attempts: u8,
    blocked_until: Option<Instant>,
    paired_once: bool,
}

impl Pairing {
    pub fn issue(&mut self) -> Result<(String, u64), &'static str> {
        let token = random_token()?;
        self.token_hash = Some(hash(&token));
        self.expires_at = Some(Instant::now() + PAIRING_TTL);
        self.failed_attempts = 0;
        self.blocked_until = None;
        Ok((token, unix_seconds().saturating_add(PAIRING_TTL.as_secs())))
    }

    pub fn consume(&mut self, token: &str, now: Instant) -> Result<(), &'static str> {
        if self.blocked_until.is_some_and(|until| now < until) {
            return Err("pairing temporarily locked");
        }
        let valid = self.expires_at.is_some_and(|expires| now < expires)
            && self
                .token_hash
                .as_ref()
                .is_some_and(|expected| constant_time_eq(expected, &hash(token)));
        if !valid {
            self.failed_attempts = self.failed_attempts.saturating_add(1);
            if self.failed_attempts >= 8 {
                self.blocked_until = Some(now + Duration::from_secs(60));
                self.failed_attempts = 0;
            }
            return Err("invalid or expired pairing token");
        }
        self.token_hash = None;
        self.expires_at = None;
        self.failed_attempts = 0;
        self.paired_once = true;
        Ok(())
    }

    pub fn paired(&self) -> bool {
        self.paired_once
    }
}

pub fn random_token() -> Result<String, &'static str> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "secure random source unavailable")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub(crate) fn read_password_file(origin: &str, path: &std::path::Path) -> Result<[u8; 32], String> {
    use std::io::Read as _;
    if !origin.starts_with("https://") {
        return Err("Password sign-in requires an HTTPS web gateway origin.".into());
    }
    let meta = std::fs::metadata(path).map_err(|_| "Could not open web gateway password file.")?;
    if !meta.is_file() || meta.len() >= 128 {
        return Err("Web gateway password must be a small regular file.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err("Web gateway password file must not be accessible to group or others.".into());
        }
    }
    let file = std::fs::File::open(path).map_err(|_| "Could not open web gateway password file.")?;
    let mut value = String::new();
    file.take(128).read_to_string(&mut value).map_err(|_| "Could not read web gateway password file.")?;
    if value.len() >= 128 {
        return Err("Web gateway password file is too large.".into());
    }
    password_hash(value.trim_end_matches(['\r', '\n']))
}

/// Instance passwords are generated 256-bit secrets, not human-chosen passwords.
pub(crate) fn password_hash(value: &str) -> Result<[u8; 32], String> {
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| "Invalid web gateway password format.")?;
    if bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&bytes) != value {
        return Err("Web gateway password must be 32 random bytes encoded as unpadded base64url.".into());
    }
    Ok(hash(value))
}

impl Pairing {
    pub(crate) fn verify_password(&mut self, expected: &[u8; 32], value: &str, now: Instant) -> bool {
        if self.blocked_until.is_some_and(|until| now < until) {
            return false;
        }
        if constant_time_eq(expected, &hash(value)) {
            self.failed_attempts = 0;
            return true;
        }
        self.failed_attempts = self.failed_attempts.saturating_add(1);
        if self.failed_attempts >= 8 {
            self.blocked_until = Some(now + Duration::from_secs(60));
            self.failed_attempts = 0;
        }
        false
    }
}

pub fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn hash(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter()
        .zip(b)
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_limits_use_matching_cookie_and_server_deadlines() {
        for (setting, hours) in [("12h", 12), ("24h", 24), ("2d", 48), ("7d", 168)] {
            let ttl = session_ttl(setting).unwrap();
            let mut store = SessionStore { ttl, ..SessionStore::default() };
            let (session, _) = store.create().unwrap();
            assert_eq!(store.cookie_max_age(), hours * 3600);
            let expiry = session.expires_at.unwrap();
            assert_eq!(session.remaining_seconds(expiry - Duration::from_secs(1)), Some(1));
            assert_eq!(session.remaining_seconds(expiry), Some(0));
            assert!(session.valid(expiry - Duration::from_secs(1)));
            assert!(!session.valid(expiry));
        }
        assert!(session_ttl("0").is_err());
    }

    #[test]
    fn host_policy_and_individual_revocation_preserve_other_sessions() {
        let path = std::env::temp_dir().join(format!("panda-policy-test-{}.sqlite3", random_token().unwrap()));
        let open = || SessionStore::configured(None, &path, "https://panda.test", Some(&[8; 32])).unwrap();
        let mut store = open();
        let (first, csrf) = store.create().unwrap();
        let (second, _) = store.create().unwrap();
        store.set_limit("2d").unwrap();
        assert!(store.set_limit("bad").is_err());
        let (finite, _) = store.create().unwrap();
        assert_eq!(store.cookie_max_age(), 172800);
        assert!(finite.expires_at.is_some());
        assert_eq!(store.list(Instant::now()).unwrap().len(), 3);
        assert_ne!(first.management_id(), first.id);
        drop(store);

        let mut store = open();
        let now = Instant::now();
        assert_eq!(store.limit_seconds(), Some(172800));
        assert!(store.authenticate(&finite.id, now).is_err());
        let authenticated = store.authenticate_csrf(&first.id, &csrf, now).unwrap();
        store.observe(&authenticated);
        assert_eq!(store.revoke_by_id(&first.management_id()).unwrap(), Some(first.id.clone()));
        assert!(store.authenticate(&first.id, now).is_err());
        assert!(store.authenticate(&second.id, now).is_ok());
        assert_eq!(store.revoke_by_id(&second.management_id()).unwrap(), None);
        assert_eq!(store.list(now).unwrap().len(), 0);
        drop(store);
        assert!(open().list(now).unwrap().is_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn unlimited_sessions_survive_restart_but_not_logout_or_configuration_changes() {
        let path = std::env::temp_dir().join(format!("panda-session-test-{}.sqlite3", random_token().unwrap()));
        let origin = "https://panda.test";
        let password = [8u8; 32];
        let mut store = SessionStore::configured(session_ttl("none").unwrap(), &path, origin, Some(&password)).unwrap();
        let (first, csrf) = store.create().unwrap();
        let (second, _) = store.create().unwrap();
        assert!(first.expires_at.is_none());
        assert_eq!(store.cookie_max_age(), 400 * 24 * 3600);
        drop(store);
        let mut restarted = SessionStore::configured(None, &path, origin, Some(&password)).unwrap();
        let later = Instant::now() + Duration::from_secs(401 * 24 * 3600);
        assert!(restarted.authenticate_csrf(&first.id, &csrf, later).is_ok());
        assert!(restarted.authenticate_csrf(&first.id, "wrong", later).is_err());
        restarted.remove(&first.id).unwrap();
        drop(restarted);
        let restarted = SessionStore::configured(None, &path, origin, Some(&password)).unwrap();
        assert!(restarted.authenticate(&first.id, later).is_err());
        assert!(restarted.authenticate(&second.id, later).is_ok());
        let rotated = SessionStore::configured(None, &path, origin, Some(&[9u8; 32])).unwrap();
        assert!(rotated.authenticate(&second.id, later).is_err());
        assert!(restarted.authenticate(&second.id, later).is_err());
        drop(rotated);
        drop(restarted);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn password_file_requires_https_and_valid_secret() {
        use std::io::Write as _;
        let path = std::env::temp_dir().join(format!("panda-password-test-{}", random_token().unwrap()));
        assert!(read_password_file("https://panda.test", &path).is_err());
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let password = random_token().unwrap();
        writeln!(options.open(&path).unwrap(), "{password}").unwrap();
        assert!(read_password_file("http://panda.test", &path).is_err());
        assert_eq!(read_password_file("https://panda.test", &path).unwrap(), password_hash(&password).unwrap());
        std::fs::write(&path, "bad-password").unwrap();
        assert!(read_password_file("https://panda.test", &path).is_err());
        std::fs::write(&path, [b'a'; 128]).unwrap();
        assert!(read_password_file("https://panda.test", &path).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn instance_password_is_reusable_and_rate_limited() {
        let password = URL_SAFE_NO_PAD.encode([7u8; 32]);
        let expected = password_hash(&password).unwrap();
        assert!(password_hash("short").is_err());
        let now = Instant::now();
        let mut limiter = Pairing::default();
        assert!(limiter.verify_password(&expected, &password, now));
        assert!(limiter.verify_password(&expected, &password, now));
        for _ in 0..8 {
            assert!(!limiter.verify_password(&expected, "wrong", now));
        }
        assert!(!limiter.verify_password(&expected, &password, now));
        assert!(limiter.verify_password(&expected, &password, now + Duration::from_secs(60)));
    }

    #[test]
    fn sessions_are_server_generated_expire_and_require_csrf() {
        let mut sessions = SessionStore::default();
        let (session, csrf) = sessions.create().unwrap();
        assert!(session.valid(Instant::now()));
        assert!(sessions
            .authenticate_csrf(&session.id, &csrf, Instant::now())
            .is_ok());
        assert!(sessions
            .authenticate_csrf(&session.id, "wrong", Instant::now())
            .is_err());
        assert!(!session.valid(session.expires_at.unwrap()));
    }

    #[test]
    fn expired_sessions_are_removed_without_touching_live_sessions() {
        let mut sessions = SessionStore::default();
        let (expired, _) = sessions.create().unwrap();
        let (live, _) = sessions.create().unwrap();
        sessions.sessions.get_mut(&expired.id).unwrap().expires_at = Some(Instant::now());

        assert_eq!(
            sessions.remove_expired(Instant::now()),
            vec![expired.id.clone()]
        );
        assert!(sessions.authenticate(&expired.id, Instant::now()).is_err());
        assert!(sessions.authenticate(&live.id, Instant::now()).is_ok());
    }

    #[test]
    fn pairing_tokens_are_single_use() {
        let mut pairing = Pairing::default();
        let (token, _) = pairing.issue().unwrap();
        assert!(pairing.consume(&token, Instant::now()).is_ok());
        assert!(pairing.consume(&token, Instant::now()).is_err());
        assert!(pairing.paired());
    }
}
