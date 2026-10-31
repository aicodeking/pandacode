//! Keyword profiler: port of upstream `heuristic.py`, used when the ONNX model is not installed.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use super::profile::{py_space, TaskProfile, N_CHECKLIST, N_DIFFICULTY, N_SKILL_LEVELS, SKILL_AXES};
use super::TaskContext;

fn rx(words: &[&str]) -> Regex {
    Regex::new(&format!(r"(?i)\b(?:{})", words.join("|"))).expect("heuristic regex")
}

struct Rules {
    category: Vec<Regex>, // CATEGORIES order
    hard: Regex,
    easy: Regex,
    tools: Regex,
    vision: Regex,
    web: Regex,
    long: Regex,
    multi: Regex,
    vague: Regex,
    security: Regex,
    stakes: Regex,
    criteria: Regex,
    concurrency: Regex,
    code_hint: Regex,
}

static RULES: LazyLock<Rules> = LazyLock::new(|| Rules {
    category: vec![
        rx(&["implement", "add (?:a |an |the )?(?:new )?(?:feature|endpoint|function|method|class|option|flag|support)",
             "build", "create", "write (?:a|an) (?:function|script|module|cli|service)", "support for"]),
        rx(&["fix", "bug", "error", "exception", "crash", "fails?", "failing", "broken", "traceback", "regression",
             "doesn'?t work", "not working", "stack ?trace", "segfault"]),
        rx(&["refactor", "clean ?up", "restructure", "rename", "extract", "simplify", "deduplicate",
             "split (?:up|into)", "migrate", "modernize"]),
        rx(&["unit tests?", "write tests?", "add tests?", "test coverage", "pytest", "jest", "integration tests?", "e2e"]),
        rx(&["review", "critique", "audit", "look over", "feedback on", "pull request", r"pr #?\d"]),
        rx(&["research", "investigate", "compare", "survey", "find out", "what are the options", "evaluate",
             "literature", "state of the art"]),
        rx(&["plan", "design doc", "roadmap", "architecture", "break (?:it )?down", "milestones", "strategy",
             "proposal", "rfc"]),
        rx(&["document", r"docs?\b", "readme", "docstring", "changelog", "write-?up", "tutorial", "blog post",
             "explain in writing"]),
        rx(&["ui", "frontend", "css", "react", "vue", "svelte", "tailwind", "component", "layout", "button", "page",
             "html", "responsive", "figma", "styling"]),
        rx(&["dataset", "csv", "dataframe", "pandas", "sql", "query", "metrics", "analy[sz]", "chart", "plot",
             "statistics", "aggregate", "etl"]),
        rx(&["deploy", "docker", "kubernetes", "k8s", "terraform", "ci/?cd", "pipeline", "github actions", "nginx",
             "helm", "aws", "gcp", "azure", "infra", "ansible"]),
        rx(&["prove", "proof", "theorem", "lemma", "integral", "derivative", "equation", "probability",
             "combinatori", "complexity of", "big-?o", "undecidab", "halting problem", "asymptotic"]),
        rx(&["what is", "what's", "who is", "hello", r"hi\b", "thanks", "define", "quick question", "tl;?dr",
             "summari[sz]e", "translate"]),
    ],
    hard: rx(&["race condition", "concurren", "distributed", "deadlock", "memory leak", "security", "crypto",
               "authenticat", "authori[sz]", "migration", "architecture", "performance", "optimi[sz]", "latency",
               "scal", "compiler", "kernel", "proof", "consensus", "lock-?free", "flaky", "intermittent",
               "root cause", "prove", "undecidab", "np-hard", "production", "zero-?downtime",
               "backward[s]? compat"]),
    easy: rx(&["typo", "rename", "one-?liner", "hello world", "simple", "trivial", "quick", "spelling",
               "bump (?:the )?version", "small change", "just ", "minor"]),
    tools: rx(&["run", "test", "repo", "file", "deploy", "install", "commit", "build", "execute", "terminal",
                "shell", "debug", "reproduce", r"ci\b"]),
    vision: rx(&["screenshot", "image", "png", "jpe?g", "figma", "mockup", "diagram", "picture", "attached design"]),
    web: rx(&["search the web", "browse", "look up", "latest", "online", "https?://", "google", "news"]),
    long: rx(&["entire (?:code ?base|repo)", "whole (?:code ?base|repo)", "large log", "huge file", "all files",
               "monorepo", "100k", "long document"]),
    multi: rx(&["across", "multiple files", "several files", "codebase-?wide", "every module", "all services"]),
    vague: rx(&["somehow", "something like", "make it better", "improve", "etc", "whatever", "nice", "clean"]),
    security: rx(&["security", "auth", "password", "secret", "token", "crypto", "permission", "oauth", "jwt", "xss",
                   "csrf", "injection"]),
    stakes: rx(&["production", r"prod\b", "customer", "payment", "billing", "data loss", "outage", "money"]),
    criteria: rx(&["should return", "must", "acceptance", "expected output", "so that", "passes?", "given .* when"]),
    concurrency: Regex::new(r"(?i)concurren|distributed|race condition|deadlock|lock-?free").expect("concurrency regex"),
    code_hint: Regex::new(r"(?i)`|\bdef |\bclass |\bfunction\b|\.py\b|\.ts\b|\.js\b|\.go\b|\.rs\b|\{|\}|=>|::")
        .expect("code hint regex"),
});

/// Per-category relevant skill axes with level offsets from the difficulty point estimate (CATEGORIES order).
const CATEGORY_AXES: [&[(&str, f64)]; 13] = [
    &[("coding", 0.0), ("planning", -2.0), ("debugging", -2.5), ("reasoning", -1.5)],
    &[("debugging", 0.0), ("coding", -1.0), ("reasoning", -1.0)],
    &[("coding", 0.0), ("review", -1.5), ("planning", -2.0)],
    &[("coding", -0.5), ("debugging", -2.0), ("review", -2.0)],
    &[("review", 0.0), ("coding", -1.5), ("reasoning", -1.5)],
    &[("research", 0.0), ("reasoning", -1.0), ("writing", -2.0)],
    &[("planning", 0.0), ("reasoning", -0.5), ("writing", -2.0)],
    &[("writing", 0.0), ("coding", -3.0), ("research", -3.0)],
    &[("ui_frontend", 0.0), ("coding", -1.0)],
    &[("data_analysis", 0.0), ("coding", -1.5), ("math", -2.5)],
    &[("coding", -0.5), ("debugging", -1.0), ("planning", -2.0)],
    &[("math", 0.0), ("reasoning", -0.5)],
    &[("writing", -1.0), ("reasoning", -1.5)],
];
const OUT_P50: [f64; 13] = [3.3, 3.0, 3.4, 3.3, 2.9, 3.1, 3.0, 3.1, 3.4, 3.0, 3.0, 2.9, 2.3];
const MATH: usize = 11;
const CHAT: usize = 12;
const IMPL: usize = 0;
const BUGFIX: usize = 1;
const REFACTOR: usize = 2;
const TESTS: usize = 3;
const REVIEW: usize = 4;
const RESEARCH: usize = 5;
const PLANNING: usize = 6;
const DOCS: usize = 7;
const UI: usize = 8;
const DATA: usize = 9;
const DEVOPS: usize = 10;

fn discrete_gaussian<const N: usize>(center: f64, sigma: f64, start: f64) -> [f64; N] {
    let mut w = [0.0; N];
    for (i, x) in w.iter_mut().enumerate() {
        *x = (-0.5 * ((start + i as f64 - center) / sigma).powi(2)).exp();
    }
    let s: f64 = w.iter().sum();
    w.map(|x| x / s)
}

fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

/// Python's `round(x, n)`: correctly rounded, half to even (Rust's float formatting rounds the same way).
pub(super) fn py_round(x: f64, n: usize) -> f64 {
    format!("{x:.n$}").parse().unwrap_or(x)
}

fn b(v: bool) -> f64 {
    if v { 1.0 } else { 0.0 }
}

pub fn profile(text: &str, ctx: &TaskContext) -> TaskProfile {
    let r = &*RULES;
    let words = text.split(py_space).filter(|w| !w.is_empty()).count();
    let files = ctx.files_in_scope.unwrap_or(0);
    let tokens = text.chars().count() / 4;
    let codey = r.code_hint.is_match(text) || !ctx.repo_languages.is_empty();

    // Category: keyword hits -> softmax.
    let mut raw = [0.0f64; 13];
    for (c, re) in r.category.iter().enumerate() {
        raw[c] += 2.0 * re.find_iter(text).count().min(3) as f64;
    }
    if raw.iter().all(|v| *v == 0.0) {
        raw[if codey { 0 } else { CHAT }] += 2.5;
    }
    if codey {
        raw[CHAT] -= 1.0;
    }
    let exps = raw.map(f64::exp);
    let z: f64 = exps.iter().sum();
    let cp = exps.map(|v| v / z);

    // Difficulty point estimate.
    let hard: HashSet<String> = r.hard.find_iter(text).map(|m| m.as_str().to_lowercase()).collect();
    let mut d = 3.0;
    d += b(words > 120) + b(words > 400);
    d += b(files > 3) + b(files > 10);
    d += b(tokens > 50_000);
    d += hard.len().min(3) as f64;
    d -= 1.5 * b(r.easy.is_match(text));
    d -= b(cp[CHAT] > 0.5);
    d += 0.5 * b(cp[MATH] > 0.4);
    let d = d.clamp(1.0, 10.0);
    let difficulty = discrete_gaussian::<N_DIFFICULTY>(d, 1.1, 1.0);

    let mut skills = [[0.0; N_SKILL_LEVELS]; 10];
    for (k, axis) in SKILL_AXES.iter().enumerate() {
        let mut lvl = 0.0;
        for (c, p) in cp.iter().enumerate() {
            if let Some((_, off)) = CATEGORY_AXES[c].iter().find(|(a, _)| a == axis) {
                lvl += p * (d + off).max(0.0);
            }
        }
        skills[k] = discrete_gaussian::<N_SKILL_LEVELS>(lvl.min(10.0), 1.2, 0.0);
    }

    let words_vague = (words < 8 && !codey) || r.vague.is_match(text);
    let flags = [
        if ctx.requires_tools { 0.95 } else { sigmoid(-1.0 + r.tools.find_iter(text).count() as f64 + b(codey)) },
        if r.vision.is_match(text) { 0.7 } else { 0.03 },
        if tokens > 100_000 { 0.95 } else if tokens > 50_000 || r.long.is_match(text) { 0.7 } else { 0.05 },
        (0.15 + 0.3 * b(r.security.is_match(text)) + 0.3 * b(r.stakes.is_match(text)) + 0.04 * (d - 5.0).max(0.0))
            .min(0.95),
        if words_vague { 0.7 } else { 0.15 },
        if files > 3 { 0.9 } else if r.multi.is_match(text) { 0.65 } else { 0.1 },
        if r.web.is_match(text) { 0.75 } else { 0.05 },
    ];

    // Taxonomy checklist order.
    let code_cats = cp[IMPL] + cp[BUGFIX] + cp[REFACTOR] + cp[TESTS] + cp[UI] + cp[DEVOPS];
    let checklist: [f64; N_CHECKLIST] = [
        (code_cats + 0.3 * b(codey)).min(0.98),
        flags[5],
        cp[IMPL] + 0.5 * cp[UI],
        cp[BUGFIX],
        cp[BUGFIX] * (0.4 + 0.1 * (d - 4.0).max(0.0)),
        flags[0],
        flags[6],
        flags[1],
        if tokens > 50_000 { 0.95 } else { 0.05 },
        if r.concurrency.is_match(text) { 0.8 } else { 0.05 },
        if r.security.is_match(text) { 0.8 } else { 0.05 },
        cp[MATH],
        if d >= 7.0 { 0.5 } else { 0.15 },
        if r.criteria.is_match(text) { 0.7 } else { 0.3 },
        flags[4] * 0.7,
        cp[PLANNING] + 0.3 * b(d >= 7.0),
        cp[UI],
        cp[DOCS] + cp[RESEARCH] * 0.6 + cp[CHAT] * 0.8 + cp[PLANNING] * 0.5,
        cp[DATA],
        cp[DEVOPS],
        (0.1 + 0.1 * (d - 4.0).max(0.0) + cp[PLANNING]).min(0.95),
        cp[REVIEW],
        if d <= 2.0 { 0.8 } else if d <= 3.0 { 0.3 } else { 0.05 },
        if r.stakes.is_match(text) { 0.7 } else { 0.1 },
    ]
    .map(|v| py_round(v.clamp(0.0, 1.0), 4));

    let p50: f64 = cp.iter().zip(OUT_P50).map(|(p, o)| p * o).sum::<f64>() + 0.08 * (d - 5.0);
    TaskProfile { category: cp, difficulty, skills, flags: flags.map(|v| py_round(v, 4)), checklist, out_p50: py_round(p50, 3) }
}

