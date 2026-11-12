//! Compiles a search pattern and works out which trigrams every matching file must contain.
//! Index trigrams are ASCII only and folded (see `fold_trigrams`), so a non-ASCII byte or a
//! wider class just ends a run: the plan may keep too many files but never loses one.
use regex::bytes::{Regex, RegexBuilder};
use regex_syntax::{
    ast::{self, Ast},
    hir::{Class, Hir, HirKind, Look},
};

const REGEX_SIZE_LIMIT: usize = 1 << 24;

/// All of the listed trigram sets must hold; each set is satisfied by any one branch.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Plan {
    Everything,
    Trigram(u32),
    All(Vec<Plan>),
    Any(Vec<Plan>),
}

pub(super) fn trigram(a: u8, b: u8, c: u8) -> u32 {
    (a as u32) << 14 | (b as u32) << 7 | c as u32
}

/// How a pattern is matched against a buffer. Each way is linear in the file's size.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum Scan {
    /// No match can cross a newline, so whole-buffer search finds the lines.
    Buffer,
    /// A class holds a newline (`\s`, `[^a]`): a buffer match proves nothing about a line, but
    /// no buffer match rules the file out.
    Lines,
    /// `\A`/`\z` mean the line's own ends here, as in ripgrep, so only lines can be tested.
    OnlyLines,
}

pub(super) struct Pattern {
    pub(super) regex: Regex,
    pub(super) plan: Plan,
    pub(super) scan: Scan,
    /// Matched ignoring case (smart case).
    pub(super) folded: bool,
}

/// `(?m)` so `^`/`$` work on a whole buffer.
pub(super) fn compile(pattern: &str, case_sensitive: bool) -> Result<Pattern, String> {
    let literals = Literals::of(pattern);
    if literals.newline {
        return Err("Patterns match within one line, so \\n is not allowed. Search for one line's text.".into());
    }
    let insensitive = !case_sensitive && literals.folds();
    let regex = RegexBuilder::new(pattern)
        .case_insensitive(insensitive)
        .multi_line(true)
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
        .map_err(|error| format!("Invalid regular expression: {error}"))?;
    let hir = regex_syntax::ParserBuilder::new()
        .utf8(false)
        .case_insensitive(insensitive)
        .multi_line(true)
        .build()
        .parse(pattern)
        .map_err(|error| format!("Invalid regular expression: {error}"))?;
    Ok(Pattern { regex, plan: plan_of(&hir), scan: scan_of(&hir), folded: insensitive })
}

fn scan_of(hir: &Hir) -> Scan {
    let looks = hir.properties().look_set();
    if looks.contains(Look::Start) || looks.contains(Look::End) {
        Scan::OnlyLines
    } else if class_holds_newline(hir) {
        Scan::Lines
    } else {
        Scan::Buffer
    }
}

fn class_holds_newline(hir: &Hir) -> bool {
    match hir.kind() {
        HirKind::Class(Class::Unicode(set)) => set.ranges().iter().any(|r| r.start() <= '\n' && '\n' <= r.end()),
        HirKind::Class(Class::Bytes(set)) => set.ranges().iter().any(|r| r.start() <= b'\n' && b'\n' <= r.end()),
        HirKind::Capture(capture) => class_holds_newline(&capture.sub),
        HirKind::Repetition(repetition) => class_holds_newline(&repetition.sub),
        HirKind::Concat(parts) | HirKind::Alternation(parts) => parts.iter().any(class_holds_newline),
        _ => false,
    }
}

/// What one pass over a pattern's literals finds.
#[derive(Default)]
struct Literals {
    any: bool,
    upper: bool,
    newline: bool,
}

impl Literals {
    fn of(pattern: &str) -> Self {
        let mut found = Self::default();
        if let Ok(ast) = ast::parse::Parser::new().parse(pattern) {
            visit_ast(&ast, &mut |c| {
                found.any = true;
                found.upper |= c.is_uppercase();
                found.newline |= c == '\n';
            });
        }
        found
    }

    /// ripgrep's rule: fold when the pattern has a literal and none of its literals is uppercase.
    fn folds(&self) -> bool {
        self.any && !self.upper
    }
}

fn visit_ast(ast: &Ast, see: &mut impl FnMut(char)) {
    match ast {
        Ast::Literal(literal) => see(literal.c),
        Ast::ClassBracketed(class) => visit_class_set(&class.kind, see),
        Ast::Repetition(repetition) => visit_ast(&repetition.ast, see),
        Ast::Group(group) => visit_ast(&group.ast, see),
        Ast::Alternation(alternation) => alternation.asts.iter().for_each(|a| visit_ast(a, see)),
        Ast::Concat(concat) => concat.asts.iter().for_each(|a| visit_ast(a, see)),
        _ => {}
    }
}

fn visit_class_set(set: &ast::ClassSet, see: &mut impl FnMut(char)) {
    match set {
        ast::ClassSet::Item(item) => visit_class_item(item, see),
        ast::ClassSet::BinaryOp(op) => {
            visit_class_set(&op.lhs, see);
            visit_class_set(&op.rhs, see);
        }
    }
}

fn visit_class_item(item: &ast::ClassSetItem, see: &mut impl FnMut(char)) {
    match item {
        ast::ClassSetItem::Literal(literal) => see(literal.c),
        ast::ClassSetItem::Range(range) => {
            see(range.start.c);
            see(range.end.c);
        }
        ast::ClassSetItem::Bracketed(class) => visit_class_set(&class.kind, see),
        ast::ClassSetItem::Union(union) => union.items.iter().for_each(|i| visit_class_item(i, see)),
        _ => {}
    }
}

fn plan_of(hir: &Hir) -> Plan {
    match hir.kind() {
        HirKind::Concat(parts) => concat_plan(parts),
        HirKind::Literal(_) | HirKind::Class(_) => concat_plan(std::slice::from_ref(hir)),
        HirKind::Capture(capture) => plan_of(&capture.sub),
        HirKind::Repetition(repetition) if repetition.min > 0 => plan_of(&repetition.sub),
        HirKind::Alternation(branches) => {
            let plans: Vec<Plan> = branches.iter().map(plan_of).collect();
            if plans.contains(&Plan::Everything) { Plan::Everything } else { Plan::Any(plans) }
        }
        _ => Plan::Everything,
    }
}

fn concat_plan(parts: &[Hir]) -> Plan {
    let mut required = Vec::new();
    let mut run: Vec<u8> = Vec::new();
    for part in parts {
        match part.kind() {
            HirKind::Literal(literal) => literal.0.iter().for_each(|&byte| push_byte(&mut run, byte, &mut required)),
            HirKind::Class(class) => match class_atom(class) {
                Some(byte) => run.push(byte),
                None => flush_run(&mut run, &mut required),
            },
            _ => {
                flush_run(&mut run, &mut required);
                match plan_of(part) {
                    Plan::Everything => {}
                    plan => required.push(plan),
                }
            }
        }
    }
    flush_run(&mut run, &mut required);
    match required.len() {
        0 => Plan::Everything,
        1 => required.remove(0),
        _ => Plan::All(required),
    }
}

fn push_byte(run: &mut Vec<u8>, byte: u8, required: &mut Vec<Plan>) {
    if byte.is_ascii() {
        run.push(byte.to_ascii_lowercase());
    } else {
        flush_run(run, required);
    }
}

fn flush_run(run: &mut Vec<u8>, required: &mut Vec<Plan>) {
    required.extend(run.windows(3).map(|w| Plan::Trigram(trigram(w[0], w[1], w[2]))));
    run.clear();
}

/// The one folded ASCII byte a class stands for, or None when it stands for several.
fn class_atom(class: &Class) -> Option<u8> {
    let mut atom = None;
    let mut see = |lo: u32, hi: u32| -> bool {
        // Bound the walk: a wide range is never one folded byte.
        if hi - lo > 4 {
            return false;
        }
        (lo..=hi).all(|code| match fold_char(code) {
            Some(byte) => *atom.get_or_insert(byte) == byte,
            None => false,
        })
    };
    let single = match class {
        Class::Unicode(set) => set.ranges().iter().all(|r| see(r.start() as u32, r.end() as u32)),
        Class::Bytes(set) => set.ranges().iter().all(|r| r.start().is_ascii() && r.end().is_ascii() && see(r.start() as u32, r.end() as u32)),
    };
    if single { atom } else { None }
}

/// What a code point folds to in the index: ASCII lowercased, plus the only two non-ASCII
/// characters whose simple case fold is an ASCII letter.
fn fold_char(code: u32) -> Option<u8> {
    match code {
        0x17F => Some(b's'),
        0x212A => Some(b'k'),
        code if code < 0x80 => Some((code as u8).to_ascii_lowercase()),
        _ => None,
    }
}

/// Calls `see` with every folded ASCII trigram of `bytes`. Other non-ASCII bytes end a run, so
/// the plan's runs (which break at the same bytes) always find their trigrams here.
pub(super) fn fold_trigrams(bytes: &[u8], mut see: impl FnMut(u32)) {
    let (mut a, mut b, mut seen) = (0u8, 0u8, 0u8);
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        let (folded, width) = if byte < 0x80 {
            (Some(byte.to_ascii_lowercase()), 1)
        } else if byte == 0xC5 && bytes.get(at + 1) == Some(&0xBF) {
            (Some(b's'), 2)
        } else if byte == 0xE2 && bytes.get(at + 1) == Some(&0x84) && bytes.get(at + 2) == Some(&0xAA) {
            (Some(b'k'), 3)
        } else {
            (None, 1)
        };
        at += width;
        let Some(c) = folded else {
            seen = 0;
            continue;
        };
        if seen >= 2 {
            see(trigram(a, b, c));
        }
        (a, b) = (b, c);
        seen = seen.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trigrams_of(text: &str) -> Vec<u32> {
        let mut all = Vec::new();
        fold_trigrams(text.as_bytes(), |t| all.push(t));
        all
    }
    fn tri(s: &str) -> Plan {
        let b = s.as_bytes();
        Plan::Trigram(trigram(b[0], b[1], b[2]))
    }
    fn planned(pattern: &str) -> Plan {
        compile(pattern, false).unwrap().plan
    }

    #[test]
    fn smart_case_follows_ripgrep() {
        for (pattern, folds) in [("foo", true), ("Foo", false), (r"\Sfoo", true), (r"\S", false), ("[A-Z]x", false), (r"\p{Lu}x", true), ("(", false)] {
            assert_eq!(Literals::of(pattern).folds(), folds, "{pattern}");
            assert_eq!(compile(pattern, false).map(|compiled| compiled.folded).unwrap_or(folds), folds, "{pattern}");
        }
        assert!(compile("foo", false).unwrap().regex.is_match(b"FOO"));
        assert!(!compile("Foo", false).unwrap().regex.is_match(b"foo"));
        assert!(!compile("foo", true).unwrap().regex.is_match(b"FOO"));
    }

    #[test]
    fn a_newline_in_a_pattern_is_refused_like_ripgrep() {
        for pattern in [r"foo\nbar", r"[\n]", r"a|\n", r"\x0A"] {
            assert!(compile(pattern, false).err().unwrap().contains("within one line"), "{pattern}");
        }
        for pattern in [r"\s", r"[^a]", r"foo\\nbar", r"\N"] {
            assert!(!compile(pattern, false).err().is_some_and(|error| error.contains("within one line")), "{pattern}");
        }
    }

    #[test]
    fn patterns_pick_a_linear_way_to_scan() {
        for (pattern, scan) in [("foo", Scan::Buffer), ("a.*b", Scan::Buffer), (r"\bx$", Scan::Buffer), (r"a\s+b", Scan::Lines), ("[^z]+z", Scan::Lines), (r"\Afoo", Scan::OnlyLines), (r"foo\z", Scan::OnlyLines), (r"(\s|\Ax)+", Scan::OnlyLines)] {
            assert_eq!(compile(pattern, false).unwrap().scan, scan, "{pattern}");
        }
    }

    #[test]
    fn plans_keep_only_what_is_required() {
        assert_eq!(planned("abcd"), Plan::All(vec![tri("abc"), tri("bcd")]));
        assert_eq!(planned("Abc"), tri("abc"));
        assert_eq!(planned("ab"), Plan::Everything);
        assert_eq!(planned("abc|xyz"), Plan::Any(vec![tri("abc"), tri("xyz")]));
        assert_eq!(planned("abc|x"), Plan::Everything);
        assert_eq!(planned("(abc)+"), tri("abc"));
        assert_eq!(planned("(abc)*"), Plan::Everything);
        assert_eq!(planned(r"abc.*xyz"), Plan::All(vec![tri("abc"), tri("xyz")]));
        assert_eq!(planned(r"abc[0-9]xyz"), Plan::All(vec![tri("abc"), tri("xyz")]));
        assert_eq!(planned(r"\w+"), Plan::Everything);
        assert_eq!(planned("héllo"), tri("llo"));
    }

    #[test]
    fn case_folding_keeps_the_two_non_ascii_folds() {
        // A folded `s` and `k` also match U+017F and U+212A.
        let pattern = compile("task", false).unwrap();
        assert!(pattern.regex.is_match("ta\u{17F}\u{212A}".as_bytes()));
        assert_eq!(pattern.plan, Plan::All(vec![tri("tas"), tri("ask")]));
        assert!(trigrams_of("ta\u{17F}\u{212A}").contains(&trigram(b't', b'a', b's')));
        assert!(trigrams_of("ta\u{17F}\u{212A}").contains(&trigram(b'a', b's', b'k')));
    }

    #[test]
    fn non_ascii_breaks_a_trigram_run() {
        assert_eq!(trigrams_of("abé"), Vec::<u32>::new());
        assert_eq!(trigrams_of("ABCé"), vec![trigram(b'a', b'b', b'c')]);
    }
}
