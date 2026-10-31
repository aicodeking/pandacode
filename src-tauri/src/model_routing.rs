//! Model routing (Settings → Agents → Model routing, and `profileId: "auto"` in teams): settings,
//! the profiler download and one process-wide Panda Router. The only network request is the
//! profiler download from `panda_router::ASSET_BASE_URL`, sha256-verified, started on an explicit
//! Settings click or when a route runs with routing enabled. Team routes never wait for it: they use
//! the keyword heuristic until the profiler is ready.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::panda_router::{self, Mode, PoolModel, Preferences, Route, Router, TaskContext, Tier, Tiers};

const SETTINGS_FILE: &str = "model-routing.json";
/// Profiler files of earlier releases, removed once the current ones load.
const OLD_ASSET_DIRS: &[&str] = &["panda-router/v2"];
/// Settings files without `version` predate v4, whose default bar is 0.5 rather than 0.8.
const SETTINGS_VERSION: u32 = 2;
const MAX_TEXT: usize = 64 * 1024;
pub(crate) const MAX_POOL: usize = 1000;
/// Settings' Try it waits this long for the download; team routes never wait.
const DOWNLOAD_WAIT: Duration = Duration::from_secs(20);
/// After a failed download, routes start another only after this long (Settings' Retry any time).
const RETRY_AFTER: Duration = Duration::from_secs(600);
const STALE_PART: Duration = Duration::from_secs(24 * 60 * 60);
const LANGUAGES_TTL: Duration = Duration::from_secs(600);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_ASSET_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled: bool,
    pub mode: Mode,
    pub min_p: f64,
    /// Missing (0) in files saved before v4.
    #[serde(default)]
    pub version: u32,
}

impl Default for Settings {
    fn default() -> Self {
        // Upstream v4's defaults: max_utility, and cheapest-mode's bar on the P lower bound at 0.5. A
        // failed worker escalates up the ladder, so the bar no longer has to carry the retry cost.
        Self { enabled: true, mode: Mode::Balanced, min_p: 0.5, version: SETTINGS_VERSION }
    }
}

impl Settings {
    fn clamped(self) -> Self {
        // v2's untouched default was 0.8 on calibrated P; v4 compares the lower bound, so 0.8 would
        // leave cheapest mode almost always relaxed. A deliberate other value is kept.
        let old_default = self.version < SETTINGS_VERSION && self.min_p == 0.8;
        let min_p = if self.min_p.is_finite() && !old_default { self.min_p.clamp(0.3, 0.9) } else { 0.5 };
        Self { min_p, version: SETTINGS_VERSION, ..self }
    }
    pub fn preferences(&self, mode: Option<Mode>) -> Preferences {
        Preferences { mode: mode.unwrap_or(self.mode), min_p: self.min_p }
    }
}

pub(crate) fn read_settings(path: &Path) -> Settings {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
        .unwrap_or_default()
        .clamped()
}

pub(crate) fn write_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&temp, json).map_err(|e| format!("Could not save model routing settings: {e}"))?;
    std::fs::rename(&temp, path).map_err(|e| format!("Could not save model routing settings: {e}"))
}

const EXCLUSIONS_FILE: &str = "routing-exclusions.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedModel {
    pub provider: String,
    pub model: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Exclusions {
    pub providers: Vec<String>,
    pub models: Vec<ExcludedModel>,
}

impl Exclusions {
    fn validated(mut self) -> Result<Self, String> {
        if self.providers.len() > 64 || self.models.len() > MAX_POOL {
            return Err("Exclude at most 64 providers and 1000 models.".into());
        }
        for provider in self.providers.iter().chain(self.models.iter().map(|m| &m.provider)) {
            if !crate::architect::HARNESSES.contains(&provider.as_str()) {
                return Err(format!("Unknown harness {provider:?}."));
            }
        }
        if self.models.iter().any(|m| m.model.is_empty() || m.model.len() > 200 || m.model.contains('\0')) {
            return Err("Model IDs must be 1–200 bytes with no NUL.".into());
        }
        let mut providers = std::collections::HashSet::new();
        self.providers.retain(|p| providers.insert(p.clone()));
        let mut models = std::collections::HashSet::new();
        self.models.retain(|m| models.insert((m.provider.clone(), m.model.clone())));
        Ok(self)
    }

    fn allowed(&self, provider: &str, model: &str) -> bool {
        !self.providers.iter().any(|p| p == provider)
            && !self.models.iter().any(|m| m.provider == provider && m.model == model)
    }
}

fn read_exclusions(path: &Path) -> Exclusions {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Exclusions>(&bytes).ok())
        // Drop entries this version no longer accepts (a removed harness) rather than the whole file.
        .map(|mut e| {
            e.providers.retain(|p| crate::architect::HARNESSES.contains(&p.as_str()));
            e.models.retain(|m| crate::architect::HARNESSES.contains(&m.provider.as_str()) && !m.model.is_empty() && m.model.len() <= 200 && !m.model.contains('\0'));
            e.providers.truncate(64);
            e.models.truncate(MAX_POOL);
            e
        })
        .and_then(|e| e.validated().ok())
        .unwrap_or_default()
}

fn write_exclusions(path: &Path, exclusions: &Exclusions) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(exclusions).map_err(|e| e.to_string())?;
    std::fs::write(&temp, json).map_err(|e| format!("Could not save routing exclusions: {e}"))?;
    std::fs::rename(&temp, path).map_err(|e| format!("Could not save routing exclusions: {e}"))
}

const TIERS_FILE: &str = "routing-tiers.json";
const MAX_TIER_KEY: usize = 300;

fn tier_key_ok(key: &str) -> bool {
    !key.is_empty() && key.len() <= MAX_TIER_KEY && !key.contains('\0')
}

fn validate_tiers(tiers: Tiers) -> Result<Tiers, String> {
    if tiers.len() > MAX_POOL {
        return Err(format!("Rank at most {MAX_POOL} models."));
    }
    if !tiers.keys().all(|k| tier_key_ok(k)) {
        return Err(format!("Tier keys must be 1–{MAX_TIER_KEY} bytes with no NUL."));
    }
    Ok(tiers)
}

/// Invalid entries (bad key or tier) are dropped one by one, never the whole file.
fn read_tiers(path: &Path) -> Tiers {
    let Some(raw) = std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&b).ok()) else {
        return Tiers::new();
    };
    raw.into_iter()
        .filter(|(k, _)| tier_key_ok(k))
        .filter_map(|(k, v)| serde_json::from_value::<Tier>(v).ok().map(|t| (k, t)))
        .take(MAX_POOL)
        .collect()
}

fn write_tiers(path: &Path, tiers: &Tiers) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    let sorted: std::collections::BTreeMap<_, _> = tiers.iter().collect();
    let json = serde_json::to_vec_pretty(&sorted).map_err(|e| e.to_string())?;
    std::fs::write(&temp, json).map_err(|e| format!("Could not save model tiers: {e}"))?;
    std::fs::rename(&temp, path).map_err(|e| format!("Could not save model tiers: {e}"))
}

#[cfg(test)]
thread_local!(static TEST_TIERS: std::cell::RefCell<Option<Tiers>> = const { std::cell::RefCell::new(None) });

#[cfg(test)]
pub(crate) fn with_tiers<T>(tiers: Tiers, f: impl FnOnce() -> T) -> T {
    struct Reset(Option<Tiers>);
    impl Drop for Reset {
        fn drop(&mut self) {
            TEST_TIERS.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let _reset = Reset(TEST_TIERS.with(|slot| slot.replace(Some(tiers))));
    f()
}

/// The user's tier list (empty before setup).
pub fn tiers() -> Tiers {
    #[cfg(test)]
    if let Some(tiers) = TEST_TIERS.with(|slot| slot.borrow().clone()) {
        return tiers;
    }
    RUNTIME.get().and_then(|rt| rt.tiers.lock().ok().map(|t| t.clone())).unwrap_or_default()
}

#[tauri::command]
pub fn model_routing_tiers() -> Result<Tiers, String> {
    runtime()?.tiers.lock().map(|t| t.clone()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn model_routing_set_tiers(tiers: Tiers) -> Result<Tiers, String> {
    let next = validate_tiers(tiers)?;
    let rt = runtime()?;
    let mut current = rt.tiers.lock().map_err(|e| e.to_string())?;
    write_tiers(&rt.root.join(TIERS_FILE), &next)?;
    *current = next.clone();
    Ok(next)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TierModel {
    pub key: String,
    pub name: String,
    pub card_id: Option<String>,
    pub providers: Vec<String>,
    pub rated: bool,
}

/// A pool entry's display name without its trailing ` · <harness name>`.
fn display_name(e: &PoolEntry) -> &str {
    let harness = crate::providers::PROVIDERS.iter().find(|(id, _)| *id == e.provider).map(|(_, name)| *name);
    harness.and_then(|h| e.name.strip_suffix(h)).and_then(|n| n.strip_suffix(" · ")).unwrap_or(&e.name).trim()
}

/// The rankable models of a pool, one per tier key, in pool order, named after their first entry. A
/// `default` entry that names no card is left out: there is nothing stable to rank.
pub fn tier_models(pool: &[PoolEntry]) -> Vec<TierModel> {
    let mut out: Vec<TierModel> = Vec::new();
    for e in pool {
        let (key, card) = panda_router::tier_key(&e.provider, &e.model, &e.name);
        if card.is_none() && e.model == "default" {
            continue;
        }
        if let Some(existing) = out.iter_mut().find(|m| m.key == key) {
            if !existing.providers.contains(&e.provider) {
                existing.providers.push(e.provider.clone());
            }
            continue;
        }
        let name = match display_name(e) {
            "" => card.unwrap_or(&e.model).to_string(),
            name => name.to_string(),
        };
        out.push(TierModel { key, name, card_id: card.map(String::from), providers: vec![e.provider.clone()], rated: card.is_some() });
    }
    out
}

/// Moves ranks saved under `<provider>/<model>` (while a model had no card) onto its card's key, so the
/// ranker shows the rank the router applies. A card-key rank wins; the legacy one is dropped. None if
/// nothing moved.
fn canonical_tiers(pool: &[PoolEntry], tiers: &Tiers) -> Option<Tiers> {
    let mut next = tiers.clone();
    for e in pool {
        let legacy = format!("{}/{}", e.provider, e.model);
        let (key, card) = panda_router::tier_key(&e.provider, &e.model, &e.name);
        if card.is_none() || key == legacy {
            continue;
        }
        if let Some(tier) = next.remove(&legacy) {
            next.entry(key).or_insert(tier);
        }
    }
    (next != *tiers).then_some(next)
}

#[tauri::command]
pub fn model_routing_tier_models(pool: Vec<PoolEntry>) -> Result<Vec<TierModel>, String> {
    validate_pool(&pool)?;
    let rt = runtime()?;
    let mut current = rt.tiers.lock().map_err(|e| e.to_string())?;
    if let Some(next) = canonical_tiers(&pool, &current) {
        write_tiers(&rt.root.join(TIERS_FILE), &next)?;
        *current = next;
    }
    Ok(tier_models(&pool))
}

#[cfg(test)]
thread_local!(static TEST_EXCLUSIONS: std::cell::RefCell<Option<Exclusions>> = const { std::cell::RefCell::new(None) });

#[cfg(test)]
pub(crate) fn with_exclusions<T>(exclusions: Exclusions, f: impl FnOnce() -> T) -> T {
    struct Reset(Option<Exclusions>);
    impl Drop for Reset {
        fn drop(&mut self) {
            TEST_EXCLUSIONS.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let _reset = Reset(TEST_EXCLUSIONS.with(|slot| slot.replace(Some(exclusions))));
    f()
}

pub fn allowed(provider: &str, model: &str) -> bool {
    #[cfg(test)]
    if let Some(allowed) = TEST_EXCLUSIONS.with(|slot| slot.borrow().as_ref().map(|e| e.allowed(provider, model))) {
        return allowed;
    }
    RUNTIME.get().is_none_or(|rt| rt.exclusions.lock().unwrap_or_else(|e| e.into_inner()).allowed(provider, model))
}

fn available(pool: Vec<PoolModel>) -> Vec<PoolModel> {
    crate::model_health::healthy(pool.into_iter().filter(|m| allowed(&m.provider, &m.model)).collect())
}

#[tauri::command]
pub fn model_routing_exclusions() -> Result<Exclusions, String> {
    runtime()?.exclusions.lock().map(|e| e.clone()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn model_routing_set_exclusions(providers: Vec<String>, models: Vec<ExcludedModel>) -> Result<Exclusions, String> {
    let next = Exclusions { providers, models }.validated()?;
    let rt = runtime()?;
    let mut exclusions = rt.exclusions.lock().map_err(|e| e.to_string())?;
    write_exclusions(&rt.root.join(EXCLUSIONS_FILE), &next)?;
    *exclusions = next.clone();
    Ok(next)
}

#[cfg(target_os = "macos")]
const MIN_MACOS: (u32, u32) = (13, 4);

struct Runtime {
    root: PathBuf,
    settings: Mutex<Settings>,
    exclusions: Mutex<Exclusions>,
    tiers: Mutex<Tiers>,
    error: Mutex<Option<String>>,
    downloading: AtomicBool,
    /// Finished download attempts; a caller that waited on another's attempt shares its result.
    attempts: AtomicU64,
    download: tokio::sync::Mutex<()>,
    failed_at: Mutex<Option<Instant>>,
    /// The loaded ONNX router and when it last routed; dropped after `IDLE_UNLOAD`, reloaded on use.
    onnx: tokio::sync::Mutex<Option<Loaded>>,
    /// Verified files that ONNX Runtime still could not load: keyword heuristic for the rest of
    /// this process, with no re-downloads.
    unusable: OnceLock<String>,
}

struct Loaded {
    router: Arc<Router>,
    used: Instant,
}

/// The profiler (session + tokenizer, tens of MB) is freed after this long without a route.
const IDLE_UNLOAD: Duration = Duration::from_secs(10 * 60);

/// Drops an idle router; otherwise returns how long until it could be idle.
fn unload_if_idle(slot: &mut Option<Loaded>, now: Instant) -> Option<Duration> {
    let idle = now.saturating_duration_since(slot.as_ref()?.used);
    if idle >= IDLE_UNLOAD {
        *slot = None;
        return None;
    }
    Some(IDLE_UNLOAD - idle)
}

fn touch(slot: &mut Option<Loaded>) -> Option<Arc<Router>> {
    let loaded = slot.as_mut()?;
    loaded.used = Instant::now();
    Some(loaded.router.clone())
}

/// One sleeping task per load: wakes when the router could be idle and drops it if it is.
fn watch_idle(rt: &'static Runtime) {
    tauri::async_runtime::spawn(async move {
        let mut wait = IDLE_UNLOAD;
        loop {
            tokio::time::sleep(wait).await;
            match unload_if_idle(&mut *rt.onnx.lock().await, Instant::now()) {
                Some(left) => wait = left,
                None => break,
            }
        }
    });
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();
static HEURISTIC: LazyLock<Arc<Router>> = LazyLock::new(|| Arc::new(Router::heuristic()));

pub fn setup(app_data: &Path) {
    let settings = read_settings(&app_data.join(SETTINGS_FILE));
    let _ = RUNTIME.set(Runtime {
        root: app_data.to_path_buf(),
        settings: Mutex::new(settings),
        exclusions: Mutex::new(read_exclusions(&app_data.join(EXCLUSIONS_FILE))),
        tiers: Mutex::new(read_tiers(&app_data.join(TIERS_FILE))),
        error: Mutex::new(None),
        downloading: AtomicBool::new(false),
        attempts: AtomicU64::new(0),
        download: tokio::sync::Mutex::new(()),
        failed_at: Mutex::new(None),
        onnx: tokio::sync::Mutex::new(None),
        unusable: OnceLock::new(),
    });
}

fn runtime() -> Result<&'static Runtime, String> {
    RUNTIME.get().ok_or_else(|| "Model routing is unavailable.".to_string())
}

impl Runtime {
    fn settings(&self) -> Settings {
        self.settings.lock().map(|s| *s).unwrap_or_default()
    }
    fn assets(&self) -> PathBuf {
        self.root.join(panda_router::ASSET_DIR)
    }
    fn error(&self) -> Option<String> {
        if let Some(reason) = self.unusable.get() {
            return Some(reason.clone());
        }
        self.error.lock().ok().and_then(|e| e.clone())
    }
    fn set_error(&self, error: Option<String>) {
        if let Ok(mut slot) = self.error.lock() {
            *slot = error;
        }
    }
    fn status(&self) -> RoutingStatus {
        let s = self.settings();
        if let Some(reason) = unsupported_os() {
            let _ = self.unusable.set(reason);
        }
        let error = self.error();
        let profiler = if self.unusable.get().is_some() {
            "unavailable"
        } else if self.downloading.load(Ordering::SeqCst) {
            "downloading"
        } else if error.is_some() {
            "failed"
        } else if assets_present(&self.assets()) {
            "ready"
        } else {
            "missing"
        };
        RoutingStatus { enabled: s.enabled, mode: s.mode, min_p: s.min_p, profiler, error }
    }
}

/// Settings → model routing switch; false before setup (tests), so nothing changes there.
pub fn enabled() -> bool {
    RUNTIME.get().is_some_and(|rt| rt.settings().enabled)
}

/// The saved routing mode (the Team menu's Cheap/Balanced/Best); the default before setup.
pub fn mode() -> Mode {
    RUNTIME.get().map_or_else(|| Settings::default().mode, |rt| rt.settings().mode)
}

/// The saved minimum P(success) lower bound for Cheap; the default before setup.
pub fn min_p() -> f64 {
    RUNTIME.get().map_or_else(|| Settings::default().min_p, |rt| rt.settings().min_p)
}

pub fn assets_present(dir: &Path) -> bool {
    panda_router::ASSETS.iter().all(|(file, _)| dir.join(file).is_file())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingStatus {
    pub enabled: bool,
    pub mode: Mode,
    pub min_p: f64,
    pub profiler: &'static str,
    pub error: Option<String>,
}

/// Downloads every missing asset into `dir`: streamed to a temp file, sha256-checked, then renamed.
pub async fn download_assets(dir: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(dir).await.map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    remove_stale_parts(dir);
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::limited(3))
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .user_agent(concat!("PandaCode/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let all = async {
        for (file, sha) in panda_router::ASSETS {
            let dest = dir.join(file);
            if !dest.is_file() {
                download_one(&client, &format!("{}{file}", panda_router::ASSET_BASE_URL), &dest, sha).await?;
            }
        }
        Ok(())
    };
    tokio::time::timeout(DOWNLOAD_TIMEOUT, all).await.map_err(|_| "The profiler download timed out.".to_string())?
}

/// Temp files another instance left behind (crash, quit mid-download) after a day.
fn remove_stale_parts(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| SystemTime::now().duration_since(t).is_ok_and(|age| age > STALE_PART));
        if old && path.extension().is_some_and(|e| e == "part") {
            let _ = std::fs::remove_file(path);
        }
    }
}

async fn download_one(client: &reqwest::Client, url: &str, dest: &Path, sha: &str) -> Result<(), String> {
    let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("profiler file");
    let fail = |e: String| format!("Downloading {name} failed: {e}");
    let mut response = client.get(url).send().await.map_err(|e| fail(e.to_string()))?;
    if !response.status().is_success() {
        return Err(fail(format!("HTTP {}", response.status().as_u16())));
    }
    if response.content_length().is_some_and(|n| n > MAX_ASSET_BYTES) {
        return Err(fail("file is too large".into()));
    }
    // Unique per process and attempt, so two app instances never write the same file.
    let temp = dest.with_file_name(format!("{name}.{}-{}.part", std::process::id(), crate::storage::id()));
    let result = async {
        let mut out = tokio::fs::File::create(&temp).await.map_err(|e| e.to_string())?;
        let (mut hasher, mut size) = (Sha256::new(), 0u64);
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            size += chunk.len() as u64;
            if size > MAX_ASSET_BYTES {
                return Err("file is too large".to_string());
            }
            hasher.update(&chunk);
            out.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
        out.sync_all().await.map_err(|e| e.to_string())?;
        if format!("{:x}", hasher.finalize()) != sha {
            return Err("checksum mismatch".to_string());
        }
        tokio::fs::rename(&temp, dest).await.map_err(|e| e.to_string())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result.map_err(fail)
}

/// Single flight: concurrent callers share one download and its outcome.
async fn prepare(rt: &'static Runtime) -> Result<(), String> {
    let seen = rt.attempts.load(Ordering::SeqCst);
    let _guard = rt.download.lock().await;
    let dir = rt.assets();
    if assets_present(&dir) {
        return Ok(());
    }
    if rt.attempts.load(Ordering::SeqCst) != seen {
        return Err(rt.error().unwrap_or_else(|| "The profiler download failed.".into()));
    }
    rt.set_error(None);
    rt.downloading.store(true, Ordering::SeqCst);
    let result = download_assets(&dir).await;
    rt.downloading.store(false, Ordering::SeqCst);
    rt.attempts.fetch_add(1, Ordering::SeqCst);
    rt.set_error(result.as_ref().err().cloned());
    if let Ok(mut failed_at) = rt.failed_at.lock() {
        *failed_at = result.is_err().then(Instant::now);
    }
    result
}

/// Starts (or joins) the download in the background while routing is on, unless one failed recently.
fn background_download(rt: &'static Runtime) -> Option<tauri::async_runtime::JoinHandle<Result<(), String>>> {
    let recent_failure = rt.failed_at.lock().ok().and_then(|t| *t).is_some_and(|t| t.elapsed() < RETRY_AFTER);
    (rt.settings().enabled && !recent_failure && rt.unusable.get().is_none() && unsupported_os().is_none()).then(|| tauri::async_runtime::spawn(prepare(rt)))
}

/// The bundled ONNX Runtime is built for macOS 13.4; older systems keep the keyword heuristic and
/// never download or load the profiler.
fn unsupported_os() -> Option<String> {
    if !panda_router::ONNX_AVAILABLE {
        return Some("This build of PandaCode has no ONNX profiler (Intel Mac and x86_64 Linux); routing uses the keyword heuristic.".into());
    }
    #[cfg(target_os = "macos")]
    {
        static SUPPORTED: OnceLock<bool> = OnceLock::new();
        let supported = *SUPPORTED.get_or_init(|| {
            std::process::Command::new("/usr/bin/sw_vers")
                .arg("-productVersion")
                .output()
                .is_ok_and(|out| macos_supported(String::from_utf8_lossy(&out.stdout).trim()))
        });
        if !supported {
            return Some(format!("The profiler needs macOS {}.{} or later; routing uses the keyword heuristic.", MIN_MACOS.0, MIN_MACOS.1));
        }
    }
    None
}

/// Whether a `sw_vers -productVersion` string is at least `MIN_MACOS`. Unparseable fails closed:
/// the heuristic still routes, it just never loads ONNX Runtime.
#[cfg(target_os = "macos")]
fn macos_supported(version: &str) -> bool {
    let mut parts = version.split('.').map(|p| p.parse::<u32>().ok());
    match (parts.next().flatten(), parts.next().unwrap_or(Some(0))) {
        (Some(major), Some(minor)) => (major, minor) >= MIN_MACOS,
        _ => false,
    }
}

/// The ONNX router when its files are here (loaded once), else the heuristic. A missing profiler
/// downloads in the background; only `wait` (Settings' Try it) waits for it, up to `DOWNLOAD_WAIT`.
async fn router(rt: &'static Runtime, wait: bool) -> Arc<Router> {
    if let Some(router) = touch(&mut *rt.onnx.lock().await) {
        return router;
    }
    if rt.unusable.get().is_some() {
        return HEURISTIC.clone();
    }
    if let Some(reason) = unsupported_os() {
        let _ = rt.unusable.set(reason);
        return HEURISTIC.clone();
    }
    let dir = rt.assets();
    if !assets_present(&dir) {
        let download = background_download(rt);
        if let (true, Some(download)) = (wait, download) {
            let _ = tokio::time::timeout(DOWNLOAD_WAIT, download).await;
        }
        if !assets_present(&dir) {
            return HEURISTIC.clone();
        }
    }
    // Single flight: a concurrent caller that loaded it meanwhile wins.
    let mut slot = rt.onnx.lock().await;
    if let Some(router) = touch(&mut slot) {
        return router;
    }
    let load_dir = dir.clone();
    let loaded = match tokio::task::spawn_blocking(move || Router::load(&load_dir)).await {
        Ok(result) => result,
        Err(e) => Err(e.to_string()),
    };
    match loaded {
        Ok(router) => {
            for old in OLD_ASSET_DIRS {
                let _ = std::fs::remove_dir_all(rt.root.join(old));
            }
            let router = Arc::new(router);
            *slot = Some(Loaded { router: router.clone(), used: Instant::now() });
            watch_idle(rt);
            router
        }
        // `read_verified` reports bad or unreadable files this way; anything else is ONNX Runtime.
        Err(error) if error.contains("sha256") || error.contains("cannot read") => {
            // Corrupt or stale files: remove them so Retry downloads fresh copies, but not on
            // every dispatch.
            for (file, _) in panda_router::ASSETS {
                let _ = std::fs::remove_file(dir.join(file));
            }
            rt.set_error(Some(format!("The profiler could not load: {error}")));
            if let Ok(mut failed_at) = rt.failed_at.lock() {
                *failed_at = Some(Instant::now());
            }
            HEURISTIC.clone()
        }
        Err(error) => {
            let _ = rt.unusable.set(format!("The profiler could not start: {error}"));
            HEURISTIC.clone()
        }
    }
}

/// One task to route. `failed` models are excluded and raise the estimated difficulty.
pub struct Job {
    pub text: String,
    pub ctx: TaskContext,
    pub failed: Vec<PoolModel>,
}

/// Routes every job over `pool`, one at a time: padded ONNX batches drift slightly from single
/// routes (int8 activation scaling), and a single route takes milliseconds. Uses the user's tier list.
pub fn route_with(router: &Router, prefs: &Preferences, pool: &[PoolModel], jobs: Vec<Job>) -> Result<Vec<Route>, String> {
    let tiers = tiers();
    jobs.iter().map(|j| router.route(&j.text, &j.ctx, pool, prefs, &j.failed, &tiers)).collect()
}

/// Routes for teams. None while routing is off.
pub async fn route_jobs(pool: Vec<PoolModel>, jobs: Vec<Job>, mode: Option<Mode>) -> Option<Result<Vec<Route>, String>> {
    let rt = RUNTIME.get()?;
    let settings = rt.settings();
    if !settings.enabled {
        return None;
    }
    Some(run(rt, settings.preferences(mode), available(pool), jobs, false).await)
}

async fn run(rt: &'static Runtime, prefs: Preferences, pool: Vec<PoolModel>, jobs: Vec<Job>, wait: bool) -> Result<Vec<Route>, String> {
    let router = router(rt, wait).await;
    tokio::task::spawn_blocking(move || route_with(&router, &prefs, &pool, jobs)).await.map_err(|e| e.to_string())?
}

/// A routing pool from (provider, model, name) entries: a `default` entry is dropped when the same
/// harness lists a concrete model with the same card, so the pick names a real model.
pub fn pool_from<'a>(entries: impl IntoIterator<Item = (&'a str, &'a str, &'a str)>) -> Vec<PoolModel> {
    let resolved: Vec<_> =
        entries.into_iter().map(|(p, m, n)| ((p, m, n), panda_router::resolve_card(p, m, n))).collect();
    resolved
        .iter()
        .filter(|&&((provider, model, _), card)| {
            model != "default"
                || card.is_none_or(|own| {
                    !resolved.iter().any(|&((p, m, _), c)| p == provider && m != "default" && c == Some(own))
                })
        })
        .map(|&((provider, model, name), _)| PoolModel { provider: provider.into(), model: model.into(), name: name.into() })
        .collect()
}

/// Distinct cards a pool resolves to, plus ranked models without one: the models routing can rate.
pub fn rated_count(pool: &[PoolModel]) -> usize {
    let tiers = tiers();
    let mut cards: Vec<_> = pool
        .iter()
        .filter_map(|m| match panda_router::tier_key(&m.provider, &m.model, &m.name) {
            (key, None) if !tiers.contains_key(&key) => None,
            (key, _) => Some(key),
        })
        .collect();
    cards.sort_unstable();
    cards.dedup();
    cards.len()
}

/// Up to 3 languages by tracked file count (`git ls-files`), cached per checkout for a while.
pub fn repo_languages(root: &Path) -> Vec<String> {
    type Cache = HashMap<PathBuf, (Instant, Vec<String>)>;
    static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Default::default);
    if let Some((at, langs)) = CACHE.lock().ok().and_then(|c| c.get(root).cloned()) {
        if at.elapsed() < LANGUAGES_TTL {
            return langs;
        }
    }
    let output = crate::workspace::run_git_bounded(root, &["ls-files", "-z"], 8 * 1024 * 1024, false, Duration::from_secs(5));
    let langs = match output {
        Ok(out) if out.status.success() => top_languages(out.stdout.bytes.split(|b| *b == 0).filter_map(|p| std::str::from_utf8(p).ok())),
        _ => Vec::new(),
    };
    if let Ok(mut cache) = CACHE.lock() {
        cache.insert(root.to_path_buf(), (Instant::now(), langs.clone()));
    }
    langs
}

fn top_languages<'a>(paths: impl Iterator<Item = &'a str>) -> Vec<String> {
    const LANGUAGES: &[(&str, &str)] = &[
        ("rs", "rust"), ("ts", "typescript"), ("tsx", "typescript"), ("mts", "typescript"), ("js", "javascript"),
        ("jsx", "javascript"), ("mjs", "javascript"), ("cjs", "javascript"), ("py", "python"), ("go", "go"),
        ("java", "java"), ("kt", "kotlin"), ("swift", "swift"), ("rb", "ruby"), ("c", "c"), ("h", "c"),
        ("cc", "cpp"), ("cpp", "cpp"), ("hpp", "cpp"), ("cs", "csharp"), ("php", "php"), ("scala", "scala"),
        ("dart", "dart"), ("ex", "elixir"), ("exs", "elixir"), ("lua", "lua"), ("zig", "zig"), ("sh", "shell"),
        ("sql", "sql"), ("vue", "vue"), ("svelte", "svelte"), ("hs", "haskell"), ("ml", "ocaml"), ("r", "r"),
    ];
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for path in paths {
        let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
        if let Some(lang) = ext.and_then(|e| LANGUAGES.iter().find(|(x, _)| *x == e).map(|(_, l)| *l)) {
            *counts.entry(lang).or_default() += 1;
        }
    }
    let mut ranked: Vec<_> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    ranked.into_iter().take(3).map(|(l, _)| l.to_string()).collect()
}

pub const OFF: &str = "Model routing is off (Settings → Agents → Model routing).";

#[tauri::command]
pub fn model_routing_status() -> Result<RoutingStatus, String> {
    Ok(runtime()?.status())
}

#[tauri::command]
pub fn model_routing_configure(enabled: Option<bool>, mode: Option<Mode>, min_p: Option<f64>) -> Result<RoutingStatus, String> {
    let rt = runtime()?;
    if min_p.is_some_and(|p| !p.is_finite()) {
        return Err("Minimum chance of success must be a number.".into());
    }
    {
        let mut settings = rt.settings.lock().map_err(|e| e.to_string())?;
        let next = Settings {
            enabled: enabled.unwrap_or(settings.enabled),
            mode: mode.unwrap_or(settings.mode),
            min_p: min_p.unwrap_or(settings.min_p),
            version: SETTINGS_VERSION,
        }
        .clamped();
        write_settings(&rt.root.join(SETTINGS_FILE), &next)?;
        *settings = next;
    }
    Ok(rt.status())
}

#[tauri::command]
pub async fn model_routing_prepare() -> Result<RoutingStatus, String> {
    let rt = runtime()?;
    if let Some(reason) = unsupported_os() {
        let _ = rt.unusable.set(reason);
    }
    if rt.unusable.get().is_none() {
        let _ = prepare(rt).await;
    }
    Ok(rt.status())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolEntry {
    pub provider: String,
    pub model: String,
    pub name: String,
}

pub(crate) fn validate_pool(pool: &[PoolEntry]) -> Result<(), String> {
    if pool.len() > MAX_POOL {
        return Err(format!("Route over at most {MAX_POOL} models."));
    }
    for entry in pool {
        if !crate::architect::HARNESSES.contains(&entry.provider.as_str()) {
            return Err(format!("Unknown harness {:?}.", entry.provider));
        }
        if entry.model.is_empty() || entry.model.len() > 200 || entry.name.len() > 200 || format!("{}{}", entry.model, entry.name).contains('\0') {
            return Err("Model IDs and names must be 1–200 bytes.".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn model_routing_route(text: String, pool: Vec<PoolEntry>) -> Result<Route, String> {
    let rt = runtime()?;
    if !rt.settings().enabled {
        return Err(OFF.into());
    }
    if text.trim().is_empty() || text.len() > MAX_TEXT || text.contains('\0') {
        return Err(format!("Describe the task in 1–{} KB.", MAX_TEXT / 1024));
    }
    validate_pool(&pool)?;
    let pool = available(pool_from(pool.iter().map(|e| (e.provider.as_str(), e.model.as_str(), e.name.as_str()))));
    // Same context as a team dispatch, so Try it shows the pick a worker would get.
    let job = Job { text, ctx: TaskContext { requires_tools: true, ..TaskContext::default() }, failed: vec![] };
    let prefs = rt.settings().preferences(None);
    run(rt, prefs, pool, vec![job], true).await?.pop().ok_or_else(|| "Routing returned nothing.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_floor_is_13_4_and_fails_closed() {
        for v in ["13.4", "13.4.1", "14", "14.0", "26.1", "27.0"] {
            assert!(super::macos_supported(v), "{v}");
        }
        for v in ["12.7.6", "13.3", "13.3.1", "11", "", "abc", "13.x"] {
            assert!(!super::macos_supported(v), "{v}");
        }
    }

    #[test]
    fn settings_round_trip_and_clamp() {
        let dir = std::env::temp_dir().join(format!("pandacode-routing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SETTINGS_FILE);
        assert_eq!(read_settings(&path), Settings::default());
        assert_eq!(Settings::default(), Settings { enabled: true, mode: Mode::Balanced, min_p: 0.5, version: SETTINGS_VERSION });
        let saved = Settings { enabled: false, mode: Mode::Cheapest, min_p: 0.7, version: SETTINGS_VERSION };
        write_settings(&path, &saved).unwrap();
        assert_eq!(read_settings(&path), saved);
        // Saved choices survive, a chosen 0.8 included; only v2's untouched 0.8 moves to v4's 0.5.
        write_settings(&path, &Settings { min_p: 0.8, ..saved }).unwrap();
        assert_eq!(read_settings(&path).min_p, 0.8);
        let v2 = |json: &str| { std::fs::write(&path, json).unwrap(); read_settings(&path) };
        assert_eq!(v2(r#"{"enabled":true,"mode":"cheapest","minP":0.8}"#), Settings { mode: Mode::Cheapest, ..Settings::default() });
        assert_eq!(v2(r#"{"enabled":true,"mode":"cheapest","minP":0.7}"#).min_p, 0.7);
        assert_eq!(v2(r#"{"enabled":true,"mode":"quality","minP":2}"#), Settings { mode: Mode::Quality, min_p: 0.9, ..Settings::default() });
        assert_eq!(v2(r#"{"minP":0.1}"#).min_p, 0.3);
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(read_settings(&path), Settings::default());
        let json = serde_json::to_value(RoutingStatus { enabled: true, mode: Mode::Balanced, min_p: 0.8, profiler: "missing", error: None }).unwrap();
        assert_eq!(json, serde_json::json!({"enabled":true,"mode":"balanced","minP":0.8,"profiler":"missing","error":null}));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn exclusions_round_trip_and_validation() {
        let dir = std::env::temp_dir().join(format!("pandacode-exclusions-{}", crate::storage::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(EXCLUSIONS_FILE);
        assert_eq!(read_exclusions(&path), Exclusions::default());
        let model = |provider: &str, model: &str| ExcludedModel { provider: provider.into(), model: model.into() };
        let saved = Exclusions {
            providers: vec!["commandcode".into(), "commandcode".into()],
            models: vec![model("codex", "gpt-5.6-luna"), model("codex", "gpt-5.6-luna")],
        }.validated().unwrap();
        assert_eq!(saved.providers, ["commandcode"]);
        assert_eq!(saved.models.len(), 1);
        write_exclusions(&path, &saved).unwrap();
        assert_eq!(read_exclusions(&path), saved);
        assert!(!path.with_extension("json.tmp").exists());
        assert_eq!(serde_json::to_value(&saved).unwrap(), serde_json::json!({"providers":["commandcode"],"models":[{"provider":"codex","model":"gpt-5.6-luna"}]}));
        for bad in [
            Exclusions { providers: vec!["unknown".into()], models: vec![] },
            Exclusions { providers: vec!["claude".into(); 65], models: vec![] },
            Exclusions { providers: vec![], models: vec![model("unknown", "m")] },
            Exclusions { providers: vec![], models: vec![model("codex", "")] },
            Exclusions { providers: vec![], models: vec![model("codex", "a\0b")] },
            Exclusions { providers: vec![], models: vec![model("codex", &"é".repeat(101))] },
            Exclusions { providers: vec![], models: vec![model("codex", "m"); 1001] },
        ] {
            assert!(bad.validated().is_err());
        }
        assert!(Exclusions { providers: vec!["claude".into(); 64], models: vec![model("codex", &"é".repeat(100)); 1000] }.validated().is_ok());
        with_exclusions(saved.clone(), || {
            assert!(!allowed("commandcode", "anything"));
            assert!(!allowed("codex", "gpt-5.6-luna"));
            assert!(allowed("codex", "gpt-6-luna"));
            assert!(allowed("claude", "gpt-5.6-luna"));
            let pool = available(pool_from([("commandcode", "opus", "Opus"), ("codex", "gpt-5.6-luna", "Luna"), ("claude", "sonnet", "Sonnet")]));
            assert_eq!(pool.len(), 1);
            assert_eq!(pool[0].provider, "claude");
        });
        std::fs::write(&path, "invalid").unwrap();
        assert_eq!(read_exclusions(&path), Exclusions::default());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tiers_round_trip_and_validation() {
        let dir = std::env::temp_dir().join(format!("pandacode-tiers-{}", crate::storage::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(TIERS_FILE);
        assert!(read_tiers(&path).is_empty());
        let saved: Tiers = [("claude-opus-5.5".to_string(), Tier::S), ("opencode/acme/x".to_string(), Tier::D)].into();
        let saved = validate_tiers(saved).unwrap();
        write_tiers(&path, &saved).unwrap();
        assert!(!path.with_extension("json.tmp").exists());
        assert_eq!(read_tiers(&path), saved);
        assert_eq!(serde_json::to_value(&saved).unwrap(), serde_json::json!({"claude-opus-5.5":"S","opencode/acme/x":"D"}));
        // Bad entries go one by one; the rest of the file stays.
        let long = "k".repeat(301);
        std::fs::write(&path, format!(r#"{{"a":"S","b":"E","":"A","c\u0000d":"B","{long}":"C","e":3,"f":"d","g":"D"}}"#)).unwrap();
        assert_eq!(read_tiers(&path), [("a".to_string(), Tier::S), ("g".to_string(), Tier::D)].into());
        std::fs::write(&path, "not json").unwrap();
        assert!(read_tiers(&path).is_empty());
        assert!(validate_tiers([("".to_string(), Tier::S)].into()).is_err());
        assert!(validate_tiers([("a\0b".to_string(), Tier::S)].into()).is_err());
        assert!(validate_tiers([(long.clone(), Tier::S)].into()).is_err());
        assert!(validate_tiers([("é".repeat(150), Tier::S)].into()).is_ok());
        assert!(validate_tiers((0..1001).map(|i| (i.to_string(), Tier::A)).collect()).is_err());
        assert!(validate_tiers((0..1000).map(|i| (i.to_string(), Tier::A)).collect()).is_ok());
        assert!(serde_json::from_str::<Tiers>(r#"{"a":"E"}"#).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_ranks_move_to_their_card_key() {
        let entry = |p: &str, m: &str| PoolEntry { provider: p.into(), model: m.into(), name: m.into() };
        let pool = [entry("commandcode", "claude-opus-5-5"), entry("opencode", "x/mystery")];
        let (card, _) = panda_router::tier_key("commandcode", "claude-opus-5-5", "claude-opus-5-5");
        let saved: Tiers = [("commandcode/claude-opus-5-5".to_string(), Tier::A), ("opencode/x/mystery".to_string(), Tier::B)].into();
        let next = canonical_tiers(&pool, &saved).unwrap();
        assert_eq!(next, [(card.clone(), Tier::A), ("opencode/x/mystery".to_string(), Tier::B)].into());
        assert!(canonical_tiers(&pool, &next).is_none());
        // A rank already on the card key wins.
        let both: Tiers = [(card.clone(), Tier::S), ("commandcode/claude-opus-5-5".to_string(), Tier::D)].into();
        assert_eq!(canonical_tiers(&pool, &both).unwrap(), [(card, Tier::S)].into());
    }

    #[test]
    fn tier_models_share_one_key_per_card() {
        let entry = |p: &str, m: &str, n: &str| PoolEntry { provider: p.into(), model: m.into(), name: n.into() };
        let models = tier_models(&[
            entry("claude", "opus", "Opus"),
            entry("opencode", "x/mystery", "Mystery"),
            entry("commandcode", "claude-opus-5-5", "Opus via Command Code"),
            entry("opencode", "x/mystery", "Mystery again"),
            entry("kimi", "x/mystery", ""),
        ]);
        let json = serde_json::to_value(&models).unwrap();
        assert_eq!(json[0]["key"], "claude-opus-5.5");
        assert_eq!(json[0]["name"], "Opus");
        assert_eq!(json[0]["cardId"], "claude-opus-5.5");
        assert_eq!(json[0]["providers"], serde_json::json!(["claude", "commandcode"]));
        assert_eq!(json[0]["rated"], true);
        assert_eq!(json[1], serde_json::json!({"key":"opencode/x/mystery","name":"Mystery","cardId":null,"providers":["opencode"],"rated":false}));
        assert_eq!(json[2]["name"], "x/mystery");
        assert_eq!(models.len(), 3);
        // Ranked unrated models count as routable; unranked ones do not.
        let pool = pool_from([("opencode", "x/mystery", "Mystery")]);
        assert_eq!(rated_count(&pool), 0);
        with_tiers([("opencode/x/mystery".to_string(), Tier::A)].into(), || {
            assert_eq!(rated_count(&pool), 1);
            let job = Job { text: "Fix a bug".into(), ctx: TaskContext::default(), failed: vec![] };
            let route = route_with(&Router::heuristic(), &Settings::default().preferences(None), &pool, vec![job]).unwrap().remove(0);
            let json = serde_json::to_value(&route).unwrap();
            assert_eq!((json["pick"]["model"].as_str(), json["pick"]["tier"].as_str()), (Some("x/mystery"), Some("A")));
        });
    }

    #[test]
    fn tier_models_name_entries_and_hide_unresolved_defaults() {
        let entry = |p: &str, m: &str, n: &str| PoolEntry { provider: p.into(), model: m.into(), name: n.into() };
        let models = tier_models(&[
            entry("claude", "default", "Default · Claude Opus 5.5 · Claude Code"),
            entry("grok", "default", "Default"),
            entry("codex", "default", "Default · GPT-6 Luna · Codex"),
            entry("claude", "opus", "Opus · Claude Code"),
            entry("opencode", "acme/x", "Acme X · OpenCode"),
            entry("opencode", "acme/y", ""),
            entry("kimi", "k3", "K3 · Codex"),
        ]);
        let rows: Vec<_> = models.iter().map(|m| (m.key.as_str(), m.name.as_str(), m.providers.join(","))).collect();
        let luna = panda_router::resolve_card("codex", "default", "Default · GPT-6 Luna · Codex");
        let mut want = vec![("claude-opus-5.5", "Default · Claude Opus 5.5", "claude".to_string())];
        if let Some(luna) = luna {
            want.push((luna, "Default · GPT-6 Luna", "codex".into()));
        }
        want.extend([("opencode/acme/x", "Acme X", "opencode".into()), ("opencode/acme/y", "acme/y", "opencode".into())]);
        // Only the entry's own harness name is stripped.
        if panda_router::resolve_card("kimi", "k3", "K3 · Codex").is_none() {
            want.push(("kimi/k3", "K3 · Codex", "kimi".into()));
        }
        assert_eq!(rows, want);
        assert!(models.iter().all(|m| !m.key.ends_with("/default")));
    }

    #[test]
    fn default_entries_yield_to_concrete_models() {
        let pool = pool_from([
            ("claude", "default", "Default · Claude Opus 5.5 · Claude Code"),
            ("claude", "opus", "Opus"),
            ("codex", "default", "Default · GPT-6 Luna · Codex"),
            ("grok", "default", "Default"),
        ]);
        let models: Vec<_> = pool.iter().map(|m| format!("{}:{}", m.provider, m.model)).collect();
        assert_eq!(models, ["claude:opus", "codex:default", "grok:default"]);
    }

    #[test]
    fn route_shape_matches_the_frontend_contract() {
        let pool = pool_from([("claude", "sonnet", "Sonnet"), ("claude", "haiku", "Haiku"), ("opencode", "x/unknown", "?")]);
        let job = Job { text: "Fix a typo in README".into(), ctx: TaskContext::default(), failed: vec![] };
        let route = route_with(&Router::heuristic(), &Settings::default().preferences(None), &pool, vec![job]).unwrap().remove(0);
        let json = serde_json::to_value(&route).unwrap();
        for key in ["pick", "ranking", "unrated", "difficulty", "category", "profiler", "latencyMs"] {
            assert!(json.get(key).is_some(), "{key}");
        }
        for key in ["provider", "model", "name", "cardId", "pSuccess", "estCostUsd", "estLatencyMs"] {
            assert!(json["pick"].get(key).is_some(), "{key}");
        }
        assert_eq!(json["unrated"], serde_json::json!([{"provider":"opencode","model":"x/unknown","name":"?"}]));
        assert_eq!(json["profiler"], "heuristic");
    }

    #[test]
    fn pool_validation() {
        let entry = |p: &str| PoolEntry { provider: p.into(), model: "m".into(), name: "n".into() };
        assert!(validate_pool(&[entry("claude")]).is_ok());
        assert!(validate_pool(&[entry("nope")]).is_err());
        assert!(validate_pool(&(0..1000).map(|_| entry("claude")).collect::<Vec<_>>()).is_ok());
        assert!(validate_pool(&(0..1001).map(|_| entry("claude")).collect::<Vec<_>>()).is_err());
    }

    #[test]
    fn languages_rank_by_file_count() {
        let paths = ["a.rs", "b.rs", "c.ts", "d.tsx", "e.RS", "f.py", "g.md", "Makefile", "h.go"];
        assert_eq!(top_languages(paths.into_iter()), ["rust", "typescript", "go"]);
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        assert_eq!(repo_languages(here).first().map(String::as_str), Some("rust"));
    }

    #[test]
    fn idle_router_is_dropped_after_ten_minutes() {
        let start = Instant::now();
        let mut slot = Some(Loaded { router: Arc::new(Router::heuristic()), used: start });
        assert_eq!(unload_if_idle(&mut slot, start + Duration::from_secs(60)), Some(Duration::from_secs(540)));
        assert!(slot.is_some());
        assert!(touch(&mut slot).is_some());
        let used = slot.as_ref().unwrap().used;
        assert_eq!(unload_if_idle(&mut slot, used + IDLE_UNLOAD), None);
        assert!(slot.is_none());
        assert_eq!(unload_if_idle(&mut slot, used), None);
    }

    #[test]
    fn stale_part_files_are_removed() {
        let dir = std::env::temp_dir().join(format!("pandacode-parts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (old, fresh) = (dir.join("model.int8.onnx.1-a.part"), dir.join("model.int8.onnx.2-b.part"));
        std::fs::write(&old, b"x").unwrap();
        std::fs::write(&fresh, b"x").unwrap();
        let day_ago = SystemTime::now() - STALE_PART - Duration::from_secs(60);
        std::fs::File::options().write(true).open(&old).unwrap().set_modified(day_ago).unwrap();
        remove_stale_parts(&dir);
        assert!(!old.exists() && fresh.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// `cargo test --lib live_download -- --ignored`: downloads the profiler
    /// from GitHub into a temp dir and checks it loads.
    #[test]
    #[ignore]
    fn live_download_verifies_hashes() {
        let dir = std::env::temp_dir().join(format!("pandacode-router-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        tokio::runtime::Runtime::new().unwrap().block_on(download_assets(&dir)).unwrap();
        assert!(assets_present(&dir));
        assert!(Router::load(&dir).unwrap().is_onnx());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// `PANDA_ROUTER_ASSETS=<dir> cargo test --lib live_team_routing -- --ignored --nocapture`: routes
    /// realistic team assignments with the real profiler over a catalog like an installed machine's.
    #[test]
    #[ignore]
    fn live_team_routing() {
        let dir = PathBuf::from(std::env::var("PANDA_ROUTER_ASSETS").expect("PANDA_ROUTER_ASSETS"));
        let router = Router::load(&dir).unwrap();
        let catalog = [
            ("claude", "default", "Default · Claude Opus 5.5"), ("claude", "opus", "Opus 5.5"), ("claude", "sonnet", "Sonnet 5.5"),
            ("claude", "haiku", "Haiku 5.5"), ("claude", "fable", "Fable 5.1"), ("codex", "gpt-6-luna", "GPT-6 Luna"),
            ("codex", "gpt-5.6-terra", "GPT-5.6 Terra"), ("codex", "gpt-5.6-luna", "GPT-5.6 Luna"), ("kimi", "kimi-code/k3", "K3"),
            ("kimi", "kimi-code/kimi-for-coding", "Kimi for coding"), ("kimi", "moonshot-ai/kimi-k3.1-pro", "K3.1 Pro"),
            ("glm", "glm-5.3", "GLM-5.3"), ("glm", "glm-5.3-flash", "GLM-5.3 Flash"), ("glm", "glm-4.5-air", "GLM-4.5 Air"),
            ("mimo", "mimo-v2.6-pro", "MiMo V2.6 Pro"), ("mimo", "mimo-v2.6-flash", "MiMo V2.6 Flash"), ("grok", "grok-4.7", "Grok 4.7"),
            ("grok", "grok-4.7-build-fast", "Grok 4.7 Build Fast"), ("muse", "muse-wonder-1.0", "Muse Wonder 1.0"),
            ("muse", "muse-spark-1.3", "Muse Spark 1.3"), ("opencode", "openrouter/deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"),
            ("opencode", "openrouter/qwen/qwen3.8-27b", "Qwen 3.8 27B"), ("pi", "flint-local", "Flint local"),
        ];
        let pool = pool_from(catalog);
        let tasks = [
            ("Fix the typo 'recieve' in docs/releasing.md line 12.", 1),
            ("The test tests/queue.test.mjs started failing after the last merge with 'expected 3, got 2'. Find the root cause and fix it.", 3),
            ("Refactor the provider pipeline so every harness goes through one transport trait: move shared code out of providers.rs, acp.rs and cloud_agents/transport.rs and keep all tests passing.", 40),
            ("Polish the settings panel: align the switches, tighten the spacing, and make the focus ring use --focus.", 2),
            ("Security review: audit the remote relay protocol code for replay, key handling and authorization bugs. Report findings only.", 15),
            ("Prove that the scheduler's admission algorithm never starves a queued worker, and write the proof as a doc comment.", 1),
            ("Research how other code editors implement incremental find-in-file highlighting and summarize the trade-offs.", 0),
            ("Write a release script that bumps the version in package.json, Cargo.toml and tauri.conf.json, then tags the commit.", 4),
        ];
        let mode = match std::env::var("PANDA_ROUTER_MODE").as_deref() {
            Ok("cheapest") => Some(Mode::Cheapest),
            Ok("quality") => Some(Mode::Quality),
            _ => None,
        };
        let prefs = Settings::default().preferences(mode);
        let langs = vec!["typescript".to_string(), "rust".to_string()];
        let short = |m: &panda_router::Routed| format!("{}:{}", m.provider, m.model);
        for (text, files) in tasks {
            let ctx = TaskContext { files_in_scope: (files > 0).then_some(files), repo_languages: langs.clone(), requires_tools: true };
            let r = router.route(text, &ctx, &pool, &prefs, &[], &Tiers::new()).unwrap();
            let pick = r.pick.as_ref().map_or("none".into(), |p| format!("{} P{:.2}/{:.2} ${:.4}", short(p), p.p_success, p.p_success_lower, p.est_cost_usd));
            let ladder: Vec<_> = r.ladder.iter().map(short).collect();
            // What a fresh `profileId: "auto"` worker gets (architect::routing::staff).
            let opener = if prefs.mode == Mode::Quality { r.pick.as_ref() } else { r.ladder.first().or(r.pick.as_ref()) };
            println!("[{} d{} {} {:.0}ms] {}\n  opener {} | policy pick {pick} ({})\n  ladder {}", r.profiler, r.difficulty, r.category, r.latency_ms, &text[..60.min(text.len())], opener.map_or("none".into(), short), r.decided_by, ladder.join(" > "));
            // Escalation: fail the staffed model, then each escalation pick, as a team replacing failed workers would.
            let mut failed: Vec<PoolModel> = Vec::new();
            let mut last = opener.cloned();
            for _ in 0..2 {
                let Some(p) = last else { break };
                failed.push(PoolModel { provider: p.provider, model: p.model, name: p.name });
                let e = router.route(text, &ctx, &pool, &prefs, &failed, &Tiers::new()).unwrap();
                let names: Vec<_> = failed.iter().map(|m| format!("{}:{}", m.provider, m.model)).collect();
                println!("  after {} failed -> {} ({}, d{})", names.join(", "), e.pick.as_ref().map_or("none".into(), short), e.decided_by, e.difficulty);
                assert!(e.pick.as_ref().is_none_or(|p| !failed.iter().any(|f| f.provider == p.provider && f.model == p.model)));
                last = e.pick;
            }
            assert_eq!(r.profiler, "onnx");
            assert!(r.unrated.is_empty() || r.unrated.iter().all(|m| m.provider == "pi"), "{:?}", r.unrated);
        }
    }
}
