//! TS/JS method signatures: `run(x = f(1), s = ")"): T { … }` must close its parameter list on
//! the line before an optional return type and a body (or a later `) {` closes a lone `run(`), so
//! calls taking callbacks and declarations ending in `;` are not mistaken for methods.
use super::symbols::OPEN_OR_BODY;
use regex::Regex;
use std::sync::OnceLock;

/// How far ahead a multi-line method's `) {` may be.
const SIGNATURE_LINES: usize = 12;

/// A whole inline object type, `{ id: string }`, with no nested braces.
macro_rules! ts_object_type {
    () => {
        r"\{[^{}]*\}"
    };
}
/// One piece of a TS return type: any character but `{` or `;`, or a whole object type.
macro_rules! ts_return_piece {
    () => {
        concat!(r"(?:[^{;]|", ts_object_type!(), ")")
    };
}
/// The last piece of a TS return type: a character that cannot continue a type (not `&`, `|`,
/// `=`, `(`, `<`, `,`, `?`, `:` or a lone `>` as in `=>`), a whole object type, or a generic's
/// closing `>` after one of those (`Promise<void>`, `Map<K, { v: V }>`).
macro_rules! ts_return_end {
    () => {
        concat!(r"(?:[^{;\s&|=(<,?:>]|", ts_object_type!(), r"|(?:[^{;\s=]|", ts_object_type!(), ")>)")
    };
}
/// TS return type before a method's `{`: whole `{ … }` object types may sit inside it, but no
/// `;`, and it never ends in `&`, `|`, `=>`, `=`, `(`, `<`, `,`, `?` or `:`, so the object type
/// closing a declaration (`render(): Props & { id: string };`, `count(): { n: number };`) is no
/// body, while `shape(): Props & { id: string } { … }` keeps its own.
pub(super) const TS_RETURN: &str = concat!(r"(?::\s*", ts_return_piece!(), "*?", ts_return_end!(), r"\s*)?");

/// `async run(` on its own line is a method only if a later `) {` or `): T {` closes it; a call
/// spread over lines ends in `);`.
pub(super) fn closes_as_method(lines: &[&str], index: usize) -> bool {
    lines[index + 1..].iter().take(SIGNATURE_LINES).find(|line| line.trim_start().starts_with(')')).is_some_and(|line| line.trim_end().ends_with('{'))
}

/// `run(x = f(1), s = ")"): T { … }`: the parameter list after the name (and any `<T>`) closes
/// on this line, so neither a call taking a callback (`it("works", function () {`) nor a
/// declaration with a commented `{ }` (`size(): number; // f() { }`) passes for a method.
pub(super) fn script_method_signature(line: &str, name_end: usize) -> bool {
    static AFTER_PARAMS: OnceLock<Regex> = OnceLock::new();
    let after_params = AFTER_PARAMS.get_or_init(|| Regex::new(&format!(r"^\s*{TS_RETURN}{OPEN_OR_BODY}")).expect("script method rule compiles"));
    let skip_space = |at: usize| at + (line[at..].len() - line[at..].trim_start().len());
    let mut at = skip_space(name_end);
    if line[at..].starts_with('<') {
        let Some(close) = line[at..].find('>') else { return false };
        at = skip_space(at + close + 1);
    }
    line[at..].starts_with('(') && closing_paren(line, at).is_some_and(|close| after_params.is_match(&line[close + 1..]))
}

/// The `)` matching the `(` at `open`, skipping `'…'`, `"…"` and `` `…` `` with `\` escapes and
/// `/* … */` comments; `None` if the line ends (also inside an unterminated `/*`) or a `;`
/// outside `{ … }` inline object types comes first.
fn closing_paren(line: &str, open: usize) -> Option<usize> {
    let bytes = line.as_bytes();
    let (mut depth, mut braces, mut quote, mut escaped) = (0usize, 0usize, None, false);
    let mut at = open;
    while at < bytes.len() {
        let byte = bytes[at];
        if let Some(open_quote) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == open_quote {
                quote = None;
            }
            at += 1;
            continue;
        }
        match byte {
            b'/' if bytes.get(at + 1) == Some(&b'*') => {
                at += 2 + line[at + 2..].find("*/")? + 2;
                continue;
            }
            b'\'' | b'"' | b'`' => quote = Some(byte),
            b'(' => depth += 1,
            b')' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(at);
                }
            }
            b'{' => braces += 1,
            b'}' => braces = braces.saturating_sub(1),
            b';' if braces == 0 => return None,
            _ => {}
        }
        at += 1;
    }
    None
}
