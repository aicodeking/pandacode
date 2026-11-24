//! Each pool's lifecycle totals since launch (in memory only) and the stderr lines that report
//! them. The formats are documented character for character in docs/worker-tokens.md.
use super::{spares, Gone, Pool, Spares};

/// One pool's spares since launch: registered, adopted or found unusable at launch, and every
/// other way one left the pool unadopted.
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PoolStats {
    pub(super) started: u64,
    pub(super) adopted: u64,
    pub(super) missed: u64,
    pub(super) expired: u64,
    pub(super) evicted: u64,
    pub(super) replaced: u64,
    pub(super) discarded: u64,
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

impl Spares {
    pub(super) fn stats_mut(&mut self, lead: bool) -> &mut PoolStats {
        if lead { &mut self.lead } else { &mut self.ordinary }
    }
}

/// `message` followed by the lead or ordinary totals since launch.
fn line(locked: &Spares, lead: bool, message: &str) -> String {
    let s = if lead { locked.lead } else { locked.ordinary };
    if lead {
        format!("{message} Lead spares since launch: {} started, {} adopted, {} not used, {} expired, {} evicted, {} replaced, {} discarded.", s.started, s.adopted, s.missed, s.expired, s.evicted, s.replaced, s.discarded)
    } else {
        format!("{message} Ordinary spares since launch: {} started, {} adopted, {} not used, {} expired, {} evicted, {} replaced, {} discarded; {} cold launches without a spare.", s.started, s.adopted, s.missed, s.expired, s.evicted, s.replaced, s.discarded, locked.cold_without_spare)
    }
}

/// A launch's adoption log line, counted as adopted (`None`) or not used in its pool's totals.
pub(super) fn decision(pool: &Pool, lead: bool, miss: Option<&str>) -> String {
    record_decision(&mut spares(pool), lead, miss)
}

fn record_decision(locked: &mut Spares, lead: bool, miss: Option<&str>) -> String {
    let stats = locked.stats_mut(lead);
    if miss.is_none() { stats.adopted += 1 } else { stats.missed += 1 }
    let message = if lead { lead_note(miss) } else { ordinary_note(miss) };
    line(locked, lead, &message)
}

/// What a launch that found no spare logs and counts: a lead's pending `gone` reason as a miss;
/// otherwise, for a launch that could have had an ordinary spare, a cold launch. Managed
/// workers never get spares, so they count and log nothing.
pub(super) fn no_spare_note(locked: &mut Spares, gone: Option<Gone>, ordinary_eligible: bool) -> Option<String> {
    match gone {
        Some(why) => Some(record_decision(locked, true, Some(why.reason()))),
        None if ordinary_eligible => {
            locked.cold_without_spare += 1;
            Some(line(locked, false, "Warm Claude agent not pooled; starting cold."))
        }
        None => None,
    }
}

/// A spare that expired idle (already counted by its removal; this only reads the totals).
pub(super) fn expired_note(pool: &Pool, lead: bool) -> String {
    let message = if lead { "Team lead's warm Claude agent expired idle." } else { "Warm Claude agent expired idle." };
    line(&spares(pool), lead, message)
}

/// Spares discarded by switching spares off (already counted; this only reads the totals).
pub(super) fn discarded_note(pool: &Pool, lead: bool) -> String {
    let message = if lead { "Team lead's warm Claude agent discarded." } else { "Warm Claude agent discarded." };
    line(&spares(pool), lead, message)
}

/// An ordinary spare's adoption message: adopted (`None`) or why its launch starts cold.
fn ordinary_note(miss: Option<&str>) -> String {
    match miss {
        None => "Warm Claude agent adopted.".into(),
        Some(reason) => format!("Warm Claude agent not used ({reason}); starting cold."),
    }
}

/// A lead spare's adoption message: adopted (`None`) or why its wake starts cold.
pub(super) fn lead_note(miss: Option<&str>) -> String {
    match miss {
        None => "Team lead's warm Claude agent adopted.".into(),
        Some(reason) => format!("Team lead's warm Claude agent not used ({reason}); starting cold."),
    }
}
