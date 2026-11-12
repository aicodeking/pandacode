//! Keychain access for usage limits. Reads run first in a short-lived process
//! whose UI is disabled (the application process never changes the global
//! Keychain interaction flag). Claude Code's own item trusts Apple's
//! `security` tool, not PandaCode; how it is then read (never written) and
//! when it is never asked about again is in `usage_keychain_claude.rs`.

#[cfg(target_os = "macos")]
mod mac {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Serialize};
    use std::{
        process::Command,
        collections::{HashMap, HashSet},
        sync::{Mutex, OnceLock, PoisonError},
        time::{Duration, Instant},
    };

    const FLAG: &str = "--pandacode-usage-keychain";
    const CHILD: &str = "PANDACODE_USAGE_KEYCHAIN_CHILD";
    const TARGET: &str = "PANDACODE_USAGE_KEYCHAIN_TARGET";
    const MARKER: &[u8] = b"PANDACODE_USAGE_KEYCHAIN:";
    const LIMIT: usize = 32 * 1024;
    /// Largest item read or written: Claude Code's item grows with MCP OAuth
    /// entries. Matches the credential-file and stored-login limits.
    pub(crate) const ITEM_LIMIT: usize = 256 * 1024;
    /// The reader's reply is base64 of the item plus its frame.
    const CHILD_OUTPUT_LIMIT: usize = ITEM_LIMIT / 3 * 4 + 8 * 1024;
    /// `security -g` prints the secret as `password: 0x<hex>  "<escaped copy>"`:
    /// two characters per byte, plus up to four (`\303`) in the copy.
    const SECURITY_OUTPUT_LIMIT: usize = ITEM_LIMIT * 6 + 4096;
    /// `security` exits with the low byte of the failing status. These mean a
    /// dialog was refused or would have been needed: errSecInteractionNotAllowed
    /// (36), errSecAuthFailed (51) and userCanceled (128).
    const DENIALS: [i32; 3] = [36, 51, 128];
    /// The refusals that mean "this item's access list does not include the
    /// reader": errSecInteractionNotAllowed, and errSecAuthFailed, which
    /// current macOS returns for Claude Code's items.
    const ACCESS_REFUSALS: [i32; 2] = [-25308, -25293];

    #[derive(Serialize, Deserialize)]
    #[serde(tag = "status", content = "data", rename_all = "camelCase")]
    enum Reply {
        Found(String),
        Missing,
        Blocked,
        /// The unlocked Keychain refused this process; asking would need a prompt.
        Refused,
        #[cfg(test)]
        Probe(bool),
    }

    #[derive(Clone, Copy, Debug, PartialEq)]
    enum Failure {
        Refused,
        Other,
    }

    fn valid_target(target: &str) -> bool {
        target == "glm"
            || target == "Claude Code-credentials"
            || target
                .strip_prefix("Claude Code-credentials-")
                .is_some_and(|suffix| {
                    suffix.len() == 8
                        && suffix
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
    }

    fn trusted_parent() -> bool {
        use std::os::unix::ffi::OsStringExt;
        let mut path = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let length = unsafe {
            libc::proc_pidpath(libc::getppid(), path.as_mut_ptr().cast(), path.len() as u32)
        };
        if length <= 0 || length as usize >= path.len() {
            return false;
        }
        let end = path
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(length as usize);
        let parent = std::path::PathBuf::from(std::ffi::OsString::from_vec(path[..end].to_vec()));
        match (
            std::fs::canonicalize(parent),
            std::env::current_exe().and_then(std::fs::canonicalize),
        ) {
            (Ok(parent), Ok(current)) => parent == current,
            _ => false,
        }
    }

    fn account_name() -> Option<String> {
        let mut passwd = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        let mut buffer = vec![0_u8; 16 * 1024];
        let status = unsafe {
            libc::getpwuid_r(
                libc::geteuid(),
                passwd.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status != 0 || result.is_null() {
            return None;
        }
        let passwd = unsafe { passwd.assume_init() };
        if passwd.pw_name.is_null() {
            return None;
        }
        unsafe { std::ffi::CStr::from_ptr(passwd.pw_name) }
            .to_str()
            .ok()
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
    }

    fn decode(bytes: &[u8]) -> Result<Option<Vec<u8>>, Failure> {
        let mut frames = bytes
            .split(|b| *b == b'\n')
            .filter_map(|line| line.strip_prefix(MARKER));
        let frame = frames.next().ok_or(Failure::Other)?;
        if frames.next().is_some() {
            return Err(Failure::Other);
        }
        match serde_json::from_slice(frame).map_err(|_| Failure::Other)? {
            Reply::Found(data) => {
                let result = STANDARD.decode(&data).map(Some).map_err(|_| Failure::Other);
                let mut bytes = data.into_bytes();
                bytes.fill(0);
                result
            }
            Reply::Missing => Ok(None),
            Reply::Refused => Err(Failure::Refused),
            _ => Err(Failure::Other),
        }
    }

    fn command(target: &str) -> Result<Command, ()> {
        let mut command = Command::new(std::env::current_exe().map_err(|_| ())?);
        if cfg!(test) {
            command.args([
                "--exact",
                "usage_keychain::mac::tests::internal_helper",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ]);
        } else {
            command.arg(FLAG);
        }
        command.env(CHILD, "1").env(TARGET, target);
        Ok(command)
    }

    fn capture(target: &str, timeout: Duration) -> Result<Vec<u8>, ()> {
        let mut output = crate::workspace::run_process(
            command(target)?,
            "Usage credential reader",
            CHILD_OUTPUT_LIMIT,
            timeout,
        )
        .map_err(|_| ())?;
        output.stderr.bytes.fill(0);
        if !output.status.success() || output.stdout.truncated {
            output.stdout.bytes.fill(0);
            return Err(());
        }
        Ok(output.stdout.bytes)
    }

    fn read(target: &str) -> Result<Option<Vec<u8>>, Failure> {
        if !valid_target(target) {
            return Err(Failure::Other);
        }
        let mut bytes = capture(target, Duration::from_secs(3)).map_err(|()| Failure::Other)?;
        let result = decode(&bytes);
        bytes.fill(0);
        result
    }

    include!("usage_keychain_claude.rs");

    pub(crate) fn read_glm() -> Result<Option<Vec<u8>>, ()> {
        read("glm").map_err(|_| ())
    }

    /// Only an access-list refusal may go on to `security`. A locked Keychain
    /// answers with the same code, but there the tool would ask for the
    /// Keychain password.
    fn may_ask_security_tool(code: i32, unlocked: impl FnOnce() -> bool) -> bool {
        ACCESS_REFUSALS.contains(&code) && unlocked()
    }

    /// Whether the keychains that may hold Claude Code's item are unlocked:
    /// the default keychain (where `security add-generic-password` saves it)
    /// and the login keychain (where it is when the default was changed).
    /// Reads state flags only, never an item, so nothing can prompt.
    fn keychains_unlocked() -> bool {
        use std::ffi::c_void;
        #[link(name = "Security", kind = "framework")]
        extern "C" {
            fn SecKeychainGetStatus(keychain: *const c_void, status: *mut u32) -> i32;
            fn SecKeychainOpen(path: *const std::ffi::c_char, keychain: *mut *const c_void) -> i32;
        }
        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFRelease(object: *const c_void);
        }
        const UNLOCKED: u32 = 1; // kSecUnlockStateStatus
        let unlocked = |keychain: *const c_void| {
            let mut status = 0;
            unsafe { SecKeychainGetStatus(keychain, &mut status) == 0 && status & UNLOCKED != 0 }
        };
        // Null is the default keychain.
        if !unlocked(std::ptr::null()) {
            return false;
        }
        // Opening only names the file (it never prompts); a missing one is skipped.
        let login = crate::agent_usage_providers::home().map(|home| home.join("Library/Keychains/login.keychain-db")).filter(|path| path.exists());
        let Some(path) = login.and_then(|path| std::ffi::CString::new(path.into_os_string().into_encoded_bytes()).ok()) else { return true };
        let mut keychain = std::ptr::null();
        if unsafe { SecKeychainOpen(path.as_ptr(), &mut keychain) } != 0 || keychain.is_null() {
            return false;
        }
        let open = unlocked(keychain);
        unsafe { CFRelease(keychain) };
        open
    }

    fn reply(target: &str) -> Reply {
        use security_framework::os::macos::{
            keychain::SecKeychain, passwords::find_generic_password,
        };
        // The environment flag alone is not authority: a shell launching this
        // signed app must not gain an export path through its Keychain ACL.
        if !trusted_parent() {
            return Reply::Blocked;
        }
        #[cfg(test)]
        let probe = matches!(target, "probe" | "hang");
        #[cfg(not(test))]
        let probe = false;
        if !valid_target(target) && !probe {
            return Reply::Blocked;
        }
        // This is the legacy Keychain control, applied only inside this child.
        // The previous per-query UISkip option does not protect legacy items.
        let Ok(_interaction) = SecKeychain::disable_user_interaction() else {
            return Reply::Blocked;
        };
        #[cfg(test)]
        if target == "hang" {
            std::thread::sleep(Duration::from_secs(300));
        }
        #[cfg(test)]
        if probe {
            return Reply::Probe(SecKeychain::user_interaction_allowed().unwrap_or(true));
        }
        let (service, account) = if target == "glm" {
            ("app.pandacode.providers", "zai-coding-plan".into())
        } else {
            let account = claude_account();
            (target, account)
        };
        match find_generic_password(None, service, &account) {
            Ok((password, _item)) if password.len() <= ITEM_LIMIT => {
                Reply::Found(STANDARD.encode(password.as_ref()))
            }
            Err(error) if error.code() == -25300 => Reply::Missing,
            Err(error) if may_ask_security_tool(error.code(), keychains_unlocked) => {
                Reply::Refused
            }
            _ => Reply::Blocked,
        }
    }

    fn emit(target: &str) {
        use std::io::Write;
        let result = reply(target);
        let mut output = std::io::stdout().lock();
        let _ = output.write_all(b"\n");
        let _ = output.write_all(MARKER);
        let _ = serde_json::to_writer(&mut output, &result);
        let _ = output.write_all(b"\n");
        let _ = output.flush();
    }

    pub(super) fn handle() -> bool {
        if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(FLAG)) {
            return false;
        }
        if std::env::var(CHILD).ok().as_deref() == Some("1") {
            emit(&std::env::var(TARGET).unwrap_or_default());
        }
        true
    }

    // Kept in its own file to keep this module short; `include!` resolves
    // beside this file, which `#[path]` in an inline module does not.
    #[cfg(test)]
    mod tests {
        include!("usage_keychain_tests.rs");
    }
}

#[cfg(target_os = "macos")]
pub(crate) use mac::{claude_item_stamp, clear_backoff, keychain_unlocked, read_claude, read_glm, ReadError};
#[cfg(all(target_os = "macos", test))]
pub(crate) use mac::fake_backend;

pub fn handle_usage_keychain_helper() -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::handle()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}
