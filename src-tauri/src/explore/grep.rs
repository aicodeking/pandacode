//! Runs every search of one call over the files at once: each file is read a single time and
//! only the jobs that may match it look at its bytes. Line semantics follow ripgrep.
use super::{
    index::{parallel, SkipList, Snapshot},
    lex::LIMIT_CHECK_BYTES,
    limit::{Limit, ParseBytesGuard},
    named::MAX_NAMED_BYTES,
    plan::{Pattern, Scan},
    shape::{Group, Line},
    symbols::{self, Enclosing, Symbol},
};
use regex::bytes::Regex;
use std::{
    borrow::Cow,
    cell::{Cell, OnceCell},
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

const LINE_CHARS: usize = 140;
/// Text kept around a match when its line is clipped.
const WINDOW_BEFORE_BYTES: usize = 120;
const WINDOW_BYTES: usize = 1_400;
/// Past this a job keeps counting matched lines but stops holding their text.
const KEEP_LINES: usize = 4_000;
/// Line numbers held per file and job; matches past it are only counted.
const MAX_RECORDED_LINES: usize = 2_000;
/// Hit lines of one file given their text and symbol.
const MAX_FILE_HITS: usize = 8;
/// Metadata is only a sample for reply shaping; the counters below include every result.
const MAX_FILE_DEFINITIONS: usize = 64;
const MAX_JOB_DEFINITIONS: usize = 256;
const MAX_JOB_FILES: usize = 512;
const MAX_OUTSIDE_FILES: usize = 64;
/// Bounds the parallel collector as well as the retained results between chunks.
const WORK_CHUNK: usize = 32;
const LIMIT_CHECK_LINES: usize = 1_024;
const IMPORT_LOOKBACK: usize = 30;

pub(super) enum Kind {
    Search { context: usize },
    Definition { name: String, qualifier: Option<String>, folded: bool },
    /// A `tests_for` lookup: the word a test would use for the file, and the file itself.
    Mention { stem: String, target: std::path::PathBuf },
}

pub(super) struct Job {
    pub(super) pattern: Pattern,
    pub(super) kind: Kind,
}

pub(super) struct Definition {
    pub(super) symbol: Symbol,
    pub(super) signature: String,
}

#[derive(Default)]
pub(super) struct FileResult {
    /// This file's matching, parsing or line rendering missed work.
    pub(super) cut: bool,
    pub(super) path: Arc<str>,
    pub(super) matched: usize,
    pub(super) in_scope: bool,
    pub(super) groups: Vec<Group>,
    pub(super) clipped_lines: usize,
    pub(super) definitions: Vec<Definition>,
    pub(super) definition_count: usize,
    /// Bounded candidates retained during this file read for a qualified lookup miss.
    unqualified: Option<(Vec<Definition>, usize)>,
    pub(super) imports: usize,
    /// Full tests_for score, including its name, imports and capped mentions.
    test_score: usize,
    /// For a search: the hit lines to show, definitions first, then the earliest, each with
    /// whether it defines what the pattern names.
    pub(super) lines: Vec<(usize, bool)>,
    /// For a file outside the glob: its first hit as `line:text`.
    pub(super) first_hit: Option<String>,
    /// For a search: a hit line defines what the pattern names, so the file is listed first.
    pub(super) defines: bool,
}

#[derive(Default)]
pub(super) struct JobResult {
    /// The shared walk or this job's own file processing missed work.
    pub(super) cut: bool,
    pub(super) files: Vec<FileResult>,
    pub(super) matched_lines: usize,
    pub(super) total_files: usize,
    pub(super) total_definitions: usize,
    pub(super) definition_files: usize,
    pub(super) unqualified_fallback: bool,
    pub(super) unsupported_files: usize,
    pub(super) mentioned_files: usize,
    pub(super) outside: Vec<FileResult>,
    pub(super) outside_files: usize,
    pub(super) outside_matches: usize,
    /// Test files mentioning the stem, including those also named for it.
    pub(super) test_files: usize,
    pub(super) named_test_files: usize,
    /// Importing test files not already counted among the named tests.
    pub(super) importing_test_files: usize,
    /// Files where the pattern matches only by running across a newline.
    pub(super) crossing_files: usize,
}

pub(super) struct Outcome {
    pub(super) jobs: Vec<JobResult>,
    pub(super) binary: SkipList,
}

/// What a call searches beyond the walk: the glob filter and files it named past the size cap.
pub(super) struct Scope<'a> {
    pub(super) allows: &'a dyn Fn(&str) -> bool,
    pub(super) named_large: Vec<Arc<str>>,
}

struct Work {
    path: Arc<str>,
    mask: u64,
    in_scope: bool,
}

/// Which files to read, each with a bit per job that may match it.
fn worklist(snapshot: &Snapshot, jobs: &[Job], scope: &Scope) -> Vec<Work> {
    let mut masks: HashMap<Arc<str>, u64> = HashMap::new();
    for (bit, job) in jobs.iter().enumerate() {
        match snapshot.candidates(&job.pattern.plan) {
            Some(paths) => paths.into_iter().for_each(|path| *masks.entry(path).or_default() |= 1 << bit),
            None => snapshot.walk.files.iter().for_each(|file| *masks.entry(file.path.clone()).or_default() |= 1 << bit),
        }
        if matches!(job.kind, Kind::Search { .. }) {
            scope.named_large.iter().for_each(|path| *masks.entry(path.clone()).or_default() |= 1 << bit);
        }
    }
    let mut work: Vec<_> = masks.into_iter().map(|(path, mask)| Work { in_scope: (scope.allows)(&path), path, mask }).collect();
    work.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    work
}

pub(super) fn run_jobs(root: &Path, snapshot: &Snapshot, jobs: &[Job], scope: &Scope, limit: &Limit) -> Outcome {
    // Each job is one bit of a file's mask; `args` allows at most 60 requests.
    assert!(jobs.len() <= 64, "too many jobs for a 64-bit mask");
    let work = worklist(snapshot, jobs, scope);
    let binary = Mutex::new(SkipList::default());
    let crossing: Vec<AtomicUsize> = jobs.iter().map(|_| AtomicUsize::new(0)).collect();
    let strict = snapshot.walk.strict;
    let shared = Shared { root, jobs, crossing: &crossing, binary: &binary, limit, strict };
    let walk_cut = snapshot.walk.incomplete || limit.expired();
    let mut results: Vec<JobResult> = jobs.iter().map(|_| JobResult { cut: walk_cut, ..JobResult::default() }).collect();
    let mut fallbacks: Vec<JobResult> = jobs.iter().map(|_| JobResult::default()).collect();
    for chunk in work.chunks(WORK_CHUNK) {
        if limit.expired() {
            results.iter_mut().for_each(|result| result.cut = true);
            break;
        }
        let found = parallel(chunk.len(), |at| (!limit.expired()).then(|| search_file(&shared, &chunk[at])));
        for (bit, mut file) in found.into_iter().flatten() {
            if let Some((definitions, definition_count)) = file.unqualified.take() {
                fallbacks[bit].add(FileResult { path: file.path.clone(), matched: file.matched, in_scope: file.in_scope, definitions, definition_count, ..FileResult::default() }, &jobs[bit].kind);
            }
            results[bit].add(file, &jobs[bit].kind);
        }
        if limit.expired() {
            results.iter_mut().for_each(|result| result.cut = true);
        }
        // Parallel completion order is arbitrary. Sort before pruning so no later chunk or
        // faster worker can displace an earlier result of the same rank.
        for ((result, fallback), job) in results.iter_mut().zip(&mut fallbacks).zip(jobs) {
            result.prune(&job.kind);
            fallback.prune(&job.kind);
        }
    }
    for (result, fallback) in results.iter_mut().zip(fallbacks) {
        if result.total_definitions == 0 && fallback.total_definitions > 0 {
            result.files = fallback.files;
            result.total_definitions = fallback.total_definitions;
            result.definition_files = fallback.definition_files;
            result.unqualified_fallback = true;
        }
    }
    for (result, crossing) in results.iter_mut().zip(&crossing) {
        result.crossing_files = crossing.load(Ordering::Relaxed);
    }
    add_groups(root, jobs, &mut results, limit, strict);
    Outcome { jobs: results, binary: binary.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner()) }
}

impl JobResult {
    fn add(&mut self, file: FileResult, kind: &Kind) {
        self.cut |= file.cut;
        if file.matched == 0 {
            return;
        }
        if !file.in_scope {
            self.outside_files += 1;
            self.outside_matches += file.matched;
            self.outside.push(file);
            return;
        }
        self.matched_lines += file.matched;
        self.total_files += 1;
        self.mentioned_files += 1;
        self.total_definitions += file.definition_count;
        self.definition_files += usize::from(file.definition_count > 0);
        self.unsupported_files += usize::from(!symbols::supported(&file.path));
        match kind {
            Kind::Definition { .. } if file.definition_count == 0 => return,
            Kind::Mention { stem, .. } => {
                if file.test_score == 0 {
                    return;
                }
                let named = super::tests_for::named_test(&file.path, stem);
                self.test_files += 1;
                self.named_test_files += usize::from(named);
                self.importing_test_files += usize::from(!named && file.imports > 0);
            }
            _ => {}
        }
        self.files.push(file);
    }

    fn prune(&mut self, kind: &Kind) {
        self.files.sort_unstable_by(|a, b| {
            let rank = match kind {
                Kind::Search { .. } => b.defines.cmp(&a.defines),
                Kind::Definition { .. } => std::cmp::Ordering::Equal,
                Kind::Mention { .. } => b.test_score.cmp(&a.test_score),
            };
            rank.then_with(|| a.path.cmp(&b.path))
        });
        self.files.truncate(MAX_JOB_FILES);
        let mut left = MAX_JOB_DEFINITIONS;
        for file in &mut self.files {
            file.definitions.truncate(left);
            left -= file.definitions.len();
        }
        self.outside.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        self.outside.truncate(MAX_OUTSIDE_FILES);
    }
}

/// Gives each search's files their lines with context, in path order until `KEEP_LINES` are
/// held, so which files show does not depend on which thread finished first.
fn add_groups(root: &Path, jobs: &[Job], results: &mut [JobResult], limit: &Limit, strict: bool) {
    let mut wanted: BTreeMap<Arc<str>, Vec<(usize, usize)>> = BTreeMap::new();
    for (bit, (job, result)) in jobs.iter().zip(results.iter()).enumerate() {
        let Kind::Search { context } = job.kind else { continue };
        let mut held = 0;
        for (at, file) in result.files.iter().enumerate() {
            if held >= KEEP_LINES {
                break;
            }
            held += file.lines.len() * (1 + 2 * context);
            wanted.entry(file.path.clone()).or_default().push((bit, at));
        }
    }
    let wanted: Vec<_> = wanted.into_iter().collect();
    let shared: &[JobResult] = results;
    let grouped = parallel(wanted.len(), |at| {
        let (path, slots) = &wanted[at];
        let bytes = (!limit.expired()).then(|| super::read_file(root, &root.join(&**path), MAX_NAMED_BYTES, strict)).flatten();
        let Some(bytes) = bytes else {
            return Some(slots.iter().map(|&(bit, file)| (bit, file, (Vec::new(), 0), limit.expired())).collect::<Vec<_>>());
        };
        let view = FileView::new(path, &bytes, limit);
        let groups = slots.iter().map(|&(bit, file)| {
            let Kind::Search { context } = jobs[bit].kind else { unreachable!("only searches are grouped") };
            let groups = view.groups(&shared[bit].files[file].lines, context, &jobs[bit].pattern.regex);
            (bit, file, groups, view.cut.get() || limit.expired())
        });
        Some(groups.collect::<Vec<_>>())
    });
    for (bit, file, (groups, clipped), cut) in grouped.into_iter().flatten() {
        results[bit].cut |= cut;
        (results[bit].files[file].groups, results[bit].files[file].clipped_lines) = (groups, clipped);
    }
}

struct Shared<'a> {
    root: &'a Path,
    jobs: &'a [Job],
    crossing: &'a [AtomicUsize],
    binary: &'a Mutex<SkipList>,
    limit: &'a Limit,
    strict: bool,
}

fn search_file(shared: &Shared, work: &Work) -> Vec<(usize, FileResult)> {
    let Some(bytes) = super::read_file(shared.root, &shared.root.join(&*work.path), MAX_NAMED_BYTES, shared.strict) else { return Vec::new() };
    if bytes.contains(&0) {
        shared.binary.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).add(&work.path);
        return Vec::new();
    }
    let file = FileView::new(&work.path, &bytes, shared.limit);
    let mut found = Vec::new();
    for (bit, job) in shared.jobs.iter().enumerate() {
        if work.mask & 1 << bit == 0 {
            continue;
        }
        let matches = if shared.limit.expired() { Matches::default() } else { matching_lines(&job.pattern, &bytes, shared.limit) };
        if matches.count == 0 {
            if shared.limit.expired() {
                found.push((bit, FileResult { cut: true, ..FileResult::default() }));
            }
            shared.crossing[bit].fetch_add(usize::from(matches.crossed && work.in_scope), Ordering::Relaxed);
            continue;
        }
        let in_scope = work.in_scope || !matches!(job.kind, Kind::Search { .. });
        found.push((bit, file.result(&work.path, &matches, job, in_scope)));
    }
    found
}

#[derive(Default, Debug, PartialEq)]
pub(super) struct Matches {
    /// Start offset of the first matching lines, up to `MAX_RECORDED_LINES`.
    pub(super) starts: Vec<usize>,
    pub(super) count: usize,
    /// No line matches, yet the buffer does: the match runs across a newline.
    pub(super) crossed: bool,
}

impl Matches {
    fn add(&mut self, start: usize, recording: usize) {
        if self.starts.len() < recording {
            self.starts.push(start);
        }
        self.count += 1;
    }
}

/// The lines of a buffer that match, in time linear in its size.
pub(super) fn matching_lines(pattern: &Pattern, bytes: &[u8], limit: &Limit) -> Matches {
    matching_lines_recording(pattern, bytes, limit, MAX_RECORDED_LINES)
}

pub(super) fn matching_lines_recording(pattern: &Pattern, bytes: &[u8], limit: &Limit, recording: usize) -> Matches {
    match pattern.scan {
        Scan::Buffer => buffer_lines(&pattern.regex, bytes, limit, recording),
        Scan::Lines if !pattern.regex.is_match(bytes) => Matches::default(),
        Scan::Lines => {
            let matches = each_line(&pattern.regex, bytes, limit, recording);
            Matches { crossed: matches.count == 0 && crosses_lines(&pattern.regex, bytes, limit), ..matches }
        }
        Scan::OnlyLines => each_line(&pattern.regex, bytes, limit, recording),
    }
}

/// Whether some match joins text on two lines (`abc\ndef`), not merely a line end (`\s+$`).
fn crosses_lines(regex: &Regex, bytes: &[u8], limit: &Limit) -> bool {
    let text = |part: &[u8]| part.iter().any(|b| !b.is_ascii_whitespace());
    for (seen, found) in regex.find_iter(bytes).enumerate() {
        if (seen + 1).is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
            return false;
        }
        let part = found.as_bytes();
        let (Some(first), Some(last)) = (part.iter().position(|&b| b == b'\n'), part.iter().rposition(|&b| b == b'\n')) else { continue };
        if text(&part[..first]) && text(&part[last + 1..]) {
            return true;
        }
    }
    false
}

/// A pattern that cannot cross a newline stops at the end of a line, so skipping from match to
/// match never scans a line twice.
fn buffer_lines(regex: &Regex, bytes: &[u8], limit: &Limit, recording: usize) -> Matches {
    let mut matches = Matches::default();
    let mut from = 0;
    while from <= bytes.len() {
        if (matches.count + 1).is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
            break;
        }
        let Some(found) = regex.find_at(bytes, from) else { break };
        let start = bytes[..found.start()].iter().rposition(|&b| b == b'\n').map_or(0, |at| at + 1);
        // The empty text after a final newline is not a line.
        if start >= bytes.len() {
            break;
        }
        matches.add(start, recording);
        from = bytes[found.start()..].iter().position(|&b| b == b'\n').map_or(bytes.len(), |at| found.start() + at) + 1;
    }
    matches
}

fn each_line(regex: &Regex, bytes: &[u8], limit: &Limit, recording: usize) -> Matches {
    let mut matches = Matches::default();
    let mut start = 0;
    let mut seen = 0usize;
    while start < bytes.len() {
        seen += 1;
        if seen.is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
            break;
        }
        let end = bytes[start..].iter().position(|&b| b == b'\n').map_or(bytes.len(), |at| start + at);
        if regex.is_match(&bytes[start..end]) {
            matches.add(start, recording);
        }
        start = end + 1;
    }
    matches
}

/// A file being reported on: its line table and symbols, each computed once and only on a hit.
pub(super) struct FileView<'a> {
    path: &'a str,
    bytes: &'a [u8],
    limit: &'a Limit,
    starts: OnceCell<Option<(Vec<usize>, ParseBytesGuard<'a>)>>,
    symbols: OnceCell<(Vec<Symbol>, bool)>,
    cut: Cell<bool>,
}

impl<'a> FileView<'a> {
    pub(super) fn new(path: &'a str, bytes: &'a [u8], limit: &'a Limit) -> Self {
        Self { path, bytes, limit, starts: OnceCell::new(), symbols: OnceCell::new(), cut: Cell::new(false) }
    }

    fn starts(&self) -> Option<&[usize]> {
        let table = self.starts.get_or_init(|| {
            let mut line_count = 0usize;
            for chunk in self.bytes.chunks(LIMIT_CHECK_BYTES) {
                if self.limit.expired() {
                    return None;
                }
                line_count += chunk.iter().filter(|&&byte| byte == b'\n').count();
            }
            if self.limit.expired() {
                return None;
            }
            let Some(capacity) = line_count.checked_add(1) else {
                self.limit.cut();
                return None;
            };
            let Some(needed) = capacity.checked_mul(size_of::<usize>()) else {
                self.limit.cut();
                return None;
            };
            let Some(guard) = self.limit.reserve_parse_bytes(needed) else {
                self.limit.cut();
                return None;
            };
            let mut starts = Vec::with_capacity(capacity);
            starts.push(0);
            for (chunk, bytes) in self.bytes.chunks(LIMIT_CHECK_BYTES).enumerate() {
                if self.limit.expired() {
                    return None;
                }
                for (at, &byte) in bytes.iter().enumerate() {
                    let next = chunk * LIMIT_CHECK_BYTES + at + 1;
                    if byte == b'\n' && next < self.bytes.len() {
                        starts.push(next);
                    }
                }
            }
            Some((starts, guard))
        });
        if table.is_none() {
            self.cut.set(true);
        }
        table.as_ref().map(|(starts, _guard)| starts.as_slice())
    }

    pub(super) fn line_at(&self, offset: usize) -> Option<usize> {
        Some(self.starts()?.partition_point(|&start| start <= offset))
    }

    fn line_bytes(&self, line: usize) -> &[u8] {
        let Some(starts) = self.starts() else { return &[] };
        let Some(&start) = line.checked_sub(1).and_then(|at| starts.get(at)) else { return &[] };
        let end = starts.get(line).map_or(self.bytes.len(), |&next| next - 1);
        let bytes = &self.bytes[start..end];
        let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
        bytes.strip_suffix(b"\r").unwrap_or(bytes)
    }

    fn line_text(&self, line: usize) -> String {
        clip(&String::from_utf8_lossy(self.line_bytes(line)), LINE_CHARS)
    }

    fn symbols(&self) -> &[Symbol] {
        let (symbols, cut) = self.symbols.get_or_init(|| symbols::extract_checked(self.path, &String::from_utf8_lossy(self.bytes), self.limit));
        self.cut.set(self.cut.get() || *cut);
        symbols
    }

    fn result(&self, path: &Arc<str>, matches: &Matches, job: &Job, in_scope: bool) -> FileResult {
        let mut result = FileResult { cut: false, path: path.clone(), matched: matches.count, in_scope, groups: Vec::new(), clipped_lines: 0, definitions: Vec::new(), definition_count: 0, unqualified: None, imports: 0, test_score: 0, lines: Vec::new(), first_hit: None, defines: false };
        if self.starts().is_none() || self.limit.expired() {
            result.cut = true;
            return result;
        }
        if !in_scope {
            result.first_hit = matches.starts.first().and_then(|&start| {
                let line = self.line_at(start)?;
                Some(format!("{line}:{}", window_around_match(self.line_bytes(line), &job.pattern.regex).0))
            });
            result.cut = self.cut.get() || self.limit.expired();
            return result;
        }
        let hits: Vec<usize> = matches.starts.iter().filter_map(|&start| self.line_at(start)).collect();
        match &job.kind {
            Kind::Search { .. } => {
                let defines = self.defining_lines(&job.pattern.regex);
                let flagged: Vec<(usize, bool)> = hits.into_iter().map(|line| (line, defines.contains(&line))).collect();
                result.defines = flagged.iter().any(|&(_, defines)| defines);
                result.lines = ranked(flagged, MAX_FILE_HITS);
            }
            Kind::Definition { name, qualifier, folded } => {
                (result.definitions, result.definition_count) = self.definitions(name, qualifier.as_deref(), *folded);
                if qualifier.is_some() && result.definition_count == 0 {
                    result.unqualified = Some(self.definitions(name, None, *folded));
                }
            }
            Kind::Mention { stem, .. } => {
                result.imports = hits.iter().filter(|&&line| self.imports_at(line)).count();
                result.test_score = super::tests_for::mention_score(path, stem, result.imports, result.matched);
            }
        }
        result.cut = self.cut.get() || self.limit.expired();
        result
    }

    /// Lines where a definition starts and the pattern matches its name, not merely some other
    /// text on the line (`const a = handleLogin;` defines `a`; `log = get_logger()` does not
    /// define `get_logger`, nor does the `log` in it count as `log`).
    fn defining_lines(&self, regex: &Regex) -> HashSet<usize> {
        let word = |byte: Option<&u8>| byte.is_some_and(|&b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80);
        let names = |symbol: &Symbol| {
            let line = self.line_bytes(symbol.line);
            let name = symbol.name.as_bytes();
            let whole = |at: usize| line[at..].starts_with(name) && !word(at.checked_sub(1).and_then(|before| line.get(before))) && !word(line.get(at + name.len()));
            // Only the name's first whole-word use is where it is defined: in
            // `notify: text => notify(text)` the call is not.
            let Some(at) = (0..line.len().saturating_sub(name.len()) + 1).find(|&at| whole(at)) else { return false };
            !name.is_empty() && regex.find_iter(line).any(|found| at < found.end() && found.start() < at + name.len())
        };
        self.symbols().iter().filter(|symbol| names(symbol)).map(|symbol| symbol.line).collect()
    }

    /// Hit lines with their context, split by the enclosing symbol, and how many were clipped.
    /// `hits` carry whether each defines what the pattern names, found by the search.
    fn groups(&self, hits: &[(usize, bool)], context: usize, regex: &Regex) -> (Vec<Group>, usize) {
        let Some(starts) = self.starts() else { return (Vec::new(), 0) };
        let last_line = starts.len();
        // The file may have changed since it was searched.
        let hits: Vec<(usize, bool)> = hits.iter().copied().filter(|&(hit, _)| hit <= last_line).collect();
        let mut wanted: BTreeMap<usize, bool> = BTreeMap::new();
        for &(hit, _) in &hits {
            for line in hit.saturating_sub(context).max(1)..=(hit + context).min(last_line) {
                wanted.entry(line).or_insert(false);
            }
            wanted.insert(hit, true);
        }
        // A one-line definition labels nothing its line does not already show.
        let spans: Vec<Symbol> = self.symbols().iter().filter(|symbol| symbol.end > symbol.line).cloned().collect();
        let mut enclosing = Enclosing::new(&spans);
        let (mut groups, mut clipped): (Vec<Group>, usize) = (Vec::new(), 0);
        for (seen, (line, hit)) in wanted.into_iter().enumerate() {
            if seen.is_multiple_of(LIMIT_CHECK_LINES) && self.limit.expired() {
                self.cut.set(true);
                break;
            }
            let symbol = enclosing.at(line).map(|symbol| format!("{} {}-{}", qualified_name(symbol), symbol.line, symbol.end));
            let (shown, cut, at) = if hit { window_around_match(self.line_bytes(line), regex) } else { (self.line_text(line).trim_start().to_owned(), false, 0) };
            clipped += usize::from(cut);
            let number = line.to_string();
            let matched = hit.then_some(number.len() + 1 + at);
            let text = format!("{number}{}{shown}", if hit { ':' } else { '-' });
            let line = Line { text, hit, number: line, definition: hit && hits.contains(&(line, true)), matched };
            match groups.last_mut() {
                Some(group) if group.symbol == symbol => group.lines.push(line),
                _ => groups.push(Group { symbol, lines: vec![line] }),
            }
        }
        (groups, clipped)
    }

    fn definitions(&self, name: &str, qualifier: Option<&str>, folded: bool) -> (Vec<Definition>, usize) {
        let same = |candidate: &str| if folded { candidate.eq_ignore_ascii_case(name) } else { candidate == name };
        let symbols = self.symbols();
        let (mut found, mut count) = (Vec::new(), 0);
        symbols::qualified_matches(symbols, qualifier, |symbol| same(&symbol.name), self.limit, |symbol| {
            count += 1;
            if found.len() < MAX_FILE_DEFINITIONS {
                found.push(Definition { signature: self.line_text(symbol.line).trim().to_owned(), symbol: symbol.clone() });
            }
        });
        self.cut.set(self.cut.get() || self.limit.expired());
        (found, count)
    }

    /// An import line, or a line inside an import spread over several lines.
    fn imports_at(&self, line: usize) -> bool {
        let text = |line: usize| String::from_utf8_lossy(self.line_bytes(line)).trim().to_owned();
        if is_import(&text(line)) {
            return true;
        }
        for earlier in (line.saturating_sub(IMPORT_LOOKBACK).max(1)..line).rev() {
            let earlier = text(earlier);
            if is_import(&earlier) && earlier.ends_with(['{', '(']) {
                return true;
            }
            if earlier.ends_with([';', '}', ')']) {
                return false;
            }
        }
        false
    }
}

/// The whole line when it fits; otherwise the part around the first match, marked as clipped.
/// Also the character in the shown text where the first match starts (0 without one).
/// A search shows lines without their indentation: a read shows them as they are.
pub(super) fn window_around_match(line: &[u8], regex: &Regex) -> (String, bool, usize) {
    let line = line.trim_ascii_start();
    let text = String::from_utf8_lossy(line);
    let found = regex.find(line).map_or(0, |found| found.start());
    let chars_before = |from: usize| String::from_utf8_lossy(&line[from..found.max(from)]).chars().count();
    if text.chars().nth(LINE_CHARS).is_none() {
        return (text.into_owned(), false, chars_before(0));
    }
    let start = found.saturating_sub(WINDOW_BEFORE_BYTES);
    let window = &line[start..line.len().min(start + WINDOW_BYTES)];
    let shown = clip(&String::from_utf8_lossy(window), LINE_CHARS);
    if start > 0 { (format!("…{shown}"), true, chars_before(start) + 1) } else { (shown, true, chars_before(0)) }
}

/// At most `most` hit lines, in line order: definitions first, then the earliest. Used per file
/// (`MAX_FILE_HITS`) and per file of a broad search (`trim_hits`).
pub(super) fn ranked(hits: impl IntoIterator<Item = (usize, bool)>, most: usize) -> Vec<(usize, bool)> {
    let mut hits: Vec<(usize, bool)> = hits.into_iter().collect();
    hits.sort_unstable_by_key(|&(line, definition)| (!definition, line));
    hits.truncate(most);
    hits.sort_unstable();
    hits
}

pub(super) fn symbol_label(symbol: &Symbol) -> String {
    format!("{} {} {}-{}", symbol.kind, qualified_name(symbol), symbol.line, symbol.end)
}

/// A container's full path (`a::b`, `Foo::Bar`), as written and as `path#a::b` looks it up; any
/// other definition by its own name, its receiver shown on its line.
fn qualified_name(symbol: &Symbol) -> Cow<'_, str> {
    match (symbol.kind, symbol.qualifier.as_deref()) {
        ("class" | "module", Some(qualifier)) => format!("{qualifier}::{}", symbol.name).into(),
        _ => symbol.name.as_str().into(),
    }
}

pub(super) fn clip(line: &str, chars: usize) -> String {
    match line.char_indices().nth(chars) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line.to_owned(),
    }
}

fn is_import(line: &str) -> bool {
    let line = line.trim_start();
    ["import ", "import{", "from ", "use ", "pub use ", "pub(crate) use ", "#include", "require", "using ", "} from "].iter().any(|word| line.starts_with(word)) || line.contains("require(") || line.contains("import(")
}

#[cfg(test)]
mod tests {
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
}
