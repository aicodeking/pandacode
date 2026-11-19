//! Team rules go to each conversation once, then again only when they change, when the
//! harness starts a new conversation or compacts it, or as a periodic reminder. Other turns
//! get a one-line reminder, a delta line when only the roster changed, and only the messages
//! and notes they have not seen.
use super::*;
use std::hash::{Hash, Hasher};

/// The rules and a compact identity block (not the mailbox or notes again) on every eighth
/// turn, so a harness that compacts without saying so never loses them for long. Reported
/// compactions get a full brief at once (`prompt` checks them before `needs_full`).
const FULL_EVERY: u32 = 8;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Briefing {
    /// A hash of the rules text this conversation last received in full.
    pub rules: u64,
    /// The newest addressed mailbox message already put in this conversation's prompt.
    pub message_id: i64,
    /// Turns since the rules were last sent in full.
    pub since_full: u32,
}

const CORE_BITS: u64 = 0xFFFF_FFFF_0000_0000;

fn hash(text: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// A conversation's team rules as `rules()` builds them.
#[derive(Clone, Debug, Default)]
pub(super) struct Rules {
    pub text: String,
    /// The one line that stands in for the rules once the conversation has them.
    pub reminder: String,
    /// The lead's roster in `text` (usable profiles and the routing note that counts them);
    /// None for workers. Set where the text is built, so rewording never loses it.
    pub roster: Option<std::ops::Range<usize>>,
}

impl Rules {
    /// The roster's text, or "" for a worker.
    pub fn roster_text(&self) -> &str {
        self.roster.clone().map_or("", |range| &self.text[range])
    }

    /// The rules' fingerprint: the high half hashes everything but the roster, the low half
    /// the roster, so `needs_full` and the coordination block can tell a roster-only change apart.
    pub fn fingerprint(&self) -> u64 {
        let core = match self.roster.clone() {
            Some(range) => format!("{}{}", &self.text[..range.start], &self.text[range.end..]),
            None => self.text.clone(),
        };
        (hash(&core) & CORE_BITS) | (hash(self.roster_text()) >> 32)
    }
}

/// Whether only the roster half differs between two fingerprints.
pub(super) fn roster_only_change(previous: u64, current: u64) -> bool {
    previous != current && previous & CORE_BITS == current & CORE_BITS
}

/// Whether this turn needs the full rules. `resumed` is false when the harness starts a
/// new conversation, which has never seen them. A roster-only change (a model paused or
/// recovered) is a one-line delta from the coordination block instead. On the periodic
/// reminder the coordination block adds only an identity block (`coordination::Brief`).
pub(super) fn needs_full(previous: Option<&Briefing>, rules: u64, resumed: bool) -> bool {
    match previous {
        Some(previous) if resumed => {
            (previous.rules != rules && !roster_only_change(previous.rules, rules)) || previous.since_full + 1 >= FULL_EVERY
        }
        _ => true,
    }
}

pub(super) fn next(previous: Option<&Briefing>, rules: u64, message_id: i64, full: bool) -> Briefing {
    Briefing {
        rules,
        message_id,
        since_full: if full { 0 } else { previous.map_or(0, |b| b.since_full) + 1 },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(text: &str) -> Rules {
        Rules { text: text.into(), ..Rules::default() }
    }

    #[test]
    fn rules_go_out_again_only_when_needed() {
        let rules = plain("rules").fingerprint();
        assert!(needs_full(None, rules, true));
        let first = next(None, rules, 0, true);
        assert!(needs_full(Some(&first), rules, false), "a new harness conversation");
        assert!(needs_full(Some(&first), plain("changed").fingerprint(), true), "changed rules");
        let mut briefing = first;
        for _ in 1..FULL_EVERY {
            assert!(!needs_full(Some(&briefing), rules, true));
            briefing = next(Some(&briefing), rules, 0, false);
        }
        assert!(needs_full(Some(&briefing), rules, true), "periodic reminder");
    }

    fn lead(roster: &str, limit: u32) -> Rules {
        let head = "Lead rules. Team: ";
        let text = format!("{head}{roster} Maximum parallel workers: {limit}.");
        Rules { text, reminder: String::new(), roster: Some(head.len()..head.len() + roster.len()) }
    }

    #[test]
    fn a_roster_only_change_is_not_a_full_resend() {
        let both = r#"[{"id":"a","model":"x"},{"id":"b","model":"y"}]. Router first: 2 rated models."#;
        let before = lead(both, 4).fingerprint();
        let paused = lead(r#"[{"id":"a","model":"x"}]. Router first: 1 rated models."#, 4).fingerprint();
        assert!(roster_only_change(before, paused));
        let first = next(None, before, 0, true);
        assert!(!needs_full(Some(&first), paused, true), "a paused model is a delta line");
        assert!(needs_full(Some(&first), paused, false), "a fresh conversation still gets everything");
        let limits = lead(both, 6).fingerprint();
        assert!(!roster_only_change(before, limits));
        assert!(needs_full(Some(&first), limits, true), "changed limits are new rules");
        assert_eq!(plain("Worker rules without a roster.").roster_text(), "");
        assert_eq!(lead(both, 4).roster_text(), both);
    }
}
