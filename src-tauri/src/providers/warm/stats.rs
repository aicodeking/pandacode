//! Each pool's lifecycle totals since launch (in memory only), the stderr lines that report
//! them, and the round-robin churn backoff. The formats are documented character for character
//! in docs/worker-tokens.md.
use super::{spares, Pool, Spares};
use serde::Serialize;
use std::time::{Duration, Instant};

/// Why a lead spare left the pool before its wake.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Gone {
    /// A newer lead spare pushed it out of the bounded lead pool.
    Evicted,
    /// Its team stopped or paused, or its task was deleted.
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

/// A pool's evictions since its last adoption, and the backoff they set (`CHURN_COOLDOWN`).
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PoolChurn {
    pub(super) consecutive_evictions: u32,
    pub(super) churn_cooldown_until: Option<Instant>,
}

impl PoolChurn {
    /// One more spare evicted unadopted; at `limit` in a row the pool backs off.
    pub(super) fn evicted(&mut self, limit: usize, now: Instant) {
        self.consecutive_evictions = self.consecutive_evictions.saturating_add(1);
        if self.consecutive_evictions >= u32::try_from(limit).unwrap_or(u32::MAX) {
            self.churn_cooldown_until = now.checked_add(CHURN_COOLDOWN);
        }
    }

    /// Whether a start is skipped at `now`. A lapsed backoff clears, so the pool probes again.
    pub(super) fn cooling(&mut self, now: Instant) -> bool {
        match self.churn_cooldown_until {
            Some(until) if now < until => true,
            Some(_) => {
                *self = Self::default();
                false
            }
            None => false,
        }
    }
}

impl Spares {
    pub(super) fn stats_mut(&mut self, lead: bool) -> &mut PoolStats {
        if lead { &mut self.lead } else { &mut self.ordinary }
    }

    pub(super) fn churn_mut(&mut self, lead: bool) -> &mut PoolChurn {
        if lead { &mut self.lead_churn } else { &mut self.ordinary_churn }
    }
}

/// `message` followed by the lead or ordinary totals since launch.
fn line(locked: &Spares, lead: bool, message: &str) -> String {
    let s = if lead { locked.lead } else { locked.ordinary };
    let pool = if lead { "Lead" } else { "Ordinary" };
    format!("{message} {pool} spares since launch: {} started, {} adopted, {} not used, {} expired, {} evicted, {} replaced, {} discarded; {} cold launches without a spare.", s.started, s.adopted, s.missed, s.expired, s.evicted, s.replaced, s.discarded, s.cold_without_spare)
}

/// A launch's adoption log line, counted as adopted (`None`) or not used in its pool's totals.
pub(super) fn decision(pool: &Pool, lead: bool, miss: Option<&str>) -> String {
    record_decision(&mut spares(pool), lead, miss)
}

/// A launch that committed to its spare (`Adopting::into_parts`): counted as adopted, which also
/// ends the pool's eviction streak and any churn backoff.
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
}

impl WarmPoolStatsSnapshot {
    fn of(s: PoolStats) -> Self {
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
        }
    }
}

/// Both pools' totals since launch (in memory only: nothing is stored or sent anywhere).
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WarmStatsSnapshot {
    ordinary: WarmPoolStatsSnapshot,
    lead: WarmPoolStatsSnapshot,
}

impl WarmStatsSnapshot {
    pub(super) fn of(locked: &Spares) -> Self {
        Self { ordinary: WarmPoolStatsSnapshot::of(locked.ordinary), lead: WarmPoolStatsSnapshot::of(locked.lead) }
    }
}
