//! Low-memory guard for warm spares: each idle Claude Code process holds about 195–255 MiB
//! (docs/worker-tokens.md), so none starts on a small machine, one short of free memory, or one
//! the OS reports under memory pressure. A probe the OS cannot answer never blocks a spare.

/// Below this much physical memory no spare starts (skips 4 GB machines, keeps 8 GB ones and
/// 7 GiB CI runners).
pub(super) const MIN_TOTAL_RAM_BYTES: u64 = 6 * 1024 * 1024 * 1024;
/// Below this much available memory no spare starts.
pub(super) const MIN_AVAILABLE_RAM_BYTES: u64 = 1536 * 1024 * 1024;

/// Whether memory leaves room for one more idle CLI. `None` (the OS did not say) allows it.
pub(super) fn memory_allows_warm_spare(total_bytes: Option<u64>, available_bytes: Option<u64>, under_pressure: bool) -> bool {
    !under_pressure
        && total_bytes.is_none_or(|total| total >= MIN_TOTAL_RAM_BYTES)
        && available_bytes.is_none_or(|available| available >= MIN_AVAILABLE_RAM_BYTES)
}

/// What the OS reports about memory right now.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Probe {
    total: Option<u64>,
    available: Option<u64>,
    under_pressure: bool,
}

#[cfg(test)]
thread_local! {
    static MEMORY_OVERRIDE: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

/// A test override scoped to the current thread. Use a current-thread runtime across awaits.
#[cfg(test)]
pub(super) struct MemoryOverride(Option<bool>);

#[cfg(test)]
impl MemoryOverride {
    pub(super) fn new(allowed: bool) -> Self {
        Self(MEMORY_OVERRIDE.with(|value| value.replace(Some(allowed))))
    }
}

#[cfg(test)]
impl Drop for MemoryOverride {
    fn drop(&mut self) {
        MEMORY_OVERRIDE.with(|value| value.set(self.0));
    }
}

/// Unit tests never read the machine's memory (runner memory varies): a healthy host unless the
/// thread-local override declines (reported as memory pressure).
#[cfg(test)]
fn test_probe() -> Probe {
    let declined = MEMORY_OVERRIDE.with(std::cell::Cell::get) == Some(false);
    Probe { under_pressure: declined, ..Probe::default() }
}

/// The guard, probed on a blocking thread so the async runtime never waits on the OS. Logs one
/// line when it declines and touches no churn streak or counter.
pub(super) async fn allows_spare_off_runtime() -> bool {
    #[cfg(test)]
    let probed: Result<Probe, tokio::task::JoinError> = Ok(test_probe());
    #[cfg(not(test))]
    let probed = tokio::task::spawn_blocking(probe).await;
    // A probe that failed to run says nothing about memory: allow, as for an unknown value.
    let Ok(found) = probed else { return true };
    let allowed = memory_allows_warm_spare(found.total, found.available, found.under_pressure);
    if !allowed {
        eprintln!("{}", skipped_note(found));
    }
    allowed
}

/// The line a declined spare logs: why, in whole MiB.
fn skipped_note(probe: Probe) -> String {
    let mib = |bytes: Option<u64>| bytes.map_or_else(|| "unknown".to_owned(), |bytes| format!("{} MiB", bytes / (1024 * 1024)));
    let why = if probe.under_pressure { "the system reports memory pressure" } else { "memory is low" };
    format!("No warm Claude agent: {why} (total {}, available {}).", mib(probe.total), mib(probe.available))
}

/// `MemTotal:` and `MemAvailable:` from `/proc/meminfo`, in bytes (the file gives KiB).
#[cfg(any(target_os = "linux", test))]
fn parse_meminfo(text: &str) -> (Option<u64>, Option<u64>) {
    let field = |name: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(name))
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|kib| kib.parse::<u64>().ok())
            .map(|kib| kib.saturating_mul(1024))
    };
    (field("MemTotal:"), field("MemAvailable:"))
}

#[cfg(target_os = "linux")]
fn probe() -> Probe {
    let (total, available) = std::fs::read_to_string("/proc/meminfo").map(|text| parse_meminfo(&text)).unwrap_or_default();
    Probe { total, available, under_pressure: false }
}

/// macOS reports no single "available" figure; its pressure level (1 normal, 2 warn, 4 critical)
/// says when free memory runs short.
#[cfg(target_os = "macos")]
fn probe() -> Probe {
    fn sysctl<T: Copy + Default>(name: &[u8]) -> Option<T> {
        let mut value = T::default();
        let mut size = std::mem::size_of::<T>();
        // SAFETY: `name` is NUL-terminated; `value` is a writable buffer of `size` bytes, and no
        // new value is set (null pointer, length 0).
        let status = unsafe { libc::sysctlbyname(name.as_ptr().cast(), (&mut value as *mut T).cast(), &mut size, std::ptr::null_mut(), 0) };
        (status == 0 && size == std::mem::size_of::<T>()).then_some(value)
    }
    let total = sysctl::<u64>(b"hw.memsize\0");
    let level = sysctl::<i32>(b"kern.memorystatus_vm_pressure_level\0");
    Probe { total, available: None, under_pressure: level.is_some_and(|level| level >= 2) }
}

#[cfg(windows)]
fn probe() -> Probe {
    /// `MEMORYSTATUSEX`. Underscored fields are only read by the OS (`dwLength`) or never.
    #[repr(C)]
    struct MemoryStatusEx {
        _length: u32,
        _memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        _total_page_file: u64,
        _avail_page_file: u64,
        _total_virtual: u64,
        _avail_virtual: u64,
        _avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
    }
    let mut status = MemoryStatusEx {
        _length: std::mem::size_of::<MemoryStatusEx>() as u32,
        _memory_load: 0,
        total_phys: 0,
        avail_phys: 0,
        _total_page_file: 0,
        _avail_page_file: 0,
        _total_virtual: 0,
        _avail_virtual: 0,
        _avail_extended_virtual: 0,
    };
    // SAFETY: `status` is a properly sized `MEMORYSTATUSEX` with `dwLength` set, as required.
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return Probe::default();
    }
    Probe { total: Some(status.total_phys), available: Some(status.avail_phys), under_pressure: false }
}

/// Other platforms have no probe: spares are allowed.
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn probe() -> Probe {
    Probe::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn proc_meminfo_gives_total_and_available_in_bytes() {
        let text = "MemTotal:       16314192 kB\nMemFree:          912340 kB\nMemAvailable:    8123456 kB\nBuffers:  1 kB\n";
        assert_eq!(parse_meminfo(text), (Some(16_314_192 * 1024), Some(8_123_456 * 1024)));
        assert_eq!(parse_meminfo("MemTotal: 4000 kB\n"), (Some(4000 * 1024), None), "an old kernel without MemAvailable");
        assert_eq!(parse_meminfo("MemTotal: lots kB\n"), (None, None), "an unreadable value is unknown");
        assert_eq!(parse_meminfo(""), (None, None));
    }

    #[test]
    fn a_healthy_host_or_an_unknown_probe_allows_a_spare() {
        assert!(memory_allows_warm_spare(Some(16 * GIB), Some(8 * GIB), false));
        assert!(memory_allows_warm_spare(Some(MIN_TOTAL_RAM_BYTES), Some(MIN_AVAILABLE_RAM_BYTES), false), "the thresholds themselves pass");
        assert!(memory_allows_warm_spare(Some(7 * GIB), None, false), "a 7 GiB CI runner");
        assert!(memory_allows_warm_spare(None, None, false), "the OS said nothing");
    }

    #[test]
    fn low_total_or_available_memory_or_pressure_declines_a_spare() {
        assert!(!memory_allows_warm_spare(Some(4 * GIB), Some(3 * GIB), false), "a 4 GB machine");
        assert!(!memory_allows_warm_spare(Some(MIN_TOTAL_RAM_BYTES - 1), None, false));
        assert!(!memory_allows_warm_spare(Some(16 * GIB), Some(GIB), false), "1 GiB available");
        assert!(!memory_allows_warm_spare(None, Some(MIN_AVAILABLE_RAM_BYTES - 1), false));
        assert!(!memory_allows_warm_spare(Some(64 * GIB), Some(32 * GIB), true), "memory pressure");
        assert!(!memory_allows_warm_spare(None, None, true));
    }

    #[test]
    fn a_declined_spare_says_why_in_mib() {
        let low = skipped_note(Probe { total: Some(4 * GIB), available: None, under_pressure: false });
        assert_eq!(low, "No warm Claude agent: memory is low (total 4096 MiB, available unknown).");
        let pressed = skipped_note(Probe { total: Some(16 * GIB), available: None, under_pressure: true });
        assert!(pressed.contains("memory pressure") && pressed.contains("16384 MiB"), "{pressed}");
    }

    /// The real probe answers on every desktop platform CI runs (Linux, macOS, Windows), and a
    /// machine that runs the test suite has more than a few hundred MiB.
    #[test]
    fn the_os_probe_reports_physical_memory() {
        let probe = probe();
        #[cfg(any(target_os = "linux", target_os = "macos", windows))]
        assert!(probe.total.is_some_and(|total| total > 512 * 1024 * 1024), "{probe:?}");
        #[cfg(any(target_os = "linux", windows))]
        assert!(probe.available.is_some_and(|available| available <= probe.total.unwrap_or(u64::MAX)), "{probe:?}");
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        assert_eq!(probe, Probe::default());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unit_tests_allow_spares_unless_overridden() {
        assert!(allows_spare_off_runtime().await, "runner memory never flakes a test");
        for allowed in [false, true] {
            let _override = MemoryOverride::new(allowed);
            assert_eq!(allows_spare_off_runtime().await, allowed);
        }
        assert!(allows_spare_off_runtime().await, "the override restores the original decision");
    }
}
