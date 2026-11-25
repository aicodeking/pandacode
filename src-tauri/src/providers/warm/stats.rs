//! Each pool's lifecycle totals since launch (in memory only), the stderr lines that report
//! them, and the round-robin churn backoff. The formats are documented character for character
//! in docs/worker-tokens.md.
use super::{spares, Pool, Spares};
use serde::Serialize;
use std::time::{Duration, Instant, SystemTime};

/// Why a lead spare left the pool before its wake.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::providers) enum Gone {
    /// A newer lead spare pushed it out of the bounded lead pool.
    Evicted,
    /// Its team stopped or paused, its task was deleted, or a setting or CLI behind it changed.
    Discarded,
    /// It waited `IDLE` (and was not renewed, or its renewal has not registered yet).
    Expired,
    /// A newer spare for the same task took its place.
    Replaced,
}

impl Gone {
    pub(super) fn reason(self) -> &'static str {
        match self {
            Gone::Evicted => "it was evicted by a newer team's spare",
            Gone::Discarded => "it was discarded",
            Gone::Expired => "it expired",
            Gone::Replaced => "it was replaced by a newer spare for the same task",
        }
    }
}

/// One pool's spares since launch: registered, adopted or found unusable at launch, and every
/// other way one left the pool unadopted. `cold_without_spare` counts eligible launches with
/// spares on that found none pooled; `churn_skipped`, starts skipped by the churn backoff.
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PoolStats {
    pub(super) started: u64,
    pub(super) adopted: u64,
    pub(super) missed: u64,
    pub(super) expired: u64,
    pub(super) evicted: u64,
    pub(super) replaced: u64,
    pub(super) discarded: u64,
    pub(super) cold_without_spare: u64,
    pub(super) churn_skipped: u64,
}

impl PoolStats {
    /// Counts a spare that left the pool unadopted.
    pub(super) fn count(&mut self, why: Gone) {
        match why {
            Gone::Evicted => self.evicted += 1,
            Gone::Discarded => self.discarded += 1,
            Gone::Expired => self.expired += 1,
            Gone::Replaced => self.replaced += 1,
        }
    }
}

/// After a pool evicts its limit of spares in a row with no adoption between (tasks taking turns
/// round-robin, each pushing out the next one's spare), it starts none for this long.
pub(super) const CHURN_COOLDOWN: Duration = Duration::from_secs(5 * 60);
/// After this many of a pool's spares in a row expire unused with no adoption between (follow-ups
/// that rarely come within `IDLE`), it starts none for `EXPIRY_COOLDOWN`. A lead's renewal chain
/// counts once, when it ends unadopted, and an expiry with spares off counts nothing.
pub(super) const EXPIRY_BACKOFF_STREAK: u32 = 3;
pub(super) const EXPIRY_COOLDOWN: Duration = Duration::from_secs(30 * 60);
/// After this many launches in a row find their pool's pooled spare dead or stale with no adoption
/// between (parallel tasks committing between each other's turns, so every follow-up misses on
/// `gitHead`), it starts none for `CHURN_COOLDOWN`. A spare that merely expired, a launch that
/// ended before adopting a usable spare and a key check that failed to run join no streak.
pub(super) const MISS_BACKOFF_STREAK: u32 = 3;

/// A pool's evictions, unused expiries and launch-time misses since its last adoption, and the
/// backoff they set (`CHURN_COOLDOWN`, `EXPIRY_COOLDOWN`) on both clocks: `Instant` may stand
/// still while the machine sleeps, the wall clock does not, so a backoff lapses once either
/// says it has. An adoption or a lapsed backoff clears every streak.
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PoolChurn {
    pub(super) consecutive_evictions: u32,
    pub(super) consecutive_expiries: u32,
    pub(super) consecutive_misses: u32,
    pub(super) churn_cooldown_until: Option<Instant>,
    pub(super) churn_cooldown_until_wall: Option<SystemTime>,
}

impl PoolChurn {
    /// One more spare evicted unadopted; at `limit` in a row the pool backs off.
    pub(super) fn evicted(&mut self, limit: usize, now: Instant, now_wall: SystemTime) {
        self.consecutive_evictions = self.consecutive_evictions.saturating_add(1);
        if self.consecutive_evictions >= u32::try_from(limit).unwrap_or(u32::MAX) {
            self.back_off(now, now_wall, CHURN_COOLDOWN);
        }
    }

    /// One more spare (or a lead's whole renewal chain) expired unused with spares on; at
    /// `EXPIRY_BACKOFF_STREAK` in a row the pool backs off.
    pub(super) fn expired(&mut self, now: Instant, now_wall: SystemTime) {
        self.consecutive_expiries = self.consecutive_expiries.saturating_add(1);
        if self.consecutive_expiries >= EXPIRY_BACKOFF_STREAK {
            self.back_off(now, now_wall, EXPIRY_COOLDOWN);
        }
    }

    /// One more launch found its pooled spare dead or stale; at `MISS_BACKOFF_STREAK` in a row
    /// the pool backs off for `CHURN_COOLDOWN` (never shortening a longer backoff already set).
    pub(super) fn missed(&mut self, now: Instant, now_wall: SystemTime) {
        self.consecutive_misses = self.consecutive_misses.saturating_add(1);
        if self.consecutive_misses >= MISS_BACKOFF_STREAK {
            self.back_off(now, now_wall, CHURN_COOLDOWN);
        }
    }

    /// Starts none until `cooldown` from now on both clocks, keeping a later backoff already set.
    fn back_off(&mut self, now: Instant, now_wall: SystemTime, cooldown: Duration) {
        self.churn_cooldown_until = self.churn_cooldown_until.max(now.checked_add(cooldown));
        self.churn_cooldown_until_wall = self.churn_cooldown_until_wall.max(now_wall.checked_add(cooldown));
    }

    /// What is left of an active backoff: the shorter of both clocks' remainders, or `None` with
    /// none set or once either clock has reached its deadline.
    fn remaining(&self, now: Instant, now_wall: SystemTime) -> Option<Duration> {
        let monotonic = self.churn_cooldown_until.map(|until| until.checked_duration_since(now).filter(|left| !left.is_zero()));
        let wall = self.churn_cooldown_until_wall.map(|until| until.duration_since(now_wall).ok().filter(|left| !left.is_zero()));
        match (monotonic, wall) {
            (None, None) => None,
            (Some(left), None) | (None, Some(left)) => left,
            (Some(monotonic), Some(wall)) => monotonic.zip(wall).map(|(monotonic, wall)| monotonic.min(wall)),
        }
    }

    /// Whether a start is skipped now. A lapsed backoff (on either clock) clears, so the pool
    /// probes again; streaks with no backoff set yet are kept.
    pub(super) fn cooling(&mut self, now: Instant, now_wall: SystemTime) -> bool {
        if self.remaining(now, now_wall).is_some() {
            return true;
        }
        if self.churn_cooldown_until.is_some() || self.churn_cooldown_until_wall.is_some() {
            *self = Self::default();
        }
        false
    }

    /// Whole seconds left of an active backoff, rounded up (at least 1 while it lasts), else 0.
    pub(super) fn paused_secs(&self, now: Instant, now_wall: SystemTime) -> u64 {
        self.remaining(now, now_wall).map_or(0, |left| left.as_secs() + u64::from(left.subsec_nanos() > 0))
    }
}

impl Spares {
    pub(super) fn stats_mut(&mut self, lead: bool) -> &mut PoolStats {
        if lead { &mut self.lead } else { &mut self.ordinary }
    }

    pub(super) fn churn_mut(&mut self, lead: bool) -> &mut PoolChurn {
        if lead { &mut self.lead_churn } else { &mut self.ordinary_churn }
    }

    fn churn(&self, lead: bool) -> PoolChurn {
        if lead { self.lead_churn } else { self.ordinary_churn }
    }
}

/// `message` followed by the lead or ordinary totals since launch.
fn line(locked: &Spares, lead: bool, message: &str) -> String {
    let s = if lead { locked.lead } else { locked.ordinary };
    let pool = if lead { "Lead" } else { "Ordinary" };
    format!("{message} {pool} spares since launch: {} started, {} adopted, {} not used, {} expired, {} evicted, {} replaced, {} discarded; {} cold launches without a spare.", s.started, s.adopted, s.missed, s.expired, s.evicted, s.replaced, s.discarded, s.cold_without_spare)
}

/// A launch-time miss against a pooled spare: counted as not used in its pool's totals and
/// logged with `reason`. `joins_streak`: the spare was dead or stale (`PoolChurn::missed`); an
/// expired spare, a launch that ended before adopting one or a failed key check join no streak,
/// and neither does a lead wake whose spare had already left the pool (`record_lead_miss`).
pub(super) fn decision_miss(pool: &Pool, lead: bool, reason: &str, joins_streak: bool) -> String {
    let mut locked = spares(pool);
    if joins_streak {
        locked.churn_mut(lead).missed(Instant::now(), SystemTime::now());
    }
    record_decision(&mut locked, lead, Some(reason))
}

/// A spare (or a lead's whole renewal chain) that expired unused with spares on and was not
/// renewed: one more toward its pool's expiry backoff (`PoolChurn::expired`).
pub(super) fn record_unused_expiry(pool: &Pool, lead: bool) {
    spares(pool).churn_mut(lead).expired(Instant::now(), SystemTime::now());
}

/// A launch that committed to its spare (`Adopting::into_parts`): counted as adopted, which also
/// ends the pool's eviction, expiry and miss streaks and any churn backoff.
pub(super) fn record_adopted(pool: &Pool, lead: bool) -> String {
    let mut locked = spares(pool);
    *locked.churn_mut(lead) = PoolChurn::default();
    record_decision(&mut locked, lead, None)
}

fn record_decision(locked: &mut Spares, lead: bool, miss: Option<&str>) -> String {
    let stats = locked.stats_mut(lead);
    if miss.is_none() { stats.adopted += 1 } else { stats.missed += 1 }
    let message = if lead { lead_note(miss) } else { ordinary_note(miss) };
    line(locked, lead, &message)
}

/// What a launch that found no spare logs and counts: a lead's pending `gone` reason as a miss;
/// otherwise, for a launch that could have had a spare, a cold launch in its pool (`lead`).
/// Managed workers never get spares, so they count and log nothing.
pub(super) fn no_spare_note(locked: &mut Spares, gone: Option<Gone>, eligible: bool, lead: bool) -> Option<String> {
    match gone {
        Some(why) => Some(record_lead_miss(locked, why)),
        None if eligible => Some(cold_without_spare_note(locked, lead)),
        None => None,
    }
}

/// A lead wake whose spare left the pool before it (`why`): counted and logged as a lead miss.
pub(super) fn record_lead_miss(locked: &mut Spares, why: Gone) -> String {
    record_decision(locked, true, Some(why.reason()))
}

/// A cold launch without a spare: counted in its pool's `cold_without_spare` and logged with that
/// pool's totals.
pub(super) fn cold_without_spare_note(locked: &mut Spares, lead: bool) -> String {
    locked.stats_mut(lead).cold_without_spare += 1;
    let message = if lead { "Team lead's warm Claude agent not pooled; starting cold." } else { "Warm Claude agent not pooled; starting cold." };
    line(locked, lead, message)
}

/// A spare that expired idle (already counted by its removal; this only reads the totals).
pub(super) fn expired_note(pool: &Pool, lead: bool) -> String {
    let message = if lead { "Team lead's warm Claude agent expired idle." } else { "Warm Claude agent expired idle." };
    line(&spares(pool), lead, message)
}

/// A lead spare that expired idle and was not renewed (`reason`); the expiry is already counted
/// by its removal, so this only reads the totals.
pub(super) fn not_renewed_note(pool: &Pool, reason: &str) -> String {
    line(&spares(pool), true, &format!("Team lead's warm Claude agent expired idle (not renewed: {reason})."))
}

/// Spares discarded by switching spares off (already counted; this only reads the totals).
pub(super) fn discarded_note(pool: &Pool, lead: bool) -> String {
    discarded_note_locked(&spares(pool), lead)
}

/// `discarded_note` for a caller already holding the pool lock (a refused registration).
pub(super) fn discarded_note_locked(locked: &Spares, lead: bool) -> String {
    let message = if lead { "Team lead's warm Claude agent discarded." } else { "Warm Claude agent discarded." };
    line(locked, lead, message)
}

/// An ordinary spare's adoption message: adopted (`None`) or why its launch starts cold.
fn ordinary_note(miss: Option<&str>) -> String {
    match miss {
        None => "Warm Claude agent adopted.".into(),
        Some(reason) => format!("Warm Claude agent not used ({reason}); starting cold."),
    }
}

/// A lead spare's adoption message: adopted (`None`) or why its wake starts cold.
fn lead_note(miss: Option<&str>) -> String {
    match miss {
        None => "Team lead's warm Claude agent adopted.".into(),
        Some(reason) => format!("Team lead's warm Claude agent not used ({reason}); starting cold."),
    }
}

/// One pool's totals as `warm_spare_stats` returns them.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WarmPoolStatsSnapshot {
    started: u64,
    adopted: u64,
    missed: u64,
    expired: u64,
    evicted: u64,
    replaced: u64,
    discarded: u64,
    cold_without_spare: u64,
    churn_skipped: u64,
    /// Spares pooled right now, idle and waiting for their follow-up.
    idle_now: u64,
    /// Whole seconds left of the pool's churn backoff (0 when it starts spares).
    paused_secs: u64,
}

impl WarmPoolStatsSnapshot {
    fn of(locked: &Spares, lead: bool, now: Instant, now_wall: SystemTime) -> Self {
        let s = if lead { locked.lead } else { locked.ordinary };
        let idle_now = locked.spares.values().filter(|spare| spare.lead == lead).count();
        Self {
            started: s.started,
            adopted: s.adopted,
            missed: s.missed,
            expired: s.expired,
            evicted: s.evicted,
            replaced: s.replaced,
            discarded: s.discarded,
            cold_without_spare: s.cold_without_spare,
            churn_skipped: s.churn_skipped,
            idle_now: u64::try_from(idle_now).unwrap_or(u64::MAX),
            paused_secs: locked.churn(lead).paused_secs(now, now_wall),
        }
    }
}

/// Both pools' totals since launch and their live state (in memory only: nothing is stored or
/// sent anywhere).
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WarmStatsSnapshot {
    ordinary: WarmPoolStatsSnapshot,
    lead: WarmPoolStatsSnapshot,
}

impl WarmStatsSnapshot {
    pub(super) fn of(locked: &Spares) -> Self {
        let (now, now_wall) = (Instant::now(), SystemTime::now());
        Self { ordinary: WarmPoolStatsSnapshot::of(locked, false, now, now_wall), lead: WarmPoolStatsSnapshot::of(locked, true, now, now_wall) }
    }
}
