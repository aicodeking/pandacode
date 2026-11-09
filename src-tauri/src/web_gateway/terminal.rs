use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

pub(super) const MAX_OWNED_TERMINALS_PER_SESSION: usize = 16;
const MAX_JOURNALED_TERMINALS: usize = 64;
const MAX_TERMINAL_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;

#[derive(Default)]
pub struct TerminalOwners {
    owners: HashMap<String, String>,
    closing: HashSet<String>,
}
impl TerminalOwners {
    pub fn claim(&mut self, terminal: &str, session: &str) -> Result<(), &'static str> {
        if terminal.is_empty() || terminal.len() > 128 {
            return Err("invalid terminal id");
        }
        if self
            .owners
            .values()
            .filter(|owner| owner.as_str() == session)
            .count()
            >= MAX_OWNED_TERMINALS_PER_SESSION
            && !self.owners.contains_key(terminal)
        {
            return Err("terminal limit reached");
        }
        match self.owners.get(terminal) {
            Some(owner) if owner != session => Err("terminal owned by another session"),
            Some(_) if self.closing.contains(terminal) => Err("terminal is closing"),
            _ => {
                self.owners.insert(terminal.into(), session.into());
                Ok(())
            }
        }
    }
    pub fn check(&self, terminal: &str, session: &str) -> Result<(), &'static str> {
        match self.owners.get(terminal) {
            Some(owner) if owner == session && !self.closing.contains(terminal) => Ok(()),
            Some(owner) if owner == session => Err("terminal is closing"),
            _ => Err("terminal is not owned by this session"),
        }
    }
    pub fn release(&mut self, terminal: &str, session: &str) -> Result<(), &'static str> {
        if self.owners.get(terminal).map(String::as_str) != Some(session) {
            return Err("terminal is not owned by this session");
        }
        self.owners.remove(terminal);
        self.closing.remove(terminal);
        Ok(())
    }
    /// Marks every terminal from a revoked session as closing while preserving its owner record.
    /// The caller removes each record only after the native terminal has actually been closed.
    pub fn begin_close_session(&mut self, session: &str) -> Vec<String> {
        let terminals = self
            .owners
            .iter()
            .filter_map(|(terminal, owner)| {
                (owner == session && !self.closing.contains(terminal)).then_some(terminal.clone())
            })
            .collect::<Vec<_>>();
        for terminal in &terminals {
            self.closing.insert(terminal.clone());
        }
        terminals
    }

    /// Records a terminal that must be destroyed even when the session's normal ownership limit
    /// is already full. Callers hold a separate bounded native-create permit, so cleanup records
    /// cannot grow without bound.
    pub fn adopt_closing(&mut self, terminal: &str, session: &str) -> Result<(), &'static str> {
        if self
            .owners
            .get(terminal)
            .is_some_and(|owner| owner != session)
        {
            return Err("terminal owned by another session");
        }
        self.owners.insert(terminal.to_owned(), session.to_owned());
        self.closing.insert(terminal.to_owned());
        Ok(())
    }

    pub fn finish_close(&mut self, terminal: &str, session: &str) -> Result<(), &'static str> {
        if !self.closing.contains(terminal) {
            return Err("terminal is not closing");
        }
        self.release(terminal, session)
    }
}

#[derive(Clone)]
struct Chunk {
    sequence: u64,
    data: String,
}

struct JournalEntry {
    chunks: VecDeque<Chunk>,
    bytes: usize,
    base_sequence: u64,
    next_sequence: u64,
    exit: bool,
    truncated: bool,
    updated: u64,
}

impl JournalEntry {
    fn new(updated: u64, truncated: bool) -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            base_sequence: 0,
            next_sequence: 0,
            exit: false,
            truncated,
            updated,
        }
    }

    fn append(&mut self, data: String, exit: bool, updated: u64) -> u64 {
        self.next_sequence = self.next_sequence.saturating_add(1);
        let sequence = self.next_sequence;
        self.exit = exit;
        self.updated = updated;
        if self.base_sequence == 0 {
            self.base_sequence = sequence;
        }
        if !data.is_empty() {
            self.bytes = self.bytes.saturating_add(data.len());
            self.chunks.push_back(Chunk { sequence, data });
        }
        self.trim_to(MAX_TERMINAL_BYTES);
        sequence
    }

    fn trim_to(&mut self, limit: usize) {
        while self.bytes > limit {
            let Some(chunk) = self.chunks.pop_front() else {
                self.bytes = 0;
                break;
            };
            self.bytes = self.bytes.saturating_sub(chunk.data.len());
            self.truncated = true;
        }
        if self.truncated {
            self.base_sequence = self
                .chunks
                .front()
                .map_or(self.next_sequence, |chunk| chunk.sequence);
        } else if self.next_sequence == 0 {
            self.base_sequence = 0;
        }
    }

    fn drop_oldest_chunk(&mut self) -> usize {
        let Some(chunk) = self.chunks.pop_front() else {
            return 0;
        };
        let removed = chunk.data.len();
        self.bytes = self.bytes.saturating_sub(removed);
        self.truncated = true;
        self.base_sequence = self
            .chunks
            .front()
            .map_or(self.next_sequence, |next| next.sequence);
        removed
    }

    fn snapshot(&self, terminal_id: &str) -> Snapshot {
        Snapshot {
            terminal_id: terminal_id.to_owned(),
            base_sequence: self.base_sequence,
            next_sequence: self.next_sequence,
            data: self
                .chunks
                .iter()
                .map(|chunk| chunk.data.as_str())
                .collect(),
            exit: self.exit,
            truncated: self.truncated,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub terminal_id: String,
    pub base_sequence: u64,
    pub next_sequence: u64,
    pub data: String,
    pub exit: bool,
    pub truncated: bool,
}

impl Snapshot {
    fn missing(terminal_id: &str) -> Self {
        Self {
            terminal_id: terminal_id.to_owned(),
            base_sequence: 0,
            next_sequence: 0,
            data: String::new(),
            exit: false,
            truncated: true,
        }
    }
}

/// A bounded, per-terminal output journal. `next_sequence` is the highest event included in a
/// snapshot, so a recovering client can discard live events at or below that barrier.
pub struct TerminalJournal {
    entries: HashMap<String, JournalEntry>,
    rejected: HashSet<String>,
    rejected_order: VecDeque<String>,
    total_bytes: usize,
    clock: u64,
    max_terminals: usize,
    max_terminal_bytes: usize,
    max_total_bytes: usize,
    max_rejected: usize,
}

impl Default for TerminalJournal {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            rejected: HashSet::new(),
            rejected_order: VecDeque::new(),
            total_bytes: 0,
            clock: 0,
            max_terminals: MAX_JOURNALED_TERMINALS,
            max_terminal_bytes: MAX_TERMINAL_BYTES,
            max_total_bytes: MAX_TOTAL_BYTES,
            max_rejected: MAX_JOURNALED_TERMINALS * 2,
        }
    }
}

impl TerminalJournal {
    #[cfg(test)]
    fn with_limits(
        max_terminals: usize,
        max_terminal_bytes: usize,
        max_total_bytes: usize,
    ) -> Self {
        Self {
            max_terminals,
            max_terminal_bytes,
            max_total_bytes,
            max_rejected: max_terminals.saturating_mul(2).max(1),
            ..Self::default()
        }
    }

    /// Records a trusted native `terminal-event`, returning the terminal-local sequence that must
    /// be attached to the WebSocket payload. Invalid event shapes are forwarded without a journal
    /// sequence and therefore recover fail-visible through a truncated snapshot.
    pub fn append_event(&mut self, payload: &Value) -> Option<u64> {
        let terminal_id = payload.get("terminalId")?.as_str()?;
        if terminal_id.is_empty() || terminal_id.len() > 128 {
            return None;
        }
        let data = payload.get("data")?.as_str()?.to_owned();
        let exit = payload.get("exit")?.as_bool()?;
        self.clock = self.clock.saturating_add(1);

        if !self.entries.contains_key(terminal_id) {
            if self.rejected.contains(terminal_id) || self.entries.len() >= self.max_terminals {
                self.reject(terminal_id);
                return None;
            }
            self.entries
                .insert(terminal_id.to_owned(), JournalEntry::new(self.clock, false));
        }

        let entry = self.entries.get_mut(terminal_id)?;
        let before = entry.bytes;
        let sequence = entry.append(data, exit, self.clock);
        if entry.bytes > self.max_terminal_bytes {
            entry.trim_to(self.max_terminal_bytes);
        }
        self.total_bytes = self
            .total_bytes
            .saturating_sub(before)
            .saturating_add(entry.bytes);
        self.trim_global();
        Some(sequence)
    }

    /// Installs an empty, recoverable journal before a newly-created PTY is returned to a client.
    /// A missing entry is fail-visible as truncated, so creation must reserve its bounded slot.
    pub fn reserve(&mut self, terminal_id: &str) -> Result<(), &'static str> {
        if terminal_id.is_empty() || terminal_id.len() > 128 {
            return Err("invalid or duplicate terminal journal");
        }
        if self.entries.contains_key(terminal_id) {
            return Ok(());
        }
        if self.rejected.contains(terminal_id) || self.entries.len() >= self.max_terminals {
            self.reject(terminal_id);
            return Err("terminal journal limit reached");
        }
        self.clock = self.clock.saturating_add(1);
        self.entries
            .insert(terminal_id.to_owned(), JournalEntry::new(self.clock, false));
        Ok(())
    }

    pub fn snapshot(&self, terminal_id: &str) -> Snapshot {
        self.entries.get(terminal_id).map_or_else(
            || Snapshot::missing(terminal_id),
            |entry| entry.snapshot(terminal_id),
        )
    }

    #[cfg(test)]
    pub fn contains(&self, terminal_id: &str) -> bool {
        self.entries.contains_key(terminal_id)
    }

    pub fn remove(&mut self, terminal_id: &str) {
        if let Some(entry) = self.entries.remove(terminal_id) {
            self.total_bytes = self.total_bytes.saturating_sub(entry.bytes);
        }
        // Native close can race the PTY reader's final exit event. Keep a bounded tombstone so a
        // late event cannot recreate output after ownership and journal cleanup.
        self.reject(terminal_id);
    }

    fn reject(&mut self, terminal_id: &str) {
        if self.rejected.insert(terminal_id.to_owned()) {
            self.rejected_order.push_back(terminal_id.to_owned());
        }
        while self.rejected_order.len() > self.max_rejected {
            if let Some(oldest) = self.rejected_order.pop_front() {
                self.rejected.remove(&oldest);
            }
        }
    }

    fn trim_global(&mut self) {
        while self.total_bytes > self.max_total_bytes {
            let oldest = self
                .entries
                .iter()
                .filter(|(_, entry)| entry.bytes > 0)
                .min_by_key(|(_, entry)| entry.updated)
                .map(|(terminal_id, _)| terminal_id.clone());
            let Some(oldest) = oldest else {
                self.total_bytes = 0;
                break;
            };
            let removed = self
                .entries
                .get_mut(&oldest)
                .map_or(0, JournalEntry::drop_oldest_chunk);
            self.total_bytes = self.total_bytes.saturating_sub(removed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn journal_sequences_and_reconstructs_exact_output() {
        let mut journal = TerminalJournal::default();
        assert_eq!(
            journal.append_event(&json!({"terminalId":"t","data":"one","exit":false})),
            Some(1)
        );
        assert_eq!(
            journal.append_event(&json!({"terminalId":"t","data":"two","exit":true})),
            Some(2)
        );
        let snapshot = journal.snapshot("t");
        assert_eq!(snapshot.base_sequence, 1);
        assert_eq!(snapshot.next_sequence, 2);
        assert_eq!(snapshot.data, "onetwo");
        assert!(snapshot.exit);
        assert!(!snapshot.truncated);
    }

    #[test]
    fn reserve_makes_initial_snapshot_recoverable_and_empty_events_keep_barrier() {
        let mut journal = TerminalJournal::default();
        journal.reserve("t").unwrap();
        let initial = journal.snapshot("t");
        assert_eq!(initial.base_sequence, 0);
        assert_eq!(initial.next_sequence, 0);
        assert!(!initial.truncated);
        assert_eq!(
            journal.append_event(&json!({"terminalId":"t","data":"","exit":false})),
            Some(1)
        );
        journal.append_event(&json!({"terminalId":"t","data":"","exit":false}));
        journal.append_event(&json!({"terminalId":"t","data":"boot","exit":false}));
        let empty = journal.snapshot("t");
        assert_eq!(empty.base_sequence, 1);
        assert_eq!(empty.next_sequence, 3);
        assert!(!empty.truncated);
        let mut early = TerminalJournal::default();
        early.append_event(&json!({"terminalId":"early","data":"boot","exit":false}));
        early.reserve("early").unwrap();
        assert_eq!(early.snapshot("early").data, "boot");
    }

    #[test]
    fn per_terminal_and_global_caps_fail_visible() {
        let mut journal = TerminalJournal::with_limits(3, 6, 8);
        journal.append_event(&json!({"terminalId":"a","data":"1234","exit":false}));
        journal.append_event(&json!({"terminalId":"a","data":"5678","exit":false}));
        let a = journal.snapshot("a");
        assert!(a.truncated);
        assert_eq!(a.data, "5678");
        assert_eq!(a.base_sequence, 2);

        journal.append_event(&json!({"terminalId":"b","data":"abcd","exit":false}));
        journal.append_event(&json!({"terminalId":"c","data":"wxyz","exit":false}));
        assert!(journal.snapshot("a").truncated);
        assert!(journal.total_bytes <= 8);
    }

    #[test]
    fn entry_cap_and_close_tombstones_never_hide_prior_loss() {
        let mut journal = TerminalJournal::with_limits(1, 32, 32);
        assert!(journal
            .append_event(&json!({"terminalId":"a","data":"a","exit":false}))
            .is_some());
        assert!(journal
            .append_event(&json!({"terminalId":"b","data":"b","exit":false}))
            .is_none());
        assert!(journal.snapshot("b").truncated);
        journal.remove("a");
        assert!(journal
            .append_event(&json!({"terminalId":"b","data":"later","exit":false}))
            .is_none());
        journal.remove("b");
        assert!(journal
            .append_event(&json!({"terminalId":"b","data":"fresh","exit":false}))
            .is_none());
        assert!(journal.snapshot("b").truncated);
    }

    #[test]
    fn revoked_session_keeps_a_closing_owner_until_native_close_succeeds() {
        let mut owners = TerminalOwners::default();
        owners.claim("terminal-a", "session-a").unwrap();
        assert_eq!(
            owners.begin_close_session("session-a"),
            vec!["terminal-a".to_owned()]
        );
        assert!(owners.check("terminal-a", "session-a").is_err());
        assert!(owners.claim("terminal-a", "session-b").is_err());

        // A failed native close leaves the durable closing record in place. Only an explicit
        // success acknowledgement allows ownership to be forgotten.
        assert!(owners.finish_close("terminal-a", "session-b").is_err());
        owners.finish_close("terminal-a", "session-a").unwrap();
        owners.claim("terminal-a", "session-b").unwrap();
    }

    #[test]
    fn cleanup_adoption_bypasses_normal_limit_but_never_steals_an_id() {
        let mut owners = TerminalOwners::default();
        for index in 0..MAX_OWNED_TERMINALS_PER_SESSION {
            owners
                .claim(&format!("terminal-{index}"), "session-a")
                .unwrap();
        }
        assert!(owners.claim("late-terminal", "session-a").is_err());
        owners.adopt_closing("late-terminal", "session-a").unwrap();
        assert!(owners.check("late-terminal", "session-a").is_err());
        assert!(owners.adopt_closing("late-terminal", "session-b").is_err());
    }
}
