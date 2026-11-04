//! Legacy Keychain reads run in a short-lived process whose UI is disabled.
//! The application process never changes the global Keychain interaction flag.

#[cfg(target_os = "macos")]
mod mac {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Serialize};
    use std::{
        process::Command,
        sync::{Mutex, PoisonError},
        time::Duration,
    };

    const FLAG: &str = "--pandacode-usage-keychain";
    const CHILD: &str = "PANDACODE_USAGE_KEYCHAIN_CHILD";
    const TARGET: &str = "PANDACODE_USAGE_KEYCHAIN_TARGET";
    const MARKER: &[u8] = b"PANDACODE_USAGE_KEYCHAIN:";
    const LIMIT: usize = 32 * 1024;
    const ERR_INTERACTION_NOT_ALLOWED: i32 = -25308;

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

    #[derive(Debug, PartialEq)]
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
            LIMIT,
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

    pub(crate) fn read_claude(service: &str) -> Result<Option<Vec<u8>>, ()> {
        static TOOL_FAILED: Mutex<bool> = Mutex::new(false);
        match read(service) {
            Err(Failure::Refused) if service != "glm" => {
                until_first_failure(&TOOL_FAILED, || read_with_security_tool(service))
            }
            result => result.map_err(|_| ()),
        }
    }

    /// `security` runs without our disabled-interaction flag, so an item whose
    /// access list does not trust it may raise a dialog. The first failure
    /// (denied, or killed at the deadline) therefore stops it for this launch,
    /// and the lock is held across the read so concurrent checks cannot stack
    /// dialogs. Every tray open re-reads usage, so this must not repeat.
    // ponytail: one latch for all Claude profiles, per-service if anyone needs a retry without a restart.
    fn until_first_failure(
        failed: &Mutex<bool>,
        read: impl FnOnce() -> Result<Option<Vec<u8>>, ()>,
    ) -> Result<Option<Vec<u8>>, ()> {
        let mut failed = failed.lock().unwrap_or_else(PoisonError::into_inner);
        if *failed {
            return Err(());
        }
        let result = read();
        *failed = result.is_err();
        result
    }

    /// Claude Code writes its login with Apple's `security` tool, so the
    /// item's access list trusts `/usr/bin/security` and not PandaCode. The
    /// direct read is then refused without a prompt; asking the trusted tool
    /// for the same exact item succeeds without one.
    fn read_with_security_tool(service: &str) -> Result<Option<Vec<u8>>, ()> {
        let account = account_name().ok_or(())?;
        let mut command = Command::new("/usr/bin/security");
        command.args(["find-generic-password", "-s", service, "-a", &account, "-w"]);
        let mut output = crate::workspace::run_process(
            command,
            "Usage credential reader",
            LIMIT,
            Duration::from_secs(3),
        )
        .map_err(|_| ())?;
        output.stderr.bytes.fill(0);
        security_output(
            output.status.code(),
            output.stdout.truncated,
            std::mem::take(&mut output.stdout.bytes),
        )
    }

    fn security_output(
        code: Option<i32>,
        truncated: bool,
        mut stdout: Vec<u8>,
    ) -> Result<Option<Vec<u8>>, ()> {
        if truncated || code != Some(0) {
            stdout.fill(0);
            // 44: the item does not exist.
            return if !truncated && code == Some(44) { Ok(None) } else { Err(()) };
        }
        while stdout.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
            stdout.pop();
        }
        Ok((!stdout.is_empty()).then_some(stdout))
    }

    pub(crate) fn read_glm() -> Result<Option<Vec<u8>>, ()> {
        read("glm").map_err(|_| ())
    }

    /// Only an access-list refusal may go on to `security`. A locked Keychain
    /// answers with the same code, but there the tool would ask for the
    /// Keychain password.
    fn may_ask_security_tool(code: i32, unlocked: impl FnOnce() -> bool) -> bool {
        code == ERR_INTERACTION_NOT_ALLOWED && unlocked()
    }

    fn default_keychain_unlocked() -> bool {
        #[link(name = "Security", kind = "framework")]
        extern "C" {
            fn SecKeychainGetStatus(keychain: *const std::ffi::c_void, status: *mut u32) -> i32;
        }
        const UNLOCKED: u32 = 1; // kSecUnlockStateStatus
        let mut status = 0;
        // Null is the default keychain; this reads a state flag, never an item.
        unsafe { SecKeychainGetStatus(std::ptr::null(), &mut status) == 0 && status & UNLOCKED != 0 }
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
            let Some(account) = account_name() else {
                return Reply::Blocked;
            };
            (target, account)
        };
        match find_generic_password(None, service, &account) {
            Ok((password, _item)) if password.len() <= 16 * 1024 => {
                Reply::Found(STANDARD.encode(password.as_ref()))
            }
            Err(error) if error.code() == -25300 => Reply::Missing,
            Err(error) if may_ask_security_tool(error.code(), default_keychain_unlocked) => {
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

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn only_exact_provider_credential_targets_are_allowed() {
            assert!(valid_target("glm"));
            assert!(valid_target("Claude Code-credentials"));
            assert!(valid_target("Claude Code-credentials-ab12cd34"));
            for invalid in [
                "",
                "Slack",
                "Claude Code-credentials-extra",
                "Claude Code-credentials-AB12CD34",
                "../Claude Code-credentials",
            ] {
                assert!(!valid_target(invalid));
            }
        }

        #[test]
        fn helper_protocol_rejects_missing_or_multiple_responses() {
            assert!(decode(b"unrelated stdout").is_err());
            assert!(decode(b"PANDACODE_USAGE_KEYCHAIN:{\"status\":\"blocked\"}").is_err());
            assert_eq!(decode(b"\nrunning 1 test\nPANDACODE_USAGE_KEYCHAIN:{\"status\":\"found\",\"data\":\"dGVzdA==\"}\n").ok().flatten(), Some(b"test".to_vec()));
            assert!(decode(b"PANDACODE_USAGE_KEYCHAIN:{\"status\":\"missing\"}\nPANDACODE_USAGE_KEYCHAIN:{\"status\":\"missing\"}").is_err());
        }

        #[test]
        fn only_an_unlocked_keychain_refusal_reaches_the_security_tool() {
            assert_eq!(
                decode(b"PANDACODE_USAGE_KEYCHAIN:{\"status\":\"refused\"}"),
                Err(Failure::Refused)
            );
            assert_eq!(
                decode(b"PANDACODE_USAGE_KEYCHAIN:{\"status\":\"blocked\"}"),
                Err(Failure::Other)
            );
            assert!(may_ask_security_tool(-25308, || true));
            assert!(!may_ask_security_tool(-25308, || false), "locked keychain");
            assert!(!may_ask_security_tool(-25293, || true));
        }

        #[test]
        fn security_tool_output_is_parsed_and_failures_keep_nothing() {
            let parse = |code, truncated, out: &[u8]| security_output(code, truncated, out.to_vec());
            assert_eq!(parse(Some(0), false, b"{\"a\":1}\r\n"), Ok(Some(b"{\"a\":1}".to_vec())));
            assert_eq!(parse(Some(0), false, b"\n"), Ok(None));
            assert_eq!(parse(Some(44), false, b""), Ok(None));
            assert_eq!(parse(Some(51), false, b"secret"), Err(()));
            assert_eq!(parse(None, false, b"secret"), Err(()));
            assert_eq!(parse(Some(0), true, b"sec"), Err(()));
            assert_eq!(parse(Some(44), true, b"sec"), Err(()));
        }

        #[test]
        fn a_failed_security_read_never_runs_again() {
            let failed = Mutex::new(false);
            assert_eq!(until_first_failure(&failed, || Ok(None)), Ok(None));
            assert_eq!(until_first_failure(&failed, || Ok(Some(vec![1]))), Ok(Some(vec![1])));
            assert_eq!(until_first_failure(&failed, || Err(())), Err(()));
            let mut ran = false;
            let again = until_first_failure(&failed, || {
                ran = true;
                Ok(None)
            });
            assert_eq!(again, Err(()));
            assert!(!ran);
        }

        #[test]
        fn interaction_is_disabled_only_in_the_child_process() {
            use security_framework::os::macos::keychain::SecKeychain;
            let before = SecKeychain::user_interaction_allowed().unwrap();
            let bytes = capture("probe", Duration::from_secs(3)).unwrap();
            assert!(bytes
                .windows(b"\"data\":false".len())
                .any(|w| w == b"\"data\":false"));
            assert_eq!(SecKeychain::user_interaction_allowed().unwrap(), before);
        }

        #[test]
        fn a_shell_cannot_use_the_app_as_a_credential_exporter() {
            let direct = command("probe").unwrap();
            let mut shell = Command::new("/bin/sh");
            shell
                .args(["-c", "\"$@\" & wait", "usage-parent-check"])
                .arg(direct.get_program())
                .args(direct.get_args());
            for (name, value) in direct.get_envs() {
                if let Some(value) = value {
                    shell.env(name, value);
                }
            }
            let result =
                crate::workspace::run_process(shell, "Usage test", LIMIT, Duration::from_secs(3))
                    .unwrap();
            assert!(result
                .stdout
                .bytes
                .windows(b"\"status\":\"blocked\"".len())
                .any(|w| w == b"\"status\":\"blocked\""));
            assert!(!result
                .stdout
                .bytes
                .windows(b"\"data\":false".len())
                .any(|w| w == b"\"data\":false"));
        }

        #[test]
        fn a_stalled_reader_is_killed_at_the_deadline() {
            let started = std::time::Instant::now();
            assert!(capture("hang", Duration::from_millis(200)).is_err());
            assert!(started.elapsed() < Duration::from_secs(3));
        }

        #[test]
        #[ignore = "Internal isolated helper; inert without the explicit parent sentinel"]
        fn internal_helper() {
            if std::env::var(CHILD).ok().as_deref() != Some("1") {
                return;
            }
            emit(&std::env::var(TARGET).unwrap_or_default());
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) use mac::{read_claude, read_glm};

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
