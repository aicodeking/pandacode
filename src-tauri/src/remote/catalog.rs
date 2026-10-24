//! The harnesses and models on another computer, for the model picker of a task that runs
//! there: asked from the host (`providers.list`, `providers.models`) and kept here per
//! device for ten minutes.
use super::{client, remote, socket, Inner};
use crate::{AppState, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
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
        if model == "default" {
            return Ok(());
        }
        if let Some(models) = self.get(&(device.into(), Some(provider.into())), now, None) {
            if !models.as_array().into_iter().flatten().any(|m| m["id"] == model) {
                return Err(format!("{model} is not available for {provider} on {name}."));
            }
        }
        Ok(())
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
    let state = remote(app);
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
    if let Some(value) = state.lock().catalog.get(&key, Instant::now(), after) {
        return Ok(value);
    }
    let value = client::call(app, &key.0, method, params).await?;
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
    cached(app, (device, Some(provider.into())), force, "providers.models", json!({"provider": provider, "force": force})).await.map(Some)
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
