use super::*;
use super::key::*;
use super::memory::MemoryOverride;
use super::spawn::*;
use super::test_support::*;

struct EnabledOverride(Option<bool>);

impl EnabledOverride {
    fn new(enabled: bool) -> Self {
        Self(ENABLED_OVERRIDE.with(|value| value.replace(Some(enabled))))
    }
}

impl Drop for EnabledOverride {
    fn drop(&mut self) {
        ENABLED_OVERRIDE.with(|value| value.set(self.0));
    }
}

#[test]
fn on_marker_is_opt_in_and_fails_closed_on_read_errors() {
    let dir = std::env::temp_dir().join(format!("warm-switch-marker-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    assert!(!enabled_in(Ok(dir.clone())), "an absent marker leaves spares off");
    let marker = dir.join(WARM_SPARES_ON_FILE);
    std::fs::write(&marker, "").unwrap();
    assert!(enabled_in(Ok(dir.clone())), "a present marker enables spares");
    // A regular file cannot contain the marker: checking it must fail closed.
    assert!(!enabled_in(Ok(marker)));
    assert!(!enabled_in(Err("app data is unavailable".into())));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn off_switch_blocks_matching_renewals_prewarm_and_process_spawn() {
    // Thread-local overrides cannot affect concurrent tests; this runtime keeps the
    // guard on the same thread across awaits, and Drop restores it even on a panic.
    let _enabled = EnabledOverride::new(true);
    let session = format!("warm-switch-off-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    let mut prepared_config = config.clone();
    prepared_config.cwd = external_path(&config.cwd);
    let disabled = crate::skill_manager::disabled_for(&session);
    // Only lead spares renew, and every spare's key carries its working tree's status.
    let git_status = git_status(&prepared_config.cwd).expect("the test folder's git status is known");
    let spare_key = lead_key(&prepared(prepared_config, &disabled), &[], &git_status).unwrap();
    let inputs: Inputs = Arc::new(|| "unchanged".into());
    assert!(still_current(&spare_key, &config, &[], "unchanged", &inputs));
    assert!(supported(&config));
    launched(&session);
    let launch = epoch(&session);
    assert_ne!(launch, 0);
    {
        let _off = EnabledOverride::new(false);
        assert!(!enabled_now());
        assert!(!still_current(&spare_key, &config, &[], "unchanged", &inputs));
        prewarm(config.clone(), Vec::new(), HashSet::new(), launch, None, || "unchanged".into()).await.unwrap();
        assert!(!waiting(&session), "disabled prewarm must leave no spare waiting");
        assert!(spawn_claude_process(config, Vec::new(), HashSet::new(), launch, false).await.unwrap().is_none(),
            "disabled spares must return before looking up or spawning a CLI");
    }
    assert!(enabled_now(), "the guard restores the previous setting");
    discard(&session);
}

#[tokio::test(flavor = "current_thread")]
async fn low_memory_skips_both_kinds_of_spare_after_the_previous_exit() {
    let _serial = test_support::spare_pool_test_lock().lock().await;
    let _enabled = EnabledOverride::new(true);
    let _low_memory = MemoryOverride::new(false);
    let (ordinary, lead, ordinary_churn, lead_churn) = {
        let locked = spares(&SPARES);
        (locked.ordinary, locked.lead, locked.ordinary_churn, locked.lead_churn)
    };

    for is_lead in [false, true] {
        let session = format!("warm-memory-wait-{is_lead}-{}", uuid::Uuid::new_v4());
        let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
        launched(&session);
        let previous = pending_in_cwd(&session, None);
        let mut spawn = std::pin::pin!(spawn_claude_process(config, Vec::new(), HashSet::new(), epoch(&session), is_lead));
        tokio::select! {
            biased;
            _ = &mut spawn => panic!("the spare checked memory before the previous exit"),
            () = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
        drop(previous);
        assert!(spawn.await.unwrap().is_none(), "low memory must prevent a spare from spawning");
        discard(&session);
    }

    let locked = spares(&SPARES);
    assert_eq!(locked.ordinary, PoolStats { memory_skipped: ordinary.memory_skipped + 1, ..ordinary });
    assert_eq!(locked.lead, PoolStats { memory_skipped: lead.memory_skipped + 1, ..lead });
    assert_eq!((locked.ordinary_churn, locked.lead_churn), (ordinary_churn, lead_churn));
}

#[tokio::test(flavor = "current_thread")]
async fn off_switch_retires_a_matching_pooled_spare_instead_of_adopting_it() {
    let _serial = spare_pool_test_lock().lock().await;
    let session = format!("warm-switch-take-{}", uuid::Uuid::new_v4());
    let pid = insert_spare_in_cwd_for_test(&session, std::env::temp_dir(), false);
    let launch = epoch(&session);
    assert!(waiting(&session));
    let _off = EnabledOverride::new(false);
    assert!(take(&session, "test-spare").is_none());
    assert!(!waiting(&session), "the disabled take must retire its matching spare");
    assert!(epoch(&session) > launch, "pending starts for the old launch are invalidated");
    await_exit(&session).await.unwrap();
    assert_process_gone(pid);
    discard(&session);
}

fn spare(lead: bool) -> Spare {
    let child = idle_sleep_command().spawn().unwrap();
    let group = ProcessGroup::register(child.id());
    Spare { key: "switch-test".into(), child, group, server: None, launch: 0,
        born: std::time::Instant::now(), born_wall: std::time::SystemTime::now(), idle: IDLE, lead, renewal_due: false, cwd: None }
}

#[tokio::test]
async fn a_switch_off_retires_both_pools_and_cancels_inflight_and_expired_renewals() {
    let pool: &'static Pool = Box::leak(Box::default());
    let ids: Vec<_> = ["ordinary", "lead", "starting", "expired"].into_iter()
        .map(|name| format!("warm-switch-{name}-{}", uuid::Uuid::new_v4())).collect();
    for id in &ids { launched(id); }
    let epochs: Vec<_> = ids.iter().map(|id| epoch(id)).collect();
    let mut pids = Vec::new();
    for (id, lead) in [(&ids[0], false), (&ids[1], true), (&ids[3], true)] {
        let mut spare = spare(lead);
        spare.cwd = Some(std::env::temp_dir());
        pids.push(spare.child.id().unwrap());
        assert!(register(pool, id, epoch(id), spare));
    }
    // A renewal may be between removing its expired spare and checking its next launch.
    let born = spares(pool).spares[&ids[3]].born;
    let (expired, pending, renewing) = take_expired_for_renewal(pool, &ids[3], born, true).unwrap();
    retire(&ids[3], expired, pending);
    let inflight = InFlight::enter(pool, ids[2].clone(), std::env::temp_dir(), false);
    let chain = until_discarded(pool, Arc::new(|| true));
    assert!(chain());
    // Even losing a diagnostic note cannot let an expiry check restart after off → on.
    spares(pool).gone.clear();
    disable_all_from(pool);
    assert!(!chain());
    assert!(spares(pool).spares.is_empty());
    // The start and the renewal check still run until their guards drop: cancelled, not forgotten.
    assert_eq!(spares(pool).starting.len(), 2);
    assert!(spares(pool).starting.values().all(|entry| entry.cancelled));
    let waiting: Renew = Arc::new(|| true);
    for (id, old) in ids.iter().zip(epochs) {
        assert!(epoch(id) > old, "{id}'s pending work was invalidated");
        assert!(!renews(Some(&waiting), old, epoch(id), 0, true));
        let mut command = idle_sleep_command();
        assert!(spawn_when_current(id, old, async { Ok(()) }, &mut command, || false).await.unwrap().is_none());
        assert!(!register(pool, id, old, spare(true)), "a late spawn must retire, never repool");
        await_exit(id).await.unwrap();
    }
    for pid in pids { assert_process_gone(pid); }
    drop(inflight);
    drop(renewing);
    assert!(spares(pool).starting.is_empty(), "each guard removes its own entry");
    disable_all_from(pool); // idempotent, including already-expired lead notes
    for id in &ids { discard_from(pool, id); }
}

#[tokio::test]
async fn folder_quiescence_cancels_a_lead_blocked_in_its_expiry_renewal() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static STARTS: AtomicUsize = AtomicUsize::new(0);
    fn counted_spawn(config: RunConfig, _: Vec<Value>, _: HashSet<String>, _: u64, _: bool) -> Spawning {
        Box::pin(async move {
            STARTS.fetch_add(1, Ordering::SeqCst);
            let Spare { key, child, group, server, .. } = spare(true);
            let starting = pending_in_cwd(&config.session_id, None);
            Ok(Some(Spawned { key, child, group, server, starting }))
        })
    }

    let pool: &'static Pool = Box::leak(Box::default());
    let session = format!("warm-folder-renewal-{}", uuid::Uuid::new_v4());
    let folder = std::env::temp_dir().join(&session);
    let config = RunConfig { session_id: session.clone(), cwd: folder.clone(),
        ..crate::providers::tests::config("claude") };
    let life = Lifecycle { idle: Duration::from_millis(20), spawn: counted_spawn,
        current: |_, _, _, _, _| true, pool };
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let entered = Mutex::new(Some(entered_tx));
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release = Mutex::new(release_rx);
    let renew: Renew = Arc::new(move || {
        let Some(entered) = entered.lock().unwrap().take() else { return false };
        let _ = entered.send(());
        release.lock().unwrap().recv_timeout(Duration::from_secs(10)).is_ok()
    });
    let reads = Arc::new(AtomicUsize::new(0));
    let inputs: Inputs = {
        let reads = reads.clone();
        Arc::new(move || { reads.fetch_add(1, Ordering::SeqCst); String::new() })
    };
    launched(&session);
    let launch = epoch(&session);
    start(life, config, Vec::new(), HashSet::new(), launch, Some((renew.clone(), inputs)), 0).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), entered_rx).await.unwrap().unwrap();
    assert!(!waiting_in(pool, &session), "the expired spare already left the pool");
    let tracked = has_spare_in(pool, &folder);
    // This must complete while the callback is blocked: discard removes its token and
    // awaits the expired process, rather than spinning on the renewal guard.
    let quiesced = tokio::time::timeout(Duration::from_secs(5), quiesce_pool_spares_in(pool, &folder)).await;
    let invalidated = epoch(&session) != launch;
    release_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while Arc::strong_count(&renew) != 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    let starts = STARTS.load(Ordering::SeqCst);
    let input_reads = reads.load(Ordering::SeqCst);
    let empty = {
        let pool = spares(pool);
        pool.spares.is_empty() && pool.starting.is_empty()
    };
    discard_from(pool, &session);
    await_exit(&session).await.unwrap();
    quiesced.unwrap().unwrap();
    assert!(tracked, "expiry must retain the folder's in-flight renewal");
    assert!(invalidated, "folder quiescence must advance the renewal's epoch");
    assert_eq!(starts, 1, "a cancelled renewal must never spawn another process");
    assert_eq!(input_reads, 1, "a cancelled renewal must never read launch inputs again");
    assert!(empty, "the settled renewal must leave no spare or in-flight token");
}

#[tokio::test]
async fn stale_launches_never_enter_the_pool_or_read_launch_inputs() {
    let pool: &'static Pool = Box::leak(Box::default());
    let session = format!("warm-stale-start-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    let life = Lifecycle { idle: IDLE, spawn: |_, _, _, _, _| panic!("stale launch spawned"),
        current: |_, _, _, _, _| true, pool };
    launched(&session);
    let stale = epoch(&session);
    invalidate_from(pool, &session);
    for launch in [0, stale] {
        let inputs: Inputs = Arc::new(|| panic!("stale launch read its inputs"));
        start(life, config.clone(), Vec::new(), HashSet::new(), launch,
            Some((Arc::new(|| true), inputs)), 1).await.unwrap();
    }
    assert!(spares(pool).starting.is_empty());
    assert!(spares(pool).spares.is_empty());
    discard_from(pool, &session);
}

#[tokio::test]
async fn an_off_switch_during_exit_wait_prevents_the_process_from_spawning() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let session = format!("warm-switch-wait-{}", uuid::Uuid::new_v4());
    launched(&session);
    let off = Arc::new(AtomicBool::new(false));
    let waiting = off.clone();
    let mut command = idle_sleep_command();
    // The same last-moment guard as production: read after the prior CLI's exit.
    let previous_exit = async move { waiting.store(true, Ordering::SeqCst); Ok(()) };
    let stopped = || off.load(Ordering::SeqCst);
    assert!(!stopped());
    let result = spawn_when_current(&session, epoch(&session), previous_exit, &mut command, stopped).await.unwrap();
    assert!(off.load(Ordering::SeqCst));
    assert!(result.is_none());
    discard_from(&SPARES, &session);
}

/// The caller's half of a launch with no pooled spare (`run_process_launch`): the production
/// `finish_empty_launch_with`, reading the switch with `enabled_now()` on this test's thread so
/// `EnabledOverride` applies (production reads it on a blocking thread).
async fn finish_empty(pool: &Pool, found: LaunchPool) -> Option<String> {
    let LaunchPool::Empty { may_record_cold, lead, gone } = found else { panic!("no spare is pooled") };
    finish_empty_launch_with(pool, may_record_cold, lead, gone, || async { enabled_now() }).await
}

/// `finish_empty_launch_with` for an ineligible launch, failing if it reads the switch at all.
async fn finish_ineligible(pool: &Pool) -> Option<String> {
    let read = std::cell::Cell::new(false);
    let note = finish_empty_launch_with(pool, false, false, None, || { read.set(true); async { true } }).await;
    assert!(!read.get(), "an ineligible launch never reads the off switch");
    note
}

#[tokio::test(flavor = "current_thread")]
async fn with_spares_off_a_launch_without_a_spare_counts_and_logs_nothing() {
    let pool: &'static Pool = Box::leak(Box::default());
    let session = format!("warm-switch-cold-off-{}", uuid::Uuid::new_v4());
    {
        let _off = EnabledOverride::new(false);
        // Preparing a launch never logs a cold launch itself.
        let found = prepare_launch_in(pool, &session, true, false);
        assert_eq!(found, LaunchPool::Empty { may_record_cold: true, lead: false, gone: None });
        assert_eq!(finish_empty(pool, found).await, None, "no `not pooled` line with spares off");
        assert_eq!(spares(pool).ordinary.cold_without_spare, 0);
    }
    let _on = EnabledOverride::new(true);
    let found = prepare_launch_in(pool, &session, true, false);
    let note = finish_empty(pool, found).await.expect("spares on: the cold launch is logged");
    assert!(note.starts_with("Warm Claude agent not pooled; starting cold."), "{note}");
    assert_eq!(spares(pool).ordinary.cold_without_spare, 1);
    discard_from(pool, &session);
}

#[tokio::test(flavor = "current_thread")]
async fn a_first_turn_or_managed_worker_never_counts_a_cold_launch() {
    let _on = EnabledOverride::new(true);
    let pool: &'static Pool = Box::leak(Box::default());
    let session = format!("warm-switch-ineligible-{}", uuid::Uuid::new_v4());
    let before = epoch(&session);
    let found = prepare_launch_in(pool, &session, false, false);
    assert_eq!(found, LaunchPool::Empty { may_record_cold: false, lead: false, gone: None });
    assert!(epoch(&session) > before, "the launch is still counted");
    assert_eq!(finish_empty(pool, found).await, None);
    assert_eq!(finish_ineligible(pool).await, None);
    // A lead's pending gone reason is its miss, never also a cold launch.
    spares(pool).gone.insert(session.clone(), Gone::Expired);
    let found = prepare_launch_in(pool, &session, true, false);
    assert_eq!(found, LaunchPool::Empty { may_record_cold: false, lead: false, gone: Some(Gone::Expired) });
    assert!(!spares(pool).gone.contains_key(&session), "taken by the launch, said at most once");
    let note = finish_empty(pool, found).await;
    assert!(note.as_deref().is_some_and(|line| line.starts_with("Team lead's warm Claude agent not used (it expired)")), "{note:?}");
    assert_eq!(finish_ineligible(pool).await, None);
    assert_eq!(spares(pool).ordinary.cold_without_spare, 0);
    assert_eq!(spares(pool).lead.missed, 1);
    discard_from(pool, &session);
}

#[tokio::test]
async fn a_switch_off_during_the_key_check_never_counts_a_cold_launch() {
    let pool: &'static Pool = Box::leak(Box::default());
    for lead in [false, true] {
        for keyed in [true, false] {
            let session = format!("warm-switch-race-{lead}-{keyed}-{}", uuid::Uuid::new_v4());
            launched(&session);
            assert!(register(pool, &session, epoch(&session), spare(lead)));
            let LaunchPool::Pooled { discard_epoch, .. } = prepare_launch_in(pool, &session, true, false) else {
                panic!("the registered spare is pooled");
            };
            // Spares are switched off while the warm key is computed off the runtime.
            disable_all_from(pool);
            let note = if keyed {
                let (adopted, note) = take_since(pool, &session, "switch-test", true, false, discard_epoch);
                assert!(adopted.is_none(), "a discarded spare is never adopted");
                note
            } else {
                launched_without_key_since(pool, &session, "its warm key check failed", true, false, discard_epoch)
            };
            // Spares are off: neither a lead's discard nor an ordinary spare is reported as a miss.
            assert_eq!(note, None, "lead={lead}, keyed={keyed}");
            assert_eq!(spares(pool).ordinary.cold_without_spare, 0);
            assert_eq!(spares(pool).lead.missed, 0);
            await_exit(&session).await.unwrap();
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn after_a_switch_off_no_lead_reports_a_miss_or_a_cold_launch() {
    let pool: &'static Pool = Box::leak(Box::default());
    let (pooled, expired) = (format!("warm-switch-gone-pooled-{}", uuid::Uuid::new_v4()), format!("warm-switch-gone-expired-{}", uuid::Uuid::new_v4()));
    launched(&pooled);
    assert!(register(pool, &pooled, epoch(&pooled), spare(true)));
    // A lead whose spare already expired (its renewal, if any, not yet registered).
    spares(pool).gone.insert(expired.clone(), Gone::Expired);
    disable_all_from(pool);
    assert_eq!(spares(pool).lead.discarded, 1, "the pooled lead spare is still counted as discarded");
    assert!(spares(pool).gone.is_empty(), "switching spares off clears every lead's `gone` note");
    let _off = EnabledOverride::new(false);
    for session in [&pooled, &expired] {
        let found = prepare_launch_in(pool, session, true, false);
        assert_eq!(found, LaunchPool::Empty { may_record_cold: true, lead: false, gone: None }, "{session} has no miss to report");
        assert_eq!(finish_empty(pool, found).await, None, "{session} logs no cold launch with spares off");
    }
    assert_eq!(spares(pool).lead.missed, 0);
    assert_eq!(spares(pool).ordinary.cold_without_spare, 0);
    await_exit(&pooled).await.unwrap();
}

#[tokio::test]
async fn a_settings_discard_keeps_the_switch_off_state_a_switch_off_moves() {
    let pool: &'static Pool = Box::leak(Box::default());
    let (pooled, expired) = (format!("warm-discard-pooled-{}", uuid::Uuid::new_v4()), format!("warm-discard-expired-{}", uuid::Uuid::new_v4()));
    launched(&pooled);
    let launch = epoch(&pooled);
    assert!(register(pool, &pooled, launch, spare(true)));
    spares(pool).gone.insert(expired.clone(), Gone::Expired);
    let before = spares(pool).discard_epoch;
    let chain = until_discarded(pool, Arc::new(|| true));
    // A setting or CLI changed (Colab's MCP, an agent update): spares stay on.
    discard_all_from(pool);
    {
        let locked = spares(pool);
        assert!(locked.spares.is_empty(), "the pooled spare is retired");
        assert_eq!(locked.lead.discarded, 1);
        assert_eq!(locked.discard_epoch, before, "launches keyed meanwhile still count");
        assert_eq!(locked.gone.get(&pooled), Some(&Gone::Discarded), "the lead's wake still reports its miss");
        assert_eq!(locked.gone.get(&expired), Some(&Gone::Expired));
    }
    assert!(epoch(&pooled) > launch, "a start for the old settings is refused");
    assert!(chain(), "renewal chains end only at a switch-off");
    // Switched off: the epoch moves, every chain ends and no lead reports a miss.
    disable_all_from(pool);
    assert_ne!(spares(pool).discard_epoch, before);
    assert!(spares(pool).gone.is_empty());
    assert!(!chain());
    await_exit(&pooled).await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn with_spares_off_a_pending_lead_miss_is_neither_logged_nor_counted() {
    let pool: &'static Pool = Box::leak(Box::default());
    let session = format!("warm-switch-gone-off-{}", uuid::Uuid::new_v4());
    // Off by an unreadable data folder or a marker set without `disable_all`: the note is still there.
    spares(pool).gone.insert(session.clone(), Gone::Evicted);
    let found = {
        let _off = EnabledOverride::new(false);
        let found = prepare_launch_in(pool, &session, true, true);
        assert_eq!(found, LaunchPool::Empty { may_record_cold: false, lead: true, gone: Some(Gone::Evicted) });
        assert_eq!(finish_empty(pool, found).await, None, "no miss line with spares off");
        found
    };
    assert_eq!(spares(pool).lead, PoolStats::default(), "and no miss counted");
    assert!(!spares(pool).gone.contains_key(&session), "the note is spent: never reported later");
    // The same note with spares on is the lead's miss.
    let _on = EnabledOverride::new(true);
    let note = finish_empty(pool, found).await;
    assert!(note.as_deref().is_some_and(|line| line.starts_with("Team lead's warm Claude agent not used (it was evicted")), "{note:?}");
    assert_eq!(spares(pool).lead, PoolStats { missed: 1, ..PoolStats::default() });
    discard_from(pool, &session);
}
