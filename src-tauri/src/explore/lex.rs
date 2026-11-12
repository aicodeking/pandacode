//! One pass over a source file: which lines start inside a string or comment, and the brace and
//! paren depth around each line. Strings and comments must not count, and one mistaken literal
//! must not poison the rest of the file.

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

const SIGNATURE_LOOKAHEAD: usize = 12;
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

    /// One byte of code. False when the rest of the line is a comment.
    fn code_byte(&mut self, line: &[u8], at: &mut usize, previous: Option<u8>, mode: &mut Mode, syntax: &Syntax) -> bool {
        let (c, next) = (line[*at - 1], line.get(*at).copied());
        match c {
            b'/' if syntax.slash_comments && next == Some(b'/') && !(syntax.templates && after_url_scheme(line, *at - 1)) => return false,
            b'#' if syntax.hash_comments && (*at == 1 || line[*at - 2].is_ascii_whitespace()) => return false,
            b'/' if syntax.slash_comments && next == Some(b'*') => {
                *mode = Mode::Block;
                *at += 1;
            }
            b'/' if syntax.regex_literals && regex_may_follow(line, *at - 1, previous) => {
                *at = regex_literal_end(line, *at - 1).unwrap_or(*at);
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
            b'`' | b'\'' if syntax.templates && stray_quote(line, *at - 1) => {}
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

    fn scan_line(&mut self, line: &[u8], mode: &mut Mode, syntax: &Syntax) {
        let (mut at, mut previous) = (0, None);
        while at < line.len() {
            let c = line[at];
            at += 1;
            match *mode {
                Mode::Code => {
                    if !self.code_byte(line, &mut at, previous, mode, syntax) {
                        return;
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
    }
}

/// JSX text such as `It`s` or `Can't`: a quote right after a word, with text after it and no
/// partner on the line. A tagged template either closes on its line or ends the line. A `'`
/// between two letters is always text: no string starts right after a name.
fn stray_quote(line: &[u8], at: usize) -> bool {
    let after_word = at > 0 && line[at - 1].is_ascii_alphanumeric();
    let rest = &line[at + 1..];
    let inside_word = line[at] == b'\'' && rest.first().is_some_and(u8::is_ascii_alphabetic);
    after_word && (inside_word || (!rest.trim_ascii().is_empty() && !rest.contains(&line[at])))
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
fn regex_literal_end(line: &[u8], open: usize) -> Option<usize> {
    let (mut at, mut in_class) = (open + 1, false);
    while at < line.len() {
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
    depth_before: Vec<i32>,
    depth_after: Vec<i32>,
    peak: Vec<i32>,
    parens_before: Vec<i32>,
    parens_after: Vec<i32>,
    has_semicolon: Vec<bool>,
    /// For each line, the next line whose depth is lower, which makes finding a block's end linear.
    next_lower: Vec<u32>,
}

impl Lexed {
    pub(super) fn new(lines: &[&str], language: Language) -> Self {
        let syntax = syntax_of(language);
        let mut mode = Mode::Code;
        let mut scanner = Scanner::default();
        let mut lexed = Self::default();
        let (mut open_for, mut heredoc): (usize, Option<String>) = (0, None);
        for line in lines {
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
            lexed.inside_literal.push(mode != Mode::Code);
            lexed.depth_before.push(scanner.depth);
            lexed.parens_before.push(scanner.parens);
            scanner.peak = scanner.depth;
            scanner.semicolon = false;
            scanner.scan_line(line.as_bytes(), &mut mode, &syntax);
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
        lexed.next_lower = next_lower(&lexed.depth_after);
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

    /// The line closing the block this definition opens, or the line ending a declaration
    /// that has no body. Only the signature is looked through line by line.
    pub(super) fn block_end(&self, lines: &[&str], start: usize) -> usize {
        let base = self.depth_before[start];
        for index in start..lines.len().min(start + SIGNATURE_LOOKAHEAD + 1) {
            if self.peak[index] > base {
                return self.closing_line(index, base);
            }
            let in_parens = self.parens_after[index] > self.parens_before[start];
            if self.has_semicolon[index] || !(in_parens || signature_continues(lines, index)) {
                return index;
            }
        }
        (start + SIGNATURE_LOOKAHEAD).min(lines.len().saturating_sub(1))
    }

    fn closing_line(&self, mut index: usize, base: i32) -> usize {
        while self.depth_after[index] > base {
            match self.next_lower[index] as usize {
                next if next < self.depth_after.len() => index = next,
                _ => return self.depth_after.len() - 1,
            }
        }
        index
    }

    /// Python: the last code line before indentation returns to the definition's level. A line
    /// inside a string or a bracket, or a comment, never ends a block.
    pub(super) fn indent_end(&self, lines: &[&str], start: usize) -> usize {
        let indent = indent_of(lines[start]);
        let mut end = start;
        for (offset, line) in lines[start..].iter().enumerate() {
            let index = start + offset;
            let trimmed = line.trim();
            if self.inside_literal[index] && offset > 0 {
                end = index;
                continue;
            }
            if trimmed.is_empty() || (offset > 0 && trimmed.starts_with('#')) {
                continue;
            }
            let in_brackets = self.parens_before[index] > self.parens_before[start];
            if offset > 0 && !in_brackets && indent_of(line) <= indent {
                break;
            }
            end = index;
        }
        end
    }
}

fn next_lower(depths: &[i32]) -> Vec<u32> {
    let mut next = vec![u32::MAX; depths.len()];
    let mut stack: Vec<usize> = Vec::new();
    for at in (0..depths.len()).rev() {
        while stack.last().is_some_and(|&later| depths[later] >= depths[at]) {
            stack.pop();
        }
        if let Some(&later) = stack.last() {
            next[at] = later as u32;
        }
        stack.push(at);
    }
    next
}

/// Whether a declaration with no `{` yet carries on past this line.
fn signature_continues(lines: &[&str], index: usize) -> bool {
    let current = lines[index].trim_end();
    let next = lines.get(index + 1).map_or("", |line| line.trim_start());
    ["(", ",", "=", "->", "=>", ":", "|", "&", "where"].iter().any(|tail| current.ends_with(tail))
        || ["{", "where", ":", "->", "=", "extends", "implements", "throws", "|", "&", ","].iter().any(|head| next.starts_with(head))
}

pub(super) fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}
