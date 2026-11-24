use super::*;
use super::key::*;
use super::spawn::*;

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
fn off_marker_is_default_on_and_fail_closed_on_read_errors() {
    let dir = std::env::temp_dir().join(format!("warm-switch-marker-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    assert!(enabled_in(Ok(dir.clone())), "an absent marker enables spares");
    let marker = dir.join(WARM_SPARES_OFF_FILE);
    std::fs::write(&marker, "").unwrap();
    assert!(!enabled_in(Ok(dir.clone())), "a present marker disables spares");
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
    let spare_key = key(&prepared(prepared_config, &disabled), &[]).unwrap();
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
        assert!(spawn_claude_process(config, Vec::new(), HashSet::new(), launch).await.unwrap().is_none(),
            "disabled spares must return before looking up or spawning a CLI");
    }
    assert!(enabled_now(), "the guard restores the previous setting");
    discard(&session);
}

#[cfg(unix)]
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
    assert!(process_gone_for_test(pid), "retirement must reap the pooled process");
    discard(&session);
}

#[cfg(unix)]
fn spare(lead: bool) -> Spare {
    let mut command = Command::new("sleep");
    command.arg("30").kill_on_drop(true);
    let child = command.spawn().unwrap();
    let group = ProcessGroup::register(child.id());
    Spare { key: "switch-test".into(), child, group, server: None,
        born: std::time::Instant::now(), idle: IDLE, lead, cwd: None }
}

#[cfg(unix)]
#[tokio::test]
async fn discard_all_retires_both_pools_and_cancels_inflight_and_expired_renewals() {
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
    let inflight = InFlight::enter(pool, ids[2].clone(), std::env::temp_dir());
    let chain = until_discarded(pool, Arc::new(|| true));
    assert!(chain());
    // Even losing a diagnostic note cannot let an expiry check restart after off → on.
    spares(pool).gone.clear();
    discard_all_from(pool);
    assert!(!chain());
    assert!(spares(pool).spares.is_empty());
    assert!(spares(pool).starting.is_empty());
    let waiting: Renew = Arc::new(|| true);
    for (id, old) in ids.iter().zip(epochs) {
        assert!(epoch(id) > old, "{id}'s pending work was invalidated");
        assert!(!renews(Some(&waiting), old, epoch(id), 0, true));
        let mut command = Command::new("sleep");
        command.arg("30").kill_on_drop(true);
        assert!(spawn_when_current(id, old, async { Ok(()) }, &mut command, || false).await.unwrap().is_none());
        assert!(!register(pool, id, old, spare(true)), "a late spawn must retire, never repool");
        await_exit(id).await.unwrap();
    }
    for pid in pids { assert!(process_gone_for_test(pid)); }
    drop(inflight);
    drop(renewing);
    discard_all_from(pool); // idempotent, including already-expired lead notes
    for id in &ids { discard_from(pool, id); }
}

#[cfg(unix)]
#[tokio::test]
async fn folder_quiescence_cancels_a_lead_blocked_in_its_expiry_renewal() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static STARTS: AtomicUsize = AtomicUsize::new(0);
    fn counted_spawn(_: RunConfig, _: Vec<Value>, _: HashSet<String>, _: u64) -> Spawning {
        Box::pin(async {
            STARTS.fetch_add(1, Ordering::SeqCst);
            let Spare { key, child, group, server, .. } = spare(true);
            Ok(Some(Spawned { key, child, group, server, starting: Pending::none() }))
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
    let life = Lifecycle { idle: IDLE, spawn: |_, _, _, _| panic!("stale launch spawned"),
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

#[cfg(unix)]
#[tokio::test]
async fn an_off_switch_during_exit_wait_prevents_the_process_from_spawning() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let session = format!("warm-switch-wait-{}", uuid::Uuid::new_v4());
    launched(&session);
    let off = Arc::new(AtomicBool::new(false));
    let waiting = off.clone();
    let mut command = Command::new("sleep");
    command.arg("30").kill_on_drop(true);
    // The same last-moment guard as production: read after the prior CLI's exit.
    let previous_exit = async move { waiting.store(true, Ordering::SeqCst); Ok(()) };
    let stopped = || off.load(Ordering::SeqCst);
    assert!(!stopped());
    let result = spawn_when_current(&session, epoch(&session), previous_exit, &mut command, stopped).await.unwrap();
    assert!(off.load(Ordering::SeqCst));
    assert!(result.is_none());
    discard_from(&SPARES, &session);
}
