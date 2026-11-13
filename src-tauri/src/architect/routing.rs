//! Panda Router for teams: `profileId: "auto"` in dispatch_workers and the route_models tool.
//! Routing runs before the team state is locked; named agent teams route only within their roster.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Manager;

use rusqlite::{params, OptionalExtension};

use super::{active, load, model_efforts, text, Assignment, TeamConfig, TeamSnapshot, WorkerProfile, HARNESSES, PAGE_BYTES};
use crate::model_routing::{self, Job};
use crate::model_health;
use crate::panda_router::{Mode, PoolModel, Route, Routed, TaskContext};
use crate::{storage, AppState, Result};

pub(super) const AUTO: &str = "auto";
/// What the profiler reads of a task; longer text is cut for it, never refused.
const MAX_TASK_TEXT: usize = 8192;

#[derive(Clone, Debug)]
pub(crate) struct AutoRoute {
    /// The policy's choice.
    pick: Option<Routed>,
    /// Try in order, escalating on failure; a fresh Cheap or Balanced assignment opens on its first rung.
    ladder: Vec<Routed>,
    mode: Mode,
    decided_by: String,
    /// Models that failed this assignment before (escalation input).
    failed: Vec<PoolModel>,
    /// The ladder entry Council diversity moved this reviewer to, in place of the usual opener.
    pinned: Option<Routed>,
    difficulty: u8,
    category: String,
    profiler: &'static str,
}
/// Assignment key -> route, or why there is none.
pub(crate) type AutoRoutes = HashMap<String, std::result::Result<AutoRoute, &'static str>>;

/// Failed attempts at one assignment after which `auto` stops escalating: the first try plus two retries.
pub(super) const MAX_ATTEMPTS: usize = 3;

/// The models `auto` may pick: a named team's own models, else every installed model
/// (`catalog`), else the roster.
pub(super) fn pool(config: &TeamConfig) -> Vec<PoolModel> {
    let source = if config.roster_only || config.catalog.is_empty() { &config.workers } else { &config.catalog };
    model_routing::pool_from(source.iter().filter(|p| model_routing::allowed(&p.provider, &p.model)).map(|p| (p.provider.as_str(), p.model.as_str(), p.name.as_str())))
}

/// Rated models in the pool that are not paused after failures.
fn rated(config: &TeamConfig) -> usize {
    model_routing::rated_count(&model_health::healthy(pool(config)))
}

/// Whether an assignment without profileId, provider or model is routed like `profileId: "auto"`.
pub(super) fn by_default(config: &TeamConfig) -> bool {
    model_routing::enabled() && rated(config) > 0
}

/// Whether this assignment asks for routing: `profileId: "auto"`, or nothing chosen while routing is the default.
fn routes(a: &Value, default: bool) -> bool {
    a["profileId"] == AUTO || (default && a["profileId"].is_null() && a["provider"].is_null() && a["model"].is_null())
}

/// The routing part of the lead's team rules; empty while routing is off or nothing is rated.
pub(super) fn prompt_note(config: &TeamConfig, enabled: bool) -> String {
    if !enabled {
        return String::new();
    }
    let n = rated(config);
    if n == 0 {
        return String::new();
    }
    let scope = if config.roster_only { format!("this team's {n} rated models") } else { format!("{n} rated models") };
    let start = if model_routing::mode() == Mode::Quality { "starting on the strongest fit" } else { "starting on the cheapest model likely to pass" };
    format!(" Router first: give every assignment profileId \"auto\" (or omit profileId, provider and model) and Panda Router picks its model from {scope}, {start}; route_models previews picks. Pick a model yourself only when the user names models or harnesses. Verify each result (tests, typecheck or review). When a routed worker errors, refuses or fails review, dispatch a replacement with replaces set to it and profileId \"auto\": a failed run drops that model and the router tries the same model on another harness first; a bad result escalates to a stronger model. At most 2 retries, then report the failure to the user. Only when routing has nothing left, use your own model.")
}

/// Failed worker ID -> the models that failed its assignment, oldest first, for `replaces`.
pub(crate) type Chains = HashMap<String, Vec<PoolModel>>;

/// Whether a worker can be replaced: it failed, or it completed and the lead found the result wrong
/// (tests, typecheck, review). A stopped or unfinished worker is no verdict on its model.
pub(super) fn replaceable(status: &str) -> bool {
    matches!(status, "failed" | "completed")
}

/// One assignment's history through its replacements.
pub(super) struct Chain {
    /// Models whose completed results failed the lead's check, oldest first: the router escalates past them.
    pub failed: Vec<PoolModel>,
    /// Every attempt, failed runs and failovers included, for the retry cap.
    pub attempts: usize,
}

/// Worker `id`'s assignment if it is replaced: each worker its dispatch `replaced` (recursively, from
/// the saved requests), then its own. None unless `replaceable`. A failed run or launch is the
/// harness's, not the model's: health already pauses that entry, and listing it as failed would
/// exclude the model on every harness, so only completed results escalate.
pub(super) fn failed_chain(store: &storage::Store, team: &TeamSnapshot, id: &str) -> Result<Option<Chain>> {
    if !team.workers.iter().any(|w| w.id == id && replaceable(&w.status)) {
        return Ok(None);
    }
    let pool = pool(&team.config);
    let mut chain = Vec::new();
    let (mut links, mut attempts) = (0, 0);
    let mut next = team.workers.iter().find(|w| w.id == id);
    // Bounded by the team's size, so a malformed record cannot loop.
    while let Some(w) = next.filter(|_| links < team.workers.len()) {
        links += 1;
        // Each dispatch is one attempt, and each harness failover another; follow-ups are not.
        attempts += 1 + w.failovers;
        if w.status == "completed" {
            let name = pool.iter().find(|m| m.provider == w.provider && m.model == w.model).map_or_else(|| w.model.clone(), |m| m.name.clone());
            chain.push(PoolModel { provider: w.provider.clone(), model: w.model.clone(), name });
        }
        let request: Option<String> = store
            .db
            .query_row("SELECT content FROM architect_requests WHERE parent_session_id=?1 AND worker_id=?2 AND kind='dispatch'", params![team.session_id, w.id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let replaced = request.and_then(|c| serde_json::from_str::<Value>(&c).ok()).and_then(|v| v["replaces"].as_str().map(String::from));
        next = replaced.and_then(|r| team.workers.iter().find(|x| x.id == r));
    }
    chain.reverse();
    Ok(Some(Chain { failed: chain, attempts }))
}

/// `failed_chain` for the workers this dispatch replaces (its `replaces` IDs), not the whole team.
pub(super) fn chains(store: &storage::Store, team: &TeamSnapshot, args: &Value) -> Result<Chains> {
    let mut chains = Chains::new();
    for id in args["assignments"].as_array().into_iter().flatten().filter_map(|a| a["replaces"].as_str()) {
        if let Some(chain) = failed_chain(store, team, id)? {
            chains.insert(id.to_string(), chain.failed);
        }
    }
    Ok(chains)
}

/// A dispatch's Council reviewers for `diversify`: routed reviewers' keys in order (a replacement that
/// inherits its lens included), and the models of reviewers staffed explicitly, which count as taken.
#[derive(Default)]
pub(crate) struct Reviewers {
    keys: Vec<String>,
    taken: Vec<(String, String)>,
}
fn reviewers(team: &TeamSnapshot, args: &Value) -> Reviewers {
    let mut out = Reviewers::default();
    let default = by_default(&team.config);
    for a in args["assignments"].as_array().into_iter().flatten() {
        let inherits = a["replaces"].as_str().is_some_and(|id| team.workers.iter().any(|w| w.id == id && w.council.is_some()));
        if team.config.council.is_none() || !(a["councilLens"].is_string() || inherits) {
            continue;
        }
        if routes(a, default) {
            out.keys.extend(a["key"].as_str().map(String::from));
        } else if let (Some(provider), Some(model)) = (a["provider"].as_str(), a["model"].as_str()) {
            out.taken.push((provider.into(), model.into()));
        } else if let Some(profile) = a["profileId"].as_str().and_then(|id| team.config.workers.iter().find(|p| p.id == id)) {
            out.taken.push((profile.provider.clone(), profile.model.clone()));
        }
    }
    out
}

/// The team's config, its checkout's main languages (cached per checkout), failed workers' chains and
/// the dispatch's reviewers, for routing.
pub(super) async fn team_context(app: &tauri::AppHandle, sid: &str, generation: u64, args: &Value) -> Result<(TeamConfig, Vec<String>, Chains, Reviewers)> {
    let (config, root, chains, reviewers) = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let team = load(&store, sid)?.ok_or("Team unavailable.")?;
        if !active(&team.status) || team.generation != generation {
            return Err("Team is no longer active.".into());
        }
        let lead = store.session(sid)?;
        let chains = chains(&store, &team, args)?;
        let reviewers = reviewers(&team, args);
        (team.config, store.workspace_root(&lead.project_id, Some(sid)).ok(), chains, reviewers)
    };
    let langs = match root {
        Some(root) => tokio::task::spawn_blocking(move || model_routing::repo_languages(&root)).await.unwrap_or_default(),
        None => Vec::new(),
    };
    Ok((config, langs, chains, reviewers))
}

/// Worker assignments run as tool-using coding agents in the team's checkout.
fn job(text: &str, files: usize, langs: &[String], failed: Vec<PoolModel>) -> Job {
    let text: String = text.chars().take(MAX_TASK_TEXT).collect();
    let files_in_scope = (files > 0).then(|| files.min(u32::MAX as usize) as u32);
    Job { text, ctx: TaskContext { files_in_scope, repo_languages: langs.to_vec(), requires_tools: true }, failed }
}

/// Whether a dispatch may ask for any routed worker (`default`: routing is on), so plain dispatches
/// skip the routing context.
pub(super) fn has_auto(args: &Value, default: bool) -> bool {
    args["assignments"].as_array().is_some_and(|a| a.iter().any(|a| routes(a, default)))
}

/// Keys and jobs for this dispatch's routed assignments (`by_default`: unchosen ones too); one that
/// `replaces` a worker escalates past every model whose result failed that assignment.
pub(super) fn auto_jobs(args: &Value, langs: &[String], chains: &Chains, default: bool) -> (Vec<String>, Vec<Job>) {
    args["assignments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| routes(a, default))
        .filter_map(|a| {
            let files = a["files"].as_array().map_or(0, Vec::len);
            let failed = a["replaces"].as_str().and_then(|id| chains.get(id)).cloned().unwrap_or_default();
            Some((a["key"].as_str()?.to_string(), job(a["prompt"].as_str()?, files, langs, failed)))
        })
        .unzip()
}

pub(super) fn auto_from(keys: Vec<String>, routes: Option<std::result::Result<Vec<Route>, String>>, mode: Mode) -> AutoRoutes {
    match routes {
        Some(Ok(routes)) => keys
            .into_iter()
            .zip(routes)
            .map(|(key, r)| {
                let route = AutoRoute { pick: r.pick, ladder: r.ladder, mode, decided_by: r.decided_by, failed: r.failed, pinned: None, difficulty: r.difficulty, category: r.category, profiler: r.profiler };
                (key, Ok(route))
            })
            .collect(),
        Some(Err(error)) => {
            eprintln!("Model routing failed: {error}");
            keys.into_iter().map(|key| (key, Err("routing failed"))).collect()
        }
        None => keys.into_iter().map(|key| (key, Err("routing is off"))).collect(),
    }
}

pub(super) async fn auto_routes(config: &TeamConfig, langs: &[String], chains: &Chains, reviewers: &Reviewers, args: &Value) -> AutoRoutes {
    let (keys, jobs) = auto_jobs(args, langs, chains, by_default(config));
    if keys.is_empty() {
        return AutoRoutes::default();
    }
    // One mode for routing and staffing, even if Settings changes it meanwhile.
    let mode = model_routing::mode();
    let mut routes = auto_from(keys, model_routing::route_jobs(pool(config), jobs, Some(mode)).await, mode);
    diversify(&reviewers.keys, reviewers.taken.clone(), &mut routes);
    routes
}

/// The rung a route opens on: Cheap keeps its contract (it must clear the minimum lower bound, else
/// the policy pick), Best and escalations take the policy's pick, and others take the first rung.
fn opening_rung<'a>(pinned: Option<&'a Routed>, failed: &[PoolModel], mode: Mode, ladder: &'a [Routed]) -> Option<&'a Routed> {
    match mode {
        _ if pinned.is_some() => pinned,
        _ if !failed.is_empty() => None,
        Mode::Quality => None,
        Mode::Cheapest => ladder.iter().find(|m| m.p_success_lower >= model_routing::min_p()),
        _ => ladder.first(),
    }
}

/// A council of one model is weak: a reviewer whose pick repeats a provider and model an earlier
/// reviewer in this batch took moves to the next unused entry of its ladder, and keeps the duplicate
/// if there is none. Weaker rungs come last, only where the route could open on them: never below
/// Cheap's minimum, and never for an escalation. `reviewers` are the batch's Council keys in order;
/// other routes are untouched.
pub(super) fn diversify(reviewers: &[String], mut taken: Vec<(String, String)>, routes: &mut AutoRoutes) {
    for key in reviewers {
        let Some(Ok(route)) = routes.get_mut(key) else { continue };
        let Some(current) = opening_rung(None, &route.failed, route.mode, &route.ladder).or(route.pick.as_ref()).cloned() else { continue };
        let free = |m: &&Routed| !taken.iter().any(|(provider, model)| *provider == m.provider && *model == m.model);
        let mut chosen = current.clone();
        if !free(&&current) {
            let at = route.ladder.iter().position(|m| m.card_id == current.card_id).map_or(0, |i| i + 1);
            let earlier = if route.failed.is_empty() { &route.ladder[..at] } else { &[] };
            let opens = |m: &&Routed| route.mode != Mode::Cheapest || m.p_success_lower >= model_routing::min_p();
            if let Some(next) = route.ladder[at..].iter().chain(earlier).filter(opens).find(free) {
                chosen = next.clone();
                route.pinned = Some(next.clone());
            }
        }
        taken.push((chosen.provider, chosen.model));
    }
}

fn money(usd: f64) -> String {
    if usd < 0.01 { format!("${usd:.4}") } else { format!("${usd:.2}") }
}

/// A model the user has not switched off and that is not paused after failures.
pub(super) fn usable(profile: &WorkerProfile) -> bool {
    model_routing::allowed(&profile.provider, &profile.model) && crate::model_health::is_healthy(&profile.provider, &profile.model)
}

/// The model a route staffs (`opening_rung`): a Council pin first; Cheap keeps its contract (the
/// opener must clear the minimum lower bound, else the policy pick); Best mode and escalations take
/// the policy's pick.
fn opener(route: &AutoRoute) -> Option<&Routed> {
    opening_rung(route.pinned.as_ref(), &route.failed, route.mode, &route.ladder)
}

/// The harness an assignment will run on, before staffing it, so only that catalog is looked up.
pub(super) fn planned_provider(config: &TeamConfig, lead: &storage::Session, key: &str, routes: &AutoRoutes) -> String {
    match routes.get(key) {
        Some(Ok(route)) if route.pick.is_some() => opener(route).or(route.pick.as_ref()).map(|m| m.provider.clone()).unwrap_or_default(),
        _ => unrouted(config, lead).provider,
    }
}

/// An unrouted assignment's model: the lead's own in an open auto team; otherwise the lead's
/// entry, else the first usable one, else the lead's own model. Its effort is the default.
fn unrouted(config: &TeamConfig, lead: &storage::Session) -> WorkerProfile {
    let own = || WorkerProfile {
        id: AUTO.into(),
        name: lead.model.clone(),
        provider: lead.provider.clone(),
        model: lead.model.clone(),
        reasoning_effort: lead.reasoning_effort.clone(),
    };
    if config.auto && !config.roster_only {
        return own();
    }
    let entries = || config.workers.iter().filter(|p| usable(p));
    entries().find(|p| p.provider == lead.provider && p.model == lead.model).or_else(|| entries().next()).cloned().unwrap_or_else(own)
}

/// Staffs a `profileId: "auto"` assignment, or the lead's own model when unrouted (a configured or named
/// team without the lead's usable model uses its first usable entry, else the lead's own model), and says which in one line. A fresh assignment
/// in Cheap or Balanced mode opens on the ladder's first (cheapest safe) rung and escalates from there;
/// Best mode and escalations take the policy's pick.
/// Returns the profile, the routing note, and how the effort was fitted to the model.
pub(super) fn staff(config: &TeamConfig, lead: &storage::Session, assignment: &Assignment, routes: &AutoRoutes) -> Result<(WorkerProfile, String, Option<String>)> {
    if assignment.provider.is_some() || assignment.model.is_some() {
        return Err("Use either profileId or provider and model, not both.".into());
    }
    let wanted = assignment.reasoning_effort.as_ref();
    let route = routes.get(&assignment.key).cloned().unwrap_or(Err("routing is off"));
    let reason = match &route {
        Ok(routed @ AutoRoute { pick: Some(policy), ladder, decided_by, failed, difficulty, category, profiler, .. }) => {
            let opener = opener(routed);
            let pick = opener.cloned().unwrap_or_else(|| policy.clone());
            let roster = config.workers.iter().find(|p| p.provider == pick.provider && p.model == pick.model);
            if config.roster_only && roster.is_none() {
                return Err("Panda Router picked a model outside this team.".into());
            }
            let (reasoning_effort, adjusted) = model_efforts::apply(&pick.provider, &pick.model, wanted, roster.and_then(|p| p.reasoning_effort.as_ref()));
            let label = if pick.name.contains('·') { pick.name.clone() } else { format!("{} · {}", pick.name, pick.provider) };
            // The keyword heuristic stands in while the profiler downloads; say so.
            let rough = if *profiler == "heuristic" { ", heuristic" } else { "" };
            // The rung the opener sits on (Cheap may skip rungs below min P).
            let rung = opener.and_then(|o| ladder.iter().position(|m| m.card_id == o.card_id)).map_or(1, |i| i + 1);
            let step = match opener {
                Some(first) if first.card_id != policy.card_id => format!("ladder {rung}/{}, opener; policy pick {}; ", ladder.len(), policy.name),
                Some(_) => format!("ladder {rung}/{}, opener; ", ladder.len()),
                None => String::new(),
            };
            let tier = pick.tier.map_or_else(String::new, |t| format!("tier {t:?}, "));
            let mut note = format!("routed: {label} ({step}{tier}P {:.2}, ~{}, difficulty {difficulty} {category}{rough})", pick.p_success, money(pick.est_cost_usd));
            if decided_by.starts_with("escalation") {
                let past: Vec<_> = failed.iter().map(|m| format!("{} · {}", m.name, m.provider)).collect();
                note.push_str(&format!(", {decided_by} past {}", past.join(", ")));
            }
            let profile = WorkerProfile {
                id: roster.map_or_else(|| AUTO.to_string(), |p| p.id.clone()),
                name: roster.map_or(pick.name, |p| p.name.clone()),
                provider: pick.provider,
                model: pick.model,
                reasoning_effort,
            };
            return Ok((profile, note, adjusted));
        }
        Ok(_) => "no rated model fits",
        Err(reason) => reason,
    };
    let profile = unrouted(config, lead);
    let (reasoning_effort, adjusted) = model_efforts::apply(&profile.provider, &profile.model, wanted, profile.reasoning_effort.as_ref());
    let note = format!("not routed ({reason}), using {} · {}", profile.name, profile.provider);
    Ok((WorkerProfile { reasoning_effort, ..profile }, note, adjusted))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RouteArgs {
    tasks: Vec<RouteTask>,
    #[serde(default)]
    mode: Option<Mode>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RouteTask {
    text: String,
    #[serde(default)]
    files: Option<u32>,
    #[serde(default)]
    failed: Vec<FailedModel>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FailedModel {
    provider: String,
    model: String,
}

/// The pool, jobs and mode of a route_models call.
pub(super) fn route_request(config: &TeamConfig, langs: &[String], args: Value) -> Result<(Vec<PoolModel>, Vec<Job>, Option<Mode>)> {
    let args: RouteArgs = serde_json::from_value(args).map_err(|e| format!("Invalid route_models arguments: {e}"))?;
    if args.tasks.is_empty() {
        return Err("Route at least one task.".into());
    }
    let pool = pool(config);
    let mut jobs = Vec::new();
    for task in args.tasks {
        text(&task.text, "Task text")?;
        if task.failed.iter().any(|f| !HARNESSES.contains(&f.provider.as_str()) || f.model.len() > 200) {
            return Err("Failed models need a known harness and a model ID under 200 bytes.".into());
        }
        let failed = task
            .failed
            .into_iter()
            .map(|f| {
                let name = pool.iter().find(|m| m.provider == f.provider && m.model == f.model).map_or_else(|| f.model.clone(), |m| m.name.clone());
                PoolModel { provider: f.provider, model: f.model, name }
            })
            .collect();
        jobs.push(job(&task.text, task.files.unwrap_or(0) as usize, langs, failed));
    }
    Ok((pool, jobs, args.mode))
}

/// Compact route_models output: pick and why, up to 3 alternatives, the first 4 rungs of the
/// escalation ladder, difficulty, category, unrated count, and which profiler ran ("heuristic" while
/// the ONNX profiler downloads). Past `PAGE_BYTES` every task drops its alternatives and ladder
/// (`trimmed`), and tasks that still do not fit are left out, last first (`omittedTasks`).
pub(super) fn route_summary(config: &TeamConfig, routes: &[Route]) -> Value {
    let model = |m: &Routed| {
        let mut entry = json!({"provider":m.provider,"model":m.model,"name":m.name,"pSuccess":(m.p_success * 100.0).round() / 100.0,"estCostUsd":(m.est_cost_usd * 10000.0).round() / 10000.0});
        if let Some(p) = config.workers.iter().find(|p| p.provider == m.provider && p.model == m.model) {
            entry["profileId"] = json!(p.id);
        }
        if let Some(tier) = m.tier {
            entry["tier"] = json!(tier);
        }
        if let Some(p) = m.tier_p {
            entry["tierP"] = json!((p * 100.0).round() / 100.0);
        }
        entry
    };
    let mut tasks: Vec<Value> = routes
        .iter()
        .map(|r| {
            let picked = r.pick.as_ref().map(|p| p.card_id.as_str());
            let alternatives: Vec<Value> = r.ranking.iter().filter(|m| Some(m.card_id.as_str()) != picked).take(3).map(model).collect();
            let ladder: Vec<Value> = r.ladder.iter().take(4).map(model).collect();
            json!({"pick":r.pick.as_ref().map(model),"decidedBy":r.decided_by,"alternatives":alternatives,"ladder":ladder,"difficulty":r.difficulty,"category":r.category,"unrated":r.unrated.len()})
        })
        .collect();
    let profiler = routes.first().map_or("heuristic", |r| r.profiler);
    let size = |task: &Value| serde_json::to_vec(task).map_or(PAGE_BYTES, |b| b.len() + 1);
    // Room for the fields around the tasks.
    let budget = PAGE_BYTES - 256;
    if tasks.iter().map(size).sum::<usize>() <= budget {
        return json!({"tasks": tasks, "profiler": profiler});
    }
    for task in &mut tasks {
        if let Some(task) = task.as_object_mut() {
            task.remove("alternatives");
            task.remove("ladder");
        }
    }
    let mut bytes = 0;
    // At least one, so a call always makes progress.
    let kept = tasks.iter().take_while(|task| { bytes += size(task); bytes <= budget }).count().max(1);
    let omitted = tasks.len() - kept;
    tasks.truncate(kept);
    let mut out = json!({"tasks": tasks, "profiler": profiler, "trimmed": true});
    if omitted > 0 {
        out["omittedTasks"] = json!(omitted);
    }
    out
}

pub(super) async fn route_models(config: &TeamConfig, langs: &[String], args: Value) -> Result<Value> {
    let (pool, jobs, mode) = route_request(config, langs, args)?;
    let routes = model_routing::route_jobs(pool, jobs, mode)
        .await
        .ok_or_else(|| format!("{} Choose models yourself.", model_routing::OFF))??;
    Ok(route_summary(config, &routes))
}

#[cfg(test)]
mod council_diversity_tests {
    use super::*;

    fn rung(provider: &str, model: &str) -> Routed {
        Routed { provider: provider.into(), model: model.into(), name: model.into(), card_id: format!("{provider}/{model}"), p_success: 0.9, p_success_lower: 0.9, est_cost_usd: 0.0, expected_cost_usd: 0.0, est_latency_ms: 0.0, tier: None, tier_p: None }
    }
    fn route(mode: Mode, pick: Routed, ladder: Vec<Routed>) -> std::result::Result<AutoRoute, &'static str> {
        Ok(AutoRoute { pick: Some(pick), ladder, mode, decided_by: "policy".into(), failed: vec![], pinned: None, difficulty: 1, category: "code".into(), profiler: "heuristic" })
    }
    fn pinned(routes: &AutoRoutes, key: &str) -> Option<String> {
        routes[key].as_ref().unwrap().pinned.as_ref().map(|m| m.card_id.clone())
    }
    fn diversify_all(keys: &[String], routes: &mut AutoRoutes) {
        diversify(keys, vec![], routes);
    }
    fn keys(names: &[&str]) -> Vec<String> {
        names.iter().map(|k| k.to_string()).collect()
    }

    #[test]
    fn reviewers_move_up_their_ladder_past_taken_models() {
        let ladder = vec![rung("a", "1"), rung("b", "2"), rung("c", "3")];
        let mut routes = AutoRoutes::new();
        for key in ["r1", "r2", "r3", "r4", "writer"] {
            routes.insert(key.into(), route(Mode::Balanced, rung("c", "3"), ladder.clone()));
        }
        diversify_all(&keys(&["r1", "r2", "r3", "r4"]), &mut routes);
        assert_eq!(pinned(&routes, "r1"), None, "the first keeps its pick");
        assert_eq!(pinned(&routes, "r2").as_deref(), Some("b/2"));
        assert_eq!(pinned(&routes, "r3").as_deref(), Some("c/3"));
        assert_eq!(pinned(&routes, "r4"), None, "nothing left: it keeps the duplicate");
        assert_eq!(pinned(&routes, "writer"), None, "other assignments are untouched");
    }

    #[test]
    fn explicitly_staffed_reviewers_count_as_taken() {
        let mut routes = AutoRoutes::new();
        routes.insert("r1".to_string(), route(Mode::Balanced, rung("a", "1"), vec![rung("a", "1"), rung("b", "2")]));
        diversify(&keys(&["r1"]), vec![("a".into(), "1".into())], &mut routes);
        assert_eq!(pinned(&routes, "r1").as_deref(), Some("b/2"));
    }

    #[test]
    fn a_replacement_that_inherits_its_lens_is_a_reviewer_and_explicit_ones_are_taken() {
        let mut team = crate::architect::new_team("lead".into(), TeamConfig {
            auto: false, roster_only: false, name: None,
            workers: vec![WorkerProfile { id: "fast".into(), name: "Fast".into(), provider: "codex".into(), model: "m".into(), reasoning_effort: None }],
            catalog: vec![], max_parallel: 0, max_rounds: 0, max_assignments: 0, workspace: "shared".into(), summary_limit: 0, lead_guidance: None,
            council: Some(Default::default()),
        });
        let mut old: crate::architect::Worker = serde_json::from_value(json!({"id":"old","sessionId":"s","name":"n","profileId":"auto","provider":"codex","model":"m","reasoningEffort":null,"status":"failed","assignment":"a","summary":"","error":null,"dependsOn":[],"files":[],"attempt":1,"createdAt":1,"updatedAt":1})).unwrap();
        old.council = Some(Default::default());
        team.workers.push(old);
        let args = json!({"assignments":[
            {"key":"again","profileId":"auto","replaces":"old"},
            {"key":"pinned","profileId":"fast","councilLens":"ux"},
            {"key":"direct","provider":"claude","model":"x","councilLens":"ux"},
            {"key":"writer","profileId":"auto"},
        ]});
        let found = reviewers(&team, &args);
        assert_eq!(found.keys, ["again"]);
        assert_eq!(found.taken, [("codex".to_string(), "m".to_string()), ("claude".to_string(), "x".to_string())]);
        team.config.council = None;
        assert!(reviewers(&team, &args).keys.is_empty());
    }

    #[test]
    fn the_same_model_on_another_harness_is_not_a_repeat() {
        let mut routes = AutoRoutes::new();
        routes.insert("r1".to_string(), route(Mode::Balanced, rung("a", "1"), vec![rung("a", "1")]));
        routes.insert("r2".to_string(), route(Mode::Balanced, rung("b", "1"), vec![rung("b", "1"), rung("c", "2")]));
        diversify_all(&keys(&["r1", "r2"]), &mut routes);
        assert_eq!(pinned(&routes, "r2"), None);
    }

    #[test]
    fn best_mode_falls_back_to_a_weaker_rung_but_an_escalation_does_not() {
        let ladder = vec![rung("a", "1"), rung("b", "2")];
        let mut routes = AutoRoutes::new();
        routes.insert("r1".to_string(), route(Mode::Quality, rung("b", "2"), ladder.clone()));
        routes.insert("r2".to_string(), route(Mode::Quality, rung("b", "2"), ladder.clone()));
        diversify_all(&keys(&["r1", "r2"]), &mut routes);
        assert_eq!(pinned(&routes, "r2").as_deref(), Some("a/1"));
        let mut routes = AutoRoutes::new();
        routes.insert("r1".to_string(), route(Mode::Quality, rung("b", "2"), ladder.clone()));
        let mut escalation = route(Mode::Quality, rung("b", "2"), ladder).unwrap();
        escalation.failed = vec![PoolModel { provider: "a".into(), model: "1".into(), name: "1".into() }];
        routes.insert("r2".to_string(), Ok(escalation));
        diversify_all(&keys(&["r1", "r2"]), &mut routes);
        assert_eq!(pinned(&routes, "r2"), None);
    }

    #[test]
    fn staffing_opens_on_the_pinned_rung() {
        let ladder = vec![rung("codex", "1"), rung("claude", "2")];
        let mut routes = AutoRoutes::new();
        routes.insert("r1".to_string(), route(Mode::Balanced, rung("codex", "1"), ladder.clone()));
        routes.insert("r2".to_string(), route(Mode::Balanced, rung("codex", "1"), ladder));
        diversify_all(&keys(&["r1", "r2"]), &mut routes);
        let route = routes["r2"].as_ref().unwrap();
        let open = opening_rung(route.pinned.as_ref(), &route.failed, route.mode, &route.ladder).unwrap();
        assert_eq!((open.provider.as_str(), open.model.as_str()), ("claude", "2"));
    }
}
