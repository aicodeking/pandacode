//! Checks the engine against ripgrep and measures it. The repository-wide checks and the
//! benchmark are ignored by default (they need `rg` on PATH, and the benchmark takes a while on
//! a big repo); `temp_repo_matches_rg_when_it_is_installed` always runs and passes without `rg`.
use super::{
    grep::{run_jobs, Job, Kind, Scope},
    index::{walk, Policy, Snapshot},
    limit::Limit,
    plan,
    tests::hits,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::Instant,
};

const EXCLUDED_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "coverage", ".next", ".nuxt", ".svelte-kit", ".venv", "venv", "__pycache__", ".turbo", ".cache", ".parcel-cache", ".gradle", "Pods", "DerivedData"];
/// Definitions the plain `rg` count finds and extraction does not, on this repository. For
/// TypeScript all 7 today are `function` text inside template strings in specs, rightly skipped.
const MISS_CEILING_RUST: usize = 0;
const MISS_CEILING_TS: usize = 10;
const PATTERNS: &[&str] = &[
    "fn main",
    "with_design",
    "TODO",
    "export function",
    "useState",
    "PandaCode",
    r"pub\(crate\) fn \w+",
    r"\bimport\b.*\bfrom\b",
    r"[A-Z][a-z]+Error",
    r"^\s*#\[derive",
    r"foo|bar|baz",
    r"\d{4}-\d{2}-\d{2}",
    "é",
    "^$",
    "ab",
    r"\s+$",
    r"zzz_no_such_token_anywhere",
    r"^fn ",
    r"\)$",
];

fn limit() -> Limit {
    Limit::new(Arc::default())
}

/// Whether `rg` can run. In CI it must: a silently skipped oracle proves nothing.
fn rg_available() -> bool {
    let found = Command::new("rg").arg("--version").output().is_ok();
    assert!(found || std::env::var_os("CI").is_none(), "CI must install ripgrep for the explore oracle");
    found
}

fn this_repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn rg_command(root: &Path, pattern: &str, output: &str) -> Command {
    let mut command = Command::new("rg");
    command.current_dir(root).stdin(Stdio::null()).args([output, "--no-config", "--hidden", "--smart-case", "--no-messages", "--max-filesize", "1048576", "--max-depth", "48", "--encoding", "none"]);
    for name in [".git", ".hg", ".svn"] {
        command.arg("-g").arg(format!("!{name}"));
    }
    for dir in EXCLUDED_DIRS {
        command.arg("-g").arg(format!("!{dir}/"));
    }
    command.arg("--").arg(pattern).arg("./");
    command
}

fn rg_hits(root: &Path, pattern: &str) -> BTreeSet<(String, usize)> {
    let output = rg_command(root, pattern, "--json").stdout(Stdio::piped()).output().expect("rg runs");
    let mut found = BTreeSet::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else { continue };
        if event["type"] != "match" {
            continue;
        }
        let Some(path) = event["data"]["path"]["text"].as_str() else { continue };
        found.insert((path.trim_start_matches("./").to_owned(), event["data"]["line_number"].as_u64().unwrap() as usize));
    }
    found
}

/// What the engine leaves out on purpose: secret-looking paths, and whole files holding a NUL
/// (rg reports the lines before the NUL, then stops).
fn engine_scope(root: &Path, found: BTreeSet<(String, usize)>) -> BTreeSet<(String, usize)> {
    let mut binary = std::collections::HashMap::new();
    found
        .into_iter()
        .filter(|(path, _)| {
            !crate::workspace::secret_path(path, false) && !*binary.entry(path.clone()).or_insert_with(|| std::fs::read(root.join(path)).map_or(true, |bytes| bytes.contains(&0)))
        })
        .collect()
}

#[test]
#[ignore = "needs rg"]
fn explore_matches_rg() {
    assert!(rg_available(), "needs rg");
    let root = std::env::var("PANDACODE_BENCH_ROOT").map_or_else(|_| this_repo(), PathBuf::from).canonicalize().unwrap();
    let mut failures = Vec::new();
    for pattern in PATTERNS {
        let expected = engine_scope(&root, rg_hits(&root, pattern));
        for policy in [Policy::NeverIndex, Policy::AlwaysIndex] {
            let found = hits(&root, pattern, policy);
            if found != expected {
                let missing: Vec<_> = expected.difference(&found).take(5).collect();
                let extra: Vec<_> = found.difference(&expected).take(5).collect();
                failures.push(format!("{pattern} {policy:?}: rg {} engine {} missing {missing:?} extra {extra:?}", expected.len(), found.len()));
            }
        }
        println!("{pattern}: {} hits", expected.len());
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn temp_repo_matches_rg_when_it_is_installed() {
    if !rg_available() {
        return;
    }
    let root = std::env::temp_dir().join(format!("pandacode-explore-rg-{}", uuid::Uuid::new_v4().simple()));
    let write = |path: &str, content: &[u8]| {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    };
    write(".git/HEAD", b"ref");
    write(".gitignore", b"ignored.txt\n");
    write("ignored.txt", b"needle\n");
    write("a.rs", "fn needle() {}\nNeedle\n\n  \r\nfoo\r\nend without newline needle".as_bytes());
    write("latin1.txt", b"caf\xe9 needle\n");
    write("unicode.txt", "ta\u{17F}\u{212A} héllo\nÉTÉ été\n".as_bytes());
    write("target/skip.rs", b"needle\n");
    write("sub/.gitignore", b"*.gen\n");
    write("sub/x.gen", b"needle\n");
    write("sub/y.rs", b"needle bar\nbaz\n");
    let canonical = root.canonicalize().unwrap();
    for pattern in ["needle", "Needle", "task", "héllo", "été", r"\s+$", "^$", "foo$", r"[^a]", r"bar\s*baz", "(?i)NEEDLE", r"\xe9"] {
        let expected = engine_scope(&canonical, rg_hits(&canonical, pattern));
        assert_eq!(hits(&canonical, pattern, Policy::NeverIndex), expected, "scan {pattern}");
        assert_eq!(hits(&canonical, pattern, Policy::AlwaysIndex), expected, "index {pattern}");
    }
    std::fs::remove_dir_all(root).unwrap();
}

// Absolute anchors are checked against the engine's per-line contract separately: rg 13.0.0
// and 15.2.0 disagree on `\Afoo` in the fixture above, depending on search optimizations.
// They are therefore not a portable oracle for `\A`/`\z`; ordinary patterns still use rg.
#[test]
fn absolute_anchors_match_each_line() {
    let root = std::env::temp_dir().join(format!("pandacode-explore-anchors-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.rs"), b"needle\nfoo\r\nneedle").unwrap();
    let canonical = root.canonicalize().unwrap();
    let cases: &[(&str, &[usize])] = &[
        (r"\Aneedle", &[1, 3]),
        (r"needle\z", &[1, 3]),
        (r"\Aneedle\z", &[1, 3]),
        (r"\Afoo", &[2]),
        (r"foo\z", &[]),
        (r"foo\r\z", &[2]),
    ];
    for &(pattern, lines) in cases {
        let expected = lines.iter().map(|&line| ("a.rs".to_owned(), line)).collect::<BTreeSet<_>>();
        for policy in [Policy::NeverIndex, Policy::AlwaysIndex] {
            assert_eq!(hits(&canonical, pattern, policy), expected, "{policy:?} {pattern}");
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}

/// Compares definitions with a plain `rg` count, and checks each block ends on a closing line.
/// This module's own tests hold definition-shaped text inside strings, so they are left out.
#[test]
#[ignore = "needs rg"]
fn symbol_accuracy() {
    assert!(rg_available(), "needs rg");
    let root = this_repo();
    let reply = super::run(&root, &json!({"symbols":["connectClick","webLink"]})).unwrap();
    for at in [0, 1] {
        assert!(reply["symbols"][at]["definitions"].as_u64().unwrap() > 0, "{reply}");
    }
    let languages = [
        ("rs", "fn", r"^\s*(pub(\([^)]*\))?\s+)?(const\s+)?(async\s+)?(unsafe\s+)?fn\s+\w+", MISS_CEILING_RUST),
        ("ts", "function", r"^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*\w+", MISS_CEILING_TS),
    ];
    let own = |path: &str| path.contains("src/explore");
    for (extension, kind, pattern, ceiling) in languages {
        let suffix = format!(".{extension}");
        let expected: BTreeSet<_> = engine_scope(&root, rg_hits(&root, pattern)).into_iter().filter(|(path, _)| path.ends_with(&suffix) && !own(path)).collect();
        let (mut found, mut closed, mut bodied) = (BTreeSet::new(), 0usize, 0usize);
        for file in walk(&root, false, &limit()).files.iter().filter(|file| file.path.ends_with(&suffix) && !own(&file.path)) {
            let Ok(text) = std::fs::read_to_string(root.join(&*file.path)) else { continue };
            let lines: Vec<&str> = text.lines().collect();
            for symbol in super::symbols::extract(&file.path, &text, &limit()).into_iter().filter(|symbol| symbol.kind == kind) {
                found.insert((file.path.to_string(), symbol.line));
                if symbol.end > symbol.line {
                    bodied += 1;
                    closed += usize::from(lines[symbol.end - 1].contains('}'));
                }
            }
        }
        let missed: Vec<_> = expected.difference(&found).cloned().collect();
        println!("{extension}: rg {} extracted {} missed {} multi-line blocks {bodied} closed {closed}", expected.len(), found.len(), missed.len());
        assert!(missed.len() <= ceiling, "{extension}: missed {}: {:?}", missed.len(), &missed[..missed.len().min(20)]);
        assert!(closed * 100 >= bodied * 99, "{extension}: only {closed} of {bodied} blocks end on a closing line");
    }
}

fn percentile(samples: &mut [f64], at: f64) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[((samples.len() - 1) as f64 * at).round() as usize]
}

fn timing(mut samples: Vec<f64>) -> Value {
    let (p50, p90) = (percentile(&mut samples, 0.5), percentile(&mut samples, 0.9));
    json!({"p50": (p50 * 10.0).round() / 10.0, "p90": (p90 * 10.0).round() / 10.0})
}

fn ms(work: impl FnOnce()) -> f64 {
    let started = Instant::now();
    work();
    started.elapsed().as_secs_f64() * 1000.0
}

fn engine_query(root: &Path, pattern: &str, policy: Policy) -> usize {
    let compiled = plan::compile(pattern, false).unwrap();
    let jobs = [Job { pattern: compiled, kind: Kind::Search { context: 0 } }];
    let limit = limit();
    let snapshot = Snapshot::open(root, policy, false, &limit);
    let scope = Scope { allows: &|_| true, named_large: Vec::new() };
    run_jobs(root, &snapshot, &jobs, &scope, &limit).jobs[0].matched_lines
}

fn resident_kib() -> f64 {
    let output = Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().unwrap();
    String::from_utf8_lossy(&output.stdout).trim().parse().unwrap_or(0.0)
}

#[test]
#[ignore = "benchmark"]
fn explore_bench() {
    let root = std::env::var("PANDACODE_BENCH_ROOT").map_or_else(|_| this_repo(), PathBuf::from).canonicalize().unwrap();
    let rounds: usize = std::env::var("PANDACODE_BENCH_ROUNDS").ok().and_then(|n| n.parse().ok()).unwrap_or(7);
    let walked = walk(&root, false, &limit());
    let files = walked.files.len();
    let walk_ms: Vec<f64> = (0..rounds).map(|_| ms(|| { walk(&root, false, &limit()); })).collect();
    let before = resident_kib();
    let mut snapshot = None;
    let build_ms = ms(|| snapshot = Some(Snapshot::open(&root, Policy::AlwaysIndex, false, &limit())));
    let snapshot = snapshot.unwrap();
    let (indexed_files, trigrams) = snapshot.index_shape();
    let table_bytes = snapshot.memory_bytes();
    let after = resident_kib();
    let refresh_ms: Vec<f64> = (0..rounds).map(|_| ms(|| { Snapshot::open(&root, Policy::AlwaysIndex, false, &limit()); })).collect();
    let mut patterns = Vec::new();
    for pattern in PATTERNS {
        let rg: Vec<f64> = (0..rounds).map(|_| ms(|| { rg_command(&root, pattern, "--count").stdout(Stdio::null()).status().unwrap(); })).collect();
        let scan: Vec<f64> = (0..rounds).map(|_| ms(|| { engine_query(&root, pattern, Policy::NeverIndex); })).collect();
        let index: Vec<f64> = (0..rounds).map(|_| ms(|| { engine_query(&root, pattern, Policy::AlwaysIndex); })).collect();
        patterns.push(json!({"pattern": pattern, "rg_ms": timing(rg), "scan_ms": timing(scan), "index_ms": timing(index)}));
    }
    let symbol_args = json!({"symbols":["with_design","main","Editor"]});
    let symbol_ms: Vec<f64> = (0..rounds).map(|_| ms(|| { super::run_with(&root, &symbol_args, false, limit(), Policy::AlwaysIndex).unwrap(); })).collect();
    let batch_args = json!({"search":["fn main","TODO","useState","export function",r"\d{4}-\d{2}-\d{2}"],"symbols":["main"],"context":1});
    let batch_ms: Vec<f64> = (0..rounds).map(|_| ms(|| { super::run_with(&root, &batch_args, false, limit(), Policy::Auto).unwrap(); })).collect();
    let batch_reply = super::run_with(&root, &batch_args, false, limit(), Policy::Auto).unwrap();
    println!("{}", serde_json::to_string_pretty(&json!({
        "reply_bytes": batch_reply.to_string().len(),
        "coverage_bytes": batch_reply["coverage"].to_string().len(),
        "root": root.file_name().map(|n| n.to_string_lossy().into_owned()),
        "files": files,
                "skipped_secret": walked.secret.count,
        "skipped_large": walked.large.count,
        "walk_ms": timing(walk_ms),
        "index": {
            "built": snapshot.indexed(),
            "build_ms": build_ms.round(),
            "files": indexed_files,
            "trigrams": trigrams,
            "table_mib": table_bytes as f64 / 1_048_576.0,
            "rss_growth_mib": (after - before) / 1024.0,
            "refresh_ms": timing(refresh_ms),
        },
        "symbols_ms": timing(symbol_ms),
        "batch_auto_ms": timing(batch_ms),
        "patterns": patterns,
    })).unwrap());
}

/// Replays recorded tool calls for `scripts/agent-bench/replay.mjs`: each line of
/// `PANDACODE_REPLAY_IN` is one call's arguments, run in order in this one process, as the
/// benchmark's server did, against `PANDACODE_REPLAY_ROOT`. Each output line holds the reply
/// text exactly as the MCP host sends it, and the call's time.
#[test]
#[ignore = "driven by scripts/agent-bench/replay.mjs"]
fn explore_replay() {
    let root = PathBuf::from(std::env::var("PANDACODE_REPLAY_ROOT").expect("PANDACODE_REPLAY_ROOT"));
    let input = std::fs::read_to_string(std::env::var("PANDACODE_REPLAY_IN").expect("PANDACODE_REPLAY_IN")).unwrap();
    // The model's own time between calls, in which a background index build can finish.
    let gap = std::time::Duration::from_millis(std::env::var("PANDACODE_REPLAY_GAP_MS").ok().and_then(|ms| ms.parse().ok()).unwrap_or(0));
    let mut lines = Vec::new();
    for (at, call) in input.lines().filter(|line| !line.trim().is_empty()).enumerate() {
        if at > 0 {
            std::thread::sleep(gap);
        }
        let args: Value = serde_json::from_str(call).unwrap();
        let started = Instant::now();
        let reply = super::run(&root, &args);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        let (text, error) = match reply {
            Ok(value) => (serde_json::to_string(&value).unwrap(), false),
            Err(error) => (error, true),
        };
        lines.push(json!({"ms": ms, "error": error, "text": text}).to_string());
    }
    std::fs::write(std::env::var("PANDACODE_REPLAY_OUT").expect("PANDACODE_REPLAY_OUT"), lines.join("\n")).unwrap();
}
