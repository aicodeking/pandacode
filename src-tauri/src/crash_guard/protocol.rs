//! The app → guard pipe: one ASCII line per message. The guard folds the lines into a
//! `Watch`, stamping each with its arrival time; pipe EOF means the app is gone.
//!
//! Lines: `arm`, `disarm` (the restart setting), `exit` (a deliberate exit follows: the guard
//! leaves at once), `term <signo>` (SIGTERM/SIGINT/SIGHUP/SIGQUIT: a death soon after is
//! deliberate, but the guard keeps watching), `signal <signo>` (a fatal signal),
//! `panic <summary>`, `report` (a panic report was written), `child <pid> <start>` /
//! `unchild <pid>` (agent process groups, with the leader's start time, to stop if the app
//! dies abruptly), `reset` (forget every agent group: the app resends its whole set after a
//! `child`/`unchild` line was dropped), `focus` / `blur` (a PandaCode window gained or lost
//! focus: the relaunch comes to the front only if the app was), `interrupted` (opening the
//! database marked running agents Interrupted while an unshown notice is held, or that notice
//! said so: a crash before it is shown says agents were stopped; `shown` clears it), `held <crashed_at> <flags> <report|-> [cause]` (the desktop app
//! took this crash notice at setup and holds it for its page; `flags` is four 0/1 digits:
//! has_report, restarts_paused, restarted, agents_interrupted), `shown` (no notice is held
//! unshown any more, and `interrupted` no longer applies) and `ping` (link check; ignored).

use super::state::Pending;
use std::collections::BTreeMap;

/// Longest summary in bytes (plus an ellipsis): every line stays under PIPE_BUF (512 on
/// macOS), so a write is atomic (never interleaved, never cut short on the non-blocking pipe).
pub const SUMMARY_LIMIT: usize = 240;

/// Agent groups the guard tracks at most: far more than PandaCode runs, few enough that a
/// process that inherited the pipe's write end cannot exhaust the guard's memory with `child`
/// lines. Beyond it new groups are ignored (and so not stopped after a crash).
pub const MAX_CHILDREN: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    Arm,
    Disarm,
    Exit,
    Term(i32),
    Signal(i32),
    Panic(String),
    Report,
    /// Process group leader pid and its start time (0: unknown, never stopped).
    Child(u32, u64),
    Unchild(u32),
    /// Forget all agent groups; the app's current `child` lines follow.
    Reset,
    /// A PandaCode window gained (true) or lost (false) focus.
    Focus(bool),
    /// Agents were stopped by this or an earlier crash whose notice is not shown yet.
    Interrupted,
    /// The crash notice the app holds unshown, for the guard to put back if the app is killed.
    Held(Pending),
    /// The app holds no unshown notice (its page showed it).
    Shown,
    Ping,
}

impl Message {
    pub fn encode(&self) -> String {
        match self {
            Self::Arm => "arm\n".into(),
            Self::Disarm => "disarm\n".into(),
            Self::Exit => "exit\n".into(),
            Self::Term(signal) => format!("term {signal}\n"),
            Self::Signal(signal) => format!("signal {signal}\n"),
            Self::Panic(summary) => format!("panic {}\n", one_line(summary)),
            Self::Report => "report\n".into(),
            Self::Child(pid, start) => format!("child {pid} {start}\n"),
            Self::Unchild(pid) => format!("unchild {pid}\n"),
            Self::Reset => "reset\n".into(),
            Self::Focus(true) => "focus\n".into(),
            Self::Focus(false) => "blur\n".into(),
            Self::Interrupted => "interrupted\n".into(),
            Self::Held(pending) => encode_held(pending),
            Self::Shown => "shown\n".into(),
            Self::Ping => "ping\n".into(),
        }
    }

    /// None for a malformed or unknown line (a write cut short by the crash).
    pub fn parse(line: &str) -> Option<Self> {
        let line = line.trim_end_matches(['\r', '\n']);
        let (word, rest) = line.split_once(' ').unwrap_or((line, ""));
        Some(match (word, rest) {
            ("arm", "") => Self::Arm,
            ("disarm", "") => Self::Disarm,
            ("exit", "") => Self::Exit,
            ("report", "") => Self::Report,
            ("ping", "") => Self::Ping,
            ("interrupted", "") => Self::Interrupted,
            ("shown", "") => Self::Shown,
            ("held", rest) => Self::Held(parse_held(rest)?),
            ("reset", "") => Self::Reset,
            ("focus", "") => Self::Focus(true),
            ("blur", "") => Self::Focus(false),
            ("term", n) => Self::Term(n.parse().ok()?),
            // The app never sends a stop request as `signal` (it is `term`): never a crash.
            ("signal", n) => Self::Signal(n.parse().ok().filter(|signal| !super::policy::TERMINATION_SIGNALS.contains(signal))?),
            ("child", rest) => {
                let (pid, start) = rest.split_once(' ')?;
                Self::Child(group_pid(pid)?, start.parse().ok()?)
            }
            ("unchild", pid) => Self::Unchild(group_pid(pid)?),
            ("panic", summary) => Self::Panic(one_line(summary)),
            _ => return None,
        })
    }
}

/// `held …`: only closed-set values (a crash report file name, a `policy::public_cause`), so
/// the line stays far under PIPE_BUF and the guard never stores text it did not make.
fn encode_held(pending: &Pending) -> String {
    let bit = |on: bool| if on { '1' } else { '0' };
    let flags: String = [pending.has_report, pending.restarts_paused, pending.restarted, pending.agents_interrupted].into_iter().map(bit).collect();
    let report = pending.report.as_deref().filter(|name| super::report::is_crash_report_name(name)).unwrap_or("-");
    let cause = pending.summary.as_deref().and_then(super::policy::public_cause).unwrap_or_default();
    format!("held {} {flags} {report} {cause}\n", pending.crashed_at)
}

fn parse_held(rest: &str) -> Option<Pending> {
    let mut parts = rest.splitn(4, ' ');
    let crashed_at = parts.next()?.parse().ok()?;
    let flags = parts.next()?.as_bytes();
    if flags.len() != 4 || !flags.iter().all(|b| matches!(b, b'0' | b'1')) {
        return None;
    }
    let report = Some(parts.next()?).filter(|name| super::report::is_crash_report_name(name)).map(str::to_owned);
    let summary = parts.next().and_then(super::policy::public_cause);
    let on = |i: usize| flags[i] == b'1';
    Some(Pending { crashed_at, summary, has_report: on(0), restarts_paused: on(1), restarted: on(2), report, relaunching: false, agents_interrupted: on(3), not_restarted: None })
}

/// A pid that is safe to signal as a group: 2..=i32::MAX (as i32 it stays positive, never
/// 0 or 1, so `kill(-pid)` can never mean "my group" or "every process").
pub fn group_pid(text: &str) -> Option<u32> {
    text.parse::<u32>().ok().filter(|pid| *pid > 1 && *pid <= i32::MAX as u32)
}

/// Collapses whitespace runs (newlines included) and truncates on a char boundary.
pub fn one_line(text: &str) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.len() <= SUMMARY_LIMIT {
        return joined;
    }
    let end = (0..=SUMMARY_LIMIT).rev().find(|i| joined.is_char_boundary(*i)).unwrap_or(0);
    format!("{}…", &joined[..end])
}

/// Everything the guard knows about the app when its pipe closes. Times are ms since epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Watch {
    /// The live restart setting (`arm`/`disarm`), starting from the spawn args.
    pub armed: bool,
    pub exiting: bool,
    pub terminated_at: Option<u64>,
    pub signal: Option<i32>,
    pub panic: Option<String>,
    /// When the first fatal marker (panic or signal) arrived.
    pub fatal_at: Option<u64>,
    pub report: bool,
    pub children: BTreeMap<u32, u64>,
    /// Whether a PandaCode window had focus at the last `focus`/`blur`; None: never told.
    pub focused: Option<bool>,
    /// An `interrupted` line arrived since the last `shown`: agents stopped by the crash whose
    /// notice the app holds unshown.
    pub agents_interrupted: bool,
    /// The notice the app took at setup and its page has not shown (`held`, until `shown`).
    pub held: Option<Pending>,
}

impl Watch {
    pub fn new(armed: bool) -> Self {
        Self { armed, exiting: false, terminated_at: None, signal: None, panic: None, fatal_at: None, report: false, children: BTreeMap::new(), focused: None, agents_interrupted: false, held: None }
    }

    /// The state after one message at `now`; the first fatal cause wins (an abort after a panic stays a panic).
    pub fn apply(self, message: Message, now: u64) -> Self {
        let mut next = self;
        match message {
            Message::Arm => next.armed = true,
            Message::Disarm => next.armed = false,
            Message::Exit => next.exiting = true,
            Message::Term(_) => next.terminated_at = Some(now),
            Message::Signal(signal) => {
                next.signal = next.signal.or(Some(signal));
                next.fatal_at = next.fatal_at.or(Some(now));
            }
            Message::Panic(summary) => {
                next.panic = next.panic.or(Some(summary));
                next.fatal_at = next.fatal_at.or(Some(now));
            }
            Message::Report => next.report = true,
            Message::Child(pid, start) => {
                if next.children.len() < MAX_CHILDREN || next.children.contains_key(&pid) {
                    next.children.insert(pid, start);
                }
            }
            Message::Unchild(pid) => {
                next.children.remove(&pid);
            }
            Message::Reset => next.children.clear(),
            Message::Focus(focused) => next.focused = Some(focused),
            Message::Interrupted => next.agents_interrupted = true,
            Message::Held(pending) => next.held = Some(pending),
            // `interrupted` belongs to the held notice: once shown, a later crash must not repeat it.
            Message::Shown => {
                next.held = None;
                next.agents_interrupted = false;
            }
            Message::Ping => {}
        }
        next
    }

    pub fn apply_line(self, line: &str, now: u64) -> Self {
        match Message::parse(line) {
            Some(message) => self.apply(message, now),
            None => self,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fold(lines: &[&str]) -> Watch {
        lines.iter().fold(Watch::new(false), |w, l| w.apply_line(l, 7))
    }

    #[test]
    fn every_message_round_trips() {
        for message in [
            Message::Arm,
            Message::Disarm,
            Message::Exit,
            Message::Term(15),
            Message::Signal(11),
            Message::Panic("index out of bounds".into()),
            Message::Report,
            Message::Child(4242, 99),
            Message::Unchild(4242),
            Message::Reset,
            Message::Focus(true),
            Message::Focus(false),
            Message::Interrupted,
            Message::Held(held()),
            Message::Held(Pending { summary: None, report: None, has_report: false, restarted: false, ..held() }),
            Message::Shown,
            Message::Ping,
        ] {
            assert_eq!(Message::parse(&message.encode()), Some(message));
        }
    }

    fn held() -> Pending {
        Pending { crashed_at: 1_700_000_000_000, summary: Some("Crashed with SIGSEGV".into()), has_report: true, restarts_paused: false, restarted: true, report: Some("1700000000000-crash.txt".into()), relaunching: false, agents_interrupted: true, not_restarted: None }
    }

    #[test]
    fn a_held_line_carries_only_closed_set_values_and_stays_short() {
        let raw = Pending { summary: Some(format!("Panic: {}", "secret ".repeat(200))), report: Some("../../etc/passwd".into()), ..held() };
        let line = Message::Held(raw).encode();
        assert!(line.len() < 128 && !line.contains("secret") && !line.contains("passwd"), "{line}");
        assert_eq!(Message::parse(&line), Some(Message::Held(Pending { summary: Some("Panic".into()), report: None, ..held() })));
        assert!(fold(&["held 5 1000 - Panic", "shown"]).held.is_none());
        assert_eq!(fold(&["shown", "held 5 1000 -"]).held.map(|p| p.crashed_at), Some(5));
    }

    #[test]
    fn malformed_and_cut_lines_are_ignored() {
        for line in ["", "sig", "signal", "signal x", "child -1 0", "child 5", "arm now", "bogus 1", "held", "held 5", "held 5 10", "held 5 1012 -", "held x 1000 -", "shown now"] {
            assert_eq!(Message::parse(line), None, "{line:?}");
        }
        let watch = Watch::new(true).apply_line("signa", 1).apply_line("exit", 1);
        assert!(watch.exiting && watch.signal.is_none());
    }

    #[test]
    fn a_stop_signal_is_never_a_fatal_marker_or_a_held_cause() {
        // The app sends these as `term N`; as `signal N` they are not its lines.
        for line in ["signal 1", "signal 2", "signal 3", "signal 9", "signal 15"] {
            assert_eq!(Message::parse(line), None, "{line}");
        }
        let watch = fold(&["signal 9", "signal 11"]);
        assert_eq!(watch.signal, Some(11), "a dropped `signal 9` must not hide the real fault");
        assert_eq!(super::super::policy::classify(&fold(&["signal 9"]), super::super::policy::ExitStatus::Unknown, 0), super::super::policy::Death::Killed(None));
        for cause in ["Crashed with SIGKILL", "Crashed with SIGTERM"] {
            let line = format!("held 5 1000 - {cause}");
            assert_eq!(Message::parse(&line), Some(Message::Held(Pending { crashed_at: 5, summary: None, has_report: true, restarts_paused: false, restarted: false, report: None, relaunching: false, agents_interrupted: false, not_restarted: None })), "{line}");
        }
    }

    #[test]
    fn pids_that_could_signal_everything_are_rejected() {
        for pid in ["0", "1", "2147483648", "4294967295", "-5"] {
            assert_eq!(group_pid(pid), None, "{pid}");
            assert_eq!(Message::parse(&format!("child {pid} 1")), None);
            assert_eq!(Message::parse(&format!("unchild {pid}")), None);
        }
        assert_eq!(group_pid("2"), Some(2));
        assert_eq!(group_pid("2147483647"), Some(i32::MAX as u32));
    }

    #[test]
    fn panic_summaries_stay_one_short_line() {
        let encoded = Message::Panic("first\nsecond\t third".into()).encode();
        assert_eq!(encoded, "panic first second third\n");
        let long = one_line(&"é".repeat(SUMMARY_LIMIT));
        assert_eq!(long.chars().count(), SUMMARY_LIMIT / 2 + 1);
        assert!(long.ends_with('…'));
        assert!(Message::Panic("é".repeat(10_000)).encode().len() < 512);
        assert_eq!(one_line(&"a".repeat(SUMMARY_LIMIT)).len(), SUMMARY_LIMIT);
    }

    #[test]
    fn folding_tracks_setting_causes_times_and_children() {
        let watch = fold(&["disarm", "child 7 1", "child 8 2", "unchild 7", "arm", "panic boom", "signal 6", "report", "ping"]);
        assert!(watch.armed && !watch.exiting && watch.report);
        assert_eq!((watch.panic.as_deref(), watch.signal, watch.fatal_at), (Some("boom"), Some(6), Some(7)));
        assert_eq!(watch.children.into_iter().collect::<Vec<_>>(), [(8, 2)]);
        let reset = fold(&["child 7 1", "child 8 2", "reset", "child 8 2"]);
        assert_eq!(reset.children.into_iter().collect::<Vec<_>>(), [(8, 2)]);
        assert_eq!(fold(&[]).focused, None);
        assert_eq!(fold(&["focus", "blur"]).focused, Some(false));
        assert_eq!(fold(&["blur", "focus", "reset"]).focused, Some(true));
        assert!(!fold(&["reset"]).agents_interrupted);
        assert!(fold(&["interrupted", "reset"]).agents_interrupted, "a resync never clears it");
        assert!(!fold(&["interrupted", "shown"]).agents_interrupted, "showing the notice does");
        assert!(fold(&["shown", "interrupted"]).agents_interrupted);
        let termed = fold(&["term 15"]);
        assert_eq!((termed.terminated_at, termed.exiting), (Some(7), false));
    }

    #[test]
    fn tracked_agent_groups_are_capped() {
        let full = (0..MAX_CHILDREN as u32 + 10).fold(Watch::new(true), |w, i| w.apply(Message::Child(i + 2, 1), 1));
        assert_eq!(full.children.len(), MAX_CHILDREN);
        // A known group still updates, and freeing a slot lets a new one in.
        let updated = full.apply(Message::Child(2, 9), 1).apply(Message::Unchild(3), 1).apply(Message::Child(1_000_000, 1), 1);
        assert_eq!((updated.children.get(&2), updated.children.len()), (Some(&9), MAX_CHILDREN));
        assert!(updated.children.contains_key(&1_000_000));
    }
}
