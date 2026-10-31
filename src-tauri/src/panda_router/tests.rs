//! Parity with the Python reference (`data/parity.json`, dumped from PandaOrchestrator 83e408c (v4.3) by a
//! script kept outside the repo). ONNX tests need `PANDA_ROUTER_ASSETS` pointing at a directory with
//! model.int8.onnx + tokenizer.json and are skipped without it (they fail instead when `CI` is set). See `strict()` for numeric parity.

use std::path::PathBuf;
use std::time::Instant;

use serde::Deserialize;

use super::profile::{format_input, TaskProfile};
use super::*;

#[derive(Deserialize)]
struct Fixture {
    pool: Vec<String>,
    tasks: Vec<FixtureTask>,
}

#[derive(Deserialize)]
struct FixtureTask {
    text: String,
    context: FixtureContext,
    ids: Vec<u32>,
    onnx: FixtureProfile,
    heuristic: FixtureProfile,
    routes: FixtureRoutes,
}

#[derive(Deserialize, Default)]
struct FixtureContext {
    #[serde(default)]
    repo_languages: Vec<String>,
    files_in_scope: Option<u32>,
    #[serde(default)]
    requires_tools: bool,
}

#[derive(Deserialize)]
struct FixtureProfile {
    category: Vec<f64>,
    difficulty: Vec<f64>,
    skills: Vec<Vec<f64>>,
    flags: Vec<f64>,
    checklist: Vec<f64>,
    out_p50: f64,
}

#[derive(Deserialize)]
struct FixtureRoutes {
    onnx: ModeRoutes,
    heuristic: ModeRoutes,
}

#[derive(Deserialize)]
struct ModeRoutes {
    balanced: FixtureRoute,
    cheapest: FixtureRoute,
    cheapest75: FixtureRoute,
    quality: FixtureRoute,
    /// Two escalations from `balanced`: each fails the previous pick.
    escalate: Vec<FixtureRoute>,
}

#[derive(Deserialize)]
struct FixtureRoute {
    failed: Option<String>,
    pick: Option<String>,
    decided_by: String,
    difficulty: u8,
    category: String,
    distribution: Vec<f64>,
    ranking: Vec<FixtureRow>,
    ladder: Vec<String>,
}

/// Upstream rounds the response: p to 4 places, costs to 6, latency to 1.
#[derive(Deserialize)]
struct FixtureRow {
    id: String,
    p: f64,
    p_lo: f64,
    cost: f64,
    exp_cost: f64,
    latency: f64,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("data/parity.json")).expect("parity.json")
}

fn ctx(c: &FixtureContext) -> TaskContext {
    TaskContext { repo_languages: c.repo_languages.clone(), files_in_scope: c.files_in_scope, requires_tools: c.requires_tools }
}

fn card_model(id: &str) -> PoolModel {
    PoolModel { provider: "test".into(), model: id.into(), name: id.into() }
}

fn assets() -> Option<PathBuf> {
    if !crate::panda_router::ONNX_AVAILABLE {
        eprintln!("note: this target builds without ONNX Runtime; skipping ONNX parity tests");
        return None;
    }
    match std::env::var_os("PANDA_ROUTER_ASSETS") {
        Some(dir) => Some(PathBuf::from(dir)),
        // CI fetches the assets (.github/workflows/ci.yml); there a skip would hide a broken profiler.
        None if std::env::var_os("CI").is_some() => panic!("PANDA_ROUTER_ASSETS must be set in CI"),
        None => {
            eprintln!("note: PANDA_ROUTER_ASSETS is not set; skipping ONNX parity tests");
            None
        }
    }
}

fn close(label: &str, got: f64, want: f64, tol: f64) {
    assert!((got - want).abs() <= tol, "{label}: got {got}, want {want} (tol {tol})");
}

fn check_profile(label: &str, got: &TaskProfile, want: &FixtureProfile, tol: f64) {
    let pairs: [(&str, &[f64], &[f64]); 4] = [
        ("category", &got.category, &want.category),
        ("difficulty", &got.difficulty, &want.difficulty),
        ("flags", &got.flags, &want.flags),
        ("checklist", &got.checklist, &want.checklist),
    ];
    for (name, g, w) in pairs {
        assert_eq!(g.len(), w.len(), "{label} {name} length");
        for (i, (g, w)) in g.iter().zip(w).enumerate() {
            close(&format!("{label} {name}[{i}]"), *g, *w, tol);
        }
    }
    for (k, axis) in want.skills.iter().enumerate() {
        for (i, w) in axis.iter().enumerate() {
            close(&format!("{label} skills[{k}][{i}]"), got.skills[k][i], *w, tol);
        }
    }
    close(&format!("{label} out_p50"), got.out_p50, want.out_p50, tol);
}

/// `p_tol` on top of upstream's rounding (half a unit in the last kept place).
fn check_route(label: &str, got: &Route, want: &FixtureRoute, p_tol: f64) {
    assert_eq!(got.pick.as_ref().map(|r| r.card_id.as_str()), want.pick.as_deref(), "{label} pick");
    assert_eq!(got.decided_by, want.decided_by, "{label} decided_by");
    assert_eq!(got.difficulty, want.difficulty, "{label} difficulty");
    assert_eq!(got.category, want.category, "{label} category");
    let ids: Vec<&str> = got.ranking.iter().map(|r| r.card_id.as_str()).collect();
    let want_ids: Vec<&str> = want.ranking.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, want_ids, "{label} ranking");
    let ladder: Vec<&str> = got.ladder.iter().map(|r| r.card_id.as_str()).collect();
    assert_eq!(ladder, want.ladder, "{label} ladder");
    for (i, (g, w)) in got.distribution.iter().zip(&want.distribution).enumerate() {
        close(&format!("{label} distribution[{i}]"), *g, *w, 5e-7 + p_tol);
    }
    for (g, w) in got.ranking.iter().zip(&want.ranking) {
        close(&format!("{label} {} p", w.id), g.p_success, w.p, 5e-5 + p_tol);
        close(&format!("{label} {} p_lo", w.id), g.p_success_lower, w.p_lo, 5e-5 + p_tol);
        close(&format!("{label} {} cost", w.id), g.est_cost_usd, w.cost, 5e-7 + 1e-3 * w.cost);
        close(&format!("{label} {} expected cost", w.id), g.expected_cost_usd, w.exp_cost, 5e-7 + 1e-3 * w.exp_cost);
        close(&format!("{label} {} latency", w.id), g.est_latency_ms, w.latency, 0.05 + 1e-3 * w.latency);
    }
}

/// Numeric ONNX parity holds only on hardware whose int8 kernels match the machine that dumped the
/// fixture; another CPU (CI's runner) moves probabilities by up to ~0.2 and difficulty by a level.
/// `PANDA_ROUTER_STRICT=1` asks for it; otherwise ONNX tests check tokenizer ids exactly and that
/// profiles and routes are well formed. The matcher is pinned exactly by the heuristic tests.
fn strict() -> bool {
    std::env::var_os("PANDA_ROUTER_STRICT").is_some()
}

fn check_well_formed(label: &str, got: &TaskProfile) {
    close(&format!("{label} category sum"), got.category.iter().sum(), 1.0, 1e-6);
    close(&format!("{label} difficulty sum"), got.difficulty.iter().sum(), 1.0, 1e-6);
    assert!(got.flags.iter().chain(&got.checklist).all(|f| (0.0..=1.0).contains(f)), "{label} flags out of range");
}

fn check_routes(router: &Router, fx: &Fixture, pick: impl Fn(&FixtureRoutes) -> &ModeRoutes, p_tol: f64) {
    let pool: Vec<PoolModel> = fx.pool.iter().map(|id| card_model(id)).collect();
    for (n, task) in fx.tasks.iter().enumerate() {
        let routes = pick(&task.routes);
        let c = ctx(&task.context);
        let modes = [
            ("balanced", Mode::Balanced, 0.5, &routes.balanced),
            ("cheapest", Mode::Cheapest, 0.5, &routes.cheapest),
            ("cheapest75", Mode::Cheapest, 0.75, &routes.cheapest75),
            ("quality", Mode::Quality, 0.5, &routes.quality),
        ];
        for (name, mode, min_p, want) in modes {
            let got = router.route(&task.text, &c, &pool, &Preferences { mode, min_p }, &[], &Tiers::new()).unwrap();
            check_route(&format!("task {n} {name}"), &got, want, p_tol);
        }
        // The chain both ways: `escalate` step by step, and `route` with every failure at once.
        let prefs = Preferences::default();
        let mut prev = router.route(&task.text, &c, &pool, &prefs, &[], &Tiers::new()).unwrap();
        let mut failed = Vec::new();
        for (k, want) in routes.escalate.iter().enumerate() {
            let m = card_model(want.failed.as_deref().unwrap());
            prev = router.escalate(&task.text, &c, &pool, &prefs, &prev, std::slice::from_ref(&m), &Tiers::new()).unwrap();
            check_route(&format!("task {n} escalate {k}"), &prev, want, p_tol);
            failed.push(m);
            let all = router.route(&task.text, &c, &pool, &prefs, &failed, &Tiers::new()).unwrap();
            check_route(&format!("task {n} route failed={k}"), &all, want, p_tol);
        }
    }
}

#[test]
fn catalog_loads_every_card() {
    let catalog = cards::catalog().unwrap();
    assert_eq!(catalog.cards.len(), 156);
    assert!(catalog.by_id(matcher::DEFAULT_CARD).is_some());
}

#[test]
fn resolves_pandacode_models() {
    let cases = [
        (("claude", "opus", "Opus"), Some("claude-opus-5.5")),
        (("claude", "sonnet", "Sonnet"), Some("claude-sonnet-5.5")),
        (("claude", "haiku", "Haiku"), Some("claude-haiku-5.5")),
        (("claude", "fable", "Fable"), Some("claude-fable-5.1")),
        (("claude", "claude-haiku-4-5-20251001", "Haiku 4.5"), Some("claude-haiku-4.5")),
        (("claude", "default", "Default · Claude Opus 5.5 · Claude Code"), Some("claude-opus-5.5")),
        (("claude", "default", "Default"), None),
        (("codex", "gpt-6-luna", "GPT-6 Luna"), Some("codex-gpt-6-luna")),
        (("codex", "gpt-5.6-terra", "GPT-5.6 Terra"), Some("codex-gpt-5.6-terra")),
        (("codex", "gpt-5.6-luna", "GPT-5.6 Luna"), Some("codex-gpt-5.6-luna")),
        (("codex", "default", "Default · GPT-6 Luna · Codex"), Some("codex-gpt-6-luna")),
        (("kimi", "kimi-code/k3", "K3"), Some("kimi-k3")),
        (("kimi", "kimi-code/k3-256k", "K3 256k"), Some("kimi-k3")),
        (("kimi", "kimi-code/kimi-for-coding", "K2.7 Coding"), Some("kimi-k2.7-code")),
        (("kimi", "moonshot-ai/kimi-k3.1-pro", "Kimi K3.1 Pro"), Some("openrouter-kimi-k3.1-pro")),
        (("glm", "glm-5.1", "GLM-5.1"), Some("glm-5.1")),
        (("glm", "glm-5-turbo", "GLM-5-Turbo"), Some("glm-5-turbo")),
        (("glm", "glm-4.7", "GLM-4.7"), Some("glm-4.7")),
        (("glm", "glm-4.5-air", "GLM-4.5-Air"), Some("glm-4.5-air")),
        (("grok", "grok-4.6", "Grok 4.6"), Some("grok-4.6")),
        (("grok", "grok-4.5", "Grok 4.5"), Some("grok-4.5")),
        (("grok", "default", "Default"), None),
        (("muse", "muse-wonder-1.0", "Muse Wonder"), Some("muse-wonder-1.0")),
        (("muse", "muse-spark-1.3", "Muse Spark 1.3"), Some("openrouter-muse-spark-1.3")),
        (("kimi", "moonshot-ai/kimi-k3.1-pro-highspeed", "K3.1 Pro HS"), Some("kimi-k3.1-pro-highspeed")),
        (("opencode", "openrouter/deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"), Some("openrouter-deepseek-v4-flash")),
        (("opencode", "openrouter/qwen/qwen3.8-27b", "Qwen 3.8 27B"), Some("openrouter-qwen3.8-27b")),
        (("opencode", "ollama/qwen3.8:27b", "qwen3.8:27b"), Some("ollama-qwen3.8-27b")),
        (("pi", "gpt-oss:20b", "gpt-oss"), Some("ollama-gpt-oss-20b")),
        (("opencode", "qwen3.8-27b", "ambiguous"), None),
        (("opencode", "claude/sonnet-5-5", "loose"), Some("claude-sonnet-5.5")),
        (("opencode", "unknown/model-x", "nope"), None),
    ];
    for ((provider, model, name), want) in cases {
        assert_eq!(resolve_card(provider, model, name), want, "{provider} {model} {name}");
    }
}

#[test]
fn unrated_and_duplicate_pool_entries() {
    let pool = vec![
        PoolModel { provider: "claude".into(), model: "opus".into(), name: "Opus".into() },
        PoolModel { provider: "claude".into(), model: "default".into(), name: "Default · Claude Opus 5.5".into() },
        PoolModel { provider: "opencode".into(), model: "unknown/model-x".into(), name: "Mystery".into() },
    ];
    let route = Router::heuristic().route("Fix the bug", &TaskContext::default(), &pool, &Preferences::default(), &[], &Tiers::new()).unwrap();
    assert_eq!(route.unrated, vec![pool[2].clone()]);
    assert_eq!(route.ranking.len(), 1);
    assert_eq!(route.pick.unwrap().model, "opus");
    assert_eq!(route.profiler, "heuristic");
    let failed = [pool[0].clone()];
    let route = Router::heuristic().route("Fix the bug", &TaskContext::default(), &pool, &Preferences::default(), &failed, &Tiers::new()).unwrap();
    assert!(route.pick.is_none() && route.ranking.is_empty());
}

#[test]
fn heuristic_profiles_match_python() {
    let fx = fixture();
    for (n, task) in fx.tasks.iter().enumerate() {
        let got = heuristic::profile(&task.text, &ctx(&task.context));
        check_profile(&format!("task {n}"), &got, &task.heuristic, 2e-6);
    }
}

#[test]
fn heuristic_routes_match_python() {
    check_routes(&Router::heuristic(), &fixture(), |r| &r.heuristic, 0.0);
}

#[test]
fn load_rejects_wrong_checksum() {
    let dir = std::env::temp_dir().join(format!("panda-router-bad-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("model.int8.onnx"), b"not a model").unwrap();
    std::fs::write(dir.join("tokenizer.json"), b"{}").unwrap();
    let err = Router::load(&dir).err().unwrap();
    // Builds without ONNX Runtime refuse every load before reading files.
    assert!(err.contains("sha256") || !crate::panda_router::ONNX_AVAILABLE, "{err}");
    std::fs::remove_dir_all(&dir).ok();
    assert!(Router::load(&dir).is_err());
}

#[test]
fn onnx_matches_python() {
    let Some(dir) = assets() else { return };
    let router = Router::load(&dir).unwrap();
    assert!(router.is_onnx());
    let onnx = router.onnx.as_ref().unwrap();
    let fx = fixture();
    for (n, task) in fx.tasks.iter().enumerate() {
        let c = ctx(&task.context);
        let ids = onnx.token_ids(&format_input(&task.text, &c)).unwrap();
        assert_eq!(ids, task.ids, "task {n} token ids");
        let got = router.profile(&task.text, &c).unwrap();
        if strict() {
            check_profile(&format!("task {n}"), &got, &task.onnx, 1e-4);
        } else {
            check_well_formed(&format!("task {n}"), &got);
        }
    }
    if strict() {
        check_routes(&router, &fx, |r| &r.onnx, 1e-4);
        return;
    }
    let pool: Vec<PoolModel> = fx.pool.iter().map(|id| card_model(id)).collect();
    for task in &fx.tasks {
        let route = router.route(&task.text, &ctx(&task.context), &pool, &Preferences::default(), &[], &Tiers::new()).unwrap();
        assert!(route.pick.is_some() && (1..=10).contains(&route.difficulty));
    }
}

#[test]
fn onnx_routes_are_fast() {
    let Some(dir) = assets() else { return };
    let router = Router::load(&dir).unwrap();
    let fx = fixture();
    let pool: Vec<PoolModel> = fx.pool.iter().map(|id| card_model(id)).collect();
    let prefs = Preferences::default();
    let tasks: Vec<(String, TaskContext)> = fx.tasks.iter().map(|t| (t.text.clone(), ctx(&t.context))).collect();
    let mut times: Vec<f64> = Vec::new();
    for round in 0..3 {
        for (text, c) in &tasks {
            let t = Instant::now();
            router.route(text, c, &pool, &prefs, &[], &Tiers::new()).unwrap();
            if round > 0 {
                times.push(t.elapsed().as_secs_f64() * 1000.0);
            }
        }
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p50 = times[times.len() / 2];
    let max = times[times.len() - 1];
    let short = Instant::now();
    router.route("Rename a variable in utils.py", &TaskContext::default(), &pool, &prefs, &[], &Tiers::new()).unwrap();
    eprintln!(
        "panda router warm route latency: p50 {p50:.2} ms, max {max:.2} ms (512-token task), short task {:.2} ms",
        short.elapsed().as_secs_f64() * 1000.0
    );
}

#[test]
fn requires_tools_matches_python() {
    // Python (83e408c): format_input / HeuristicProfiler / OnnxProfiler on the same task.
    let c = TaskContext { repo_languages: vec!["rust".into(), "typescript".into()], files_in_scope: Some(3), requires_tools: true };
    assert_eq!(format_input("  Fix bug ", &c), "[ctx] langs=rust,typescript files_in_scope=3 requires_tools\n[task] Fix bug");
    let text = "Fix the flaky test in queue.rs and run the suite";
    let c = TaskContext { repo_languages: vec!["rust".into()], files_in_scope: Some(3), requires_tools: true };
    close("heuristic needs_tools", heuristic::profile(text, &c).flags[profile::FLAG_NEEDS_TOOLS], 0.95, 1e-12);
    let Some(dir) = assets() else { return };
    let got = Router::load(&dir).unwrap().profile(text, &c).unwrap();
    if strict() {
        close("onnx needs_tools", got.flags[profile::FLAG_NEEDS_TOOLS], 0.9952313216327713, 1e-4);
        close("onnx bugfix", got.category[1], 0.9209576043029076, 1e-4);
    } else {
        assert!(got.flags[profile::FLAG_NEEDS_TOOLS] > 0.5 && got.category[1] > 0.5, "tool-using bugfix");
    }
}

#[test]
fn tool_tasks_skip_models_without_tools() {
    let catalog = cards::catalog().unwrap();
    let toolless: Vec<&str> = catalog.cards.iter().filter(|c| !c.tools).map(|c| c.id.as_str()).collect();
    let Some(id) = toolless.first() else { return };
    let pool = vec![card_model(id), card_model("claude-sonnet-5.5")];
    let c = TaskContext { requires_tools: true, ..TaskContext::default() };
    let route = Router::heuristic().route("Write a haiku about autumn", &c, &pool, &Preferences::default(), &[], &Tiers::new()).unwrap();
    assert!(route.pick.is_some_and(|p| p.card_id == "claude-sonnet-5.5"));
}

#[test]
fn fuzzy_alias_needs_matching_version_digits() {
    // Misspelled, same digits: resolves (upstream difflib ratio > 0.75).
    assert_eq!(resolve_card("opencode", "claude-sonet-5.5", "x"), Some("claude-sonnet-5.5"));
    assert_eq!(resolve_card("opencode", "anthropic/claude-opsu-5-5", "x"), Some("claude-opus-5.5"));
    // Version near-misses never fuzz into another version.
    assert_eq!(resolve_card("opencode", "claude-sonnet-5.6", "x"), None);
    assert_eq!(resolve_card("opencode", "gpt-6.2-luna", "x"), None);
    // Size and speed tiers are other models, not misspellings.
    assert_eq!(resolve_card("opencode", "gpt-6-luna-mini", "x"), None);
    assert_eq!(resolve_card("opencode", "claude-sonet-5.5-flash", "x"), None);
    // A tier word inside another word is not a tier: "gemni" (gemini) still fuzzes.
    let gemini = cards::catalog().unwrap().cards.iter().find(|c| c.id.contains("gemini") && c.id.contains("flash")).map(|c| c.id.clone());
    if let Some(id) = gemini {
        let typo = id.replacen("gemini", "gemni", 1);
        assert_eq!(resolve_card("opencode", &typo, "x"), Some(id.as_str()));
    }
    assert!((cards::ratio("abcd", "bcde") - 0.75).abs() < 1e-12);
    assert!((cards::ratio("claudesonet55", "claudesonnet55") - 26.0 / 27.0).abs() < 1e-12);
}

#[test]
fn every_harness_map_entry_names_a_card() {
    let catalog = cards::catalog().unwrap();
    let map: Vec<serde_json::Value> = serde_json::from_str(include_str!("data/harness_map.json")).unwrap();
    for e in &map {
        assert!(catalog.by_id(e["card"].as_str().unwrap()).is_some(), "{e}");
    }
    let known = [
        ("claude", "sonnet"), ("codex", "gpt-6-luna"), ("kimi", "kimi-code/k3"), ("glm", "glm-5.1"), ("mimo", "mimo-v2.6-pro"),
        ("grok", "grok-4.7"), ("muse", "muse-wonder-1.0"), ("pi", "claude-sonnet-4-5"), ("omp", "claude-sonnet-4-5"),
        ("commandcode", "claude-sonnet-5-5"), ("cline", "cline-pass/kimi-k3"), ("opencode", "openrouter/deepseek/deepseek-v4-flash"),
        ("deepseek", r#"["deepseek-official","deepseek-v4-pro"]"#), ("deepseek", r#"["deepseek-official","deepseek-flash"]"#),
        ("antigravity", "gemini-3.1-pro"), ("github-copilot", "claude-sonnet-4.6"), ("github-copilot", "gpt-5.4"),
    ];
    for (provider, model) in known {
        assert!(resolve_card(provider, model, "").is_some(), "{provider} {model}");
    }
}


const MID_TASK: &str = "Refactor the session store so drafts and published tasks share one query path, update the callers in three modules and keep the tests passing.";

fn tiered(pairs: &[(&str, Tier)]) -> Tiers {
    pairs.iter().map(|(k, t)| (k.to_string(), *t)).collect()
}

fn route_mid(pool: &[PoolModel], mode: Mode, failed: &[PoolModel], tiers: &Tiers) -> Route {
    let c = TaskContext { requires_tools: true, files_in_scope: Some(3), ..TaskContext::default() };
    Router::heuristic().route(MID_TASK, &c, pool, &Preferences { mode, min_p: 0.5 }, failed, tiers).unwrap()
}

const WEAK: &str = "openrouter-qwen3.8-flash";
const STRONG: &str = "claude-opus-5.5";

fn tier_pool() -> Vec<PoolModel> {
    [WEAK, "claude-haiku-5.5", "claude-sonnet-5.5", STRONG].iter().map(|id| card_model(id)).collect()
}

fn flipped() -> Tiers {
    tiered(&[(WEAK, Tier::S), (STRONG, Tier::D)])
}

fn find<'a>(rows: &'a [Routed], id: &str) -> Option<&'a Routed> {
    rows.iter().find(|r| r.card_id == id)
}

#[test]
fn flipped_tiers_flip_pick_and_ladder() {
    let pool: Vec<PoolModel> = [WEAK, STRONG].iter().map(|id| card_model(id)).collect();
    for mode in [Mode::Balanced, Mode::Cheapest, Mode::Quality] {
        let plain = route_mid(&pool, mode, &[], &Tiers::new());
        let ranked = route_mid(&pool, mode, &[], &flipped());
        assert_eq!(plain.pick.as_ref().unwrap().card_id, STRONG, "{mode:?}");
        assert_eq!(plain.ladder[0].card_id, STRONG, "{mode:?}");
        assert_eq!(ranked.pick.as_ref().unwrap().card_id, WEAK, "{mode:?}");
        assert_eq!(ranked.ladder[0].card_id, WEAK, "{mode:?}");
        assert_eq!(ranked.pick.as_ref().unwrap().tier, Some(Tier::S));
        assert!(plain.pick.as_ref().unwrap().tier.is_none());
    }
}

#[test]
fn tiers_dominate_p_at_every_level_and_in_the_final_p() {
    let catalog = cards::catalog().unwrap();
    let profile = heuristic::profile(MID_TASK, &TaskContext::default());
    let demand = matcher::Demand::new(&profile);
    for card in [WEAK, STRONG] {
        let card = &catalog.cards[catalog.by_id(card).unwrap()];
        let (s, _) = demand.p_by_level(card, Some(Tier::S.ability()));
        let (d, _) = demand.p_by_level(card, Some(Tier::D.ability()));
        assert!(s.iter().zip(&d).all(|(s, d)| s > d), "{}: {s:?} vs {d:?}", card.id);
    }
    // The success head covers both cards, so the final P is the head's: the tier must still win it.
    assert!(success::HEAD.covers(WEAK) && success::HEAD.covers(STRONG));
    let plain = route_mid(&tier_pool(), Mode::Quality, &[], &Tiers::new());
    let ranked = route_mid(&tier_pool(), Mode::Quality, &[], &flipped());
    let p = |r: &Route, id: &str| find(&r.ranking, id).unwrap().p_success;
    assert!(p(&plain, STRONG) > p(&plain, WEAK));
    assert!(p(&ranked, WEAK) > p(&ranked, STRONG));
    assert!(p(&ranked, WEAK) > p(&plain, WEAK) && p(&ranked, STRONG) < p(&plain, STRONG));
    // Unranked cards keep exactly their P.
    for id in ["claude-haiku-5.5", "claude-sonnet-5.5"] {
        assert_eq!(p(&ranked, id), p(&plain, id), "{id}");
    }
}

#[test]
fn escalation_never_steps_down_by_tiered_strength() {
    let pool = tier_pool();
    let failed = [card_model(WEAK)];
    // Untiered, the strongest card is fair game after the weak one fails.
    let plain = route_mid(&pool, Mode::Balanced, &failed, &Tiers::new());
    assert!(find(&plain.ladder, STRONG).is_some() || plain.pick.as_ref().unwrap().card_id == STRONG);
    // Ranked S, the failed card sets a floor (0.7·8.9 + 0.3·6.59) that only Sonnet clears: Opus (D) and Haiku are below it.
    let ranked = route_mid(&pool, Mode::Balanced, &failed, &flipped());
    assert!(ranked.decided_by.starts_with("escalation"), "{}", ranked.decided_by);
    assert_eq!(ranked.pick.as_ref().unwrap().card_id, "claude-sonnet-5.5");
    assert!(ranked.ladder.iter().all(|r| r.card_id == "claude-sonnet-5.5"), "{:?}", ranked.ladder);
}

#[test]
fn ranked_unrated_models_get_a_synthetic_card() {
    let secret = PoolModel { provider: "opencode".into(), model: "acme/secret-1".into(), name: "Secret".into() };
    let mut pool: Vec<PoolModel> = [WEAK, "claude-haiku-5.5"].iter().map(|id| card_model(id)).collect();
    pool.push(secret.clone());
    pool.push(secret.clone());
    let plain = route_mid(&pool, Mode::Quality, &[], &Tiers::new());
    assert_eq!(plain.unrated, vec![secret.clone(), secret.clone()]);
    let tiers = tiered(&[("opencode/acme/secret-1", Tier::S)]);
    for mode in [Mode::Balanced, Mode::Quality] {
        let ranked = route_mid(&pool, mode, &[], &tiers);
        assert!(ranked.unrated.is_empty());
        assert_eq!(ranked.ranking.len(), 3);
        let row = find(&ranked.ranking, "opencode/acme/secret-1").unwrap();
        assert_eq!((row.model.as_str(), row.tier), ("acme/secret-1", Some(Tier::S)));
        // Without Haiku it beats the weak card outright.
        let duo = [pool[0].clone(), secret.clone()];
        assert_eq!(route_mid(&duo, mode, &[], &tiers).pick.unwrap().card_id, "opencode/acme/secret-1", "{mode:?}");
    }
    // It can fail and be escalated past like any rated model.
    let after = route_mid(&pool, Mode::Balanced, std::slice::from_ref(&secret), &tiers);
    assert_eq!(after.failed, vec![secret.clone()]);
    assert!(after.pick.is_none_or(|p| p.model != "acme/secret-1"));
}


const ALL_TIERS: [Tier; 5] = [Tier::S, Tier::A, Tier::B, Tier::C, Tier::D];

#[test]
fn ability_is_exactly_the_tier_blend() {
    let catalog = cards::catalog().unwrap();
    let demand = matcher::Demand::new(&heuristic::profile(MID_TASK, &TaskContext::default()));
    for id in [WEAK, "claude-haiku-5.5", STRONG] {
        let card = &catalog.cards[catalog.by_id(id).unwrap()];
        let (mu, sd) = demand.moments(card, None);
        for t in ALL_TIERS {
            let (tmu, tsd) = demand.moments(card, Some((t.ability(), tiers::TIER_WEIGHT)));
            assert!((tmu - (0.7 * t.ability() + 0.3 * mu)).abs() < 1e-12, "{id} {t:?}: {tmu} vs {mu}");
            assert_eq!(tsd, sd, "{id} {t:?}: a tier moves only the mean");
        }
    }
}

#[test]
fn final_p_is_exactly_the_tier_blend_on_route() {
    let pool = tier_pool();
    let plain = route_mid(&pool, Mode::Quality, &[], &Tiers::new());
    for t in ALL_TIERS {
        let ranked = route_mid(&pool, Mode::Quality, &[], &tiered(&[(WEAK, t), (STRONG, t)]));
        for row in &ranked.ranking {
            let v4 = find(&plain.ranking, &row.card_id).unwrap().p_success;
            match row.tier_p {
                Some(tp) => assert!((row.p_success - (0.7 * tp + 0.3 * v4)).abs() < 1e-12, "{} {t:?}", row.card_id),
                None => assert_eq!(row.p_success, v4, "{}", row.card_id),
            }
            assert_eq!(row.tier_p.is_some(), [WEAK, STRONG].contains(&row.card_id.as_str()));
        }
    }
}

#[test]
fn a_strong_unranked_card_still_beats_a_weaker_s_card() {
    // An S rank puts Sonnet at S ability, but on this task S's P (head scale) is below Opus's own P,
    // so the rank lifts Sonnet without overtaking a stronger unranked card: ranks are not overrides.
    let pool: Vec<PoolModel> = [STRONG, "claude-sonnet-5.5"].iter().map(|id| card_model(id)).collect();
    let plain = route_mid(&pool, Mode::Balanced, &[], &Tiers::new());
    let ranked = route_mid(&pool, Mode::Balanced, &[], &tiered(&[("claude-sonnet-5.5", Tier::S)]));
    let p = |r: &Route, id: &str| find(&r.ranking, id).unwrap().p_success;
    assert!(p(&ranked, "claude-sonnet-5.5") > p(&plain, "claude-sonnet-5.5"));
    assert_eq!(p(&ranked, STRONG), p(&plain, STRONG));
    for mode in [Mode::Balanced, Mode::Cheapest, Mode::Quality] {
        assert_eq!(route_mid(&pool, mode, &[], &tiered(&[("claude-sonnet-5.5", Tier::S)])).pick.unwrap().card_id, STRONG, "{mode:?}");
    }
}

#[test]
fn cheap_mode_prefers_a_costly_s_over_a_cheap_d() {
    let cheap = "claude-haiku-5.5";
    let pool: Vec<PoolModel> = [cheap, STRONG].iter().map(|id| card_model(id)).collect();
    let c = TaskContext { requires_tools: true, files_in_scope: Some(3), ..TaskContext::default() };
    let tiers = tiered(&[(cheap, Tier::D), (STRONG, Tier::S)]);
    let route = |min_p: f64, t: &Tiers| Router::heuristic().route(MID_TASK, &c, &pool, &Preferences { mode: Mode::Cheapest, min_p }, &[], t).unwrap();
    let r = route(0.3, &tiers);
    let pick = r.pick.as_ref().unwrap();
    assert_eq!((pick.card_id.as_str(), r.decided_by.as_str()), (STRONG, "policy:cheapest_above_threshold"));
    assert!(pick.p_success_lower >= 0.3 && find(&r.ranking, cheap).unwrap().p_success_lower < 0.3);
    assert!(find(&r.ranking, cheap).unwrap().est_cost_usd < pick.est_cost_usd);
    // At a bar the cheap card clears unranked, its D rank alone hands the pick to the S card.
    assert_eq!(route(0.25, &Tiers::new()).pick.unwrap().card_id, cheap);
    assert_eq!(route(0.25, &tiers).pick.unwrap().card_id, STRONG);
}

#[test]
fn escalate_matches_route_under_ranks() {
    let pool = tier_pool();
    let c = TaskContext { requires_tools: true, files_in_scope: Some(3), ..TaskContext::default() };
    let prefs = Preferences::default();
    let tiers = tiered(&[(WEAK, Tier::S), (STRONG, Tier::D), ("claude-haiku-5.5", Tier::B)]);
    let router = Router::heuristic();
    let mut prev = router.route(MID_TASK, &c, &pool, &prefs, &[], &tiers).unwrap();
    let mut failed = Vec::new();
    while let Some(p) = prev.pick.clone() {
        let m = PoolModel { provider: p.provider, model: p.model, name: p.name };
        prev = router.escalate(MID_TASK, &c, &pool, &prefs, &prev, std::slice::from_ref(&m), &tiers).unwrap();
        failed.push(m);
        let all = router.route(MID_TASK, &c, &pool, &prefs, &failed, &tiers).unwrap();
        let ids = |r: &Route| (r.pick.as_ref().map(|p| p.card_id.clone()), r.ladder.iter().map(|x| x.card_id.clone()).collect::<Vec<_>>());
        assert_eq!(ids(&prev), ids(&all), "after {} failed", failed.len());
        assert_eq!(prev.decided_by, all.decided_by);
        let ps = |r: &Route| r.ranking.iter().map(|x| (x.p_success, x.tier_p)).collect::<Vec<_>>();
        assert_eq!(ps(&prev), ps(&all));
    }
    assert_eq!(failed.len(), pool.len(), "every model was tried once");
    assert_eq!(failed[0].model, WEAK, "the S rank opens");
}

#[test]
fn synthetic_only_pools_route_with_a_stable_cost() {
    let unknown = |m: &str| PoolModel { provider: "opencode".into(), model: m.into(), name: m.into() };
    let pool = vec![unknown("acme/one"), unknown("acme/two")];
    let tiers = tiered(&[("opencode/acme/one", Tier::C), ("opencode/acme/two", Tier::S)]);
    let r = route_mid(&pool, Mode::Balanced, &[], &tiers);
    assert!(r.unrated.is_empty() && r.ranking.len() == 2);
    assert_eq!(r.pick.as_ref().unwrap().card_id, "opencode/acme/two");
    let cost = r.pick.as_ref().unwrap().est_cost_usd;
    assert!(cost > 0.0);
    let (_, cin, cout) = tiers::catalog_medians();
    assert!(cin > 0.0 && cout > 0.0);
    // Toggling unrelated rated models never moves a synthetic card's cost.
    for extra in [vec![WEAK], vec![STRONG], vec![WEAK, "claude-haiku-5.5", STRONG]] {
        let mut more = pool.clone();
        more.extend(extra.iter().map(|id| card_model(id)));
        let r = route_mid(&more, Mode::Quality, &[], &tiers);
        assert_eq!(find(&r.ranking, "opencode/acme/two").unwrap().est_cost_usd, cost, "{extra:?}");
    }
    // Both fail: nothing left.
    let after = route_mid(&pool, Mode::Balanced, &pool, &tiers);
    assert!(after.pick.is_none());
}

#[test]
fn legacy_provider_model_tiers_apply_to_rated_cards() {
    let first = card_model("claude-sonnet-5.5");
    let second = PoolModel { provider: "opencode".into(), model: "anthropic/claude-sonnet-5.5".into(), name: "Sonnet".into() };
    assert_eq!(resolve_card(&second.provider, &second.model, &second.name), Some("claude-sonnet-5.5"));
    let pool = vec![first.clone(), second.clone()];
    let tier_of = |t: &Tiers| route_mid(&pool, Mode::Quality, &[], t).ranking[0].tier;
    assert_eq!(tier_of(&Tiers::new()), None);
    // Saved under either entry's old key, even the duplicate's.
    assert_eq!(tier_of(&tiered(&[("test/claude-sonnet-5.5", Tier::A)])), Some(Tier::A));
    assert_eq!(tier_of(&tiered(&[("opencode/anthropic/claude-sonnet-5.5", Tier::B)])), Some(Tier::B));
    // The card-id tier wins over an old key.
    assert_eq!(tier_of(&tiered(&[("claude-sonnet-5.5", Tier::D), ("test/claude-sonnet-5.5", Tier::S)])), Some(Tier::D));
}
