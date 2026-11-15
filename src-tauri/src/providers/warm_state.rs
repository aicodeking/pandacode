//! The shared state of warm agents for every harness: debounced first-start tickets, waiting
//! sends (`hurry`), the wake-up every waiter listens on (`changed`), the generation counter,
//! when each task was last wanted (`touch`), and which Claude agents are being spawned.
use super::*;

/// Debounced first starts (no inputs recorded yet), any harness.
static RESERVED: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(Default::default);
/// Tasks with a send waiting: their debounce ends at once.
static HURRIED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);
/// When the user last showed intent to write in each task (typed in it, picked a setting, or
/// a turn ended): the shared limit keeps the most recently wanted spares.
static INTENT: LazyLock<Mutex<HashMap<String, std::time::Instant>>> = LazyLock::new(Default::default);
/// Tasks whose Claude agent is being spawned right now.
static SPAWNING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);
/// Woken on every change a waiting send or debounce may care about.
static CHANGED: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);

static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(in crate::providers) fn reservations() -> std::sync::MutexGuard<'static, HashMap<String, u64>> {
    RESERVED.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(in crate::providers) fn hurried() -> std::sync::MutexGuard<'static, HashSet<String>> {
    HURRIED.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The user showed intent to write in this task now (a first keystroke, a pick, a turn end).
pub fn touch(session_id: &str) {
    INTENT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(session_id.to_owned(), std::time::Instant::now());
}

/// How recently a task's spare was wanted: its last intent, or its birth if later.
pub(in crate::providers) fn recency(session_id: &str, born: std::time::Instant) -> std::time::Instant {
    INTENT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(session_id).map_or(born, |touched| born.max(*touched))
}

/// A task's Claude agent being spawned; ends (and wakes a waiting switch) when dropped.
pub(in crate::providers) struct Spawning(String);

impl Spawning {
    pub(in crate::providers) fn mark(session_id: &str) -> Self {
        SPAWNING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(session_id.to_owned());
        Self(session_id.to_owned())
    }
}

impl Drop for Spawning {
    fn drop(&mut self) {
        SPAWNING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&self.0);
        changed();
    }
}

/// A Claude agent for the task is being spawned (it is stored when the spawn ends).
pub(in crate::providers) fn spawning(session_id: &str) -> bool {
    SPAWNING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains(session_id)
}

/// One counter for tickets and both harnesses' generations.
pub(in crate::providers) fn next_generation() -> u64 {
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
}

/// Wake every waiting send and debounce to look again.
pub(in crate::providers) fn changed() {
    CHANGED.notify_waiters();
}

/// Wait until `pending` turns false or `deadline` passes, looking again on every `changed`.
pub(in crate::providers) async fn wait_while(deadline: tokio::time::Instant, mut pending: impl FnMut() -> bool) {
    loop {
        let notified = CHANGED.notified();
        tokio::pin!(notified);
        // Registered before looking, so a change between the look and the wait still wakes it.
        notified.as_mut().enable();
        if !pending() || tokio::time::timeout_at(deadline, notified).await.is_err() {
            return;
        }
    }
}

/// The send has taken (or given up on) its spare: a pending first start is no longer wanted.
pub(in crate::providers) fn launch_settled(session_id: &str) {
    reservations().remove(session_id);
    hurried().remove(session_id);
    changed();
}

/// Drop the task's pending first start, whatever its ticket.
pub(in crate::providers) fn cancel_ticket(session_id: &str) {
    reservations().remove(session_id);
    changed();
}

/// A ticket for a debounced first start; a newer ticket or a send makes it stale.
pub fn reserve(session_id: &str) -> u64 {
    let ticket = next_generation();
    reservations().insert(session_id.to_owned(), ticket);
    ticket
}

/// The ticket is still the task's newest.
pub fn reserved(session_id: &str, ticket: u64) -> bool {
    reservations().get(session_id) == Some(&ticket)
}

/// A debounced first start is pending for the task.
pub(in crate::providers) fn pending_ticket(session_id: &str) -> bool {
    reservations().contains_key(session_id)
}

/// The ticket's start is over (begun, superseded or abandoned). Every path of a debounced
/// start ends here, so a send never waits for a start that is not coming.
pub fn release(session_id: &str, ticket: u64) {
    let mut reservations = reservations();
    if reservations.get(session_id) == Some(&ticket) {
        reservations.remove(session_id);
    }
    drop(reservations);
    changed();
}

/// A send is waiting for this task's agent: a debounce still running ends now.
pub(in crate::providers) fn hurry(session_id: &str) {
    hurried().insert(session_id.to_owned());
    changed();
}

/// The pause before a switch's agent starts, so rapid picks start one agent; a send waiting
/// for it ends the pause at once.
pub async fn debounce(session_id: &str) {
    wait_while(tokio::time::Instant::now() + DEBOUNCE, || !hurried().contains(session_id)).await;
}
