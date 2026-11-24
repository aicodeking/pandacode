//! Each pool's churn backoff: evictions, unused expiries (a lead's renewal chain counted once,
//! nothing with spares off) and launch-time misses in a row, each cleared by an adoption or a
//! lapsed cooldown.
use super::*;
use super::spawn::*;
use super::stats::{record_lead_miss, CHURN_COOLDOWN, EXPIRY_BACKOFF_STREAK, EXPIRY_COOLDOWN, MISS_BACKOFF_STREAK};
use super::test_support::*;

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

#[test]
fn unused_expiries_in_a_row_back_off_until_the_cooldown_lapses() {
    let now = std::time::Instant::now();
    let mut churn = PoolChurn::default();
    for _ in 1..EXPIRY_BACKOFF_STREAK {
        churn.expired(now);
        assert!(!churn.cooling(now), "a follow-up that missed the window is ordinary");
    }
    churn.expired(now);
    assert!(churn.cooling(now), "{EXPIRY_BACKOFF_STREAK} unused in a row with no adoption between back off");
    assert!(churn.cooling(now + CHURN_COOLDOWN), "for longer than an eviction backoff");
    assert!(!churn.cooling(now + EXPIRY_COOLDOWN), "a lapsed backoff probes again");
    assert_eq!(churn, PoolChurn::default(), "and starts fresh streaks");
    // An eviction backoff never shortens a longer expiry backoff already set.
    let mut both = PoolChurn::default();
    for _ in 0..EXPIRY_BACKOFF_STREAK {
        both.expired(now);
    }
    both.evicted(1, now);
    assert_eq!(both.churn_cooldown_until, now.checked_add(EXPIRY_COOLDOWN));
}

#[tokio::test]
async fn unused_expiries_back_off_each_pool_apart_and_an_adoption_clears_it() {
    let pool = own_pool();
    // Spares that expire within a few timer slices, and ones that wait out the whole test.
    let quick = Lifecycle { idle: Duration::from_millis(20), pool, ..stub() };
    let holding = Lifecycle { idle: Duration::from_secs(3600), pool, ..stub() };
    let session = format!("warm-expiry-churn-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    let turn = |life: Lifecycle| {
        launched(&session);
        start(life, config.clone(), Vec::new(), HashSet::new(), epoch(&session), None, 0)
    };
    // Each spare really waits out its window unused, and counts once it settles with spares on.
    for streak in 1..=EXPIRY_BACKOFF_STREAK {
        assert!(turn(quick).await.unwrap());
        assert!(eventually(|| spares(pool).ordinary_churn.consecutive_expiries == streak).await, "expiry {streak}");
    }
    {
        let locked = spares(pool);
        assert_eq!(locked.ordinary.expired, u64::from(EXPIRY_BACKOFF_STREAK));
        assert!(locked.ordinary_churn.churn_cooldown_until.is_some());
        assert_eq!(locked.lead_churn, PoolChurn::default(), "the lead pool keeps its own streak");
    }
    assert!(!turn(holding).await.unwrap(), "no spare starts while the pool backs off");
    assert_eq!(stub_starts(&session), EXPIRY_BACKOFF_STREAK);
    assert_eq!(spares(pool).ordinary.churn_skipped, 1);
    // A lead spare still starts in its own pool.
    let lead_session = format!("warm-expiry-churn-lead-{}", uuid::Uuid::new_v4());
    let lead_config = RunConfig { session_id: lead_session.clone(), ..crate::providers::tests::config("claude") };
    launched(&lead_session);
    assert!(start(holding, lead_config, Vec::new(), HashSet::new(), epoch(&lead_session), lead(Arc::new(|| true)), 0).await.unwrap());
    // A launch adopting a spare ends the backoff at once.
    let evicted = admit(&mut spares(pool), session.clone(), idle_spare(false, Duration::ZERO));
    assert!(evicted.is_empty());
    let (adopted, note) = take_in(pool, &session, "launch", true);
    assert!(adopted.is_some() && note.as_deref().is_some_and(|line| line.starts_with("Warm Claude agent adopted.")), "{note:?}");
    assert_eq!(spares(pool).ordinary_churn, PoolChurn::default());
    drop(adopted);
    assert!(turn(holding).await.unwrap(), "an adoption clears the backoff");
    for id in [&session, &lead_session] {
        discard_from(pool, id);
        await_exit(id).await.unwrap();
    }
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

/// Starts a read-only team lead's spare and waits until its whole renewal chain has run out
/// unadopted (`1 + MAX_RENEWALS` spares, the last one expired for good).
async fn lead_chain_runs_out(life: Lifecycle, name: &str) -> String {
    let session = format!("warm-chain-{name}-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    launched(&session); // a prewarm always follows a launch, never launch 0
    assert!(start(life, config, Vec::new(), HashSet::new(), epoch(&session), lead(Arc::new(|| true)), 0).await.unwrap());
    assert!(eventually(|| stub_starts(&session) == 1 + MAX_RENEWALS).await, "renewed: {}", stub_starts(&session));
    assert!(eventually(|| !waiting_in(life.pool, &session)).await, "the last spare expires for good");
    session
}

/// Windows long enough that a loaded runner stays well inside each chain's wall-clock bound
/// (`chain_expired`: three windows from the first start).
fn chain_life() -> Lifecycle {
    Lifecycle { idle: Duration::from_millis(800), ..stub() }
}

#[tokio::test]
async fn two_read_only_teams_renewing_at_once_never_trip_the_expiry_backoff() {
    let life = chain_life();
    let (a, b) = futures_util::future::join(lead_chain_runs_out(life, "a"), lead_chain_runs_out(life, "b")).await;
    // Each finished chain counts once: two, short of the streak, and nothing mid-chain.
    assert!(eventually(|| spares(life.pool).lead_churn.consecutive_expiries == 2).await, "{:?}", spares(life.pool).lead_churn);
    {
        let locked = spares(life.pool);
        assert_eq!(locked.lead.churn_skipped, 0, "no renewal was skipped mid-chain");
        assert_eq!(locked.lead.expired, u64::from(2 * (1 + MAX_RENEWALS)), "every spare still counts as expired");
        assert_eq!(locked.lead_churn.churn_cooldown_until, None);
    }
    for session in [&a, &b] {
        await_exit(session).await.unwrap();
    }
}

#[tokio::test]
async fn a_whole_unadopted_lead_chain_counts_one_expiry_toward_the_backoff() {
    let life = chain_life();
    let first = lead_chain_runs_out(life, "first").await;
    assert!(eventually(|| spares(life.pool).lead_churn.consecutive_expiries == 1).await, "{:?}", spares(life.pool).lead_churn);
    assert_eq!(spares(life.pool).lead.expired, u64::from(1 + MAX_RENEWALS));
    assert_eq!(spares(life.pool).lead_churn.churn_cooldown_until, None, "one chain is no streak");
    // Only `EXPIRY_BACKOFF_STREAK` finished unadopted chains pause the lead pool.
    let (second, third) = futures_util::future::join(lead_chain_runs_out(life, "second"), lead_chain_runs_out(life, "third")).await;
    assert!(eventually(|| spares(life.pool).lead_churn.consecutive_expiries == EXPIRY_BACKOFF_STREAK).await, "{:?}", spares(life.pool).lead_churn);
    {
        let locked = spares(life.pool);
        assert!(locked.lead_churn.churn_cooldown_until.is_some());
        assert_eq!(locked.lead.churn_skipped, 0, "every chain renewed in full");
        assert_eq!(locked.ordinary_churn, PoolChurn::default(), "the ordinary pool keeps its own streak");
    }
    let next = format!("warm-chain-next-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: next.clone(), ..crate::providers::tests::config("claude") };
    launched(&next);
    assert!(!start(life, config, Vec::new(), HashSet::new(), epoch(&next), lead(Arc::new(|| true)), 0).await.unwrap());
    assert_eq!(stub_starts(&next), 0, "no lead spare starts while the lead pool backs off");
    assert_eq!(spares(life.pool).lead.churn_skipped, 1);
    for session in [&first, &second, &third] {
        await_exit(session).await.unwrap();
    }
}

#[tokio::test]
async fn an_expiry_with_spares_off_neither_counts_toward_the_backoff_nor_logs() {
    let pool = own_pool();
    // An ordinary spare expiring with the switch off, and a lead's whose check found it off.
    assert_eq!(settle_expiry(pool, false, false), None);
    assert!(!chain_ended_unused(false, 4, 4, Expiry::Off));
    assert_eq!(settle_lead_expiry(pool, false, 4, 4, Expiry::Off), None);
    assert_eq!(spares(pool).ordinary_churn, PoolChurn::default());
    assert_eq!(spares(pool).lead_churn, PoolChurn::default());
    // With spares on, each counts once and logs its line.
    let line = settle_expiry(pool, false, true);
    assert!(line.as_deref().is_some_and(|line| line.starts_with("Warm Claude agent expired idle.")), "{line:?}");
    let line = settle_lead_expiry(pool, false, 4, 4, Expiry::Changed);
    assert!(line.as_deref().is_some_and(|line| line.starts_with("Team lead's warm Claude agent expired idle (not renewed")), "{line:?}");
    // A renewal that pooled, a wake that superseded it or a forgotten task: neither.
    for (renewed, launch, epoch) in [(true, 4, 4), (false, 4, 5), (false, 0, 0)] {
        assert!(!chain_ended_unused(renewed, launch, epoch, Expiry::Current));
        assert_eq!(settle_lead_expiry(pool, renewed, launch, epoch, Expiry::Current), None);
    }
    assert_eq!(spares(pool).ordinary_churn.consecutive_expiries, 1);
    assert_eq!(spares(pool).lead_churn.consecutive_expiries, 1);
    // A real ordinary spare expiring while the switch reads off (a headless host's marker).
    // Keep the thread-local override active via Drop until the timer task has settled and exited.
    struct OffGuard(Option<bool>);
    impl Drop for OffGuard {
        fn drop(&mut self) {
            ENABLED_OVERRIDE.with(|value| value.set(self.0));
        }
    }
    let _off = OffGuard(ENABLED_OVERRIDE.with(|value| value.replace(Some(false))));
    let life = Lifecycle { idle: Duration::from_millis(20), ..stub() };
    let session = format!("warm-expiry-off-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    launched(&session);
    assert!(start(life, config, Vec::new(), HashSet::new(), epoch(&session), None, 0).await.unwrap());
    assert!(eventually(|| spares(life.pool).ordinary.expired == 1).await, "the spare expired");
    await_exit(&session).await.unwrap();
    tokio::task::yield_now().await;
    assert_eq!(spares(life.pool).ordinary_churn, PoolChurn::default(), "spares off: no expiry streak");
}

#[test]
fn launch_time_misses_in_a_row_back_off_for_the_churn_cooldown() {
    let now = std::time::Instant::now();
    let mut churn = PoolChurn::default();
    for _ in 1..MISS_BACKOFF_STREAK {
        churn.missed(now);
        assert!(!churn.cooling(now), "a stale spare now and then is ordinary");
    }
    churn.missed(now);
    assert!(churn.cooling(now), "{MISS_BACKOFF_STREAK} misses in a row with no adoption between back off");
    assert_eq!(churn.churn_cooldown_until, now.checked_add(CHURN_COOLDOWN));
    assert!(!churn.cooling(now + CHURN_COOLDOWN), "a lapsed backoff probes again");
    assert_eq!(churn, PoolChurn::default(), "and starts fresh streaks");
    // A miss backoff never shortens a longer expiry backoff already set.
    let mut both = PoolChurn::default();
    for _ in 0..EXPIRY_BACKOFF_STREAK {
        both.expired(now);
    }
    for _ in 0..MISS_BACKOFF_STREAK {
        both.missed(now);
    }
    assert_eq!(both.churn_cooldown_until, now.checked_add(EXPIRY_COOLDOWN));
}

#[tokio::test]
async fn launch_time_misses_back_off_each_pool_apart_and_an_adoption_clears_them() {
    let life = Lifecycle { idle: Duration::from_secs(3600), ..stub() };
    let pool = life.pool;
    let session = format!("warm-miss-churn-{}", uuid::Uuid::new_v4());
    let config = RunConfig { session_id: session.clone(), ..crate::providers::tests::config("claude") };
    let turn = || {
        launched(&session);
        start(life, config.clone(), Vec::new(), HashSet::new(), epoch(&session), None, 0)
    };
    // Each follow-up finds its spare stale (another task committed between turns: `gitHead`).
    for streak in 1..=MISS_BACKOFF_STREAK {
        assert!(turn().await.unwrap(), "spare {streak} starts");
        let (taken, note) = take_in(pool, &session, "changed", true);
        assert!(taken.is_none() && note.as_deref().is_some_and(|line| line.starts_with("Warm Claude agent not used")), "{note:?}");
        assert_eq!(spares(pool).ordinary_churn.consecutive_misses, streak);
    }
    {
        let locked = spares(pool);
        assert_eq!(locked.ordinary.missed, u64::from(MISS_BACKOFF_STREAK));
        assert!(locked.ordinary_churn.churn_cooldown_until.is_some());
        assert_eq!(locked.lead_churn, PoolChurn::default(), "the lead pool keeps its own streak");
    }
    assert!(!turn().await.unwrap(), "no spare starts while the pool backs off");
    assert_eq!(stub_starts(&session), MISS_BACKOFF_STREAK);
    assert_eq!(spares(pool).ordinary.churn_skipped, 1);
    // A launch adopting a spare clears every streak and the backoff at once.
    let evicted = admit(&mut spares(pool), session.clone(), idle_spare(false, Duration::ZERO));
    assert!(evicted.is_empty());
    let (adopted, note) = take_in(pool, &session, "launch", true);
    assert!(adopted.is_some() && note.as_deref().is_some_and(|line| line.starts_with("Warm Claude agent adopted.")), "{note:?}");
    assert_eq!(spares(pool).ordinary_churn, PoolChurn::default());
    drop(adopted);
    assert!(turn().await.unwrap(), "an adoption clears the backoff");
    discard_from(pool, &session);
    await_exit(&session).await.unwrap();
}

#[tokio::test]
async fn a_lead_wake_whose_spare_already_left_the_pool_joins_no_miss_streak() {
    let pool = own_pool();
    // Its removal already settled each of these; the wake only reports it.
    for why in [Gone::Evicted, Gone::Expired, Gone::Discarded, Gone::Replaced] {
        let note = record_lead_miss(&mut spares(pool), why);
        assert!(note.starts_with("Team lead's warm Claude agent not used ("), "{note}");
    }
    // The same through a launch that finds the lead's `gone` note.
    let session = format!("warm-gone-miss-{}", uuid::Uuid::new_v4());
    spares(pool).gone.insert(session.clone(), Gone::Expired);
    let LaunchPool::Empty { may_record_cold, lead, gone } = prepare_launch_in(pool, &session, true, true) else { panic!("nothing is pooled") };
    assert!(finish_empty_launch_with(pool, may_record_cold, lead, gone, || async { true }).await.is_some());
    let locked = spares(pool);
    assert_eq!(locked.lead.missed, 5, "each wake is counted as not used");
    assert_eq!(locked.lead_churn, PoolChurn::default(), "but never twice into a streak");
}
