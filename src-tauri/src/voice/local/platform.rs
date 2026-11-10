//! Whether this computer can run the bundled speech engine. Windows on Arm release builds are
//! compiled natively by MSVC for the build runner's CPU (`GGML_NATIVE=ON`), which has the Armv8.2
//! dot-product and the Armv8.6 int8 matrix-multiply (i8mm) extensions, so an Arm CPU without
//! either (e.g. Snapdragon 8cx Gen 1-3 lack i8mm) would crash on the first model load. Both are
//! checked with `IsProcessorFeaturePresent`; i8mm is feature id 66
//! (`PF_ARM_V82_I8MM_INSTRUCTIONS_AVAILABLE`, Windows SDK 26100). Windows versions that predate
//! that id answer false, which safely blocks local models there.

pub const UNSUPPORTED_CPU: &str =
    "This computer’s processor can’t run on-device speech models. Use a speech service instead.";

/// The CPU facts the decision needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cpu {
    #[cfg_attr(not(all(target_os = "windows", target_arch = "aarch64")), allow(dead_code))]
    WindowsArm64 { dotprod: bool, i8mm: bool },
    Other,
}

/// `Some(reason)` when on-device speech cannot run on `cpu`.
pub fn unsupported_reason(cpu: Cpu) -> Option<&'static str> {
    match cpu {
        Cpu::WindowsArm64 { dotprod: true, i8mm: true } | Cpu::Other => None,
        Cpu::WindowsArm64 { .. } => Some(UNSUPPORTED_CPU),
    }
}

#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
fn this_cpu() -> Cpu {
    use windows::Win32::System::Threading::{
        IsProcessorFeaturePresent, PF_ARM_V82_DP_INSTRUCTIONS_AVAILABLE, PROCESSOR_FEATURE_ID,
    };
    /// `PF_ARM_V82_I8MM_INSTRUCTIONS_AVAILABLE` (Windows SDK 26100; not in the `windows` crate).
    const PF_ARM_V82_I8MM_INSTRUCTIONS_AVAILABLE: PROCESSOR_FEATURE_ID = PROCESSOR_FEATURE_ID(66);
    // SAFETY: plain queries with constant feature ids.
    let dotprod = unsafe { IsProcessorFeaturePresent(PF_ARM_V82_DP_INSTRUCTIONS_AVAILABLE) }.as_bool();
    let i8mm = unsafe { IsProcessorFeaturePresent(PF_ARM_V82_I8MM_INSTRUCTIONS_AVAILABLE) }.as_bool();
    Cpu::WindowsArm64 { dotprod, i8mm }
}

#[cfg(not(all(target_os = "windows", target_arch = "aarch64")))]
fn this_cpu() -> Cpu {
    Cpu::Other
}

/// Why on-device speech is unavailable on this computer, if it is.
pub fn current_unsupported_reason() -> Option<&'static str> {
    if !cfg!(any(target_os = "macos", target_os = "windows", target_os = "linux")) {
        return Some("On-device speech models aren’t available on this system. Use a speech service instead.");
    }
    static REASON: std::sync::OnceLock<Option<&'static str>> = std::sync::OnceLock::new();
    *REASON.get_or_init(|| unsupported_reason(this_cpu()))
}
