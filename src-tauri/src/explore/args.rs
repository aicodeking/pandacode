//! The tool's arguments: tolerant of a single string where a list belongs, and when something
//! is wrong it says everything that is wrong at once, so the agent needs one retry at most.
use serde_json::Value;

const QUESTION_KEYS: &[&str] = &["search", "symbols", "outline", "read", "tests_for"];
/// Items per list; the catalog states it too.
pub(super) const MAX_ITEMS: usize = 20;
const MAX_ITEM_BYTES: usize = 200;
const MAX_CONTEXT: usize = 20;
// search, symbols and tests_for each take a bit of a file's 64-bit job mask.
const _: () = assert!(3 * MAX_ITEMS <= 64);

#[derive(Default)]
pub(super) struct Ask {
    pub(super) search: Vec<String>,
    pub(super) glob: Vec<String>,
    pub(super) symbols: Vec<String>,
    pub(super) outline: Vec<String>,
    pub(super) read: Vec<String>,
    pub(super) tests_for: Vec<String>,
    pub(super) context: usize,
    pub(super) case_sensitive: bool,
}

impl Ask {
    fn list(&mut self, key: &str) -> Option<&mut Vec<String>> {
        Some(match key {
            "search" => &mut self.search,
            "glob" => &mut self.glob,
            "symbols" => &mut self.symbols,
            "outline" => &mut self.outline,
            "read" => &mut self.read,
            "tests_for" => &mut self.tests_for,
            _ => return None,
        })
    }
}

/// One string is a list of one; otherwise a list of short strings.
fn list(key: &str, value: &Value) -> Result<Vec<String>, String> {
    let items = match value {
        Value::String(one) => vec![one.clone()],
        Value::Array(items) => items.iter().map(|item| item.as_str().map(str::to_owned)).collect::<Option<_>>().ok_or_else(|| format!("{key}: expected a list of strings"))?,
        _ => return Err(format!("{key}: expected a list of strings")),
    };
    if items.len() > MAX_ITEMS {
        return Err(format!("{key}: at most {MAX_ITEMS} items"));
    }
    if items.iter().any(|item| item.len() > MAX_ITEM_BYTES || item.contains('\0')) {
        return Err(format!("{key}: each item at most {MAX_ITEM_BYTES} bytes, no null characters"));
    }
    Ok(items)
}

/// A glob item with nothing in it would search the whole project, and a long list is a scan
/// in disguise. The count is before `names_path` keeps a real path with commas whole, so it
/// is an upper bound.
fn glob_problems(globs: &[String]) -> Vec<String> {
    let mut problems = Vec::new();
    let counts: Vec<usize> = globs.iter().map(|item| super::glob::split_list(item, |_| false).len()).collect();
    if counts.contains(&0) {
        problems.push("glob: an item holds no glob".to_owned());
    }
    if counts.iter().sum::<usize>() > super::glob::MAX_GLOBS {
        problems.push(format!("glob: at most {} globs after splitting at commas", super::glob::MAX_GLOBS));
    }
    problems
}

/// Reads the arguments, reporting every problem together.
pub(super) fn parse(args: &Value) -> Result<Ask, String> {
    let object = args.as_object().ok_or("Tool arguments must be an object.")?;
    let mut ask = Ask::default();
    let mut problems = Vec::new();
    for (key, value) in object {
        let problem = match key.as_str() {
            "context" => value.as_u64().map(|n| ask.context = (n as usize).min(MAX_CONTEXT)).ok_or("context: expected a non-negative integer".to_owned()).err(),
            "case_sensitive" => value.as_bool().map(|on| ask.case_sensitive = on).ok_or("case_sensitive: expected true or false".to_owned()).err(),
            // Result caps borrowed from grep tools: every reply is already capped, so they are ignored
            // rather than costing the agent a retry (batch E: 2 calls refused for `limit`).
            "limit" | "head_limit" | "max_results" => None,
            other => match ask.list(other) {
                None => Some(format!("{other}: unknown argument")),
                Some(slot) => list(other, value).map(|items| *slot = items).err(),
            },
        };
        problems.extend(problem);
    }
    problems.extend(glob_problems(&ask.glob));
    if !QUESTION_KEYS.iter().any(|key| ask.list(key).is_some_and(|items| !items.is_empty())) {
        problems.push("give at least one of search, symbols, outline, read or tests_for".to_owned());
    }
    if problems.is_empty() { Ok(ask) } else { Err(format!("Invalid arguments: {}.", problems.join("; "))) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_string_becomes_a_one_item_list() {
        let ask = parse(&json!({"search":"needle","read":"a.rs:1-2","glob":["*.rs"],"context":50,"case_sensitive":true})).unwrap();
        assert_eq!((ask.search, ask.read, ask.glob), (vec!["needle".to_owned()], vec!["a.rs:1-2".to_owned()], vec!["*.rs".to_owned()]));
        assert_eq!((ask.context, ask.case_sensitive), (MAX_CONTEXT, true));
    }

    #[test]
    fn every_bad_argument_is_named_at_once() {
        let error = parse(&json!({"search":[1],"context":"2","case_sensitive":"yes","path":"/etc","symbols":vec!["x"; 21],"read":["x".repeat(201)]})).err().unwrap();
        for part in ["search: expected a list of strings", "context: expected a non-negative integer", "case_sensitive: expected true or false", "path: unknown argument", "symbols: at most 20", "read: each item at most 200"] {
            assert!(error.contains(part), "{part} in {error}");
        }
    }

    #[test]
    fn result_caps_from_grep_tools_are_ignored() {
        let ask = parse(&json!({"search":["x"],"limit":0,"head_limit":50,"max_results":"10"})).unwrap();
        assert_eq!(ask.search, ["x"]);
    }

    #[test]
    fn a_null_character_is_refused() {
        assert!(parse(&json!({"search":["a\u{0}b"]})).err().unwrap().contains("no null"));
    }

    #[test]
    fn an_empty_glob_item_or_too_many_globs_is_an_argument_error() {
        for empty in [",", " , ", "", ",,"] {
            let error = parse(&json!({"search":["x"],"glob":["*.rs", empty]})).err().unwrap();
            assert!(error.contains("glob: an item holds no glob"), "{empty:?}: {error}");
        }
        let forty = vec!["a"; super::super::glob::MAX_GLOBS].join(",");
        assert!(parse(&json!({"search":["x"],"glob":[forty.clone()]})).is_ok());
        let error = parse(&json!({"search":["x"],"glob":[forty, "b"]})).err().unwrap();
        assert!(error.contains("at most 40 globs"), "{error}");
    }

    #[test]
    fn a_question_is_required() {
        for args in [json!({}), json!({"glob":["*.rs"]}), json!({"search":[]}), json!({"context":2})] {
            assert!(parse(&args).err().unwrap().contains("at least one"), "{args}");
        }
        assert!(parse(&json!([])).is_err());
    }
}
