//! What keeps one call bounded: a deadline shared by the walk, the search and the symbol
//! extractors, the task's stop flag, the bytes it may hold of whole files, and a process-wide
//! limit on concurrent calls.
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};

// Tests get an hour so a loaded machine cannot cut a call short; tests of the deadline itself
// use `Limit::lasting`.
const DEADLINE: Duration = Duration::from_secs(if cfg!(test) { 3600 } else { 20 });
// Parallel tests must not turn one another away.
const MAX_CALLS: usize = if cfg!(test) { usize::MAX } else { 4 };
const WAIT_SLICE: Duration = Duration::from_millis(100);
/// File text one call may hold at once (outlines, `path#name` reads, read lines kept), so 4
/// calls of 20 requests each cannot fill memory with 16 MiB files.
pub(super) const MAX_CALL_BYTES: usize = 64 * 1024 * 1024;
/// Temporary line/lexer metadata shared by all parsers in one call.
pub(super) const MAX_PARSE_BYTES: usize = 16 * 1024 * 1024;

pub(super) struct Limit {
    deadline: Instant,
    stopped: Arc<AtomicBool>,
    cut: AtomicBool,
    bytes_left: AtomicUsize,
    parse_bytes_left: AtomicUsize,
}

impl Limit {
    pub(super) fn new(stopped: Arc<AtomicBool>) -> Self {
        Self::lasting(DEADLINE, stopped)
    }

    pub(super) fn lasting(time: Duration, stopped: Arc<AtomicBool>) -> Self {
        Self { deadline: Instant::now() + time, stopped, cut: AtomicBool::new(false), bytes_left: AtomicUsize::new(MAX_CALL_BYTES), parse_bytes_left: AtomicUsize::new(MAX_PARSE_BYTES) }
    }

    /// A limit holding at most `bytes` of file text, so a test need not fill 64 MiB.
    #[cfg(test)]
    pub(super) fn with_bytes(bytes: usize) -> Self {
        Self { bytes_left: AtomicUsize::new(bytes), ..Self::new(Arc::default()) }
    }

    #[cfg(test)]
    pub(super) fn with_parse_bytes(bytes: usize) -> Self {
        Self { parse_bytes_left: AtomicUsize::new(bytes), ..Self::new(Arc::default()) }
    }

    /// Reserves scratch space until its buffers have been dropped, including on early return.
    pub(super) fn reserve_parse_bytes(&self, bytes: usize) -> Option<ParseBytesGuard<'_>> {
        if take_from(&self.parse_bytes_left, bytes) {
            Some(ParseBytesGuard { limit: self, bytes })
        } else {
            None
        }
    }

    /// Takes `bytes` of the call's allowance; false, taking nothing, when too few are left.
    pub(super) fn take_bytes(&self, bytes: usize) -> bool {
        take_from(&self.bytes_left, bytes)
    }

    /// True once the call must stop; remembers it, so the reply can say it was cut short.
    pub(super) fn expired(&self) -> bool {
        let over = self.stopped.load(Ordering::Relaxed) || Instant::now() >= self.deadline;
        if over {
            self.cut.store(true, Ordering::Relaxed);
        }
        over
    }

    /// The call missed something for another reason, such as the walk's entry cap.
    pub(super) fn cut(&self) {
        self.cut.store(true, Ordering::Relaxed);
    }

    pub(super) fn was_cut(&self) -> bool {
        self.cut.load(Ordering::Relaxed)
    }

    pub(super) fn stopped(&self) -> bool {
        self.stopped.load(Ordering::Relaxed)
    }
}

fn take_from(counter: &AtomicUsize, bytes: usize) -> bool {
    let mut left = counter.load(Ordering::Relaxed);
    while let Some(remaining) = left.checked_sub(bytes) {
        match counter.compare_exchange_weak(left, remaining, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return true,
            Err(current) => left = current,
        }
    }
    false
}

pub(super) struct ParseBytesGuard<'a> {
    limit: &'a Limit,
    bytes: usize,
}

impl Drop for ParseBytesGuard<'_> {
    fn drop(&mut self) {
        self.limit.parse_bytes_left.fetch_add(self.bytes, Ordering::Relaxed);
    }
}

/// Why a call got no slot.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Refusal {
    Stopped,
    Busy,
}

impl Refusal {
    pub(super) fn message(&self) -> &'static str {
        match self {
            Self::Stopped => "Task has stopped.",
            Self::Busy => "Too many explore calls are running. Try again.",
        }
    }
}

pub(super) struct Gate {
    running: Mutex<usize>,
    freed: Condvar,
    most: usize,
}

pub(super) static CALLS: Gate = Gate::new(MAX_CALLS);

impl Gate {
    pub(super) const fn new(most: usize) -> Self {
        Self { running: Mutex::new(0), freed: Condvar::new(), most }
    }

    /// Waits for a free slot until the call's limit runs out.
    pub(super) fn enter(&self, limit: &Limit) -> Result<Permit<'_>, Refusal> {
        let mut running = self.running.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while *running >= self.most {
            if limit.stopped() {
                return Err(Refusal::Stopped);
            }
            if limit.expired() {
                return Err(Refusal::Busy);
            }
            running = self.freed.wait_timeout(running, WAIT_SLICE).map_or_else(|poisoned| poisoned.into_inner().0, |(guard, _)| guard);
        }
        *running += 1;
        Ok(Permit(self))
    }
}

pub(super) struct Permit<'a>(&'a Gate);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        *self.0.running.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) -= 1;
        self.0.freed.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reservations_share_a_pool_and_restore_it_on_drop() {
        let limit = Limit::with_parse_bytes(100);
        let first = limit.reserve_parse_bytes(60).unwrap();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                assert!(limit.reserve_parse_bytes(41).is_none());
                assert!(limit.reserve_parse_bytes(40).is_some());
                assert!(limit.reserve_parse_bytes(usize::MAX).is_none());
            }).join().unwrap();
        });
        drop(first);
        assert!(limit.reserve_parse_bytes(100).is_some());
    }

    #[test]
    fn a_full_gate_turns_late_calls_away_and_frees_slots() {
        let gate = Gate::new(2);
        let long = Limit::new(Arc::default());
        let (first, _second) = (gate.enter(&long).unwrap(), gate.enter(&long).unwrap());
        let short = Limit::lasting(Duration::from_millis(50), Arc::default());
        assert!(gate.enter(&short).is_err());
        assert!(short.was_cut());
        drop(first);
        assert!(gate.enter(&long).is_ok());
        assert!(!long.was_cut());
    }

    #[test]
    fn stop_and_deadline_both_expire() {
        let stopped: Arc<AtomicBool> = Arc::default();
        let limit = Limit::new(stopped.clone());
        assert!(!limit.expired());
        stopped.store(true, Ordering::Relaxed);
        assert!(limit.expired() && limit.was_cut());
        assert!(Limit::lasting(Duration::ZERO, Arc::default()).expired());
    }

    #[test]
    fn the_byte_allowance_runs_out() {
        let limit = Limit::new(Arc::default());
        assert!(limit.take_bytes(0));
        assert!(!limit.take_bytes(usize::MAX));
        assert!(limit.take_bytes(MAX_CALL_BYTES - 1));
        assert!(!limit.take_bytes(2));
        assert!(limit.take_bytes(1));
        assert!(!limit.take_bytes(1));
        assert!(limit.take_bytes(0));
    }

    #[test]
    fn concurrent_reads_share_one_byte_allowance() {
        let limit = Limit::with_bytes(1000);
        std::thread::scope(|scope| {
            let readers: Vec<_> = (0..8).map(|_| scope.spawn(|| {
                let mut taken = 0;
                while limit.take_bytes(1) {
                    taken += 1;
                }
                taken
            })).collect();
            assert_eq!(readers.into_iter().map(|reader| reader.join().unwrap()).sum::<usize>(), 1000);
        });
        assert!(!limit.take_bytes(1));
    }
}
