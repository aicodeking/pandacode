//! Reasoning levels per worker model. A requested `reasoningEffort` is lowered only when the
//! harness's catalog is known to lack it for that model (the lists the Codex and Claude runs
//! check at startup); with no catalog the provider-wide rule decides and the level is kept.
//! Catalogs are looked up only when a dispatch or follow-up asks for an effort, bounded in
//! time; only one confirmed within the cache TTL lowers a level, and a failed lookup is
//! remembered briefly so it is not retried at once. Fitting never does I/O,
//! so the scheduler can fit again right before a launch. If a harness still rejects an effort
//! at startup, the worker is relaunched once without it (`rejected`).
use std::collections::HashMap;
use std::future::Future;
use std::time::{Duration, Instant};

/// Reasoning levels from least to most, the scale the nearest supported level is found on.
/// `none` (some Codex catalogs) and `off` are both "no reasoning".
pub(super) const EFFORT_LEVELS: [&str; 8] = ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
/// How long a discovered catalog is used before it is refreshed (it is kept if that fails).
const CATALOG_TTL: Duration = Duration::from_secs(10 * 60);
/// How long a failed discovery is not retried.
const FAILURE_TTL: Duration = Duration::from_secs(60);
/// The whole lookup, including waiting for a discovery already running elsewhere.
const LOOKUP_BUDGET: Duration = Duration::from_secs(8);
const SLOT_RETRY: Duration = Duration::from_millis(250);

/// Model ID -> the effort IDs it advertises.
type Catalog = HashMap<String, Vec<String>>;
struct Entry {
    /// The discovered catalog; `None` after a failed lookup.
    catalog: Option<Catalog>,
    checked: Instant,
    ok: bool,
}
type Catalogs = HashMap<String, Entry>;

#[cfg(not(test))]
static CATALOGS: std::sync::LazyLock<std::sync::Mutex<Catalogs>> = std::sync::LazyLock::new(Default::default);
#[cfg(not(test))]
fn with_catalogs<R>(f: impl FnOnce(&mut Catalogs) -> R) -> R {
    f(&mut CATALOGS.lock().unwrap_or_else(|e| e.into_inner()))
}
// Each test thread has its own cache, so tests cannot see each other's catalogs.
#[cfg(test)]
thread_local! { static CATALOGS: std::cell::RefCell<Catalogs> = Default::default(); }
#[cfg(test)]
fn with_catalogs<R>(f: impl FnOnce(&mut Catalogs) -> R) -> R {
    CATALOGS.with(|c| f(&mut c.borrow_mut()))
}

/// Most characters a requested effort may have; anything longer is not a level.
const EFFORT_MAX: usize = 32;
/// Told to the lead when a requested effort is not a level at all.
pub(super) const NOT_A_LEVEL: &str = "reasoningEffort must be a level such as low, medium or high (up to 32 letters, digits, dashes or underscores).";

/// A requested effort, normalised and checked at the tool boundary: up to 32 lowercase ASCII
/// letters, digits, dashes or underscores (catalog IDs such as `extra_high`), so a note or snapshot can never carry an inflated value.
pub(super) fn check(effort: Option<String>) -> Result<Option<String>, &'static str> {
    let Some(effort) = normalise(effort) else { return Ok(None) };
    let level = effort.len() <= EFFORT_MAX && effort.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
    if level { Ok(Some(effort)) } else { Err(NOT_A_LEVEL) }
}

/// Effort as the lead may type it (`" High "`), as the harnesses expect it (`high`).
pub(super) fn normalise(effort: Option<String>) -> Option<String> {
    effort.map(|e| e.trim().to_ascii_lowercase()).filter(|e| !e.is_empty())
}

/// The levels a model accepts, when its catalog is known. Codex and Claude reject any effort
/// a listed model does not advertise (Codex skips its `default` model); elsewhere an empty
/// list only means the catalog did not say. A model missing from the catalog is unknown.
pub(super) fn model_levels(provider: &str, model: &str) -> Option<Vec<String>> {
    if provider == "codex" && model == "default" {
        return None;
    }
    // Only a catalog confirmed within the cache TTL may lower a level; a stale one kept after a
    // failed refresh decides nothing (the provider's rule keeps the level).
    let levels = with_catalogs(|c| {
        let entry = c.get(provider).filter(|e| e.ok && e.checked.elapsed() <= CATALOG_TTL)?;
        entry.catalog.as_ref()?.get(model).cloned()
    })?;
    (!levels.is_empty() || matches!(provider, "codex" | "claude")).then_some(levels)
}

/// A level the run will start with: the provider-wide check always applies (a run fails it
/// before the harness starts, with no relaunch), and a fresh catalog must list it too.
fn supports(provider: &str, known: Option<&[String]>, effort: &str) -> bool {
    crate::providers::validate_reasoning_effort(provider, Some(effort)).is_ok()
        && known.is_none_or(|levels| levels.iter().any(|level| level == effort))
}

fn target(provider: &str, model: &str) -> String {
    if model.is_empty() { provider.to_string() } else { format!("{model} ({provider})") }
}

/// Fits a requested effort to a model: kept when supported (or when the model's levels are
/// unknown and the provider accepts it), else the nearest supported level (the lower one on a
/// tie), else dropped. The note says what changed.
pub(super) fn fit(provider: &str, model: &str, wanted: Option<&String>) -> (Option<String>, Option<String>) {
    let Some(wanted) = normalise(wanted.cloned()) else { return (None, None) };
    let known = model_levels(provider, model);
    let known = known.as_deref();
    if supports(provider, known, &wanted) {
        return (Some(wanted), None);
    }
    let target = target(provider, model);
    let used = |level: &str| (Some(level.to_string()), Some(format!("reasoningEffort {wanted} is not supported on {target}; used {level}")));
    // A thinking switch (Kimi's on/off): any level asks for thinking, so it is "on", never "off".
    let disables = |level: &str| matches!(level, "off" | "none");
    let positive = !disables(&wanted);
    if positive && known.is_some_and(|levels| levels.iter().any(|level| level == "on")) {
        return used("on");
    }
    // A positive level never lands on "off"/"none", which would turn reasoning off instead of
    // lowering it; "off" and "none" fit each other.
    let nearest = EFFORT_LEVELS.iter().position(|e| *e == wanted).and_then(|at| {
        (0..EFFORT_LEVELS.len())
            // "off"/"none" only ever fit each other: no reasoning never becomes some reasoning.
            .filter(|&i| positive != disables(EFFORT_LEVELS[i]) && supports(provider, known, EFFORT_LEVELS[i]))
            .min_by_key(|&i| (i.abs_diff(at), i))
    });
    match nearest {
        Some(i) => used(EFFORT_LEVELS[i]),
        None => (None, Some(format!("reasoningEffort {wanted} is not supported on {target}; dropped"))),
    }
}

/// The effort a worker runs with: the requested one fitted to its model, else its inherited
/// default (the lead's or the profile's, for this same model), which is trusted as it is.
/// The note says what was changed and what is used instead.
pub(super) fn apply(provider: &str, model: &str, wanted: Option<&String>, default: Option<&String>) -> (Option<String>, Option<String>) {
    if wanted.is_none() {
        return (default.cloned(), None);
    }
    let (fitted, note) = fit(provider, model, wanted);
    if fitted.is_some() {
        return (fitted, note);
    }
    // A request for no reasoning that the model cannot honour takes the model's own default,
    // never an inherited positive level.
    if wanted.is_some_and(|wanted| matches!(normalise(Some(wanted.clone())).as_deref(), Some("off" | "none"))) {
        return (None, note.map(|n| format!("{n}, using the model's default")));
    }
    let instead = default.map_or_else(|| "the model's default".to_string(), |e| format!("the default {e}"));
    (default.cloned(), note.map(|n| format!("{n}, using {instead}")))
}

/// For a provider and model the lead named: an unsupported level is an error listing the
/// valid ones (the model's own when they are known).
pub(super) fn explicit(provider: &str, model: &str, wanted: Option<&String>) -> Result<(), String> {
    let Some(wanted) = wanted else { return Ok(()) };
    let known = model_levels(provider, model);
    if supports(provider, known.as_deref(), wanted) {
        return Ok(());
    }
    let valid: Vec<String> = match known.as_deref() {
        Some(levels) => levels.iter().filter(|level| supports(provider, Some(levels), level)).cloned().collect(),
        None => EFFORT_LEVELS.iter().filter(|e| supports(provider, None, e)).map(|e| e.to_string()).collect(),
    };
    let valid = if valid.is_empty() { "none (omit reasoningEffort)".to_string() } else { valid.join(", ") };
    Err(format!("reasoningEffort {wanted:?} is not supported on {}. Use one of: {valid}.", target(provider, model)))
}

/// The setting names an ACP harness gives its effort choice (option id, else category).
const ACP_EFFORT_SETTINGS: [&str; 3] = ["thought_level", "effort", "reasoning_effort"];

/// A run that failed at startup because the harness refused its reasoning effort: Codex and
/// Claude ("The selected … model does not support this reasoning effort"), and ACP harnesses
/// (`acp::NO_ADJUSTABLE_EFFORT`, or `acp::UNADVERTISED_CHOICE` for an effort setting). An
/// effort option with another id (say "variant") is not recognised; the run then fails as usual.
pub(crate) fn rejected(error: &str) -> bool {
    use crate::providers::acp::{NO_ADJUSTABLE_EFFORT, UNADVERTISED_CHOICE};
    use crate::providers::{MODEL_REFUSES_EFFORT, UNSUPPORTED_EFFORT};
    // Only the known startup errors, by their shared phrases: any other error that mentions an
    // effort is an ordinary failure.
    [MODEL_REFUSES_EFFORT, UNSUPPORTED_EFFORT, NO_ADJUSTABLE_EFFORT].iter().any(|phrase| error.contains(phrase))
        || ACP_EFFORT_SETTINGS.iter().any(|setting| error.contains(&format!("{UNADVERTISED_CHOICE} {setting} \"")))
}

fn cached(provider: &str) -> bool {
    with_catalogs(|c| c.get(provider).is_some_and(|e| e.checked.elapsed() <= if e.ok { CATALOG_TTL } else { FAILURE_TTL }))
}

/// Looks up the catalogs of these providers that are not cached, in parallel and bounded in time.
pub(super) async fn warm(providers: impl IntoIterator<Item = String>) {
    warm_with(providers, |provider| async move { crate::providers::list_model_catalog(&provider).await }).await
}

/// `warm` with the discovery passed in. A discovery that is busy elsewhere is retried until the
/// budget runs out; a failure is remembered briefly so the next dispatch does not wait again.
pub(super) async fn warm_with<F, Fut>(providers: impl IntoIterator<Item = String>, discover: F)
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<Vec<crate::providers::ModelInfo>, String>>,
{
    let mut wanted: Vec<String> = providers.into_iter().filter(|p| !cached(p)).collect();
    wanted.sort();
    wanted.dedup();
    let discover = &discover;
    let found = futures_util::future::join_all(wanted.into_iter().map(|provider| async move {
        let started = Instant::now();
        let models = loop {
            let left = LOOKUP_BUDGET.saturating_sub(started.elapsed());
            match tokio::time::timeout(left, discover(provider.clone())).await {
                Ok(Err(error)) if busy(&error) && started.elapsed() + SLOT_RETRY < LOOKUP_BUDGET => tokio::time::sleep(SLOT_RETRY).await,
                Ok(result) => break result.ok(),
                Err(_) => break None,
            }
        };
        (provider, models)
    }))
    .await;
    with_catalogs(|catalogs| {
        for (provider, models) in found {
            let found = models.map(|models| models.into_iter().map(|m| (m.id, m.reasoning_efforts.into_iter().map(|e| e.id).collect())).collect());
            // A failed lookup replaces the entry: an older catalog would decide nothing anyway.
            let ok = found.is_some();
            catalogs.insert(provider, Entry { catalog: found, checked: Instant::now(), ok });
        }
    });
}

/// Another window or dispatch holds this harness's discovery slot.
fn busy(error: &str) -> bool {
    error.contains("already running") || error.contains("busy")
}

#[cfg(test)]
pub(super) fn seed(provider: &str, models: &[(&str, &[&str])]) {
    with_catalogs(|catalogs| {
        let entry = catalogs.entry(provider.to_string()).or_insert_with(|| Entry { catalog: None, checked: Instant::now(), ok: true });
        let catalog = entry.catalog.get_or_insert_with(HashMap::new);
        for (model, levels) in models {
            catalog.insert(model.to_string(), levels.iter().map(|l| l.to_string()).collect());
        }
    });
}

/// Forgets every catalog on this test thread; `stale` marks them due for a refresh instead.
#[cfg(test)]
pub(super) fn reset(stale: bool) {
    with_catalogs(|catalogs| {
        if stale {
            for entry in catalogs.values_mut() {
                entry.checked = Instant::now().checked_sub(CATALOG_TTL + Duration::from_secs(1)).unwrap_or(entry.checked);
            }
        } else {
            catalogs.clear();
        }
    });
}
