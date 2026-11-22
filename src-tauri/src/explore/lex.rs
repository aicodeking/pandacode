//! One pass over a source file: which lines start inside a string or comment, and the brace and
//! paren depth around each line. Strings and comments must not count, and one mistaken literal
//! must not poison the rest of the file.
use super::limit::Limit;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(super) enum Language {
    Rust,
    Script,
    Python,
    Go,
    Java,
    Kotlin,
    Swift,
    CFamily,
    Ruby,
    Php,
    Shell,
}

pub(super) const SIGNATURE_LOOKAHEAD: usize = 12;
pub(super) const LIMIT_CHECK_LINES: usize = 4_096;
pub(super) const LIMIT_CHECK_BYTES: usize = 65_536;
const MAX_REGEX_LITERAL: usize = 2_048;
const MAX_FAILED_REGEX_SCAN: usize = 4_096;
/// A string left open this many lines, then a line that starts a definition at column 0, was
/// mis-read. Shorter multi-line templates may well hold code at column 0.
const RESYNC_AFTER: usize = 30;
const DEFINITION_STARTS: &[&str] = &["fn ", "pub ", "pub(", "impl ", "impl<", "struct ", "enum ", "trait ", "mod ", "use ", "#[", "function ", "export ", "class ", "interface ", "const ", "async ", "func ", "type ", "def "];
/// Words after which a `/` starts a regex rather than a division.
const REGEX_AFTER_WORDS: &[&str] = &["return", "typeof", "case", "in", "of", "do", "else", "void", "yield", "await", "delete", "throw"];

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Code,
    Block,
    Str(u8),
    /// `"""` or `'''`.
    Triple(u8),
    /// A Rust raw string, closed by a quote and this many hashes.
    Raw(usize),
}

struct Syntax {
    slash_comments: bool,
    hash_comments: bool,
    char_literals: bool,
    raw_strings: bool,
    regex_literals: bool,
    triple_quotes: &'static [u8],
    /// Whether a plain string may run on to the next line.
    spanning: bool,
    templates: bool,
}

fn syntax_of(language: Language) -> Syntax {
    use Language::*;
    let triple_quotes: &[u8] = match language {
        Python => b"\"'",
        Swift | Java | Kotlin => b"\"",
        _ => b"",
    };
    Syntax {
        slash_comments: !matches!(language, Python | Shell | Ruby),
        hash_comments: matches!(language, Shell | Php | Python | Ruby),
        char_literals: !matches!(language, Script | Shell | Php | Python | Ruby),
        raw_strings: language == Rust,
        regex_literals: language == Script,
        triple_quotes,
        spanning: matches!(language, Rust | Shell | Php),
        templates: language == Script,
    }
}

/// State of the scan that lasts from line to line, plus what the current line did.
#[derive(Default)]
struct Scanner {
    depth: i32,
    peak: i32,
    parens: i32,
    semicolon: bool,
    /// Brace depth at each open `${` of a template string.
    template_stack: Vec<i32>,
}

/// Lazily cached quote positions and the total failed regex lookahead on this line.
struct LineScan<'a> {
    limit: &'a Limit,
    failed_regex_bytes: usize,
    quote_ends: Option<QuoteEnds>,
}

#[derive(Default)]
struct QuoteEnds {
    apostrophe: Option<usize>,
    backtick: Option<usize>,
    non_space: Option<usize>,
}

impl LineScan<'_> {
    /// JSX text such as `It`s` or `Can't`: a quote after a word with no later partner.
    /// A `'` between letters is always text. Cache the ends so quote checks and trailing
    /// whitespace checks take constant time after one cancellable pass over the line.
    fn stray_quote(&mut self, line: &[u8], at: usize) -> Option<bool> {
        if at == 0 || !line[at - 1].is_ascii_alphanumeric() {
            return Some(false);
        }
        if line[at] == b'\'' && line.get(at + 1).is_some_and(u8::is_ascii_alphabetic) {
            return Some(true);
        }
        if self.quote_ends.is_none() {
            let mut ends = QuoteEnds::default();
            for (chunk_index, chunk) in line.chunks(LIMIT_CHECK_BYTES).enumerate() {
                if self.limit.expired() {
                    return None;
                }
                for (offset, &byte) in chunk.iter().enumerate() {
                    let index = chunk_index * LIMIT_CHECK_BYTES + offset;
                    match byte {
                        b'\'' => ends.apostrophe = Some(index),
                        b'`' => ends.backtick = Some(index),
                        _ => {}
                    }
                    if !byte.is_ascii_whitespace() {
                        ends.non_space = Some(index);
                    }
                }
            }
            self.quote_ends = Some(ends);
        }
        let ends = self.quote_ends.as_ref().expect("quote positions cached");
        let last = if line[at] == b'\'' { ends.apostrophe } else { ends.backtick };
        Some(ends.non_space > Some(at) && last <= Some(at))
    }
}

impl Scanner {
    fn close_brace(&mut self, mode: &mut Mode) {
        if self.template_stack.last() == Some(&self.depth) {
            self.template_stack.pop();
            *mode = Mode::Str(b'`');
        } else {
            self.depth -= 1;
        }
    }

    fn string_byte(&mut self, line: &[u8], at: &mut usize, c: u8, quote: u8, mode: &mut Mode, syntax: &Syntax) {
        if c == b'\\' {
            *at += 1;
        } else if c == quote {
            *mode = Mode::Code;
        } else if syntax.templates && quote == b'`' && c == b'$' && line.get(*at) == Some(&b'{') {
            *at += 1;
            self.template_stack.push(self.depth);
            *mode = Mode::Code;
        }
    }

    /// One byte of code. False when the line is a comment or the scan has expired.
    fn code_byte(&mut self, line: &[u8], at: &mut usize, previous: Option<u8>, mode: &mut Mode, syntax: &Syntax, scan: &mut LineScan<'_>) -> bool {
        let (c, next) = (line[*at - 1], line.get(*at).copied());
        match c {
            b'/' if syntax.slash_comments && next == Some(b'/') && !(syntax.templates && after_url_scheme(line, *at - 1)) => return false,
            b'#' if syntax.hash_comments && (*at == 1 || line[*at - 2].is_ascii_whitespace()) => return false,
            b'/' if syntax.slash_comments && next == Some(b'*') => {
                *mode = Mode::Block;
                *at += 1;
            }
            b'/' if syntax.regex_literals && scan.failed_regex_bytes < MAX_FAILED_REGEX_SCAN && regex_may_follow(line, *at - 1, previous) => {
                let bytes = (MAX_FAILED_REGEX_SCAN - scan.failed_regex_bytes).min(MAX_REGEX_LITERAL).min(line.len() - (*at - 1));
                if let Some(end) = regex_literal_end(line, *at - 1, bytes) {
                    *at = end;
                } else {
                    scan.failed_regex_bytes += bytes;
                }
            }
            b'r' if syntax.raw_strings && raw_string_opens(line, *at - 1).is_some() => {
                let hashes = raw_string_opens(line, *at - 1).unwrap_or(0);
                *mode = Mode::Raw(hashes);
                *at += hashes + 1;
            }
            b'"' | b'\'' if syntax.triple_quotes.contains(&c) && line[*at..].starts_with(&[c, c]) => {
                *mode = Mode::Triple(c);
                *at += 2;
            }
            b'`' | b'\'' if syntax.templates => {
                let Some(stray) = scan.stray_quote(line, *at - 1) else { return false };
                if !stray {
                    *mode = Mode::Str(c);
                }
            }
            b'"' | b'`' => *mode = Mode::Str(c),
            b'\'' if syntax.char_literals => *at += char_literal_len(&line[*at..]).unwrap_or(0),
            b'\'' => *mode = Mode::Str(c),
            b'{' => {
                self.depth += 1;
                self.peak = self.peak.max(self.depth);
            }
            b'}' => self.close_brace(mode),
            b'(' | b'[' => self.parens += 1,
            b')' | b']' => self.parens -= 1,
            b';' if self.parens <= 0 => self.semicolon = true,
            _ => {}
        }
        true
    }

    fn scan_line(&mut self, line: &[u8], mode: &mut Mode, syntax: &Syntax, limit: &Limit) -> bool {
        let mut scan = LineScan { limit, failed_regex_bytes: 0, quote_ends: None };
        let (mut at, mut previous, mut next_check) = (0, None, 0);
        while at < line.len() {
            if at >= next_check {
                if limit.expired() {
                    return false;
                }
                next_check = at + LIMIT_CHECK_BYTES;
            }
            let c = line[at];
            at += 1;
            match *mode {
                Mode::Code => {
                    if !self.code_byte(line, &mut at, previous, mode, syntax, &mut scan) {
                        return !limit.expired();
                    }
                }
                Mode::Block if c == b'*' && line.get(at) == Some(&b'/') => {
                    *mode = Mode::Code;
                    at += 1;
                }
                Mode::Block => {}
                Mode::Str(quote) => self.string_byte(line, &mut at, c, quote, mode, syntax),
                Mode::Triple(quote) if c == quote && line[at..].starts_with(&[quote, quote]) => {
                    *mode = Mode::Code;
                    at += 2;
                }
                Mode::Triple(_) => {}
                Mode::Raw(hashes) if c == b'"' && line[at..].iter().take_while(|&&b| b == b'#').count() >= hashes => {
                    *mode = Mode::Code;
                    at += hashes;
                }
                Mode::Raw(_) => {}
            }
            if !c.is_ascii_whitespace() {
                previous = Some(c);
            }
        }
        true
    }
}

/// `https://host` in JSX text is not a comment: a scheme of letters right before the slashes,
/// and a host right after them (`default:// note` is a label and a comment).
fn after_url_scheme(line: &[u8], slash: usize) -> bool {
    let before = &line[..slash];
    let Some(scheme) = before.strip_suffix(b":") else { return false };
    let letters = scheme.iter().rev().take_while(|b| b.is_ascii_alphabetic()).count();
    letters >= 2 && line.get(slash + 2).is_some_and(|b| b.is_ascii_alphanumeric())
}

/// Hashes of a raw string opening at this `r`, as in `r"` or `br##"`; a name like `for"` is none.
fn raw_string_opens(line: &[u8], at: usize) -> Option<usize> {
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let before = at.checked_sub(1).map(|i| line[i]);
    let bare = before.is_none_or(|b| !word(b));
    let byte = before == Some(b'b') && (at < 2 || !word(line[at - 2]));
    if !bare && !byte {
        return None;
    }
    let hashes = line[at + 1..].iter().take_while(|&&b| b == b'#').count();
    (line.get(at + 1 + hashes) == Some(&b'"')).then_some(hashes)
}

/// Where a JS regex literal starting at `/` ends on this line, if it does.
fn regex_literal_end(line: &[u8], open: usize, bytes: usize) -> Option<usize> {
    let (mut at, mut in_class) = (open + 1, false);
    let end = line.len().min(open + bytes.min(MAX_REGEX_LITERAL));
    while at < end {
        match line[at] {
            b'\\' => at += 1,
            b'[' => in_class = true,
            b']' => in_class = false,
            b'/' if !in_class => return Some(at + 1),
            _ => {}
        }
        at += 1;
    }
    None
}

/// A `/` after an operator or a keyword starts a regex; after a name, number or `)` it divides.
fn regex_may_follow(line: &[u8], slash: usize, previous: Option<u8>) -> bool {
    let Some(previous) = previous else { return true };
    if b"(=,:!&|?{;[+-~^%".contains(&previous) {
        return true;
    }
    let text = line[..slash].trim_ascii_end();
    REGEX_AFTER_WORDS.iter().any(|word| text.ends_with(word.as_bytes()) && !text[..text.len() - word.len()].last().is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'.'))
}

/// Bytes after an opening `'` that finish a char literal, or None for a Rust lifetime.
fn char_literal_len(rest: &[u8]) -> Option<usize> {
    let first = *rest.first()?;
    if first == b'\\' {
        return rest.iter().skip(1).take(10).position(|&b| b == b'\'').map(|p| p + 2);
    }
    let width = match first {
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => 1,
    };
    (first != b'\'' && rest.get(width) == Some(&b'\'')).then_some(width + 1)
}

/// The closing word of a shell heredoc opened on this line: `<<EOF`, `<<-'EOF'`.
fn heredoc_word(line: &str) -> Option<String> {
    let (_, rest) = line.split_once("<<")?;
    if rest.starts_with('<') {
        return None;
    }
    let rest = rest.strip_prefix('-').unwrap_or(rest).trim_start();
    let rest = rest.strip_prefix(['\'', '"']).unwrap_or(rest);
    let word: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    (!word.is_empty()).then_some(word)
}

#[derive(Default)]
pub(super) struct Lexed {
    pub(super) inside_literal: Vec<bool>,
    pub(super) depth_before: Vec<i32>,
    pub(super) depth_after: Vec<i32>,
    pub(super) peak: Vec<i32>,
    pub(super) parens_before: Vec<i32>,
    pub(super) parens_after: Vec<i32>,
    pub(super) has_semicolon: Vec<bool>,
}

impl Lexed {
    pub(super) fn new(lines: &[&str], language: Language, limit: &Limit) -> Self {
        let syntax = syntax_of(language);
        let mut mode = Mode::Code;
        let mut scanner = Scanner::default();
        if limit.expired() {
            return Self::default();
        }
        // Exact capacities keep the scratch reservation valid as each vector fills.
        let mut lexed = Self {
            inside_literal: Vec::with_capacity(lines.len()),
            depth_before: Vec::with_capacity(lines.len()),
            depth_after: Vec::with_capacity(lines.len()),
            peak: Vec::with_capacity(lines.len()),
            parens_before: Vec::with_capacity(lines.len()),
            parens_after: Vec::with_capacity(lines.len()),
            has_semicolon: Vec::with_capacity(lines.len()),
        };
        let (mut open_for, mut heredoc): (usize, Option<String>) = (0, None);
        for (index, line) in lines.iter().enumerate() {
            if index.is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
                break;
            }
            if let Some(word) = &heredoc {
                let closes = line.trim() == word;
                lexed.record_literal_line(&scanner);
                if closes {
                    heredoc = None;
                }
                continue;
            }
            open_for = if matches!(mode, Mode::Str(_)) { open_for + 1 } else { 0 };
            if open_for > RESYNC_AFTER && DEFINITION_STARTS.iter().any(|start| line.starts_with(start)) {
                mode = Mode::Code;
                scanner.template_stack.clear();
            }
            let (inside_literal, depth_before, parens_before) = (mode != Mode::Code, scanner.depth, scanner.parens);
            scanner.peak = scanner.depth;
            scanner.semicolon = false;
            if !scanner.scan_line(line.as_bytes(), &mut mode, &syntax, limit) {
                break;
            }
            lexed.inside_literal.push(inside_literal);
            lexed.depth_before.push(depth_before);
            lexed.parens_before.push(parens_before);
            if matches!(mode, Mode::Str(b'"' | b'\'')) && !syntax.spanning {
                mode = Mode::Code;
            }
            lexed.depth_after.push(scanner.depth);
            lexed.peak.push(scanner.peak);
            lexed.parens_after.push(scanner.parens);
            lexed.has_semicolon.push(scanner.semicolon);
            if language == Language::Shell && mode == Mode::Code {
                heredoc = heredoc_word(line);
            }
        }
        lexed
    }

    fn record_literal_line(&mut self, scanner: &Scanner) {
        self.inside_literal.push(true);
        self.depth_before.push(scanner.depth);
        self.depth_after.push(scanner.depth);
        self.peak.push(scanner.depth);
        self.parens_before.push(scanner.parens);
        self.parens_after.push(scanner.parens);
        self.has_semicolon.push(false);
    }
}

/// Whether a declaration with no `{` yet carries on past this line.
pub(super) fn signature_continues(lines: &[&str], index: usize) -> bool {
    let current = lines[index].trim_end();
    let next = lines.get(index + 1).map_or("", |line| line.trim_start());
    ["(", ",", "=", "->", "=>", ":", "|", "&", "where"].iter().any(|tail| current.ends_with(tail))
        || ["{", "where", ":", "->", "=", "extends", "implements", "throws", "|", "&", ","].iter().any(|head| next.starts_with(head))
}

pub(super) fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}
