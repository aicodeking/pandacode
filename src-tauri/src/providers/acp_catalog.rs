//! Positive ACP model metadata shared by settings and command discovery.
//! Commands themselves remain scoped to their project directory.
use super::{acp, ModelInfo};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{Duration, Instant, SystemTime},
};

const TTL: Duration = Duration::from_secs(5 * 60);
const LIMIT: usize = 16;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct Key {
    provider: String,
    path: PathBuf,
    modified: Option<SystemTime>,
    length: u64,
}

fn key(provider: &str, path: &Path) -> Key {
    let metadata = path.metadata().ok();
    Key {
        provider: provider.into(),
        path: path.into(),
        modified: metadata.as_ref().and_then(|value| value.modified().ok()),
        length: metadata.map_or(0, |value| value.len()),
    }
}

#[derive(Default)]
struct Cache(HashMap<Key, (Instant, Vec<ModelInfo>)>, u64);

pub(crate) struct Discovery {
    key: Key,
    revision: u64,
}

impl Cache {
    fn begin(&self, key: Key) -> Discovery {
        Discovery {
            key,
            revision: self.1,
        }
    }

    fn commit(&mut self, discovery: Discovery, models: Vec<ModelInfo>, now: Instant) {
        if discovery.revision == self.1 {
            self.store(discovery.key, models, now);
        }
    }

    fn invalidate(&mut self, provider: &str) {
        self.1 = self.1.wrapping_add(1);
        self.0.retain(|key, _| key.provider != provider);
    }

    /// Expired catalogs are never reused, so drop them whenever the cache is
    /// read or written instead of keeping them for the life of the process.
    fn purge(&mut self, now: Instant) {
        self.0
            .retain(|_, (at, _)| now.saturating_duration_since(*at) < TTL);
    }

    fn get(&mut self, key: &Key, now: Instant) -> Option<Vec<ModelInfo>> {
        self.purge(now);
        self.0.get(key).map(|(_, models)| models.clone())
    }

    fn store(&mut self, key: Key, models: Vec<ModelInfo>, now: Instant) {
        // A default-only response is not a catalog and must not overwrite a
        // previously discovered usable list.
        if models.len() <= 1 {
            return;
        }
        self.purge(now);
        self.0.retain(|existing, _| {
            !(existing.provider == key.provider && existing.path == key.path)
        });
        if self.0.len() >= LIMIT {
            if let Some(oldest) = self
                .0
                .iter()
                .min_by_key(|(_, (at, _))| at)
                .map(|(key, _)| key.clone())
            {
                self.0.remove(&oldest);
            }
        }
        self.0.insert(key, (now, models));
    }
}

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

pub(crate) fn get(provider: &str, path: &Path) -> Option<Vec<ModelInfo>> {
    cache()
        .lock()
        .ok()?
        .get(&key(provider, path), Instant::now())
}

/// Capture before starting a process so Refresh can invalidate in-flight work,
/// and replacing an executable cannot attach its old response to the new file.
pub(crate) fn begin(provider: &str, path: &Path) -> Option<Discovery> {
    Some(cache().lock().ok()?.begin(key(provider, path)))
}

pub(crate) fn store(discovery: Option<Discovery>, metadata: &Value) {
    let Some(discovery) = discovery else {
        return;
    };
    let models = acp::parse_models_for(&discovery.key.provider, metadata);
    store_models(Some(discovery), models);
}

/// For harnesses whose catalog takes more than one `session/new` result (Devin).
pub(crate) fn store_models(discovery: Option<Discovery>, models: Vec<ModelInfo>) {
    let Some(discovery) = discovery else {
        return;
    };
    if key(&discovery.key.provider, &discovery.key.path) != discovery.key {
        return;
    }
    if let Ok(mut cache) = cache().lock() {
        cache.commit(discovery, models, Instant::now());
    }
}

pub(crate) fn invalidate(provider: &str) {
    if let Ok(mut cache) = cache().lock() {
        cache.invalidate(provider);
    }
}

/// Callers recheck the positive cache after acquiring this guard. Weak entries
/// disappear when callers finish, so changing an executable never grows a
/// permanent lock registry or blocks a different executable's discovery.
pub(crate) async fn refresh_lock(provider: &str, path: &Path) -> tokio::sync::OwnedMutexGuard<()> {
    type Locks = HashMap<Key, Weak<tokio::sync::Mutex<()>>>;
    static LOCKS: OnceLock<Mutex<Locks>> = OnceLock::new();
    let lock = {
        let mut locks = LOCKS
            .get_or_init(Mutex::default)
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        locks.retain(|_, lock| lock.strong_count() > 0);
        let weak = locks.entry(key(provider, path)).or_default();
        weak.upgrade().unwrap_or_else(|| {
            let lock = Arc::new(tokio::sync::Mutex::new(()));
            *weak = Arc::downgrade(&lock);
            lock
        })
    };
    lock.lock_owned().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    static GLOBAL_CACHE_TEST: Mutex<()> = Mutex::new(());

    #[test]
    fn positive_catalog_is_bounded_expires_and_follows_executable_identity() {
        let now = Instant::now();
        let identity = key("antigravity", Path::new("/fixture/agy"));
        let metadata =
            json!({"models":{"availableModels":[{"modelId":"model-a","name":"Model A"}]}});
        let mut cache = Cache::default();
        cache.store(identity.clone(), acp::parse_models(&metadata), now);
        assert_eq!(cache.get(&identity, now).unwrap()[1].id, "model-a");
        cache.store(identity.clone(), acp::parse_models(&json!({})), now);
        assert!(cache.get(&identity, now).is_some());
        assert!(cache.get(&identity, now + TTL).is_none());
        let mut replaced = identity.clone();
        replaced.length = 42;
        assert!(cache.get(&replaced, now).is_none());
        assert!(cache
            .get(&key("grok", Path::new("/fixture/agy")), now)
            .is_none());
        for index in 0..30 {
            cache.store(
                key("antigravity", Path::new(&format!("/fixture/{index}"))),
                acp::parse_models(&metadata),
                now,
            );
        }
        assert_eq!(cache.0.len(), LIMIT);
    }

    #[test]
    fn deepseek_cached_efforts_cover_api_and_account_models_only() {
        let _guard = GLOBAL_CACHE_TEST.lock().unwrap();
        let path = std::env::temp_dir().join(format!("deepseek-catalog-{}", uuid::Uuid::new_v4()));
        let api = "[\"deepseek-official\",\"deepseek-v4-flash\"]";
        let account = "[\"deepseek-account\",\"DeepSeek-V4.1-Flash\"]";
        let pro = "[\"deepseek-account\",\"DeepSeek-V4-Pro\"]";
        let metadata = json!({"configOptions":[
            {"id":"model","category":"model","type":"select","currentValue":api,"options":[
                {"group":"deepseek-official","options":[{"value":api}]},
                {"group":"deepseek-account","options":[{"value":account},{"value":pro}]}]},
            {"id":"reasoning_effort","category":"thought_level","type":"select","currentValue":"high","options":[
                {"value":"off"},{"value":"low"},{"value":"high"},{"value":"max"}]}]});
        // Both model discovery and command discovery populate this cache.
        for provider in ["deepseek", "kilo"] {
            store(begin(provider, &path), &metadata);
            let models = get(provider, &path).unwrap();
            assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["default", api, account, pro]);
            assert!(models[0].reasoning_efforts.is_empty());
            for model in models.iter().skip(1) {
                if provider == "deepseek" || model.id == api {
                    assert_eq!(model.reasoning_efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["off", "low", "high", "max"]);
                    assert_eq!(model.default_reasoning_effort.as_deref(), Some("high"));
                } else {
                    assert!(model.reasoning_efforts.is_empty());
                    assert!(model.default_reasoning_effort.is_none());
                }
            }
        }
        let mut without_effort = metadata;
        without_effort["configOptions"].as_array_mut().unwrap().pop();
        store(begin("deepseek", &path), &without_effort);
        assert!(get("deepseek", &path).unwrap().iter().all(|m| m.reasoning_efforts.is_empty() && m.default_reasoning_effort.is_none()));
        cache().lock().unwrap().0.retain(|key, _| key.path != path);
    }

    #[test]
    fn expired_catalogs_are_purged_when_the_cache_is_touched() {
        let now = Instant::now();
        let metadata =
            json!({"models":{"availableModels":[{"modelId":"model-a","name":"Model A"}]}});
        let mut cache = Cache::default();
        for index in 0..4 {
            cache.store(
                key("antigravity", Path::new(&format!("/fixture/idle-{index}"))),
                acp::parse_models(&metadata),
                now,
            );
        }
        let fresh = key("antigravity", Path::new("/fixture/fresh"));
        cache.store(fresh.clone(), acp::parse_models(&metadata), now + TTL / 2);
        assert_eq!(cache.0.len(), 5);
        // A lookup of any key, even a miss, drops every expired entry.
        assert!(cache
            .get(&key("grok", Path::new("/fixture/miss")), now + TTL)
            .is_none());
        assert_eq!(cache.0.len(), 1);
        assert!(cache.get(&fresh, now + TTL).is_some());
        assert!(cache.get(&fresh, now + TTL + TTL / 2).is_none());
        assert!(cache.0.is_empty());
    }

    #[tokio::test]
    async fn refresh_lock_coalesces_one_executable_without_blocking_another() {
        let path = Path::new("/fixture/coalescing");
        let first = refresh_lock("antigravity", path).await;
        let waiting = tokio::spawn(async move { refresh_lock("antigravity", path).await });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        let other = tokio::time::timeout(
            Duration::from_millis(100),
            refresh_lock("antigravity", Path::new("/fixture/different")),
        )
        .await
        .unwrap();
        drop(other);
        drop(first);
        let _next = tokio::time::timeout(Duration::from_millis(100), waiting)
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn explicit_refresh_invalidates_only_the_requested_provider() {
        let _guard = GLOBAL_CACHE_TEST.lock().unwrap();
        let provider = format!("fixture-{}", uuid::Uuid::new_v4());
        let other = format!("other-{}", uuid::Uuid::new_v4());
        let path = Path::new("/fixture/refresh");
        let metadata =
            json!({"models":{"availableModels":[{"modelId":"model-a","name":"Model A"}]}});
        store(begin(&provider, path), &metadata);
        store(begin(&other, path), &metadata);
        assert!(get(&provider, path).is_some());
        invalidate(&provider);
        assert!(get(&provider, path).is_none());
        assert!(get(&other, path).is_some());
        invalidate(&other);
    }

    #[test]
    fn refresh_cannot_be_repopulated_by_discovery_started_before_it() {
        let now = Instant::now();
        let identity = key("antigravity", Path::new("/fixture/in-flight"));
        let old = json!({"models":{"availableModels":[{"modelId":"old-model"}]}});
        let new = json!({"models":{"availableModels":[{"modelId":"new-model"}]}});
        let mut cache = Cache::default();
        let in_flight = cache.begin(identity.clone());
        cache.invalidate("antigravity");
        cache.commit(in_flight, acp::parse_models(&old), now);
        assert!(cache.get(&identity, now).is_none());
        let refreshed = cache.begin(identity.clone());
        cache.commit(refreshed, acp::parse_models(&new), now);
        assert_eq!(cache.get(&identity, now).unwrap()[1].id, "new-model");
    }
}
