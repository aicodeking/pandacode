//! Panda Router: picks the model for a task, in process. A native port of PandaOrchestrator v4.3
//! (github.com/aicodeking/PandaOrchestrator @ 83e408c): an int8 ONNX task profiler (or a keyword heuristic
//! when the model files are not installed), the learned success head, and the v4 policy with its
//! escalation ladder. Nothing here touches the network; `model_routing` downloads the profiler and owns
//! the process-wide router.

mod cards;
mod heuristic;
mod matcher;
mod policy;
#[cfg(panda_onnx)]
mod onnx;
#[cfg(not(panda_onnx))]
#[path = "panda_router/onnx_stub.rs"]
mod onnx;
mod profile;
mod success;
mod tiers;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use onnx::OnnxProfiler;
pub use tiers::Tier;

/// User tier list: card id for rated models, `<provider>/<model>` for unrated ones (`tier_key`).
pub type Tiers = HashMap<String, Tier>;

/// Whether this build carries the ONNX profiler (see `panda_onnx` in build.rs).
pub const ONNX_AVAILABLE: bool = cfg!(panda_onnx);
use profile::{TaskProfile, CATEGORIES, N_DIFFICULTY};

/// Model files downloaded into the router directory: (file name, sha256 hex).
pub const ASSETS: &[(&str, &str)] = &[
    ("model.int8.onnx", "b52d463905808efd892c91917e3010985359e259fe7a514ae083967c98fa2216"),
    ("tokenizer.json", "ca870c678352403d107496dc78899fa666ed0f56fef63e88ae398fafe5d78c45"),
];
pub const ASSET_BASE_URL: &str = "https://raw.githubusercontent.com/aicodeking/PandaOrchestrator/83e408c794ef1d09b6d13b6ad8734e984f552402/artifacts/panda-router-v4/";
/// Directory (under app data) for the files in `ASSETS`; versioned so v2 files are never reused.
pub const ASSET_DIR: &str = "panda-router/v4";

const TOP_K: usize = 5;

/// A PandaCode harness + model id + display name.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolModel {
    pub provider: String,
    pub model: String,
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Upstream `max_utility`.
    #[default]
    Balanced,
    /// Upstream `cheapest_above_threshold` (min expected cost with P lower bound >= min_p; none -> `:relaxed`).
    Cheapest,
    /// Upstream `max_quality`.
    Quality,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub mode: Mode,
    pub min_p: f64,
}

impl Default for Preferences {
    fn default() -> Self {
        Self { mode: Mode::Balanced, min_p: 0.5 }
    }
}

#[derive(Clone, Debug, Default)]
pub struct TaskContext {
    pub repo_languages: Vec<String>,
    pub files_in_scope: Option<u32>,
    /// The task runs as a tool-using agent: the profiler sees it and only tool-capable models qualify.
    pub requires_tools: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Routed {
    pub provider: String,
    pub model: String,
    pub name: String,
    pub card_id: String,
    /// Calibrated P(pass) (what upstream displays).
    pub p_success: f64,
    /// Lower confidence bound of P; the policy decides on this.
    pub p_success_lower: f64,
    pub est_cost_usd: f64,
    /// Cost plus the failure term (1 - P)·(next step + retry penalty).
    pub expected_cost_usd: f64,
    pub est_latency_ms: f64,
    /// The user's tier for this model, when ranked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<Tier>,
    /// That tier's P for this task before the blend: `p_success` = 0.7·tier P + 0.3·card P.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier_p: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub pick: Option<Routed>,
    /// Upstream `choice.decided_by`: `policy:<mode>[:relaxed|:equal_p_cheaper]`, `escalation_ladder`,
    /// `escalation:stronger`, `escalation:strongest_left` or `none:all_filtered`.
    pub decided_by: String,
    /// Best first, at most 5.
    pub ranking: Vec<Routed>,
    /// Upstream `escalation_ladder`: try in order, escalate on failure (empty when nothing qualifies).
    pub ladder: Vec<Routed>,
    /// Models that already failed on this task, in order (escalation input).
    pub failed: Vec<PoolModel>,
    /// Decision difficulty over levels 1..10, rounded like upstream's response (escalation prior).
    pub distribution: Vec<f64>,
    /// Pool entries with no card.
    pub unrated: Vec<PoolModel>,
    /// Most likely level of `distribution`.
    pub difficulty: u8,
    pub category: String,
    /// "onnx" or "heuristic".
    pub profiler: &'static str,
    pub latency_ms: f64,
}

pub struct Router {
    onnx: Option<OnnxProfiler>,
}

/// Maps a PandaCode model to a card id: the harness table, then upstream alias matching, then (for
/// `default`) the display name. Ambiguous or unknown -> None.
pub fn resolve_card(provider: &str, model: &str, name: &str) -> Option<&'static str> {
    let catalog = cards::catalog().ok()?;
    catalog.resolve(provider, model, name).map(|i| catalog.cards[i].id.as_str())
}

/// A model's tier-list key: its card id when rated (the same model on several harnesses shares it),
/// else `<provider>/<model>`.
pub fn tier_key(provider: &str, model: &str, name: &str) -> (String, Option<&'static str>) {
    match resolve_card(provider, model, name) {
        Some(id) => (id.to_string(), Some(id)),
        None => (format!("{provider}/{model}"), None),
    }
}

impl Router {
    /// Loads the ONNX profiler from `dir` (model.int8.onnx + tokenizer.json, checked against `ASSETS`).
    pub fn load(dir: &Path) -> Result<Router, String> {
        cards::catalog()?;
        Ok(Router { onnx: Some(OnnxProfiler::load(dir)?) })
    }

    /// Keyword profiler; works without model files but routes less well.
    pub fn heuristic() -> Router {
        Router { onnx: None }
    }

    pub fn is_onnx(&self) -> bool {
        self.onnx.is_some()
    }

    fn profiler_name(&self) -> &'static str {
        if self.is_onnx() { "onnx" } else { "heuristic" }
    }

    fn profile(&self, text: &str, ctx: &TaskContext) -> Result<TaskProfile, String> {
        match &self.onnx {
            Some(onnx) => Ok(onnx.profile_batch(&[profile::format_input(text, ctx)])?.remove(0)),
            None => Ok(heuristic::profile(text, ctx)),
        }
    }

    /// Upstream `route`, then one upstream `escalate` per entry of `failed`, in order (a chain: each
    /// failure updates the previous route's difficulty and follows its ladder). Failed models that are not
    /// a rated pool entry are ignored here; `escalate` refuses them.
    pub fn route(
        &self,
        text: &str,
        ctx: &TaskContext,
        pool: &[PoolModel],
        prefs: &Preferences,
        failed: &[PoolModel],
        tiers: &Tiers,
    ) -> Result<Route, String> {
        let start = Instant::now();
        let profile = self.profile(text, ctx)?;
        let rated = Rated::new(pool, tiers)?;
        let mut route = self.decide(&profile, text, ctx, &rated, prefs, None, &[], &[], start);
        for m in failed {
            if rated.position(m).is_some() {
                route = self.escalate_once(&profile, text, ctx, &rated, prefs, &route, m, start)?;
            }
        }
        Ok(route)
    }

    /// Upstream `escalate`: `previous` (a route for the same task, pool and preferences) was tried and
    /// each model in `failed` failed, in order. The difficulty becomes the Bayes posterior given the
    /// failure, failed models are excluded, and the pick never steps down: the next rung of `previous.ladder`
    /// still at least as strong as the strongest failed model, else `escalation:stronger`, else
    /// `escalation:strongest_left`. Errors when `failed` is empty or names a model not rated in `pool`.
    // Production escalates through `route(.., failed)` (no saved Route across turns); tests prove both agree.
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub fn escalate(
        &self,
        text: &str,
        ctx: &TaskContext,
        pool: &[PoolModel],
        prefs: &Preferences,
        previous: &Route,
        failed: &[PoolModel],
        tiers: &Tiers,
    ) -> Result<Route, String> {
        let start = Instant::now();
        if failed.is_empty() {
            return Err("escalate needs at least one failed model".into());
        }
        let profile = self.profile(text, ctx)?;
        let rated = Rated::new(pool, tiers)?;
        let mut route = previous.clone();
        for m in failed {
            if rated.position(m).is_none() {
                return Err(format!("failed model {} is not a rated pool entry", m.name));
            }
            route = self.escalate_once(&profile, text, ctx, &rated, prefs, &route, m, start)?;
        }
        Ok(route)
    }

    #[allow(clippy::too_many_arguments)]
    fn escalate_once(
        &self,
        profile: &TaskProfile,
        text: &str,
        ctx: &TaskContext,
        rated: &Rated,
        prefs: &Preferences,
        previous: &Route,
        failed: &PoolModel,
        start: Instant,
    ) -> Result<Route, String> {
        let i = rated.position(failed).ok_or("failed model is not in the pool")?;
        let prior: [f64; N_DIFFICULTY] = match previous.distribution.as_slice().try_into() {
            Ok(d) => matcher::normalized(&d),
            Err(_) => matcher::normalized(&profile.difficulty),
        };
        let post = matcher::Demand::new(profile).after_failure(&prior, rated.card(i), rated.ability(i));
        let mut failed_list: Vec<usize> = previous.failed.iter().filter_map(|m| rated.position(m)).collect();
        failed_list.push(i);
        let ladder: Vec<usize> = previous.ladder.iter().filter_map(|r| rated.by_card_id(&r.card_id)).collect();
        Ok(self.decide(profile, text, ctx, rated, prefs, Some(post), &failed_list, &ladder, start))
    }

    #[allow(clippy::too_many_arguments)]
    fn decide(
        &self,
        profile: &TaskProfile,
        text: &str,
        ctx: &TaskContext,
        rated: &Rated,
        prefs: &Preferences,
        difficulty: Option<[f64; N_DIFFICULTY]>,
        failed: &[usize],
        prev_ladder: &[usize],
        start: Instant,
    ) -> Route {
        let cards: Vec<&cards::Card> = (0..rated.entries.len()).map(|i| rated.card(i)).collect();
        let abilities: Vec<Option<f64>> = (0..rated.entries.len()).map(|i| rated.ability(i)).collect();
        let difficulty = difficulty.unwrap_or(profile.difficulty);
        let d = matcher::decide(&matcher::Request {
            profile,
            text,
            difficulty: &difficulty,
            pool: &cards,
            failed,
            prev_ladder,
            tiers: &abilities,
            requires_tools: ctx.requires_tools,
            mode: prefs.mode,
            min_p: prefs.min_p,
        });
        let routed = |i: usize| {
            let (m, _, tier) = &rated.entries[i];
            let s = &d.scored[i];
            Routed {
                provider: m.provider.clone(),
                model: m.model.clone(),
                name: m.name.clone(),
                card_id: rated.card(i).id.clone(),
                p_success: s.p,
                p_success_lower: s.p_lo,
                est_cost_usd: s.cost,
                expected_cost_usd: s.expected_cost,
                est_latency_ms: s.latency,
                tier: *tier,
                tier_p: s.tier_p,
            }
        };
        let level = d.difficulty.iter().enumerate().fold(0, |best, (i, p)| if *p > d.difficulty[best] { i } else { best });
        let mut failed_models: Vec<PoolModel> = failed.iter().map(|&i| rated.entries[i].0.clone()).collect();
        failed_models.dedup();
        Route {
            pick: d.chosen.map(routed),
            decided_by: d.decided_by,
            ranking: d.order.iter().take(TOP_K).map(|&i| routed(i)).collect(),
            ladder: d.ladder.iter().map(|&i| routed(i)).collect(),
            failed: failed_models,
            distribution: d.difficulty.iter().map(|x| heuristic::py_round(*x, 6)).collect(),
            unrated: rated.unrated.clone(),
            difficulty: level as u8 + 1,
            category: CATEGORIES[profile.top_category()].to_string(),
            profiler: self.profiler_name(),
            latency_ms: start.elapsed().as_secs_f64() * 1000.0,
        }
    }
}

#[derive(Clone, Copy)]
enum Source {
    Catalog(usize),
    Synthetic(usize),
}

/// The pool resolved to cards; the first entry for a card wins. Ranked models without a card get a
/// synthetic one (`tiers::synthetic`); unranked ones stay unrated.
struct Rated<'a> {
    catalog: &'static cards::Catalog,
    entries: Vec<(&'a PoolModel, Source, Option<Tier>)>,
    synthetic: Vec<cards::Card>,
    unrated: Vec<PoolModel>,
}

impl<'a> Rated<'a> {
    fn new(pool: &'a [PoolModel], tiers: &Tiers) -> Result<Self, String> {
        let catalog = cards::catalog()?;
        let mut entries: Vec<(&PoolModel, Source, Option<Tier>)> = Vec::new();
        let mut pending: Vec<(&PoolModel, String, Tier)> = Vec::new();
        let mut unrated = Vec::new();
        let legacy = |m: &PoolModel| tiers.get(&format!("{}/{}", m.provider, m.model)).copied();
        for m in pool {
            match catalog.resolve(&m.provider, &m.model, &m.name) {
                Some(card) => match entries.iter_mut().find(|(_, c, _)| matches!(c, Source::Catalog(c) if *c == card)) {
                    // A tier saved under `<provider>/<model>` while the model was unrated still applies once
                    // it has a card, from any of the card's pool entries; the card-id tier wins.
                    Some((_, _, tier)) => *tier = tier.or_else(|| legacy(m)),
                    None => entries.push((m, Source::Catalog(card), tiers.get(&catalog.cards[card].id).copied().or_else(|| legacy(m)))),
                },
                None => {
                    let key = format!("{}/{}", m.provider, m.model);
                    match tiers.get(&key) {
                        Some(_) if pending.iter().any(|(_, k, _)| *k == key) => {}
                        Some(&tier) => pending.push((m, key, tier)),
                        None => unrated.push(m.clone()),
                    }
                }
            }
        }
        let synthetic: Vec<cards::Card> = pending.iter().map(|(_, key, tier)| tiers::synthetic(key.clone(), *tier)).collect();
        entries.extend(pending.into_iter().enumerate().map(|(k, (m, _, tier))| (m, Source::Synthetic(k), Some(tier))));
        Ok(Self { catalog, entries, synthetic, unrated })
    }

    fn card(&self, i: usize) -> &cards::Card {
        match self.entries[i].1 {
            Source::Catalog(c) => &self.catalog.cards[c],
            Source::Synthetic(k) => &self.synthetic[k],
        }
    }

    fn ability(&self, i: usize) -> Option<f64> {
        self.entries[i].2.map(Tier::ability)
    }

    /// The rated entry for a model (by its card, so a duplicate entry maps to the kept one).
    fn position(&self, m: &PoolModel) -> Option<usize> {
        let id = match self.catalog.resolve(&m.provider, &m.model, &m.name) {
            Some(card) => self.catalog.cards[card].id.clone(),
            None => format!("{}/{}", m.provider, m.model),
        };
        self.by_card_id(&id)
    }

    fn by_card_id(&self, id: &str) -> Option<usize> {
        (0..self.entries.len()).position(|i| self.card(i).id == id)
    }
}
