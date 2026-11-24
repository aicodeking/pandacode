//! Each pool's lifecycle: hits, misses and cold launches counted in the right pool, lead renewals,
//! the cap on starts in flight and the round-robin churn backoff.
use super::*;
use super::key::*;
use super::spawn::*;
use super::stats::{expired_note, not_renewed_note, CHURN_COOLDOWN};
use super::test_support::*;
use std::sync::atomic::{AtomicBool, Ordering};

#[tokio::test]
async fn every_lead_spare_hit_and_miss_is_logged_with_its_reason() {
    let pool = own_pool();
    let base = crate::providers::tests::config("claude");
    let launch = key(&base, &[]).unwrap();
    let with_key = |lead: bool, age: Duration, key: &str| Spare { key: key.into(), ..idle_spare(lead, age) };
    let id = |name: &str| format!("warm-log-{name}-{}", uuid::Uuid::new_v4());
    // Adopted.
    let hit = id("hit");
    admit(&mut spares(pool), hit.clone(), with_key(true, Duration::ZERO, &launch));
    let (spare, note) = take_in(pool, &hit, &launch, true);
    assert!(spare.is_some());
    assert_eq!(note.as_deref(), Some("Team lead's warm Claude agent adopted. Lead spares since launch: 1 started, 1 adopted, 0 not used, 0 expired, 0 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare."));
    // A warm-key field differed: only the field names, never their values.
    let changed = id("changed");
    admit(&mut spares(pool), changed.clone(), with_key(true, Duration::ZERO, &launch));
    let next = key(&RunConfig { model: "claude-sonnet-5-5".into(), ..base.clone() }, &[]).unwrap();
    let (spare, note) = take_in(pool, &changed, &next, true);
    assert!(spare.is_none());
    assert_eq!(note.as_deref(), Some("Team lead's warm Claude agent not used (changed: model); starting cold. Lead spares since launch: 2 started, 1 adopted, 1 not used, 0 expired, 0 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare."));
    // Expired while still in the pool.
    let old = id("old");
    admit(&mut spares(pool), old.clone(), with_key(true, IDLE, &launch));
    assert_eq!(take_in(pool, &old, &launch, true).1.as_deref(), Some("Team lead's warm Claude agent not used (it expired); starting cold. Lead spares since launch: 3 started, 1 adopted, 2 not used, 0 expired, 0 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare."));
    // Evicted by newer teams' spares.
    let evicted = id("evicted");
    admit(&mut spares(pool), evicted.clone(), with_key(true, Duration::from_secs(60), &launch));
    for _ in 0..LEAD_LIMIT {
        admit(&mut spares(pool), id("newer"), with_key(true, Duration::ZERO, &launch));
    }
    assert_eq!(take_in(pool, &evicted, &launch, true).1.as_deref(), Some("Team lead's warm Claude agent not used (it was evicted by a newer team's spare); starting cold. Lead spares since launch: 6 started, 1 adopted, 3 not used, 0 expired, 1 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare."));
    // Discarded (settings changed, team paused or stopped).
    let discarded = id("discarded");
    admit(&mut spares(pool), discarded.clone(), with_key(true, Duration::ZERO, &launch));
    discard_from(pool, &discarded);
    assert_eq!(take_in(pool, &discarded, &launch, true).1.as_deref(), Some("Team lead's warm Claude agent not used (it was discarded); starting cold. Lead spares since launch: 7 started, 1 adopted, 4 not used, 0 expired, 2 evicted, 0 replaced, 1 discarded; 0 cold launches without a spare."));
    // Each reason is said once; a managed worker (never eligible for a spare) logs nothing.
    assert_eq!(take_in(pool, &discarded, &launch, false).1, None);
    // An ordinary spare logs its hits and misses with ordinary totals of its own.
    let plain = id("plain");
    admit(&mut spares(pool), plain.clone(), with_key(false, Duration::ZERO, &launch));
    let (spare, note) = take_in(pool, &plain, &launch, true);
    assert!(spare.is_some());
    assert_eq!(note.as_deref(), Some("Warm Claude agent adopted. Ordinary spares since launch: 1 started, 1 adopted, 0 not used, 0 expired, 0 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare."));
    admit(&mut spares(pool), plain.clone(), with_key(false, Duration::ZERO, &launch));
    assert_eq!(
        take_in(pool, &plain, &next, true).1.as_deref(),
        Some("Warm Claude agent not used (changed: model); starting cold. Ordinary spares since launch: 2 started, 1 adopted, 1 not used, 0 expired, 0 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare.")
    );
    // Ordinary spares never move the lead counters, and lead spares never move the ordinary ones.
    let counts = spares(pool);
    assert_eq!(counts.lead, PoolStats { started: 7, adopted: 1, missed: 4, evicted: 2, discarded: 1, ..PoolStats::default() });
    assert_eq!(counts.ordinary, PoolStats { started: 2, adopted: 1, missed: 1, ..PoolStats::default() });
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
    // Windows long enough that a loaded runner stays well inside the chain's wall-clock bound
    // (`chain_expired`: three windows from the first start).
    let life = Lifecycle { idle: Duration::from_millis(800), ..stub() };
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

/// A stand-in for a spawn that declines (spares off, no warm key, an unreadable git status).
fn declined_spawn(_: RunConfig, _: Vec<Value>, _: HashSet<String>, _: u64, _: bool) -> Spawning {
    Box::pin(async { Ok(None) })
}

#[tokio::test]
async fn a_renewal_that_never_pools_is_not_taken_for_renewed() {
    let session = format!("warm-renew-skip-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    let waiting: Renew = Arc::new(|| true);
    launched(&session);
    let launch = epoch(&session);
    let renewal = |life: Lifecycle| start(life, config.clone(), Vec::new(), HashSet::new(), launch, lead(waiting.clone()), 1);
    // The spawn declined: no spare, so the expiry still says the lead's spare expired idle.
    let declined = Lifecycle { idle: Duration::from_secs(3600), spawn: declined_spawn, ..stub() };
    let renewed = renewal(declined).await.unwrap();
    assert!(!renewed && !waiting_in(declined.pool, &session));
    let note = expiry_note(declined.pool, renewed, launch, epoch(&session), true);
    assert!(note.as_deref().is_some_and(|line| line.starts_with("Team lead's warm Claude agent expired idle.")), "{note:?}");
    // The lead pool's churn backoff skipped it: the same.
    let cooling = Lifecycle { idle: Duration::from_secs(3600), ..stub() };
    for _ in 0..LEAD_LIMIT {
        spares(cooling.pool).lead_churn.evicted(LEAD_LIMIT, std::time::Instant::now());
    }
    let renewed = renewal(cooling).await.unwrap();
    assert!(!renewed && stub_starts(&session) == 0 && spares(cooling.pool).lead.churn_skipped == 1);
    assert!(expiry_note(cooling.pool, renewed, launch, epoch(&session), true).is_some());
    // A renewal that really pooled logs nothing, and neither does one a launch superseded.
    let pooled = Lifecycle { idle: Duration::from_secs(3600), ..stub() };
    let renewed = renewal(pooled).await.unwrap();
    assert!(renewed && waiting_in(pooled.pool, &session));
    assert_eq!(expiry_note(pooled.pool, renewed, launch, epoch(&session), true), None);
    assert_eq!(expiry_note(pooled.pool, false, launch, launch + 1, true), None);
    discard_from(pooled.pool, &session);
    await_exit(&session).await.unwrap();
}

/// Threads the renewal check ran on (`a_lead_spares_renewal_check_runs_off_the_runtime_thread`).
static CHECK_THREADS: LazyLock<Mutex<Vec<std::thread::ThreadId>>> = LazyLock::new(|| Mutex::new(Vec::new()));

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
    // Only lead spares renew, and a lead's key carries its working tree's status.
    let git_status = lead_git_status(&external_path(&base.cwd)).expect("the test folder's git status is known");
    let spare = lead_key(&RunConfig { cwd: external_path(&base.cwd), ..base.clone() }, &tools, &git_status).unwrap();
    let inputs: Inputs = Arc::new(|| "explore:true tools:Some(false)".into());
    let current = |key: &str, tools: &[Value], spawned: &str| still_current(key, &base, tools, spawned, &inputs);
    assert!(current(&spare, &tools, "explore:true tools:Some(false)"));
    let plain = key(&RunConfig { cwd: external_path(&base.cwd), ..base.clone() }, &tools).unwrap();
    assert!(!current(&plain, &tools, "explore:true tools:Some(false)"), "a key without the lead's git status");
    assert!(!current(&spare, &[], "explore:true tools:Some(false)"), "a changed tool catalog");
    // The explorer switch, agent-made tools or the instructions they shape changed since spawn.
    assert!(!current(&spare, &tools, "explore:false tools:Some(false)"), "changed launch inputs");
    // A setting read at spawn (here the telemetry switch) changing makes it stale.
    super::super::privacy::FORCE.with(|force| force.set(Some(!super::super::privacy::telemetry_off())));
    let stale = !current(&spare, &tools, "explore:true tools:Some(false)");
    super::super::privacy::FORCE.with(|force| force.set(None));
    assert!(stale);
}

#[tokio::test]
async fn a_launch_with_no_pooled_spare_is_counted_without_keying() {
    let pool = own_pool();
    let cold = format!("warm-cold-{}", uuid::Uuid::new_v4());
    spares(pool).gone.insert(cold.clone(), Gone::Expired);
    let before = epoch(&cold);
    let (pooled, note) = launch_in(pool, &cold, true);
    assert!(!pooled);
    assert!(epoch(&cold) > before, "the launch is counted, so a spare for the old launch is refused");
    assert_eq!(
        note.as_deref(),
        Some("Team lead's warm Claude agent not used (it expired); starting cold. Lead spares since launch: 0 started, 0 adopted, 1 not used, 0 expired, 0 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare.")
    );
    assert!(!spares(pool).gone.contains_key(&cold));
    // Each reason is said once; the next launch is a plain cold launch without a spare.
    assert_eq!(
        launch_in(pool, &cold, true),
        (false, Some(format!("{NOT_POOLED} Ordinary spares since launch: 0 started, 0 adopted, 0 not used, 0 expired, 0 evicted, 0 replaced, 0 discarded; 1 cold launches without a spare.")))
    );
    assert_eq!(spares(pool).ordinary.cold_without_spare, 1, "a lead's gone reason counts only as a lead miss");

    let warm = format!("warm-pooled-{}", uuid::Uuid::new_v4());
    admit(&mut spares(pool), warm.clone(), idle_spare(true, Duration::ZERO));
    let launch = epoch(&warm);
    assert_eq!(launch_in(pool, &warm, true), (true, None));
    assert!(waiting_in(pool, &warm), "the pooled spare is left for `take`");
    assert!(epoch(&warm) > launch, "counted with a spare pooled too, so a stale lead renewal is refused");
    let (adopted, _) = take_in(pool, &warm, "launch", true);
    assert!(adopted.is_some());
}

#[tokio::test]
async fn a_launch_without_a_key_retires_and_logs_a_lead_spare_without_a_stale_note() {
    let pool = own_pool();
    let session = format!("warm-nokey-lead-{}", uuid::Uuid::new_v4());
    let spare = idle_spare(true, Duration::ZERO);
    let pid = pid_of(&spare);
    admit(&mut spares(pool), session.clone(), spare);
    let before = epoch(&session);
    assert_eq!(
        launched_without_key_in(pool, &session, NO_CONFIG, true).as_deref(),
        Some("Team lead's warm Claude agent not used (its config folder cannot be known); starting cold. Lead spares since launch: 1 started, 0 adopted, 1 not used, 0 expired, 0 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare.")
    );
    assert!(epoch(&session) > before, "the launch is counted");
    assert!(!waiting_in(pool, &session), "the spare must not idle beside the cold process");
    assert!(!spares(pool).gone.contains_key(&session), "no stale gone note for a later launch");
    assert_eq!(launched_without_key_in(pool, &session, NO_CONFIG, false), None, "the miss is said once");
    assert_eq!(launch_in(pool, &session, false), (false, None));
    {
        let counts = spares(pool);
        assert_eq!(counts.lead, PoolStats { started: 1, missed: 1, ..PoolStats::default() });
        assert_eq!(counts.ordinary, PoolStats::default(), "lead spares never move the ordinary counters");
    }
    await_exit(&session).await.unwrap();
    assert_process_gone(pid);
}

#[tokio::test]
async fn a_launch_without_a_key_retires_and_logs_an_ordinary_spare() {
    let pool = own_pool();
    let session = format!("warm-nokey-plain-{}", uuid::Uuid::new_v4());
    let spare = idle_spare(false, Duration::ZERO);
    let pid = pid_of(&spare);
    admit(&mut spares(pool), session.clone(), spare);
    assert_eq!(
        launched_without_key_in(pool, &session, NO_CONFIG, true).as_deref(),
        Some("Warm Claude agent not used (its config folder cannot be known); starting cold. Ordinary spares since launch: 1 started, 0 adopted, 1 not used, 0 expired, 0 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare.")
    );
    assert!(!waiting_in(pool, &session));
    assert_eq!(launched_without_key_in(pool, &session, NO_CONFIG, false), None, "the miss is said once");
    {
        let counts = spares(pool);
        assert_eq!(counts.lead, PoolStats::default(), "ordinary spares never move the lead counters");
        assert_eq!(counts.ordinary, PoolStats { started: 1, missed: 1, ..PoolStats::default() });
    }
    await_exit(&session).await.unwrap();
    assert_process_gone(pid);
}

#[tokio::test]
async fn a_cold_launch_is_counted_once_and_never_for_a_managed_worker() {
    let pool = own_pool();
    let id = |name: &str| format!("warm-cold-count-{name}-{}", uuid::Uuid::new_v4());
    // A managed worker: no spare, no note, no count, but the launch still advances.
    let worker = id("worker");
    let before = epoch(&worker);
    assert_eq!(launch_in(pool, &worker, false), (false, None));
    assert!(epoch(&worker) > before);
    assert_eq!(spares(pool).ordinary.cold_without_spare, 0, "managed workers never count as cold launches");
    // A lead's gone note: only a lead miss, never a cold launch.
    let lead = id("lead");
    spares(pool).gone.insert(lead.clone(), Gone::Evicted);
    let (pooled, note) = launch_in(pool, &lead, true);
    assert!(!pooled && note.as_deref().is_some_and(|line| line.starts_with("Team lead's warm Claude agent not used (it was evicted")), "{note:?}");
    assert_eq!(spares(pool).lead, PoolStats { missed: 1, ..PoolStats::default() });
    assert_eq!(spares(pool).ordinary.cold_without_spare, 0);
    // An ordinary launch with nothing pooled.
    assert_eq!(
        launch_in(pool, &id("plain"), true),
        (false, Some(format!("{NOT_POOLED} Ordinary spares since launch: 0 started, 0 adopted, 0 not used, 0 expired, 0 evicted, 0 replaced, 0 discarded; 1 cold launches without a spare.")))
    );
    assert_eq!(spares(pool).ordinary, PoolStats { cold_without_spare: 1, ..PoolStats::default() });
}

#[tokio::test]
async fn a_spare_vanishing_during_the_key_walk_still_counts_its_launch() {
    let pool = own_pool();
    let session = format!("warm-vanish-{}", uuid::Uuid::new_v4());
    let spare = idle_spare(false, Duration::ZERO);
    let pid = pid_of(&spare);
    admit(&mut spares(pool), session.clone(), spare);
    let before = epoch(&session);
    assert_eq!(launch_in(pool, &session, true), (true, None));
    assert!(epoch(&session) > before, "the launch is counted before the key walk");
    // Expired (or evicted) while the key was computed off the runtime.
    let removed = spares(pool).remove(&session, Gone::Expired);
    let (adopted, note) = take_in(pool, &session, "launch", true);
    assert!(adopted.is_none());
    assert_eq!(
        note.as_deref(),
        Some(format!("{NOT_POOLED} Ordinary spares since launch: 1 started, 0 adopted, 0 not used, 1 expired, 0 evicted, 0 replaced, 0 discarded; 1 cold launches without a spare.").as_str())
    );
    // The same race for a managed worker counts and logs nothing.
    assert_eq!(take_in(pool, &session, "launch", false).1, None);
    assert_eq!(spares(pool).ordinary.cold_without_spare, 1);
    if let Some((spare, pending)) = removed {
        retire(&session, spare, pending);
    }
    await_exit(&session).await.unwrap();
    assert_process_gone(pid);
}

#[tokio::test]
async fn expiry_and_discard_lines_read_the_totals_without_counting() {
    let pool = own_pool();
    {
        let mut locked = spares(pool);
        locked.lead = PoolStats { started: 3, adopted: 1, missed: 1, expired: 1, ..PoolStats::default() };
        locked.ordinary = PoolStats { started: 2, discarded: 2, cold_without_spare: 4, ..PoolStats::default() };
    }
    assert_eq!(expired_note(pool, true), "Team lead's warm Claude agent expired idle. Lead spares since launch: 3 started, 1 adopted, 1 not used, 1 expired, 0 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare.");
    assert_eq!(expired_note(pool, false), "Warm Claude agent expired idle. Ordinary spares since launch: 2 started, 0 adopted, 0 not used, 0 expired, 0 evicted, 0 replaced, 2 discarded; 4 cold launches without a spare.");
    assert_eq!(discarded_note(pool, true), "Team lead's warm Claude agent discarded. Lead spares since launch: 3 started, 1 adopted, 1 not used, 1 expired, 0 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare.");
    assert_eq!(discarded_note(pool, false), "Warm Claude agent discarded. Ordinary spares since launch: 2 started, 0 adopted, 0 not used, 0 expired, 0 evicted, 0 replaced, 2 discarded; 4 cold launches without a spare.");
    let locked = spares(pool);
    assert_eq!(locked.lead, PoolStats { started: 3, adopted: 1, missed: 1, expired: 1, ..PoolStats::default() });
    assert_eq!(locked.ordinary, PoolStats { started: 2, discarded: 2, cold_without_spare: 4, ..PoolStats::default() });
}

#[tokio::test]
async fn a_launch_without_a_spare_counts_a_discard_and_leaves_no_stale_lead_note() {
    let pool = own_pool();
    let session = format!("warm-nospare-lead-{}", uuid::Uuid::new_v4());
    let spare = idle_spare(true, Duration::ZERO);
    let pid = pid_of(&spare);
    admit(&mut spares(pool), session.clone(), spare);
    // An older note (say, from a replaced spare) is cleared by this launch, not reported later.
    spares(pool).gone.insert(session.clone(), Gone::Expired);
    let before = epoch(&session);
    launched_without_spare_in(pool, &session);
    assert!(epoch(&session) > before, "the launch is counted");
    assert!(!waiting_in(pool, &session), "the spare must not idle beside the cold process");
    assert!(!spares(pool).gone.contains_key(&session), "no stale gone note for the next launch");
    assert_eq!(spares(pool).lead, PoolStats { started: 1, discarded: 1, ..PoolStats::default() });
    // The lead's next supported launch starts cold without counting a lead miss.
    let (pooled, note) = launch_in(pool, &session, true);
    assert!(!pooled && note.as_deref().is_some_and(|line| line.starts_with(NOT_POOLED)), "{note:?}");
    let note = take_in(pool, &session, "launch", true).1;
    assert!(note.as_deref().is_some_and(|line| line.starts_with(NOT_POOLED)), "{note:?}");
    assert_eq!(spares(pool).ordinary.cold_without_spare, 2);
    assert_eq!(spares(pool).lead, PoolStats { started: 1, discarded: 1, ..PoolStats::default() });
    assert_eq!(spares(pool).ordinary, PoolStats { cold_without_spare: 2, ..PoolStats::default() });
    await_exit(&session).await.unwrap();
    assert_process_gone(pid);
}

#[tokio::test]
async fn a_failed_key_check_logs_its_own_reason() {
    let pool = own_pool();
    let session = format!("warm-keyfail-{}", uuid::Uuid::new_v4());
    let spare = idle_spare(false, Duration::ZERO);
    let pid = pid_of(&spare);
    admit(&mut spares(pool), session.clone(), spare);
    let note = launched_without_key_in(pool, &session, "its warm key check failed", true).unwrap();
    assert!(note.starts_with("Warm Claude agent not used (its warm key check failed); starting cold."), "{note}");
    assert!(!note.contains(NO_CONFIG), "{note}");
    assert!(!waiting_in(pool, &session));
    await_exit(&session).await.unwrap();
    assert_process_gone(pid);
}

#[tokio::test]
async fn ordinary_pool_stats_count_every_lifecycle_step_apart_from_leads() {
    let pool = own_pool();
    let id = |name: &str| format!("warm-stats-{name}-{}", uuid::Uuid::new_v4());
    let (a, b, c, gone, cold) = (id("a"), id("b"), id("c"), id("gone"), id("cold"));
    for session in [&a, &b, &c] {
        launched(session);
    }
    // `register` counts every spare it accepts.
    assert!(register(pool, &a, epoch(&a), idle_spare(false, Duration::from_secs(30))));
    assert!(register(pool, &b, epoch(&b), idle_spare(false, Duration::from_secs(20))));
    assert_eq!(spares(pool).ordinary.started, 2);
    // A newer spare for `b` replaces it; a third task's spare evicts `a` (the oldest).
    assert!(register(pool, &b, epoch(&b), idle_spare(false, Duration::from_secs(10))));
    assert!(register(pool, &c, epoch(&c), idle_spare(false, Duration::ZERO)));
    // Expired, then discarded.
    let born = spares(pool).spares[&b].born;
    let expired = take_expired(pool, &b, born);
    discard_from(pool, &c);
    // Adopted, then found unusable.
    admit(&mut spares(pool), gone.clone(), idle_spare(false, Duration::ZERO));
    assert!(take_in(pool, &gone, "launch", true).0.is_some());
    admit(&mut spares(pool), gone.clone(), idle_spare(false, Duration::ZERO));
    assert!(take_in(pool, &gone, "another", true).0.is_none());
    // A launch with nothing pooled.
    let (pooled, note) = launch_in(pool, &cold, true);
    assert!(!pooled && note.as_deref().is_some_and(|line| line.starts_with(NOT_POOLED)), "{note:?}");
    {
        let counts = spares(pool);
        assert_eq!(
            counts.ordinary,
            PoolStats { started: 6, adopted: 1, missed: 1, expired: 1, evicted: 1, replaced: 1, discarded: 1, cold_without_spare: 1, churn_skipped: 0 }
        );
        assert_eq!(counts.lead, PoolStats::default(), "ordinary spares never move the lead counters");
        assert_eq!(counts.ordinary.cold_without_spare, 1);
        assert!(counts.gone.is_empty(), "ordinary spares leave no gone notes");
    }
    if let Some((spare, pending)) = expired {
        retire(&b, spare, pending);
    }
    for session in [&a, &b, &c, &gone] {
        await_exit(session).await.unwrap();
    }
}

#[tokio::test]
async fn a_refused_registration_counts_as_started_and_discarded() {
    let (pool, session) = (own_pool(), format!("warm-refused-count-{}", uuid::Uuid::new_v4()));
    launched(&session);
    let stale = epoch(&session);
    launched(&session); // a newer launch began while the spare was starting
    assert!(!register(pool, &session, stale, idle_spare(false, Duration::ZERO)), "a stale ordinary spare is refused");
    assert!(!register(pool, &session, 0, idle_spare(true, Duration::ZERO)), "a forgotten task's lead spare is refused");
    {
        let counts = spares(pool);
        // started == adopted + missed + expired + evicted + replaced + discarded, in both pools.
        assert_eq!(counts.ordinary, PoolStats { started: 1, discarded: 1, ..PoolStats::default() });
        assert_eq!(counts.lead, PoolStats { started: 1, discarded: 1, ..PoolStats::default() });
        assert!(counts.spares.is_empty() && counts.gone.is_empty(), "nothing pooled, no stale gone note");
        assert_eq!(counts.ordinary.cold_without_spare, 0);
    }
    await_exit(&session).await.unwrap();
}

#[test]
fn a_lead_spare_not_renewed_logs_an_expiry_not_a_cold_start() {
    let pool = own_pool();
    {
        let mut locked = spares(pool);
        locked.lead = PoolStats { started: 2, adopted: 1, expired: 1, ..PoolStats::default() };
    }
    let note = not_renewed_note(pool, "its launch settings changed");
    assert_eq!(note, "Team lead's warm Claude agent expired idle (not renewed: its launch settings changed). Lead spares since launch: 2 started, 1 adopted, 0 not used, 1 expired, 0 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare.");
    assert!(!note.contains("starting cold"), "{note}");
    assert!(note.contains("Lead spares since launch:"), "{note}");
    assert_eq!(spares(pool).lead, PoolStats { started: 2, adopted: 1, expired: 1, ..PoolStats::default() }, "reading the totals counts nothing");
}

/// Starts already in flight for other tasks, in the ordinary or lead pool, held until dropped.
fn busy_starts(pool: &'static Pool, count: usize, lead: bool) -> Vec<InFlight> {
    (0..count).map(|n| InFlight::enter(pool, format!("warm-cap-busy-{n}-{}", uuid::Uuid::new_v4()), std::env::temp_dir(), lead)).collect()
}

#[tokio::test]
async fn each_pool_caps_its_starts_in_flight_without_blocking_the_other() {
    let life = Lifecycle { idle: Duration::from_secs(3600), ..stub() };
    for (full, limit) in [(false, LIMIT), (true, LEAD_LIMIT)] {
        let busy = busy_starts(life.pool, limit, full);
        for lead_start in [full, !full] {
            let session = format!("warm-cap-{full}-{lead_start}-{}", uuid::Uuid::new_v4());
            let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
            launched(&session);
            let renew = if lead_start { lead(Arc::new(|| false)) } else { None };
            start(life, config, Vec::new(), HashSet::new(), epoch(&session), renew, 0).await.unwrap();
            let declined = lead_start == full;
            assert_eq!(stub_starts(&session), u32::from(!declined), "full pool lead={full}, start lead={lead_start}");
            assert_eq!(waiting_in(life.pool, &session), !declined);
            assert_eq!(spares(life.pool).starting.len(), limit, "a start leaves no token behind");
            discard_from(life.pool, &session);
            await_exit(&session).await.unwrap();
        }
        drop(busy);
        assert!(spares(life.pool).starting.is_empty());
    }
}

#[tokio::test]
async fn a_renewal_holding_its_own_token_is_not_capped_by_it() {
    let life = Lifecycle { idle: Duration::from_secs(3600), ..stub() };
    let session = format!("warm-cap-renewal-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    launched(&session);
    // The expiry token the renewal holds through its start, beside another team's start.
    let own = InFlight::enter(life.pool, session.clone(), std::env::temp_dir(), true);
    let others = busy_starts(life.pool, LEAD_LIMIT - 1, true);
    start(life, config, Vec::new(), HashSet::new(), epoch(&session), lead(Arc::new(|| false)), 1).await.unwrap();
    assert_eq!(stub_starts(&session), 1, "the renewal starts");
    assert!(waiting_in(life.pool, &session));
    drop((own, others));
    discard_from(life.pool, &session);
    await_exit(&session).await.unwrap();
}

#[tokio::test]
async fn an_adoption_counts_only_once_the_launch_commits_to_its_spare() {
    let pool = own_pool();
    let session = format!("warm-commit-{}", uuid::Uuid::new_v4());
    let take = |session: &str| {
        let discard_epoch = spares(pool).discard_epoch;
        take_since(pool, session, "launch", true, false, discard_epoch)
    };
    // Taken, then the launch ends (a failed rebind, a Stop) before it owns the process.
    let spare = idle_spare(false, Duration::ZERO);
    let pid = pid_of(&spare);
    admit(&mut spares(pool), session.clone(), spare);
    let (taken, note) = take(&session);
    assert!(note.is_none(), "a match is logged only when the launch commits to it");
    assert_eq!(spares(pool).ordinary.adopted, 0, "not counted at take");
    drop(Adopting { pool, session_id: session.clone(), spare: taken });
    assert_eq!(spares(pool).ordinary, PoolStats { started: 1, missed: 1, ..PoolStats::default() });
    await_exit(&session).await.unwrap();
    assert_process_gone(pid);
    // Taken and committed: counted once as adopted.
    admit(&mut spares(pool), session.clone(), idle_spare(false, Duration::ZERO));
    let (taken, _) = take(&session);
    let (mut child, _group) = Adopting { pool, session_id: session.clone(), spare: taken }.into_parts();
    assert_eq!(spares(pool).ordinary, PoolStats { started: 2, adopted: 1, missed: 1, ..PoolStats::default() });
    child.kill().await.unwrap();
}

#[tokio::test]
async fn a_switch_off_keeps_counting_starts_still_in_flight() {
    let life = Lifecycle { idle: Duration::from_secs(3600), ..stub() };
    let folder = std::env::temp_dir();
    let busy = busy_starts(life.pool, LIMIT, false);
    assert_eq!(in_flight(&spares(life.pool), "warm-cap-me", false), LIMIT);
    assert!(has_spare_in(life.pool, &folder));
    disable_all_from(life.pool);
    // Their tasks still run until the guards drop: a quick off → on must not start more.
    assert_eq!(in_flight(&spares(life.pool), "warm-cap-me", false), LIMIT, "cancelled starts still count");
    assert!(spares(life.pool).starting.values().all(|entry| entry.cancelled));
    assert!(!has_spare_in(life.pool, &folder), "folder quiescence no longer waits on them");
    let session = format!("warm-cap-off-on-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    launched(&session);
    start(life, config, Vec::new(), HashSet::new(), epoch(&session), None, 0).await.unwrap();
    assert_eq!(stub_starts(&session), 0, "the cap still holds right after a switch-off");
    drop(busy);
    assert_eq!(in_flight(&spares(life.pool), "warm-cap-me", false), 0);
    assert!(spares(life.pool).starting.is_empty(), "each guard removes its own entry");
}

#[test]
fn a_pools_churn_backoff_starts_at_its_limit_and_lapses() {
    let now = std::time::Instant::now();
    let mut churn = PoolChurn::default();
    churn.evicted(2, now);
    assert!(!churn.cooling(now), "one eviction is ordinary turnover");
    churn.evicted(2, now);
    assert!(churn.cooling(now), "two in a row with no adoption between back off");
    assert!(churn.cooling(now + CHURN_COOLDOWN / 2));
    assert!(!churn.cooling(now + CHURN_COOLDOWN), "a lapsed backoff probes again");
    assert_eq!(churn, PoolChurn::default(), "and starts a fresh streak");
}

#[tokio::test]
async fn round_robin_turns_back_off_and_an_adoption_clears_the_backoff() {
    let life = Lifecycle { idle: Duration::from_secs(3600), ..stub() };
    let id = |name: &str| format!("warm-churn-{name}-{}", uuid::Uuid::new_v4());
    let (a, b, c) = (id("a"), id("b"), id("c"));
    let turn = |session: &String| {
        let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
        launched(session);
        start(life, config, Vec::new(), HashSet::new(), epoch(session), None, 0)
    };
    // A → B → C → A → B → C: each new spare evicts the next task's, which is never adopted.
    for session in [&a, &b, &c, &a, &b, &c] {
        turn(session).await.unwrap();
    }
    assert_eq!((stub_starts(&a), stub_starts(&b), stub_starts(&c)), (2, 1, 1), "after two evictions in a row no doomed spare starts");
    {
        let locked = spares(life.pool);
        assert_eq!(locked.ordinary.evicted, 2);
        assert_eq!(locked.ordinary.churn_skipped, 2);
        assert!(locked.ordinary_churn.churn_cooldown_until.is_some());
        assert_eq!(locked.lead_churn, PoolChurn::default(), "the lead pool keeps its own streak");
    }
    // C's turn comes and adopts its spare: the backoff ends at once.
    let (adopted, note) = take_in(life.pool, &c, "stub", true);
    assert!(adopted.is_some() && note.as_deref().is_some_and(|line| line.starts_with("Warm Claude agent adopted.")), "{note:?}");
    assert_eq!(spares(life.pool).ordinary_churn, PoolChurn::default());
    turn(&b).await.unwrap();
    assert_eq!(stub_starts(&b), 2, "an adoption clears the backoff");
    drop(adopted);
    for session in [&a, &b, &c] {
        discard_from(life.pool, session);
        await_exit(session).await.unwrap();
    }
}

#[tokio::test]
async fn a_spare_past_its_idle_on_the_wall_clock_is_never_adopted() {
    let pool = own_pool();
    let session = format!("warm-wall-{}", uuid::Uuid::new_v4());
    // Fresh on the monotonic clock, a whole idle window old on the wall clock (the machine slept).
    let slept = Spare { born: std::time::Instant::now(), born_wall: std::time::SystemTime::now().checked_sub(IDLE).unwrap(), ..idle_spare(false, Duration::ZERO) };
    let pid = pid_of(&slept);
    admit(&mut spares(pool), session.clone(), slept);
    let (adopted, note) = take_in(pool, &session, "launch", true);
    assert!(adopted.is_none());
    assert!(note.as_deref().is_some_and(|line| line.starts_with("Warm Claude agent not used (it expired); starting cold.")), "{note:?}");
    await_exit(&session).await.unwrap();
    assert_process_gone(pid);
}

#[tokio::test]
async fn a_leads_cold_launch_counts_in_the_lead_pool() {
    let pool = own_pool();
    let session = format!("warm-lead-cold-{}", uuid::Uuid::new_v4());
    let found = prepare_launch_in(pool, &session, true, true);
    assert_eq!(found, LaunchPool::Empty { may_record_cold: true, lead: true, gone: None });
    let LaunchPool::Empty { may_record_cold, lead, gone } = found else { unreachable!() };
    assert_eq!(
        finish_empty_launch_with(pool, may_record_cold, lead, gone, || async { true }).await.as_deref(),
        Some("Team lead's warm Claude agent not pooled; starting cold. Lead spares since launch: 0 started, 0 adopted, 0 not used, 0 expired, 0 evicted, 0 replaced, 0 discarded; 1 cold launches without a spare.")
    );
    // Its spare vanished during the key walk: still a lead cold launch.
    admit(&mut spares(pool), session.clone(), idle_spare(false, Duration::ZERO));
    let removed = spares(pool).remove(&session, Gone::Expired);
    let discard_epoch = spares(pool).discard_epoch;
    let (adopted, note) = take_since(pool, &session, "launch", true, true, discard_epoch);
    assert!(adopted.is_none() && note.as_deref().is_some_and(|line| line.starts_with("Team lead's warm Claude agent not pooled")), "{note:?}");
    assert_eq!(spares(pool).lead, PoolStats { cold_without_spare: 2, ..PoolStats::default() });
    assert_eq!(spares(pool).ordinary.cold_without_spare, 0, "a lead's cold launch never counts in the ordinary pool");
    if let Some((spare, pending)) = removed {
        retire(&session, spare, pending);
    }
    await_exit(&session).await.unwrap();
}

#[test]
fn warm_spare_stats_reports_both_pools_in_camel_case() {
    let pool = own_pool();
    {
        let mut locked = spares(pool);
        locked.ordinary = PoolStats { started: 3, adopted: 2, cold_without_spare: 4, churn_skipped: 1, ..PoolStats::default() };
        locked.lead = PoolStats { started: 1, missed: 1, cold_without_spare: 2, ..PoolStats::default() };
    }
    let stats = serde_json::to_value(WarmStatsSnapshot::of(&spares(pool))).unwrap();
    assert_eq!(stats["ordinary"], json!({"started": 3, "adopted": 2, "missed": 0, "expired": 0, "evicted": 0, "replaced": 0, "discarded": 0, "coldWithoutSpare": 4, "churnSkipped": 1}));
    assert_eq!(stats["lead"]["coldWithoutSpare"], 2);
    assert_eq!(stats["lead"]["missed"], 1);
    let live = serde_json::to_value(warm_spare_stats()).unwrap();
    assert!(live["ordinary"].is_object() && live["lead"].is_object(), "{live}");
}
