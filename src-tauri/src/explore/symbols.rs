//! Line-based definition extraction: one rule table per language, with block ends from the
//! lexer (braces, indentation) or a matching `end`. Good enough to label a hit and to outline a
//! file; a macro or an odd layout can produce a wrong or missing entry.
use super::{
    lex::{indent_of, signature_continues, Language, Lexed, LIMIT_CHECK_BYTES, LIMIT_CHECK_LINES, SIGNATURE_LOOKAHEAD},
    limit::Limit,
};
use regex::{Regex, RegexSet};
use std::{
    collections::{BinaryHeap, HashMap},
    sync::OnceLock,
};

/// How far ahead a multi-line method's `) {` may be.
const SIGNATURE_LINES: usize = 12;
/// A longer line is minified or data, never a definition worth finding.
const MAX_RULE_LINE: usize = 2_000;
/// One line slice, two flags and five depths, rounded up for allocation alignment.
pub(super) const LINE_METADATA_BYTES: usize = (size_of::<&str>() + 2 * size_of::<bool>() + 5 * size_of::<i32>()).next_multiple_of(8);

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Symbol {
    pub(super) name: String,
    pub(super) kind: &'static str,
    pub(super) line: usize,
    pub(super) end: usize,
}

pub(super) const SUPPORTED: &str = "Rust, TypeScript/JavaScript, Python, Go, Java, Kotlin, Swift, C/C++, Ruby, PHP and shell";
/// A rule whose line must be confirmed by a later `) {`, then named `method`.
const OPEN_METHOD: &str = "method-open";

const MODS_TS: &str = r"(?:(?:public|private|protected|static|async|readonly|override|abstract|declare|get|set)\s+)*";
const MODS_JAVA: &str = r"(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp|sealed|non-sealed)\s+)*";
const MODS_KOTLIN: &str = r"(?:(?:public|private|protected|internal|open|abstract|final|sealed|data|enum|inline|value|annotation|override|suspend|operator|companion|tailrec|infix|external|expect|actual)\s+)*";
const MODS_SWIFT: &str = r"(?:(?:public|private|fileprivate|internal|open|final|static|class|override|mutating|nonmutating|indirect|convenience|required|lazy|weak|nonisolated|@\w+(?:\([^)]*\))?)\s+)*";
const MODS_PHP: &str = r"(?:(?:public|private|protected|static|final|abstract|readonly)\s+)*";
/// Attributes on the same line, then visibility.
const RUST_LEAD: &str = r"^\s*(?:#!?\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?";

type Rules = Vec<(&'static str, String)>;

fn r(kind: &'static str, pattern: String) -> (&'static str, String) {
    (kind, pattern)
}

fn rules(language: Language) -> Rules {
    match language {
        Language::Rust => rust_rules(),
        Language::Script => script_rules(),
        Language::Python => python_rules(),
        Language::Go => go_rules(),
        Language::Java => java_rules(),
        Language::Kotlin => kotlin_rules(),
        Language::Swift => swift_rules(),
        Language::CFamily => c_family_rules(),
        Language::Ruby => ruby_rules(),
        Language::Php => php_rules(),
        Language::Shell => shell_rules(),
    }
}

fn rust_rules() -> Rules {
    vec![
        r("fn", format!(r#"{RUST_LEAD}(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)"#)),
        r("struct", format!(r"{RUST_LEAD}struct\s+(\w+)")),
        r("enum", format!(r"{RUST_LEAD}enum\s+(\w+)")),
        r("union", format!(r"{RUST_LEAD}union\s+(\w+)")),
        r("trait", format!(r"{RUST_LEAD}(?:unsafe\s+)?(?:auto\s+)?trait\s+(\w+)")),
        r("type", format!(r"{RUST_LEAD}type\s+(\w+)")),
        r("mod", format!(r"{RUST_LEAD}mod\s+(\w+)")),
        r("const", format!(r"{RUST_LEAD}(?:const|static)\s+(?:mut\s+)?(\w+)\s*:")),
        r("macro", r"^\s*(?:#!?\[[^\]]*\]\s*)*macro_rules!\s*(\w+)".into()),
        r("impl", r"^\s*(?:#!?\[[^\]]*\]\s*)*(?:unsafe\s+)?impl(?:<.*?>)?\s+([^{]+?)\s*(?:\bwhere\b.*)?(?:\{.*)?$".into()),
    ]
}

fn script_rules() -> Rules {
    vec![
        r("function", r"^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*(\w+)".into()),
        r("class", r"^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+(\w+)".into()),
        r("interface", r"^\s*(?:export\s+)?(?:declare\s+)?interface\s+(\w+)".into()),
        r("type", r"^\s*(?:export\s+)?(?:declare\s+)?type\s+(\w+)\b".into()),
        r("enum", r"^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+(\w+)".into()),
        r("namespace", r"^\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+(\w+)".into()),
        r("function", r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|(?:<[^>]*>\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>|\(\s*$)".into()),
        r("const", r"^(?:export\s+)?(?:const|let|var)\s+(\w+)".into()),
        r("method", format!(r"^\s+{MODS_TS}\*?#?(\w+)\s*(?:<[^>]*>)?\s*\(.*\)\s*(?::[^{{]+)?\{{\s*$")),
        r("method", r"^\s+(\w+)\s*:\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|\w+)\s*=>)".into()),
        r("method", format!(r"^\s+{MODS_TS}#?(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>")),
        r(OPEN_METHOD, format!(r"^\s+{MODS_TS}\*?#?(\w+)\s*(?:<[^>]*>)?\s*\(\s*$")),
    ]
}

fn python_rules() -> Rules {
    vec![
        r("function", r"^\s*(?:async\s+)?def\s+(\w+)".into()),
        r("class", r"^\s*class\s+(\w+)".into()),
        r("const", r"^([A-Za-z_]\w*)\s*(?::[^=]+)?=[^=]".into()),
    ]
}

fn go_rules() -> Rules {
    vec![
        r("func", r"^func\s+(?:\([^)]*\)\s*)?(\w+)".into()),
        r("type", r"^type\s+(\w+)".into()),
        r("const", r"^(?:const|var)\s+(\w+)".into()),
    ]
}

fn java_rules() -> Rules {
    vec![
        r("class", format!(r"^\s*{MODS_JAVA}(?:class|interface|enum|record|@interface)\s+(\w+)")),
        r("method", format!(r"^\s+{MODS_JAVA}(?:<[^>]*>\s*)?[\w<>\[\],.?]+(?:\s+[\w<>\[\],.?]+)*\s+(\w+)\s*\([^;]*$")),
    ]
}

fn kotlin_rules() -> Rules {
    vec![
        r("class", format!(r"^\s*{MODS_KOTLIN}(?:class|interface|object)\s+(\w+)")),
        r("function", format!(r"^\s*{MODS_KOTLIN}fun\s+(?:<[^>]*>\s*)?(?:[\w.<>?]+\.)?(\w+)")),
        r("const", format!(r"^(?:{MODS_KOTLIN}|const\s+)*(?:val|var)\s+(\w+)")),
        r("type", format!(r"^\s*{MODS_KOTLIN}typealias\s+(\w+)")),
    ]
}

fn swift_rules() -> Rules {
    vec![
        r("function", format!(r"^\s*{MODS_SWIFT}func\s+(\S+?)\s*[(<]")),
        r("class", format!(r"^\s*{MODS_SWIFT}(?:class|struct|enum|protocol|actor|extension)\s+(\w+)")),
        r("type", format!(r"^\s*{MODS_SWIFT}typealias\s+(\w+)")),
        r("function", format!(r"^\s*{MODS_SWIFT}(init)[?!]?\s*[(<]")),
        r("const", format!(r"^{MODS_SWIFT}(?:let|var)\s+(\w+)")),
    ]
}


fn c_family_rules() -> Rules {
    vec![
        r("class", r"^\s*(?:template\s*<.*>\s*)?(?:typedef\s+)?(?:class|struct|union|enum(?:\s+class)?|namespace)\s+(\w+)\s*(?::[^;]*)?\{?\s*$".into()),
        r("macro", r"^\s*#\s*define\s+(\w+)".into()),
        r("type", r"^\s*typedef\b.*?(\w+)\s*;\s*$".into()),
        r("type", r"^\}\s*(\w+)\s*;\s*$".into()),
        r("function", r"^[A-Za-z_][\w\s*:&<>,~]*?[\s*&:]~?(\w+)\s*\([^;]*$".into()),
        r("method", r"^\s+(?:(?:virtual|static|inline|explicit|constexpr|friend)\s+)*(?:[\w:*&<>,~]+\s+)*[*&]*(~?\w+)\s*\([^;{]*\)\s*(?:const\b|override\b|noexcept\b|final\b|\s)*(?::[^;{]*)?\{\s*$".into()),
    ]
}

fn ruby_rules() -> Rules {
    vec![
        r("method", r"^\s*def\s+(?:[\w:]+\.)?([^\s(;.]+)".into()),
        r("class", r"^\s*class\s+(\w+(?:::\w+)*)".into()),
        r("module", r"^\s*module\s+(\w+(?:::\w+)*)".into()),
    ]
}

fn php_rules() -> Rules {
    vec![
        r("function", format!(r"^\s*{MODS_PHP}function\s+&?(\w+)")),
        r("class", format!(r"^\s*{MODS_PHP}(?:class|interface|trait|enum)\s+(\w+)")),
        r("const", format!(r"^\s*{MODS_PHP}const\s+(\w+)")),
    ]
}

fn shell_rules() -> Rules {
    vec![
        r("function", r"^\s*function\s+([\w:.-]+)".into()),
        r("function", r"^\s*([\w:.-]+)\s*\(\s*\)".into()),
    ]
}


struct Table {
    set: RegexSet,
    rules: Vec<(&'static str, Regex)>,
}

fn table(language: Language) -> &'static Table {
    static TABLES: OnceLock<HashMap<Language, Table>> = OnceLock::new();
    let all = TABLES.get_or_init(|| {
        [Language::Rust, Language::Script, Language::Python, Language::Go, Language::Java, Language::Kotlin, Language::Swift, Language::CFamily, Language::Ruby, Language::Php, Language::Shell]
            .into_iter()
            .map(|language| {
                let rules = rules(language);
                let set = RegexSet::new(rules.iter().map(|(_, p)| p)).expect("symbol rules compile");
                let rules = rules.into_iter().map(|(kind, p)| (kind, Regex::new(&p).expect("symbol rule compiles"))).collect();
                (language, Table { set, rules })
            })
            .collect()
    });
    &all[&language]
}

fn language_of(path: &str) -> Option<Language> {
    let name = path.rsplit('/').next().unwrap_or(path);
    language_for_extension(&crate::workspace::extension(name).to_ascii_lowercase())
}

pub(super) fn language_for_extension(extension: &str) -> Option<Language> {
    Some(match extension {
        "rs" => Language::Rust,
        "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs" => Language::Script,
        "py" | "pyi" => Language::Python,
        "go" => Language::Go,
        "java" => Language::Java,
        "kt" | "kts" => Language::Kotlin,
        "swift" => Language::Swift,
        "c" | "h" | "cc" | "cpp" | "cxx" | "hh" | "hpp" | "hxx" | "m" | "mm" => Language::CFamily,
        "rb" | "rake" => Language::Ruby,
        "php" => Language::Php,
        "sh" | "bash" | "zsh" => Language::Shell,
        _ => return None,
    })
}

pub(super) fn supported(path: &str) -> bool {
    language_of(path).is_some()
}

/// In rules with no keyword before the name: words that look like one in `word(...) {`.
const NOT_NAMES: &[&str] = &["if", "else", "for", "while", "switch", "catch", "return", "function", "do", "try", "new", "throw", "with", "await", "yield", "typeof", "delete", "case", "sizeof", "super", "this", "assert", "synchronized", "foreach", "elif", "match", "loop", "defined"];

/// Definitions in file order, with 1-based inclusive line ranges. Span resolution takes
/// O((lines + symbols) log symbols); a call out of time gets the definitions found so far.
pub(super) fn extract(path: &str, text: &str, limit: &Limit) -> Vec<Symbol> {
    let Some(language) = language_of(path) else { return Vec::new() };
    if limit.expired() {
        return Vec::new();
    }
    let mut line_count = usize::from(!text.is_empty() && !text.ends_with('\n'));
    for chunk in text.as_bytes().chunks(LIMIT_CHECK_BYTES) {
        if limit.expired() {
            return Vec::new();
        }
        line_count += chunk.iter().filter(|&&byte| byte == b'\n').count();
    }
    let Some(needed) = line_count.checked_mul(LINE_METADATA_BYTES) else {
        limit.cut();
        return Vec::new();
    };
    let Some(_guard) = limit.reserve_parse_bytes(needed) else {
        limit.cut();
        return Vec::new();
    };
    let mut lines = Vec::with_capacity(line_count);
    lines.extend(text.lines());
    let lex = Lexed::new(&lines, language, limit);
    if lex.inside_literal.len() < lines.len() {
        return Vec::new();
    }
    let mut symbols = Vec::new();
    let mut go_group = None;
    for (index, line) in lines.iter().enumerate() {
        if index.is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
            break;
        }
        if lex.inside_literal[index] || line.len() > MAX_RULE_LINE {
            continue;
        }
        let found = if language == Language::Go { go_definition(line, &mut go_group) } else { None };
        if let Some((kind, name)) = found.or_else(|| definition(path, language, &lines, index)) {
            symbols.push(Symbol { name, kind, line: index + 1, end: index + 1 });
        }
    }
    if limit.expired() {
        return symbols;
    }
    set_ends(language, &lines, &lex, &mut symbols, limit);
    symbols
}

fn definition(path: &str, language: Language, lines: &[&str], index: usize) -> Option<(&'static str, String)> {
    let line = lines[index];
    let table = table(language);
    let rule = table.set.matches(line).iter().next()?;
    let (kind, regex) = &table.rules[rule];
    let name = regex.captures(line)?.get(1)?.as_str();
    let guessed = matches!((language, *kind), (Language::Script | Language::Java, "method" | OPEN_METHOD) | (Language::CFamily, "function" | "method"));
    if guessed && (NOT_NAMES.contains(&name) || first_word_blocks(line)) {
        return None;
    }
    if *kind == "method" && language == Language::CFamily && path.ends_with(".c") {
        return None;
    }
    if *kind == OPEN_METHOD {
        return closes_as_method(lines, index).then(|| ("method", name.to_owned()));
    }
    Some((kind, name.to_owned()))
}

/// `async run(` on its own line is a method only if a later `) {` or `): T {` closes it; a call
/// spread over lines ends in `);`.
fn closes_as_method(lines: &[&str], index: usize) -> bool {
    lines[index + 1..].iter().take(SIGNATURE_LINES).find(|line| line.trim_start().starts_with(')')).is_some_and(|line| line.trim_end().ends_with('{'))
}

/// Members of `type (`, `const (` and `var (` groups, which the column-0 rules cannot see.
fn go_definition(line: &str, group: &mut Option<&'static str>) -> Option<(&'static str, String)> {
    let kind = match line.trim_end() {
        "type (" => Some("type"),
        "const (" | "var (" => Some("const"),
        ")" => {
            *group = None;
            return None;
        }
        _ => None,
    };
    if kind.is_some() {
        *group = kind;
        return None;
    }
    let kind = (*group)?;
    let member = line.strip_prefix('\t').filter(|rest| !rest.starts_with([' ', '\t']))?;
    let name: String = member.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    (!name.is_empty()).then_some((kind, name))
}

fn first_word_blocks(line: &str) -> bool {
    let word = line.trim_start().split(|c: char| !c.is_alphanumeric() && c != '_').next().unwrap_or("");
    matches!(word, "return" | "new" | "else" | "throw" | "await" | "yield" | "goto" | "case")
}

fn set_ends(language: Language, lines: &[&str], lex: &Lexed, symbols: &mut [Symbol], limit: &Limit) {
    match language {
        Language::Ruby => ruby_ends(lines, symbols, limit),
        Language::Python => indent_ends(lines, lex, symbols, limit),
        _ => block_ends(lines, lex, symbols, limit),
    }
}

/// Find each opening in bounded signature lookahead, then close all eligible definitions
/// together. Multiple braces on an opening line must close back to its original depth.
fn block_ends(lines: &[&str], lex: &Lexed, symbols: &mut [Symbol], limit: &Limit) {
    let mut openings = Vec::new();
    for (sym_idx, symbol) in symbols.iter_mut().enumerate() {
        if sym_idx.is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
            return;
        }
        let start = symbol.line - 1;
        let base = lex.depth_before[start];
        symbol.end = (start + SIGNATURE_LOOKAHEAD + 1).min(lines.len());
        for index in start..lines.len().min(start + SIGNATURE_LOOKAHEAD + 1) {
            let in_parens = lex.parens_after[index] > lex.parens_before[start];
            if lex.peak[index] > base {
                if lex.depth_after[index] > base {
                    openings.push((index, base, sym_idx));
                    break;
                }
                // An inline parameter type or default is not the function's body.
                if !lex.has_semicolon[index] && (in_parens || signature_continues(lines, index)) {
                    continue;
                }
            }
            if lex.has_semicolon[index] || !(in_parens || signature_continues(lines, index)) {
                symbol.end = index + 1;
                break;
            }
        }
    }
    openings.sort_unstable_by_key(|&(line, _, _)| line);
    let mut openings = openings.into_iter().peekable();
    let mut open = BinaryHeap::new();
    let mut closed = 0usize;
    for (index, &depth) in lex.depth_after.iter().take(lines.len()).enumerate() {
        if index.is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
            return;
        }
        while openings.peek().is_some_and(|&(line, _, _)| line == index) {
            let (_, base, sym_idx) = openings.next().expect("opening exists");
            open.push((base, sym_idx));
        }
        while open.peek().is_some_and(|&(base, _)| depth <= base) {
            if closed.is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
                return;
            }
            let (_, sym_idx) = open.pop().expect("open definition exists");
            symbols[sym_idx].end = index + 1;
            closed += 1;
        }
    }
    for (index, (_, sym_idx)) in open.into_iter().enumerate() {
        if index.is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
            return;
        }
        symbols[sym_idx].end = lines.len();
    }
}

/// Open Python definitions grouped by bracket depth. Each heap orders indentation; a range
/// maximum tree finds a qualifying heap without rescanning definitions protected by brackets.
/// This also bounds work for malformed files whose bracket and indentation levels disagree.
struct IndentBlocks {
    parens: Vec<i32>,
    heaps: Vec<BinaryHeap<(usize, usize)>>,
    maxima: Vec<Option<usize>>,
    size: usize,
}

impl IndentBlocks {
    fn new(mut parens: Vec<i32>) -> Self {
        parens.sort_unstable();
        parens.dedup();
        let size = parens.len().next_power_of_two();
        Self { heaps: vec![BinaryHeap::new(); parens.len()], parens, maxima: vec![None; 2 * size], size }
    }

    fn update(&mut self, group: usize) {
        let mut node = self.size + group;
        self.maxima[node] = self.heaps[group].peek().map(|&(indent, _)| indent);
        while node > 1 {
            node /= 2;
            self.maxima[node] = self.maxima[node * 2].max(self.maxima[node * 2 + 1]);
        }
    }

    fn push(&mut self, parens: i32, indent: usize, sym_idx: usize) {
        let group = self.parens.binary_search(&parens).expect("definition bracket depth is indexed");
        self.heaps[group].push((indent, sym_idx));
        self.update(group);
    }

    /// First heap at or after `first` containing an indent >= the current line's indent.
    fn qualifying(&self, node: usize, left: usize, right: usize, first: usize, indent: usize) -> Option<usize> {
        if right <= first || self.maxima[node] < Some(indent) {
            return None;
        }
        if right - left == 1 {
            return Some(left);
        }
        let middle = (left + right) / 2;
        self.qualifying(node * 2, left, middle, first, indent).or_else(|| self.qualifying(node * 2 + 1, middle, right, first, indent))
    }
}

/// A nonliteral, noncomment code line closes definitions only when BOTH its indentation
/// and bracket depth have returned to their starting levels. All still-open definitions
/// share the last code line, including literal lines but excluding blank/comment lines.
fn indent_ends(lines: &[&str], lex: &Lexed, symbols: &mut [Symbol], limit: &Limit) {
    let mut parens = Vec::with_capacity(symbols.len());
    for (index, symbol) in symbols.iter().enumerate() {
        if index.is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
            return;
        }
        parens.push(lex.parens_before[symbol.line - 1]);
    }
    let mut open = IndentBlocks::new(parens);
    let (mut next, mut last_code, mut closed) = (0, 0, 0usize);
    for (index, line) in lines.iter().enumerate() {
        if index.is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
            return;
        }
        if lex.inside_literal[index] {
            last_code = index + 1;
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = indent_of(line);
        let parens = lex.parens_before[index];
        let first = open.parens.partition_point(|&depth| depth < parens);
        while let Some(group) = open.qualifying(1, 0, open.size, first, indent) {
            if closed.is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
                return;
            }
            let (_, sym_idx) = open.heaps[group].pop().expect("qualifying definition exists");
            symbols[sym_idx].end = last_code;
            open.update(group);
            closed += 1;
        }
        last_code = index + 1;
        while next < symbols.len() && symbols[next].line == index + 1 {
            open.push(parens, indent, next);
            next += 1;
        }
    }
    for (index, (_, sym_idx)) in open.heaps.into_iter().flatten().enumerate() {
        if index.is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
            return;
        }
        symbols[sym_idx].end = last_code;
    }
}

/// Ruby: an `end` at a definition's own indentation closes it. One pass with a stack of open
/// definitions; one-liners and `def a = 1` never open.
fn ruby_ends(lines: &[&str], symbols: &mut [Symbol], limit: &Limit) {
    let mut open: Vec<usize> = Vec::new();
    let mut next = 0;
    for (index, line) in lines.iter().enumerate() {
        if index.is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
            return;
        }
        let indent = indent_of(line);
        let trimmed = line.trim_start();
        let closes = trimmed.strip_prefix("end").is_some_and(|rest| !rest.starts_with(|c: char| c.is_alphanumeric() || c == '_'));
        if closes {
            while open.last().is_some_and(|&at| indent_of(lines[symbols[at].line - 1]) > indent) {
                open.pop();
            }
            if let Some(&at) = open.last().filter(|&&at| indent_of(lines[symbols[at].line - 1]) == indent) {
                symbols[at].end = index + 1;
                open.pop();
            }
        }
        while next < symbols.len() && symbols[next].line == index + 1 {
            if !ruby_one_liner(line) {
                open.push(next);
            }
            next += 1;
        }
    }
}

fn ruby_one_liner(line: &str) -> bool {
    static ENDLESS: OnceLock<Regex> = OnceLock::new();
    let endless = ENDLESS.get_or_init(|| Regex::new(r"^\s*def\s+[^\s(]+(?:\([^)]*\))?\s+=\s").expect("rule compiles"));
    line.trim_end().ends_with("end") || endless.is_match(line)
}

/// Finds the innermost definition of ascending lines in one pass over the symbols.
pub(super) struct Enclosing<'a> {
    symbols: &'a [Symbol],
    next: usize,
    open: Vec<&'a Symbol>,
}

impl<'a> Enclosing<'a> {
    pub(super) fn new(symbols: &'a [Symbol]) -> Self {
        Self { symbols, next: 0, open: Vec::new() }
    }

    pub(super) fn at(&mut self, line: usize) -> Option<&'a Symbol> {
        while self.next < self.symbols.len() && self.symbols[self.next].line <= line {
            self.open.push(&self.symbols[self.next]);
            self.next += 1;
        }
        while self.open.last().is_some_and(|symbol| symbol.end < line) {
            self.open.pop();
        }
        self.open.last().copied()
    }
}

/// Whether `symbol` sits inside a definition whose name holds `qualifier` as a whole word
/// (`Foo` in `impl Display for Foo<'a>`).
#[cfg(test)]
pub(super) fn qualified_by(symbols: &[Symbol], symbol: &Symbol, qualifier: &str) -> bool {
    symbols.iter().any(|outer| {
        outer.line <= symbol.line && symbol.end <= outer.end && outer != symbol && outer.name.split(|c: char| !c.is_alphanumeric() && c != '_').any(|word| word == qualifier)
    })
}

/// Streams matching definitions in O(symbols), retaining only two same-line qualifier
/// candidates. Earlier-line qualifiers need only their maximum end. The two same-line
/// candidates have distinct values because `qualified_by` excludes value-equal symbols.
pub(super) fn qualified_matches<'a>(
    symbols: &'a [Symbol],
    qualifier: Option<&str>,
    matches_name: impl Fn(&Symbol) -> bool,
    limit: &Limit,
    mut found: impl FnMut(&'a Symbol),
) {
    let Some(qualifier) = qualifier else {
        for (index, symbol) in symbols.iter().enumerate() {
            if index.is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
                return;
            }
            if matches_name(symbol) {
                found(symbol);
            }
        }
        return;
    };
    let (mut start, mut max_prev_end) = (0, None);
    while start < symbols.len() {
        let mut end = start;
        let (mut first, mut second): (Option<&Symbol>, Option<&Symbol>) = (None, None);
        while end < symbols.len() && symbols[end].line == symbols[start].line {
            if end.is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
                return;
            }
            let symbol = &symbols[end];
            if symbol.name.split(|c: char| !c.is_alphanumeric() && c != '_').any(|word| word == qualifier) && first != Some(symbol) && second != Some(symbol) {
                if first.is_none_or(|first| symbol.end > first.end) {
                    second = first;
                    first = Some(symbol);
                } else if second.is_none_or(|second| symbol.end > second.end) {
                    second = Some(symbol);
                }
            }
            end += 1;
        }
        for (offset, symbol) in symbols[start..end].iter().enumerate() {
            if (start + offset).is_multiple_of(LIMIT_CHECK_LINES) && limit.expired() {
                return;
            }
            let same_line_end = first.filter(|&outer| outer != symbol).or(second.filter(|&outer| outer != symbol)).map(|outer| outer.end);
            if max_prev_end.max(same_line_end).is_some_and(|outer_end| symbol.end <= outer_end) && matches_name(symbol) {
                found(symbol);
            }
        }
        max_prev_end = max_prev_end.max(first.map(|outer| outer.end));
        start = end;
    }
}
