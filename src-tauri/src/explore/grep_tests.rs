use super::*;
use crate::explore::plan::compile;
use std::time::Duration;

fn limit() -> Limit {
    Limit::new(Arc::default())
}

fn lines_of(pattern: &str, text: &str) -> Vec<usize> {
    let limit = limit();
    let view = FileView::new("a.txt", text.as_bytes(), &limit);
    matching_lines(&compile(pattern, false).unwrap(), text.as_bytes(), &limit).starts.into_iter().map(|start| view.line_at(start).unwrap()).collect()
}

#[test]
fn line_semantics_follow_ripgrep() {
    assert_eq!(lines_of("foo", "foo\nbar\nfoo foo\n"), [1, 3]);
    assert_eq!(lines_of("^$", "a\n\nb\n"), [2]);
    assert_eq!(lines_of("^$", ""), Vec::<usize>::new());
    assert_eq!(lines_of(r"a\s+b", "a\nb\na b\n"), [3]);
    assert_eq!(lines_of("[^a]", "aaa\n\naa\nab\n"), [4]);
    assert_eq!(lines_of("foo$", "foo\r\nfoo\n"), [2]);
    assert_eq!(lines_of(r"\bx", "x\n"), [1]);
    assert_eq!(lines_of(r"\Afoo", "foo\nfoo\nx foo\n"), [1, 2]);
    assert_eq!(lines_of(r"foo\z", "foo\nx foo\nfoo x\n"), [1, 2]);
}

#[test]
fn line_tables_refuse_dense_files_without_spending_scratch_bytes() {
    let bytes = vec![b'\n'; 4 * 1024 * 1024];
    let budget = limit();
    let view = FileView::new("dense.txt", &bytes, &budget);
    assert_eq!(view.line_at(0), None);
    assert!(view.starts().is_none());
    assert!(view.line_bytes(0).is_empty());
    assert!(view.line_bytes(1).is_empty());
    let job = Job { pattern: compile("^$", true).unwrap(), kind: Kind::Search { context: 0 } };
    let matches = Matches { starts: vec![0], count: 1, crossed: false };
    let file = view.result(&Arc::from("dense.txt"), &matches, &job, true);
    assert!(file.cut && file.lines.is_empty());
    assert!(view.groups(&[(1, false)], 0, &job.pattern.regex).0.is_empty());
    assert!(budget.was_cut());
    // Refusal must happen before allocating or reserving any part of the table.
    assert!(budget.reserve_parse_bytes(super::super::limit::MAX_PARSE_BYTES).is_some());
}

#[test]
fn line_tables_stop_before_building_for_cancelled_or_expired_calls() {
    let bytes = vec![b'\n'; 4 * 1024 * 1024];
    for budget in [Limit::lasting(Duration::ZERO, Arc::default()), Limit::new(Arc::new(std::sync::atomic::AtomicBool::new(true)))] {
        let view = FileView::new("dense.txt", &bytes, &budget);
        assert_eq!(view.line_at(0), None);
        assert!(view.starts().is_none());
        assert!(budget.was_cut());
        assert!(budget.reserve_parse_bytes(super::super::limit::MAX_PARSE_BYTES).is_some());
    }
}

#[test]
fn line_table_reservations_live_until_the_file_view_drops() {
    let bytes = b"a\nb\n";
    let needed = 3 * size_of::<usize>();
    let budget = Limit::with_parse_bytes(needed);
    for _ in 0..3 {
        let view = FileView::new("small.txt", bytes, &budget);
        assert_eq!(view.line_at(2), Some(2));
        assert!(budget.reserve_parse_bytes(1).is_none());
        drop(view);
        assert!(budget.reserve_parse_bytes(needed).is_some());
    }
    assert!(!budget.was_cut());
}

/// CPU time this thread has used (wall time where there is no such clock).
fn busy_time() -> Duration {
    #[cfg(unix)]
    {
        let mut now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        // SAFETY: `now` is a valid timespec for the call to fill.
        assert_eq!(unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut now) }, 0);
        Duration::new(now.tv_sec as u64, now.tv_nsec as u32)
    }
    #[cfg(not(unix))]
    {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        START.get_or_init(std::time::Instant::now).elapsed()
    }
}

/// Each took minutes or more when a match could restart near the same place for every line.
#[test]
fn crossing_patterns_stay_linear_on_a_large_file() {
    let many_lines = "aaaa\n".repeat(200_000) + "az\n";
    let started = busy_time();
    assert_eq!(matching_lines(&compile("[^z]+z", true).unwrap(), many_lines.as_bytes(), &limit()).count, 1);
    assert_eq!(matching_lines(&compile("a\\s+b", true).unwrap(), many_lines.as_bytes(), &limit()).count, 0);
    assert_eq!(matching_lines(&compile("foo[^z]*z|a", true).unwrap(), many_lines.as_bytes(), &limit()).count, 200_001);
    let notes = "TODO line of a note\n".repeat(45_000) + "FIXME\n";
    assert_eq!(matching_lines(&compile("(?s)TODO.*FIXME", true).unwrap(), notes.as_bytes(), &limit()).count, 0);
    assert_eq!(matching_lines(&compile("[^Z]+FIXME", true).unwrap(), notes.as_bytes(), &limit()).count, 0);
    let short = "aaa\n".repeat(64 * 1024) + "z\n";
    assert_eq!(matching_lines(&compile("[^z]*z", true).unwrap(), short.as_bytes(), &limit()).count, 1);
    let empty_lines = "\n".repeat(1 << 20);
    assert_eq!(matching_lines(&compile(r"\s+x", true).unwrap(), empty_lines.as_bytes(), &limit()).count, 0);
    // CPU time, not wall time: a loaded machine makes the test wait, not work.
    let spent = busy_time() - started;
    assert!(spent < Duration::from_secs(30), "{spent:?}");
}

#[test]
fn a_match_only_across_lines_is_remembered() {
    let matches = matching_lines(&compile(r"abc\s+def", true).unwrap(), b"abc\ndef\n", &limit());
    assert_eq!((matches.count, matches.crossed), (0, true));
    let matches = matching_lines(&compile(r"abc\s+def", true).unwrap(), b"abc def\n", &limit());
    assert_eq!((matches.count, matches.crossed), (1, false));
    assert!(!matching_lines(&compile(r"abc\s+def", true).unwrap(), b"nothing\n", &limit()).crossed);
    assert!(!matching_lines(&compile(r"\s+$", true).unwrap(), b"fn a() {}\nfn b() {}\n", &limit()).crossed, "only a newline is no line of text");
    assert!(matching_lines(&compile(r"(?s)abc.def", true).unwrap(), b"abc\ndef\n", &limit()).crossed);
}

#[test]
fn matches_past_the_cap_are_counted_not_recorded() {
    let text = "x\n".repeat(MAX_RECORDED_LINES + 10);
    let matches = matching_lines(&compile("x", true).unwrap(), text.as_bytes(), &limit());
    assert_eq!((matches.count, matches.starts.len()), (MAX_RECORDED_LINES + 10, MAX_RECORDED_LINES));
}

#[test]
fn an_expired_limit_stops_a_scan() {
    let done = Limit::lasting(Duration::ZERO, Arc::default());
    let text = "x\n".repeat(1 << 18);
    let matches = matching_lines(&compile("x", true).unwrap(), text.as_bytes(), &done);
    assert!(matches.count < 1 << 18);
    assert!(done.was_cut());
    let by_line = matching_lines(&compile(r"\Ax", true).unwrap(), text.as_bytes(), &Limit::lasting(Duration::ZERO, Arc::default()));
    assert!(by_line.count < 1 << 18);
}

#[test]
fn a_long_line_shows_the_part_around_its_match() {
    let line = format!("{}needle{}", "a".repeat(5_000), "b".repeat(5_000));
    let regex = compile("needle", true).unwrap().regex;
    let (shown, cut, at) = window_around_match(line.as_bytes(), &regex);
    assert!(cut && shown.starts_with('…') && shown.chars().skip(at).collect::<String>().starts_with("needle"), "{shown}");
    assert!(shown.chars().count() <= LINE_CHARS + 2);
    assert_eq!(window_around_match("  é short needle".as_bytes(), &regex), ("é short needle".to_owned(), false, 8));
}

/// A file can shrink between the search and the second read that shows its lines.
#[test]
fn lines_past_a_file_that_shrank_are_dropped() {
    let limit = limit();
    let view = FileView::new("a.txt", b"needle\nother\n", &limit);
    let (groups, _) = view.groups(&[(1, false), (5, false)], 0, &compile("needle", true).unwrap().regex);
    assert_eq!(groups.iter().flat_map(|group| &group.lines).map(|line| line.number).collect::<Vec<_>>(), [1]);
}

#[test]
fn imports_are_recognised() {
    let limit = limit();
    let text = "import {\n  billing,\n  other,\n} from './x';\nbilling();\nuse crate::{\n    billing::a,\n};\nlet billing = 1;\n";
    let view = FileView::new("a.ts", text.as_bytes(), &limit);
    for (line, expected) in [(1, true), (2, true), (3, true), (4, true), (5, false), (6, true), (7, true), (9, false)] {
        assert_eq!(view.imports_at(line), expected, "line {line}");
    }
    assert!(is_import("const a = require('./x')"));
}
