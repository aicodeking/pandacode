//! Returns memory the allocator holds after agent work to the OS.

use std::sync::Mutex;
use std::time::{Duration, Instant};

const MIN_GAP: Duration = Duration::from_secs(30);

static LAST: Mutex<Option<Instant>> = Mutex::new(None);

/// Asks the allocator to give back freed pages, off the async executor and at most
/// once per `MIN_GAP`. Called when the last running agent run ends.
pub fn release_soon() {
    {
        let Ok(mut last) = LAST.lock() else { return };
        if last.is_some_and(|at| at.elapsed() < MIN_GAP) {
            return;
        }
        *last = Some(Instant::now());
    }
    drop(tauri::async_runtime::spawn_blocking(release));
}

#[cfg(target_os = "macos")]
pub fn release() {
    extern "C" {
        fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
    }
    // SAFETY: libSystem's documented API; a null zone means every zone and a goal of 0
    // means as much as possible. It touches only allocator-owned free memory.
    unsafe {
        malloc_zone_pressure_relief(std::ptr::null_mut(), 0);
    }
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
pub fn release() {
    extern "C" {
        fn malloc_trim(pad: usize) -> std::ffi::c_int;
    }
    // SAFETY: glibc's malloc_trim only returns free heap pages to the OS.
    unsafe {
        malloc_trim(0);
    }
}

#[cfg(not(any(target_os = "macos", all(target_os = "linux", target_env = "gnu"))))]
pub fn release() {}

#[cfg(test)]
mod tests {
    #[test]
    fn release_runs() {
        let blocks: Vec<Vec<u8>> = (0..50_000).map(|_| vec![1; 1024]).collect();
        drop(blocks);
        super::release();
    }

    /// `cargo test --lib memory::tests::footprint -- --ignored --nocapture`
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn footprint() {
        let pid = std::process::id().to_string();
        let measure = || {
            let out = std::process::Command::new("footprint").arg(&pid).output().unwrap();
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.lines().find(|line| line.contains("Footprint")).unwrap_or("").to_string()
        };
        let blocks: Vec<Vec<u8>> = (0..200_000).map(|i| vec![1; 256 + i % 512]).collect();
        // Keep every 64th block so freed blocks stay scattered across the zone.
        let kept: Vec<Vec<u8>> = blocks.into_iter().step_by(64).collect();
        println!("after free: {}", measure());
        super::release();
        println!("after: {}", measure());
        drop(kept);
    }
}
