//! Replaceable, attributed notifications of background services (`ui.notify`, runtime phase R2, slice R0207).
//!
//! A trusted service raises a notice with `panda.ui.notify({key, text, title?, tone?})` and takes it back with
//! `panda.ui.withdraw(key)`. A notice is named by its key inside its package: the same key again replaces the notice
//! (one row, never two), a withdraw removes it. Every notice carries the package that raised it, in the in-app list and
//! in the operating-system channel alike, so a notice is never anonymous.
//!
//! Two surfaces show a notice: the in-app list (`src/extensions/runtime-notifications.ts` reads `snapshot` through
//! `extensions_runtime_notices`) and the operating-system channel (`OsChannel`). The native recorder keeps the ordered
//! operations that reached them (`show`, `replace`, `merge`, `withdraw`, `dismiss`) with what the OS channel answered,
//! so tests compare it with the visible list.
//!
//! Rules that are for predictability and fault isolation, never for trust (ADR-0005):
//! - at most 6 sends per package per minute; the following sends merge into one "N more notices" notice of the package
//!   (its count grows, no other notice is touched) until the user dismisses it or the service stops;
//! - at most 32 live notices per package; past that the oldest one is withdrawn;
//! - the permission is checked natively on every request; a revoked `ui.notify`, a disabled package, safe mode and a
//!   stopped service remove every notice of the package (`clear`, `sweep`);
//! - an unavailable OS channel is reported (`os: "unavailable"`), never pretended delivered, and never blocks the
//!   request: the in-app notice shows regardless.
//!
//! The state is pure (injected clock, grant answer and OS channel) so the bounds are deterministic to test.
use serde_json::{json, Map, Value};
use std::{collections::{BTreeMap, VecDeque}, sync::Mutex};

/// The named permission (granted with the trust decision, rechecked on every request).
pub const PERMISSION: &str = "ui.notify";
/// Sends per package per window; the next ones merge.
pub const MAX_PER_WINDOW: usize = 6;
pub const WINDOW_MS: u64 = 60_000;
/// Live notices per package.
pub const MAX_LIVE: usize = 32;
pub const TEXT_CHARS: usize = 1024;
pub const TITLE_CHARS: usize = 120;
/// Operations kept by the recorder.
pub const RECORDER_MAX: usize = 256;
pub const TONES: [&str; 5] = ["neutral", "info", "success", "warning", "danger"];
/// The key of the merged notice in `snapshot` and in `dismiss` (no package key is empty).
pub const MERGED_KEY: &str = "";

/// What the operating system channel answered for one operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os { Delivered, Unavailable }
impl Os { pub fn as_str(self) -> &'static str { match self { Self::Delivered => "delivered", Self::Unavailable => "unavailable" } } }

/// The operating-system notification path. The app has no such channel in this build (`NoOsChannel`): every operation
/// answers `Unavailable`, which is reported and never pretended; tests install a channel that delivers.
pub trait OsChannel: Send + Sync {
    fn show(&self, owner: &str, notice: &Notice) -> Os;
    fn withdraw(&self, owner: &str, key: &str) -> Os;
}
pub struct NoOsChannel;
impl OsChannel for NoOsChannel {
    fn show(&self, _: &str, _: &Notice) -> Os { Os::Unavailable }
    fn withdraw(&self, _: &str, _: &str) -> Os { Os::Unavailable }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Notice { pub key: String, pub title: String, pub text: String, pub tone: String, pub package: String, pub seq: u64, pub count: u64, pub os: &'static str }
impl Notice { fn merged(&self) -> bool { self.key == MERGED_KEY } }

/// What the app answers about the world; tests give fixed answers.
pub struct Checks<'a> {
    /// The package holds `ui.notify` now (checked against the grants file on every request).
    pub granted: bool,
    /// The package's display name, shown on every notice.
    pub package: &'a str,
    pub now_ms: u64,
}

#[derive(Default)]
struct Layer { notices: BTreeMap<String, Notice>, sends: VecDeque<u64>, merged: Option<Notice> }
#[derive(Default)]
struct Inner { layers: BTreeMap<String, Layer>, revision: u64, seq: u64, recorder: VecDeque<Value> }

/// Every package's live notices and the recorder.
pub struct Notices { inner: Mutex<Inner>, os: Box<dyn OsChannel> }
impl Default for Notices { fn default() -> Self { Self::new(Box::new(NoOsChannel)) } }

pub fn failure(code: &str) -> Value { json!({"ok": false, "error": {"schemaVersion": 1, "code": code, "path": "$", "ids": []}}) }
fn ok(value: Value) -> Value { json!({"ok": true, "value": value}) }
fn key_ok(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control) }

impl Inner {
    fn record(&mut self, op: &str, owner: &str, notice: &Notice, reason: Option<&str>) {
        let mut entry = json!({"seq": self.recorder.back().map_or(1, |last| last["seq"].as_u64().unwrap_or(0) + 1), "op": op, "owner": owner, "package": notice.package, "key": notice.key, "title": notice.title, "text": notice.text, "tone": notice.tone, "os": notice.os});
        if let Some(reason) = reason { entry["reason"] = json!(reason); }
        if self.recorder.len() >= RECORDER_MAX { self.recorder.pop_front(); }
        self.recorder.push_back(entry);
    }
}

impl Notices {
    pub fn new(os: Box<dyn OsChannel>) -> Self { Self { inner: Mutex::new(Inner::default()), os } }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, &'static str> { self.inner.lock().map_err(|_| "HostUnavailable") }

    /// A counter that changes whenever any notice changes; the interface reads again when it moves.
    pub fn revision(&self) -> u64 { self.inner.lock().map_or(0, |inner| inner.revision) }
    /// Live notices of `owner`, the merged one included.
    pub fn count(&self, owner: &str) -> usize { self.inner.lock().ok().and_then(|inner| inner.layers.get(owner).map(|layer| layer.notices.len() + usize::from(layer.merged.is_some()))).unwrap_or(0) }

    /// `panda.ui.notify`: answers `{key, replaced, merged, os}`.
    pub fn notify(&self, owner: &str, checks: &Checks, raw: &Value) -> Result<Value, String> {
        if !checks.granted { return Err("PermissionDenied".into()); }
        let object = raw.as_object().ok_or("InvalidShape")?;
        if object.keys().any(|key| !["key", "text", "title", "tone"].contains(&key.as_str())) { return Err("InvalidShape".into()); }
        let key = object.get("key").and_then(Value::as_str).filter(|key| key_ok(key)).ok_or("InvalidShape")?.to_owned();
        let text = object.get("text").and_then(Value::as_str).ok_or("InvalidShape")?;
        if text.trim().is_empty() { return Err("InvalidShape".into()); }
        if text.chars().count() > TEXT_CHARS { return Err("LimitExceeded".into()); }
        let title = match object.get("title") { None | Some(Value::Null) => String::new(), Some(Value::String(title)) if title.chars().count() <= TITLE_CHARS && !title.chars().any(char::is_control) => title.clone(), Some(Value::String(_)) => return Err("LimitExceeded".into()), Some(_) => return Err("InvalidShape".into()) };
        let tone = match object.get("tone") { None | Some(Value::Null) => "neutral".to_owned(), Some(Value::String(tone)) if TONES.contains(&tone.as_str()) => tone.clone(), Some(_) => return Err("InvalidShape".into()) };
        let mut inner = self.lock()?;
        inner.seq += 1;
        let seq = inner.seq;
        let layer = inner.layers.entry(owner.to_owned()).or_default();
        while layer.sends.front().is_some_and(|at| checks.now_ms.saturating_sub(*at) >= WINDOW_MS) { layer.sends.pop_front(); }
        // Past six sends in a minute the rest merge into one notice of the package; nothing else is touched.
        if layer.sends.len() >= MAX_PER_WINDOW {
            let count = layer.merged.as_ref().map_or(0, |merged| merged.count) + 1;
            let mut merged = Notice { key: MERGED_KEY.into(), title: checks.package.to_owned(), text: format!("{count} more notices from {}", checks.package), tone: "neutral".into(), package: checks.package.to_owned(), seq, count, os: Os::Unavailable.as_str() };
            merged.os = self.os.show(owner, &merged).as_str();
            layer.merged = Some(merged.clone());
            inner.revision += 1;
            inner.record("merge", owner, &merged, None);
            return Ok(json!({"key": key, "replaced": false, "merged": true, "os": merged.os}));
        }
        layer.sends.push_back(checks.now_ms);
        let replaced = layer.notices.contains_key(&key);
        let mut notice = Notice { key: key.clone(), title, text: text.to_owned(), tone, package: checks.package.to_owned(), seq, count: 1, os: Os::Unavailable.as_str() };
        notice.os = self.os.show(owner, &notice).as_str();
        layer.notices.insert(key.clone(), notice.clone());
        let mut evicted = None;
        if layer.notices.len() > MAX_LIVE {
            if let Some(oldest) = layer.notices.values().min_by_key(|notice| notice.seq).map(|notice| notice.key.clone()) { evicted = layer.notices.remove(&oldest); }
        }
        inner.revision += 1;
        inner.record(if replaced { "replace" } else { "show" }, owner, &notice, None);
        if let Some(gone) = evicted { self.os.withdraw(owner, &gone.key); inner.record("withdraw", owner, &gone, Some("evicted")); }
        Ok(json!({"key": key, "replaced": replaced, "merged": false, "os": notice.os}))
    }

    /// `panda.ui.withdraw`: a key that is gone (or never was) answers `NotFound`, never a second success.
    pub fn withdraw(&self, owner: &str, checks: &Checks, key: &str) -> Result<Value, String> {
        if !checks.granted { return Err("PermissionDenied".into()); }
        if !key_ok(key) { return Err("InvalidShape".into()); }
        let mut inner = self.lock()?;
        let notice = inner.layers.get_mut(owner).and_then(|layer| layer.notices.remove(key)).ok_or("NotFound")?;
        let mut gone = notice; gone.os = self.os.withdraw(owner, key).as_str();
        inner.revision += 1;
        inner.record("withdraw", owner, &gone, None);
        Ok(Value::Null)
    }

    /// The user closes a notice (or the merged one, `MERGED_KEY`) in the in-app list. Answers whether it existed.
    pub fn dismiss(&self, owner: &str, key: &str) -> bool {
        let Ok(mut inner) = self.lock() else { return false };
        let Some(layer) = inner.layers.get_mut(owner) else { return false };
        let removed = if key == MERGED_KEY { layer.merged.take() } else { layer.notices.remove(key) };
        let Some(mut gone) = removed else { return false };
        gone.os = self.os.withdraw(owner, key).as_str();
        inner.revision += 1;
        inner.record("dismiss", owner, &gone, None);
        true
    }

    /// The service stopped, or the package lost the permission, was disabled or is in safe mode: every notice of the
    /// owner is withdrawn from both surfaces. Answers whether anything went.
    pub fn clear(&self, owner: &str, reason: &str) -> bool {
        let Ok(mut inner) = self.lock() else { return false };
        let Some(layer) = inner.layers.remove(owner) else { return false };
        let mut gone: Vec<Notice> = layer.notices.into_values().chain(layer.merged).collect();
        gone.sort_by_key(|notice| notice.seq);
        for mut notice in gone { notice.os = self.os.withdraw(owner, &notice.key).as_str(); inner.record("withdraw", owner, &notice, Some(reason)); }
        inner.revision += 1;
        true
    }

    /// Clears every owner `allowed` no longer answers for. Answers whether anything went.
    pub fn sweep(&self, allowed: &dyn Fn(&str) -> bool, reason: &str) -> bool {
        let owners: Vec<String> = self.inner.lock().map(|inner| inner.layers.keys().cloned().collect()).unwrap_or_default();
        let mut changed = false;
        for owner in owners { if !allowed(&owner) { changed |= self.clear(&owner, reason); } }
        changed
    }

    /// What the interface shows: every owner's notices in the order they were last sent, the merged one last of its owner.
    pub fn snapshot(&self) -> Value {
        let Ok(inner) = self.inner.lock() else { return json!({"revision": 0, "notices": []}) };
        let mut all: Vec<(&String, &Notice)> = inner.layers.iter().flat_map(|(owner, layer)| layer.notices.values().chain(layer.merged.iter()).map(move |notice| (owner, notice))).collect();
        all.sort_by_key(|(_, notice)| notice.seq);
        let notices: Vec<Value> = all.into_iter().map(|(owner, notice)| {
            let mut entry = Map::new();
            for (name, value) in [("owner", json!(owner)), ("package", json!(notice.package)), ("key", json!(notice.key)), ("title", json!(notice.title)), ("text", json!(notice.text)), ("tone", json!(notice.tone)), ("merged", json!(notice.merged())), ("count", json!(notice.count)), ("os", json!(notice.os)), ("seq", json!(notice.seq))] { entry.insert(name.into(), value); }
            Value::Object(entry)
        }).collect();
        json!({"revision": inner.revision, "notices": notices})
    }

    /// The ordered operations that reached the surfaces (bounded to the last 256).
    pub fn recorder(&self) -> Value { self.inner.lock().map_or(json!([]), |inner| Value::Array(inner.recorder.iter().cloned().collect())) }
}

/// A `notice` request of a service: `{op: notify | withdraw, ...}`. Answers the broker envelope.
pub fn serve(notices: &Notices, owner: &str, checks: &Checks, params: &Value) -> Value {
    let result = match params["op"].as_str() {
        Some("notify") => notices.notify(owner, checks, &params["notice"]),
        Some("withdraw") => notices.withdraw(owner, checks, params["key"].as_str().unwrap_or_default()),
        _ => Err("InvalidShape".into()),
    };
    match result { Ok(value) => ok(value), Err(code) => failure(&code) }
}

/// Unix milliseconds now.
pub fn now_millis() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64) }

/// The app's one set of notices, managed as Tauri state.
pub fn state(app: &tauri::AppHandle) -> Option<tauri::State<'_, Notices>> { use tauri::Manager; app.try_state::<Notices>() }

/// Tells every window the notices moved; they read them again with `extensions_runtime_notices`.
pub fn changed(app: &tauri::AppHandle) { use tauri::Emitter; let _ = app.emit("extensions-runtime-notices", state(app).map_or(0, |notices| notices.revision())); }

/// Serves a `notice` request of the service of `owner`, against the installed manifest and the live grant. A package
/// that is disabled, absent or in safe mode raises nothing.
pub fn serve_app(app: &tauri::AppHandle, owner: &str, params: &Value) -> Value {
    use tauri::Manager;
    let Some(notices) = state(app) else { return failure("UnsupportedCapability") };
    let packages = app.state::<crate::extensions::packages::ExtensionPackages>();
    let Ok(packages) = packages.0.try_lock() else { return failure("Timeout") };
    let snapshot = serde_json::to_value(packages.snapshot()).unwrap_or(Value::Null);
    if snapshot["safeMode"] == true { return failure("NotFound"); }
    let Some(package) = snapshot["packages"].as_array().into_iter().flatten().find(|package| package["manifest"]["id"] == owner && package["enabled"] == true) else { return failure("NotFound") };
    let version = package["manifest"]["version"].as_str().unwrap_or_default();
    let name = package["manifest"]["name"].as_str().filter(|name| !name.trim().is_empty()).unwrap_or(owner);
    let granted = app.try_state::<crate::extensions::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(owner, version, PERMISSION, &crate::extensions::runtime_grants::Target::default()).is_ok());
    let reply = serve(&notices, owner, &Checks { granted, package: name, now_ms: now_millis() }, params);
    if reply["ok"] == true { changed(app); }
    reply
}

/// The service of `owner` stopped (disable, uninstall, update, trust loss, safe mode, crash): its notices go.
pub fn service_stopped(app: &tauri::AppHandle, owner: &str) {
    if state(app).is_some_and(|notices| notices.clear(owner, "service-stopped")) { changed(app); }
}

/// Removes the notices of every package that no longer holds `ui.notify`, is disabled or is in safe mode. Called after
/// a grant changes, so a revoke takes effect at once on both surfaces.
pub fn sweep_app(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(notices) = state(app) else { return };
    let packages = app.state::<crate::extensions::packages::ExtensionPackages>();
    let Ok(packages) = packages.0.lock() else { return };
    let snapshot = serde_json::to_value(packages.snapshot()).unwrap_or(Value::Null);
    let safe = snapshot["safeMode"] == true;
    let allowed = |owner: &str| {
        if safe { return false; }
        let Some(package) = snapshot["packages"].as_array().into_iter().flatten().find(|package| package["manifest"]["id"] == owner && package["enabled"] == true) else { return false };
        let version = package["manifest"]["version"].as_str().unwrap_or_default();
        app.try_state::<crate::extensions::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(owner, version, PERMISSION, &crate::extensions::runtime_grants::Target::default()).is_ok())
    };
    if notices.sweep(&allowed, if safe { "safe-mode" } else { "revoked-or-disabled" }) { changed(app); }
}

/// The interface reads every live notice.
#[tauri::command]
pub fn extensions_runtime_notices(app: tauri::AppHandle) -> Value { state(&app).map_or_else(|| json!({"revision": 0, "notices": []}), |notices| notices.snapshot()) }
/// The user closes one notice in the list (`key` is empty for the merged one).
#[tauri::command]
pub fn extensions_runtime_notice_dismiss(app: tauri::AppHandle, owner: String, key: String) -> bool {
    let removed = state(&app).is_some_and(|notices| notices.dismiss(&owner, &key));
    if removed { changed(&app); }
    removed
}
/// The native recorder (read only): the operations in order with what the OS channel answered.
#[tauri::command]
pub fn extensions_runtime_notice_recorder(app: tauri::AppHandle) -> Value { state(&app).map_or_else(|| json!([]), |notices| notices.recorder()) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};
    const OWNER: &str = "sample.runtime-notifications";
    const NAME: &str = "Runtime notices";

    /// An OS channel that delivers and remembers what it was asked, like the test recorder of a real channel.
    struct Delivering(Arc<StdMutex<Vec<String>>>);
    impl OsChannel for Delivering {
        fn show(&self, owner: &str, notice: &Notice) -> Os { self.0.lock().unwrap().push(format!("show {owner} {} {}", notice.key, notice.package)); Os::Delivered }
        fn withdraw(&self, owner: &str, key: &str) -> Os { self.0.lock().unwrap().push(format!("withdraw {owner} {key}")); Os::Delivered }
    }
    fn checks(now_ms: u64) -> Checks<'static> { Checks { granted: true, package: NAME, now_ms } }
    fn send(key: &str, text: &str) -> Value { json!({"key": key, "text": text}) }
    fn code(result: Result<Value, String>) -> String { result.unwrap_err() }
    fn keys(notices: &Notices) -> Vec<String> { notices.snapshot()["notices"].as_array().unwrap().iter().map(|notice| notice["key"].as_str().unwrap().to_owned()).collect() }

    #[test]
    fn a_notice_names_its_package_and_the_same_key_replaces_it() {
        let log = Arc::new(StdMutex::new(vec![]));
        let notices = Notices::new(Box::new(Delivering(log.clone())));
        let first = notices.notify(OWNER, &checks(1), &json!({"key": "build", "text": "3 builds failed", "title": "Builds", "tone": "danger"})).unwrap();
        assert_eq!(first, json!({"key": "build", "replaced": false, "merged": false, "os": "delivered"}));
        let again = notices.notify(OWNER, &checks(2), &send("build", "4 builds failed")).unwrap();
        assert_eq!((again["replaced"].as_bool(), notices.count(OWNER)), (Some(true), 1));
        let snapshot = notices.snapshot();
        assert_eq!(snapshot["notices"][0]["text"], "4 builds failed");
        assert_eq!(snapshot["notices"][0]["package"], NAME);
        assert_eq!(snapshot["notices"][0]["owner"], OWNER);
        // Replacement keeps one row and the recorder says show then replace; the OS channel saw the package name.
        let ops: Vec<String> = notices.recorder().as_array().unwrap().iter().map(|entry| entry["op"].as_str().unwrap().to_owned()).collect();
        assert_eq!(ops, ["show", "replace"]);
        assert!(log.lock().unwrap().iter().all(|line| line.ends_with(NAME) || line.starts_with("withdraw")));
        // Withdraw removes it from both surfaces; a second withdraw is NotFound.
        assert_eq!(notices.withdraw(OWNER, &checks(3), "build").unwrap(), Value::Null);
        assert!(keys(&notices).is_empty());
        assert_eq!(notices.recorder().as_array().unwrap().last().unwrap()["op"], "withdraw");
        assert_eq!(code(notices.withdraw(OWNER, &checks(3), "build")), "NotFound");
    }

    #[test]
    fn six_sends_a_minute_then_they_merge_and_the_window_slides() {
        let notices = Notices::new(Box::new(Delivering(Arc::new(StdMutex::new(vec![])))));
        for index in 0..6 { notices.notify(OWNER, &checks(1000 + index), &send(&format!("k{index}"), "x")).unwrap(); }
        assert_eq!(notices.count(OWNER), 6);
        let seventh = notices.notify(OWNER, &checks(2000), &send("k6", "x")).unwrap();
        let eighth = notices.notify(OWNER, &checks(3000), &send("k0", "y")).unwrap();
        assert_eq!((seventh["merged"].as_bool(), eighth["merged"].as_bool()), (Some(true), Some(true)));
        // The merged notice counts; no other notice was created or replaced.
        let snapshot = notices.snapshot();
        let merged = snapshot["notices"].as_array().unwrap().iter().find(|notice| notice["merged"] == true).unwrap().clone();
        assert_eq!((merged["count"].as_u64(), merged["text"].as_str()), (Some(2), Some("2 more notices from Runtime notices")));
        assert_eq!(snapshot["notices"].as_array().unwrap().iter().find(|notice| notice["key"] == "k0").unwrap()["text"], "x");
        assert_eq!(notices.count(OWNER), 7);
        // A minute after the first sends the window has room again.
        let later = notices.notify(OWNER, &checks(1000 + WINDOW_MS + 10), &send("k9", "z")).unwrap();
        assert_eq!(later["merged"], false);
        // Another package has its own window.
        assert_eq!(notices.notify("sample.other", &checks(2000), &send("a", "x")).unwrap()["merged"], false);
    }

    #[test]
    fn refusals_name_their_reason() {
        let notices = Notices::default();
        // No grant, and a revoked one, is the permission itself.
        assert_eq!(code(notices.notify(OWNER, &Checks { granted: false, ..checks(1) }, &send("a", "x"))), "PermissionDenied");
        assert_eq!(code(notices.withdraw(OWNER, &Checks { granted: false, ..checks(1) }, "a")), "PermissionDenied");
        // Shapes and sizes: input validation and predictability.
        for (raw, expected) in [(json!("text"), "InvalidShape"), (json!({"text": "x"}), "InvalidShape"), (json!({"key": "", "text": "x"}), "InvalidShape"), (json!({"key": "a"}), "InvalidShape"), (json!({"key": "a", "text": "  "}), "InvalidShape"),
            (json!({"key": "a", "text": "x", "tone": "rainbow"}), "InvalidShape"), (json!({"key": "a", "text": "x", "action": "run"}), "InvalidShape"), (json!({"key": "a", "text": "x".repeat(1025)}), "LimitExceeded"), (json!({"key": "a", "text": "x", "title": "t".repeat(121)}), "LimitExceeded")] {
            assert_eq!(code(notices.notify(OWNER, &checks(1), &raw)), expected, "{raw}");
        }
        assert_eq!(notices.count(OWNER), 0);
        assert_eq!(code(notices.withdraw(OWNER, &checks(1), "")), "InvalidShape");
        assert_eq!(serve(&notices, OWNER, &checks(1), &json!({"op": "explode"}))["error"]["code"], "InvalidShape");
        // The unavailable OS channel is reported and the in-app notice still shows.
        let reply = serve(&notices, OWNER, &checks(1), &json!({"op": "notify", "notice": send("a", "x")}));
        assert_eq!((reply["ok"].clone(), reply["value"]["os"].clone()), (json!(true), json!("unavailable")));
        assert_eq!(keys(&notices), ["a"]);
        assert_eq!(notices.recorder().as_array().unwrap()[0]["os"], "unavailable");
    }

    #[test]
    fn revoke_stop_disable_and_safe_mode_remove_every_notice_and_the_user_can_dismiss() {
        let notices = Notices::new(Box::new(Delivering(Arc::new(StdMutex::new(vec![])))));
        for (owner, key) in [(OWNER, "a"), (OWNER, "b"), ("sample.other", "c")] { notices.notify(owner, &checks(1), &send(key, "x")).unwrap(); }
        // The package lost the permission: only its notices go, from both surfaces.
        assert!(notices.sweep(&|owner| owner != OWNER, "revoked-or-disabled"));
        assert_eq!(keys(&notices), ["c"]);
        let withdrawn: Vec<(String, String)> = notices.recorder().as_array().unwrap().iter().filter(|entry| entry["op"] == "withdraw").map(|entry| (entry["key"].as_str().unwrap().to_owned(), entry["reason"].as_str().unwrap().to_owned())).collect();
        assert_eq!(withdrawn, [("a".to_owned(), "revoked-or-disabled".to_owned()), ("b".to_owned(), "revoked-or-disabled".to_owned())]);
        assert!(!notices.sweep(&|owner| owner != OWNER, "again"));
        // Safe mode and a stopped service clear the rest; repeating changes nothing.
        assert!(notices.sweep(&|_| false, "safe-mode"));
        assert_eq!(notices.count("sample.other"), 0);
        assert!(!notices.clear("sample.other", "service-stopped"));
        // The user closes a notice, and the merged one by its empty key.
        for index in 0..7 { notices.notify(OWNER, &checks(10 + index), &send(&format!("k{index}"), "x")).unwrap(); }
        assert!(notices.dismiss(OWNER, "k1") && notices.dismiss(OWNER, MERGED_KEY));
        assert!(!notices.dismiss(OWNER, "k1"));
        assert_eq!(notices.count(OWNER), 5);
        assert_eq!(notices.recorder().as_array().unwrap().iter().filter(|entry| entry["op"] == "dismiss").count(), 2);
        // The live cap withdraws the oldest first.
        let many = Notices::default();
        for index in 0..40u64 { many.notify(OWNER, &checks(index * WINDOW_MS), &send(&format!("n{index}"), "x")).unwrap(); }
        assert_eq!(many.count(OWNER), MAX_LIVE);
        assert!(!keys(&many).contains(&"n0".to_owned()));
    }
}
