// Tests for `usage_keychain::mac`, kept apart to keep the module short.
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
    assert!(may_ask_security_tool(-25293, || true), "errSecAuthFailed on current macOS");
    assert!(!may_ask_security_tool(-25293, || false));
    assert!(!may_ask_security_tool(-128, || true), "a cancelled dialog is not a refusal");
}

#[test]
fn security_g_output_is_parsed_and_failures_keep_nothing() {
    let parse = |code, truncated, err: &[u8]| security_output(code, truncated, err.to_vec());
    let json = "{\"a\":\"Zoë\"}".as_bytes();
    let hex: String = json.iter().map(|b| format!("{b:02X}")).collect();
    // Non-ASCII bytes (or control characters) come as hex; printable ASCII,
    // quotes included, as a quoted string (below).
    assert_eq!(parse(Some(0), false, format!("password: 0x{hex}  \"ignored\"\n").as_bytes()), Ok(Some(json.to_vec())));
    assert_eq!(parse(Some(0), false, b"password: \"plain\"\n"), Ok(Some(b"plain".to_vec())));
    // The form Claude Code's ASCII-only login really takes: JSON, quotes and all, inside quotes.
    let login = br#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x","refreshToken":"sk-ant-ort01-y","expiresAt":1,"scopes":["user:profile"]}}"#;
    let mut printed = b"password: \"".to_vec();
    printed.extend_from_slice(login);
    printed.extend_from_slice(b"\"\n");
    assert_eq!(parse(Some(0), false, &printed), Ok(Some(login.to_vec())));
    assert_eq!(parse(Some(0), false, b"no password line"), Err(SecurityError::Other));
    assert_eq!(parse(Some(44), false, b""), Ok(None));
    for code in [51, 128] {
        assert_eq!(parse(Some(code), false, b"password: \"x\""), Err(SecurityError::Denied));
    }
    assert_eq!(parse(Some(36), false, b""), Err(SecurityError::NotAllowed));
    assert_eq!(parse(Some(1), false, b""), Err(SecurityError::Other));
    assert_eq!(parse(None, false, b""), Err(SecurityError::Other));
    assert_eq!(parse(Some(0), true, b"password: \"x\""), Err(SecurityError::Other));
    // Items with large MCP OAuth entries are read whole.
    let big = vec![b'x'; 40 * 1024];
    let big_hex: String = big.iter().map(|b| format!("{b:02X}")).collect();
    assert_eq!(parse(Some(0), false, format!("password: 0x{big_hex}  \"…\"").as_bytes()), Ok(Some(big)));
    const { assert!(SECURITY_OUTPUT_LIMIT >= ITEM_LIMIT * 2) };
    const FRAMED: usize = MARKER.len() + r#"{"status":"found","data":""}"#.len() + ITEM_LIMIT.div_ceil(3) * 4;
    const { assert!(CHILD_OUTPUT_LIMIT > FRAMED) };
}

#[test]
fn a_failed_read_backs_off_per_service_and_recovers() {
    let mut backoff = Backoff::default();
    let start = Instant::now();
    let at = |secs| start + Duration::from_secs(secs);
    backoff.record("a", at(0), true);
    assert!(!backoff.allows("a", at(60)), "backing off");
    assert!(backoff.allows("b", at(60)), "other profiles are not held back");
    assert!(backoff.allows("a", at(601)));
    backoff.record("a", at(601), true);
    assert!(!backoff.allows("a", at(601 + 900)), "a second failure doubles the wait");
    backoff.record("a", at(601 + 1201), false);
    assert!(backoff.allows("a", at(601 + 1202)), "a success clears it");
    assert_eq!(Backoff::wait(40), BACKOFF_MAX);
}

/// `read_claude`'s path: the reader is refused (Claude Code's item), and
/// `security` answers as scripted, with an account attribute.
fn read_as(service: &str, security: impl FnOnce() -> Result<Option<Vec<u8>>, SecurityError>) -> Result<Option<Vec<u8>>, ReadError> {
    read_claude_with(service, true, SECURITY_TIMEOUT, || Err(Failure::Refused), move |_| {
        security().map(|found| found.map(|secret| Found { secret }))
    })
}

#[test]
fn only_an_access_refusal_on_an_unlocked_keychain_reaches_security() {
    let item = "Claude Code-credentials-00000b01";
    let json = b"{}".to_vec();
    let reader = |child: Result<Option<Vec<u8>>, Failure>, unlocked: bool| {
        let json = json.clone();
        read_claude_with(item, unlocked, SECURITY_TIMEOUT, move || child, move |_| Ok(Some(Found { secret: json })))
    };
    assert_eq!(reader(Err(Failure::Refused), true), Ok(Some(json.clone())), "refused: `security` reads it");
    assert_eq!(reader(Err(Failure::Refused), false), Err(ReadError::Locked), "never on a locked Keychain");
    assert_eq!(reader(Ok(Some(b"own".to_vec())), true), Ok(Some(b"own".to_vec())), "the reader's own find is final");
    // Blocked, slow or garbled: no `security`, and the item backs off.
    let blocked = read_claude_with(item, true, SECURITY_TIMEOUT, || Err(Failure::Other), |_| panic!("security after a non-refusal"));
    assert_eq!(blocked, Err(ReadError::Failed));
    assert_eq!(read_claude_with(item, true, SECURITY_TIMEOUT, || panic!("backing off"), |_| panic!("backing off")), Err(ReadError::Failed));
    clear_backoff(item);
    assert_eq!(reader(Err(Failure::Refused), true), Ok(Some(json)));
}

#[test]
fn a_denial_or_an_unanswered_read_latches_across_launches_until_one_refresh() {
    // A run killed at its deadline counts as not answered (it backs off; see below).
    let start = Instant::now() - Duration::from_secs(6);
    assert_eq!(run_error(start, SECURITY_TIMEOUT), SecurityError::TimedOut);
    assert_eq!(run_error(Instant::now(), SECURITY_TIMEOUT), SecurityError::Other);
    let item = "Claude Code-credentials-0000feed";
    assert_eq!(read_as(item, || Err(SecurityError::Denied)), Err(ReadError::Latched));
    assert!(marker(item).unwrap().exists());
    gate().latched.remove(item); // a new launch: memory is empty, the marker is not
    assert_eq!(read_as(item, || panic!("asked again after a restart")), Err(ReadError::Latched));
    // A manual refresh allows exactly one new attempt.
    clear_backoff(item);
    assert!(!marker(item).unwrap().exists());
    assert_eq!(read_as(item, || Err(SecurityError::Denied)), Err(ReadError::Latched));
    assert_eq!(read_as(item, || panic!("one attempt only")), Err(ReadError::Latched));
}

#[test]
fn a_slow_success_is_a_success() {
    let item = "Claude Code-credentials-0000cafe";
    let late = || { std::thread::sleep(Duration::from_millis(2100)); Ok(Some(b"{}".to_vec())) };
    assert_eq!(read_as(item, late), Ok(Some(b"{}".to_vec())));
    assert_eq!(read_as(item, || Ok(None)), Ok(None), "read again normally");
}

#[test]
fn a_manual_refresh_gives_security_time_to_be_answered() {
    let item = "Claude Code-credentials-0000d1a1";
    fake_backend::install(item, fake_backend::Answer::Found(b"{}".to_vec()));
    read_claude(item, false).unwrap();
    read_claude(item, true).unwrap();
    assert_eq!(fake_backend::waits(item), [SECURITY_TIMEOUT, MANUAL_TIMEOUT]);
}

#[test]
fn an_unanswered_read_backs_off() {
    let slow = "Claude Code-credentials-0000c0c1";
    assert_eq!(read_as(slow, || Err(SecurityError::TimedOut)), Err(ReadError::Latched), "the card says not answered");
    assert!(!marker(slow).unwrap().exists() && !latched(slow), "not latched, not persisted");
    assert_eq!(read_as(slow, || panic!("asked again during the backoff")), Err(ReadError::Latched), "still not answered: no automatic run of Claude Code");
    // Ten minutes later (the backoff has passed), an automatic check asks again.
    gate().backoff.0.insert(slow.to_owned(), (Instant::now() - Duration::from_secs(11 * 60), 1));
    assert_eq!(read_as(slow, || Ok(None)), Ok(None), "asked again once the backoff passes");
    assert_eq!(read_as(slow, || Err(SecurityError::TimedOut)), Err(ReadError::Latched));
    clear_backoff(slow);
    assert_eq!(read_as(slow, || Ok(None)), Ok(None), "and at once after a manual refresh");
}

#[test]
fn an_item_the_reader_cannot_find_is_looked_up_by_service_once() {
    let item = "Claude Code-credentials-0000c0c2";
    let found = read_claude_with(item, true, SECURITY_TIMEOUT, || Ok(None), |_| Ok(Some(Found { secret: b"{}".to_vec() })));
    assert_eq!(found, Ok(Some(b"{}".to_vec())), "saved under another account");
    let gone = "Claude Code-credentials-0000c0c3";
    assert_eq!(read_claude_with(gone, true, SECURITY_TIMEOUT, || Ok(None), |_| Ok(None)), Ok(None));
    assert_eq!(read_claude_with(gone, true, SECURITY_TIMEOUT, || Ok(None), |_| panic!("asked twice")), Ok(None), "exit 44: really missing");
    assert_eq!(read_claude_with(gone, false, SECURITY_TIMEOUT, || Ok(None), |_| panic!("locked")), Ok(None));
}

#[test]
fn a_full_size_item_fits_the_g_output_limit() {
    let big = vec![b'\xe9'; ITEM_LIMIT];
    let hex: String = big.iter().map(|b| format!("{b:02X}")).collect();
    let escaped = "\\351".repeat(ITEM_LIMIT);
    let stderr = format!("password: 0x{hex}  \"{escaped}\"\n");
    assert!(stderr.len() <= SECURITY_OUTPUT_LIMIT, "hex plus the escaped copy fit");
    assert_eq!(security_output(Some(0), false, stderr.into_bytes()), Ok(Some(big)));
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

/// Shows which path reads each real Claude item; prints outcomes only.
#[test]
#[ignore = "Opt-in live Keychain diagnostic; prints result kinds, never secrets"]
fn live_claude_keychain_paths() {
    let services = std::env::var("PANDACODE_SMOKE_KEYCHAIN_SERVICES")
        .unwrap_or_else(|_| "Claude Code-credentials".into());
    for service in services.split(',') {
        let child = match read(service) {
            Ok(Some(_)) => "found".to_owned(),
            Ok(None) => "missing".to_owned(),
            Err(failure) => format!("{failure:?}"),
        };
        let tool = match read_with_security_tool(service, SECURITY_TIMEOUT) {
            Ok(Some(found)) => format!("found ({} bytes)", found.secret.len()),
            Ok(None) => "missing".to_owned(),
            Err(error) => format!("{error:?}"),
        };
        // This ignored test's own process is disposable, so it may
        // disable interaction to learn the exact refusal code.
        let code = {
            use security_framework::os::macos::{
                keychain::SecKeychain, passwords::find_generic_password,
            };
            let _off = SecKeychain::disable_user_interaction();
            match find_generic_password(None, service, &claude_account()) {
                Ok(_) => 0,
                Err(error) => error.code(),
            }
        };
        eprintln!("{service}: child={child} code={code} security={tool} unlocked={}", keychains_unlocked());
    }
}

#[test]
#[ignore = "Internal isolated helper; inert without the explicit parent sentinel"]
fn internal_helper() {
    if std::env::var(CHILD).ok().as_deref() != Some("1") {
        return;
    }
    emit(&std::env::var(TARGET).unwrap_or_default());
}

#[test]
fn a_found_secret_never_shows_in_debug_output() {
    let found = Found { secret: b"top-secret-token".to_vec() };
    let shown = format!("{found:?}");
    assert!(!shown.contains("top-secret") && shown.contains("16 bytes"), "{shown}");
}

#[test]
fn interaction_not_allowed_latches_for_this_launch_only() {
    let item = "Claude Code-credentials-00000036";
    assert_eq!(read_as(item, || Err(SecurityError::NotAllowed)), Err(ReadError::Latched));
    assert!(!marker(item).unwrap().exists(), "no marker: not across launches");
    assert_eq!(read_as(item, || panic!("asked again in this launch")), Err(ReadError::Latched));
    gate().unanswered.remove(item); // a new launch
    assert_eq!(read_as(item, || Ok(Some(b"{}".to_vec()))), Ok(Some(b"{}".to_vec())));
}

#[test]
fn security_reads_under_claude_codes_account_first_then_by_service_alone() {
    let found = || Found { secret: b"{}".to_vec() };
    let mut calls = Vec::new();
    let read = read_in_order("svc", "me", SECURITY_TIMEOUT, |args, _| {
        calls.push(args.join(" "));
        Ok((calls.len() == 2).then(found))
    });
    assert_eq!(read.unwrap().map(|found| found.secret.clone()), Some(b"{}".to_vec()));
    assert_eq!(calls, ["find-generic-password -a me -s svc -g", "find-generic-password -s svc -g"]);
    // Found under the account: one run. Denied: final, never asked twice.
    let mut runs = 0;
    assert!(read_in_order("svc", "me", SECURITY_TIMEOUT, |_, _| { runs += 1; Ok(Some(found())) }).is_ok_and(|found| found.is_some()));
    assert_eq!(runs, 1);
    let mut runs = 0;
    assert_eq!(read_in_order("svc", "me", SECURITY_TIMEOUT, |_, _| { runs += 1; Err(SecurityError::Denied) }), Err(SecurityError::Denied));
    assert_eq!(runs, 1);
}

#[test]
fn attribute_lookups_find_the_item_reads_find_when_two_share_the_service() {
    // Two items for one service: Claude Code's (account "me") and another.
    let items = |args: &[&str]| -> Result<Option<String>, ()> {
        Ok(Some(if args.contains(&"-a") { "me" } else { "someone-else" }.to_owned()))
    };
    assert_eq!(lookup_in_order("svc", "me", items), Ok(Some("me".into())), "the one `-a me -s svc -g` reads");
    let mut calls = Vec::new();
    let only_other = lookup_in_order("svc", "me", |args| {
        calls.push(args.join(" "));
        Ok(args.contains(&"-a").then_some(()).map_or(Some("someone-else".to_owned()), |_| None))
    });
    assert_eq!(only_other, Ok(Some("someone-else".into())));
    assert_eq!(calls, ["find-generic-password -a me -s svc", "find-generic-password -s svc"]);
    assert_eq!(lookup_in_order::<String>("svc", "me", |_| Err(())), Err(()), "a failed lookup is final");
}

#[test]
fn a_helper_read_resets_the_failure_count() {
    let item = "Claude Code-credentials-0000b0ff";
    for _ in 0..3 {
        gate().backoff.record(item, Instant::now() - Duration::from_secs(24 * 3600), true);
    }
    assert_eq!(read_claude_with(item, true, SECURITY_TIMEOUT, || Ok(Some(b"{}".to_vec())), |_| panic!("not needed")), Ok(Some(b"{}".to_vec())));
    assert!(!gate().backoff.0.contains_key(item), "the next failure backs off from the start again");
}

#[test]
fn two_unanswered_reads_in_a_row_latch_across_launches_until_a_refresh() {
    let slow = "Claude Code-credentials-0000c0d7";
    let past_backoff = || gate().backoff.0.insert(slow.to_owned(), (Instant::now() - Duration::from_secs(7 * 60 * 60), 1));
    assert_eq!(read_as(slow, || Err(SecurityError::TimedOut)), Err(ReadError::Latched));
    assert!(!latched(slow), "one unanswered read only backs off");
    past_backoff();
    assert_eq!(read_as(slow, || Err(SecurityError::TimedOut)), Err(ReadError::Latched));
    assert!(latched(slow) && marker(slow).unwrap().exists(), "the second in a row latches like a denial");
    gate().latched.remove(slow); // a new launch: the marker holds
    past_backoff();
    assert_eq!(read_as(slow, || panic!("asked again after a restart")), Err(ReadError::Latched));
    clear_backoff(slow);
    assert!(!marker(slow).unwrap().exists(), "a Refresh removes the marker");
    assert_eq!(read_as(slow, || Ok(None)), Ok(None), "a Refresh lifts it");
    // An answer in between starts the count again.
    assert_eq!(read_as(slow, || Err(SecurityError::TimedOut)), Err(ReadError::Latched));
    clear_backoff(slow);
    assert_eq!(read_as(slow, || Err(SecurityError::TimedOut)), Err(ReadError::Latched));
    assert!(!latched(slow), "the Refresh cleared the first");
}
