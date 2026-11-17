//! Held credentials used without being read, and account switching (`credentials.use`, runtime slice R0805).
//!
//! PandaCode holds credentials a package may want to use: a provider key, a saved connection's secret, a bot token, a
//! cloud key. ADR-0006 decides that the value of such a credential is never handed to a package: there is no
//! `credentials.read`. A package that holds `credentials.use` for an item may ask the host to attach that credential
//! to a request the package declared (`source: "held"` in a connection, see `runtime_connection_adapters.rs`), and may
//! ask the host to switch the active account of a harness (`panda.harnesses.switchAccount`). Both are host operations.
//!
//! Rules (docs/extensions/runtime-held-credentials.md):
//! - The grant is per item (`provider:glm`, `connection:<id>`, `bot:<id>`, `cloud:<name>`, `deploy:<name>`, `speech`,
//!   `github`). It is rechecked natively on every use through `RuntimeGrants::begin`, so a revoke, a narrowing that
//!   drops the item, untrust, disable, a stale version and safe mode answer `PermissionDenied`, and a request in flight
//!   when that happens ends as `PermissionDenied` with no output.
//! - Every use appends one entry to the package's activity list: the credential item, the destination address (origin
//!   and path, never the query) and the package. Never the value. When the entry cannot be written, the use does not
//!   happen (`HostUnavailable`), so no use goes unrecorded.
//! - The value goes from the host's own stores to the HTTP transport and nowhere else: not to the service, a panel, a
//!   log, a projection or an error. A credential found in a JSON answer is replaced by the adapter.
//! - Account switching names an id of the `accounts` resource (`default`, or a saved connection of the harness). It
//!   needs `credentials.use` for the account's item (`provider:<harness>` for `default`, `connection:<id>`), changes
//!   which account is active and nothing else: no credential is returned, written or replaced. The choice is a small
//!   file under the app data directory (independent of SQLite); the `accounts` resource reads `active` from it, so its
//!   revision changes with the switch, and a task without an assignment of its own launches with the active account.
//! - The webview may read the activity list (main window only); it never receives a value.
use crate::extensions::{runtime_grants::{RuntimeGrants, Target}, runtime_service_lifetime::{runtime_usage_resources, DispatchRequest}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::{Path, PathBuf}, sync::{Arc, OnceLock}, time::{SystemTime, UNIX_EPOCH}};

type Reply = Result<Value, &'static str>;

/// The permission a package must hold, for each item it uses.
pub const PERMISSION: &str = "credentials.use";
/// Entries kept per package; the oldest go first.
pub const MAX_ENTRIES: usize = 100;
const DIRECTORY: &str = "extension-held-credentials-v1";
const ACTIVE_FILE: &str = "active.json";
const ACTIVITY_FILE: &str = "activity.json";
const LABEL: &str = "held credential records";
/// The account every harness has without a saved connection: its own setup.
pub const DEFAULT_ACCOUNT: &str = "default";

/// A held credential id: `provider:<harness>`, `connection:<id>`, `bot:<id>`, `deploy:<name>`, `cloud:<name>`, or
/// `speech` / `github`. Not a contribution id: the colon is part of the vocabulary.
pub fn valid_item(item: &str) -> bool {
    match item.split_once(':') {
        None => matches!(item, "speech" | "github"),
        Some((kind, id)) => matches!(kind, "provider" | "connection" | "bot" | "deploy" | "cloud")
            && (1..=64).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte)),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The host's credential stores, read only by the host.

/// Where a held credential's value comes from. Implemented by the host's own stores and by tests; nothing that holds
/// a `Held` hands a value to a package.
pub trait Held: Send + Sync {
    fn value(&self, item: &str) -> Option<String>;
}

/// The app's own stores.
pub struct Live;
impl Held for Live {
    fn value(&self, item: &str) -> Option<String> {
        let (kind, id) = item.split_once(':')?;
        let value = match kind {
            "provider" => match id {
                "glm" => crate::provider_settings::glm_key(),
                "mimo" => crate::provider_settings::mimo_key(),
                "alibaba" => crate::provider_settings::alibaba_key(),
                "deepseek" => crate::provider_settings::deepseek_key(),
                "commandcode" => crate::provider_settings::commandcode_key(),
                _ => return None,
            }.ok().flatten(),
            "connection" => crate::connections::held_secret(id),
            "bot" => crate::bots::held_token(id),
            "cloud" => crate::cloud::secret(&format!("{id}_key")).or_else(|| crate::cloud::secret(&format!("{id}_token"))),
            _ => None,
        };
        value.filter(|value| !value.is_empty())
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The records: the activity list and the active account of each harness.

/// One line of a package's activity list. There is no field for a value.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub at: u64,
    /// `credential.use` or `account.switch`.
    pub kind: String,
    pub item: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    pub package: String,
    pub version: String,
}
type Ledger = BTreeMap<String, Vec<Entry>>;

/// The active account of one harness and who chose it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Active { pub account: String, pub package: String, pub at: u64 }
type ActiveMap = BTreeMap<String, Active>;

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64) }

/// The two small files of this slice. The live instance finds the app data directory when it is used.
#[derive(Clone, Default)]
pub struct Files { dir: Option<PathBuf> }
impl Files {
    pub fn live() -> Self { Self { dir: None } }
    pub fn open(dir: &Path) -> Self { Self { dir: Some(dir.join(DIRECTORY)) } }
    fn root(&self) -> Option<PathBuf> { self.dir.clone().or_else(|| crate::secret_store::dir().map(|dir| dir.join(DIRECTORY))) }
    fn read<T: serde::de::DeserializeOwned + Default>(&self, file: &str) -> Option<T> {
        let root = self.root()?;
        crate::secret_store::load::<T>(&root.join(file), LABEL).ok()
    }
    fn change<T: Serialize + serde::de::DeserializeOwned + Default + PartialEq>(&self, file: &str, change: impl FnOnce(T) -> T) -> Result<(), &'static str> {
        let root = self.root().ok_or("HostUnavailable")?;
        std::fs::create_dir_all(&root).map_err(|_| "HostUnavailable")?;
        crate::secret_store::update::<T>(&root, file, LABEL, change).map_err(|_| "HostUnavailable")
    }

    /// Appends one entry to the package's list; the list keeps the newest `MAX_ENTRIES`.
    pub fn record(&self, entry: Entry) -> Result<(), &'static str> {
        self.change::<Ledger>(ACTIVITY_FILE, |mut ledger| {
            let list = ledger.entry(entry.package.clone()).or_default();
            list.push(entry);
            let extra = list.len().saturating_sub(MAX_ENTRIES);
            list.drain(..extra);
            ledger
        })
    }
    /// The package's entries, newest first.
    pub fn activity(&self, package: &str) -> Vec<Entry> {
        let mut list = self.read::<Ledger>(ACTIVITY_FILE).and_then(|mut ledger| ledger.remove(package)).unwrap_or_default();
        list.reverse();
        list
    }
    /// Forgets a package's list (uninstall).
    pub fn forget(&self, package: &str) {
        let _ = self.change::<Ledger>(ACTIVITY_FILE, |mut ledger| { ledger.remove(package); ledger });
    }
    /// The account of `harness` that is active, `None` for its own setup.
    pub fn active(&self, harness: &str) -> Option<String> {
        self.read::<ActiveMap>(ACTIVE_FILE).and_then(|mut map| map.remove(harness)).map(|active| active.account).filter(|account| account != DEFAULT_ACCOUNT)
    }
}

/// The account of `harness` the user's extensions made active, in the app's data directory. `None`: its own setup.
pub fn active_account(harness: &str) -> Option<String> { Files::live().active(harness) }

/// The address a use is recorded with: scheme, host, port and path. The query is part of the declared address but
/// may carry identifiers, so the list does not keep it.
pub fn address_of(url: &reqwest::Url) -> String {
    let mut text = format!("{}://{}", url.scheme(), url.host_str().unwrap_or(""));
    if let Some(port) = url.port() { text.push_str(&format!(":{port}")); }
    text.push_str(url.path());
    text
}

// ---------------------------------------------------------------------------------------------------------------
// Using a held credential.

/// What the host needs to attach a held credential: where values come from and where uses are written.
pub struct HeldUse { values: Box<dyn Held>, files: Files }
impl HeldUse {
    pub fn new(values: Box<dyn Held>, files: Files) -> Self { Self { values, files } }
    pub fn live() -> Self { Self::new(Box::new(Live), Files::live()) }
    /// Whether the credential is held right now (a status answer). Never used to return anything about the value.
    pub fn has(&self, item: &str) -> bool { valid_item(item) && self.values.value(item).is_some() }
    /// The value for one request the host is about to send. The use is written first; when it cannot be, no value
    /// leaves the store. `NotFound`: PandaCode holds no such credential. The caller passes the value to the transport.
    pub fn use_credential(&self, package: &str, version: &str, item: &str, address: &str) -> Result<String, &'static str> {
        if !valid_item(item) { return Err("InvalidShape"); }
        let value = self.values.value(item).ok_or("NotFound")?;
        self.files.record(Entry { at: now(), kind: "credential.use".into(), item: item.into(), address: Some(address.into()), package: package.into(), version: version.into() })?;
        Ok(value)
    }
    pub fn files(&self) -> &Files { &self.files }
}

/// The app's one `HeldUse`.
pub fn shared() -> Arc<HeldUse> {
    static SHARED: OnceLock<Arc<HeldUse>> = OnceLock::new();
    SHARED.get_or_init(|| Arc::new(HeldUse::live())).clone()
}

/// The activation-time flow of `connections.rs` (a command's own start) uses a held credential through the same
/// grant, record and store as the service channel. The grant is checked here; the value only ever reaches the transport.
pub(in crate::extensions) fn use_from_app(app: &tauri::AppHandle, owner: &str, version: &str, item: &str, url: &reqwest::Url) -> Result<String, &'static str> {
    use tauri::Manager;
    app.state::<RuntimeGrants>().check(owner, version, PERMISSION, &Target::item(item)).map_err(|_| "PermissionDenied")?;
    shared().use_credential(owner, version, item, &address_of(url))
}

// ---------------------------------------------------------------------------------------------------------------
// Switching accounts.

/// The harnesses and accounts that exist. The live implementation reads the provider roster and the saved connections.
pub trait Roster {
    fn harness(&self, id: &str) -> bool;
    fn account(&self, harness: &str, account: &str) -> bool;
}
pub struct LiveRoster;
impl Roster for LiveRoster {
    fn harness(&self, id: &str) -> bool { crate::providers::PROVIDERS.iter().any(|(known, _)| *known == id) }
    fn account(&self, harness: &str, account: &str) -> bool { account == DEFAULT_ACCOUNT || crate::connections::pool_members(harness).iter().any(|connection| connection.id == account) }
}

/// The item whose grant lets a package switch to `account` of `harness`.
pub fn account_item(harness: &str, account: &str) -> String {
    if account == DEFAULT_ACCOUNT { format!("provider:{harness}") } else { format!("connection:{account}") }
}

/// `panda.harnesses.switchAccount({ harness, account })`: makes `account` (an id of the `accounts` resource) the active
/// account of `harness`. Resolves to `null`. It returns, writes and replaces no credential.
pub fn switch(grants: &RuntimeGrants, files: &Files, roster: &dyn Roster, owner: &str, version: &str, params: &Value) -> Reply {
    let object = params.as_object().ok_or("InvalidArguments")?;
    if object.keys().any(|key| key != "harness" && key != "account") { return Err("InvalidArguments"); }
    let harness = object.get("harness").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 64).ok_or("InvalidArguments")?;
    let account = object.get("account").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 128).ok_or("InvalidArguments")?;
    // Holding the permission at all comes first, so a package without it learns nothing about the accounts.
    if !holds(grants, owner, version) { return Err("PermissionDenied"); }
    if !roster.harness(harness) || !roster.account(harness, account) { return Err("NotFound"); }
    let item = account_item(harness, account);
    let work = grants.begin(owner, version, PERMISSION, &Target::item(&item)).map_err(|_| "PermissionDenied")?;
    let mut outcome: Result<(), &'static str> = Ok(());
    files.record(Entry { at: now(), kind: "account.switch".into(), item: item.clone(), address: None, package: owner.into(), version: version.into() })?;
    files.change::<ActiveMap>(ACTIVE_FILE, |mut map| {
        if work.is_cancelled() || grants.check(owner, version, PERMISSION, &Target::item(&item)).is_err() { outcome = Err("PermissionDenied"); return map; }
        if account == DEFAULT_ACCOUNT { map.remove(harness); } else { map.insert(harness.to_owned(), Active { account: account.to_owned(), package: owner.to_owned(), at: now() }); }
        map
    })?;
    outcome.map(|()| Value::Null)
}

/// `true` when the package holds `credentials.use` for any item.
fn holds(grants: &RuntimeGrants, owner: &str, version: &str) -> bool {
    grants.projection()["packages"].as_array().into_iter().flatten().any(|package| {
        package["id"] == owner && package["version"] == version && package["authorized"] == true
            && package["grants"].as_array().into_iter().flatten().any(|grant| grant["permission"] == PERMISSION)
    })
}

/// Serves `accountSwitch` from the duplex channel (`runtime_service_lifetime::app_dispatch`), blocking.
pub fn serve(app: &tauri::AppHandle, request: DispatchRequest) -> Value {
    use tauri::Manager;
    let result = (|| {
        let version = {
            let packages = app.state::<crate::extensions::packages::ExtensionPackages>();
            let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
            runtime_usage_resources::enabled_version(&packages, &request.owner).ok_or("PermissionDenied")?
        };
        switch(&app.state::<RuntimeGrants>(), &Files::live(), &LiveRoster, &request.owner, &version, &request.params)
    })();
    match result { Ok(value) => json!({"ok": true, "value": value}), Err(code) => crate::extensions::context::failure(code) }
}

/// The package's activity list as the webview may see it (main window only): items, addresses and times, never a value.
#[tauri::command]
pub fn extensions_credential_activity(window: tauri::WebviewWindow, id: String) -> Result<Value, String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    if id.is_empty() || id.len() > 128 { return Err("InvalidArguments".into()); }
    Ok(json!({"schemaVersion": 1, "package": id, "items": Files::live().activity(&id)}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::runtime_grants::Scope;

    const A: &str = "sample.held-credentials";
    const B: &str = "sample.other-package";
    /// Built from parts so this file never holds a realistic token; the tests look for it in every output.
    fn canary() -> String { ["canary", "held", "credential", "r0805"].join("-") }
    struct Dir(PathBuf);
    impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-held-credentials-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    struct Fake(BTreeMap<String, String>);
    impl Held for Fake { fn value(&self, item: &str) -> Option<String> { self.0.get(item).cloned() } }
    struct Accounts;
    impl Roster for Accounts {
        fn harness(&self, id: &str) -> bool { id == "claude" || id == "codex" }
        fn account(&self, harness: &str, account: &str) -> bool { account == DEFAULT_ACCOUNT || (harness == "claude" && (account == "work" || account == "personal")) }
    }
    fn grants(dir: &Dir) -> RuntimeGrants {
        let grants = RuntimeGrants::open(&dir.0);
        for id in [A, B] {
            grants.register_package(id, "1.0.0", &["runtime.service", PERMISSION], Some("digest")).unwrap();
            grants.trust(id, true).unwrap();
        }
        grants
    }
    fn items(list: &[&str]) -> Scope { Scope { items: Some(list.iter().map(|item| item.to_string()).collect()), ..Scope::default() } }
    fn held(dir: &Dir) -> HeldUse {
        let values = Fake(BTreeMap::from([("provider:glm".to_owned(), canary()), ("connection:work".to_owned(), format!("{}-work", canary()))]));
        HeldUse::new(Box::new(values), Files::open(&dir.0))
    }

    #[test]
    fn item_ids_follow_the_frozen_vocabulary() {
        for item in ["provider:glm", "connection:6f1c-22", "bot:abc", "deploy:vercel", "cloud:daytona", "speech", "github"] { assert!(valid_item(item), "{item}"); }
        for item in ["", "provider", "provider:", "provider:a b", "secret:x", "credentials.read", "github:x", "provider:../x", &"provider:".repeat(20)] { assert!(!valid_item(item), "{item}"); }
    }

    #[test]
    fn a_use_needs_the_item_and_writes_identity_address_and_package_but_never_the_value() {
        let dir = Dir::new(); let held = held(&dir);
        assert_eq!(held.use_credential(A, "1.0.0", "provider:glm", "http://127.0.0.1:4000/usage").unwrap(), canary());
        assert_eq!(held.use_credential(A, "1.0.0", "provider:openai", "http://127.0.0.1:4000/usage").unwrap_err(), "NotFound", "PandaCode holds nothing under that id");
        assert_eq!(held.use_credential(A, "1.0.0", "credentials.read", "x").unwrap_err(), "InvalidShape");
        let entries = held.files().activity(A);
        assert_eq!(entries.len(), 1, "only a use that happened is written: {entries:?}");
        let entry = &entries[0];
        assert_eq!((entry.kind.as_str(), entry.item.as_str(), entry.address.as_deref(), entry.package.as_str()), ("credential.use", "provider:glm", Some("http://127.0.0.1:4000/usage"), A));
        assert!(held.files().activity(B).is_empty(), "another package's list is its own");
        let on_disk = std::fs::read_to_string(dir.0.join(DIRECTORY).join(ACTIVITY_FILE)).unwrap();
        assert!(!on_disk.contains(&canary()), "the activity file holds no value");
        assert!(!serde_json::to_string(&entries).unwrap().contains(&canary()));
    }

    #[test]
    fn the_list_keeps_the_newest_entries_and_the_query_is_not_part_of_an_address() {
        let dir = Dir::new(); let held = held(&dir);
        let url = reqwest::Url::parse("https://api.example.com/v1/usage?account=1234#").unwrap();
        assert_eq!(address_of(&url), "https://api.example.com/v1/usage");
        for _ in 0..MAX_ENTRIES + 5 { held.use_credential(A, "1.0.0", "provider:glm", &address_of(&url)).unwrap(); }
        assert_eq!(held.files().activity(A).len(), MAX_ENTRIES);
        held.files().forget(A);
        assert!(held.files().activity(A).is_empty());
    }

    #[test]
    fn a_use_that_cannot_be_written_does_not_happen() {
        let dir = Dir::new();
        // The records directory is a file: nothing can be created under it.
        std::fs::write(dir.0.join(DIRECTORY), b"not a directory").unwrap();
        let held = held(&dir);
        assert_eq!(held.use_credential(A, "1.0.0", "provider:glm", "http://127.0.0.1:4000/").unwrap_err(), "HostUnavailable");
    }

    #[test]
    fn switching_needs_the_item_of_the_account_and_changes_only_which_account_is_active() {
        let dir = Dir::new(); let grants = grants(&dir); let files = Files::open(&dir.0);
        let call = |owner: &str, params: Value| switch(&grants, &files, &Accounts, owner, "1.0.0", &params);
        assert_eq!(call(A, json!({"harness": "claude", "account": "work"})).unwrap_err(), "PermissionDenied", "no grant");
        grants.grant(A, PERMISSION, items(&["connection:work"])).unwrap();
        assert_eq!(call(A, json!({"harness": "claude", "account": "work"})).unwrap(), Value::Null);
        assert_eq!(files.active("claude").as_deref(), Some("work"));
        assert_eq!(call(A, json!({"harness": "claude", "account": "personal"})).unwrap_err(), "PermissionDenied", "another item is another grant");
        assert_eq!(call(A, json!({"harness": "claude", "account": "default"})).unwrap_err(), "PermissionDenied", "the own setup is `provider:claude`");
        assert_eq!(files.active("claude").as_deref(), Some("work"), "a refused switch changes nothing");
        assert_eq!(call(B, json!({"harness": "claude", "account": "work"})).unwrap_err(), "PermissionDenied", "another package");
        for (params, expected) in [
            (json!({"harness": "nobody", "account": "work"}), "NotFound"), (json!({"harness": "claude", "account": "missing"}), "NotFound"),
            (json!({"harness": "codex", "account": "work"}), "NotFound"), (json!({"harness": "claude"}), "InvalidArguments"),
            (json!({"harness": "claude", "account": "work", "credential": "x"}), "InvalidArguments"), (json!("claude"), "InvalidArguments"),
        ] { assert_eq!(call(A, params.clone()).unwrap_err(), expected, "{params}"); }
        grants.grant(A, PERMISSION, items(&["connection:work", "provider:claude"])).unwrap();
        assert_eq!(call(A, json!({"harness": "claude", "account": "default"})).unwrap(), Value::Null);
        assert_eq!(files.active("claude"), None, "back to the harness's own setup");
        assert_eq!(call(A, json!({"harness": "claude", "account": "default"})).unwrap(), Value::Null, "switching to the active account is idempotent");
        let list = files.activity(A);
        assert!(list.iter().all(|entry| entry.kind == "account.switch" && entry.address.is_none()), "{list:?}");
        assert_eq!(list.len(), 3);
    }

    #[test]
    fn revoking_or_narrowing_ends_use_and_switching_and_a_stale_version_is_refused() {
        let dir = Dir::new(); let grants = grants(&dir); let files = Files::open(&dir.0);
        grants.grant(A, PERMISSION, items(&["connection:work", "provider:glm"])).unwrap();
        let work = grants.begin(A, "1.0.0", PERMISSION, &Target::item("provider:glm")).unwrap();
        grants.narrow(A, PERMISSION, items(&["connection:work"])).unwrap();
        assert!(work.is_cancelled(), "a use in flight loses its item with the narrowing");
        assert!(grants.check(A, "1.0.0", PERMISSION, &Target::item("provider:glm")).is_err());
        grants.revoke(A, PERMISSION).unwrap();
        assert_eq!(switch(&grants, &files, &Accounts, A, "1.0.0", &json!({"harness": "claude", "account": "work"})).unwrap_err(), "PermissionDenied");
        grants.grant(A, PERMISSION, items(&["connection:work"])).unwrap();
        assert_eq!(switch(&grants, &files, &Accounts, A, "0.9.0", &json!({"harness": "claude", "account": "work"})).unwrap_err(), "PermissionDenied", "stale version");
        assert_eq!(files.active("claude"), None);
    }

    #[test]
    fn the_package_never_receives_a_credential_from_any_operation() {
        let dir = Dir::new(); let grants = grants(&dir); let files = Files::open(&dir.0);
        grants.grant(A, PERMISSION, items(&["connection:work"])).unwrap();
        let reply = switch(&grants, &files, &Accounts, A, "1.0.0", &json!({"harness": "claude", "account": "work"})).unwrap();
        assert_eq!(reply, Value::Null);
        let everything = format!("{}{}", serde_json::to_string(&files.activity(A)).unwrap(), std::fs::read_to_string(dir.0.join(DIRECTORY).join(ACTIVE_FILE)).unwrap());
        assert!(!everything.contains(&canary()));
        assert!(PERMISSION != "credentials.read" && !crate::extensions::runtime_grants::PERMISSIONS.contains(&"credentials.read"), "there is no credentials.read");
    }

    #[test]
    fn the_status_asks_only_whether_a_credential_is_held() {
        let dir = Dir::new(); let held = held(&dir);
        assert!(held.has("provider:glm") && held.has("connection:work"));
        assert!(!held.has("provider:openai") && !held.has("github") && !held.has("credentials.read"));
        assert!(held.files().activity(A).is_empty(), "a status is not a use");
    }
}
