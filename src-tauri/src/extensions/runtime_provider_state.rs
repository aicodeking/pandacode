//! Dynamic provider state published by a package's service (`panda.providers.update`, runtime phase R8, slice R0806).
//!
//! A package provider is declared once in the manifest (readiness, models, no limits). Its service tells the host what
//! is true now: a sign-in finished and the account has models and limits, or the account signed out. The host keeps
//! that as one overlay per provider in this module and applies it in exactly one place for every reader:
//!
//! * `dynamic_harness::metadata` / `catalog` (the native roster, the model picker, the readiness line and the send
//!   path) read `apply_metadata` and `effective_models`;
//! * `runtime_usage_resources` (the `limits` and `accounts` resources) reads `limits_of` / `account_of`;
//! * the webview reads the secret-free projection (`extensions_provider_state`) and mirrors it in the preview roster.
//!
//! Rules (ADR-0005, ADR-0006):
//!
//! * `panda.providers.update(id, state)` needs `ui.dynamic`, checked natively against the installed version on every
//!   call. The provider must be declared by the caller's own package (`NotFound` otherwise: ownership). The state is
//!   one strict shape: `readiness`, `account` (a label), `models`, `limits`; anything else is `InvalidShape`. There is
//!   no field that could carry a credential, and every text is bounded.
//! * A `signedOut` or `unavailable` readiness invalidates the account: models, account and limits are emptied in the
//!   same step, so a sign-out can never leave a ready-looking model list behind.
//! * The overlay lives as long as the service that published it: stop, crash, disable, uninstall, update, trust loss,
//!   safe mode and a revoked grant return the provider to its manifest values (`clear_owner`, `sweep_app`). A rejected
//!   update leaves the previous overlay untouched and is only counted (a fault never changes what the user sees).
//! * Publishing never starts anything. There is no code path from this module to a process, so a package is never
//!   started as a warm spare to refresh a roster (upstream's warm spares are suspected in a known deadlock); the
//!   launched run of the package keeps starting in `dynamic_harness::run`, on a send, and shares the package's one
//!   `runtime_provider_launch::State` across tasks.
//! * `signIn` / `signOut` in the provider's manifest metadata name commands of the same package. The host resolves
//!   them for the "Sign in" / "Sign out" actions (`action_command`); the command runs in the package's service, which
//!   uses `panda.auth.signIn` and `panda.secrets.private`, and publishes the outcome here.
use serde_json::{json, Map, Value};
use std::{collections::{BTreeMap, VecDeque}, sync::{Mutex, OnceLock}};

pub const PERMISSION: &str = "ui.dynamic";
const MAX_MODELS: usize = 32;
const MAX_WINDOWS: usize = 16;
const MAX_CREDITS: usize = 2048;
const RECORDER: usize = 64;

/// One provider's published values. `None` means "the manifest's value".
#[derive(Clone, Debug, Default, PartialEq)]
struct Entry {
    owner: String,
    readiness: Option<(String, String)>,
    account: Option<Option<String>>,
    models: Option<Vec<Value>>,
    limits: Option<Option<Value>>,
    updates: u64,
    rejected: u64,
    /// Unix milliseconds of the last accepted update: the `readAt` of the limits row, stable between reads.
    at: u64,
}
#[derive(Default)]
struct Store { entries: BTreeMap<String, Entry>, revision: u64, recorder: VecDeque<Value> }
fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}
fn with<T>(change: impl FnOnce(&mut Store) -> T) -> T { change(&mut store().lock().unwrap_or_else(|poisoned| poisoned.into_inner())) }
fn record(store: &mut Store, what: &str, provider: &str, detail: &str) {
    if store.recorder.len() >= RECORDER { store.recorder.pop_front(); }
    store.recorder.push_back(json!({"what": what, "provider": provider, "detail": detail}));
}

fn text_ok(value: &Value, max: usize) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty() && text.chars().count() <= max && !text.chars().any(char::is_control))
}
fn token_ok(text: &str, max: usize) -> bool {
    !text.is_empty() && text.len() <= max && text.starts_with(|c: char| c.is_ascii_lowercase()) && text.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}
fn only<'a>(value: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, String> {
    let object = value.as_object().ok_or("InvalidShape")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) { return Err("InvalidShape".into()); }
    Ok(object)
}

#[derive(Debug, Default)]
struct Parsed { readiness: Option<(String, String)>, account: Option<Option<String>>, models: Option<Vec<Value>>, limits: Option<Option<Value>> }

fn parse_model(model: &Value) -> Result<Value, String> {
    let object = only(model, &["id", "name", "efforts", "contextWindow", "speedTiers"])?;
    let id = object.get("id").and_then(|id| id.as_str()).filter(|id| !id.is_empty() && id.len() <= 200 && !id.chars().any(char::is_control)).ok_or("InvalidShape")?;
    let name = object.get("name").and_then(|name| text_ok(name, 256)).ok_or("InvalidShape")?;
    let efforts = object.get("efforts").and_then(Value::as_array).ok_or("InvalidShape")?;
    if efforts.len() > 8 || efforts.iter().any(|effort| !effort.as_str().is_some_and(|effort| token_ok(effort, 40))) { return Err("InvalidShape".into()); }
    let mut clean = json!({"id": id, "name": name, "efforts": efforts});
    if let Some(window) = object.get("contextWindow") {
        let window = window.as_u64().filter(|window| (1..=10_000_000).contains(window)).ok_or("InvalidShape")?;
        clean["contextWindow"] = json!(window);
    }
    if let Some(tiers) = object.get("speedTiers") {
        let tiers = tiers.as_array().filter(|tiers| tiers.len() <= 8).ok_or("InvalidShape")?;
        let mut kept = Vec::new();
        for tier in tiers {
            let object = only(tier, &["id", "name", "description"])?;
            let id = object.get("id").and_then(Value::as_str).filter(|id| token_ok(id, 40)).ok_or("InvalidShape")?;
            let name = object.get("name").and_then(|name| text_ok(name, 256)).ok_or("InvalidShape")?;
            let mut item = json!({"id": id, "name": name});
            if let Some(description) = object.get("description") { item["description"] = json!(description.as_str().filter(|text| text.chars().count() <= 256 && !text.chars().any(char::is_control)).ok_or("InvalidShape")?); }
            kept.push(item);
        }
        if kept.iter().map(|tier| tier["id"].as_str()).collect::<std::collections::BTreeSet<_>>().len() != kept.len() { return Err("InvalidShape".into()); }
        clean["speedTiers"] = Value::Array(kept);
    }
    Ok(clean)
}

fn parse_limits(limits: &Value) -> Result<Value, String> {
    let object = only(limits, &["windows", "credits"])?;
    let windows = object.get("windows").and_then(Value::as_array).filter(|windows| windows.len() <= MAX_WINDOWS).ok_or("InvalidShape")?;
    let mut kept = Vec::new();
    for window in windows {
        let item = only(window, &["id", "label", "usedPercent", "resetsAt"])?;
        let id = item.get("id").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))).ok_or("InvalidShape")?;
        let label = item.get("label").and_then(|label| text_ok(label, 120)).ok_or("InvalidShape")?;
        let used = item.get("usedPercent").and_then(Value::as_f64).filter(|used| (0.0..=100.0).contains(used)).ok_or("InvalidShape")?;
        let mut clean = json!({"id": id, "label": label, "usedPercent": used});
        if let Some(resets) = item.get("resetsAt") { clean["resetsAt"] = json!(text_ok(resets, 64).ok_or("InvalidShape")?); }
        kept.push(clean);
    }
    if kept.iter().map(|window| window["id"].as_str()).collect::<std::collections::BTreeSet<_>>().len() != kept.len() { return Err("InvalidShape".into()); }
    let mut clean = json!({"windows": kept});
    if let Some(credits) = object.get("credits") {
        if credits.to_string().len() > MAX_CREDITS { return Err("LimitExceeded".into()); }
        clean["credits"] = credits.clone();
    }
    Ok(clean)
}

fn parse(update: &Value) -> Result<Parsed, String> {
    let object = only(update, &["readiness", "account", "models", "limits"])?;
    if object.is_empty() { return Err("InvalidShape".into()); }
    let mut parsed = Parsed::default();
    if let Some(readiness) = object.get("readiness") {
        let item = only(readiness, &["state", "reason"])?;
        let state = item.get("state").and_then(Value::as_str).filter(|state| ["ready", "signedOut", "unavailable"].contains(state)).ok_or("InvalidShape")?;
        let reason = item.get("reason").and_then(|reason| text_ok(reason, 256)).ok_or("InvalidShape")?;
        parsed.readiness = Some((state.into(), reason.into()));
    }
    if let Some(account) = object.get("account") {
        parsed.account = Some(if account.is_null() { None } else {
            let item = only(account, &["label"])?;
            Some(item.get("label").and_then(|label| text_ok(label, 120)).ok_or("InvalidShape")?.to_owned())
        });
    }
    if let Some(models) = object.get("models") {
        let models = models.as_array().filter(|models| models.len() <= MAX_MODELS).ok_or("InvalidShape")?;
        let kept = models.iter().map(parse_model).collect::<Result<Vec<_>, _>>()?;
        if kept.iter().map(|model| model["id"].as_str()).collect::<std::collections::BTreeSet<_>>().len() != kept.len() { return Err("InvalidShape".into()); }
        parsed.models = Some(kept);
    }
    if let Some(limits) = object.get("limits") { parsed.limits = Some(if limits.is_null() { None } else { Some(parse_limits(limits)?) }); }
    Ok(parsed)
}

/// What the installed package says about the caller, resolved by the app wrapper (`serve_app`) and by tests.
#[derive(Clone, Copy, Debug)]
pub struct Context { pub granted: bool, pub declared: bool }

/// `panda.providers.update(id, state)` of the service of `owner`. Returns the new revision.
pub fn update(owner: &str, id: &str, state: &Value, context: Context) -> Result<u64, String> {
    if !context.granted { return Err("PermissionDenied".into()); }
    if !context.declared || super::providers::extension_owner(id) != Some(owner) { return Err("NotFound".into()); }
    let parsed = match parse(state) {
        Ok(parsed) => parsed,
        Err(code) => { with(|store| { store.entries.entry(id.to_owned()).or_insert_with(|| Entry { owner: owner.into(), ..Entry::default() }).rejected += 1; record(store, "rejected", id, &code); }); return Err(code); }
    };
    Ok(with(|store| {
        let entry = store.entries.entry(id.to_owned()).or_insert_with(|| Entry { owner: owner.into(), ..Entry::default() });
        entry.owner = owner.into();
        let invalidates = parsed.readiness.as_ref().is_some_and(|(state, _)| state != "ready");
        if invalidates {
            // A sign-out (or any not-ready state) takes the account, the models and the limits with it.
            entry.account = Some(None); entry.models = Some(Vec::new()); entry.limits = Some(None);
        } else {
            if parsed.account.is_some() { entry.account = parsed.account; }
            if parsed.models.is_some() { entry.models = parsed.models; }
            if parsed.limits.is_some() { entry.limits = parsed.limits; }
        }
        if let Some(readiness) = parsed.readiness { entry.readiness = Some(readiness); }
        entry.updates += 1;
        entry.at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64);
        let readiness = entry.readiness.as_ref().map_or("manifest".to_owned(), |(state, _)| state.clone());
        store.revision += 1;
        record(store, "update", id, &readiness);
        store.revision
    }))
}

/// The service of `owner` ended, or the package lost its grant or its place: its providers return to the manifest.
pub fn clear_owner(owner: &str, reason: &str) -> bool {
    with(|store| {
        let gone: Vec<String> = store.entries.iter().filter(|(_, entry)| entry.owner == owner).map(|(id, _)| id.clone()).collect();
        for id in &gone { store.entries.remove(id); record(store, "clear", id, reason); }
        if !gone.is_empty() { store.revision += 1; }
        !gone.is_empty()
    })
}
/// Drops the overlay of every package `allowed` refuses (a revoked grant, disable, safe mode). True when anything moved.
pub fn sweep(allowed: &dyn Fn(&str) -> bool, reason: &str) -> bool {
    let owners: Vec<String> = with(|store| store.entries.values().map(|entry| entry.owner.clone()).collect::<std::collections::BTreeSet<_>>().into_iter().collect());
    owners.iter().filter(|owner| !allowed(owner)).fold(false, |moved, owner| clear_owner(owner, reason) | moved)
}

/// The manifest's metadata with the published readiness, account and limits applied. A provider nothing was published
/// for is returned untouched. The launch overlay runs after this one, so an executable that cannot start still wins
/// over a `ready` a service published.
pub(crate) fn apply_metadata(id: &str, mut metadata: Value) -> Value {
    let Some(entry) = with(|store| store.entries.get(id).cloned()) else { return metadata };
    if let Some((state, reason)) = entry.readiness { metadata["readiness"] = json!({"state": state, "reason": reason}); }
    match entry.account { Some(Some(label)) => metadata["account"] = json!({"label": label}), Some(None) => { if let Some(object) = metadata.as_object_mut() { object.remove("account"); } } None => {} }
    match entry.limits { Some(Some(limits)) => metadata["limits"] = limits, Some(None) => { if let Some(object) = metadata.as_object_mut() { object.remove("limits"); } } None => {} }
    metadata
}
/// The model list of provider `id`: the published one, else the manifest's.
pub(crate) fn effective_models(id: &str, definition: &Value) -> Vec<Value> {
    with(|store| store.entries.get(id).and_then(|entry| entry.models.clone())).unwrap_or_else(|| definition["models"].as_array().cloned().unwrap_or_default())
}
/// The published limits of provider `id` (the `limits` resource), when there are any.
#[allow(dead_code)] // read by runtime_usage_resources once the usage view draws published windows (issues file)
pub(crate) fn limits_of(id: &str) -> Option<Value> { with(|store| store.entries.get(id).and_then(|entry| entry.limits.clone().flatten())) }
/// The published account label of provider `id` (the `accounts` resource).
#[allow(dead_code)] // as limits_of
pub(crate) fn account_of(id: &str) -> Option<String> { with(|store| store.entries.get(id).and_then(|entry| entry.account.clone().flatten())) }

/// Whether a service published anything for provider `id` (the `harness` selector of the usage resources accepts it).
pub(crate) fn is_published(id: &str) -> bool { with(|store| store.entries.get(id).is_some_and(|entry| entry.updates > 0)) }
/// The `limits` rows of published providers (`only` narrows to one): the same row shape as a built-in harness's reading.
pub(crate) fn limit_rows(only: Option<&str>) -> Vec<Value> {
    with(|store| store.entries.iter().filter(|(id, _)| only.is_none_or(|only| only == id.as_str())).filter_map(|(id, entry)| {
        let limits = entry.limits.clone().flatten()?;
        Some(json!({"harness": id, "account": "default", "status": "ready", "stale": false, "windows": limits["windows"], "readAt": entry.at}))
    }).collect())
}
/// The `accounts` rows of published providers: the account the service signed in, never a credential.
pub(crate) fn account_rows(only: Option<&str>) -> Vec<Value> {
    with(|store| store.entries.iter().filter(|(id, entry)| only.is_none_or(|only| only == id.as_str()) && entry.updates > 0).map(|(id, entry)| {
        let state = entry.readiness.as_ref().map_or("unchecked", |(state, _)| state.as_str());
        let mut row = json!({"harness": id, "id": "default", "active": true, "signedIn": match state { "ready" => json!(true), "signedOut" => json!(false), _ => Value::Null }, "status": state});
        if let Some(Some(label)) = &entry.account { row["label"] = json!(label); }
        row
    }).collect())
}

/// The command a provider's "Sign in" (`signIn`) or "Sign out" (`signOut`) action runs: a command of the same package.
pub fn action_command(definition: &Value, action: &str, commands: &[String]) -> Option<String> {
    let command = definition["metadata"][action]["command"].as_str()?;
    commands.iter().any(|known| known == command).then(|| command.to_owned())
}

/// The webview's read: no secret, no command output, only what the roster shows.
pub fn projection() -> Value {
    with(|store| {
        let providers: Vec<Value> = store.entries.iter().map(|(id, entry)| json!({
            "id": id, "owner": entry.owner,
            "readiness": entry.readiness.as_ref().map(|(state, reason)| json!({"state": state, "reason": reason})),
            "account": entry.account.clone().map(|account| account.map(|label| json!({"label": label}))),
            "models": entry.models.as_ref().map(|models| models.iter().map(|model| json!({"id": model["id"], "name": model["name"], "efforts": model["efforts"], "contextWindow": model.get("contextWindow"), "speedTiers": model.get("speedTiers")})).collect::<Vec<_>>()),
            "limits": entry.limits.clone(),
            "updates": entry.updates, "rejected": entry.rejected,
        })).collect();
        json!({"schemaVersion": 1, "revision": store.revision, "providers": providers, "recorder": store.recorder.iter().cloned().collect::<Vec<_>>()})
    })
}
/// Test and diagnostics: forgets everything (a new app run starts with no overlay).
#[cfg(test)]
pub(crate) fn reset() { with(|store| *store = Store::default()); }

fn ok(value: Value) -> Value { json!({"ok": true, "value": value}) }

/// Tells every window the provider state moved; the roster and the picker read it again.
pub fn changed(app: &tauri::AppHandle, provider: Option<&str>) {
    use tauri::Emitter;
    let revision = with(|store| store.revision);
    let _ = app.emit("extensions-provider-state", revision);
    if let Some(provider) = provider { let _ = app.emit("provider-models-changed", json!({"provider": provider})); }
}

fn package_view(app: &tauri::AppHandle, owner: &str) -> Option<(Value, bool)> {
    use tauri::Manager;
    let packages = app.state::<super::packages::ExtensionPackages>();
    let packages = packages.0.try_lock().ok()?;
    let snapshot = serde_json::to_value(packages.snapshot()).ok()?;
    if snapshot["safeMode"] == true { return None; }
    let package = snapshot["packages"].as_array()?.iter().find(|package| package["manifest"]["id"] == owner && package["enabled"] == true)?.clone();
    let version = package["manifest"]["version"].as_str().unwrap_or_default().to_owned();
    let granted = app.try_state::<super::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(owner, &version, PERMISSION, &super::runtime_grants::Target::default()).is_ok());
    Some((package, granted))
}

/// Serves a `providerUpdate` request of the service of `owner` against the installed manifest and the live grant.
pub fn serve_app(app: &tauri::AppHandle, owner: &str, params: &Value) -> Value {
    let (Some(id), Some((package, granted))) = (params["id"].as_str(), package_view(app, owner)) else { return super::context::failure("NotFound") };
    let declared = package["manifest"]["contributes"]["providers"].as_array().is_some_and(|providers| providers.iter().any(|provider| provider["id"] == id));
    match update(owner, id, &params["state"], Context { granted, declared }) {
        Ok(_) => { changed(app, Some(id)); ok(Value::Null) }
        Err(code) => super::context::failure(&code),
    }
}

/// The service of `owner` ended for any reason (stop, crash, disable, uninstall, update, trust loss, safe mode).
pub fn service_stopped(app: &tauri::AppHandle, owner: &str) {
    if clear_owner(owner, "service-stopped") { changed(app, None); }
}

/// After a grant changes: a package that no longer holds `ui.dynamic`, is disabled or is in safe mode loses its overlay.
pub fn sweep_app(app: &tauri::AppHandle) {
    let moved = sweep(&|owner| package_view(app, owner).is_some_and(|(_, granted)| granted), "revoked-or-disabled");
    if moved { changed(app, None); }
}

/// The interface reads the published state (main window only: it is the roster's input).
#[tauri::command]
pub fn extensions_provider_state(window: tauri::WebviewWindow) -> Result<Value, String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    Ok(projection())
}

/// The command a provider's "Sign in" or "Sign out" action runs (`action` is `signIn` or `signOut`), main window only.
#[tauri::command]
pub fn extensions_provider_action(window: tauri::WebviewWindow, app: tauri::AppHandle, provider: String, action: String) -> Result<Value, String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    if action != "signIn" && action != "signOut" { return Err("InvalidArguments".into()); }
    let owner = super::providers::extension_owner(&provider).ok_or("NotFound")?.to_owned();
    let (package, _) = package_view(&app, &owner).ok_or("NotFound")?;
    let definition = package["manifest"]["contributes"]["providers"].as_array().and_then(|providers| providers.iter().find(|item| item["id"] == provider.as_str())).ok_or("NotFound")?;
    let commands: Vec<String> = package["manifest"]["contributes"]["commands"].as_array().into_iter().flatten().filter_map(|command| command["id"].as_str().map(str::to_owned)).collect();
    let command = action_command(definition, &action, &commands).ok_or("NotFound")?;
    Ok(json!({"provider": provider, "action": action, "command": command, "owner": owner}))
}

#[cfg(test)]
mod tests {
    use super::*;
    const OWNER: &str = "sample.provider-state";
    const PROVIDER: &str = "sample.provider-state/agent";
    const ALLOWED: Context = Context { granted: true, declared: true };
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-provider-state/extension.json");

    fn manifest_provider() -> Value { serde_json::from_str::<Value>(MANIFEST).unwrap()["contributes"]["providers"][0].clone() }
    fn ready() -> Value {
        json!({"readiness": {"state": "ready", "reason": "Signed in as Fixture User."}, "account": {"label": "Fixture User"},
            "models": [{"id": "fixture-large", "name": "Fixture large", "efforts": ["low", "high"], "contextWindow": 200000, "speedTiers": [{"id": "fast", "name": "Fast"}]}, {"id": "fixture-small", "name": "Fixture small", "efforts": []}],
            "limits": {"windows": [{"id": "session", "label": "Session", "usedPercent": 12.5, "resetsAt": "2026-11-17T12:00:00Z"}], "credits": {"balance": 3}}})
    }
    fn signed_out() -> Value { json!({"readiness": {"state": "signedOut", "reason": "Sign in to use the fixture provider."}}) }
    fn guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        let guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        reset();
        guard
    }

    #[test]
    fn the_fixture_provider_starts_signed_out_with_no_models_and_names_its_commands() {
        let provider = manifest_provider();
        assert_eq!(provider["models"], json!([]));
        assert_eq!(provider["metadata"]["readiness"]["state"], "signedOut");
        let commands: Vec<String> = serde_json::from_str::<Value>(MANIFEST).unwrap()["contributes"]["commands"].as_array().unwrap().iter().map(|command| command["id"].as_str().unwrap().to_owned()).collect();
        assert_eq!(action_command(&provider, "signIn", &commands).as_deref(), Some("sample.provider-state/sign-in"));
        assert_eq!(action_command(&provider, "signOut", &commands).as_deref(), Some("sample.provider-state/sign-out"));
        assert_eq!(action_command(&provider, "signIn", &[]), None, "a command the package does not own is never bound");
    }

    #[test]
    fn sign_in_publishes_models_limits_and_account_and_sign_out_invalidates_them() {
        let _guard = guard();
        let provider = manifest_provider();
        assert_eq!(apply_metadata(PROVIDER, provider["metadata"].clone()), provider["metadata"], "nothing published: the manifest's values");
        assert!(effective_models(PROVIDER, &provider).is_empty());
        let revision = update(OWNER, PROVIDER, &ready(), ALLOWED).unwrap();
        let metadata = apply_metadata(PROVIDER, provider["metadata"].clone());
        assert_eq!(metadata["readiness"]["state"], "ready");
        assert_eq!(metadata["account"], json!({"label": "Fixture User"}));
        assert_eq!(metadata["limits"]["windows"][0]["usedPercent"], 12.5);
        assert_eq!(effective_models(PROVIDER, &provider).iter().map(|model| model["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>(), ["fixture-large", "fixture-small"]);
        assert_eq!(limits_of(PROVIDER).unwrap()["windows"][0]["id"], "session");
        assert_eq!(account_of(PROVIDER).as_deref(), Some("Fixture User"));
        // Sign-out: readiness is invalidated and nothing ready-looking survives, whatever else the update carried.
        let mut leaving = signed_out(); leaving["models"] = ready()["models"].clone(); leaving["limits"] = ready()["limits"].clone();
        assert!(update(OWNER, PROVIDER, &leaving, ALLOWED).unwrap() > revision);
        let metadata = apply_metadata(PROVIDER, provider["metadata"].clone());
        assert_eq!(metadata["readiness"]["state"], "signedOut");
        assert!(metadata.get("account").is_none() && metadata.get("limits").is_none());
        assert!(effective_models(PROVIDER, &provider).is_empty());
        assert_eq!((limits_of(PROVIDER), account_of(PROVIDER)), (None, None));
        // Signing in again restores the same published values.
        update(OWNER, PROVIDER, &ready(), ALLOWED).unwrap();
        assert_eq!(effective_models(PROVIDER, &provider).len(), 2);
    }

    #[test]
    fn partial_updates_merge_and_a_fault_leaves_the_previous_state() {
        let _guard = guard();
        update(OWNER, PROVIDER, &ready(), ALLOWED).unwrap();
        update(OWNER, PROVIDER, &json!({"limits": {"windows": [{"id": "session", "label": "Session", "usedPercent": 99}]}}), ALLOWED).unwrap();
        assert_eq!(limits_of(PROVIDER).unwrap()["windows"][0]["usedPercent"], 99.0);
        assert_eq!(effective_models(PROVIDER, &manifest_provider()).len(), 2, "an update of limits leaves the models");
        let before = projection();
        for bad in [json!({}), json!({"extra": 1}), json!({"readiness": {"state": "ready"}}), json!({"readiness": {"state": "fine", "reason": "x"}}), json!({"account": {"label": "x", "token": "y"}}),
            json!({"models": [{"id": "a", "name": "A", "efforts": ["Bad Effort"]}]}), json!({"models": [{"id": "a", "name": "A", "efforts": []}, {"id": "a", "name": "A", "efforts": []}]}),
            json!({"limits": {"windows": [{"id": "s", "label": "S", "usedPercent": 101}]}}), json!({"limits": {"windows": [], "secret": "x"}}), json!("ready")] {
            assert!(update(OWNER, PROVIDER, &bad, ALLOWED).is_err(), "{bad}");
        }
        assert_eq!(update(OWNER, PROVIDER, &json!({"limits": {"windows": [], "credits": "x".repeat(4096)}}), ALLOWED).unwrap_err(), "LimitExceeded");
        let after = projection();
        assert_eq!(after["providers"][0]["models"], before["providers"][0]["models"]);
        assert_eq!(after["providers"][0]["limits"], before["providers"][0]["limits"]);
        assert_eq!(after["providers"][0]["updates"], before["providers"][0]["updates"], "a rejected update is only counted");
        assert!(after["providers"][0]["rejected"].as_u64().unwrap() >= 11);
    }

    #[test]
    fn grant_ownership_and_declaration_are_checked_on_every_call() {
        let _guard = guard();
        assert_eq!(update(OWNER, PROVIDER, &ready(), Context { granted: false, declared: true }).unwrap_err(), "PermissionDenied");
        assert_eq!(update(OWNER, PROVIDER, &ready(), Context { granted: true, declared: false }).unwrap_err(), "NotFound");
        assert_eq!(update("other.package", PROVIDER, &ready(), ALLOWED).unwrap_err(), "NotFound", "a package updates only its own providers");
        assert_eq!(update(OWNER, "codex", &ready(), ALLOWED).unwrap_err(), "NotFound", "a built-in provider is never updated");
        assert!(projection()["providers"].as_array().unwrap().is_empty());
    }

    #[test]
    fn stop_revoke_disable_and_safe_mode_return_the_manifest_values() {
        let _guard = guard();
        let provider = manifest_provider();
        update(OWNER, PROVIDER, &ready(), ALLOWED).unwrap();
        update("sample.other", "sample.other/agent", &ready(), ALLOWED).unwrap();
        assert!(clear_owner(OWNER, "service-stopped"));
        assert!(!clear_owner(OWNER, "service-stopped"), "already clear");
        assert_eq!(apply_metadata(PROVIDER, provider["metadata"].clone()), provider["metadata"]);
        assert!(effective_models(PROVIDER, &provider).is_empty());
        assert_eq!(projection()["providers"].as_array().unwrap().len(), 1, "another package keeps its overlay");
        update(OWNER, PROVIDER, &ready(), ALLOWED).unwrap();
        assert!(sweep(&|owner| owner == "sample.other", "revoked-or-disabled"));
        assert_eq!(projection()["providers"].as_array().unwrap().iter().map(|item| item["owner"].as_str().unwrap()).collect::<Vec<_>>(), ["sample.other"]);
        assert!(!sweep(&|_| true, "x"));
        assert!(projection()["recorder"].as_array().unwrap().iter().any(|item| item["what"] == "clear" && item["detail"] == "revoked-or-disabled"));
    }

    #[test]
    fn the_projection_carries_no_credential_and_no_command_output() {
        let _guard = guard();
        let canary = ["canary", "token", "r0806"].join("-");
        let mut state = ready();
        state["readiness"]["reason"] = json!("Signed in.");
        update(OWNER, PROVIDER, &state, ALLOWED).unwrap();
        assert!(update(OWNER, PROVIDER, &json!({"account": {"label": "x", "accessToken": canary}}), ALLOWED).is_err(), "no field can carry a token");
        assert!(!projection().to_string().contains(&canary));
    }

    /// A really installed package (archive, trust, enable): the launch provider starts signed out with no models;
    /// publishing sign-in state fills the native roster and the send path without starting any process; two tasks
    /// of the package share one launch state; sign-out and a stop of the service invalidate readiness again.
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    mod installed {
        use super::*;
        use crate::{extensions::{packages::ExtensionPackages, runtime_provider_launch as launch}, providers};
        use std::{io::Write, path::{Path, PathBuf}, sync::Arc, time::Duration};

        const AGENT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/extensions/backends/fake-agent.mjs");
        struct Dir(PathBuf);
        impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-provider-state-test-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
        impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

        fn archive(manifest: &str) -> Vec<u8> {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            for (name, bytes) in [("extension.json", manifest.as_bytes()), ("main.cjs", b"module.exports = { service: async () => {} };".as_slice())] {
                writer.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap().into_inner()
        }
        async fn send(dir: &Path, session: &str, model: &str, prompt: &str) -> (Result<(), String>, Vec<providers::AgentEvent>) {
            let config = providers::RunConfig { session_id: session.into(), provider: PROVIDER.into(), model: model.into(), reasoning_effort: None, mode: "ask".into(), cwd: dir.to_path_buf(), resume_id: None, prompt: prompt.into(), instructions: String::new(), skill: None, goal: None, codex_settings: None, images: vec![] };
            let (_input, rx) = tokio::sync::mpsc::unbounded_channel();
            let (events, mut output) = tokio::sync::mpsc::unbounded_channel();
            let result = tokio::time::timeout(Duration::from_secs(60), providers::run(config, Arc::new(move |event| { let _ = events.send(event); }), rx)).await.expect("the run finishes");
            let mut seen = Vec::new();
            while let Ok(event) = output.try_recv() { seen.push(event); }
            (result, seen)
        }
        fn discovered() -> providers::ProviderInfo { providers::dynamic_adapter::discover().into_iter().find(|provider| provider.id == PROVIDER).expect("the provider is registered") }

        // The test lock serializes the global provider state; the test runs on its own current-thread runtime, so no other
        // task on this thread can wait for the guard while it is held across an await.
        #[allow(clippy::await_holding_lock)]
        #[tokio::test]
        async fn the_roster_picker_and_send_path_follow_fake_sign_in_and_sign_out_without_starting_the_package() {
            let _host = providers::dynamic_adapter::TEST_HOST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let _guard = guard();
            let dir = Dir::new();
            let packages = ExtensionPackages::new(&dir.0, false);
            providers::dynamic_adapter::configure(&packages.0, Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")));
            launch::forget(OWNER);
            let mut manifest: Value = serde_json::from_str(MANIFEST).unwrap();
            manifest["contributes"]["providers"][0]["launch"]["command"][1] = json!(AGENT);
            {
                let guard = packages.0.lock().unwrap();
                guard.install(&archive(&manifest.to_string())).unwrap();
                let digest = serde_json::to_value(guard.snapshot()).unwrap()["packages"][0]["executable"]["digest"].as_str().unwrap().to_owned();
                guard.trust(OWNER, &digest, true).unwrap();
                guard.enable(OWNER, true).unwrap();
            }
            // Signed out: registered, not ready, no models, an explicit reason at the send path; nothing started.
            let signed_out_info = discovered();
            assert!(signed_out_info.models.is_empty() && !signed_out_info.installed);
            assert_eq!(signed_out_info.metadata.as_ref().unwrap()["readiness"]["state"], "signedOut");
            assert_eq!(providers::dynamic_adapter::require_available(PROVIDER).unwrap_err(), "Sign in to use the fixture provider.");
            assert!(providers::dynamic_adapter::models(PROVIDER).unwrap().is_empty());
            // Fake sign-in: the service publishes the account's models and limits (the B3/B4 flow itself is `runtime_sign_in::tests`).
            update(OWNER, PROVIDER, &ready(), ALLOWED).unwrap();
            let ready_info = discovered();
            assert!(ready_info.installed);
            assert_eq!(ready_info.models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["fixture-large", "fixture-small"]);
            assert_eq!(ready_info.models[0].context_window, Some(200000));
            assert_eq!(ready_info.models[0].speed_tiers[0].id, "fast");
            assert_eq!(ready_info.metadata.as_ref().unwrap()["account"], json!({"label": "Fixture User"}));
            assert_eq!(providers::dynamic_adapter::models(PROVIDER).unwrap().len(), 2);
            assert!(providers::dynamic_adapter::require_available(PROVIDER).is_ok());
            // Publishing and reading the roster started nothing: no handshake, no token, no run state.
            let state = launch::snapshot(OWNER);
            assert_eq!((state.handshakes, state.tokens_issued, state.active), (0, 0, 0), "{state:?}");
            // Two tasks reuse the one service session state.
            let slow = |text: &str| format!("#script [{{\"sleep\":400}},{{\"say\":\"{text}\"}}]");
            let (first, second) = (slow("first"), slow("second"));
            let (one, two) = tokio::join!(send(&dir.0, "state-one", "fixture-large", &first), send(&dir.0, "state-two", "fixture-small", &second));
            assert!(one.0.is_ok() && two.0.is_ok(), "{:?} {:?}", one.0, two.0);
            let state = launch::snapshot(OWNER);
            assert_eq!((state.tokens_issued, state.handshakes, state.peak, state.active), (2, 2, 2, 0), "{state:?}");
            // A model the account does not have is refused from the published list.
            assert!(send(&dir.0, "state-three", "not-a-model", "hi").await.0.is_err());
            // Sign-out invalidates readiness, models and limits at once and the send path says why.
            update(OWNER, PROVIDER, &signed_out(), ALLOWED).unwrap();
            let after = discovered();
            assert!(after.models.is_empty() && !after.installed);
            assert!(after.metadata.as_ref().unwrap().get("account").is_none() && after.metadata.as_ref().unwrap().get("limits").is_none());
            assert_eq!(providers::dynamic_adapter::require_available(PROVIDER).unwrap_err(), "Sign in to use the fixture provider.");
            assert!(send(&dir.0, "state-four", "fixture-large", "hi").await.0.is_err());
            // Fault, stop and disable return the manifest values.
            update(OWNER, PROVIDER, &ready(), ALLOWED).unwrap();
            assert!(update(OWNER, PROVIDER, &json!({"models": "no"}), ALLOWED).is_err());
            assert_eq!(discovered().models.len(), 2, "a rejected update changes nothing");
            assert!(clear_owner(OWNER, "service-stopped"));
            assert!(discovered().models.is_empty());
            update(OWNER, PROVIDER, &ready(), ALLOWED).unwrap();
            packages.0.lock().unwrap().enable(OWNER, false).unwrap();
            assert!(sweep(&|_| false, "revoked-or-disabled"));
            assert!(projection()["providers"].as_array().unwrap().is_empty());
            launch::forget(OWNER);
        }
    }
}
