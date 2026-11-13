// Claude Code's Keychain item through Apple's `security` tool, read only
// (PandaCode never writes it). Included into `usage_keychain::mac` so it
// shares its private items. The rule:
//
// - Reads are rare: a check reuses the login it last read from the Keychain
//   (`agent_usage_claude`'s cache) and reads again only when that login is
//   about to expire, the usage service rejects it, the item changed, or the
//   user pressed Refresh.
// - The isolated, no-UI reader goes first. `security` is asked only when the
//   item's access list REFUSED it (Claude Code's item trusts `security`, not
//   PandaCode), or when the reader found no item (Claude Code may have saved
//   it under another account), once per launch, and only while the login
//   Keychain is unlocked. `security` reads as Claude Code does, under its
//   account first, then by service name alone. Other reader failures back
//   off; a locked Keychain is never touched.
// - A `security` read that is denied (exit 51/128) writes a persistent latch:
//   not asked again, in this launch or the next, until a manual Refresh. One
//   refused because no interaction was allowed (exit 36: the Keychain locked
//   during the call, say) latches for this launch only. One not answered in
//   time backs off (10 minutes, doubling) like any failure, so a later check
//   may ask again; a second unanswered read in a row latches it like a
//   denial (across launches, until a Refresh). A slow success is a success.
// - Automatic reads give `security` 5 s; a manual Refresh gives it 20 s.

/// A failed read leaves the item alone for a while, doubling up to six
/// hours; a manual refresh clears it.
const BACKOFF: Duration = Duration::from_secs(10 * 60);
const BACKOFF_MAX: Duration = Duration::from_secs(6 * 60 * 60);
const SECURITY_TIMEOUT: Duration = Duration::from_secs(5);
const MANUAL_TIMEOUT: Duration = Duration::from_secs(20);

/// Per-item failure backoff.
#[derive(Default)]
struct Backoff(HashMap<String, (Instant, u32)>);

impl Backoff {
    fn wait(failures: u32) -> Duration {
        BACKOFF.saturating_mul(1_u32 << failures.saturating_sub(1).min(8)).min(BACKOFF_MAX)
    }

    fn allows(&self, service: &str, now: Instant) -> bool {
        self.0.get(service).is_none_or(|(at, count)| now.saturating_duration_since(*at) >= Self::wait(*count))
    }

    fn record(&mut self, service: &str, now: Instant, failed: bool) {
        if failed {
            let count = self.0.get(service).map_or(0, |(_, count)| *count);
            self.0.insert(service.to_owned(), (now, count.saturating_add(1)));
        } else {
            self.0.remove(service);
        }
    }
}

/// Per-item gate. Held only for map updates, never across a read.
#[derive(Default)]
struct Gate {
    backoff: Backoff,
    /// Items `security` must not be asked about again: denied. Mirrored by a
    /// marker file, so it holds across launches.
    latched: HashSet<String>,
    /// Items refused because no interaction was allowed: this launch only.
    unanswered: HashSet<String>,
    /// Items `security` confirmed missing this launch (exit 44).
    missing: HashSet<String>,
    /// Items whose last `security` read was not answered in time: a second
    /// in a row latches them for this launch (`unanswered`).
    timed_out: HashSet<String>,
}

fn gate() -> std::sync::MutexGuard<'static, Gate> {
    static GATE: OnceLock<Mutex<Gate>> = OnceLock::new();
    GATE.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner)
}

/// Where latch markers live: one empty 0600 file per item, named by a hash
/// of its service name (no secrets, no account).
fn latch_dir() -> Option<std::path::PathBuf> {
    #[cfg(test)]
    {
        static DIR: OnceLock<std::path::PathBuf> = OnceLock::new();
        Some(DIR.get_or_init(|| std::env::temp_dir().join(format!("pandacode-keychain-denied-{}", uuid::Uuid::new_v4()))).clone())
    }
    #[cfg(not(test))]
    crate::secret_store::dir().map(|dir| dir.join("claude-keychain-denied"))
}

fn marker(service: &str) -> Option<std::path::PathBuf> {
    use sha2::{Digest, Sha256};
    let hash = format!("{:x}", Sha256::digest(service));
    latch_dir().map(|dir| dir.join(&hash[..16]))
}

/// Whether the item is latched, this launch or an earlier one.
fn latched(service: &str) -> bool {
    if gate().latched.contains(service) || gate().unanswered.contains(service) {
        return true;
    }
    let persisted = marker(service).is_some_and(|path| path.exists());
    if persisted {
        gate().latched.insert(service.to_owned());
    }
    persisted
}

fn latch(gate: &mut Gate, service: &str) {
    gate.latched.insert(service.to_owned());
    let Some(path) = marker(service) else { return };
    let made = path.parent().map(std::fs::create_dir_all).transpose().and_then(|_| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true);
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(&path).map(drop)
    });
    if let Err(error) = made {
        eprintln!("Could not remember a Keychain item macOS did not let PandaCode read: {error}");
    }
}

/// Why a Claude item could not be read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReadError {
    /// The login Keychain is locked; nothing was asked, to avoid a dialog.
    Locked,
    /// `security` was denied or not answered (latched, or backing off): the
    /// card asks for a manual Refresh.
    Latched,
    Failed,
}

/// Claude Code's Keychain account rule (`$USER` when plain, else a fixed
/// fallback), used by the isolated reader's lookup and `security`'s first read.
fn claude_account() -> String {
    let plain = |name: &str| !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    std::env::var("USER")
        .ok()
        .filter(|name| !name.is_empty())
        .or_else(account_name)
        .filter(|name| plain(name))
        .unwrap_or_else(|| "claude-code-user".into())
}

/// Why a `security` read failed.
#[derive(Clone, Debug, PartialEq)]
enum SecurityError {
    /// Denied (exit 51/128): a persistent latch.
    Denied,
    /// No user interaction allowed (exit 36, e.g. the Keychain locked during
    /// the call): latched for this launch only.
    NotAllowed,
    /// Killed at its deadline (a dialog may have been open): backs off.
    TimedOut,
    /// Could not start, truncated, any other exit: back off.
    Other,
}

/// What `security` read: the secret.
#[derive(PartialEq)]
struct Found {
    secret: Vec<u8>,
}

/// Never prints the secret, only its size.
impl std::fmt::Debug for Found {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Found").field("secret", &format_args!("<{} bytes>", self.secret.len())).finish()
    }
}

impl Drop for Found {
    fn drop(&mut self) {
        self.secret.fill(0);
    }
}

/// Runs `security` for one item, one at a time so dialogs cannot stack.
fn with_security(
    service: &str,
    timeout: Duration,
    run: impl FnOnce(Duration) -> Result<Option<Found>, SecurityError>,
) -> Result<Option<Vec<u8>>, ReadError> {
    static SERIAL: Mutex<()> = Mutex::new(());
    let _serial = SERIAL.lock().unwrap_or_else(PoisonError::into_inner);
    if latched(service) || !gate().backoff.allows(service, Instant::now()) {
        return Err(if latched(service) { ReadError::Latched } else { held_back(service) });
    }
    let result = run(timeout);
    let mut gate = gate();
    // A denial latches; one not answered in time backs off (10 minutes
    // doubling), and a second in a row latches for this launch.
    let timed_out = matches!(result, Err(SecurityError::TimedOut));
    let again = timed_out && gate.timed_out.contains(service);
    let latching = again || matches!(result, Err(SecurityError::Denied | SecurityError::NotAllowed));
    gate.backoff.record(service, Instant::now(), result.is_err() && !latching);
    if timed_out && !again {
        gate.timed_out.insert(service.to_owned());
    } else {
        gate.timed_out.remove(service);
    }
    answer(&mut gate, service, result, again)
}

/// What `security`'s `result` gives the reader, noting a missing item, a
/// latch, or a dialog not answered (`again`: the second in a row).
fn answer(gate: &mut Gate, service: &str, result: Result<Option<Found>, SecurityError>, again: bool) -> Result<Option<Vec<u8>>, ReadError> {
    match result {
        Ok(Some(mut found)) => {
            gate.missing.remove(service);
            Ok(Some(std::mem::take(&mut found.secret)))
        }
        Ok(None) => {
            gate.missing.insert(service.to_owned());
            Ok(None)
        }
        Err(SecurityError::Denied) => {
            latch(gate, service);
            Err(ReadError::Latched)
        }
        Err(SecurityError::NotAllowed) => {
            gate.unanswered.insert(service.to_owned());
            Err(ReadError::Latched)
        }
        // Two dialogs in a row nobody answered: latched like a denial, across
        // launches, until a Refresh.
        Err(SecurityError::TimedOut) if again => {
            latch(gate, service);
            Err(ReadError::Latched)
        }
        // Not answered: backing off (recorded above); the card says so the
        // same way ("denied or not answered", press Refresh).
        Err(SecurityError::TimedOut) => Err(ReadError::Latched),
        Err(SecurityError::Other) => Err(ReadError::Failed),
    }
}

/// Reads Claude Code's item: the isolated reader, then `security` only when
/// the reader was refused by the item's access list and the Keychain is
/// unlocked. `manual` (a Refresh the user pressed) gives `security` time to
/// be answered.
pub(crate) fn read_claude(service: &str, manual: bool) -> Result<Option<Vec<u8>>, ReadError> {
    #[cfg(test)]
    if let Some(result) = fake_backend::read(service, manual) {
        return result;
    }
    let timeout = if manual { MANUAL_TIMEOUT } else { SECURITY_TIMEOUT };
    read_claude_with(service, keychains_unlocked(), timeout, || read(service), |wait| read_with_security_tool(service, wait))
}

fn read_claude_with(
    service: &str,
    unlocked: bool,
    timeout: Duration,
    child: impl FnOnce() -> Result<Option<Vec<u8>>, Failure>,
    security: impl FnOnce(Duration) -> Result<Option<Found>, SecurityError>,
) -> Result<Option<Vec<u8>>, ReadError> {
    if !valid_target(service) || service == "glm" {
        return Err(ReadError::Failed);
    }
    if latched(service) {
        return Err(ReadError::Latched);
    }
    if !gate().backoff.allows(service, Instant::now()) {
        return Err(held_back(service));
    }
    match child() {
        // Read without a prompt: earlier failures no longer count.
        Ok(Some(found)) => {
            let mut gate = gate();
            gate.backoff.record(service, Instant::now(), false);
            gate.timed_out.remove(service);
            Ok(Some(found))
        }
        // Not found under Claude Code's usual account: `security -s` looks it
        // up by service name alone, once per launch.
        Ok(None) if unlocked && !gate().missing.contains(service) => with_security(service, timeout, security),
        Ok(None) => {
            gate().backoff.record(service, Instant::now(), false);
            Ok(None)
        }
        Err(_) if !unlocked => Err(ReadError::Locked),
        Err(Failure::Refused) => with_security(service, timeout, security),
        Err(Failure::Other) => {
            gate().backoff.record(service, Instant::now(), true);
            Err(ReadError::Failed)
        }
    }
}

/// Why a read backing off was not tried: after a dialog nobody answered it
/// stays "denied or not answered" (`Latched`), so no automatic check runs
/// Claude Code, which could show that dialog again unprompted, until a
/// Refresh; after any other failure, `Failed`.
fn held_back(service: &str) -> ReadError {
    if gate().timed_out.contains(service) { ReadError::Latched } else { ReadError::Failed }
}

/// A manual refresh: the backoff and the latch (memory and marker) are
/// lifted, so the item is asked about once more. Quick: never held across a read.
pub(crate) fn clear_backoff(service: &str) {
    {
        let mut gate = gate();
        gate.backoff.0.remove(service);
        gate.latched.remove(service);
        gate.unanswered.remove(service);
        gate.missing.remove(service);
        gate.timed_out.remove(service);
    }
    if let Some(path) = marker(service) {
        let _ = std::fs::remove_file(path);
    }
}

/// The item's modification date (`mdat`), by an attribute-only lookup in the
/// order reads use; `Ok(None)` when the item is gone.
fn item_modified(service: &str) -> Result<Option<Option<String>>, ()> {
    lookup_in_order(service, &claude_account(), |args| {
        let mut command = Command::new("/usr/bin/security");
        command.args(args);
        let output = crate::workspace::run_process(command, "Usage credential lookup", LIMIT, SECURITY_TIMEOUT).map_err(|_| ())?;
        match output.status.code() {
            Some(44) => Ok(None),
            Some(0) => Ok(Some(modified_attribute(&String::from_utf8_lossy(&output.stdout.bytes)))),
            _ => Err(()),
        }
    })
}

/// Attribute lookups in the order reads use (`read_in_order`): under Claude
/// Code's account first, then by service name alone, so the item looked at
/// is the one a read finds even when two items share the service.
fn lookup_in_order<T>(
    service: &str,
    account: &str,
    mut run: impl FnMut(&[&str]) -> Result<Option<T>, ()>,
) -> Result<Option<T>, ()> {
    if let Some(found) = run(&["find-generic-password", "-a", account, "-s", service])? {
        return Ok(Some(found));
    }
    run(&["find-generic-password", "-s", service])
}

/// `    "mdat"<timedate>=0x…  "20261110040000Z\000"`: when the item last changed.
fn modified_attribute(listing: &str) -> Option<String> {
    let line = listing.lines().find(|line| line.trim_start().starts_with("\"mdat\"<timedate>="))?;
    Some(line.trim().trim_start_matches("\"mdat\"<timedate>=").to_owned())
}

/// When Claude Code's item last changed, by an attribute-only lookup (no
/// secret, no prompt): `Some(Some(date))`, `Some(None)` when it is gone,
/// `None` when it cannot be told. A new sign-in or a refresh changes it.
pub(crate) fn claude_item_stamp(service: &str) -> Option<Option<String>> {
    #[cfg(test)]
    if let Some(stamp) = fake_backend::stamp(service) {
        return stamp;
    }
    if !valid_target(service) || !keychains_unlocked() {
        return None;
    }
    item_modified(service).ok().map(|item| item.map(Option::unwrap_or_default))
}

/// Whether the login Keychain holding Claude Code's item is unlocked now.
pub(crate) fn keychain_unlocked(service: &str) -> bool {
    #[cfg(test)]
    if let Some(locked) = fake_backend::locked(service) {
        return !locked;
    }
    let _ = service;
    keychains_unlocked()
}

/// `security`'s exit status when no user interaction was allowed.
const INTERACTION_NOT_ALLOWED: i32 = 36;

/// `security find-generic-password -g`, as Claude Code reads its item: under
/// its account (`-a <claude_account()> -s <service>`) first, then, if that
/// finds nothing (Claude Code may have saved it under another account), by
/// the service name alone (unique per config folder). Both runs share
/// `timeout`; a failure of the first (denied, not answered) is final.
fn read_with_security_tool(service: &str, timeout: Duration) -> Result<Option<Found>, SecurityError> {
    let account = claude_account();
    read_in_order(service, &account, timeout, run_security_read)
}

fn read_in_order(
    service: &str,
    account: &str,
    timeout: Duration,
    mut run: impl FnMut(&[&str], Duration) -> Result<Option<Found>, SecurityError>,
) -> Result<Option<Found>, SecurityError> {
    let started = Instant::now();
    if let Some(found) = run(&["find-generic-password", "-a", account, "-s", service, "-g"], timeout)? {
        return Ok(Some(found));
    }
    let left = timeout.saturating_sub(started.elapsed());
    if left.is_zero() {
        return Err(SecurityError::TimedOut);
    }
    run(&["find-generic-password", "-s", service, "-g"], left)
}

/// One `security` read, its attributes on stdout and the secret on stderr. A
/// run killed at its deadline may have had a dialog open: that counts as not
/// answered.
fn run_security_read(args: &[&str], timeout: Duration) -> Result<Option<Found>, SecurityError> {
    let mut command = Command::new("/usr/bin/security");
    command.args(args);
    let started = Instant::now();
    let mut output = crate::workspace::run_process_with_input(command, "Usage credential reader", SECURITY_OUTPUT_LIMIT, timeout, None)
        .map_err(|_| run_error(started, timeout))?;
    let code = output.status.code();
    let truncated = output.stdout.truncated || output.stderr.truncated;
    output.stdout.bytes.fill(0);
    let secret = security_output(code, truncated, std::mem::take(&mut output.stderr.bytes))?;
    Ok(secret.map(|secret| Found { secret }))
}

/// A `security` run that did not finish: killed at its deadline means not
/// answered (a dialog may have been open); else it never ran.
fn run_error(started: Instant, timeout: Duration) -> SecurityError {
    if started.elapsed() >= timeout { SecurityError::TimedOut } else { SecurityError::Other }
}

/// The secret from `-g`'s stderr. `security` prints a secret of printable
/// ASCII, quotes included (a JSON login with only ASCII characters), as
/// `password: "<text>"` with the text as is, and any other (non-ASCII bytes
/// or control characters) as `password: 0x<hex>  "<escaped copy>"`; the hex
/// is decoded and the copy ignored. The quoted form ends at the last quote.
fn security_output(code: Option<i32>, truncated: bool, mut stderr: Vec<u8>) -> Result<Option<Vec<u8>>, SecurityError> {
    if truncated || code != Some(0) {
        stderr.fill(0);
        return match code {
            _ if truncated => Err(SecurityError::Other),
            Some(44) => Ok(None),
            Some(INTERACTION_NOT_ALLOWED) => Err(SecurityError::NotAllowed),
            Some(code) if DENIALS.contains(&code) => Err(SecurityError::Denied),
            _ => Err(SecurityError::Other),
        };
    }
    let secret = password_line(&stderr);
    stderr.fill(0);
    secret.map(Some).ok_or(SecurityError::Other)
}

fn password_line(stderr: &[u8]) -> Option<Vec<u8>> {
    let start = stderr.windows(10).position(|w| w == b"password: ")? + 10;
    let rest = &stderr[start..];
    if let Some(hex) = rest.strip_prefix(b"0x") {
        let mut digits: Vec<u8> = hex.iter().copied().take_while(u8::is_ascii_hexdigit).collect();
        let digit = |b: u8| (b as char).to_digit(16).unwrap_or(0) as u8;
        let secret = digits.len().is_multiple_of(2).then(|| digits.chunks(2).map(|p| digit(p[0]) << 4 | digit(p[1])).collect());
        // The hex copy is the secret too.
        digits.fill(0);
        return secret;
    }
    let quoted = rest.strip_prefix(b"\"")?;
    let end = quoted.iter().rposition(|b| *b == b'"')?;
    Some(quoted[..end].to_vec()).filter(|secret| !secret.is_empty())
}

/// A scripted Keychain for tests: `read_claude` and the store above it run
/// their real logic; the isolated reader is refused (as for Claude Code's
/// item) and `security` answers as scripted.
#[cfg(test)]
pub(crate) mod fake_backend {
    use super::*;

    /// What `security` answers for a scripted item.
    #[derive(Clone)]
    pub(crate) enum Answer {
        Found(Vec<u8>),
        /// Denied.
        Denied,
        /// A dialog nobody answered before the timeout.
        Unanswered,
        /// No item (exit 44): an attribute lookup finds none either.
        Gone,
        /// The login Keychain is locked: nothing is asked.
        Locked,
    }

    struct Item {
        answer: Answer,
        /// The `security` timeouts each read was given.
        waits: Vec<Duration>,
        lookups: usize,
        /// Bumped by every `install`, like the item's modification date.
        version: u32,
    }

    static ITEMS: Mutex<Option<HashMap<String, Item>>> = Mutex::new(None);

    pub(crate) fn install(service: &str, answer: Answer) {
        let mut items = ITEMS.lock().unwrap();
        let items = items.get_or_insert_with(HashMap::new);
        let version = items.get(service).map_or(0, |item| item.version + 1);
        items.insert(service.to_owned(), Item { answer, waits: Vec::new(), lookups: 0, version });
    }

    pub(crate) fn waits(service: &str) -> Vec<Duration> {
        ITEMS.lock().unwrap().as_ref().and_then(|items| items.get(service)).map(|item| item.waits.clone()).unwrap_or_default()
    }

    /// What `claude_item_stamp` gives for a scripted item: its
    /// "modification date", `Some(None)` when gone, `None` (can't tell) when
    /// the Keychain is locked.
    pub(crate) fn stamp(service: &str) -> Option<Option<Option<String>>> {
        let mut items = ITEMS.lock().unwrap();
        let item = items.as_mut()?.get_mut(service)?;
        item.lookups += 1;
        Some(match item.answer {
            Answer::Locked => None,
            Answer::Gone => Some(None),
            _ => Some(Some(format!("v{}", item.version))),
        })
    }

    /// Whether a scripted item's Keychain is locked (`None`: not scripted).
    pub(crate) fn locked(service: &str) -> Option<bool> {
        Some(matches!(ITEMS.lock().unwrap().as_ref()?.get(service)?.answer, Answer::Locked))
    }

    pub(crate) fn lookups(service: &str) -> usize {
        ITEMS.lock().unwrap().as_ref().and_then(|items| items.get(service)).map_or(0, |item| item.lookups)
    }

    pub(super) fn read(service: &str, manual: bool) -> Option<Result<Option<Vec<u8>>, ReadError>> {
        let answer = ITEMS.lock().unwrap().as_ref()?.get(service)?.answer.clone();
        let timeout = if manual { MANUAL_TIMEOUT } else { SECURITY_TIMEOUT };
        let unlocked = !matches!(answer, Answer::Locked);
        Some(read_claude_with(service, unlocked, timeout, || Err(Failure::Refused), |wait| {
            if let Some(item) = ITEMS.lock().unwrap().as_mut().and_then(|items| items.get_mut(service)) {
                item.waits.push(wait);
            }
            match answer {
                Answer::Found(secret) => Ok(Some(Found { secret })),
                Answer::Denied => Err(SecurityError::Denied),
                Answer::Unanswered => Err(SecurityError::TimedOut),
                Answer::Gone | Answer::Locked => Ok(None),
            }
        }))
    }
}
