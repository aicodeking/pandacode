//! Storage benchmarks: how long the real `Store` (and the modules that query it directly) takes
//! on a file-backed SQLite database shaped like a mature PandaCode workspace: 20 projects, 500
//! tasks, ~25k messages (~64% tool rows of 4-16 KiB), teams, subagents, turn changes, bots, a
//! moodboard, schedules and a Connect mirror. Every case calls production code; where the caller
//! needs an `AppState` (a listing, the scheduler, the watchdog) it calls the same helpers that
//! caller does.
//!
//! Destructive cases (deletes, fork, writes) run on fresh copies of one pristine database, so
//! every case sees the same starting state. Results print as a markdown table plus one JSON
//! line per case (`{"suite":"storage_bench",...}`) for before/after comparison. Every id the
//! fixture writes itself comes from a seeded `Rng::uuid`, so two runs build the same table and
//! index layouts. Set `PANDACODE_STORAGE_BENCH_EXPORT=<file>` to keep a copy of the pristine
//! database for diagnosis with `sqlite3`. The fixture itself lives in `storage_bench/fixture.rs`.
//!
//! Two ignored tests, run one at a time so neither absorbs the other's disk I/O:
//!
//! - `db_bench_all`: only the paired cases, which do identical work and disk I/O before and after
//!   a change (plus the version 38 write-cost cases, last, so tables line up row by row).
//!   `cargo test --manifest-path src-tauri/Cargo.toml --profile fast-release --lib storage_bench::db_bench_all -- --ignored --exact --nocapture --test-threads=1`
//! - `db_bench_migration`: the one-time version 37 to 38 migration at two scales (1× and 2×
//!   messages), both from pre-reverted, `VACUUM`ed files, after an untimed schema round-trip check.
//!   `cargo test --manifest-path src-tauri/Cargo.toml --profile fast-release --lib storage_bench::db_bench_migration -- --ignored --exact --nocapture --test-threads=1`
//!
//! Compiled only for tests: `lib.rs` declares the module under `#[cfg(test)]`.

mod fixture;

use crate::providers::{AgentEvent, SubagentActivity};
use crate::storage::{self, Store, V38_BOT_INDEXES, V38_SCHEMA_INDEXES, V38_TRACKER_INDEXES, V38_TRACKER_TABLES, V38_TRACKER_TRIGGERS};
use crate::turn_changes::Captured;
use fixture::{build_fixture, captured, subagent, tool_json, Copy, Fixture, Rng, TempRoot, DAY_MS, DELETE_PROJECT, FORK, HEAVY, MIRROR, MOODBOARD_PROJECT, SEED};
use rusqlite::params;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

// Reporting

struct Table {
    title: String,
    rows: Vec<(String, Vec<f64>, String)>,
}

impl Table {
    fn new(title: &str) -> Self { Self { title: title.into(), rows: Vec::new() } }

    fn add(&mut self, name: impl Into<String>, samples: &[Duration], note: impl Into<String>) {
        self.rows.push((name.into(), samples.iter().map(|d| d.as_secs_f64() * 1000.0).collect(), note.into()));
    }

    fn print(&self) {
        println!("\n### {}\n\n| case | n | p50 ms | p95 ms | max ms | note |\n|---|---:|---:|---:|---:|---|", self.title);
        for (name, samples, note) in &self.rows {
            let (n, p50, p95, max, _) = stats(samples);
            println!("| {name} | {n} | {} | {} | {} | {note} |", cell(p50), cell(p95), cell(max));
        }
        println!();
        for (name, samples, note) in &self.rows {
            let (n, p50, p95, max, mean) = stats(samples);
            // 6 decimals of a millisecond: 0.000001 ms (1 ns) print precision, not timer resolution.
            let round = |v: f64| (v * 1_000_000.0).round() / 1_000_000.0;
            println!("{}", json!({"suite": "storage_bench", "case": name, "n": n, "p50_ms": round(p50), "p95_ms": round(p95), "max_ms": round(max), "mean_ms": round(mean), "note": note}));
        }
    }
}

/// A markdown cell for `v` ms: 5 decimals below 0.1 ms (10 ns print precision), 3 above.
fn cell(v: f64) -> String { if v < 0.1 { format!("{v:.5}") } else { format!("{v:.3}") } }

/// Nearest-rank percentile of a nonempty sorted sample.
fn percentile(sorted: &[f64], p: usize) -> f64 {
    let idx = (sorted.len() * p).div_ceil(100).saturating_sub(1).min(sorted.len() - 1);
    sorted[idx]
}

/// (n, p50, p95, max, mean) in ms, using nearest-rank percentiles.
fn stats(samples: &[f64]) -> (usize, f64, f64, f64, f64) {
    let mut s = samples.to_vec();
    s.sort_by(f64::total_cmp);
    if s.is_empty() {
        return (0, 0.0, 0.0, 0.0, 0.0);
    }
    (s.len(), percentile(&s, 50), percentile(&s, 95), s[s.len() - 1], s.iter().sum::<f64>() / s.len() as f64)
}

#[test]
fn nearest_rank_percentiles() {
    let samples: Vec<_> = (1..=20).map(f64::from).collect();
    assert_eq!(stats(&samples[..15]).2, 15.0);
    assert_eq!(stats(&samples[..5]).2, 5.0);
    assert_eq!(stats(&samples).1, 10.0);
}

fn time<T>(f: impl FnOnce() -> T) -> (T, Duration) {
    let started = Instant::now();
    let value = f();
    (value, started.elapsed())
}

/// Runs `run` `warmup` times untimed, then `iters` times timed. Returned values drop untimed.
fn bench<T>(table: &mut Table, name: &str, (warmup, iters): (usize, usize), note: &str, mut run: impl FnMut() -> T) {
    bench_with(table, name, (warmup, iters), note, || (), |_| run());
}

/// Like `bench`, with an untimed `setup` before every run (a fresh copy, new rows to settle).
fn bench_with<S, T>(table: &mut Table, name: &str, (warmup, iters): (usize, usize), note: &str, mut setup: impl FnMut() -> S, mut run: impl FnMut(&mut S) -> T) {
    let mut samples = Vec::with_capacity(iters);
    for i in 0..warmup + iters {
        let mut state = setup();
        let (value, elapsed) = time(|| std::hint::black_box(run(&mut state)));
        drop(value);
        drop(state);
        if i >= warmup {
            samples.push(elapsed);
        }
    }
    table.add(name, &samples, note);
}

/// Like `bench`, timing `batch` consecutive calls per sample and recording the per-call
/// duration (`elapsed / batch`), so sub-20 µs operations stay well above timer/rounding noise.
/// Each call's value drops inside the timed loop (constant memory); the note gains
/// ` (batched ×{batch}/sample)`.
fn bench_batched<T>(table: &mut Table, name: &str, (warmup, iters): (usize, usize), batch: usize, note: &str, mut run: impl FnMut() -> T) {
    assert!(batch > 0);
    let mut samples = Vec::with_capacity(iters);
    for i in 0..warmup + iters {
        let started = Instant::now();
        for _ in 0..batch {
            std::hint::black_box(run());
        }
        let elapsed = started.elapsed();
        if i >= warmup {
            samples.push(Duration::from_secs_f64(elapsed.as_secs_f64() / batch as f64));
        }
    }
    table.add(name, &samples, format!("{note} (batched ×{batch}/sample)"));
}

// Cases

fn startup_cases(fx: &Fixture, table: &mut Table) {
    bench_with(table, "startup_open_recovery", (1, 15), "first Store::open + discard_empty_drafts after a quit with 2 running teams, 3+2 running tasks, 5 drafts (fresh copy each)",
        || fx.unopened_copy("recovery"),
        |copy| { let store = Store::open(&copy.path).unwrap(); store.discard_empty_drafts().unwrap(); store });
    let path = fx.copy_path("reopen");
    drop(Store::open(&path).unwrap());
    bench(table, "startup_open_reopen", (2, 15), "Store::open + discard_empty_drafts on the populated DB (close untimed)", || {
        let store = Store::open(&path).unwrap();
        store.discard_empty_drafts().unwrap();
        store
    });
    drop(Copy { store: None, path });
}

fn read_cases(fx: &Fixture, table: &mut Table) {
    let mut copy = fx.open_copy("reads");
    let store = copy.store.take().unwrap();
    let mut locked = Mutex::new(store);
    let store: &Store = locked.get_mut().unwrap();
    fx.make_live(store);
    let heavy = fx.heavy();
    let project = &fx.projects[HEAVY];
    let agents: HashMap<String, crate::RunningAgent> = HashMap::new();
    bench(table, "sidebar_sessions", (3, 30), "store.sessions() (500 tasks, task_links attached)", || store.sessions().unwrap());
    bench(table, "sidebar_sessions_and_reconcile", (3, 30), "store.sessions() + crate::reconcile_listed, as listed_sessions (empty agents map, 2 active teams)", || {
        crate::reconcile_listed(store, &agents, store.sessions().unwrap())
    });
    bench(table, "agents_dock_snapshot", (3, 30), "agents_dock::snapshot_in_store, as agents_dock::snapshot after its locks (empty agents map, 2 active teams)", || {
        crate::agents_dock::snapshot_in_store(store, &agents).unwrap()
    });
    bench_batched(table, "single_session_lookup", (2, 25), 100, "store.session(heavy)", || store.session(heavy).unwrap());
    let control_ids = listed_ids(store, 500);
    let control = control_connection(&copy.path);
    bench(table, "control_pk_lookup_500", (3, 30), "pragma-invariant control: 500 sessions primary-key lookups through prepare (not prepare_cached) on its own plain rusqlite connection with fixed PRAGMA cache_size=-1024 and temp_store=DEFAULT, so Store::open's pragmas (cache_size, temp_store) cannot reach it; SQL, connection settings and Rust are identical before and after and only the sessions primary key is used, close to, not completely, schema-independent (reads sessions by primary key on the fixture file itself, whose size and sessions indexes differ between v37 and v38; control_write_50 uses a standalone file outside the fixture)", || {
        let mut query = control.prepare("SELECT title FROM sessions WHERE id=?1").unwrap();
        control_ids.iter().map(|id| query.query_row([id], |r| r.get::<_, String>(0)).unwrap().len()).sum::<usize>()
    });
    drop(control);
    control_write_case(fx, table);
    bench(table, "thread_open_message_page", (3, 50), "store.message_page(heavy, None): 300 rows, 200 tool rows of ~12 KiB", || store.message_page(heavy, None).unwrap());
    bench(table, "thread_open_subagent_rows", (3, 50), "store.finish_subagents(heavy, stopped) + store.subagent_rows(heavy) (24 children); startup recovery settles the running subagents before warm-up, so every timed call sees the already-settled steady state, as when reopening an existing thread", || {
        store.finish_subagents(heavy, "stopped").unwrap();
        store.subagent_rows(heavy).unwrap()
    });
    let since = storage::now() - 366 * DAY_MS;
    bench(table, "prompt_activity_calendar", (2, 20), "store.prompt_activity(now - 366 d), as the command", || store.prompt_activity(since).unwrap());
    bench(table, "search_tasks_project", (2, 20), "store.search_tasks(project, \"deploy_pipeline\", 20)", || {
        let hits = store.search_tasks(project, "deploy_pipeline", 20).unwrap();
        assert!(!hits.is_empty());
        hits
    });
    bench(table, "search_tasks_project_miss", (2, 20), "store.search_tasks(project, \"zz_no_such_token\", 20): scans every chat row", || store.search_tasks(project, "zz_no_such_token", 20).unwrap());
    bench_batched(table, "workspace_root_lookup", (2, 25), 50, "store.workspace_root(project, Some(heavy)) (worktree with .git file)", || store.workspace_root(project, Some(heavy)).unwrap());
    bench_batched(table, "workspace_root_lock_hold", (2, 25), 100, "uncontended store-mutex lock/unlock + SQL critical section of AppState::root (BEFORE holds the lock across workspace_root including disk checks; AFTER holds it only across workspace_paths)", || locked.lock().unwrap().workspace_paths(project, Some(heavy)).unwrap());
    let store: &Store = locked.get_mut().unwrap();
    bench_batched(table, "user_turns_count", (2, 25), 100, "store.user_turns(heavy)", || store.user_turns(heavy).unwrap());
    bench_batched(table, "imported_task_lookup", (2, 25), 100, "store.imported_task(\"claude\", resume_id)", || assert!(store.imported_task("claude", &fx.import_resume_id).unwrap().is_some()));
    bench_batched(table, "due_limit_resumes", (2, 25), 100, "store.due_limit_resumes(now)", || store.due_limit_resumes(storage::now()).unwrap());
    let scheduled = &fx.scheduled_session;
    bench_batched(table, "schedules_list_session", (2, 25), 100, "schedules::list(Some(task)) on the task holding the most of the 100 schedules, as schedules_list for a thread", || {
        let schedules = crate::schedules::list(store, Some(scheduled)).unwrap();
        assert!(!schedules.is_empty());
        schedules
    });
    let mut link_state = ["closed", "open"].into_iter().cycle();
    bench_with(table, "update_link_states_20", (3, 30), "store.update_link_states(project, 20 links), alternating open/closed states and title suffixes each sample",
        || fx.link_states(link_state.next().unwrap()),
        |states| store.update_link_states(project, states).unwrap());
    let listed = store.sessions().unwrap();
    let mut subset = listed.iter().filter(|s| !s.pinned).skip(5).step_by(37).take(10).map(|s| s.id.clone()).collect::<Vec<_>>();
    assert_eq!(subset.len(), 10);
    bench(table, "reorder_sessions_500", (2, 20), "store.reorder_sessions(10 of 500 ranked tasks), order flipped each run; includes its sessions() reply", || {
        subset.reverse();
        store.reorder_sessions(&subset).unwrap()
    });
    architect_cases(fx, store, &listed, table);
    mirror_read_cases(fx, store, table);
    bot_cases(fx, store, table);
}

/// The control case's connection: plain `Connection::open`, none of `Store::open`'s setup, and
/// the same fixed pragmas whatever `Store::open` sets.
fn control_connection(path: &std::path::Path) -> rusqlite::Connection {
    let db = rusqlite::Connection::open(path).unwrap();
    db.execute_batch("PRAGMA cache_size=-1024; PRAGMA temp_store=DEFAULT;").unwrap();
    db
}

/// Removes a database file and its WAL/shm files.
fn remove_db(path: &std::path::Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

/// The disk-write control: 50 autocommit WAL writes of a 2 KiB row into a small standalone file
/// with fixed pragmas and one table, independent of `Store::open` and the schema, so it is
/// identical before and after; a shift measures disk/WAL write skew between runs. The WAL is
/// truncated untimed before every sample, so no sample absorbs an auto-checkpoint.
fn control_write_case(fx: &Fixture, table: &mut Table) {
    let path = fx.root.0.join("control-write.db");
    let wdb = rusqlite::Connection::open(&path).unwrap();
    wdb.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-1024; PRAGMA temp_store=DEFAULT; CREATE TABLE kv(k INTEGER PRIMARY KEY, v TEXT NOT NULL);").unwrap();
    let payload = fx.corpus.take(&mut Rng(SEED ^ 0xc0_417e), 2048);
    bench_with(table, "control_write_50", (2, 20), "disk-write control: 50 autocommit INSERT OR REPLACE INTO kv(k,v) of a 2 KiB row (each its own WAL commit) on a standalone file with fixed PRAGMA journal_mode=WAL, synchronous=NORMAL, cache_size=-1024, temp_store=DEFAULT and one table, independent of Store::open and the schema; wal_checkpoint(TRUNCATE) untimed before each sample; a shift measures disk/WAL write skew between runs, not the change",
        || wdb.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap(),
        |_| {
            let mut stmt = wdb.prepare("INSERT OR REPLACE INTO kv(k,v) VALUES(?1,?2)").unwrap();
            for k in 0..50i64 {
                stmt.execute(params![k, &payload]).unwrap();
            }
        });
    drop(wdb);
    remove_db(&path);
}

/// The first `count` session ids in primary-key order (the control case's lookup keys).
fn listed_ids(store: &Store, count: usize) -> Vec<String> {
    let mut query = store.db.prepare("SELECT id FROM sessions ORDER BY id LIMIT ?1").unwrap();
    let ids = query.query_map([count as i64], |r| r.get::<_, String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    assert_eq!(ids.len(), count);
    ids
}

fn architect_cases(fx: &Fixture, store: &Store, listed: &[storage::Session], table: &mut Table) {
    // architect::next_action_state and architect::watchdog::{reconcile, settle_stale} need an
    // AppState; these cases call the candidate queries they call.
    bench(table, "architect_active_scan/scheduler_query", (3, 30), "architect::runnable_team_rows + TeamSnapshot parse, as next_action_state", || {
        let rows = crate::architect::runnable_team_rows(&store.db).unwrap();
        let teams = rows.iter().map(|(_, s)| serde_json::from_str::<crate::architect::TeamSnapshot>(s).unwrap()).collect::<Vec<_>>();
        assert_eq!(teams.len(), fx.active_teams.len());
        teams
    });
    bench_batched(table, "architect_active_scan/watchdog_reconcile", (2, 15), 50, "watchdog::reconcile_candidates: the active-team query watchdog::reconcile runs every 30 s", || {
        let rows = crate::architect::watchdog::reconcile_candidates(&store.db).unwrap();
        assert_eq!(rows.len(), fx.active_teams.len());
        rows
    });
    let expected_stale = expected_stale_candidates(store);
    assert!(expected_stale > 0, "the fixture must hold settled teams for settle_stale to select");
    assert_eq!(crate::architect::watchdog::stale_candidates(&store.db).unwrap().len(), expected_stale, "stale_candidates must match the snapshot predicate");
    bench_batched(table, "architect_active_scan/watchdog_stale_candidates", (2, 15), 50, "watchdog::stale_candidates: settle_stale's one-time startup candidate selection (settle_stale then loads each candidate's full team snapshot, not timed here)", || {
        let rows = crate::architect::watchdog::stale_candidates(&store.db).unwrap();
        assert_eq!(rows.len(), expected_stale);
        rows
    });
    bench(table, "architect_active_scan/is_active_500", (3, 30), "architect::is_active for every listed task: the single-task fallback (listed_sessions uses active_team_session_ids)", || listed.iter().filter(|s| crate::architect::is_active(store, &s.id)).count());
    bench(table, "architect_active_scan/load_active", (3, 30), "architect::load for both active team snapshots (~60 KiB each); two-team total per sample", || fx.active_teams.iter().map(|lead| crate::architect::load(store, lead).unwrap().unwrap()).collect::<Vec<_>>());
}

/// Untimed: the teams `watchdog::stale_candidates` must list, counted straight from the snapshots
/// (every non-JSON row, and every JSON row whose status is set and is neither `running` nor
/// `waiting`) rather than from the trigger-kept tracker the query reads.
fn expected_stale_candidates(store: &Store) -> usize {
    let sql = "SELECT COUNT(*) FROM architect_teams WHERE CASE WHEN json_valid(content) THEN json_extract(content,'$.status') NOT IN ('running','waiting') ELSE 1 END";
    store.db.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap() as usize
}

fn mirror_read_cases(fx: &Fixture, store: &Store, table: &mut Table) {
    let mirror = &fx.sessions[MIRROR];
    bench_batched(table, "remote_mirror_ops/of", (2, 25), 100, "remote::mirror::of(mirror)", || crate::remote::mirror::of(store, mirror).unwrap().unwrap());
    bench_batched(table, "remote_mirror_ops/unfinished_cut_lookup", (2, 20), 100, "remote::mirror::cut_copies(mirror); 2 cut rows of 500", || {
        let rows = crate::remote::mirror::cut_copies(store, mirror).unwrap();
        assert_eq!(rows.len(), 2);
        rows
    });
    bench(table, "remote_mirror_ops/message_page", (3, 30), "store.message_page(mirror, None)", || store.message_page(mirror, None).unwrap());
}

fn bot_cases(fx: &Fixture, store: &Store, table: &mut Table) {
    use crate::bots::shared_channels;
    let [main, other] = &fx.bots;
    // update_link_states_20 and reorder_sessions_500 wrote to this copy just before; flush their
    // WAL frames so bots::log does not absorb the synchronous auto-checkpoint they would trigger.
    store.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    bench_batched(table, "bots_log_and_shared_channels/failover_switches", (2, 20), 50, "bots::failover::switches(delivery task): the 12 model-switch rows among the 5,500 bot_activity rows, as bot_model_switches", || {
        let switches = crate::bots::failover::switches(store, &fx.delivery_session).unwrap();
        assert_eq!(switches.len(), 12);
        switches
    });
    let log = |store: &Store, bot: &str| crate::bots::log(store, bot, "message", "Replied in #general", json!({"channel": "slack", "chars": 420})).unwrap();
    bench(table, "bots_log_and_shared_channels/log", (8, 160), "bots::log on one bot near its 5,000-row cap: 160 consecutive inserts cross a 128-row trim boundary within the window. max_ms is the unattributed tail maximum of the 160 samples", || log(store, main));
    let interleaved = fx.open_copy("bot-log-interleaved");
    interleaved.store().db.execute("INSERT INTO bot_activity(bot_id,kind,summary,detail,at) SELECT ?2,kind,summary,detail,at FROM bot_activity WHERE bot_id=?1 AND kind!='model-switch' ORDER BY id LIMIT (5000 - (SELECT COUNT(*) FROM bot_activity WHERE bot_id=?2))", params![main, other]).unwrap();
    interleaved.store().db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    let mut bots = [main, other].into_iter().cycle();
    bench(table, "bots_log_and_shared_channels/log_interleaved", (8, 160), "bots::log alternating two bots near their 5,000-row caps: 160 consecutive interleaved inserts crossing a 128-row global row-ID trim boundary. max_ms is the unattributed tail maximum of the 160 samples", || log(interleaved.store(), bots.next().unwrap()));
    bench(table, "bots_log_and_shared_channels/activity_page", (3, 50), "bots::activity(bot, None, 50)", || crate::bots::activity(store, main, None, 50).unwrap());
    bench(table, "bots_log_and_shared_channels/list", (3, 50), "bots::shared_channels::list (10 channels)", || shared_channels::list(store).unwrap());
    bench(table, "bots_log_and_shared_channels/detail", (3, 50), "shared_channels::detail(channel, 200)", || shared_channels::detail(store, &fx.channel_id, 200).unwrap());
    bench_batched(table, "bots_log_and_shared_channels/delivery_lookups", (2, 25), 50, "shared_channels::current_hop_depth + open_posts for both bots", || {
        let depth = shared_channels::current_hop_depth(store, &fx.delivery_session).unwrap();
        (depth, shared_channels::open_posts(store, main).unwrap(), shared_channels::open_posts(store, other).unwrap())
    });
}

/// Each case after the first starts with a truncated WAL, so none absorbs the auto-checkpoint
/// the frames of the case before it would trigger.
fn write_cases(fx: &Fixture, table: &mut Table) {
    let copy = fx.open_copy("writes");
    let store = copy.store();
    let heavy = fx.heavy();
    let mut rng = Rng(SEED ^ 0xa5a5);
    let mut ids = Rng(SEED ^ 0x1d5_a5a5);
    let stages = (0..5).map(|k| tool_json(&fx.corpus, &mut rng, "toolu_stream", if k == 4 { "completed" } else { "running" }, 8 * 1024)).collect::<Vec<_>>();
    let mut run = 0;
    bench(table, "streaming_tool_upserts_50", (2, 30), "50 store.tool_message(heavy): 10 new tools × 5 snapshots of ~8 KiB", || {
        run += 1;
        for k in 0..10 {
            let id = format!("toolu_stream_{run}_{k}");
            for stage in &stages {
                store.tool_message(heavy, &id, stage).unwrap();
            }
        }
    });
    let prompt = fx.corpus.take(&mut rng, 300);
    let reply = fx.corpus.take(&mut rng, 2048);
    store.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    bench(table, "streaming_message_inserts_50", (2, 30), "50 store.message(heavy), alternating user (300 B) / assistant (2 KiB)", || {
        for k in 0..50 {
            if k % 2 == 0 { store.message(heavy, "user", &prompt) } else { store.message(heavy, "assistant", &reply) }.unwrap();
        }
    });
    let running = tool_json(&fx.corpus, &mut rng, "toolu_open", "running", 6 * 1024);
    let child = subagent(&fx.corpus, &mut rng, "agent-open", "running", storage::now());
    let mut turn = 0;
    store.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    bench_with(table, "turn_end_finish_tools_and_subagents", (2, 20), "store.finish_tools(heavy) + finish_subagents(heavy, stopped); 2 running tools and 1 running child added untimed",
        || {
            turn += 1;
            for k in 0..2 {
                store.tool_message(heavy, &format!("toolu_open_{turn}_{k}"), &running).unwrap();
            }
            store.save_subagent(heavy, &SubagentActivity { id: format!("agent-open-{turn}"), ..child.clone() }).unwrap();
        },
        |_| { store.finish_tools(heavy).unwrap(); store.finish_subagents(heavy, "stopped").unwrap(); });
    store.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    bench_with(table, "turn_changes_persist", (2, 20), "turn_changes::persist(heavy) with 10 changed files of ~4 KiB patches",
        || captured(&fx.corpus, &mut rng, ids.uuid(), 10, 4096),
        |capture| crate::turn_changes::persist(store, heavy, Captured { summary: capture.summary.clone(), details: std::mem::take(&mut capture.details) }).unwrap());
    solo_history_case(fx, table);
    team_history_case(fx, table, "turn_changes_persist_dense_team", 250,
        "turn_changes::persist under the Store mutex on its own fresh copy: 4 finished workers with 1,000 interleaved attributed captures (250 each), the newest 250 already rolled up across multiple pages; seeded history restored between samples");
    team_history_case(fx, table, "turn_changes_persist_merged_team", 1_000,
        "turn_changes::persist under the Store mutex on its own fresh copy: 4 finished workers with 1,000 interleaved attributed captures (250 each), all 1,000 already rolled up (zero new sources); seeded history restored between samples");
    let mirror = &fx.sessions[MIRROR];
    store.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    bench_with(table, "remote_mirror_ops/store_page_10", (2, 20), "remote::mirror::store_page with 10 new host messages",
        || {
            let after: i64 = store.db.query_row("SELECT remote_synced_id FROM sessions WHERE id=?1", [mirror], |r| r.get(0)).unwrap();
            let messages = (1..=10).map(|k| json!({"id": after + k, "role": if k % 2 == 0 { "assistant" } else { "tool" }, "content": fx.corpus.take(&mut rng, 4096), "createdAt": storage::now()})).collect::<Vec<_>>();
            (after, json!({"messages": messages, "hasMore": false, "title": "Mirrored task"}))
        },
        |(after, page)| assert!(!crate::remote::mirror::store_page(store, mirror, *after, page).unwrap()));
    let children = (0..5).map(|k| subagent(&fx.corpus, &mut rng, &format!("remote-agent-{k}"), "running", storage::now())).collect::<Vec<_>>();
    store.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    bench(table, "remote_mirror_ops/save_subagents_5", (2, 30), "remote::mirror::save_subagents_in_store with 5 unchanged children (duplicate-replay upsert + trigger check)", || {
        crate::remote::mirror::save_subagents_in_store(store, mirror, &children).unwrap()
    });
    store.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    let mut sample = 0;
    bench_with(table, "remote_mirror_ops/save_subagents_5_changing", (2, 30), "remote::mirror::save_subagents_in_store (each sample updates all 5 children with fresh timestamps and tool output text)",
        || {
            sample += 1;
            let progress = format!("\nMirrored progress {sample:02}");
            let mut snapshots = children.clone();
            for child in &mut snapshots {
                child.updated_at += sample;
                child.tools[0].output.push_str(&progress);
            }
            snapshots
        },
        |snapshots| crate::remote::mirror::save_subagents_in_store(store, mirror, snapshots).unwrap());
    store.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    queue_cases(store, heavy, table);
    store.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    attachment_cases(fx, store, &mut ids, table);
    drop(copy);
    subagent_state_cases(fx, table);
}

fn solo_history_case(fx: &Fixture, table: &mut Table) {
    let mut rng = Rng(SEED ^ 0xb5b5);
    let mut ids = Rng(SEED ^ 0x1d5_b5b5);
    let sid = ids.uuid();
    let mut copy = fx.seed_solo_history(&sid, &mut rng, &mut ids);
    let store = Mutex::new(copy.store.take().unwrap());
    bench_with(table, "turn_changes_persist_solo_history", (2, 20),
        "turn_changes::persist under the Store mutex with 10 changed files of ~4 KiB patches; solo thread seeded with 250 ~8 KiB summaries on its own fresh copy",
        || Some(captured(&fx.corpus, &mut rng, ids.uuid(), 10, 4096)),
        |capture| crate::turn_changes::persist(&store.lock().unwrap(), &sid, capture.take().unwrap()).unwrap());
}

fn team_history_case(fx: &Fixture, table: &mut Table, name: &str, pre_merged: usize, note: &str) {
    let mut copy = fx.open_copy(name);
    let mut rng = Rng(SEED ^ 0xd3e5);
    let mut ids = Rng(SEED ^ 0x1d5_d3e5);
    let parent = ids.uuid();
    let workers = (0..4).map(|i| (format!("worker-{i}"), ids.uuid())).collect::<Vec<_>>();
    let store = copy.store();
    let tx = store.db.unchecked_transaction().unwrap();
    let now = storage::now();
    for (sid, title) in [(&parent, "Dense team")].into_iter().chain(workers.iter().map(|(_, sid)| (sid, "Finished worker"))) {
        tx.execute(
            "INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,title_origin)
             VALUES(?1,?2,?3,'claude','claude-opus','full','idle',?4,?5,'auto')",
            params![sid, fx.projects[HEAVY], title, now - DAY_MS, now],
        ).unwrap();
    }
    let roster = workers.iter().map(|(id, sid)| json!({"id":id,"sessionId":sid,"status":"completed","abandoned":false})).collect::<Vec<_>>();
    tx.execute("INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)", params![parent, json!({"status":"completed","workers":roster}).to_string()]).unwrap();
    for (id, sid) in &workers {
        tx.execute("INSERT INTO architect_workers(parent_session_id,worker_id,session_id) VALUES(?1,?2,?3)", params![parent, id, sid]).unwrap();
    }
    let first_merged = 1_000 - pre_merged;
    let mut capture_ids = Vec::with_capacity(1_000);
    {
        let mut message = tx.prepare("INSERT INTO messages(session_id,role,content,created_at) VALUES(?1,'changes','',?2) RETURNING id").unwrap();
        let mut change = tx.prepare("INSERT INTO turn_changes(id,session_id,message_id,summary,created_at) VALUES(?1,?2,?3,?4,?5)").unwrap();
        for n in 0..1_000usize {
            let worker = &workers[n % workers.len()].1;
            let at = now - (1_000 - n as i64) * 60_000;
            let message_id: i64 = message.query_row(params![worker, at], |row| row.get(0)).unwrap();
            let summary = captured(&fx.corpus, &mut rng, ids.uuid(), 1, 0).summary;
            change.execute(params![summary.id, worker, message_id, serde_json::to_string(&summary).unwrap(), at]).unwrap();
            capture_ids.push(summary.id);
        }
        for sources in capture_ids[first_merged..].rchunks(125) {
            let message_id: i64 = message.query_row(params![parent, now], |row| row.get(0)).unwrap();
            let mut summary = serde_json::to_value(captured(&fx.corpus, &mut rng, ids.uuid(), 0, 0).summary).unwrap();
            summary["teamSources"] = json!(sources);
            change.execute(params![summary["id"].as_str().unwrap(), parent, message_id, summary.to_string(), now]).unwrap();
        }
    }
    tx.commit().unwrap();
    store.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    let expected_first = capture_ids[..first_merged].last();
    let store = Mutex::new(copy.store.take().unwrap());
    let mut samples = Vec::with_capacity(12);
    for _ in 0..12 {
        let capture = captured(&fx.corpus, &mut rng, ids.uuid(), 10, 4096);
        let (message_id, elapsed) = time(|| crate::turn_changes::persist(&store.lock().unwrap(), &parent, capture).unwrap());
        // Check the rollup skipped the already merged rows, then restore the seeded history.
        let store = store.lock().unwrap();
        let sources: Option<String> = store.db.query_row(
            "SELECT summary -> '$.teamSources' FROM turn_changes WHERE message_id=?1",
            [message_id], |row| row.get(0),
        ).unwrap();
        let sources: Vec<String> = sources.map_or_else(Vec::new, |json| serde_json::from_str(&json).unwrap());
        assert_eq!(sources.first(), expected_first);
        assert_eq!(store.db.execute("DELETE FROM messages WHERE id=?1", [message_id]).unwrap(), 1);
        samples.push(elapsed);
    }
    table.add(name, &samples[2..], note);
}

fn queue_cases(store: &Store, heavy: &str, table: &mut Table) {
    bench(table, "message_queue_ops", (3, 30), "message_queue::add + list(Some(heavy)) + take of the added entry: a queued follow-up delivered", || {
        let entry = crate::message_queue::add(store, heavy, "follow up", &json!([])).unwrap();
        let queued = crate::message_queue::list(store, Some(heavy)).unwrap();
        assert_eq!(queued.len(), 1);
        crate::message_queue::take(store, &entry.id).unwrap()
    });
}

/// The prompt images and moodboard `attachments_link_batch` links per run.
const PROMPT_IMAGES: usize = 4;

/// An 8×8 PNG, a real image `link_message_attachments` can read the size of.
fn tiny_png(shade: u8) -> Vec<u8> {
    let image = image::RgbaImage::from_pixel(8, 8, image::Rgba([shade, 0x80, 0x40, 0xff]));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}

fn attachment_cases(fx: &Fixture, store: &Store, ids: &mut Rng, table: &mut Table) {
    let dirs = TempRoot::new("attach");
    let capture_dir = dirs.0.join("captures");
    let app_data_dir = dirs.0.join("app-data");
    std::fs::create_dir_all(&capture_dir).unwrap();
    std::fs::create_dir_all(&app_data_dir).unwrap();
    let project = &fx.projects[MOODBOARD_PROJECT];
    let expected = PROMPT_IMAGES + crate::moodboards::list(store, project).unwrap()[0].image_count as usize;
    // message_attachments is keyed by (session_id, id), so every run links into a new task of the
    // moodboard's project (created untimed with its user message and capture files).
    bench_with(table, "attachments_link_batch", (2, 20), &format!("attachments::link_message_attachments: {PROMPT_IMAGES} 8×8 PNG captures copied into app data + the 64-image moodboard named in the prompt ({expected} rows) for a new message in a new task of the moodboard's project (task, message and capture files created untimed)"),
        || {
            let sid = ids.uuid();
            let now = storage::now();
            store.db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,title_origin) VALUES(?1,?2,'Attachments','claude','claude-opus','full','idle',?3,?3,'auto')", params![sid, project, now]).unwrap();
            let images = (0..PROMPT_IMAGES).map(|k| {
                let id = ids.uuid();
                std::fs::write(capture_dir.join(format!("{id}.png")), tiny_png(k as u8)).unwrap();
                id
            }).collect::<Vec<_>>();
            let mut content = (0..PROMPT_IMAGES).map(|k| format!("Attached image: screen-{k}.png\n")).collect::<String>();
            content.push_str(&format!("Match the brand board (moodboard ID: {})", fx.moodboard_id));
            store.message(&sid, "user", &content).unwrap();
            let message: i64 = store.db.query_row("SELECT MAX(id) FROM messages WHERE session_id=?1", [&sid], |r| r.get(0)).unwrap();
            (sid, message, content, images)
        },
        |(sid, message, content, images)| {
            let linked = crate::attachments::link_message_attachments(store, sid, *message, content, images, &capture_dir, &app_data_dir).unwrap();
            assert_eq!(linked, expected);
        });
}

fn subagent_state_cases(fx: &Fixture, table: &mut Table) {
    let copy = fx.unopened_copy("subagent-state");
    let store = Mutex::new(Store::open(&copy.path).unwrap());
    let heavy = fx.heavy();
    let mut rng = Rng(SEED ^ 0x5ab5);
    let children = (0..5).map(|k| subagent(&fx.corpus, &mut rng, &format!("tracked-{k}"), "running", storage::now())).collect::<Vec<SubagentActivity>>();
    store.lock().unwrap().db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    let mut run = 0;
    bench_with(table, "subagent_state_flush", (2, 20), "subagent_state::SubagentState::finish(heavy, stopped): flushes 5 running children (recorded untimed through record, ~10-20 tools each) and settles the task's unfinished children, as at turn end",
        || {
            run += 1;
            let mut tracker = crate::subagent_state::SubagentState::default();
            for child in &children {
                let mut event = AgentEvent { session_id: heavy.into(), kind: "subagent".into(), text: String::new(), request_id: None, data: Some(serde_json::to_value(child).unwrap()), tool: None };
                tracker.record(&store, &format!("run-{run}"), &mut event).unwrap();
            }
            tracker
        },
        |tracker| {
            let store = store.lock().unwrap();
            let (changed, saved) = tracker.finish(&store, heavy, "stopped");
            saved.unwrap();
            assert_eq!(changed.len(), children.len());
            changed
        });
    drop(store);
}

fn destructive_cases(fx: &Fixture, table: &mut Table) {
    {
        let copy = fx.open_copy("fork");
        let store = copy.store();
        let source = &fx.sessions[FORK];
        bench(table, "conversation_fork_200", (1, 20), "conversation_fork::at_message on a 200-message task (one copy; forks accumulate)", || crate::conversation_fork::at_message(store, source, fx.fork_last_message).unwrap());
    }
    let project = &fx.projects[MOODBOARD_PROJECT];
    bench_with(table, "delete_moodboard_64_images", (1, 15), "moodboards::delete_in_store(project, moodboard_id) (the exact DB work of delete_moodboard: targeted board lookup + DELETE cascade of 64 images and 144 attachments); fresh copy each",
        || fx.open_copy("moodboard"),
        |copy| crate::moodboards::delete_in_store(copy.store(), project, &fx.moodboard_id).unwrap());
    let target = &fx.projects[DELETE_PROJECT];
    bench_with(table, "delete_project_cascade", (1, 15), "remove_project_with_team_check on a project of 25 tasks (the exact DB work of remove_project: active/malformed team check + cascade delete of teams, links, changes, schedules); fresh copy each",
        || fx.open_copy("project"),
        |copy| crate::remove_project_with_team_check(copy.store(), target).unwrap());
}

// Cost visibility: what version 38 adds to writes (last in `db_bench_all`, so before/after
// tables still line up row by row) and to the first launch (`db_bench_migration`).

/// The one object version 38 drops: version 13's index, superseded by `turn_changes_retained_bytes`
/// (its SQL as version 13 created it).
const V37_RETAINED_INDEX: &str = "CREATE INDEX IF NOT EXISTS turn_changes_retained ON turn_changes(created_at,id) WHERE diff_bytes>0;";

/// `(type, name, sql)` of every schema object, SQLite's internal ones left out.
fn schema(path: &std::path::Path) -> Vec<(String, String, Option<String>)> {
    let db = rusqlite::Connection::open(path).unwrap();
    let mut query = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type,name").unwrap();
    let rows = query.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    rows
}

/// Puts a copy of the (version 38) fixture back to version 37: drops exactly the objects version
/// 38 adds, recreates the one index it drops, and closes the connection (checkpointing its WAL).
/// Version 38 alters no table, so this is a version 37 schema.
fn revert_to_v37(path: &std::path::Path) {
    let db = rusqlite::Connection::open(path).unwrap();
    let mut batch = String::from("BEGIN;");
    for trigger in V38_TRACKER_TRIGGERS {
        batch.push_str(&format!("DROP TRIGGER {trigger};"));
    }
    for table in V38_TRACKER_TABLES {
        batch.push_str(&format!("DROP TABLE {table};"));
    }
    // The tracker tables' indexes went with their tables.
    for index in V38_SCHEMA_INDEXES.iter().chain(V38_BOT_INDEXES.iter()) {
        batch.push_str(&format!("DROP INDEX {index};"));
    }
    batch.push_str(V37_RETAINED_INDEX);
    batch.push_str("PRAGMA user_version=37; COMMIT;");
    db.execute_batch(&batch).unwrap();
    db.close().map_err(|(_, e)| e).unwrap();
}

/// The target serialized size of `architect_team_save_1mb`.
const TEAM_1MB_BYTES: usize = 1024 * 1024;

fn cost_cases(fx: &Fixture, table: &mut Table) {
    {
        let copy = fx.open_copy("team-save");
        let store = copy.store();
        fx.make_live(store);
        let mut team = crate::architect::load(store, &fx.active_teams[0]).unwrap().unwrap();
        assert!(team.config.council.is_none() && team.lead_failure.is_none());
        let kib = serde_json::to_string(&team).unwrap().len() as f64 / 1024.0;
        let note = format!("the real architect::save of a working team ({kib:.1} KiB snapshot, no Council or lead failure): stamp, refresh_council (no query without Council), serde_json::to_string, then one SAVEPOINT that sets its architect_team_meta row with skip_sync=1 and upserts the snapshot, so the update triggers parse no JSON for an existing team");
        bench(table, "architect_team_save", (3, 30), &note, || crate::architect::save(store, &mut team).unwrap());
        let mut big = crate::architect::load(store, &fx.active_teams[1]).unwrap().unwrap();
        let base = serde_json::to_string(&big).unwrap().len();
        let pad = TEAM_1MB_BYTES.saturating_sub(base) + big.objective.len();
        big.objective = fx.corpus.0.chars().cycle().take(pad).collect();
        crate::architect::save(store, &mut big).unwrap();
        store.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        let kib = serde_json::to_string(&big).unwrap().len() as f64 / 1024.0;
        let note = format!("architect::save of the second working team with its objective padded with corpus text to a {kib:.1} KiB snapshot (saved once untimed first): the same SAVEPOINT + skip_sync path, so the cost is serializing and writing the large row");
        bench(table, "architect_team_save_1mb", (3, 30), &note, || crate::architect::save(store, &mut big).unwrap());
    }
}

/// Once, untimed: the reverted copy has a version 37 schema, and the migration rebuilds the
/// version 38 schema exactly (same objects, same SQL).
fn assert_v37_round_trip(fx: &Fixture) {
    let check = fx.unopened_copy("v37-check");
    let v38 = schema(&check.path);
    revert_to_v37(&check.path);
    let v37 = schema(&check.path);
    let dropped = V38_SCHEMA_INDEXES.len() + V38_BOT_INDEXES.len() + V38_TRACKER_TABLES.len() + V38_TRACKER_INDEXES.len() + V38_TRACKER_TRIGGERS.len();
    assert_eq!(v37.len() + dropped, v38.len() + 1, "the revert drops only version 38's objects and restores turn_changes_retained");
    assert!(v37.iter().any(|(_, name, _)| name == "turn_changes_retained"));
    drop(Store::open(&check.path).unwrap());
    assert_eq!(schema(&check.path), v38, "the v37 to v38 migration must rebuild the fixture's schema");
}

fn file_mib(path: &std::path::Path) -> f64 { std::fs::metadata(path).unwrap().len() as f64 / 1048576.0 }

fn message_count(path: &std::path::Path) -> i64 {
    let db = rusqlite::Connection::open(path).unwrap();
    let count = db.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
    db.close().map_err(|(_, e)| e).unwrap();
    count
}

/// Compacts a database file and truncates its WAL, then closes it, so both migration scales start
/// from the same on-disk layout.
fn vacuum(path: &std::path::Path) {
    let db = rusqlite::Connection::open(path).unwrap();
    db.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    db.close().map_err(|(_, e)| e).unwrap();
}

/// Duplicates every `messages` row in one transaction, preserving usage limits and suffixing
/// tool ids so `messages_tool` stays unique.
fn double_messages(path: &std::path::Path) {
    let mut db = rusqlite::Connection::open(path).unwrap();
    let tx = db.transaction().unwrap();
    let count_limited = || tx.query_row("SELECT COUNT(*) FROM sessions WHERE limited_until IS NOT NULL", [], |r| r.get::<_, i64>(0)).unwrap();
    let limited_before = count_limited();
    assert!(limited_before > 0, "the migration fixture needs sessions with a usage limit reset");
    // The message-insert trigger clears limits on new user work. Restore the fixture's state
    // so both migration scales build sessions_limit_resume from the same input.
    tx.execute_batch(
        "CREATE TEMP TABLE saved_session_limits AS
         SELECT id, limited_at, limited_until, resume_at_reset FROM sessions
         WHERE limited_until IS NOT NULL OR limited_at IS NOT NULL OR resume_at_reset != 0;
         INSERT INTO messages(session_id,role,content,created_at,tool_id,turn_duration_ms,remote_cut)
         SELECT session_id,role,content,created_at,CASE WHEN tool_id IS NOT NULL THEN tool_id || '_2' END,turn_duration_ms,remote_cut FROM messages;
         UPDATE sessions
         SET (limited_at, limited_until, resume_at_reset) = (saved.limited_at, saved.limited_until, saved.resume_at_reset)
         FROM saved_session_limits AS saved WHERE sessions.id = saved.id;",
    ).unwrap();
    assert_eq!(count_limited(), limited_before, "2× message duplication must preserve usage limits");
    tx.commit().unwrap();
    db.close().map_err(|(_, e)| e).unwrap();
}

/// Times `Store::open` on fresh copies of the pre-reverted, `VACUUM`ed version 37 file `source`.
fn migration_case(fx: &Fixture, table: &mut Table, name: &str, source: &std::path::Path, note: &str) {
    bench_with(table, name, (1, 5), note,
        || {
            let path = fx.root.0.join(format!("copy-{:03}-{name}.db", fx.copies.get()));
            fx.copies.set(fx.copies.get() + 1);
            std::fs::copy(source, &path).unwrap();
            Copy { store: None, path }
        },
        |copy| Store::open(&copy.path).unwrap());
}

/// The version 37 to 38 migration at two scales. Both pristine files are reverted and `VACUUM`ed
/// untimed, so 1× and 2× differ only in size; both are removed right after their cases.
fn migration_cases(fx: &Fixture, table: &mut Table) {
    let v37_1x = fx.root.0.join("pristine-1x-v37.db");
    std::fs::copy(&fx.pristine, &v37_1x).unwrap();
    revert_to_v37(&v37_1x);
    vacuum(&v37_1x);
    let msgs_1x = message_count(&v37_1x);
    let v37_1x_mib = file_mib(&v37_1x);
    let v37_2x = fx.root.0.join("pristine-2x-v37.db");
    std::fs::copy(&v37_1x, &v37_2x).unwrap();
    double_messages(&v37_2x);
    let msgs_2x = message_count(&v37_2x);
    assert_eq!(msgs_2x, msgs_1x * 2, "every message row duplicated");
    vacuum(&v37_2x);
    let v37_2x_mib = file_mib(&v37_2x);
    let work = "bots::upgrade, the 22 version 38 indexes, drop turn_changes_retained, the 3 tracker tables running_tools/running_subagents/architect_team_meta with their 3 indexes and 9 triggers, and their backfill; one-time, runs synchronously in Store::open, scales with database size; fresh copy of a pre-reverted, VACUUMed file each";
    let note_1x = format!("Store::open on a version 37 copy ({v37_1x_mib:.1} MiB, {msgs_1x} messages): {work}");
    let note_2x = format!("Store::open on a version 37 copy with every message row duplicated ({v37_2x_mib:.1} MiB, {msgs_2x} messages; 1× is {v37_1x_mib:.1} MiB): {work}");
    // PANDACODE_BENCH_MIGRATION_ORDER=2x_first runs the 2× case first, so a series of runs can
    // alternate the order and cancel any bias from always running one scale second.
    let two_x_first = std::env::var("PANDACODE_BENCH_MIGRATION_ORDER").as_deref() == Ok("2x_first");
    println!("storage_bench migration order: {}", if two_x_first { "2x_first" } else { "1x_first" });
    let one_x = ("migration_v37_to_v38", &v37_1x, note_1x);
    let two_x = ("migration_v37_to_v38_2x", &v37_2x, note_2x);
    let order = if two_x_first { [two_x, one_x] } else { [one_x, two_x] };
    for (name, source, note) in &order {
        migration_case(fx, table, name, source, note);
    }
    remove_db(&v37_1x);
    remove_db(&v37_2x);
}

#[test]
#[ignore]
fn db_bench_all() {
    let started = Instant::now();
    let fixture = build_fixture();
    println!("\nstorage_bench fixture: {}", fixture.summary);
    let mut table = Table::new("Storage (file-backed SQLite, mature workspace)");
    startup_cases(&fixture, &mut table);
    read_cases(&fixture, &mut table);
    write_cases(&fixture, &mut table);
    destructive_cases(&fixture, &mut table);
    cost_cases(&fixture, &mut table);
    table.print();
    let root = fixture.root.0.clone();
    drop(fixture);
    assert!(!root.exists(), "temp dir must be removed");
    println!("\nstorage_bench total {:.1} s", started.elapsed().as_secs_f64());
}

#[test]
#[ignore]
fn db_bench_migration() {
    let started = Instant::now();
    let fixture = build_fixture();
    println!("\nstorage_bench fixture: {}", fixture.summary);
    assert_v37_round_trip(&fixture);
    let mut table = Table::new("Migration v37 to v38 (two scales)");
    migration_cases(&fixture, &mut table);
    table.print();
    let root = fixture.root.0.clone();
    drop(fixture);
    assert!(!root.exists(), "temp dir must be removed");
    println!("\nstorage_bench migration total {:.1} s", started.elapsed().as_secs_f64());
}
