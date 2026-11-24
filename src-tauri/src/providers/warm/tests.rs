//! Spare retirement and exits, adoption across launches, folder quiescence and the pool limits.
use super::*;
use super::key::*;
use super::spawn::*;
use super::test_support::*;

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

#[tokio::test]
async fn evicted_spares_are_handed_back_to_drop_outside_the_lock() {
    let mut pool = Spares::default();
    assert!(admit(&mut pool, "task-a".into(), idle_spare(false, Duration::from_secs(30))).is_empty());
    assert!(admit(&mut pool, "task-b".into(), idle_spare(false, Duration::from_secs(20))).is_empty());
    let evicted = admit(&mut pool, "task-c".into(), idle_spare(false, Duration::ZERO));
    assert_eq!(evicted.len(), 1);
    assert!(!pool.spares.contains_key("task-a"), "the oldest went: {:?}", pool.spares.keys().collect::<Vec<_>>());
}

#[tokio::test]
async fn a_replaced_spare_is_handed_back_with_its_reason() {
    let mut pool = Spares::default();
    assert!(admit(&mut pool, "lead-a".into(), idle_spare(true, Duration::from_secs(10))).is_empty());
    let replaced = admit(&mut pool, "lead-a".into(), idle_spare(true, Duration::ZERO));
    assert_eq!(replaced.len(), 1, "the old spare is dropped by the caller, outside the lock");
    assert!(replaced[0].1.born < pool.spares["lead-a"].born, "the newer spare stays");
    assert!(!pool.gone.contains_key("lead-a"), "no stale `Replaced` note beside the fresh spare");
    assert_eq!(pool.lead.replaced, 1, "the replacement is still counted");
    assert_eq!(admit(&mut pool, "task-a".into(), idle_spare(false, Duration::ZERO)).len(), 0);
    assert_eq!(admit(&mut pool, "task-a".into(), idle_spare(false, Duration::ZERO)).len(), 1);
    assert!(!pool.gone.contains_key("task-a"), "ordinary spares keep no reason");
}

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

#[tokio::test]
async fn quiesce_leaves_no_spare_and_no_pending_exit() {
    let (pool, session) = (own_pool(), format!("warm-quiesce-{}", uuid::Uuid::new_v4()));
    let spare = idle_spare(false, Duration::ZERO);
    let pid = spare.child.id().unwrap();
    spares(pool).spares.insert(session.clone(), spare);
    quiesce_in(pool, &session).await.unwrap();
    assert!(!waiting_in(pool, &session), "no spare is left");
    assert_process_gone(pid);
    assert!(super::super::exit::exit_registry().lock().unwrap().get(&session).is_none(), "no exit is pending");
}

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

#[tokio::test]
async fn a_mismatched_or_exited_warm_agent_is_discarded() {
    let spawn = || {
        let child = idle_sleep_command().spawn().unwrap();
        let group = ProcessGroup::register(None);
        (child, group)
    };
    let (pool, session) = (own_pool(), format!("warm-test-{}", uuid::Uuid::new_v4()));
    let insert = |child: Child, group: ProcessGroup| {
        spares(pool).spares.insert(session.clone(), Spare { key: "launch-a".into(), child, group, server: None, born: std::time::Instant::now(), born_wall: std::time::SystemTime::now(), idle: IDLE, lead: false, cwd: None });
    };
    let (child, group) = spawn();
    insert(child, group);
    assert!(take_in(pool, &session, "launch-b", true).0.is_none(), "a different launch starts cold");
    assert!(!waiting_in(pool, &session), "and the stale agent is gone");
    let (child, group) = spawn();
    insert(child, group);
    let mut adopted = take_in(pool, &session, "launch-a", true).0.expect("the matching agent is adopted");
    adopted.0.child.kill().await.unwrap();
    let (mut child, group) = spawn();
    child.kill().await.unwrap();
    child.wait().await.unwrap();
    insert(child, group);
    assert!(take_in(pool, &session, "launch-a", true).0.is_none(), "an agent that exited is never adopted");
    discard_from(pool, &session);
}

#[tokio::test]
async fn a_missed_spare_is_gone_before_the_cold_launch_may_start() {
    let (pool, session) = (own_pool(), format!("warm-miss-{}", uuid::Uuid::new_v4()));
    let spare = idle_spare(false, Duration::ZERO);
    let pid = spare.child.id().unwrap();
    spares(pool).spares.insert(session.clone(), spare);
    assert!(take_in(pool, &session, "another launch", true).0.is_none());
    // The cold launch's `await_exit` returns only once the dropped spare has exited.
    await_exit(&session).await.unwrap();
    assert_process_gone(pid);
    assert!(!super::super::exit::exit_registry().lock().unwrap().contains_key(&session), "the registry entry is released");
}

#[tokio::test]
async fn a_discarded_spare_is_gone_before_the_console_may_resume_the_session() {
    let (pool, session) = (own_pool(), format!("warm-console-{}", uuid::Uuid::new_v4()));
    let spare = idle_spare(false, Duration::ZERO);
    let pid = spare.child.id().unwrap();
    spares(pool).spares.insert(session.clone(), spare);
    discard_from(pool, &session);
    assert!(!waiting_in(pool, &session));
    await_exit(&session).await.unwrap();
    assert_process_gone(pid);
    // Nothing left to wait for.
    await_exit(&session).await.unwrap();
}

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
    assert_process_gone(pid);
    assert!(!super::super::exit::exit_registry().lock().unwrap().contains_key(&session));
}

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
    assert_process_gone(first_pid);
    assert_process_gone(old_pid);
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

#[tokio::test]
async fn a_launch_without_a_spare_retires_the_pooled_one() {
    let _serial = spare_pool_test_lock().lock().await;
    let session = format!("warm-hostless-{}", uuid::Uuid::new_v4());
    let spare = idle_spare(false, Duration::ZERO);
    let pid = pid_of(&spare);
    spares(&SPARES).spares.insert(session.clone(), spare);
    launched_without_spare(&session);
    assert!(!waiting_in(&SPARES, &session), "the spare must not idle beside the cold process");
    await_exit(&session).await.unwrap();
    assert_process_gone(pid);
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

#[tokio::test]
async fn a_spare_whose_launch_moved_during_its_exit_wait_never_spawns() {
    let session = "moved-during-exit-wait";
    launched(session);
    let launch = epoch(session);
    let mut command = idle_sleep_command();
    let follow_up = async { launched(session); Ok(()) };
    let spawned = spawn_when_current(session, launch, follow_up, &mut command, || false).await.unwrap();
    assert!(spawned.is_none(), "a stale spare must not start a process");
    let current = epoch(session);
    let spawned = spawn_when_current(session, current, async { Ok(()) }, &mut command, || false).await.unwrap();
    let (mut child, _starting) = spawned.expect("a current spare spawns");
    child.kill().await.unwrap();
}

#[tokio::test]
async fn an_exit_wait_started_during_a_spares_spawn_waits_until_the_spare_is_gone() {
    let session = format!("warm-spawn-window-{}", uuid::Uuid::new_v4());
    launched(&session);
    let launch = epoch(&session);
    let mut command = idle_sleep_command();
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
    let spare = Spare { key: "k".into(), child, group: ProcessGroup::register(Some(pid)), server: None, born: std::time::Instant::now(), born_wall: std::time::SystemTime::now(), idle: IDLE, lead: false, cwd: None };
    assert!(!register(own_pool(), &session, launch, spare), "a spare from an older launch is refused");
    drop(starting);
    tokio::time::timeout(Duration::from_secs(10), waiter).await.unwrap().unwrap().unwrap();
    assert_process_gone(pid);
}

#[cfg(unix)]
#[tokio::test]
async fn a_spare_whose_adoption_fails_is_retired_and_awaited() {
    let session = format!("failed-adopt-{}", std::process::id());
    let spare = idle_spare(false, Duration::ZERO);
    let pid = spare.child.id().unwrap();
    // Taken for adoption, then the launch failed before it owned the streams.
    let adopting = Adopting { pool: own_pool(), session_id: session.clone(), spare: Some((spare, Pending::none())) };
    drop(adopting);
    assert!(exit_registry().lock().unwrap().contains_key(&session), "the failed adopt registered no exit");
    tokio::time::timeout(Duration::from_secs(10), await_exit(&session)).await.unwrap().unwrap();
    assert!(process_gone(pid), "the next launch would have started beside the dying spare");
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
        let policy = crate::claude_roots::resolve_claude_config_dir_env(&env, &cwd, cfg!(windows));
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
    let standard_key = key(&standard, &[]).unwrap();
    let off_key = key(&toggled_off, &[]).unwrap();
    let fast_key = key(&fast, &[]).unwrap();
    assert_eq!(standard_key, off_key);
    assert_eq!(key(&other_tier, &[]).as_deref(), Some(standard_key.as_str()));
    assert_ne!(standard_key, fast_key);
    assert_eq!(miss(true, &standard_key, &fast_key, false).as_deref(), Some("changed: fastMode"));
    assert_eq!(miss(true, &fast_key, &off_key, false).as_deref(), Some("changed: fastMode"));
}

#[tokio::test]
async fn a_warm_spare_is_never_adopted_across_a_claude_fast_mode_toggle() {
    let pool = own_pool();
    let session = format!("warm-fast-mode-{}", uuid::Uuid::new_v4());
    let base = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    let standard_key = key(&base, &[]).unwrap();
    let off_key = key(&RunConfig { codex_settings: Some(json!({"serviceTier": null})), ..base.clone() }, &[]).unwrap();
    let fast_key = key(&RunConfig { codex_settings: Some(json!({"serviceTier": "fast"})), ..base.clone() }, &[]).unwrap();
    let insert = |lead: bool, spare_key: &str| {
        let spare = Spare { key: spare_key.into(), ..idle_spare(lead, Duration::ZERO) };
        let pid = pid_of(&spare);
        spares(pool).spares.insert(session.clone(), spare);
        pid
    };
    // Toggling Fast mode ON never adopts a standard-speed spare.
    let pid = insert(false, &standard_key);
    let (adopted, note) = take_in(pool, &session, &fast_key, true);
    assert!(adopted.is_none());
    assert_eq!(
        note.as_deref(),
        Some("Warm Claude agent not used (changed: fastMode); starting cold. Ordinary spares since launch: 0 started, 0 adopted, 1 not used, 0 expired, 0 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare.")
    );
    assert!(!waiting_in(pool, &session));
    await_exit(&session).await.unwrap();
    assert_process_gone(pid);
    // Toggling Fast mode OFF never adopts a fast-mode spare (which would overbill the next turn).
    let pid = insert(false, &fast_key);
    let (adopted, note) = take_in(pool, &session, &off_key, true);
    assert!(adopted.is_none());
    assert_eq!(
        note.as_deref(),
        Some("Warm Claude agent not used (changed: fastMode); starting cold. Ordinary spares since launch: 0 started, 0 adopted, 2 not used, 0 expired, 0 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare.")
    );
    assert!(!waiting_in(pool, &session));
    await_exit(&session).await.unwrap();
    assert_process_gone(pid);
    // A lead spare also refuses a fast-mode mismatch and reports the field name.
    let pid = insert(true, &fast_key);
    let (adopted, note) = take_in(pool, &session, &off_key, true);
    assert!(adopted.is_none());
    assert!(note.as_deref().is_some_and(|line| line.contains("Team lead's warm Claude agent not used (changed: fastMode)")), "{note:?}");
    await_exit(&session).await.unwrap();
    assert_process_gone(pid);
    // Matching fast mode adopts cleanly, and standard None <-> serviceTier:null adopts cleanly.
    insert(false, &fast_key);
    let (adopted, note) = take_in(pool, &session, &fast_key, true);
    assert_eq!(note.as_deref(), Some("Warm Claude agent adopted. Ordinary spares since launch: 0 started, 1 adopted, 2 not used, 0 expired, 0 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare."));
    let (mut spare, _pending) = adopted.expect("matching fast-mode spare is adopted");
    spare.child.kill().await.unwrap();
    insert(false, &standard_key);
    let (adopted, note) = take_in(pool, &session, &off_key, true);
    assert_eq!(note.as_deref(), Some("Warm Claude agent adopted. Ordinary spares since launch: 0 started, 2 adopted, 2 not used, 0 expired, 0 evicted, 0 replaced, 0 discarded; 0 cold launches without a spare."));
    let (mut spare, _pending) = adopted.expect("standard None and serviceTier:null share one warm key");
    spare.child.kill().await.unwrap();
}

#[test]
fn path_in_folder_matches_canonical_nested_and_deleted_folders() {
    let base = std::env::temp_dir().join(format!("pandacode-warm-path-{}", uuid::Uuid::new_v4().simple()));
    let _cleanup = TempDir(base.clone());
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

}

#[tokio::test]
async fn invalidating_a_running_turn_advances_epoch_retires_stale_spare_and_allows_post_turn_prewarm() {
    let pool = own_pool();
    let never = format!("warm-never-{}", uuid::Uuid::new_v4());
    // Invalidating a task that has never launched does not insert a launch epoch.
    invalidate_from(pool, &never);
    assert_eq!(epoch(&never), 0);

    let session = format!("warm-invalidate-{}", uuid::Uuid::new_v4());
    let base = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    let standard_key = key(&base, &[]).unwrap();
    let fast_cfg = RunConfig { codex_settings: Some(json!({"serviceTier": "fast"})), ..base.clone() };
    let fast_key = key(&fast_cfg, &[]).unwrap();

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
    assert_process_gone(stale_pid);

    let after = epoch(&session);
    assert_ne!(after, 0, "mid-turn invalidation must keep a nonzero epoch for the running turn");
    assert!(after > before, "epoch must advance so older in-flight spawns and renewals abort");

    // Any in-flight spare or renewal from `before` is refused.
    let waiting_lead: Renew = Arc::new(|| true);
    assert!(!renews(Some(&waiting_lead), before, after, 0, true));
    let mut cmd = idle_sleep_command();
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
        born_wall: std::time::SystemTime::now(),
        idle: IDLE,
        lead: true,
        cwd: Some(external_path(&fast_cfg.cwd)),
    };
    assert!(register(pool, &session, after, fresh), "post-turn spare must register");
    drop(starting);
    assert!(waiting_in(pool, &session));

    let (adopted, _) = take_in(pool, &session, &fast_key, true);
    let (mut spare, _pending) = adopted.expect("next turn adopts the fast-mode spare");
    spare.child.kill().await.unwrap();
    let _ = spare.child.wait().await;
}

#[cfg(unix)]
#[tokio::test]
async fn discard_in_retires_canonical_nested_inflight_and_deleted_folder_spares_with_pending_handoff() {
    let pool = own_pool();
    let base = std::env::temp_dir().join(format!("pandacode-warm-folder-{}", uuid::Uuid::new_v4().simple()));
    let _cleanup = TempDir(base.clone());
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
    let inflight_guard = InFlight::enter(pool, inflight_id.clone(), external_path(&folder), false);

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
}

/// `spawn_claude_process` keyed as for a legacy connection keeping `HOME` as a secret.
fn spawn_unresolvable(config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64, _lead: bool) -> Spawning {
    Box::pin(spawn_claude_keyed(config, tools, approval_tools, launch, |config, catalog, disabled, stdio| {
        key_for_connection(config, catalog, "legacy#1", Some(&legacy_secret_connection("HOME")), disabled, stdio, None)
    }))
}

#[tokio::test]
async fn an_unresolvable_user_config_folder_starts_no_spare() {
    let session = format!("warm-unresolvable-spawn-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    let tools = vec![json!({"type":"function","name":"pandacode_title"})];
    launched(&session); // a prewarm always follows a launch, never launch 0
    let launch = epoch(&session);
    // Declined before the secret store, the executable search, the tool server or the process,
    // so this holds with no Claude Code installed.
    let spawned = spawn_unresolvable(config.clone(), tools.clone(), HashSet::new(), launch, false).await.unwrap();
    assert!(spawned.is_none(), "no process is started for a launch that has no warm key");
    let life = Lifecycle { idle: Duration::from_secs(3600), spawn: spawn_unresolvable, current: |_, _, _, _, _| true, pool: own_pool() };
    start(life, config, tools, HashSet::new(), launch, None, 0).await.unwrap();
    assert!(!waiting_in(life.pool, &session), "nothing is registered in the pool");
    assert!(spares(life.pool).spares.is_empty());
    discard(&session);
}
