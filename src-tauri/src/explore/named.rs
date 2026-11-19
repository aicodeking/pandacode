//! Requests that name a file: `read` and `outline`.
use super::{
    grep::clip,
    shape::{head, plain_lines, Body, Item, ReadSpan},
    symbols::{self, Symbol},
    Category, Ctx,
};
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
};

/// A named file may be bigger than what a search reads; past this, use the shell. Tests use a
/// lower cap, so they need not write 16 MiB to reach it.
pub(super) const MAX_NAMED_BYTES: u64 = if cfg!(test) { 6 } else { 16 } * 1024 * 1024;
const READ_LINE_CHARS: usize = 2_000;
/// Lines formatted for one read; the reply holds far fewer, and `next` covers the rest.
const MAX_READ_LINES: usize = 4_000;
const REFUSED_SECRET: &str = "Refused: this path may hold credentials.";
const UNREADABLE: &str = "Refused: a file that could not be read.";
const BINARY: &str = "Binary file.";
const SPENT: &str = "Skipped: this call already holds as much file text as it may; ask for it in another call.";
/// `path:42` (a stack trace, compiler output) reads this many lines before and after it.
const AROUND_BEFORE: usize = 10;
const AROUND_AFTER: usize = 30;
/// Ranges listed for an ambiguous `path#name`; the count says how many there were.
const AMBIGUOUS_LISTED: usize = 20;

/// An explicit path: inside the project, no `.git`, no symlink escape, no credential name.
pub(super) fn resolve_named(ctx: &Ctx, raw: &str) -> Result<(String, PathBuf), String> {
    let relative = if Path::new(raw).is_absolute() { ctx.relative(raw).unwrap_or(raw) } else { raw };
    let relative = relative.strip_prefix("./").unwrap_or(relative);
    if cfg!(windows) && relative.contains(':') {
        return Err("Refused: a path part may not contain a colon.".into());
    }
    if crate::workspace::secret_path(relative, ctx.strict) {
        return Err(REFUSED_SECRET.into());
    }
    let target = crate::workspace::scoped_path(ctx.root, relative)?;
    // A file that exists is given as its real path, the one checked here, so it is opened
    // without being resolved again.
    let Ok(real) = target.canonicalize() else { return Ok((relative.to_owned(), target)) };
    if real.strip_prefix(ctx.root).is_ok_and(|inside| crate::workspace::secret_path(&inside.to_string_lossy(), ctx.strict)) {
        return Err(REFUSED_SECRET.into());
    }
    Ok((relative.to_owned(), real))
}

/// An explicit file, opened after every check, with its project-relative path and the size it
/// had when opened.
fn open_named(ctx: &Ctx, raw: &str) -> Result<(String, std::fs::File, u64), String> {
    let (relative, target) = resolve_named(ctx, raw)?;
    let opened = crate::workspace::open_inside_up_to(ctx.root, &target, MAX_NAMED_BYTES, |path| crate::workspace::secret_path(path, ctx.strict));
    // Only a file that could not be opened is looked at again, to say why.
    let Some((file, size)) = opened else {
        let metadata = std::fs::metadata(&target).map_err(|_| "File not found.".to_owned())?;
        return Err(match () {
            () if metadata.is_dir() => "This is a folder.".into(),
            () if !metadata.is_file() => "Not a regular file.".into(),
            () if metadata.len() > MAX_NAMED_BYTES => format!("File is larger than {} MiB; use a shell command for it.", MAX_NAMED_BYTES / (1024 * 1024)),
            () => UNREADABLE.into(),
        });
    };
    Ok((relative, file, size))
}

/// The whole text of an opened file, for what needs the symbols: an outline or a `path#name`
/// read. Its size is taken from the call's allowance first, and a lossy copy of a file that is
/// not UTF-8 too.
fn read_opened(ctx: &Ctx, relative: String, file: std::fs::File, size: u64) -> Result<(String, String), String> {
    if !ctx.limit.take_bytes(usize::try_from(size).unwrap_or(usize::MAX)) {
        return Err(SPENT.into());
    }
    let mut bytes = Vec::new();
    // A file that grew since is read only as far as it was.
    file.take(size).read_to_end(&mut bytes).map_err(|_| UNREADABLE.to_owned())?;
    if bytes.contains(&0) {
        return Err(BINARY.into());
    }
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(invalid) => {
            let text = String::from_utf8_lossy(invalid.as_bytes()).into_owned();
            if !ctx.limit.take_bytes(text.len()) {
                return Err(SPENT.into());
            }
            text
        }
    };
    Ok((relative, text))
}

/// Lines of one read, taken from a stream so a range of a large file holds only that range.
#[derive(Default)]
struct Streamed {
    lines: Vec<String>,
    /// Lines in the whole file.
    total: usize,
    /// Lines in the range longer than a read shows.
    clipped: usize,
    /// The call's allowance ran out: later lines are counted, not kept.
    full: bool,
}

impl Streamed {
    /// `keep` takes a kept line's bytes from the call's allowance; past it lines are counted only.
    fn end_line(&mut self, line: &mut Vec<u8>, wanted: bool, keep: &dyn Fn(usize) -> bool) {
        self.total += 1;
        if wanted {
            let text = String::from_utf8_lossy(line);
            self.clipped += usize::from(text.chars().nth(READ_LINE_CHARS).is_some());
            if self.lines.len() < MAX_READ_LINES && !self.full {
                let text = clip(&text, READ_LINE_CHARS);
                self.full = !keep(text.len());
                if !self.full {
                    self.lines.push(text);
                }
            }
        }
        line.clear();
    }
}

/// Lines `from..=to` of `reader` and its line count; a NUL anywhere makes it binary. At most
/// `KEEP_BYTES` of a line are held, enough to know it is clipped.
fn stream_lines(mut reader: impl BufRead, from: usize, to: usize, keep: &dyn Fn(usize) -> bool) -> Result<Streamed, String> {
    const KEEP_BYTES: usize = READ_LINE_CHARS * 4 + 1;
    let mut out = Streamed::default();
    let (mut line, mut open) = (Vec::new(), false);
    loop {
        let chunk = reader.fill_buf().map_err(|_| UNREADABLE.to_owned())?;
        if chunk.is_empty() {
            break;
        }
        if chunk.contains(&0) {
            return Err(BINARY.into());
        }
        let used = chunk.len();
        let mut rest = chunk;
        while !rest.is_empty() {
            let wanted = (from..=to).contains(&(out.total + 1));
            let end = rest.iter().position(|&b| b == b'\n');
            let part = &rest[..end.unwrap_or(rest.len())];
            if wanted {
                line.extend_from_slice(&part[..part.len().min(KEEP_BYTES.saturating_sub(line.len()))]);
            }
            open = end.is_none();
            if end.is_some() {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                out.end_line(&mut line, wanted, keep);
                rest = &rest[part.len() + 1..];
            } else {
                rest = &[];
            }
        }
        reader.consume(used);
    }
    if open {
        let wanted = (from..=to).contains(&(out.total + 1));
        out.end_line(&mut line, wanted, keep);
    }
    Ok(out)
}

/// A file's text read for its outline. Run in the order asked, so the allowance goes to the
/// first requests whichever thread would finish first.
pub(super) fn outline_text(ctx: &Ctx, raw: &str) -> Result<(String, String), String> {
    let (relative, file, size) = open_named(ctx, raw)?;
    // Before reading: a file with no outline takes nothing from the allowance.
    if !symbols::supported(&relative) {
        return Err(format!("No outline for this file type; read it instead. Outlines cover {}.", symbols::SUPPORTED));
    }
    read_opened(ctx, relative, file, size)
}

pub(super) fn outline_item(ctx: &Ctx, raw: &str, read: Result<(String, String), String>) -> Item {
    let (path, text) = match read {
        Ok(found) => found,
        Err(error) => return Item::error(Category::Outline, raw, error),
    };
    let symbols = symbols::extract(&path, &text, ctx.limit);
    let mut open: Vec<usize> = Vec::new();
    let lines = symbols.iter().map(|symbol| {
        open.retain(|&end| end >= symbol.end);
        let line = format!("{}{}", "  ".repeat(open.len()), super::grep::symbol_label(symbol));
        open.push(symbol.end);
        line
    });
    let lines = plain_lines(lines.collect::<Vec<_>>());
    Item::new(Category::Outline, head(&[("path", json!(path)), ("total_lines", json!(text.lines().count()))]), Body::Lines(lines))
}

#[derive(Debug, PartialEq)]
enum Span<'a> {
    Whole,
    Lines(usize, Option<usize>),
    /// A location such as `path:42`, `path:42:13` or grep's `path:42:text`: lines around it.
    Around(usize),
    Symbol(&'a str),
}

/// `10-40`, `10-`, or a line number followed by nothing or by `:` and anything.
fn line_range(range: &str) -> Option<Span<'static>> {
    let digits = range.find(|c: char| !c.is_ascii_digit()).unwrap_or(range.len());
    let from = range[..digits].parse::<usize>().ok()?;
    match &range[digits..] {
        "" => Some(Span::Around(from)),
        rest if rest.starts_with(':') => Some(Span::Around(from)),
        rest => match rest.strip_prefix('-')? {
            "" => Some(Span::Lines(from, None)),
            to => Some(Span::Lines(from, Some(to.parse().ok()?))),
        },
    }
}

/// `path:10-40`, `path:10-`, `path:42` (and `:42:13`), `path#symbol`, `path#Type::symbol` or a
/// plain path. A file whose real name has such a suffix wins.
/// Whether `raw` names a file as it stands, checked inside the project before it is looked at.
pub(super) fn whole_file(ctx: &Ctx, raw: &str) -> bool {
    resolve_named(ctx, raw).is_ok_and(|(_, target)| target.is_file())
}

fn parse_read<'a>(raw: &'a str, whole_file: impl Fn(&str) -> bool) -> Result<(&'a str, Span<'a>), String> {
    if whole_file(raw) {
        return Ok((raw, Span::Whole));
    }
    let located = raw.match_indices(':').find_map(|(at, _)| Some((at, line_range(&raw[at + 1..])?)));
    if let Some((at, span)) = located {
        let bad = match span {
            Span::Lines(from, to) => from == 0 || to.is_some_and(|to| to < from),
            Span::Around(line) => line == 0,
            _ => false,
        };
        if bad {
            return Err(format!("Bad line range: {}", &raw[at + 1..]));
        }
        return Ok((&raw[..at], span));
    }
    if let Some((path, symbol)) = raw.rsplit_once('#') {
        if !symbol.is_empty() && !symbol.contains('/') {
            return Ok((path, Span::Symbol(symbol)));
        }
    }
    Ok((raw, Span::Whole))
}

/// `run()`, `run(_:)`, `Foo::run`, `Foo.run`, `Foo#run`: the name and its last qualifier.
pub(super) fn split_name(raw: &str) -> (Option<&str>, &str) {
    let raw = raw.split('(').next().unwrap_or(raw).trim();
    let is_separator = |c: char| matches!(c, '.' | ':' | '#');
    let Some(at) = raw.rfind(is_separator) else { return (None, raw) };
    let qualifier = raw[..at].trim_end_matches(is_separator);
    let qualifier = qualifier.rsplit(is_separator).next().filter(|part| !part.is_empty());
    (qualifier, &raw[at + 1..])
}

/// The one definition `raw` names, or the ranges to choose from.
fn symbol_range(symbols: &[Symbol], raw: &str) -> Result<(usize, usize), SymbolMiss> {
    let (qualifier, name) = split_name(raw);
    let found: Vec<&Symbol> = symbols.iter().filter(|symbol| symbol.name == name && qualifier.is_none_or(|q| symbols::qualified_by(symbols, symbol, q))).collect();
    match found.as_slice() {
        [] => Err(SymbolMiss::None),
        [one] => Ok((one.line, one.end)),
        many => Err(SymbolMiss::Ambiguous(many.len(), many.iter().take(AMBIGUOUS_LISTED).map(|symbol| super::grep::symbol_label(symbol)).collect())),
    }
}

enum SymbolMiss {
    None,
    Ambiguous(usize, Vec<String>),
}

/// A read with its file taken in the order asked: done, or a `path#name` read's whole text,
/// whose symbols are found afterwards in parallel.
pub(super) enum ReadStep {
    Done(Item),
    Symbol { path: String, text: String, name: String },
}

pub(super) fn read_step(ctx: &Ctx, raw: &str) -> ReadStep {
    read_span(ctx, raw).unwrap_or_else(|error| ReadStep::Done(Item::error(Category::Read, raw, error)))
}

pub(super) fn read_item(ctx: &Ctx, raw: &str, step: ReadStep) -> Item {
    match step {
        ReadStep::Done(item) => item,
        ReadStep::Symbol { path, text, name } => symbol_read(ctx, path, &text, &name).unwrap_or_else(|error| Item::error(Category::Read, raw, error)),
    }
}

fn read_span(ctx: &Ctx, raw: &str) -> Result<ReadStep, String> {
    let (path, span) = parse_read(raw, |raw| whole_file(ctx, raw))?;
    let (from, to, upper) = match span {
        Span::Whole => (1, usize::MAX, None),
        Span::Lines(from, to) => (from, to.unwrap_or(usize::MAX), to),
        Span::Around(line) => (line.saturating_sub(AROUND_BEFORE).max(1), line + AROUND_AFTER, Some(line + AROUND_AFTER)),
        Span::Symbol(name) => {
            let (path, file, size) = open_named(ctx, path)?;
            // Before reading: a file with no definitions to find takes nothing.
            if !symbols::supported(&path) {
                return Err(format!("No definitions are found in this file type; read it instead ({path} or {path}:from-to)."));
            }
            let (path, text) = read_opened(ctx, path, file, size)?;
            return Ok(ReadStep::Symbol { path, text, name: name.to_owned() });
        }
    };
    let (path, file, _) = open_named(ctx, path)?;
    let streamed = stream_lines(BufReader::new(file), from, to, &|bytes| ctx.limit.take_bytes(bytes))?;
    let first = if let Span::Around(line) = span { line } else { from };
    read_item_of(path, streamed, (first, from, to), upper).map(ReadStep::Done)
}

fn symbol_read(ctx: &Ctx, path: String, text: &str, name: &str) -> Result<Item, String> {
    let (from, to) = match symbol_range(&symbols::extract(&path, text, ctx.limit), name) {
        Ok(range) => range,
        Err(SymbolMiss::None) => return Err(format!("No definition named {name} here; outline the file.")),
        Err(SymbolMiss::Ambiguous(count, ranges)) => return Ok(Item::new(Category::Read, head(&[("path", json!(path)), ("ambiguous", json!(ranges)), ("ambiguous_count", json!(count))]), Body::Nothing)),
    };
    // The whole text was taken from the allowance already.
    let streamed = stream_lines(text.as_bytes(), from, to, &|_| true)?;
    read_item_of(path, streamed, (from, from, to), Some(to))
}

/// `first` is the line that must exist; `from..=to` is what is shown of it.
fn read_item_of(path: String, streamed: Streamed, (first, from, to): (usize, usize, usize), upper: Option<usize>) -> Result<Item, String> {
    let Streamed { lines, total, clipped, .. } = streamed;
    if first > total.max(1) {
        return Err(format!("Line {first} is past the end of this file ({total} lines)."));
    }
    let to = to.min(total);
    let shown = plain_lines(lines.into_iter().enumerate().map(|(at, line)| format!("{}:{line}", from + at)).collect::<Vec<_>>());
    let mut item = Item::new(Category::Read, head(&[("path", json!(path)), ("from", json!(from)), ("to", json!(to)), ("total_lines", json!(total))]), Body::Lines(shown));
    item.total_lines = (to + 1).saturating_sub(from);
    item.clipped_lines = clipped;
    item.read = Some(ReadSpan { path, first: from, upper });
    Ok(item)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_requests_parse() {
        for (raw, path, span) in [
            ("a.rs", "a.rs", Span::Whole),
            ("a.rs:10-40", "a.rs", Span::Lines(10, Some(40))),
            ("a.rs:125:155", "a.rs", Span::Around(125)),
            ("a.rs:10-", "a.rs", Span::Lines(10, None)),
            ("a.rs:10", "a.rs", Span::Around(10)),
            ("a.rs:42:13:", "a.rs", Span::Around(42)),
            ("a.rs:42:fn x", "a.rs", Span::Around(42)),
            ("C:/a.rs:7", "C:/a.rs", Span::Around(7)),
            ("C#/foo.cs:2-3", "C#/foo.cs", Span::Lines(2, Some(3))),
            ("C#/foo.cs", "C#/foo.cs", Span::Whole),
            ("a.rs#run", "a.rs", Span::Symbol("run")),
            ("a.rs#Foo::run", "a.rs", Span::Symbol("Foo::run")),
            ("a.rs#run()", "a.rs", Span::Symbol("run()")),
            ("a.swift#run(_:)", "a.swift", Span::Symbol("run(_:)")),
            ("a.rs:42:13", "a.rs", Span::Around(42)),
        ] {
            assert_eq!(parse_read(raw, |_| false).unwrap(), (path, span), "{raw}");
        }
        for raw in ["a.rs:5-1", "a.rs:0", "a.rs:0:3"] {
            assert!(parse_read(raw, |_| false).is_err(), "{raw}");
        }
        assert_eq!(parse_read("a.rs:3", |raw| raw == "a.rs:3").unwrap(), ("a.rs:3", Span::Whole), "a file with that very name wins");
    }

    #[test]
    fn a_read_keeps_at_most_its_line_cap() {
        let streamed = stream_lines("a\n".repeat(MAX_READ_LINES + 5).as_bytes(), 1, usize::MAX, &|_| true).unwrap();
        assert_eq!((streamed.lines.len(), streamed.total), (MAX_READ_LINES, MAX_READ_LINES + 5));
    }

    #[test]
    fn names_split_into_qualifier_and_name() {
        for (raw, expected) in [("run", (None, "run")), ("run()", (None, "run")), ("run(_:)", (None, "run")), ("Foo::run", (Some("Foo"), "run")), ("a::Foo::run", (Some("Foo"), "run")), ("Foo.run", (Some("Foo"), "run")), ("Foo#run()", (Some("Foo"), "run"))] {
            assert_eq!(split_name(raw), expected, "{raw}");
        }
    }
}
