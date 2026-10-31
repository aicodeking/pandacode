use super::parse::{self, CodexState, Record};
use super::pricing::{parse_prices, PriceBook};
use super::*;
use serde_json::json;
use std::io::Write;

fn claude(id: &str, request: &str, timestamp: &str, usage: serde_json::Value) -> String {
    json!({"type":"assistant","requestId":request,"timestamp":timestamp,"message":{"id":id,"model":"claude-opus-5-5","role":"assistant","usage":usage,"content":[{"type":"text","text":"secret reply"}]}}).to_string()
}
// Rollouts serialize `timestamp` and `type` ahead of the payload; json! would sort keys.
fn codex_context(model: &str) -> String {
    format!(r#"{{"timestamp":"2026-09-20T10:00:00.000Z","type":"turn_context","payload":{{"cwd":"/tmp","model":"{model}"}}}}"#)
}
fn codex_tokens(timestamp: &str, total: u64, input: u64, cached: u64, output: u64) -> String {
    let info = json!({"total_token_usage":{"total_tokens":total},"last_token_usage":{"input_tokens":input,"cached_input_tokens":cached,"output_tokens":output,"reasoning_output_tokens":output / 2,"total_tokens":input + output}});
    format!(r#"{{"timestamp":"{timestamp}","type":"event_msg","payload":{{"type":"token_count","info":{info}}}}}"#)
}
fn book() -> PriceBook {
    PriceBook::bundled()
}

#[test]
fn timestamps_parse_utc_offsets_and_fractions() {
    assert_eq!(parse::unix_seconds("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(parse::unix_seconds("2026-09-26T08:58:01.123Z"), Some(1_790_413_081));
    assert_eq!(parse::unix_seconds("2026-09-26T10:58:01+02:00"), Some(1_790_413_081));
    assert_eq!(parse::unix_seconds("2024-02-29T00:00:00Z"), Some(1_709_164_800));
    assert_eq!(parse::unix_seconds("2026-13-01T00:00:00Z"), None);
    assert_eq!(parse::unix_seconds("yesterday"), None);
}

#[test]
fn claude_replies_keep_counts_split_hour_cache_writes_and_drop_text() {
    let line = claude("msg_1", "req_1", "2026-09-26T08:58:01Z", json!({"input_tokens":12,"cache_creation_input_tokens":1000,"cache_read_input_tokens":50_000,"output_tokens":300,"cache_creation":{"ephemeral_1h_input_tokens":800,"ephemeral_5m_input_tokens":200}}));
    let record = parse::claude_line(&line).unwrap();
    assert_eq!((record.input, record.cache_read, record.cache_write, record.cache_write_1h, record.output), (12, 50_000, 200, 800, 300));
    assert_eq!(record.hour, 1_790_413_081 / 3600);
    assert_eq!(record.class, 0);
    assert!(record.key.is_some());
    assert!(!serde_json::to_string(&record).unwrap().contains("secret"));
    let synthetic = line.replace("claude-opus-5-5", "<synthetic>");
    assert_eq!(parse::claude_line(&synthetic), None);
    let user = json!({"type":"user","timestamp":"2026-09-26T08:58:01Z","message":{"role":"user","content":"\"usage\" \"assistant\""}}).to_string();
    assert_eq!(parse::claude_line(&user), None);
}

#[test]
fn codex_counts_turns_once_and_separates_cached_input() {
    let mut state = CodexState::default();
    assert_eq!(parse::codex_line(&codex_tokens("2026-09-20T09:00:00Z", 10, 8, 0, 2), &mut state).unwrap().model, "unknown");
    assert_eq!(parse::codex_line(&codex_context("gpt-6-astra"), &mut state), None);
    let turn = parse::codex_line(&codex_tokens("2026-09-20T10:05:00Z", 1_110, 1_000, 900, 100), &mut state).unwrap();
    assert_eq!((turn.input, turn.cache_read, turn.output, turn.model.as_str()), (100, 900, 100, "gpt-6-astra"));
    // A repeated event with an unchanged running total is not another turn.
    assert_eq!(parse::codex_line(&codex_tokens("2026-09-20T10:06:00Z", 1_110, 1_000, 900, 100), &mut state), None);
    let empty = r#"{"timestamp":"2026-09-20T10:07:00Z","type":"event_msg","payload":{"type":"token_count","info":null}}"#;
    assert_eq!(parse::codex_line(empty, &mut state), None);
    let large = parse::codex_line(&codex_tokens("2026-09-20T10:08:00Z", 400_000, 300_000, 0, 10), &mut state).unwrap();
    assert_eq!(large.class, 2);
    let mut hourly = Vec::new();
    parse::merge_hourly(&mut hourly, turn.clone());
    parse::merge_hourly(&mut hourly, turn);
    assert_eq!((hourly.len(), hourly[0].input, hourly[0].cache_read), (1, 200, 1_800));
}

#[test]
fn multibyte_text_near_the_prefix_does_not_panic() {
    let line = format!("{{\"timestamp\":\"{}\",\"type\":\"response_item\"}}", "é".repeat(150));
    assert_eq!(parse::codex_line(&line, &mut CodexState::default()), None);
}

#[test]
fn prices_prefer_vendor_listings_and_apply_long_context_and_hour_cache_rates() {
    let prices = parse_prices(&json!({
        "azure/model-x": {"mode":"chat","input_cost_per_token":9.0,"output_cost_per_token":9.0},
        "model-x": {"mode":"chat","input_cost_per_token":1e-6,"output_cost_per_token":5e-6,"cache_read_input_token_cost":1e-7,"cache_creation_input_token_cost":1.25e-6,"cache_creation_input_token_cost_above_1hr":2e-6,
            "input_cost_per_token_above_272k_tokens":2e-6,"output_cost_per_token_above_272k_tokens":7.5e-6,"cache_read_input_token_cost_above_272k_tokens":2e-7},
        "vertex_ai/only-reseller": {"mode":"chat","input_cost_per_token":3e-6,"output_cost_per_token":4e-6},
        "embedder": {"mode":"embedding","input_cost_per_token":1e-6,"output_cost_per_token":0.0}
    }));
    assert!(prices.contains_key("only-reseller"));
    assert!(!prices.contains_key("embedder"));
    let book = PriceBook::from_prices(prices);
    let record = |class, input, cache_read, cache_write, cache_write_1h, output| Record { key: None, hour: 0, model: "model-x-20260101".into(), class, input, cache_read, cache_write, cache_write_1h, output };
    let (cost, savings) = book.cost(&record(0, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000)).unwrap();
    assert!((cost - (1.0 + 0.1 + 1.25 + 2.0 + 5.0)).abs() < 1e-9, "{cost}");
    assert!((savings - 0.9).abs() < 1e-9);
    // Above 272k, the long-context tier applies; 200k–272k stays at base rates for a 272k tier.
    let (high, _) = book.cost(&record(2, 1_000_000, 1_000_000, 0, 0, 1_000_000)).unwrap();
    assert!((high - (2.0 + 0.2 + 7.5)).abs() < 1e-9, "{high}");
    let (middle, _) = book.cost(&record(1, 1_000_000, 0, 0, 0, 0)).unwrap();
    assert!((middle - 1.0).abs() < 1e-9);
    assert!(book.cost(&Record { model: "unknown".into(), ..record(0, 1, 0, 0, 0, 0) }).is_none());
    assert!(book.find("model-x[1m]").is_some());
}

#[test]
fn bundled_snapshot_prices_current_agent_models() {
    let book = book();
    for model in ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5-20251001", "gpt-6-astra", "gpt-5.5"] {
        assert!(book.find(model).is_some(), "{model} is missing from the bundled price snapshot");
    }
}

#[test]
fn scanning_dedupes_claude_replies_resumes_appends_and_forgets_deleted_logs() {
    let root = std::env::temp_dir().join(format!("pandacode-ledger-{}", uuid::Uuid::new_v4()));
    let project = root.join("claude").join("projects").join("demo");
    std::fs::create_dir_all(project.join("session").join("subagents")).unwrap();
    let usage = json!({"input_tokens":10,"cache_read_input_tokens":100,"output_tokens":5});
    let reply = claude("msg_1", "req_1", "2026-09-26T08:58:01Z", usage.clone());
    std::fs::write(project.join("a.jsonl"), format!("{reply}\n{reply}\n")).unwrap();
    // A resumed session copies the same reply into a new file, then continues.
    let resumed = claude("msg_4", "req_4", "2026-09-26T10:00:00Z", usage.clone());
    std::fs::write(project.join("b.jsonl"), format!("{reply}\n{resumed}\n")).unwrap();
    std::fs::write(project.join("session").join("subagents").join("agent.jsonl"), format!("{}\n", claude("msg_2", "req_2", "2026-09-26T09:10:00Z", usage))).unwrap();
    let mut cache = Cache { version: CACHE_VERSION, files: HashMap::new() };
    let mut files = Vec::new();
    log_files(&root.join("claude").join("projects"), 0, &|_| true, &mut files);
    assert_eq!(files.len(), 3);
    for (path, metadata) in &files {
        let entry = cache.files.entry(path.to_string_lossy().into_owned()).or_insert_with(|| FileEntry {
            agent: Some(Agent::Claude),
            session: !path.components().any(|part| part.as_os_str() == "subagents"),
            ..FileEntry::default()
        });
        read_file(path, Agent::Claude, entry).unwrap();
        entry.length = metadata.len();
    }
    let ledger = aggregate(&cache, &book(), 0, 1);
    let tokens: u64 = ledger.rows.iter().map(|row| row.2 + row.3 + row.4 + row.5).sum();
    assert_eq!(tokens, 345, "each reply counts once across streaming copies and resumed sessions");
    assert_eq!(ledger.sessions.len(), 2, "subagent logs belong to their parent session");
    assert_eq!(ledger.models.len(), 1);
    assert!(ledger.rows.iter().all(|row| row.6 > 0.0));

    // An appended file continues from its saved offset; a partial last line waits.
    let path = project.join("a.jsonl");
    let key = path.to_string_lossy().into_owned();
    let offset = cache.files[&key].offset;
    let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
    let later = claude("msg_3", "req_3", "2026-09-26T11:00:00Z", json!({"input_tokens":1,"output_tokens":1}));
    write!(file, "{later}\n{{\"partial\":").unwrap();
    drop(file);
    read_file(&path, Agent::Claude, cache.files.get_mut(&key).unwrap()).unwrap();
    let entry = &cache.files[&key];
    assert_eq!(entry.records.len(), 3);
    assert_eq!(entry.offset, offset + later.len() as u64 + 1);
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn task_usage_sums_only_linked_session_logs_and_honors_since() {
    let record = |hour: i64, input: u64, output: u64, key: Option<u64>| Record { key, hour, model: "m".into(), class: 0, input, cache_read: 0, cache_write: 0, cache_write_1h: 0, output };
    let mut cache = Cache { version: CACHE_VERSION, files: HashMap::new() };
    // The reply with key 7 appears twice: streamed once, then copied by a resume into the same log.
    cache.files.insert(
        "/logs/8f0e7c5a-1111-4222-8333-444455556666".into(),
        FileEntry { agent: Some(Agent::Claude), session: true, records: vec![record(1, 10, 5, Some(7)), record(1, 10, 5, Some(7)), record(5, 100, 50, Some(8))], ..FileEntry::default() },
    );
    cache.files.insert(
        "/logs/rollout-2026-09-26T08-58-01-aaaa1111-b222-4c33-8d44-555566667777".into(),
        FileEntry { agent: Some(Agent::Codex), records: vec![record(2, 7, 3, None)], ..FileEntry::default() },
    );
    cache.files.insert(
        "/logs/unlinked".into(),
        FileEntry { agent: Some(Agent::Claude), records: vec![record(1, 999, 999, None)], ..FileEntry::default() },
    );
    let links = ["8f0e7c5a-1111-4222-8333-444455556666".to_string(), "aaaa1111-b222-4c33-8d44-555566667777".to_string()];
    let usage = task_usage_from_cache(&cache, &links, 0);
    assert_eq!((usage.input, usage.cache_read, usage.output), (117, 0, 58), "streamed copies count once");
    assert_eq!((usage.first_used, usage.last_used), (Some(3_600_000), Some(18_000_000)));
    let since = task_usage_from_cache(&cache, &links, 3);
    assert_eq!((since.input, since.output), (100, 50));
    assert_eq!((since.first_used, since.last_used), (Some(18_000_000), Some(18_000_000)));
}

#[test]
fn model_names_are_shared_between_records_and_survive_a_cache_round_trip() {
    let first = parse::claude_line(&claude("msg_1", "req_1", "2026-09-26T08:58:01Z", json!({"input_tokens":1}))).unwrap();
    let second = parse::claude_line(&claude("msg_2", "req_2", "2026-09-26T08:58:02Z", json!({"input_tokens":1}))).unwrap();
    assert!(std::ptr::eq(first.model.as_str(), second.model.as_str()), "one allocation per model name");
    let text = serde_json::to_string(&first).unwrap();
    assert!(text.contains(r#""model":"claude-opus-5-5""#), "{text}");
    let back: Record = serde_json::from_str(&text).unwrap();
    assert_eq!(back, first);
    assert!(std::ptr::eq(back.model.as_str(), first.model.as_str()));
}

/// Claude and Codex logs for two linked sessions plus an unrelated one.
fn sample_logs(root: &Path) -> (Roots, Vec<String>, PathBuf) {
    let claude_root = root.join("claude").join("projects");
    let codex_root = root.join("codex").join("sessions");
    let project = claude_root.join("demo");
    let day = codex_root.join("2026").join("09").join("20");
    std::fs::create_dir_all(project.join("8f0e7c5a-1111-4222-8333-444455556666").join("subagents")).unwrap();
    std::fs::create_dir_all(&day).unwrap();
    let usage = |input: u64| json!({"input_tokens":input,"cache_read_input_tokens":100,"cache_creation_input_tokens":40,"output_tokens":5});
    let linked = project.join("8f0e7c5a-1111-4222-8333-444455556666.jsonl");
    let reply = claude("msg_1", "req_1", "2026-09-26T08:58:01Z", usage(10));
    std::fs::write(&linked, format!("{reply}\n{reply}\n{}\n", claude("msg_2", "req_2", "2026-09-26T09:30:00Z", usage(20)))).unwrap();
    std::fs::write(project.join("8f0e7c5a-1111-4222-8333-444455556666").join("subagents").join("agent-1.jsonl"), format!("{}\n", claude("msg_3", "req_3", "2026-09-26T09:40:00Z", usage(30)))).unwrap();
    std::fs::write(project.join("other.jsonl"), format!("{reply}\n{}\n", claude("msg_4", "req_4", "2026-09-26T10:00:00Z", usage(40)))).unwrap();
    let rollout = [codex_context("gpt-6-astra"), codex_tokens("2026-09-20T10:05:00Z", 1_110, 1_000, 900, 100), codex_tokens("2026-09-20T10:06:00Z", 1_110, 1_000, 900, 100), codex_tokens("2026-09-20T11:05:00Z", 2_000, 800, 100, 90)];
    std::fs::write(day.join("rollout-2026-09-20T10-00-00-aaaa1111-b222-4c33-8d44-555566667777.jsonl"), rollout.join("\n") + "\n").unwrap();
    std::fs::write(day.join("rollout-2026-09-20T10-00-00-bbbb1111-b222-4c33-8d44-555566667777.jsonl"), rollout.join("\n") + "\n").unwrap();
    let roots = vec![(Agent::Claude, vec![claude_root]), (Agent::Codex, vec![codex_root])];
    let links = vec!["8f0e7c5a-1111-4222-8333-444455556666".to_string(), "aaaa1111-b222-4c33-8d44-555566667777".to_string()];
    (roots, links, linked)
}

#[test]
fn linked_refresh_matches_a_full_scan_through_appends_and_deletes() {
    let root = std::env::temp_dir().join(format!("pandacode-ledger-{}", uuid::Uuid::new_v4()));
    let (roots, links, linked) = sample_logs(&root);
    let empty = || Cache { version: CACHE_VERSION, files: HashMap::new() };
    let (mut full, mut slim) = (empty(), empty());
    let totals = |full: &mut Cache, slim: &mut Cache| {
        refresh_cache(full, &roots, 0);
        refresh_linked(slim, &roots, &links, 0);
        let expected = task_usage_from_cache(full, &links, 0);
        assert_eq!(task_usage_from_cache(slim, &links, 0), expected);
        assert_eq!(task_usage_from_cache(slim, &links, 1_790_413_081 / 3600 + 1), task_usage_from_cache(full, &links, 1_790_413_081 / 3600 + 1));
        expected
    };
    // First sight walks the roots and reads only the linked files.
    let first = totals(&mut full, &mut slim);
    assert_eq!((first.input, first.cache_read, first.output), (10 + 20 + 100 + 700, 200 + 900 + 100, 10 + 100 + 90));
    assert_eq!(slim.files.len(), 2, "unlinked and subagent logs are not read");
    // Later run ends only stat the cached files and read what was appended.
    let mut file = std::fs::OpenOptions::new().append(true).open(&linked).unwrap();
    writeln!(file, "{}", claude("msg_5", "req_5", "2026-09-26T12:00:00Z", json!({"input_tokens":7,"output_tokens":3}))).unwrap();
    drop(file);
    let appended = totals(&mut full, &mut slim);
    assert_eq!((appended.input - first.input, appended.output - first.output), (7, 3));
    // A deleted log stops counting, as in a full scan.
    std::fs::remove_file(&linked).unwrap();
    let deleted = totals(&mut full, &mut slim);
    assert_eq!(deleted.input, 800);
    assert_eq!(slim.files.len(), 1);
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn linked_refresh_follows_archived_rollouts_and_extra_logs_of_a_session() {
    let root = std::env::temp_dir().join(format!("pandacode-ledger-{}", uuid::Uuid::new_v4()));
    let (mut roots, links, _) = sample_logs(&root);
    let archive = root.join("codex").join("archived_sessions");
    std::fs::create_dir_all(&archive).unwrap();
    roots[1].1.push(archive.clone());
    let empty = || Cache { version: CACHE_VERSION, files: HashMap::new() };
    let (mut full, mut slim) = (empty(), empty());
    let totals = |full: &mut Cache, slim: &mut Cache| {
        refresh_cache(full, &roots, 0);
        refresh_linked(slim, &roots, &links, 0);
        let expected = task_usage_from_cache(full, &links, 0);
        assert_eq!(task_usage_from_cache(slim, &links, 0), expected);
        expected
    };
    let first = totals(&mut full, &mut slim);
    // Codex moves a finished rollout into archived_sessions; it still counts, once.
    let name = "rollout-2026-09-20T10-00-00-aaaa1111-b222-4c33-8d44-555566667777.jsonl";
    std::fs::rename(root.join("codex").join("sessions").join("2026").join("09").join("20").join(name), archive.join(name)).unwrap();
    assert_eq!(totals(&mut full, &mut slim), first);
    assert!(slim.files.keys().any(|key| key.contains("archived_sessions")));
    assert_eq!(slim.files.len(), 2, "the old rollout path is forgotten");
    // The same session logged under a second project adds its new replies.
    let other = root.join("claude").join("projects").join("elsewhere");
    std::fs::create_dir_all(&other).unwrap();
    let reply = claude("msg_9", "req_9", "2026-09-27T08:00:00Z", json!({"input_tokens":4,"output_tokens":6}));
    std::fs::write(other.join("8f0e7c5a-1111-4222-8333-444455556666.jsonl"), format!("{reply}\n")).unwrap();
    let second = totals(&mut full, &mut slim);
    assert_eq!((second.input - first.input, second.output - first.output), (4, 6));
    assert_eq!(slim.files.len(), 3);
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_saved_cache_reloads_to_the_same_ledger_and_task_totals() {
    let root = std::env::temp_dir().join(format!("pandacode-ledger-{}", uuid::Uuid::new_v4()));
    let (roots, links, _) = sample_logs(&root);
    let mut cache = Cache { version: CACHE_VERSION, files: HashMap::new() };
    assert!(refresh_cache(&mut cache, &roots, 0));
    assert!(!refresh_cache(&mut cache, &roots, 0), "an unchanged scan leaves nothing to save");
    let path = root.join("app").join("usage-ledger-cache.json");
    assert!(save_cache(&path, &cache));
    assert!(!path.with_extension("tmp").exists());
    let loaded = load_cache(&path);
    let ledger = |cache: &Cache| serde_json::to_value(aggregate(cache, &book(), 0, 1)).unwrap();
    assert_eq!(ledger(&loaded), ledger(&cache));
    assert_eq!(task_usage_from_cache(&loaded, &links, 0), task_usage_from_cache(&cache, &links, 0));
    assert_eq!(load_cache(&root.join("missing.json")).files.len(), 0);
    std::fs::remove_dir_all(&root).unwrap();
}

/// `cargo test --lib live_local_logs -- --ignored --nocapture` prints totals only.
#[test]
#[ignore]
fn live_local_logs() {
    let since = crate::storage::now() - HISTORY_DAYS * 86_400_000;
    let mut cache = Cache { version: CACHE_VERSION, files: HashMap::new() };
    let started = std::time::Instant::now();
    refresh_cache(&mut cache, &agent_roots(), since);
    let first = started.elapsed();
    let started = std::time::Instant::now();
    refresh_cache(&mut cache, &agent_roots(), since);
    let again = started.elapsed();
    let ledger = aggregate(&cache, &PriceBook::bundled(), since.div_euclid(3_600_000), 0);
    for agent in [Agent::Claude, Agent::Codex] {
        let rows = ledger.rows.iter().filter(|row| ledger.models[row.1].provider == agent);
        let (tokens, cost) = rows.fold((0u64, 0f64), |(tokens, cost), row| (tokens + row.2 + row.3 + row.4 + row.5, cost + row.6));
        let sessions = ledger.sessions.iter().filter(|session| session.provider == agent).count();
        println!("{agent:?}: {sessions} sessions, {tokens} tokens, ${cost:.2}");
    }
    let unpriced: Vec<_> = ledger.models.iter().filter(|model| !model.priced).map(|model| model.name.as_str()).collect();
    let cache_bytes = serde_json::to_vec(&cache).unwrap().len();
    let ledger_bytes = serde_json::to_vec(&ledger).unwrap().len();
    println!("first scan {first:?}, rescan {again:?}, rows {}, cache {cache_bytes} B, payload {ledger_bytes} B, unpriced {unpriced:?}", ledger.rows.len());
}
