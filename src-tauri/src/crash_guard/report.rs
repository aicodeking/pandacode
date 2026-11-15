//! Local crash reports in `<app data>/crash-reports/`: plain text, never sent anywhere.
//! A panic report carries the message, location, thread and backtrace; the guard writes a
//! shorter one with the death cause when there was no panic. No environment or settings.

use std::path::{Path, PathBuf};

pub const REPORTS_DIR: &str = "crash-reports";
/// App crash reports kept (panics and guard-recorded deaths).
pub const MAX_REPORTS: usize = 10;
/// Webview reports kept, counted apart so a flood of them never evicts a crash report.
pub const MAX_WEBVIEW_REPORTS: usize = 5;
/// Reports older than this (by the time in their name) are removed whatever the count.
pub const MAX_REPORT_AGE_MS: u64 = 90 * 24 * 60 * 60 * 1000;
/// A report dated later than now by more than this was named by a clock that was wrong (or
/// by someone else): it is pruned as expired and never shown as the newest.
pub const FUTURE_SLACK_MS: u64 = 24 * 60 * 60 * 1000;
const REPORT_EXTENSION: &str = "txt";

/// What a report is about; the kind ends its file name (`<ms>-<kind>.txt`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Panic,
    Crash,
    Webview,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Panic => "panic",
            Self::Crash => "crash",
            Self::Webview => "webview",
        }
    }

    /// The kind of a file named exactly `<ms>-<kind>.txt` (`<ms>` all digits, a u64), the only
    /// names `write` makes; any other file in `crash-reports/` is not ours and never touched.
    fn of_name(name: &str) -> Option<Self> {
        let (at, kind) = name.strip_suffix(&format!(".{REPORT_EXTENSION}"))?.split_once('-')?;
        if at.is_empty() || !at.bytes().all(|b| b.is_ascii_digit()) || at.parse::<u64>().is_err() {
            return None;
        }
        [Self::Panic, Self::Crash, Self::Webview].into_iter().find(|k| k.name() == kind)
    }

    fn is_crash(self) -> bool {
        self != Self::Webview
    }
}

pub struct Panic<'a> {
    /// The panicking process: a guard adopts only its own app's report (`panic_report_since`).
    pub pid: u32,
    pub message: &'a str,
    pub location: Option<String>,
    pub thread: &'a str,
    pub backtrace: &'a str,
}

fn header(kind: &str, at_ms: u64) -> String {
    format!(
        "PandaCode {kind}\nVersion: {}\nOS: {} {}\nTime: {} (ms since epoch {at_ms})\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        chrono::DateTime::from_timestamp_millis(at_ms as i64).map(|t| t.to_rfc3339()).unwrap_or_default(),
    )
}

/// The header line naming the process that wrote a panic report.
pub fn process_line(pid: u32) -> String {
    format!("Process: {pid}")
}

/// A value for one header line: a control character (CR, LF, …) becomes a space, so a thread
/// name or location cannot end the line and forge another (`Process:`, which `written_by` trusts).
fn header_value(value: &str) -> String {
    value.chars().map(|c| if c.is_ascii_control() { ' ' } else { c }).collect()
}

pub fn panic_text(panic: &Panic, at_ms: u64) -> String {
    format!(
        "{}{}\nThread: {}\nLocation: {}\n\nMessage:\n{}\n\nBacktrace:\n{}\n",
        header("panic", at_ms),
        process_line(panic.pid),
        header_value(panic.thread),
        header_value(panic.location.as_deref().unwrap_or("unknown")),
        panic.message,
        panic.backtrace,
    )
}

pub fn death_text(cause: &str, at_ms: u64) -> String {
    format!("{}\nCause: {cause}\nNo panic was reported; the cause comes from the crash guard.\n", header("crash", at_ms))
}

/// Names tried after the first is taken (the next millisecond each time).
const NAME_TRIES: u64 = 64;

/// Writes one owner-only report and prunes both groups (crash and webview) to their caps
/// and age: an old webview report must not wait for the next webview report. Never replaces
/// a file: when `<at_ms>-<kind>.txt` is taken (two reports in one millisecond), the next
/// millisecond's name is tried, up to `NAME_TRIES` times.
pub fn write(dir: &Path, kind: Kind, at_ms: u64, text: &str) -> std::io::Result<PathBuf> {
    let reports = dir.join(REPORTS_DIR);
    super::files::private_dir(&reports)?;
    let mut tries = (at_ms..at_ms.saturating_add(NAME_TRIES)).map(|at| reports.join(format!("{at}-{}.{REPORT_EXTENSION}", kind.name())));
    let path = loop {
        let Some(path) = tries.next() else { return Err(std::io::ErrorKind::AlreadyExists.into()) };
        match super::files::create_private(&path, text.as_bytes()) {
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            result => break result.map(|()| path)?,
        }
    };
    prune_all(dir, at_ms);
    Ok(path)
}

/// Both groups to their caps and age: whenever a report is written, at startup and about
/// once a day while the process runs (`super::prune_if_due`).
pub fn prune_all(dir: &Path, now: u64) {
    let reports = dir.join(REPORTS_DIR);
    prune(&reports, Kind::is_crash, MAX_REPORTS, now);
    prune(&reports, |kind| !kind.is_crash(), MAX_WEBVIEW_REPORTS, now);
}

/// Whether `reports` is a real directory: a symlinked `crash-reports/` is never read through,
/// as `files::private_dir` never writes through one.
fn is_real_dir(reports: &Path) -> bool {
    std::fs::symlink_metadata(reports).is_ok_and(|meta| meta.is_dir())
}

/// Our report files, newest first (names start with the time, so name order is time order).
/// A symlink is never one: the entry's own type is read, not its target's.
fn list(reports: &Path, keep: impl Fn(Kind) -> bool) -> Vec<PathBuf> {
    if !is_real_dir(reports) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(reports) else { return Vec::new() };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().filter(|e| e.file_type().is_ok_and(|t| t.is_file())))
        .filter(|entry| entry.file_name().to_str().and_then(Kind::of_name).is_some_and(&keep))
        .map(|entry| entry.path())
        .collect();
    files.sort_by_key(|path| std::cmp::Reverse(sort_key(path)));
    files
}

fn sort_key(path: &Path) -> (u64, String) {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let at = name.split('-').next().and_then(|n| n.parse().ok()).unwrap_or(0);
    (at, name)
}

/// The newest crash report (panic or guard-recorded), the one a crash notice refers to.
pub fn newest(dir: &Path) -> Option<PathBuf> {
    newest_at(dir, super::guard::now_ms())
}

/// `newest` at `now`: a report dated in the future (`is_future`) is skipped.
fn newest_at(dir: &Path, now: u64) -> Option<PathBuf> {
    list(&dir.join(REPORTS_DIR), Kind::is_crash).into_iter().find(|path| !is_future(path, now))
}

fn is_future(path: &Path, now: u64) -> bool {
    sort_key(path).0 > now.saturating_add(FUTURE_SLACK_MS)
}

/// The newest panic report process `pid` wrote (`process_line` in its header), when it is
/// dated `since` or later; like `newest`, one dated in the future (`is_future`) is skipped.
/// Desktop and `serve` share `crash-reports/`: another process's panic is never this death's,
/// and a report without the line (an older version's) is never adopted, only pruned.
pub fn panic_report_since(dir: &Path, since: u64, pid: u32) -> Option<PathBuf> {
    panic_report_since_at(dir, since, pid, super::guard::now_ms())
}

fn panic_report_since_at(dir: &Path, since: u64, pid: u32, now: u64) -> Option<PathBuf> {
    list(&dir.join(REPORTS_DIR), |kind| kind == Kind::Panic)
        .into_iter()
        .filter(|path| !is_future(path, now))
        .take_while(|path| sort_key(path).0 >= since)
        .find(|path| written_by(path, pid))
}

/// Whether the report's header (the lines before the first blank one, read from at most its
/// first `HEADER_BYTES`) carries `process_line(pid)`. The message comes after the blank line,
/// so panic text can never fake it.
fn written_by(path: &Path, pid: u32) -> bool {
    const HEADER_BYTES: u64 = 1024;
    let Some(head) = super::files::read_prefix(path, HEADER_BYTES) else { return false };
    let wanted = process_line(pid);
    String::from_utf8_lossy(&head).lines().take_while(|line| !line.is_empty()).any(|line| line == wanted)
}

/// Whether `name` is a crash report's file name (`<ms>-panic.txt`, `<ms>-crash.txt`): a
/// plain name, never a path, so a name read back from a state file cannot point elsewhere.
pub fn is_crash_report_name(name: &str) -> bool {
    Kind::of_name(name).is_some_and(Kind::is_crash)
}

/// The file name of a report `write` returned.
pub fn file_name(path: &Path) -> Option<String> {
    path.file_name()?.to_str().map(str::to_owned).filter(|name| is_crash_report_name(name))
}

/// The report named `name` in `dir`, when the name is valid, not dated in the future
/// (`is_future`, as `newest`) and the file still exists (a regular file, not a symlink).
pub fn named(dir: &Path, name: &str) -> Option<PathBuf> {
    named_at(dir, name, super::guard::now_ms())
}

fn named_at(dir: &Path, name: &str, now: u64) -> Option<PathBuf> {
    let reports = dir.join(REPORTS_DIR);
    let path = reports.join(name);
    let valid = is_crash_report_name(name) && !is_future(&path, now);
    (valid && is_real_dir(&reports) && std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file())).then_some(path)
}

/// Keeps the `keep` newest of `group`, dropping any dated more than `MAX_REPORT_AGE_MS` before
/// `now` or more than `FUTURE_SLACK_MS` after it (such a name would never age out).
fn prune(reports: &Path, group: impl Fn(Kind) -> bool, keep: usize, now: u64) {
    let files = list(reports, group);
    let expired = |path: &PathBuf| now.saturating_sub(sort_key(path).0) > MAX_REPORT_AGE_MS || is_future(path, now);
    for (_, old) in files.iter().enumerate().filter(|(i, path)| *i >= keep || expired(path)) {
        if let Err(error) = std::fs::remove_file(old) {
            // The name only: the guard's log never holds a home-directory path.
            let name = old.file_name().unwrap_or_default().to_string_lossy();
            eprintln!("Could not remove old crash report {name}: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("pandacode-crash-reports-{}", uuid::Uuid::new_v4()))
    }

    #[cfg(unix)]
    #[test]
    fn the_header_check_reads_only_a_regular_file_never_through_a_link() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("1-panic.txt");
        std::fs::write(&real, format!("PandaCode panic\n{}\n\nmessage", process_line(7))).unwrap();
        assert!(written_by(&real, 7) && !written_by(&real, 8));
        let link = dir.join("2-panic.txt");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(!written_by(&link, 7));
        // A FIFO neither blocks the open nor counts.
        let fifo = dir.join("3-panic.txt");
        let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(!written_by(&fifo, 7));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reports_carry_the_essentials_and_no_environment() {
        let text = panic_text(
            &Panic { pid: 7, message: "boom", location: Some("src/x.rs:1:2".into()), thread: "main", backtrace: "0: frame" },
            1_700_000_000_000,
        );
        for part in ["PandaCode panic", "Process: 7", env!("CARGO_PKG_VERSION"), std::env::consts::OS, "Thread: main", "src/x.rs:1:2", "boom", "0: frame"] {
            assert!(text.contains(part), "{part}");
        }
        assert!(!text.contains("PATH"));
        assert!(death_text("Crashed with SIGSEGV", 1).contains("Cause: Crashed with SIGSEGV"));
    }

    #[test]
    fn a_thread_name_or_location_cannot_forge_a_header_line() {
        let dir = temp_dir();
        let panic = Panic { pid: 5, message: "boom", location: Some("x.rs\r\nProcess: 1".into()), thread: "t\nProcess: 1\u{7f}", backtrace: "" };
        let text = panic_text(&panic, 1);
        assert!(text.contains("Thread: t Process: 1 \nLocation: x.rs  Process: 1\n"), "{text}");
        let path = write(&dir, Kind::Panic, 1, &text).unwrap();
        assert!(written_by(&path, 5) && !written_by(&path, 1));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn writing_prunes_to_the_newest_reports() {
        let dir = temp_dir();
        for at in 0..(MAX_REPORTS as u64 + 5) {
            write(&dir, Kind::Panic, 1_000 + at, "x").unwrap();
        }
        std::fs::write(dir.join(REPORTS_DIR).join("notes.md"), "kept").unwrap();
        assert_eq!(list(&dir.join(REPORTS_DIR), Kind::is_crash).len(), MAX_REPORTS);
        assert_eq!(newest(&dir), Some(dir.join(REPORTS_DIR).join(format!("{}-panic.txt", 1_000 + MAX_REPORTS as u64 + 4))));
        assert!(dir.join(REPORTS_DIR).join("notes.md").exists());
        assert!(!dir.join(REPORTS_DIR).join("1000-panic.txt").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reports_older_than_the_age_limit_are_removed_whatever_the_count() {
        let dir = temp_dir();
        let now = MAX_REPORT_AGE_MS + 1_000_000;
        write(&dir, Kind::Crash, now - MAX_REPORT_AGE_MS - 1, "old").unwrap();
        write(&dir, Kind::Webview, 5, "old webview").unwrap();
        write(&dir, Kind::Crash, now - MAX_REPORT_AGE_MS, "at the limit").unwrap();
        write(&dir, Kind::Panic, now, "new").unwrap();
        write(&dir, Kind::Webview, now, "new webview").unwrap();
        let names: Vec<String> = list(&dir.join(REPORTS_DIR), |_| true).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, [format!("{now}-webview.txt"), format!("{now}-panic.txt"), format!("{}-crash.txt", now - MAX_REPORT_AGE_MS)]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn writing_a_report_prunes_the_other_group_too() {
        let dir = temp_dir();
        let now = MAX_REPORT_AGE_MS + 1_000_000;
        let reports = dir.join(REPORTS_DIR);
        std::fs::create_dir_all(&reports).unwrap();
        std::fs::write(reports.join("7-webview.txt"), "old").unwrap();
        write(&dir, Kind::Crash, now, "new").unwrap();
        assert!(!reports.join("7-webview.txt").exists(), "a crash report left an expired webview report");
        std::fs::write(reports.join("8-crash.txt"), "old").unwrap();
        write(&dir, Kind::Webview, now + 1, "new").unwrap();
        assert!(!reports.join("8-crash.txt").exists(), "a webview report left an expired crash report");
        assert_eq!(list(&reports, |_| true).len(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn startup_prunes_old_reports_without_a_new_one() {
        let dir = temp_dir();
        let now = MAX_REPORT_AGE_MS + 1_000_000;
        let reports = dir.join(REPORTS_DIR);
        std::fs::create_dir_all(&reports).unwrap();
        for name in [format!("{}-crash.txt", now - MAX_REPORT_AGE_MS - 1), "7-webview.txt".into(), format!("{now}-panic.txt")] {
            std::fs::write(reports.join(name), "x").unwrap();
        }
        prune_all(&dir, now);
        let names: Vec<String> = list(&reports, |_| true).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, [format!("{now}-panic.txt")]);
        // No reports directory at all is fine.
        prune_all(&temp_dir(), now);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn webview_reports_never_evict_crash_reports_and_are_not_the_newest_crash() {
        let dir = temp_dir();
        write(&dir, Kind::Crash, 10, "crash").unwrap();
        for at in 100..(100 + MAX_REPORTS as u64 * 3) {
            write(&dir, Kind::Webview, at, "webview").unwrap();
        }
        let reports = dir.join(REPORTS_DIR);
        assert_eq!(list(&reports, |k| k == Kind::Webview).len(), MAX_WEBVIEW_REPORTS);
        assert_eq!(newest(&dir), Some(reports.join("10-crash.txt")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(reports.join("10-crash.txt")).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(&reports).unwrap().permissions().mode() & 0o777, 0o700);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_plain_crash_report_names_are_accepted() {
        for good in ["1-panic.txt", "1700000000000-crash.txt"] {
            assert!(is_crash_report_name(good), "{good}");
        }
        for bad in ["", "-panic.txt", "1-webview.txt", "1-panic.md", "../1-panic.txt", "a/1-panic.txt", "/tmp/1-crash.txt", "1x-crash.txt", "1-crash.txt/..", "1-panic-crash.txt"] {
            assert!(!is_crash_report_name(bad), "{bad}");
        }
        let dir = temp_dir();
        let written = write(&dir, Kind::Crash, 42, "x").unwrap();
        assert_eq!(file_name(&written).as_deref(), Some("42-crash.txt"));
        assert_eq!(named(&dir, "42-crash.txt"), Some(written));
        assert_eq!(named(&dir, "43-crash.txt"), None);
        assert_eq!(named(&dir, "../42-crash.txt"), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn files_not_named_like_our_reports_are_never_listed_pruned_or_the_newest() {
        let dir = temp_dir();
        let reports = dir.join(REPORTS_DIR);
        write(&dir, Kind::Crash, 10, "ours").unwrap();
        let foreign = ["my-notes-crash.txt", "notes-panic.txt", "1-2-crash.txt", "+1-crash.txt", "1-crash.TXT", "99999999999999999999999-crash.txt", "1-crash.txt.bak"];
        for name in foreign {
            std::fs::write(reports.join(name), "user file").unwrap();
        }
        assert_eq!(list(&reports, |_| true), [reports.join("10-crash.txt")]);
        assert_eq!(newest(&dir), Some(reports.join("10-crash.txt")));
        prune_all(&dir, 10 + MAX_REPORT_AGE_MS + 1);
        assert!(!reports.join("10-crash.txt").exists(), "ours expired");
        for name in foreign {
            assert!(reports.join(name).exists(), "{name} was pruned");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn two_reports_in_one_millisecond_both_keep_their_text() {
        let dir = temp_dir();
        let first = write(&dir, Kind::Panic, 50, "first").unwrap();
        let second = write(&dir, Kind::Panic, 50, "second").unwrap();
        let third = write(&dir, Kind::Crash, 50, "other kind").unwrap();
        let reports = dir.join(REPORTS_DIR);
        assert_eq!((first.clone(), second.clone(), third), (reports.join("50-panic.txt"), reports.join("51-panic.txt"), reports.join("50-crash.txt")));
        assert_eq!((std::fs::read_to_string(first).unwrap(), std::fs::read_to_string(second).unwrap()), ("first".into(), "second".into()));
        // Every name taken: an error, nothing replaced.
        for at in 100..100 + NAME_TRIES {
            std::fs::write(reports.join(format!("{at}-webview.txt")), "taken").unwrap();
        }
        assert_eq!(write(&dir, Kind::Webview, 100, "x").unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_future_dated_report_is_pruned_and_never_the_newest() {
        let dir = temp_dir();
        let now = MAX_REPORT_AGE_MS + 1_000_000;
        let reports = dir.join(REPORTS_DIR);
        write(&dir, Kind::Crash, now, "real").unwrap();
        let soon = now + FUTURE_SLACK_MS;
        let far = soon + 1;
        for at in [soon, far] {
            std::fs::write(reports.join(format!("{at}-panic.txt")), "x").unwrap();
        }
        // Within the slack (a clock a little off) it is still a report like any other.
        assert_eq!(newest_at(&dir, now), Some(reports.join(format!("{soon}-panic.txt"))));
        std::fs::remove_file(reports.join(format!("{soon}-panic.txt"))).unwrap();
        assert_eq!(newest_at(&dir, now), Some(reports.join(format!("{now}-crash.txt"))));
        prune_all(&dir, now);
        assert!(!reports.join(format!("{far}-panic.txt")).exists(), "a future-dated report never ages out");
        assert!(reports.join(format!("{now}-crash.txt")).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_future_dated_panic_report_is_never_this_deaths() {
        let dir = temp_dir();
        let reports = dir.join(REPORTS_DIR);
        let now = 1_700_000_000_000;
        std::fs::create_dir_all(&reports).unwrap();
        let ours = reports.join(format!("{}-panic.txt", now - 5));
        let (soon, far) = (now + FUTURE_SLACK_MS, now + FUTURE_SLACK_MS + 1);
        for path in [ours.clone(), reports.join(format!("{far}-panic.txt"))] {
            std::fs::write(path, process_line(9)).unwrap();
        }
        assert_eq!(panic_report_since_at(&dir, now - 10, 9, now), Some(ours.clone()), "the future one hid this death's");
        assert_eq!(panic_report_since_at(&dir, now, 9, now), None, "dated before `since`");
        // Within the slack (a clock a little off) it is still a report like any other.
        std::fs::write(reports.join(format!("{soon}-panic.txt")), process_line(9)).unwrap();
        assert_eq!(panic_report_since_at(&dir, now - 10, 9, now), Some(reports.join(format!("{soon}-panic.txt"))));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_the_guarded_process_own_panic_report_is_adopted() {
        let dir = temp_dir();
        let now = 1_700_000_000_000;
        let text = |pid| panic_text(&Panic { pid, message: &process_line(5), location: None, thread: "main", backtrace: "" }, now);
        let ours = write(&dir, Kind::Panic, now - 20, &text(5)).unwrap();
        // A newer one from the other mode (`serve` beside the desktop app) on the shared folder…
        write(&dir, Kind::Panic, now - 10, &text(6)).unwrap();
        // …and one an older version wrote, without the line.
        write(&dir, Kind::Panic, now - 5, "PandaCode panic\n\nMessage:\nx\n").unwrap();
        assert_eq!(panic_report_since_at(&dir, now - 60, 5, now), Some(ours));
        assert_eq!(panic_report_since_at(&dir, now - 60, 7, now), None, "no other process's report");
        // Only the header counts: the message above names pid 5 for every report.
        assert_eq!(panic_report_since_at(&dir, now - 60, 6, now), Some(dir.join(REPORTS_DIR).join(format!("{}-panic.txt", now - 10))));
        assert_eq!(panic_report_since_at(&dir, now - 15, 5, now), None, "dated before `since`");
        // The name rule is unchanged: all three stay prunable.
        prune_all(&dir, now + MAX_REPORT_AGE_MS + 100);
        assert!(list(&dir.join(REPORTS_DIR), |_| true).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_reports_folder_is_never_listed_revealed_or_pruned_through() {
        let dir = temp_dir();
        let outside = temp_dir();
        write(&outside, Kind::Crash, 10, "elsewhere").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(outside.join(REPORTS_DIR), dir.join(REPORTS_DIR)).unwrap();
        assert_eq!(newest(&dir), None);
        assert_eq!(named(&dir, "10-crash.txt"), None);
        assert!(panic_report_since(&dir, 0, 1).is_none());
        prune_all(&dir, 10 + MAX_REPORT_AGE_MS + 1);
        assert!(outside.join(REPORTS_DIR).join("10-crash.txt").exists(), "pruned through the link");
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_report_is_neither_listed_nor_pruned_through() {
        let dir = temp_dir();
        write(&dir, Kind::Crash, 10, "real").unwrap();
        let outside = temp_dir();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("target.txt"), "keep").unwrap();
        let reports = dir.join(REPORTS_DIR);
        std::os::unix::fs::symlink(outside.join("target.txt"), reports.join("99-crash.txt")).unwrap();
        assert_eq!(newest(&dir), Some(reports.join("10-crash.txt")));
        assert!(panic_report_since(&dir, 0, 1).is_none());
        std::os::unix::fs::symlink(outside.join("target.txt"), reports.join("98-panic.txt")).unwrap();
        assert!(panic_report_since(&dir, 0, 1).is_none());
        assert_eq!(named(&dir, "98-panic.txt"), None, "a symlink is never revealed");
        std::fs::remove_dir_all(dir).unwrap();
        assert_eq!(std::fs::read_to_string(outside.join("target.txt")).unwrap(), "keep");
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn a_named_report_dated_far_ahead_is_not_revealed() {
        let dir = temp_dir();
        let now = 1_700_000_000_000;
        // Written directly: `write` prunes against the real clock.
        std::fs::create_dir_all(dir.join(REPORTS_DIR)).unwrap();
        let file = |at: u64| {
            let path = dir.join(REPORTS_DIR).join(format!("{at}-crash.txt"));
            std::fs::write(&path, "x").unwrap();
            path
        };
        let (soon, far) = (file(now + FUTURE_SLACK_MS), file(now + FUTURE_SLACK_MS + 1));
        let name = |path: &PathBuf| path.file_name().unwrap().to_str().unwrap().to_owned();
        assert_eq!(named_at(&dir, &name(&soon), now), Some(soon.clone()), "within the slack");
        assert_eq!(named_at(&dir, &name(&far), now), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

}
