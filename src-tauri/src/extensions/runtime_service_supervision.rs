//! Supervision of background services (`runtime.service`, runtime slice R0106): the pure rules the service loop of
//! `runtime_service_lifetime.rs` applies, kept apart so that they are proven on a controlled clock.
//!
//! - A crash (the process started and then exited, threw from `service`, or broke the protocol) is restarted after a
//!   backoff of 1 s, doubling per consecutive crash up to 60 s. Crashes are consecutive while each one follows the
//!   previous one by less than ten minutes; a crash ten minutes or more after the previous one starts again at 1 s.
//! - Five crashes inside ten minutes park the service: no further restart until the user retries, enables it again or
//!   an update arrives. The explanation is bounded and names only host error codes, never package output.
//! - A start that never reached the process (no runtime, unreadable code) is not a crash: it stays failed until retried.
//! - A service still starting after ten seconds is reported as slow; nothing waits for it.
//! - Memory is measured (the resident set of the service's process tree), never capped; there is no deadline.
//!
//! These are reliability rules (ADR-0005): they never limit what a running service may do.
use std::{collections::{BTreeMap, VecDeque}, future::Future, pin::Pin, time::{Duration, Instant}};
use serde_json::{json, Value};

/// The first restart delay after a crash.
pub const FIRST_BACKOFF: Duration = Duration::from_secs(1);
/// The longest restart delay.
pub const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// The window crashes are counted in, and the quiet time that resets the backoff.
pub const CRASH_WINDOW: Duration = Duration::from_secs(600);
/// Crashes inside `CRASH_WINDOW` that park the service.
pub const PARK_AFTER: usize = 5;
/// A service whose `service` function has not settled after this long is shown as a slow start.
pub const START_NOTICE: Duration = Duration::from_secs(10);
/// How often the resident memory of a running service is measured.
pub const MEMORY_SAMPLE: Duration = Duration::from_secs(2);
/// The longest parking explanation, in characters.
pub const EXPLANATION_LIMIT: usize = 240;

/// A wait on a `Clock`.
pub type Sleep = Pin<Box<dyn Future<Output = ()> + Send>>;
/// The time source of the supervisor: the monotonic time since the manager was created. Tests replace it with a
/// `ManualClock` so that backoff and the crash window are reproducible to the millisecond.
pub trait Clock: Send + Sync {
    fn now(&self) -> Duration;
    /// Resolves once `now()` has reached `at`.
    fn sleep_until(&self, at: Duration) -> Sleep;
}
/// The real clock.
pub struct SystemClock(Instant);
impl Default for SystemClock { fn default() -> Self { Self(Instant::now()) } }
impl Clock for SystemClock {
    fn now(&self) -> Duration { self.0.elapsed() }
    fn sleep_until(&self, at: Duration) -> Sleep { Box::pin(tokio::time::sleep(at.saturating_sub(self.now()))) }
}
/// A clock that moves only when a test advances it.
#[cfg(test)]
pub struct ManualClock(tokio::sync::watch::Sender<Duration>);
#[cfg(test)]
impl ManualClock {
    pub fn new() -> std::sync::Arc<Self> { std::sync::Arc::new(Self(tokio::sync::watch::channel(Duration::ZERO).0)) }
    pub fn advance(&self, by: Duration) { self.0.send_modify(|now| *now += by); }
}
#[cfg(test)]
impl Clock for ManualClock {
    fn now(&self) -> Duration { *self.0.borrow() }
    fn sleep_until(&self, at: Duration) -> Sleep {
        let mut now = self.0.subscribe();
        Box::pin(async move { while *now.borrow_and_update() < at { if now.changed().await.is_err() { return; } } })
    }
}

/// The delay before the restart that follows the `streak`-th consecutive crash (1-based): 1 s, 2 s, 4 s … 60 s.
pub fn backoff(streak: u32) -> Duration {
    FIRST_BACKOFF.saturating_mul(1u32 << streak.saturating_sub(1).min(16)).min(MAX_BACKOFF)
}

/// What the supervisor does after a crash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Start again at `at` (clock time), `delay` after the crash.
    Restart { delay: Duration, at: Duration },
    /// Stop restarting; `explanation` is shown until the user retries, enables or updates.
    Park { explanation: String },
}

/// The crashes of one service since it was last started by the user (enable, retry, update or app start).
#[derive(Clone, Debug, Default)]
pub struct CrashHistory { recent: VecDeque<(Duration, &'static str)>, streak: u32, last: Option<Duration> }
impl CrashHistory {
    /// Records a crash with its host error code at clock time `now` and decides the next step.
    pub fn record(&mut self, id: &str, now: Duration, code: &'static str) -> Decision {
        if self.last.is_some_and(|last| now.saturating_sub(last) >= CRASH_WINDOW) { self.streak = 0; }
        self.last = Some(now);
        self.streak = self.streak.saturating_add(1);
        self.recent.retain(|(at, _)| now.saturating_sub(*at) < CRASH_WINDOW);
        self.recent.push_back((now, code));
        if self.recent.len() >= PARK_AFTER { return Decision::Park { explanation: explanation(id, self.recent.iter().map(|(_, code)| *code)) }; }
        let delay = backoff(self.streak);
        Decision::Restart { delay, at: now + delay }
    }
    /// Crashes inside the window ending at `now`.
    pub fn recent(&self, now: Duration) -> usize { self.recent.iter().filter(|(at, _)| now.saturating_sub(*at) < CRASH_WINDOW).count() }
}

/// The bounded, named parking explanation: the package id, the count and the host error codes (most frequent first).
pub fn explanation<'a>(id: &str, codes: impl Iterator<Item = &'a str>) -> String {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for code in codes { *counts.entry(code).or_default() += 1; }
    let total: usize = counts.values().sum();
    let mut named: Vec<(&str, usize)> = counts.into_iter().collect();
    named.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    let codes = named.iter().map(|(code, count)| if *count == 1 { (*code).to_owned() } else { format!("{code} x{count}") }).collect::<Vec<_>>().join(", ");
    bounded(format!("The service of {id} was parked after {total} crashes in 10 minutes ({codes}). Retry, enable or update the package to start it again."))
}
fn bounded(text: String) -> String {
    if text.chars().count() <= EXPLANATION_LIMIT { return text; }
    let mut cut: String = text.chars().take(EXPLANATION_LIMIT - 1).collect();
    cut.push('\u{2026}');
    cut
}

/// The start-state report of the projection: time since the start, whether it is a slow start, and how long the
/// start took once the service declared itself ready.
pub fn start_state(starting: bool, started: Duration, ready: Option<Duration>, now: Duration) -> Value {
    let elapsed = now.saturating_sub(started);
    json!({
        "elapsedMs": u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
        "slow": starting && elapsed >= START_NOTICE,
        "readyMs": ready.map(|ready| u64::try_from(ready.saturating_sub(started).as_millis()).unwrap_or(u64::MAX)),
    })
}

/// The measured resident memory of a running service (its whole process tree), never a limit.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Memory { pub resident: u64, pub peak: u64, pub samples: u64 }
impl Memory {
    pub fn sample(&mut self, resident: u64) { self.resident = resident; self.peak = self.peak.max(resident); self.samples += 1; }
    pub fn projection(&self) -> Value { json!({"residentBytes": self.resident, "peakBytes": self.peak, "samples": self.samples}) }
}

/// The resident set (working set on Windows, `VmRSS` on Linux) summed over `pids`; `None` when none can be read or
/// the platform has no reader yet (macOS: memory is not reported there until its runtime is qualified).
pub fn resident_bytes(pids: &[u32]) -> Option<u64> {
    let mut total = None;
    for pid in pids { if let Some(bytes) = process_resident(*pid) { total = Some(total.unwrap_or(0) + bytes); } }
    total
}
#[cfg(windows)]
fn process_resident(pid: u32) -> Option<u64> {
    use windows::Win32::{Foundation::CloseHandle, System::{ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS}, Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ}}};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid).ok()?;
        let mut counters = PROCESS_MEMORY_COUNTERS::default();
        let read = GetProcessMemoryInfo(handle, &mut counters, std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32);
        let _ = CloseHandle(handle);
        read.ok().map(|()| counters.WorkingSetSize as u64)
    }
}
#[cfg(target_os = "linux")]
fn process_resident(pid: u32) -> Option<u64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
    line.split_whitespace().nth(1)?.parse::<u64>().ok().map(|kib| kib * 1024)
}
#[cfg(not(any(windows, target_os = "linux")))]
fn process_resident(_pid: u32) -> Option<u64> { None }

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "sample.service-supervision";
    fn ms(value: u64) -> Duration { Duration::from_millis(value) }
    /// Feeds crash times (ms) and returns each decision as the restart delay in ms, or `None` for parking.
    fn script(times: &[u64]) -> Vec<Option<u64>> {
        let mut history = CrashHistory::default();
        times.iter().map(|time| match history.record(ID, ms(*time), "HostUnavailable") {
            Decision::Restart { delay, at } => { assert_eq!(at, ms(*time) + delay); Some(delay.as_millis() as u64) }
            Decision::Park { .. } => None,
        }).collect()
    }

    #[test]
    fn backoff_doubles_from_one_second_to_sixty_and_stays_there() {
        let delays: Vec<u64> = (1..=10).map(|streak| backoff(streak).as_secs()).collect();
        assert_eq!(delays, [1, 2, 4, 8, 16, 32, 60, 60, 60, 60]);
        assert_eq!(backoff(0), FIRST_BACKOFF);
        assert_eq!(backoff(u32::MAX), MAX_BACKOFF);
    }

    /// The scripted crash sequences of the acceptance, on a controlled clock.
    #[test]
    fn a_scripted_crash_sequence_backs_off_and_parks_after_five_crashes_in_ten_minutes() {
        // Each restart crashes at once: 1, 2, 4, 8 s, then the fifth crash (15 s after the first) parks.
        assert_eq!(script(&[0, 1_000, 3_000, 7_000, 15_000]), [Some(1_000), Some(2_000), Some(4_000), Some(8_000), None]);
        // Crashes every 150 s never put five inside ten minutes: the backoff climbs to the 60 s cap without parking.
        let spaced: Vec<u64> = (0..9).map(|index| index * 150_000).collect();
        assert_eq!(script(&spaced), [Some(1_000), Some(2_000), Some(4_000), Some(8_000), Some(16_000), Some(32_000), Some(60_000), Some(60_000), Some(60_000)]);
        // The boundary: a fifth crash 599.999 s after the first parks; at exactly 600 s the first has left the window.
        assert_eq!(script(&[0, 100_000, 200_000, 300_000, 599_999]).last(), Some(&None));
        assert_eq!(script(&[0, 100_000, 200_000, 300_000, 600_000]).last(), Some(&Some(16_000)));
        // Ten quiet minutes reset the backoff: the next crash restarts after 1 s again.
        assert_eq!(script(&[0, 1_000, 3_000, 603_000]), [Some(1_000), Some(2_000), Some(4_000), Some(1_000)]);
        assert_eq!(script(&[0, 1_000, 3_000, 602_999]), [Some(1_000), Some(2_000), Some(4_000), Some(8_000)]);
        let mut history = CrashHistory::default();
        for time in [0, 10, 20] { history.record(ID, ms(time), "HostUnavailable"); }
        assert_eq!((history.recent(ms(20)), history.recent(ms(600_000)), history.recent(ms(600_020))), (3, 2, 0));
    }

    #[test]
    fn the_parking_explanation_is_named_bounded_and_carries_only_host_codes() {
        let mut history = CrashHistory::default();
        let codes = ["HostUnavailable", "IncompatibleApi", "HostUnavailable", "PermissionDenied", "HostUnavailable"];
        let mut last = None;
        for (index, code) in codes.iter().enumerate() { last = Some(history.record(ID, ms(index as u64 * 10), code)); }
        let Some(Decision::Park { explanation }) = last else { panic!("not parked: {last:?}") };
        assert_eq!(explanation, "The service of sample.service-supervision was parked after 5 crashes in 10 minutes (HostUnavailable x3, IncompatibleApi, PermissionDenied). Retry, enable or update the package to start it again.");
        let long = super::explanation(&"x".repeat(400), ["HostUnavailable"; 5].into_iter());
        assert_eq!(long.chars().count(), EXPLANATION_LIMIT);
        assert!(long.ends_with('\u{2026}') && long.starts_with("The service of xxx"));
    }

    #[test]
    fn a_start_is_slow_after_ten_seconds_and_reports_how_long_it_took_once_ready() {
        assert_eq!(start_state(true, ms(5_000), None, ms(14_999)), json!({"elapsedMs": 9_999, "slow": false, "readyMs": null}));
        assert_eq!(start_state(true, ms(5_000), None, ms(15_000)), json!({"elapsedMs": 10_000, "slow": true, "readyMs": null}));
        assert_eq!(start_state(false, ms(5_000), Some(ms(17_000)), ms(30_000)), json!({"elapsedMs": 25_000, "slow": false, "readyMs": 12_000}));
    }

    #[tokio::test]
    async fn the_manual_clock_wakes_sleepers_only_when_advanced_past_their_time() {
        let clock = ManualClock::new();
        let sleeper = { let sleep = clock.sleep_until(ms(1_000)); tokio::spawn(sleep) };
        clock.advance(ms(999)); tokio::task::yield_now().await; tokio::time::sleep(ms(20)).await;
        assert!(!sleeper.is_finished());
        clock.advance(ms(1)); tokio::time::timeout(ms(2_000), sleeper).await.unwrap().unwrap();
        assert_eq!(clock.now(), ms(1_000));
    }

    #[test]
    fn memory_is_measured_with_its_peak_and_the_current_process_is_readable() {
        let mut memory = Memory::default();
        memory.sample(10); memory.sample(30); memory.sample(20);
        assert_eq!(memory.projection(), json!({"residentBytes": 20, "peakBytes": 30, "samples": 3}));
        let own = resident_bytes(&[std::process::id()]);
        if cfg!(any(windows, target_os = "linux")) { assert!(own.is_some_and(|bytes| bytes > 1024 * 1024), "{own:?}"); } else { assert_eq!(own, None); }
        assert_eq!(resident_bytes(&[]), None);
    }
}
