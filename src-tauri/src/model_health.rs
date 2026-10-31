//! Models whose runs failed, paused for a cooldown so Panda Router never offers them, and the same
//! model on another harness to fail over to. Saved in app data so a restart keeps the pauses.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
#[cfg(not(test))]
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::panda_router::{self, PoolModel};

const COOLDOWN_MS: u64 = 10 * 60 * 1000;
const MAX_COOLDOWN_MS: u64 = 2 * 60 * 60 * 1000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unhealthy {
    pub provider: String,
    pub model: String,
    pub reason: String,
    pub until: u64,
    pub failures: u32,
    pub provider_down: bool,
    /// When the latest failure happened (unix ms).
    #[serde(default)]
    pub at: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Registry {
    entries: Vec<Unhealthy>,
    /// Provider -> its latest successful run (unix ms); failures before it never make an outage.
    #[serde(default)]
    last_success: HashMap<String, u64>,
}

const FILE: &str = "model-health.json";
static PATH: OnceLock<PathBuf> = OnceLock::new();

#[cfg(not(test))]
static HEALTH: Mutex<Option<Registry>> = Mutex::new(None);

/// Runs `f` on the registry under one lock; it returns its result and whether to save. Tests get one
/// registry per thread, so tests that fail workers never leak pauses into each other.
fn with<R>(f: impl FnOnce(&mut Registry) -> (R, bool)) -> R {
    #[cfg(not(test))]
    {
        let mut guard = HEALTH.lock().unwrap_or_else(|e| e.into_inner());
        let registry = guard.get_or_insert_with(load);
        let (out, save) = f(registry);
        if save {
            store(registry);
        }
        out
    }
    #[cfg(test)]
    {
        thread_local!(static HEALTH: std::cell::RefCell<Registry> = Default::default());
        HEALTH.with(|r| f(&mut r.borrow_mut()).0)
    }
}

/// Where pauses are saved; before this (and in tests) they live in memory only.
pub fn setup(dir: &Path) {
    let _ = PATH.set(dir.join(FILE));
}

#[cfg_attr(test, allow(dead_code))]
fn load() -> Registry {
    let now = now();
    let mut registry: Registry = PATH
        .get()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    // Expired pauses only matter for backoff; keep a day of them.
    registry.entries.retain(|e| e.until.saturating_add(24 * 60 * 60 * 1000) > now);
    registry
}

#[cfg_attr(test, allow(dead_code))]
fn store(registry: &Registry) {
    let Some(path) = PATH.get() else { return };
    let Ok(bytes) = serde_json::to_vec(registry) else { return };
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, path)) {
        eprintln!("Saving model health: {e}");
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

impl Registry {
    fn failure(&mut self, provider: &str, model: &str, reason: &str, now: u64) {
        let index = self
            .entries
            .iter()
            .position(|e| e.provider == provider && e.model == model);
        let failures = index.map_or(1, |i| self.entries[i].failures.saturating_add(1));
        let cooldown = COOLDOWN_MS
            .saturating_mul(1u64 << failures.saturating_sub(1).min(4))
            .min(MAX_COOLDOWN_MS);
        let entry = Unhealthy {
            provider: provider.into(),
            model: model.into(),
            reason: reason.chars().take(300).collect(),
            until: now.saturating_add(cooldown),
            failures,
            provider_down: false,
            at: now,
        };
        if let Some(i) = index {
            self.entries[i] = entry;
        } else {
            self.entries.push(entry);
        }
    }

    fn provider_down(&self, provider: &str, now: u64) -> bool {
        let since = self.last_success.get(provider).copied().unwrap_or(0);
        self.entries
            .iter()
            .filter(|e| e.provider == provider && e.until > now && e.at >= since)
            .take(2)
            .count()
            >= 2
    }

    fn is_healthy(&self, provider: &str, model: &str, now: u64) -> bool {
        !self.provider_down(provider, now)
            && !self
                .entries
                .iter()
                .any(|e| e.provider == provider && e.model == model && e.until > now)
    }

    fn list(&self, now: u64) -> Vec<Unhealthy> {
        self.entries
            .iter()
            .filter(|e| e.until > now)
            .map(|e| Unhealthy {
                provider_down: self.provider_down(&e.provider, now),
                ..e.clone()
            })
            .collect()
    }

    fn clear(&mut self, provider: Option<&str>, model: Option<&str>) {
        self.entries.retain(|e| {
            !(provider.is_none_or(|p| e.provider == p) && model.is_none_or(|m| e.model == m))
        });
    }

    /// A run on `provider` worked: that model is fine, and the harness is not down.
    fn success(&mut self, provider: &str, model: &str, now: u64) {
        self.clear(Some(provider), Some(model));
        self.last_success.insert(provider.into(), now);
    }

    fn healthy(&self, pool: Vec<PoolModel>, now: u64) -> Vec<PoolModel> {
        pool.into_iter()
            .filter(|m| self.is_healthy(&m.provider, &m.model, now))
            .collect()
    }

    fn alternatives(&self, failed: &PoolModel, pool: &[PoolModel], now: u64) -> Vec<PoolModel> {
        // The same card, or for an unrated model the same model ID.
        let card = panda_router::resolve_card(&failed.provider, &failed.model, &failed.name);
        let same = |m: &PoolModel| match card {
            Some(card) => panda_router::resolve_card(&m.provider, &m.model, &m.name) == Some(card),
            None => failed.model != "default" && m.model == failed.model,
        };
        pool.iter()
            .filter(|m| m.provider != failed.provider && self.is_healthy(&m.provider, &m.model, now) && same(m))
            .cloned()
            .collect()
    }
}

pub fn record_failure(provider: &str, model: &str, reason: &str) {
    with(|r| (r.failure(provider, model, reason, now()), true));
}

pub fn record_success(provider: &str, model: &str) {
    with(|r| {
        // Most runs succeed; skip the write when nothing changes.
        let changed = r.entries.iter().any(|e| e.provider == provider) || !r.last_success.contains_key(provider);
        r.success(provider, model, now());
        ((), changed)
    });
}

pub fn is_healthy(provider: &str, model: &str) -> bool {
    with(|r| (r.is_healthy(provider, model, now()), false))
}

pub fn healthy(pool: Vec<PoolModel>) -> Vec<PoolModel> {
    with(|r| (r.healthy(pool, now()), false))
}

pub fn same_model_alternatives(failed: &PoolModel, pool: &[PoolModel]) -> Vec<PoolModel> {
    with(|r| (r.alternatives(failed, pool, now()), false))
}

#[tauri::command]
pub fn model_health_list() -> Vec<Unhealthy> {
    with(|r| (r.list(now()), false))
}

#[tauri::command]
pub fn model_health_clear(provider: Option<String>, model: Option<String>) -> Vec<Unhealthy> {
    with(|r| {
        r.clear(provider.as_deref(), model.as_deref());
        (r.list(now()), true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(provider: &str, model: &str) -> PoolModel {
        PoolModel {
            provider: provider.into(),
            model: model.into(),
            name: model.into(),
        }
    }

    #[test]
    fn cooldown_doubles_and_caps_even_after_expiry() {
        let mut health = Registry::default();
        let mut now = 100;
        for (i, minutes) in [10, 20, 40, 80, 120, 120, 120].into_iter().enumerate() {
            health.failure("p", "m", "failed", now);
            let entry = &health.list(now)[0];
            assert_eq!(entry.failures, i as u32 + 1);
            assert_eq!(entry.until, now + minutes * 60 * 1000);
            now = entry.until;
        }
    }

    #[test]
    fn expiry_restores_health_at_deadline() {
        let mut health = Registry::default();
        health.failure("p", "m", "failed", 100);
        assert!(!health.is_healthy("p", "m", 100 + COOLDOWN_MS - 1));
        assert!(health.is_healthy("p", "m", 100 + COOLDOWN_MS));
        assert!(health.list(100 + COOLDOWN_MS).is_empty());
    }

    #[test]
    fn success_clears_failure_and_resets_backoff() {
        let provider = "model-health-success-test";
        record_failure(provider, "m", "failed");
        assert!(!is_healthy(provider, "m"));
        record_success(provider, "m");
        assert!(is_healthy(provider, "m"));
        record_failure(provider, "m", "failed again");
        let entry = model_health_list()
            .into_iter()
            .find(|e| e.provider == provider)
            .unwrap();
        assert_eq!(entry.failures, 1);
        record_success(provider, "m");
    }

    #[test]
    fn provider_down_needs_two_distinct_active_models() {
        let mut health = Registry::default();
        health.failure("p", "one", "failed", 0);
        health.failure("p", "one", "failed", 0);
        assert!(health.is_healthy("p", "other", 0));
        health.failure("p", "two", "failed", 100);
        assert!(!health.is_healthy("p", "other", 100));
        assert!(health.list(100).iter().all(|e| e.provider_down));
        assert!(health.is_healthy("q", "other", 100));
        assert!(health.is_healthy("p", "other", 100 + COOLDOWN_MS));
        assert!(!health.is_healthy("p", "one", 100 + COOLDOWN_MS));
        health.failure("p", "two", "failed", 200);
        health.clear(Some("p"), Some("one"));
        assert!(health.is_healthy("p", "other", 200));
        assert!(!health.is_healthy("p", "two", 200));
    }

    #[test]
    fn a_success_ends_a_provider_outage_but_keeps_other_pauses() {
        let mut health = Registry::default();
        health.failure("p", "one", "failed", 10);
        health.failure("p", "two", "failed", 10);
        assert!(!health.is_healthy("p", "three", 20));
        health.success("p", "three", 30);
        assert!(health.is_healthy("p", "three", 40));
        assert!(!health.is_healthy("p", "one", 40) && !health.is_healthy("p", "two", 40));
        assert!(health.list(40).iter().all(|e| !e.provider_down));
        // New failures after the success count again.
        health.failure("p", "one", "failed", 50);
        health.failure("p", "four", "failed", 50);
        assert!(!health.is_healthy("p", "three", 60));
    }

    #[test]
    fn unrated_models_fail_over_by_exact_model_id() {
        let health = Registry::default();
        let failed = model("commandcode", "acme/custom-9");
        let pool = vec![model("opencode", "acme/custom-9"), model("opencode", "acme/custom-8"), model("kilo", "default")];
        assert_eq!(health.alternatives(&failed, &pool, 0), vec![model("opencode", "acme/custom-9")]);
        assert!(health.alternatives(&model("kilo", "default"), &[model("cline", "default")], 0).is_empty());
    }

    #[test]
    fn registry_round_trips_through_json() {
        let mut health = Registry::default();
        health.failure("p", "m", "boom", 5);
        health.success("q", "n", 7);
        let back: Registry = serde_json::from_slice(&serde_json::to_vec(&health).unwrap()).unwrap();
        assert_eq!((back.entries[0].at, back.entries[0].reason.as_str(), back.last_success["q"]), (5, "boom", 7));
    }

    #[test]
    fn alternatives_match_real_cards_across_healthy_providers_in_order() {
        let mut health = Registry::default();
        let failed = model("claude", "claude-sonnet-5-5");
        let alternate = model("commandcode", "claude-sonnet-5-5");
        let pool = vec![
            failed.clone(),
            alternate.clone(),
            model("commandcode", "claude-opus-5-5"),
            alternate.clone(),
        ];
        assert!(
            panda_router::resolve_card(&failed.provider, &failed.model, &failed.name).is_some()
        );
        assert_eq!(
            health.alternatives(&failed, &pool, 0),
            vec![alternate.clone(), alternate]
        );
        health.failure("commandcode", "claude-sonnet-5-5", "failed", 0);
        assert!(health.alternatives(&failed, &pool, 0).is_empty());
        assert!(health
            .alternatives(&model("unknown", "not-a-model"), &pool, 0)
            .is_empty());
    }

    #[test]
    fn healthy_filters_paused_models_and_provider_outages_without_reordering() {
        let mut health = Registry::default();
        health.failure("down", "one", "failed", 0);
        health.failure("down", "two", "failed", 0);
        health.failure("partial", "one", "failed", 0);
        let first = model("partial", "two");
        let last = model("up", "one");
        let pool = vec![
            model("down", "other"),
            first.clone(),
            model("partial", "one"),
            last.clone(),
        ];
        assert_eq!(health.healthy(pool, 0), vec![first, last]);
        let provider = "model-health-filter-test";
        record_failure(provider, "bad", "failed");
        let good = model(provider, "good");
        assert_eq!(
            healthy(vec![model(provider, "bad"), good.clone()]),
            vec![good]
        );
        record_success(provider, "bad");
    }

    #[test]
    fn clear_scopes_and_serialized_reason_are_bounded() {
        let mut health = Registry::default();
        health.failure("p", "one", &"🦀".repeat(400), 0);
        health.failure("p", "two", "failed", 0);
        health.failure("q", "one", "failed", 0);
        let entry = &health.list(0)[0];
        assert_eq!(entry.reason.chars().count(), 300);
        let json = serde_json::to_value(entry).unwrap();
        assert_eq!(json["providerDown"], true);
        assert_eq!(json["until"], COOLDOWN_MS);
        health.clear(Some("p"), Some("one"));
        assert_eq!(health.list(0).len(), 2);
        assert!(!health.list(0)[0].provider_down);
        health.clear(Some("p"), None);
        assert_eq!(health.list(0)[0].provider, "q");
        health.clear(None, None);
        assert!(health.list(0).is_empty());
    }
}
