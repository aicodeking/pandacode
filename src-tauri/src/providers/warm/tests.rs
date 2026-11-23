use super::*;
use super::key::*;
use super::spawn::*;
#[cfg(unix)]
use std::sync::atomic::{AtomicBool, Ordering};

#[test]
fn a_warm_agent_is_used_only_for_the_exact_launch_it_was_started_for() {
    let base = crate::providers::tests::config("claude");
    let tools = vec![json!({"type":"function","name":"pandacode_title"})];
    let original = key(&base, &tools);
    assert_eq!(original, key(&base.clone(), &tools));
    let changed = |edit: fn(&mut RunConfig)| { let mut config = base.clone(); edit(&mut config); key(&config, &tools) };
    for different in [
        changed(|c| c.model = "claude-sonnet-5-5".into()),
        changed(|c| c.mode = "full".into()),
        changed(|c| c.reasoning_effort = Some("high".into())),
        changed(|c| c.resume_id = Some("another".into())),
        changed(|c| c.instructions = "new".into()),
        key(&base, &[]),
        key_with(&base, &tools, "work#1"),
    ] {
        assert_ne!(different, original);
    }
    // A spare started before the telemetry switch changed is never adopted.
    super::super::privacy::FORCE.with(|force| force.set(Some(true)));
    assert_ne!(key(&base, &tools), original);
    super::super::privacy::FORCE.with(|force| force.set(None));
    // A different named connection, or a saved change to the same one, starts cold.
    for different in [key_with(&base, &tools, "personal#1"), key_with(&base, &tools, "work#2")] {
        assert_ne!(different, key_with(&base, &tools, "work#1"));
    }
    // Relays, goals and skills always start cold.
    assert!(supported(&base));
    // Relay spares are off (see `supported`).
    assert!(!supported(&crate::providers::tests::config("glm")));
    assert!(!supported(&crate::providers::tests::config("mimo")));
    assert!(!supported(&crate::providers::tests::config("codex")));
    assert!(!supported(&RunConfig { skill: Some(("review".into(), PathBuf::from("/skills/review"))), ..base.clone() }));
}

#[test]
fn turning_the_local_code_explorer_off_starts_the_next_turn_cold() {
    let base = crate::providers::tests::config("claude");
    // What a run sends for each setting: the tool in the catalog and its instruction clause.
    let launch = |enabled: bool| {
        let explore = crate::explore::run_name(false, enabled, &base.provider);
        let tools = if explore.is_some() { crate::explore::catalog() } else { Vec::new() };
        key(&RunConfig { instructions: crate::app_instructions(&crate::app_instructions::InstructionOptions { chat: false, role: crate::Role::Task, explore, tools: false, cloud: false }), ..base.clone() }, &tools)
    };
    assert_eq!(launch(true), launch(true));
    assert_ne!(launch(true), launch(false));
    assert!(!launch(false).contains("pandacode_explore"));
}

#[test]
fn switching_modes_changes_only_the_mode_field_of_the_warm_key() {
    // The cached instructions are the same in every mode, so the prompt prefix survives a
    // switch; only the process (whose command line carries the mode) starts cold.
    // Built as the launch builds them, for a run offered agent-made tools.
    let base = RunConfig { session_id: format!("warm-modes-{}", uuid::Uuid::new_v4()), ..crate::providers::tests::config("claude") };
    let launch = |mode: &str| {
        let config = RunConfig { mode: mode.into(), ..base.clone() };
        let instructions = crate::app_instructions::launch_instructions(&config, crate::Role::Task, None, true);
        key(&RunConfig { instructions, ..config }, &[])
    };
    for mode in ["auto", "review", "plan", "full"] {
        assert_eq!(miss(true, &launch("ask"), &launch(mode), Duration::from_secs(1), IDLE).as_deref(), Some("changed: mode"), "{mode}");
    }
}

#[test]
fn a_first_saved_tool_does_not_change_the_warm_key() {
    // The instructions and the agent-made tool specs are the same whether or not the project
    // has a tool; only the message note (not part of the key) differs.
    let dir = crate::custom_tools::temp();
    let base = crate::providers::tests::config("claude");
    let launch = || {
        let tools = crate::custom_tools::test_host(dir.0.clone(), "project", dir.0.clone(), "warm-tools", "ask").tools;
        let instructions = crate::app_instructions::launch_instructions(&base, crate::Role::Task, None, true);
        key(&RunConfig { instructions, ..base.clone() }, &tools)
    };
    let empty = launch();
    crate::custom_tools::test_save(&dir.0, "project", "build-app", "true");
    assert_eq!(launch(), empty);
}

#[test]
fn a_worker_trim_change_starts_the_next_turn_cold() {
    use crate::providers::WorkerTrim;
    let base = crate::providers::tests::config("claude");
    let with = |worker: Option<WorkerTrim>| key(&RunConfig { worker, ..base.clone() }, &[]);
    let trims = [
        None,
        Some(WorkerTrim { read_only: false, skills: false, trim: true }),
        Some(WorkerTrim { read_only: true, skills: false, trim: true }),
        Some(WorkerTrim { read_only: false, skills: true, trim: true }),
        Some(WorkerTrim { read_only: false, skills: true, trim: false }),
    ];
    for (i, a) in trims.iter().enumerate() {
        for b in &trims[i + 1..] {
            assert_ne!(with(*a), with(*b), "{a:?} vs {b:?}");
        }
    }
    let missed = miss(true, &with(None), &with(trims[1]), Duration::from_secs(1), IDLE);
    assert_eq!(missed.as_deref(), Some("changed: worker"));
}

#[test]
fn a_changed_deny_set_starts_the_next_turn_cold() {
    let base = crate::providers::tests::config("claude");
    let with = |denied: Option<&str>| key(&RunConfig { disallowed_tools: denied.map(str::to_owned), ..base.clone() }, &[]);
    let (a, b) = ("--disallowedTools=ScheduleWakeup,Monitor,CronCreate", "--disallowedTools=ScheduleWakeup,Monitor,CronCreate,Skill");
    assert_eq!(with(Some(a)), with(Some(a)));
    assert_ne!(with(Some(a)), with(Some(b)));
    assert_ne!(with(None), with(Some(a)));
    assert_eq!(miss(true, &with(Some(a)), &with(Some(b)), Duration::from_secs(1), IDLE).as_deref(), Some("changed: disallowedTools"));
}

#[test]
fn a_saved_agent_tool_keeps_the_warm_key() {
    // The catalog rides the message note, so saving a tool must not start the next turn cold.
    let base = crate::providers::tests::config("claude");
    let (tools, root) = (crate::custom_tools::temp(), crate::custom_tools::temp());
    let session = format!("warm-{}", uuid::Uuid::new_v4());
    let specs = || crate::custom_tools::test_host(tools.0.clone(), "p1", root.0.clone(), &session, "ask").tools;
    // An empty project is offered the same specs as one with tools: the first save keeps the key.
    let empty = key(&base, &specs());
    crate::custom_tools::test_save(&tools.0, "p1", "build-app", "echo built");
    assert_eq!(key(&base, &specs()), empty, "the first save");
    crate::custom_tools::test_save(&tools.0, "p1", "test-app", "echo tested");
    assert_eq!(key(&base, &specs()), empty, "a later save");
    crate::custom_tools::run_ended(&session);
}

#[cfg(unix)]
fn idle_spare(lead: bool, age: Duration) -> Spare {
    let mut command = Command::new("sleep");
    command.arg("30").kill_on_drop(true);
    let child = command.spawn().unwrap();
    let born = std::time::Instant::now().checked_sub(age).unwrap_or_else(std::time::Instant::now);
    Spare { key: "launch".into(), child, group: ProcessGroup::register(None), server: None, born, idle: IDLE, lead, cwd: None }
}

/// A pool of the test's own, so tests running in parallel never share spares.
#[cfg(unix)]
pub(super) fn own_pool() -> &'static Pool {
    Box::leak(Box::default())
}

#[cfg(unix)]
#[tokio::test]
async fn ordinary_tasks_never_evict_a_waiting_leads_spare() {
    let mut pool = Spares::default();
    let leads = |pool: &Spares| pool.spares.values().filter(|spare| spare.lead).count();
    admit(&mut pool, "lead-a".into(), idle_spare(true, Duration::from_secs(60)));
    for (i, age) in [30, 20, 10].into_iter().enumerate() {
        admit(&mut pool, format!("task-{i}"), idle_spare(false, Duration::from_secs(age)));
    }
    assert!(pool.spares.contains_key("lead-a"), "the lead's spare is outside the global limit");
    assert_eq!(pool.spares.values().filter(|spare| !spare.lead).count(), LIMIT, "ordinary tasks keep their own limit");
    assert!(!pool.spares.contains_key("task-0"), "the oldest ordinary spare goes first");
    // Lead spares have their own bounded pool: one per team, the oldest team's goes first.
    for (i, age) in [50, 40, 5].into_iter().enumerate() {
        admit(&mut pool, format!("lead-{i}"), idle_spare(true, Duration::from_secs(age)));
    }
    assert_eq!(leads(&pool), LEAD_LIMIT);
    assert!(!pool.spares.contains_key("lead-a"));
    assert!(pool.spares.len() <= LIMIT + LEAD_LIMIT, "the total stays bounded");
    // A team's next spare replaces its previous one.
    admit(&mut pool, "lead-2".into(), idle_spare(true, Duration::ZERO));
    assert_eq!(leads(&pool), LEAD_LIMIT);
    // Evicted lead spares are remembered for the adoption log; ordinary ones are not.
    assert_eq!(pool.gone.get("lead-a"), Some(&Gone::Evicted));
    assert!(!pool.gone.contains_key("task-0"));
}

#[cfg(unix)]
#[tokio::test]
async fn every_lead_spare_hit_and_miss_is_logged_with_its_reason() {
    let pool = own_pool();
    let base = crate::providers::tests::config("claude");
    let launch = key(&base, &[]);
    let with_key = |lead: bool, age: Duration, key: &str| Spare { key: key.into(), ..idle_spare(lead, age) };
    let id = |name: &str| format!("warm-log-{name}-{}", uuid::Uuid::new_v4());
    // Adopted.
    let hit = id("hit");
    admit(&mut spares(pool), hit.clone(), with_key(true, Duration::ZERO, &launch));
    let (spare, note) = take_in(pool, &hit, &launch);
    assert!(spare.is_some());
    assert_eq!(note.as_deref(), Some("Team lead's warm Claude agent adopted. Lead spares since launch: 1 adopted, 0 not used."));
    // A warm-key field differed: only the field names, never their values.
    let changed = id("changed");
    admit(&mut spares(pool), changed.clone(), with_key(true, Duration::ZERO, &launch));
    let next = key(&RunConfig { model: "claude-sonnet-5-5".into(), ..base.clone() }, &[]);
    let (spare, note) = take_in(pool, &changed, &next);
    assert!(spare.is_none());
    assert_eq!(note.as_deref(), Some("Team lead's warm Claude agent not used (changed: model); starting cold. Lead spares since launch: 1 adopted, 1 not used."));
    // Expired while still in the pool.
    let old = id("old");
    admit(&mut spares(pool), old.clone(), with_key(true, IDLE, &launch));
    assert_eq!(take_in(pool, &old, &launch).1.as_deref(), Some("Team lead's warm Claude agent not used (it expired); starting cold. Lead spares since launch: 1 adopted, 2 not used."));
    // Evicted by newer teams' spares.
    let evicted = id("evicted");
    admit(&mut spares(pool), evicted.clone(), with_key(true, Duration::from_secs(60), &launch));
    for _ in 0..LEAD_LIMIT {
        admit(&mut spares(pool), id("newer"), with_key(true, Duration::ZERO, &launch));
    }
    assert_eq!(take_in(pool, &evicted, &launch).1.as_deref(), Some("Team lead's warm Claude agent not used (it was evicted by a newer team's spare); starting cold. Lead spares since launch: 1 adopted, 3 not used."));
    // Discarded (settings changed, team paused or stopped).
    let discarded = id("discarded");
    admit(&mut spares(pool), discarded.clone(), with_key(true, Duration::ZERO, &launch));
    discard_from(pool, &discarded);
    assert_eq!(take_in(pool, &discarded, &launch).1.as_deref(), Some("Team lead's warm Claude agent not used (it was discarded); starting cold. Lead spares since launch: 1 adopted, 4 not used."));
    // Each reason is said once; a task that never had a lead spare logs nothing.
    assert_eq!(take_in(pool, &discarded, &launch).1, None);
    // An ordinary spare logs only its misses, as before.
    let plain = id("plain");
    admit(&mut spares(pool), plain.clone(), with_key(false, Duration::ZERO, &launch));
    assert_eq!(take_in(pool, &plain, &launch).1, None);
    admit(&mut spares(pool), plain.clone(), with_key(false, Duration::ZERO, &launch));
    assert_eq!(take_in(pool, &plain, &next).1.as_deref(), Some("Warm Claude agent not used (changed: model); starting cold."));
    // Ordinary spares never move the lead counters.
    let counts = spares(pool);
    assert_eq!((counts.lead_adopted, counts.lead_missed), (1, 4));
}

#[test]
fn an_expired_lead_spare_restarts_once_per_expiry_while_the_team_waits() {
    let waiting: Renew = Arc::new(|| true);
    let settled: Renew = Arc::new(|| false);
    assert!(renews(Some(&waiting), 4, 4, 0, true), "still waiting on workers: start a fresh spare");
    assert!(renews(Some(&waiting), 4, 4, MAX_RENEWALS - 1, true));
    assert!(!renews(Some(&waiting), 4, 4, MAX_RENEWALS, true), "renewals are bounded");
    assert!(!renews(Some(&waiting), 4, 5, 0, true), "the wake already launched: nothing to keep warm");
    assert!(!renews(Some(&settled), 4, 4, 0, true), "the team settled, finished or stopped");
    assert!(!renews(None, 4, 4, 0, true), "ordinary spares simply expire");
    assert!(!renews(Some(&waiting), 4, 4, 0, false), "its launch settings changed: it could never be adopted");
}

#[cfg(unix)]
#[tokio::test]
async fn a_spare_still_starting_when_its_task_is_discarded_never_registers() {
    let (pool, session) = (own_pool(), format!("warm-{}", uuid::Uuid::new_v4()));
    // A lead's prewarm (or renewal) reads the launch after a turn, then spends a while starting...
    launched(&session);
    let launch = epoch(&session);
    // ...while the team is paused or stopped (`architect_control`) and its spare discarded.
    discard_from(pool, &session);
    assert!(!register(pool, &session, launch, idle_spare(true, Duration::ZERO)), "the in-flight spare is dropped");
    assert!(!waiting_in(pool, &session), "no idle process is left behind");
    let waiting_lead: Renew = Arc::new(|| true);
    assert!(!renews(Some(&waiting_lead), launch, epoch(&session), 0, true), "and its expiry timer never renews it");
    // A spare started after the discard, for the current launch, is kept as usual.
    launched(&session); // a prewarm always follows a launch, never launch 0
    assert!(register(pool, &session, epoch(&session), idle_spare(true, Duration::ZERO)));
    assert!(waiting_in(pool, &session));
    discard_from(pool, &session);
    assert!(!waiting_in(pool, &session));
}

/// Spares the stub lifecycle started, per task.
#[cfg(unix)]
static STUB_STARTS: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// A stand-in for Claude Code: an idle `sleep` process, counted per task.
#[cfg(unix)]
fn stub_spawn(config: RunConfig, _: Vec<Value>, _: HashSet<String>, _: u64) -> Spawning {
    Box::pin(async move {
        *STUB_STARTS.lock().unwrap().entry(config.session_id.clone()).or_default() += 1;
        let mut command = Command::new("sleep");
        command.arg("30").kill_on_drop(true);
        let child = command.spawn().map_err(|error| error.to_string())?;
        Ok(Some(Spawned { key: "stub".to_owned(), child, group: ProcessGroup::register(None), server: None, starting: Pending::none() }))
    })
}

/// A lead's renewal check whose launch inputs never change.
#[cfg(unix)]
fn lead(renew: Renew) -> Option<Lead> {
    Some((renew, Arc::new(String::new)))
}

/// The stub lifecycle with a pool of its own.
#[cfg(unix)]
fn stub() -> Lifecycle {
    Lifecycle { idle: Duration::from_millis(400), spawn: stub_spawn, current: |_, _, _, _, _| true, pool: own_pool() }
}

#[cfg(unix)]
fn stub_starts(session: &str) -> u32 {
    STUB_STARTS.lock().unwrap().get(session).copied().unwrap_or(0)
}

/// Waits (up to 20 s) until `done` holds.
#[cfg(unix)]
async fn eventually(done: impl Fn() -> bool) -> bool {
    for _ in 0..400 {
        if done() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    done()
}

#[cfg(unix)]
#[tokio::test]
async fn an_expired_lead_spare_really_renews_then_the_chain_ends() {
    let session = format!("warm-renew-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    let asked = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let counter = asked.clone();
    let waiting_lead: Renew = Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        true
    });
    // A spare with a timer no stall can reach, so these checks never race its expiry.
    let holding = Lifecycle { idle: Duration::from_secs(3600), ..stub() };
    let held = format!("warm-held-{}", uuid::Uuid::new_v4());
    let held_config = RunConfig { session_id: held.clone(), ..config.clone() };
    launched(&held); // a prewarm always follows a launch, never launch 0
    start(holding, held_config, Vec::new(), HashSet::new(), epoch(&held), lead(waiting_lead.clone()), 0).await.unwrap();
    assert!(waiting_in(holding.pool, &held) && stub_starts(&held) == 1, "the first spare waits in the lead pool");
    assert!(spares(holding.pool).spares.get(&held).is_some_and(|spare| spare.lead));
    discard_from(holding.pool, &held);
    let life = stub();
    let waiting = |session: &str| waiting_in(life.pool, session);
    launched(&session); // a prewarm always follows a launch, never launch 0
    start(life, config, Vec::new(), HashSet::new(), epoch(&session), lead(waiting_lead), 0).await.unwrap();
    // It expires and starts again, MAX_RENEWALS times, then the chain ends with no process.
    assert!(eventually(|| stub_starts(&session) == 1 + MAX_RENEWALS).await, "renewed: {}", stub_starts(&session));
    assert!(eventually(|| !waiting(&session)).await, "the last spare expires for good");
    tokio::time::sleep(life.idle * 2).await;
    assert_eq!(stub_starts(&session), 1 + MAX_RENEWALS, "no renewal past the limit");
    assert_eq!(asked.load(Ordering::SeqCst), MAX_RENEWALS, "asked once per expiry that could renew");
    assert_eq!(MAX_RENEWALS, 2, "a lead holds an idle CLI for at most three idle windows");
}

#[cfg(unix)]
#[tokio::test]
async fn one_no_at_an_expiry_ends_the_renewals_for_good() {
    let session = format!("warm-renew-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    // A worker waits on the user when the spare expires; the user answers right after.
    let holds = Arc::new(AtomicBool::new(false));
    let check = holds.clone();
    let renew: Renew = Arc::new(move || check.load(Ordering::SeqCst));
    let life = stub();
    let waiting = |session: &str| waiting_in(life.pool, session);
    launched(&session); // a prewarm always follows a launch, never launch 0
    start(life, config, Vec::new(), HashSet::new(), epoch(&session), lead(renew), 0).await.unwrap();
    assert!(eventually(|| !waiting(&session)).await, "the spare expired");
    holds.store(true, Ordering::SeqCst);
    tokio::time::sleep(life.idle * 3).await;
    assert_eq!(stub_starts(&session), 1, "nothing asks again: the chain ended at the first no");
    assert!(!waiting(&session));
}

#[cfg(unix)]
#[tokio::test]
async fn a_lead_spare_whose_launch_settings_changed_is_not_renewed() {
    let session = format!("warm-renew-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    let waiting_lead: Renew = Arc::new(|| true);
    let life = Lifecycle { current: |_, _, _, _, _| false, ..stub() };
    launched(&session); // a prewarm always follows a launch, never launch 0
    start(life, config, Vec::new(), HashSet::new(), epoch(&session), lead(waiting_lead), 0).await.unwrap();
    assert!(eventually(|| !waiting_in(life.pool, &session)).await, "the spare expired");
    tokio::time::sleep(life.idle * 3).await;
    assert_eq!(stub_starts(&session), 1, "a stale spare is never started again");
}

#[cfg(unix)]
/// Threads the renewal check ran on (`a_lead_spares_renewal_check_runs_off_the_runtime_thread`).
static CHECK_THREADS: LazyLock<Mutex<Vec<std::thread::ThreadId>>> = LazyLock::new(|| Mutex::new(Vec::new()));

#[cfg(unix)]
#[tokio::test]
async fn a_lead_spares_renewal_check_runs_off_the_runtime_thread() {
    let session = format!("warm-renew-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    let runtime = std::thread::current().id();
    let renew: Renew = Arc::new(|| {
        CHECK_THREADS.lock().unwrap().push(std::thread::current().id());
        false
    });
    let life = Lifecycle {
        current: |_, _, _, _, _| {
            CHECK_THREADS.lock().unwrap().push(std::thread::current().id());
            true
        },
        ..stub()
    };
    launched(&session); // a prewarm always follows a launch, never launch 0
    start(life, config, Vec::new(), HashSet::new(), epoch(&session), lead(renew), 0).await.unwrap();
    // The current-thread test runtime runs the timer task on this thread; the check must not.
    assert!(eventually(|| CHECK_THREADS.lock().unwrap().len() >= 2).await, "the expiry asked both checks");
    assert!(CHECK_THREADS.lock().unwrap().iter().all(|thread| *thread != runtime));
    assert_eq!(stub_starts(&session), 1, "a no still ends the chain");
}

#[test]
fn a_renewal_is_current_only_while_its_warm_key_is_unchanged() {
    let base = crate::providers::tests::config("claude");
    let tools = vec![json!({"type":"function","name":"pandacode_title"})];
    let spare = key(&RunConfig { cwd: external_path(&base.cwd), ..base.clone() }, &tools);
    let inputs: Inputs = Arc::new(|| "explore:true tools:Some(false)".into());
    let current = |key: &str, tools: &[Value], spawned: &str| still_current(key, &base, tools, spawned, &inputs);
    assert!(current(&spare, &tools, "explore:true tools:Some(false)"));
    assert!(!current(&spare, &[], "explore:true tools:Some(false)"), "a changed tool catalog");
    // The explorer switch, agent-made tools or the instructions they shape changed since spawn.
    assert!(!current(&spare, &tools, "explore:false tools:Some(false)"), "changed launch inputs");
    // A setting read at spawn (here the telemetry switch) changing makes it stale.
    super::super::privacy::FORCE.with(|force| force.set(Some(!super::super::privacy::telemetry_off())));
    let stale = !current(&spare, &tools, "explore:true tools:Some(false)");
    super::super::privacy::FORCE.with(|force| force.set(None));
    assert!(stale);
}

#[cfg(unix)]
#[tokio::test]
async fn evicted_spares_are_handed_back_to_drop_outside_the_lock() {
    let mut pool = Spares::default();
    assert!(admit(&mut pool, "task-a".into(), idle_spare(false, Duration::from_secs(30))).is_empty());
    assert!(admit(&mut pool, "task-b".into(), idle_spare(false, Duration::from_secs(20))).is_empty());
    let evicted = admit(&mut pool, "task-c".into(), idle_spare(false, Duration::ZERO));
    assert_eq!(evicted.len(), 1);
    assert!(!pool.spares.contains_key("task-a"), "the oldest went: {:?}", pool.spares.keys().collect::<Vec<_>>());
}

#[cfg(unix)]
#[tokio::test]
async fn a_replaced_spare_is_handed_back_with_its_reason() {
    let mut pool = Spares::default();
    assert!(admit(&mut pool, "lead-a".into(), idle_spare(true, Duration::from_secs(10))).is_empty());
    let replaced = admit(&mut pool, "lead-a".into(), idle_spare(true, Duration::ZERO));
    assert_eq!(replaced.len(), 1, "the old spare is dropped by the caller, outside the lock");
    assert!(replaced[0].1.born < pool.spares["lead-a"].born, "the newer spare stays");
    assert_eq!(pool.gone.get("lead-a"), Some(&Gone::Replaced));
    assert_eq!(admit(&mut pool, "task-a".into(), idle_spare(false, Duration::ZERO)).len(), 0);
    assert_eq!(admit(&mut pool, "task-a".into(), idle_spare(false, Duration::ZERO)).len(), 1);
    assert!(!pool.gone.contains_key("task-a"), "ordinary spares keep no reason");
}

#[cfg(unix)]
#[tokio::test]
async fn discarding_a_task_drops_its_spare_and_launch_count() {
    let (pool, session) = (own_pool(), format!("warm-forget-{}", uuid::Uuid::new_v4()));
    launched(&session);
    let launch = epoch(&session);
    assert!(register(pool, &session, launch, idle_spare(true, Duration::ZERO)));
    discard_from(pool, &session);
    assert!(!waiting_in(pool, &session), "no idle process is left behind");
    assert!(!LAUNCHES.lock().unwrap().contains_key(&session), "the count is gone");
    assert!(!register(pool, &session, launch, idle_spare(true, Duration::ZERO)), "a spare still starting is dropped");
    launched(&session);
    assert_ne!(epoch(&session), launch, "a later launch never reuses a forgotten number");
}

#[cfg(unix)]
#[tokio::test]
async fn quiesce_leaves_no_spare_and_no_pending_exit() {
    let (pool, session) = (own_pool(), format!("warm-quiesce-{}", uuid::Uuid::new_v4()));
    let spare = idle_spare(false, Duration::ZERO);
    let pid = spare.child.id().unwrap();
    spares(pool).spares.insert(session.clone(), spare);
    quiesce_in(pool, &session).await.unwrap();
    assert!(!waiting_in(pool, &session), "no spare is left");
    assert!(process_gone(pid), "its process has exited");
    assert!(exit_registry().lock().unwrap().get(&session).is_none(), "no exit is pending");
}

#[cfg(unix)]
#[tokio::test]
async fn a_spare_that_read_launch_zero_after_a_discard_is_refused() {
    let (pool, session) = (own_pool(), format!("warm-zero-{}", uuid::Uuid::new_v4()));
    launched(&session);
    discard_from(pool, &session);
    assert_eq!(epoch(&session), 0, "the discard forgot the count");
    assert!(!register(pool, &session, 0, idle_spare(false, Duration::ZERO)), "0 == 0 must not pass");
    assert!(!waiting_in(pool, &session));
    let mut command = Command::new("true");
    assert!(spawn_when_current(&session, 0, async { Ok(()) }, &mut command, || false).await.unwrap().is_none());
}

#[test]
fn a_failed_renewal_is_logged_with_its_number() {
    assert_eq!(failure_note(0, "Claude Code is not installed"), "Could not prepare a warm Claude agent: Claude Code is not installed");
    let renewal = failure_note(2, "Claude Code is not installed");
    assert!(renewal.contains("renew the team lead's warm Claude agent") && renewal.contains(&format!("renewal 2 of {MAX_RENEWALS}")), "{renewal}");
    assert!(renewal.ends_with("Claude Code is not installed"));
}

#[test]
fn the_warm_key_reads_only_the_launch_not_the_message() {
    // `lead_spare::tests` compares every `RunConfig` input to these fields between a lead's spare and its wake.
    let base = crate::providers::tests::config("claude");
    let message = RunConfig { prompt: "Review the settled workers.".into(), images: vec![PathBuf::from("/tmp/shot.png")], ..base.clone() };
    assert_eq!(key(&base, &[]), key(&message, &[]));
    let field_names: Vec<String> = match serde_json::from_str::<Value>(&key(&base, &[])).unwrap() {
        Value::Object(fields) => fields.keys().cloned().collect(),
        _ => unreachable!(),
    };
    let mut config_fields = ["provider", "model", "effort", "mode", "cwd", "resume", "instructions", "tools", "fastMode", "worker", "disallowedTools"].map(String::from).to_vec();
    config_fields.extend(["namedConnection", "connection", "environment", "telemetryOff"].map(String::from));
    // Read from the session, provider and cwd, which a lead's spare and its wake share.
    config_fields.extend(["disabledSkills", "executable", "claudeConfig"].map(String::from));
    let (mut a, mut b) = (field_names, config_fields);
    a.sort();
    b.sort();
    assert_eq!(a, b, "a new key field must be added to the lead wake test too");
}

#[test]
fn a_missed_warm_agent_names_what_changed() {
    let base = crate::providers::tests::config("claude");
    let original = key(&base, &[]);
    let fresh = Duration::from_secs(1);
    assert_eq!(miss(true, &original, &original, fresh, IDLE), None);
    assert_eq!(miss(false, &original, &original, fresh, IDLE).as_deref(), Some("its process exited"));
    assert_eq!(miss(true, &original, &original, IDLE, IDLE).as_deref(), Some("it expired"));
    // A lifecycle with a shorter idle expires its spares at that idle, not at `IDLE`.
    let short = Duration::from_millis(50);
    assert_eq!(miss(true, &original, &original, short, short).as_deref(), Some("it expired"));
    assert_eq!(miss(true, &original, &original, Duration::from_millis(10), short), None);
    let next = key(&RunConfig { resume_id: Some("another".into()), model: "claude-sonnet-5-5".into(), ..base.clone() }, &[]);
    assert_eq!(miss(true, &original, &next, fresh, IDLE).as_deref(), Some("changed: model, resume"));
}

#[cfg(unix)]
#[tokio::test]
async fn a_mismatched_or_exited_warm_agent_is_discarded() {
    let spawn = || {
        let mut command = Command::new("sleep");
        command.arg("30").kill_on_drop(true);
        let child = command.spawn().unwrap();
        let group = ProcessGroup::register(None);
        (child, group)
    };
    let (pool, session) = (own_pool(), format!("warm-test-{}", uuid::Uuid::new_v4()));
    let insert = |child: Child, group: ProcessGroup| {
        spares(pool).spares.insert(session.clone(), Spare { key: "launch-a".into(), child, group, server: None, born: std::time::Instant::now(), idle: IDLE, lead: false, cwd: None });
    };
    let (child, group) = spawn();
    insert(child, group);
    assert!(take_in(pool, &session, "launch-b").0.is_none(), "a different launch starts cold");
    assert!(!waiting_in(pool, &session), "and the stale agent is gone");
    let (child, group) = spawn();
    insert(child, group);
    let mut adopted = take_in(pool, &session, "launch-a").0.expect("the matching agent is adopted");
    adopted.0.child.kill().await.unwrap();
    let (mut child, group) = spawn();
    child.kill().await.unwrap();
    child.wait().await.unwrap();
    insert(child, group);
    assert!(take_in(pool, &session, "launch-a").0.is_none(), "an agent that exited is never adopted");
    discard_from(pool, &session);
}

#[cfg(unix)]
fn process_gone(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as i32, 0) == -1 }
}

#[cfg(unix)]
#[tokio::test]
async fn a_missed_spare_is_gone_before_the_cold_launch_may_start() {
    let (pool, session) = (own_pool(), format!("warm-miss-{}", uuid::Uuid::new_v4()));
    let spare = idle_spare(false, Duration::ZERO);
    let pid = spare.child.id().unwrap();
    spares(pool).spares.insert(session.clone(), spare);
    assert!(take_in(pool, &session, "another launch").0.is_none());
    // The cold launch's `await_exit` returns only once the dropped spare has exited.
    await_exit(&session).await.unwrap();
    assert!(process_gone(pid), "the missed spare still runs after await_exit");
    assert!(!exit_registry().lock().unwrap().contains_key(&session), "the registry entry is released");
}

#[cfg(unix)]
#[tokio::test]
async fn a_discarded_spare_is_gone_before_the_console_may_resume_the_session() {
    let (pool, session) = (own_pool(), format!("warm-console-{}", uuid::Uuid::new_v4()));
    let spare = idle_spare(false, Duration::ZERO);
    let pid = spare.child.id().unwrap();
    spares(pool).spares.insert(session.clone(), spare);
    discard_from(pool, &session);
    assert!(!waiting_in(pool, &session));
    await_exit(&session).await.unwrap();
    assert!(process_gone(pid), "the console would have overlapped the spare");
    // Nothing left to wait for.
    await_exit(&session).await.unwrap();
}

#[cfg(unix)]
fn pid_of(spare: &Spare) -> u32 {
    spare.child.id().unwrap()
}

#[cfg(unix)]
#[tokio::test]
async fn a_refused_spare_is_gone_before_a_same_session_launch_may_start() {
    let (pool, session) = (own_pool(), format!("warm-refused-{}", uuid::Uuid::new_v4()));
    launched(&session);
    let launch = epoch(&session);
    launched(&session); // a newer launch began while the spare was starting
    let spare = idle_spare(false, Duration::ZERO);
    let pid = pid_of(&spare);
    assert!(!register(pool, &session, launch, spare));
    await_exit(&session).await.unwrap();
    assert!(process_gone(pid), "the refused spare still runs after await_exit");
    assert!(!exit_registry().lock().unwrap().contains_key(&session));
}

#[cfg(unix)]
#[tokio::test]
async fn replaced_and_evicted_spares_are_gone_before_their_sessions_may_launch() {
    let pool = own_pool();
    let id = |name: &str| format!("warm-{name}-{}", uuid::Uuid::new_v4());
    let (replaced, oldest, b, c) = (id("replaced"), id("oldest"), id("b"), id("c"));
    for session in [&replaced, &oldest, &b, &c] {
        launched(session);
    }
    // The first spare of `replaced` is pushed out by its own newer one.
    let first = idle_spare(false, Duration::from_secs(40));
    let first_pid = pid_of(&first);
    assert!(register(pool, &replaced, epoch(&replaced), first));
    assert!(register(pool, &replaced, epoch(&replaced), idle_spare(false, Duration::from_secs(39))));
    // `oldest` is then the oldest of three ordinary spares and leaves when `c` arrives.
    let old = idle_spare(false, Duration::from_secs(50));
    let old_pid = pid_of(&old);
    assert!(register(pool, &oldest, epoch(&oldest), old));
    assert!(register(pool, &b, epoch(&b), idle_spare(false, Duration::from_secs(10))));
    assert!(register(pool, &c, epoch(&c), idle_spare(false, Duration::ZERO)));
    assert!(!waiting_in(pool, &oldest));
    await_exit(&replaced).await.unwrap();
    await_exit(&oldest).await.unwrap();
    assert!(process_gone(first_pid), "the replaced spare outlived await_exit");
    assert!(process_gone(old_pid), "the evicted spare outlived await_exit");
    for session in [&replaced, &b, &c] {
        discard_from(pool, session);
        await_exit(session).await.unwrap();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn an_expired_spare_is_gone_before_its_session_may_launch() {
    let session = format!("warm-expiry-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    let life = stub();
    launched(&session); // a prewarm always follows a launch, never launch 0
    start(life, config, Vec::new(), HashSet::new(), epoch(&session), None, 0).await.unwrap();
    let pid = pid_of(spares(life.pool).spares.get(&session).unwrap());
    assert!(eventually(|| !waiting_in(life.pool, &session)).await, "the spare expires");
    // Expiry registers the exit in the same step as the removal; waiting makes sure it finished.
    assert!(eventually(|| process_gone(pid)).await, "the expired spare still runs");
    await_exit(&session).await.unwrap();
    assert!(!exit_registry().lock().unwrap().contains_key(&session));
}

#[cfg(unix)]
#[tokio::test]
async fn a_launch_without_a_spare_retires_the_pooled_one() {
    let _serial = spare_pool_test_lock().lock().await;
    let session = format!("warm-hostless-{}", uuid::Uuid::new_v4());
    let spare = idle_spare(false, Duration::ZERO);
    let pid = pid_of(&spare);
    spares(&SPARES).spares.insert(session.clone(), spare);
    launched_without_spare(&session);
    assert!(!waiting_in(&SPARES, &session), "the spare idles beside the cold process");
    await_exit(&session).await.unwrap();
    assert!(process_gone(pid));
}

#[tokio::test]
async fn a_spare_never_spawns_once_the_app_is_quitting() {
    let session = format!("warm-quit-{}", uuid::Uuid::new_v4());
    launched(&session);
    let launch = epoch(&session);
    let mut command = Command::new("true");
    let spawned = spawn_when_current(&session, launch, async { Ok(()) }, &mut command, || true).await.unwrap();
    assert!(spawned.is_none(), "a spare waiting on an exit must not start after quit begins");
}

#[cfg(unix)]
#[tokio::test]
async fn a_spare_whose_launch_moved_during_its_exit_wait_never_spawns() {
    let session = "moved-during-exit-wait";
    launched(session);
    let launch = epoch(session);
    let mut command = Command::new("sleep");
    command.arg("30").kill_on_drop(true);
    let follow_up = async { launched(session); Ok(()) };
    let spawned = spawn_when_current(session, launch, follow_up, &mut command, || false).await.unwrap();
    assert!(spawned.is_none(), "a stale spare must not start a process");
    let current = epoch(session);
    let spawned = spawn_when_current(session, current, async { Ok(()) }, &mut command, || false).await.unwrap();
    let (mut child, _starting) = spawned.expect("a current spare spawns");
    child.kill().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn an_exit_wait_started_during_a_spares_spawn_waits_until_the_spare_is_gone() {
    let session = format!("warm-spawn-window-{}", uuid::Uuid::new_v4());
    launched(&session);
    let launch = epoch(&session);
    let mut command = Command::new("sleep");
    command.arg("30").kill_on_drop(true);
    let (child, starting) = spawn_when_current(&session, launch, async { Ok(()) }, &mut command, || false).await.unwrap().expect("a current spare spawns");
    let pid = child.id().unwrap();
    // A launch or the console lands after the spawn, before the spare is registered.
    let waiter = tokio::spawn({
        let session = session.clone();
        async move { await_exit(&session).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!waiter.is_finished(), "the wait found nothing to wait on while the spare was starting");
    // That launch moved the epoch, so the spare is refused and killed.
    launched(&session);
    let spare = Spare { key: "k".into(), child, group: ProcessGroup::register(Some(pid)), server: None, born: std::time::Instant::now(), idle: IDLE, lead: false, cwd: None };
    assert!(!register(own_pool(), &session, launch, spare), "a spare from an older launch is refused");
    drop(starting);
    tokio::time::timeout(Duration::from_secs(10), waiter).await.unwrap().unwrap().unwrap();
    assert!(process_gone(pid), "the wait ended before the spare's process was gone");
}

#[cfg(unix)]
#[tokio::test]
async fn a_spare_whose_adoption_fails_is_retired_and_awaited() {
    let session = format!("failed-adopt-{}", std::process::id());
    let spare = idle_spare(false, Duration::ZERO);
    let pid = spare.child.id().unwrap();
    // Taken for adoption, then the launch failed before it owned the streams.
    let adopting = Adopting { session_id: session.clone(), spare: Some((spare, Pending::none())) };
    drop(adopting);
    assert!(exit_registry().lock().unwrap().contains_key(&session), "the failed adopt registered no exit");
    tokio::time::timeout(Duration::from_secs(10), await_exit(&session)).await.unwrap().unwrap();
    assert!(process_gone(pid), "the next launch would have started beside the dying spare");
}

#[test]
fn skill_manager_disabled_skills_invalidate_a_warm_launch() {
    let config = crate::providers::tests::config("claude");
    let none = std::collections::BTreeSet::new();
    let disabled = std::collections::BTreeSet::from(["alpha".into()]);
    assert_ne!(key_with_disabled(&config, &[], "", &none), key_with_disabled(&config, &[], "", &disabled));
}

#[test]
fn claude_config_file_edits_invalidate_a_warm_launch() {
    let cwd = std::env::temp_dir().join(format!("pandacode-warm-config-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(cwd.join(".claude")).unwrap();
    let mut config = crate::providers::tests::config("claude");
    config.cwd = cwd.clone();
    let none = std::collections::BTreeSet::new();
    let key = || key_with_disabled(&config, &[], "", &none);
    let mut previous = key();
    assert_eq!(previous, key(), "unchanged config files keep the key");
    // Every write changes the byte length, so coarse mtime granularity cannot hide it.
    for (name, contents) in [
        (".mcp.json", "{}"),
        (".mcp.json", r#"{"mcpServers":{}}"#),
        (".claude/settings.json", "{}"),
        (".claude/settings.json", r#"{"model":"x"}"#),
        ("CLAUDE.md", "a"),
        ("CLAUDE.md", "ab"),
    ] {
        std::fs::write(cwd.join(name), contents).unwrap();
        let next = key();
        assert_ne!(next, previous, "writing {name} must start the next turn cold");
        previous = next;
    }
    std::fs::remove_file(cwd.join("CLAUDE.md")).unwrap();
    assert_ne!(key(), previous, "removing CLAUDE.md must start the next turn cold");
    let _ = std::fs::remove_dir_all(&cwd);
}

/// Write `contents` to `root/name`, creating its folders.
fn write_config(root: &Path, name: &str, contents: &str) {
    let path = root.join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

#[test]
fn claude_local_memory_rules_agents_and_commands_edits_invalidate_a_warm_launch() {
    let cwd = std::env::temp_dir().join(format!("pandacode-warm-config-dirs-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(cwd.join(".claude")).unwrap();
    let mut config = crate::providers::tests::config("claude");
    config.cwd = cwd.clone();
    let none = std::collections::BTreeSet::new();
    let key = || key_with_disabled(&config, &[], "", &none);
    let mut previous = key();
    // Every write changes the byte length, so coarse mtime granularity cannot hide it.
    for name in ["CLAUDE.local.md", ".claude/rules/common/style.md", ".claude/agents/reviewer.md", ".claude/commands/check.md"] {
        for contents in ["a", "ab"] {
            write_config(&cwd, name, contents);
            let next = key();
            assert_ne!(next, previous, "writing {name} must start the next turn cold");
            previous = next;
        }
    }
    std::fs::remove_file(cwd.join(".claude/rules/common/style.md")).unwrap();
    assert_ne!(key(), previous, "removing a nested rule must start the next turn cold");
    let _ = std::fs::remove_dir_all(&cwd);
}

#[test]
fn a_named_connections_claude_folder_is_fingerprinted_instead_of_the_global_one() {
    let root = std::env::temp_dir().join(format!("pandacode-warm-connection-{}", uuid::Uuid::new_v4().simple()));
    let (cwd, global, own, by_env) = (root.join("project"), root.join("global"), root.join("own"), root.join("by-env"));
    for dir in [&cwd, &global, &own, &by_env] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let text = |path: &Path| path.to_string_lossy().into_owned();
    let provider_env = vec![("CLAUDE_CONFIG_DIR".to_string(), text(&global))];
    assert_eq!(claude_config_dir_from(provider_env.clone(), None, &cwd), Some(global.clone()));
    let folder = crate::connections::Connection {
        id: "work".into(),
        provider: "claude".into(),
        name: "Work".into(),
        config_dir: Some(text(&own)),
        ..Default::default()
    };
    assert_eq!(claude_config_dir_from(provider_env.clone(), Some(&folder), &cwd), Some(own.clone()));
    let env = |value: String| std::collections::BTreeMap::from([("CLAUDE_CONFIG_DIR".to_string(), value)]);
    let variable = crate::connections::Connection { config_dir: None, env: env(text(&by_env)), ..folder.clone() };
    assert_eq!(claude_config_dir_from(provider_env.clone(), Some(&variable), &cwd), Some(by_env.clone()));
    // The connection's own folder is applied after its variables, as at launch.
    let both = crate::connections::Connection { env: env(text(&by_env)), ..folder.clone() };
    assert_eq!(claude_config_dir_from(provider_env.clone(), Some(&both), &cwd), Some(own.clone()));
    // A relative folder resolves against the working folder the process starts in.
    let relative = crate::connections::Connection { config_dir: None, env: env("connection-config".into()), ..folder.clone() };
    assert_eq!(claude_config_dir_from(provider_env.clone(), Some(&relative), &cwd), Some(cwd.join("connection-config")));

    let user = claude_config_dir_from(provider_env, Some(&folder), &cwd).unwrap();
    let stamp = || claude_config_fingerprint_with(&cwd, Some(&user), None, &[]);
    let mut previous = stamp();
    write_config(&global, "settings.json", "{}");
    write_config(&global, "rules/common/rule.md", "a");
    assert_eq!(stamp(), previous, "the global folder is not this connection's");
    for (name, contents) in [("settings.json", "{}"), ("settings.json", "{ }"), ("rules/common/rule.md", "a"), ("rules/common/rule.md", "ab")] {
        write_config(&own, name, contents);
        let next = stamp();
        assert_ne!(next, previous, "writing {name} in the connection's folder must start the next turn cold");
        previous = next;
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn a_config_folder_walk_follows_symlinked_folders_once_and_is_capped() {
    let root = std::env::temp_dir().join(format!("pandacode-warm-walk-{}", uuid::Uuid::new_v4().simple()));
    let skills = root.join("skills");
    let external = root.join("external");
    std::fs::create_dir_all(skills.join("a")).unwrap();
    write_config(&external, "SKILL.md", "a");
    std::os::unix::fs::symlink(&skills, skills.join("a/loop")).unwrap();
    std::os::unix::fs::symlink(&external, skills.join("linked")).unwrap();
    let paths = |stamp: &Value| -> Vec<String> {
        stamp.as_array().unwrap().iter().filter_map(|item| item.get(0).and_then(Value::as_str).map(str::to_owned)).collect()
    };
    let before = config_dir_stamp(&skills);
    let walked = paths(&before);
    assert!(walked.contains(&"a/loop".to_string()));
    assert!(!walked.iter().any(|path| path.starts_with("a/loop/")), "a link back to a visited folder is not walked: {walked:?}");
    assert!(walked.contains(&"linked/SKILL.md".to_string()), "a symlinked skill folder is walked: {walked:?}");
    write_config(&external, "SKILL.md", "ab");
    assert_ne!(config_dir_stamp(&skills), before, "editing a linked skill in place must start the next turn cold");
    for index in 0..140 {
        std::fs::write(skills.join(format!("f{index:03}.md")), "x").unwrap();
    }
    let capped = config_dir_stamp(&skills);
    assert_eq!(capped.as_array().unwrap().last(), Some(&json!("capped")));
    assert!(capped.as_array().unwrap().len() <= 128 + 2, "the entry cap holds");
    assert_eq!(config_dir_stamp(&skills), capped, "a capped walk is deterministic");
    assert_eq!(config_dir_stamp(&root.join("missing")), Value::Null);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn agents_md_ancestor_and_main_checkout_config_edits_invalidate_a_warm_launch() {
    let root = std::env::temp_dir().join(format!("pandacode-warm-roots-{}", uuid::Uuid::new_v4().simple()));
    let repo = root.join("repo");
    let nested = repo.join("src/deep");
    std::fs::create_dir_all(repo.join(".git")).unwrap();
    std::fs::create_dir_all(&nested).unwrap();
    let user = root.join("user");
    let home = root.join("home/.claude");
    let stamp = |cwd: &Path| claude_config_fingerprint_with(cwd, Some(&user), Some(&home), &[]);
    let mut previous = stamp(&nested);
    for (name, contents) in [("AGENTS.md", "a"), ("AGENTS.md", "ab"), (".claude/settings.json", "{}"), ("CLAUDE.md", "a")] {
        write_config(&repo, name, contents);
        let next = stamp(&nested);
        assert_ne!(next, previous, "writing the repository root's {name} must start a nested launch cold");
        previous = next;
    }
    write_config(&nested, "AGENTS.md", "a");
    assert_ne!(stamp(&nested), previous, "writing AGENTS.md in the working folder must start the next turn cold");

    for (parent, name) in [
        (&root, "CLAUDE.md"),
        (&root, ".claude/rules/common/rule.md"),
        (&home, "CLAUDE.md"),
        (&home, "rules/common/rule.md"),
    ] {
        write_config(parent, name, "a");
        let before = stamp(&nested);
        write_config(parent, name, "ab");
        assert_ne!(
            stamp(&nested),
            before,
            "writing {parent:?}/{name} must start the next turn cold"
        );
    }

    // A linked worktree inherits configuration from its main checkout.
    let main = root.join("main");
    let gitdir = main.join(".git/worktrees/wt");
    let worktree = root.join("wt");
    std::fs::create_dir_all(&gitdir).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(main.join(".git/config"), "[core]\n bare = false\n").unwrap();
    std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
    std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
    let mut previous = stamp(&worktree);
    for (name, contents) in [
        (".claude/settings.local.json", "{}"),
        (".claude/settings.local.json", "{ }"),
        (".claude/rules/rule.md", "a"),
        (".claude/rules/rule.md", "ab"),
    ] {
        write_config(&main, name, contents);
        let next = stamp(&worktree);
        assert_ne!(next, previous, "writing the main checkout's {name} must start a worktree launch cold");
        previous = next;
    }
    for name in [
        "AGENTS.md",
        "CLAUDE.md",
        "CLAUDE.local.md",
        ".claude/CLAUDE.md",
        ".mcp.json",
    ] {
        write_config(&main, name, "a");
        assert_eq!(
            stamp(&worktree),
            previous,
            "writing the main checkout's {name} must preserve the warm key"
        );
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn claude_config_paths_match_the_permission_policy_resolver() {
    let cwd = std::env::temp_dir().join("pandacode-warm-config-cwd");
    let absolute = cwd.join("absolute");
    for (value, expected) in [
        (absolute.to_string_lossy().into_owned(), absolute),
        ("relative".into(), cwd.join("relative")),
        ("~/x".into(), cwd.join("~").join("x")),
    ] {
        let env = vec![("CLAUDE_CONFIG_DIR".into(), value)];
        let policy = crate::turn_changes::resolve_claude_config_dir_env(&env, &cwd, cfg!(windows));
        assert_eq!(policy, Some(expected));
        assert_eq!(claude_config_dir_from(env, None, &cwd), policy);
    }
}

#[test]
fn claude_config_dir_names_match_case_insensitively_when_asked() {
    let root = std::env::temp_dir().join(format!("pandacode-warm-case-{}", uuid::Uuid::new_v4().simple()));
    let (cwd, mixed, lower) = (root.join("project"), root.join("mixed"), root.join("lower"));
    let text = |path: &Path| path.to_string_lossy().into_owned();
    let provider_env = vec![("Claude_Config_Dir".to_string(), text(&mixed))];
    assert_eq!(claude_config_dir_from_with(provider_env.clone(), None, &cwd, true), Some(mixed.clone()));
    assert_ne!(claude_config_dir_from_with(provider_env.clone(), None, &cwd, false), Some(mixed.clone()));
    let connection = crate::connections::Connection {
        id: "work".into(),
        provider: "claude".into(),
        name: "Work".into(),
        env: std::collections::BTreeMap::from([("claude_config_dir".to_string(), text(&lower))]),
        ..Default::default()
    };
    // The connection's variables come after the saved environment, so the last one wins.
    assert_eq!(claude_config_dir_from_with(provider_env.clone(), Some(&connection), &cwd, true), Some(lower.clone()));
    let relative = crate::connections::Connection {
        env: std::collections::BTreeMap::from([("CLAUDE_config_DIR".to_string(), "rel".to_string())]),
        ..connection.clone()
    };
    assert_eq!(claude_config_dir_from_with(provider_env, Some(&relative), &cwd, true), Some(cwd.join("rel")));
}

#[test]
fn skill_manager_warm_spare_applies_the_same_skill_instructions_as_a_cold_launch() {
    let disabled = std::collections::BTreeSet::from(["Friendly skill".into()]);
    let base = crate::providers::tests::config("claude");
    // Cold path: run_inner applies the reminder, then keys the launch.
    let mut cold = base.clone();
    crate::skill_manager::apply_instructions(&mut cold, &disabled);
    let spare = prepared(base.clone(), &disabled);
    assert!(spare.instructions.contains("Friendly skill"));
    assert_eq!(key_with_disabled(&spare, &[], "", &disabled), key_with_disabled(&cold, &[], "", &disabled));
    // Applying twice (spare prepared, then adopted by run_inner) changes nothing.
    assert_eq!(prepared(spare.clone(), &disabled).instructions, spare.instructions);
    let mut command = Command::new("claude");
    configure_command_with_skills(&mut command, &spare, &disabled);
    let args: Vec<_> = command.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
    assert!(args.windows(2).any(|a| a[0] == "--append-system-prompt" && a[1].contains("Friendly skill")));
}

#[cfg(unix)]
#[tokio::test]
async fn quiesce_during_discard_gap_waits_for_the_retired_process_to_exit() {
    let (pool, session) = (own_pool(), format!("warm-discard-gap-{}", uuid::Uuid::new_v4()));
    launched(&session);
    let mut spare = idle_spare(false, Duration::ZERO);
    let cwd = PathBuf::from("/tmp/pandacode-discard-cwd");
    spare.cwd = Some(cwd.clone());
    let pid = pid_of(&spare);
    assert!(register(pool, &session, epoch(&session), spare));
    // Discard has removed the spare from the pool, but has not retired it yet.
    let (spare, pending) = take_for_discard(pool, &session).expect("spare removed by discard");
    assert!(super::super::exit::pending_exits().iter().any(|(id, dir)| id == &session && dir.as_ref() == Some(&cwd)));
    let waiter = tokio::spawn({
        let session = session.clone();
        async move { quiesce_in(pool, &session).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!waiter.is_finished(), "quiesce returned before the discarded spare retired and exited");
    assert!(!process_gone(pid), "spare process should still be alive before retire");
    retire(&session, spare, pending);
    tokio::time::timeout(Duration::from_secs(5), waiter).await.unwrap().unwrap().unwrap();
    assert!(process_gone(pid), "quiesce returned before the spare process exited");
    assert!(!exit_registry().lock().unwrap().contains_key(&session));
}

#[cfg(unix)]
#[tokio::test]
async fn quiesce_during_expiry_gap_waits_for_the_retired_process_to_exit() {
    let (pool, session) = (own_pool(), format!("warm-expiry-gap-{}", uuid::Uuid::new_v4()));
    launched(&session);
    let spare = idle_spare(false, Duration::ZERO);
    let born = spare.born;
    let pid = pid_of(&spare);
    assert!(register(pool, &session, epoch(&session), spare));
    let (expired, pending) = take_expired(pool, &session, born).expect("spare removed by expiry");
    let waiter = tokio::spawn({
        let session = session.clone();
        async move { quiesce_in(pool, &session).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!waiter.is_finished(), "quiesce returned before the expired spare retired and exited");
    assert!(!process_gone(pid));
    retire(&session, expired, pending);
    tokio::time::timeout(Duration::from_secs(5), waiter).await.unwrap().unwrap().unwrap();
    assert!(process_gone(pid));
    assert!(!exit_registry().lock().unwrap().contains_key(&session));
}

#[cfg(unix)]
#[tokio::test]
async fn quiesce_during_eviction_gap_waits_for_the_retired_process_to_exit() {
    let pool = own_pool();
    let id = |name: &str| format!("warm-evict-gap-{name}-{}", uuid::Uuid::new_v4());
    let (oldest, b, c) = (id("oldest"), id("b"), id("c"));
    for session in [&oldest, &b, &c] {
        launched(session);
    }
    let old = idle_spare(false, Duration::from_secs(50));
    let old_pid = pid_of(&old);
    assert!(register(pool, &oldest, epoch(&oldest), old));
    assert!(register(pool, &b, epoch(&b), idle_spare(false, Duration::from_secs(10))));
    let evicted = admit(&mut spares(pool), c.clone(), idle_spare(false, Duration::ZERO));
    assert_eq!(evicted.len(), 1);
    assert_eq!(evicted[0].0, oldest);
    let waiter = tokio::spawn({
        let oldest = oldest.clone();
        async move { quiesce_in(pool, &oldest).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!waiter.is_finished(), "quiesce returned before the evicted spare retired and exited");
    assert!(!process_gone(old_pid));
    for (session, spare, pending) in evicted {
        retire(&session, spare, pending);
    }
    tokio::time::timeout(Duration::from_secs(5), waiter).await.unwrap().unwrap().unwrap();
    assert!(process_gone(old_pid));
    assert!(!exit_registry().lock().unwrap().contains_key(&oldest));
    for session in [&b, &c] {
        quiesce_in(pool, session).await.unwrap();
    }
}

#[tokio::test]
async fn pending_exits_exposes_and_clears_cwd() {
    let session = format!("warm-pending-cwd-{}", uuid::Uuid::new_v4());
    let cwd = PathBuf::from("/tmp/pandacode-pending-cwd");
    let guard = pending_in_cwd(&session, Some(cwd.clone()));
    assert!(super::super::exit::pending_exits().iter().any(|(id, dir)| id == &session && dir.as_ref() == Some(&cwd)));
    drop(guard);
    await_exit(&session).await.unwrap();
    assert!(!super::super::exit::pending_exits().iter().any(|(id, _)| id == &session));
}

#[test]
fn toggling_claude_fast_mode_changes_the_warm_key_identically_to_the_cli_flag() {
    let cli_has_fast_flag = |cfg: &RunConfig| {
        let mut command = Command::new("claude");
        configure_command(&mut command, cfg);
        let args: Vec<_> = command.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        args.windows(2).any(|pair| pair == ["--settings", r#"{"fastMode":true}"#])
    };
    let with = |provider: &str, settings: Option<Value>| RunConfig {
        codex_settings: settings,
        ..crate::providers::tests::config(provider)
    };
    let standard = with("claude", None);
    let toggled_off = with("claude", Some(json!({"serviceTier": null})));
    let other_tier = with("claude", Some(json!({"serviceTier": "standard"})));
    let fast = with("claude", Some(json!({"serviceTier": "fast"})));
    let relay_fast = with("glm", Some(json!({"serviceTier": "fast"})));
    // `claude_fast_mode` matches `configure_command` identically across every shape.
    for cfg in [&standard, &toggled_off, &other_tier, &fast, &relay_fast] {
        assert_eq!(claude_fast_mode(cfg), cli_has_fast_flag(cfg), "{:?}", cfg.codex_settings);
    }
    assert!(claude_fast_mode(&fast));
    assert!(!claude_fast_mode(&standard));
    assert!(!claude_fast_mode(&toggled_off));
    assert!(!claude_fast_mode(&relay_fast));
    // Standard speed variants share one key; fast mode produces a distinct key.
    let standard_key = key(&standard, &[]);
    let off_key = key(&toggled_off, &[]);
    let fast_key = key(&fast, &[]);
    assert_eq!(standard_key, off_key);
    assert_eq!(standard_key, key(&other_tier, &[]));
    assert_ne!(standard_key, fast_key);
    assert_eq!(miss(true, &standard_key, &fast_key, Duration::from_secs(1), IDLE).as_deref(), Some("changed: fastMode"));
    assert_eq!(miss(true, &fast_key, &off_key, Duration::from_secs(1), IDLE).as_deref(), Some("changed: fastMode"));
}

#[cfg(unix)]
#[tokio::test]
async fn a_warm_spare_is_never_adopted_across_a_claude_fast_mode_toggle() {
    let pool = own_pool();
    let session = format!("warm-fast-mode-{}", uuid::Uuid::new_v4());
    let base = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    let standard_key = key(&base, &[]);
    let off_key = key(&RunConfig { codex_settings: Some(json!({"serviceTier": null})), ..base.clone() }, &[]);
    let fast_key = key(&RunConfig { codex_settings: Some(json!({"serviceTier": "fast"})), ..base.clone() }, &[]);
    let insert = |lead: bool, spare_key: &str| {
        let spare = Spare { key: spare_key.into(), ..idle_spare(lead, Duration::ZERO) };
        let pid = pid_of(&spare);
        spares(pool).spares.insert(session.clone(), spare);
        pid
    };
    // Toggling Fast mode ON never adopts a standard-speed spare.
    let pid = insert(false, &standard_key);
    let (adopted, note) = take_in(pool, &session, &fast_key);
    assert!(adopted.is_none());
    assert_eq!(note.as_deref(), Some("Warm Claude agent not used (changed: fastMode); starting cold."));
    assert!(!waiting_in(pool, &session));
    await_exit(&session).await.unwrap();
    assert!(process_gone(pid));
    // Toggling Fast mode OFF never adopts a fast-mode spare (which would overbill the next turn).
    let pid = insert(false, &fast_key);
    let (adopted, note) = take_in(pool, &session, &off_key);
    assert!(adopted.is_none());
    assert_eq!(note.as_deref(), Some("Warm Claude agent not used (changed: fastMode); starting cold."));
    assert!(!waiting_in(pool, &session));
    await_exit(&session).await.unwrap();
    assert!(process_gone(pid));
    // A lead spare also refuses a fast-mode mismatch and reports the field name.
    let pid = insert(true, &fast_key);
    let (adopted, note) = take_in(pool, &session, &off_key);
    assert!(adopted.is_none());
    assert!(note.as_deref().is_some_and(|line| line.contains("Team lead's warm Claude agent not used (changed: fastMode)")), "{note:?}");
    await_exit(&session).await.unwrap();
    assert!(process_gone(pid));
    // Matching fast mode adopts cleanly, and standard None <-> serviceTier:null adopts cleanly.
    insert(false, &fast_key);
    let (adopted, note) = take_in(pool, &session, &fast_key);
    assert!(note.is_none());
    let (mut spare, _pending) = adopted.expect("matching fast-mode spare is adopted");
    spare.child.kill().await.unwrap();
    insert(false, &standard_key);
    let (adopted, note) = take_in(pool, &session, &off_key);
    assert!(note.is_none());
    let (mut spare, _pending) = adopted.expect("standard None and serviceTier:null share one warm key");
    spare.child.kill().await.unwrap();
}

#[test]
fn path_in_folder_matches_canonical_nested_and_deleted_folders() {
    let base = std::env::temp_dir().join(format!("pandacode-warm-path-{}", uuid::Uuid::new_v4().simple()));
    let folder = base.join("wt");
    let nested = folder.join("sub/dir");
    let sibling = base.join("wt-other");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::create_dir_all(&sibling).unwrap();

    let resolved = resolve_path(&folder);
    assert!(path_in_folder(&folder, &folder, &resolved));
    assert!(path_in_folder(&folder.join("."), &folder, &resolved));
    assert!(path_in_folder(&nested, &folder, &resolved));
    assert!(!path_in_folder(&sibling, &folder, &resolved));

    // After the leaf directory disappears (e.g. `recreate_worktree`), canonicalizing the deepest
    // existing ancestor still matches canonical and non-canonical spellings of the deleted folder.
    let canonical_folder = folder.canonicalize().unwrap();
    let canonical_nested = nested.canonicalize().unwrap();
    std::fs::remove_dir_all(&folder).unwrap();
    let deleted_resolved = resolve_path(&folder);
    assert!(path_in_folder(&canonical_folder, &folder, &deleted_resolved));
    assert!(path_in_folder(&canonical_nested, &folder, &deleted_resolved));
    assert!(!path_in_folder(&sibling, &folder, &deleted_resolved));

    let _ = std::fs::remove_dir_all(base);
}

#[cfg(unix)]
#[tokio::test]
async fn invalidating_a_running_turn_advances_epoch_retires_stale_spare_and_allows_post_turn_prewarm() {
    let pool = own_pool();
    let never = format!("warm-never-{}", uuid::Uuid::new_v4());
    // Invalidating a task that has never launched does not insert a launch epoch.
    invalidate_from(pool, &never);
    assert_eq!(epoch(&never), 0);

    let session = format!("warm-invalidate-{}", uuid::Uuid::new_v4());
    let base = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    let standard_key = key(&base, &[]);
    let fast_cfg = RunConfig { codex_settings: Some(json!({"serviceTier": "fast"})), ..base.clone() };
    let fast_key = key(&fast_cfg, &[]);

    launched(&session);
    let before = epoch(&session);
    assert_ne!(before, 0);

    // Put a stale standard-speed lead spare in the pool for `before`.
    let stale = Spare { key: standard_key.clone(), ..idle_spare(true, Duration::ZERO) };
    let stale_pid = pid_of(&stale);
    assert!(register(pool, &session, before, stale));
    assert!(waiting_in(pool, &session));

    // Mid-turn `/fast` invalidation retires the stale spare and advances the epoch (never zeroing it).
    invalidate_from(pool, &session);
    assert!(!waiting_in(pool, &session), "stale pooled spare must be retired");
    await_exit(&session).await.unwrap();
    assert!(process_gone(stale_pid), "stale spare process must exit");

    let after = epoch(&session);
    assert_ne!(after, 0, "mid-turn invalidation must keep a nonzero epoch for the running turn");
    assert!(after > before, "epoch must advance so older in-flight spawns and renewals abort");

    // Any in-flight spare or renewal from `before` is refused.
    let waiting_lead: Renew = Arc::new(|| true);
    assert!(!renews(Some(&waiting_lead), before, after, 0, true));
    let mut cmd = Command::new("sleep");
    cmd.arg("30").kill_on_drop(true);
    assert!(spawn_when_current(&session, before, async { Ok(()) }, &mut cmd, || false).await.unwrap().is_none());
    assert!(!register(pool, &session, before, Spare { key: standard_key, ..idle_spare(true, Duration::ZERO) }));

    // When the running turn finishes cleanly, its post-turn prewarm reads `after` and succeeds
    // with the refreshed `fastMode` key.
    let (child, starting) = spawn_when_current(&session, after, async { Ok(()) }, &mut cmd, || false)
        .await
        .unwrap()
        .expect("post-turn spare with nonzero advanced epoch must spawn");
    let pid = child.id().unwrap();
    let fresh = Spare {
        key: fast_key.clone(),
        child,
        group: ProcessGroup::register(Some(pid)),
        server: None,
        born: std::time::Instant::now(),
        idle: IDLE,
        lead: true,
        cwd: Some(external_path(&fast_cfg.cwd)),
    };
    assert!(register(pool, &session, after, fresh), "post-turn spare must register");
    drop(starting);
    assert!(waiting_in(pool, &session));

    let (adopted, _) = take_in(pool, &session, &fast_key);
    let (mut spare, _pending) = adopted.expect("next turn adopts the fast-mode spare");
    spare.child.kill().await.unwrap();
    let _ = spare.child.wait().await;
}

#[cfg(unix)]
#[tokio::test]
async fn discard_in_retires_canonical_nested_inflight_and_deleted_folder_spares_with_pending_handoff() {
    let pool = own_pool();
    let base = std::env::temp_dir().join(format!("pandacode-warm-folder-{}", uuid::Uuid::new_v4().simple()));
    let folder = base.join("wt");
    let nested = folder.join("sub");
    let other = base.join("other");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::create_dir_all(&other).unwrap();

    let id = |name: &str| format!("warm-dir-{name}-{}", uuid::Uuid::new_v4().simple());
    let (same_id, nested_id, inflight_id, other_id) = (id("same"), id("nested"), id("inflight"), id("other"));
    for sid in [&same_id, &nested_id, &inflight_id, &other_id] {
        launched(sid);
    }

    let make_spare = |lead: bool, cwd: PathBuf| {
        let mut spare = idle_spare(lead, Duration::ZERO);
        spare.cwd = Some(external_path(&cwd));
        spare
    };
    // Cover both ordinary and lead pools (and stay within `LIMIT`/`LEAD_LIMIT` = 2 each).
    let same_spare = make_spare(false, folder.join("."));
    let same_pid = pid_of(&same_spare);
    let nested_spare = make_spare(true, nested.clone());
    let nested_pid = pid_of(&nested_spare);
    let other_spare = make_spare(false, other.clone());
    let other_pid = pid_of(&other_spare);
    assert!(register(pool, &same_id, epoch(&same_id), same_spare));
    assert!(register(pool, &nested_id, epoch(&nested_id), nested_spare));
    assert!(register(pool, &other_id, epoch(&other_id), other_spare));

    // Also register an in-flight spawn targeting `folder` before `take_for_discard_in`.
    let inflight_epoch = epoch(&inflight_id);
    let inflight_guard = InFlight::enter(pool, inflight_id.clone(), external_path(&folder));

    // Simulate the gap between removing from `SPARES` (with `Pending` registered under the lock)
    // and calling `retire`, verifying `quiesce_pool_spares_in` blocks until retired processes exit.
    let (removed, affected) = take_for_discard_in(pool, &folder);
    assert_eq!(removed.len(), 2, "only spares inside folder (same + nested) are removed");
    assert!(affected.contains(&same_id) && affected.contains(&nested_id) && affected.contains(&inflight_id));
    assert!(!waiting_in(pool, &same_id) && !waiting_in(pool, &nested_id));
    assert!(waiting_in(pool, &other_id), "unrelated folder spare must stay pooled");
    assert!(epoch(&inflight_id) > inflight_epoch, "in-flight spawn epoch must advance");
    assert!(!register(pool, &inflight_id, inflight_epoch, make_spare(false, folder.clone())), "in-flight spawn must be refused");
    drop(inflight_guard);

    let waiter = tokio::spawn({
        let folder = folder.clone();
        async move { quiesce_pool_spares_in(pool, &folder).await }
    });
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(!waiter.is_finished(), "quiesce_spares_in must wait while Pending handoff is active");
    assert!(!process_gone(same_pid) && !process_gone(nested_pid));

    for (sid, spare, pending) in removed {
        retire(&sid, spare, pending);
    }
    tokio::time::timeout(Duration::from_secs(5), waiter)
        .await
        .expect("quiesce_spares_in must complete once retired spares exit")
        .unwrap()
        .unwrap();
    assert!(process_gone(same_pid) && process_gone(nested_pid));
    assert!(!process_gone(other_pid) && waiting_in(pool, &other_id));

    // Deleted-folder quiesce (like `recreate_worktree`): register a spare with canonical cwd,
    // remove the directory on disk, then quiesce using the non-canonical `folder` path.
    let deleted_id = id("deleted");
    launched(&deleted_id);
    let deleted_spare = make_spare(false, folder.canonicalize().unwrap());
    let deleted_pid = pid_of(&deleted_spare);
    assert!(register(pool, &deleted_id, epoch(&deleted_id), deleted_spare));
    std::fs::remove_dir_all(&folder).unwrap();
    quiesce_pool_spares_in(pool, &folder).await.unwrap();
    assert!(!waiting_in(pool, &deleted_id), "spare pinned to deleted folder must be retired");
    assert!(process_gone(deleted_pid), "retired deleted-folder spare must exit");

    quiesce_in(pool, &other_id).await.unwrap();
    assert!(process_gone(other_pid));
    let _ = std::fs::remove_dir_all(base);
}
