//! The harnesses and models on another computer, for the model picker of a task that runs
//! there: asked from the host (`providers.list`, `providers.models`) and kept here per
//! device for ten minutes.
use super::{client, remote, socket, Inner};
use crate::{AppState, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

const FRESH: Duration = Duration::from_secs(10 * 60);

/// (device, provider); no provider for the provider list.
type Key = (String, Option<String>);

#[derive(Default)]
pub(crate) struct Cache {
    entries: HashMap<Key, (Instant, Value)>,
    /// One lock per key, so identical requests share one call to the host.
    flights: HashMap<Key, Arc<tokio::sync::Mutex<()>>>,
    /// Providers whose models were asked for, per device: warmed with its list.
    asked: HashSet<(String, String)>,
    /// When each key was last warmed. Kept when a device's replies are forgotten, so a host
    /// that flaps is still asked at most once per [`FRESH`].
    warmed: HashMap<Key, Instant>,
}

impl Cache {
    /// A reply still fresh at `now`; for a forced request (`after`), only one fetched since.
    fn get(&self, key: &Key, now: Instant, after: Option<Instant>) -> Option<Value> {
        let (at, value) = self.entries.get(key)?;
        let fresh = match after {
            Some(after) => *at >= after,
            None => now.saturating_duration_since(*at) < FRESH,
        };
        fresh.then(|| value.clone())
    }

    pub(crate) fn put(&mut self, key: Key, at: Instant, value: Value) {
        self.entries.insert(key, (at, value));
        self.flights.retain(|_, flight| Arc::strong_count(flight) > 1);
    }

    fn flight(&mut self, key: &Key) -> Arc<tokio::sync::Mutex<()>> {
        self.flights.entry(key.clone()).or_default().clone()
    }

    /// Drops what a device said when it goes offline, comes back, or changes hosting.
    pub(crate) fn forget(&mut self, device: &str) {
        self.entries.retain(|(id, _), _| id != device);
    }

    /// The ids of the harnesses `device` has installed, from the cached list alone.
    pub(crate) fn harnesses(&self, device: &str, now: Instant) -> Option<Vec<String>> {
        let list = self.get(&(device.into(), None), now, None)?;
        Some(list.as_array().into_iter().flatten().filter(|p| p["installed"] == true).filter_map(|p| p["id"].as_str().map(str::to_owned)).collect())
    }

    /// The lists to fetch for `device` now, marked as warmed: its providers and the models of
    /// any provider asked for, unless fresh or warmed within [`FRESH`].
    fn due_to_warm(&mut self, device: &str, now: Instant) -> Vec<Key> {
        let models = self.asked.iter().filter(|(id, _)| id == device).map(|(_, provider)| Some(provider.clone()));
        let keys: Vec<Key> = std::iter::once(None).chain(models).map(|provider| (device.to_owned(), provider)).collect();
        let due: Vec<Key> = keys.into_iter().filter(|key| self.get(key, now, None).is_none() && self.warmed.get(key).is_none_or(|at| now.saturating_duration_since(*at) >= FRESH)).collect();
        due.iter().for_each(|key| {
            self.warmed.insert(key.clone(), now);
        });
        due
    }

    #[cfg(test)]
    pub(crate) fn knows(&self, device: &str) -> bool {
        self.entries.keys().any(|(id, _)| id == device)
    }

    /// Refuses a harness or model the cached lists say `device` (named `name`) lacks.
    /// Nothing cached, nothing refused: the host still checks.
    fn check(&self, device: &str, name: &str, provider: &str, model: &str, now: Instant) -> Result<()> {
        if let Some(list) = self.get(&(device.into(), None), now, None) {
            let found = list.as_array().into_iter().flatten().find(|p| p["id"] == provider);
            if !found.is_some_and(|p| p["installed"] == true) {
                let label = found.and_then(|p| p["name"].as_str()).unwrap_or(provider);
                return Err(format!("{label} is not installed on {name}."));
            }
        }
        if self.has_model(device, provider, model, now) == Some(false) {
            return Err(format!("{model} is not available for {provider} on {name}."));
        }
        Ok(())
    }

    /// Whether `device` lists `model` for `provider`; None when its list isn't cached. `default`
    /// is always there.
    pub(crate) fn has_model(&self, device: &str, provider: &str, model: &str, now: Instant) -> Option<bool> {
        if model == "default" {
            return Some(true);
        }
        let models = self.get(&(device.into(), Some(provider.into())), now, None)?;
        Some(models.as_array().into_iter().flatten().any(|m| m["id"] == model))
    }
}

/// The device a picker request goes to, or None for this computer.
pub(crate) fn target(device_id: Option<String>, me: &str) -> Option<String> {
    device_id.filter(|id| !id.is_empty() && id != me)
}

/// The usual errors for an unknown or offline host, even on a cache hit.
fn ready(inner: &Inner, device: &str) -> Result<()> {
    inner.callable(device)?;
    if !inner.devices.iter().any(|d| d.id == device && d.online) {
        return Err(socket::OFFLINE.into());
    }
    Ok(())
}

async fn cached(app: &tauri::AppHandle, key: Key, force: bool, method: &str, params: Value) -> Result<Value> {
    let device = key.0.clone();
    let call = client::call(app, &device, method, params);
    fill(&remote(app), key, force, |_, _| Ok(()), call).await
}

/// The reply for `key`, cached or from `call`. `gate` is asked right before the call goes out,
/// after any wait for an identical request.
async fn fill(state: &super::Remote, key: Key, force: bool, gate: impl Fn(&Inner, &str) -> Result<()>, call: impl std::future::Future<Output = Result<Value>>) -> Result<Value> {
    let asked = Instant::now();
    let after = force.then_some(asked);
    let flight = {
        let mut inner = state.lock();
        ready(&inner, &key.0)?;
        if let Some(value) = inner.catalog.get(&key, asked, after) {
            return Ok(value);
        }
        inner.catalog.flight(&key)
    };
    let _turn = flight.lock().await;
    // A call that finished while this one waited answers it too.
    {
        let inner = state.lock();
        if let Some(value) = inner.catalog.get(&key, Instant::now(), after) {
            return Ok(value);
        }
        gate(&inner, &key.0)?;
    }
    let value = call.await?;
    if !value.is_array() {
        return Err("The other computer sent an invalid list.".into());
    }
    state.lock().catalog.put(key, Instant::now(), value.clone());
    Ok(value)
}

/// `list_providers` with a `deviceId`. This computer's own id lists locally.
pub(crate) async fn providers(app: &tauri::AppHandle, device_id: Option<String>, force: bool) -> Result<Option<Value>> {
    let Some(device) = target(device_id, &remote(app).device_id()) else { return Ok(None) };
    super::valid_device_id(&device)?;
    cached(app, (device, None), force, "providers.list", json!({"force": force})).await.map(Some)
}

/// `list_provider_models` with a `deviceId`.
pub(crate) async fn models(app: &tauri::AppHandle, device_id: Option<String>, provider: &str, force: bool) -> Result<Option<Value>> {
    let Some(device) = target(device_id, &remote(app).device_id()) else { return Ok(None) };
    super::valid_device_id(&device)?;
    if !super::host::PROVIDERS.contains(&provider) {
        return Err("Unknown provider.".into());
    }
    remote(app).lock().catalog.asked.insert((device.clone(), provider.to_owned()));
    cached(app, (device, Some(provider.into())), force, "providers.models", json!({"provider": provider, "force": force})).await.map(Some)
}

/// Fetches what `device`'s catalog lacks, in the background, sending nothing once orchestration
/// is off or the link no longer counts. A fetch that fails may be tried again the next time the
/// device is warmed.
pub(crate) fn warm(app: &tauri::AppHandle, device: &str) {
    let keys = remote(app).lock().catalog.due_to_warm(device, Instant::now());
    for key in keys {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let (method, params) = match &key.1 {
                Some(provider) => ("providers.models", json!({"provider": provider, "force": false})),
                None => ("providers.list", json!({"force": false})),
            };
            let call = client::call(&app, &key.0, method, params);
            let asked = fill(&remote(&app), key.clone(), false, super::orchestrate::links::may_warm, call).await;
            if asked.is_err() {
                remote(&app).lock().catalog.warmed.remove(&key);
            }
        });
    }
}

/// Refuses a harness or model the host is known not to have.
pub(crate) fn check(app: &tauri::AppHandle, device: &str, provider: &str, model: &str) -> Result<()> {
    remote(app).lock().catalog.check(device, &super::device_label(device), provider, model, Instant::now())
}

/// [`check`] for a mirror's model change; ordinary tasks pass.
pub(crate) fn check_mirror(app: &tauri::AppHandle, state: &AppState, session_id: &str, provider: &str, model: &str) -> Result<()> {
    let mirror = super::mirror::of(&*state.store.lock().map_err(|e| e.to_string())?, session_id)?;
    mirror.map_or(Ok(()), |mirror| check(app, &mirror.device, provider, model))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(provider: Option<&str>) -> Key {
        ("studio".into(), provider.map(str::to_owned))
    }

    #[test]
    fn replies_stay_fresh_for_ten_minutes_unless_forced() {
        let mut cache = Cache::default();
        let start = Instant::now();
        assert_eq!(cache.get(&key(None), start, None), None);
        cache.put(key(None), start, json!([1]));
        assert_eq!(cache.get(&key(None), start + Duration::from_secs(9 * 60), None), Some(json!([1])));
        assert_eq!(cache.get(&key(None), start + FRESH, None), None);
        // Forced: only a reply fetched after the request began counts.
        assert_eq!(cache.get(&key(None), start, Some(start + Duration::from_secs(1))), None);
        cache.put(key(None), start + Duration::from_secs(2), json!([2]));
        assert_eq!(cache.get(&key(None), start, Some(start + Duration::from_secs(1))), Some(json!([2])));
        // Per provider, and forgotten per device.
        cache.put(key(Some("claude")), start, json!([3]));
        cache.put(("other".into(), None), start, json!([4]));
        cache.forget("studio");
        assert_eq!((cache.get(&key(None), start, None), cache.get(&key(Some("claude")), start, None)), (None, None));
        assert_eq!(cache.get(&("other".into(), None), start, None), Some(json!([4])));
    }

    #[test]
    fn warming_asks_for_what_is_missing_at_most_once_per_ten_minutes() {
        let mut cache = Cache::default();
        let start = Instant::now();
        assert_eq!(cache.due_to_warm("studio", start), vec![key(None)]);
        assert_eq!(cache.due_to_warm("studio", start + Duration::from_secs(60)), Vec::<Key>::new(), "coalesced while the fetch runs");
        cache.put(key(None), start, json!([]));
        cache.asked.insert(("studio".into(), "claude".into()));
        cache.asked.insert(("other".into(), "codex".into()));
        assert_eq!(cache.due_to_warm("studio", start + Duration::from_secs(60)), vec![key(Some("claude"))], "a provider asked for, on that device only");
        // The device flapped: its replies are forgotten, but it is not asked again yet.
        cache.forget("studio");
        assert_eq!(cache.due_to_warm("studio", start + Duration::from_secs(120)), Vec::<Key>::new());
        let mut later = cache.due_to_warm("studio", start + FRESH + Duration::from_secs(60));
        later.sort();
        assert_eq!(later, vec![key(None), key(Some("claude"))]);
    }

    /// A `Remote` with `studio` linked and online, the catalog empty.
    fn linked_remote() -> super::super::Remote {
        let key = "k".to_string();
        let mut inner = Inner { token: Some("t".into()), devices: vec![super::super::tests::device("studio", "Studio", &key)], ..Default::default() };
        inner.settings.device_id = "me".into();
        inner.settings.orchestration = true;
        inner.settings.links.insert("studio".into(), super::super::config::Link { access: super::super::config::Access::Ask, at: 1, key, name: String::new() });
        super::super::Remote { dir: std::env::temp_dir(), inner: std::sync::Mutex::new(inner), key: Default::default(), saving: Default::default() }
    }

    #[tokio::test]
    async fn a_warm_sends_nothing_once_it_may_not() {
        async fn warm(state: &super::super::Remote, called: &std::sync::atomic::AtomicBool) -> Result<Value> {
            let call = async {
                called.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(json!([]))
            };
            fill(state, key(None), false, crate::remote::orchestrate::links::may_warm, call).await
        }
        let called = std::sync::atomic::AtomicBool::new(false);
        let sent = |called: &std::sync::atomic::AtomicBool| called.swap(false, std::sync::atomic::Ordering::SeqCst);
        // A change while the warm waits for an identical request: it is seen right before the call.
        for change in [
            (|inner: &mut Inner| inner.settings.orchestration = false) as fn(&mut Inner),
            |inner| inner.token = None,
            |inner| {
                inner.settings.links.clear();
            },
        ] {
            let state = linked_remote();
            let flight = state.lock().catalog.flight(&key(None));
            let held = flight.lock().await;
            let running = warm(&state, &called);
            tokio::pin!(running);
            assert!(tokio::time::timeout(Duration::from_millis(20), &mut running).await.is_err(), "waits its turn");
            change(&mut state.lock());
            drop(held);
            assert!(running.await.is_err());
            assert!(!sent(&called), "nothing went out");
        }
        let state = linked_remote();
        assert_eq!(warm(&state, &called).await, Ok(json!([])));
        assert!(sent(&called), "still linked: it goes");
    }

    #[test]
    fn harnesses_come_from_the_cached_list_only() {
        let mut cache = Cache::default();
        let now = Instant::now();
        assert_eq!(cache.harnesses("studio", now), None, "not cached: unknown, never asked");
        cache.put(key(None), now, json!([{"id": "claude", "installed": true}, {"id": "codex", "installed": false}]));
        assert_eq!(cache.harnesses("studio", now), Some(vec!["claude".to_string()]));
        assert_eq!(cache.harnesses("studio", now + FRESH), None, "stale counts as not cached");
    }

    #[test]
    fn identical_requests_share_a_flight() {
        let mut cache = Cache::default();
        let (a, b) = (cache.flight(&key(None)), cache.flight(&key(None)));
        assert!(Arc::ptr_eq(&a, &b));
        assert!(!Arc::ptr_eq(&a, &cache.flight(&key(Some("codex")))));
        drop((a, b));
        cache.put(key(None), Instant::now(), json!([]));
        assert!(cache.flights.is_empty());
    }

    #[test]
    fn starts_and_model_changes_follow_the_cached_lists() {
        let mut cache = Cache::default();
        let now = Instant::now();
        assert_eq!(cache.check("studio", "Studio", "codex", "gpt", now), Ok(()));
        cache.put(key(None), now, json!([{"id": "claude", "name": "Claude Code", "installed": true}, {"id": "codex", "name": "Codex", "installed": false}]));
        cache.put(key(Some("claude")), now, json!([{"id": "default"}, {"id": "sonnet"}]));
        assert_eq!(cache.check("studio", "Studio", "claude", "sonnet", now), Ok(()));
        assert_eq!(cache.check("studio", "Studio", "claude", "default", now), Ok(()));
        assert_eq!(cache.check("studio", "Studio", "claude", "opus-9", now), Err("opus-9 is not available for claude on Studio.".into()));
        assert_eq!((cache.has_model("studio", "claude", "sonnet", now), cache.has_model("studio", "claude", "opus-9", now)), (Some(true), Some(false)));
        assert_eq!((cache.has_model("studio", "codex", "gpt", now), cache.has_model("studio", "codex", "default", now)), (None, Some(true)), "not cached: unknown; default always");
        assert_eq!(cache.check("studio", "Studio", "codex", "gpt", now), Err("Codex is not installed on Studio.".into()));
        assert_eq!(cache.check("studio", "Studio", "kimi", "k2", now), Err("kimi is not installed on Studio.".into()));
    }

    #[test]
    fn a_device_id_routes_to_that_computer_unless_it_is_this_one() {
        assert_eq!(target(None, "me"), None);
        assert_eq!(target(Some(String::new()), "me"), None);
        assert_eq!(target(Some("me".into()), "me"), None);
        assert_eq!(target(Some("studio".into()), "me"), Some("studio".into()));
    }
}
