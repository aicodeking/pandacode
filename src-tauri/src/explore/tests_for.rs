//! `tests_for`: from a changed path to the test files most likely to cover it.
use super::{
    add_job,
    grep::{Job, JobResult, Kind},
    index::Snapshot,
    named::resolve_named,
    plan,
    shape::{head, plain_lines, Body, Item},
    Category, Ctx, Slot,
};
use serde_json::json;
use std::collections::HashMap;

const MAX_TESTS: usize = 20;
const MIN_STEM: usize = 3;
const NAME_SCORE: usize = 4;
const IMPORT_SCORE: usize = 3;
const MENTION_CAP: usize = 2;
/// Tests that only mention the stem, kept once a test is named for the file or imports it: a
/// common stem (`shape`) is a word in many unrelated tests.
const MENTION_ONLY: usize = 3;
const INLINE_MARKS: &[&str] = &["#[cfg(test)]", "#[test]", "describe(", "def test_", "func Test", "@Test"];
/// File names that say nothing about what a file does; their folder speaks for them.
const GENERIC_STEMS: &[&str] = &["mod", "index", "lib", "main", "__init__", "init"];
/// Folder names too common to be what a test mentions.
const GENERIC_FOLDERS: &[&str] = &["src", "lib", "app", "pkg", "source", "sources", "core"];
const TEST_FOLDERS: &[&str] = &["test", "tests", "__tests__", "spec", "specs", "e2e"];
const FIXTURE_FOLDERS: &[&str] = &["fixture", "fixtures", "__fixtures__", "__snapshots__", "__mocks__", "testdata", "snapshots", "golden"];

/// The word a test would use for this file: its stem, or its folder for `mod.rs`/`index.ts`.
fn stem_of(path: &str) -> Result<String, String> {
    let mut parts = path.rsplit(['/', '\\']);
    let name = parts.next().unwrap_or(path);
    let stem = name.split('.').next().unwrap_or(name);
    let word = if GENERIC_STEMS.contains(&stem) {
        parts.next().filter(|folder| !GENERIC_FOLDERS.contains(&folder.to_lowercase().as_str())).ok_or("This file's name is too generic to look for its tests; name the tests by search.")?
    } else {
        stem
    };
    if word.len() < MIN_STEM {
        return Err("This file's name is too short to look for its tests.".into());
    }
    Ok(word.to_owned())
}

fn is_code(name: &str) -> bool {
    crate::workspace::is_code_extension(&crate::workspace::extension(name).to_lowercase())
}

/// Whether a path is a test: a test folder or a test-shaped file name, in code, not a fixture.
pub(super) fn is_test_path(path: &str) -> bool {
    let (mut parts, mut folders) = (path.split('/').rev(), Vec::new());
    let name = parts.next().unwrap_or("");
    parts.for_each(|part| folders.push(part.to_lowercase()));
    if !is_code(name) || folders.iter().any(|folder| FIXTURE_FOLDERS.contains(&folder.as_str())) {
        return false;
    }
    let lower = name.to_lowercase();
    let stem = lower.split('.').next().unwrap_or(&lower);
    let cased_stem = name.split('.').next().unwrap_or(name);
    folders.iter().any(|folder| TEST_FOLDERS.contains(&folder.as_str()) || folder.ends_with(".tests") || folder.ends_with(".test"))
        || lower.contains(".test.")
        || lower.contains(".spec.")
        || matches!(stem, "tests" | "test")
        || stem.ends_with("_test")
        || stem.ends_with("_tests")
        || stem.ends_with("_spec")
        || stem.starts_with("test_")
        || cased_stem.ends_with("Test")
        || cased_stem.ends_with("Tests")
        || cased_stem.ends_with("Spec")
}

/// Whether `word` appears in `name` with an identifier boundary on each side: `app` is in
/// `app.test.ts` and `AppTest`, not in `snapshot_test` or `wrapper`.
fn name_has_word(name: &str, word: &str) -> bool {
    let separators = |c: char| !c.is_alphanumeric();
    let bytes = name.as_bytes();
    let word_len = word.len();
    // ASCII lowercase keeps every byte where it was, so offsets into `name` stay valid.
    name.to_ascii_lowercase().match_indices(&word.to_ascii_lowercase()).any(|(at, _)| {
        let before = name[..at].chars().next_back();
        let after = name.get(at + word_len..).and_then(|rest| rest.chars().next());
        let starts = before.is_none_or(separators) || (bytes[at].is_ascii_uppercase() && before.is_some_and(char::is_lowercase));
        let ends = after.is_none_or(separators) || after.is_some_and(char::is_uppercase);
        starts && ends
    })
}

pub(super) fn named_test(path: &str, stem: &str) -> bool {
    is_test_path(path) && name_has_word(path.rsplit('/').next().unwrap_or(path), stem)
}

/// The collector and reply must rank mentions by the same combined score before either caps
/// them. Ranking only by imports can discard a later test also named for the changed file.
pub(super) fn mention_score(path: &str, stem: &str, imports: usize, matched: usize) -> usize {
    if !is_test_path(path) {
        return 0;
    }
    usize::from(named_test(path, stem)) * NAME_SCORE + usize::from(imports > 0) * IMPORT_SCORE + matched.min(MENTION_CAP)
}

pub(super) fn job(jobs: &mut Vec<Job>, ctx: &Ctx, path: &str) -> Slot {
    let (_, target) = resolve_named(ctx, path)?;
    let stem = stem_of(path)?;
    add_job(jobs, plan::compile(&crate::workspace::whole_word_pattern(&stem), false), Kind::Mention { stem, target })
}

#[derive(Default)]
struct Score {
    score: usize,
    why: Vec<String>,
}

impl Score {
    fn add(&mut self, points: usize, why: String) {
        self.score += points;
        self.why.push(why);
    }
}

pub(super) fn item(ctx: &Ctx, path: &str, job: &Job, snapshot: &Snapshot, result: JobResult) -> Item {
    let Kind::Mention { stem, target } = &job.kind else { unreachable!("a tests_for job is a mention") };
    let mut scores: HashMap<String, Score> = HashMap::new();
    let mut named = 0;
    // The snapshot is path-sorted. Only the first MAX_TESTS named-only candidates could be
    // shown; a later named test with mentions is supplied by the ranked grep sample below.
    for file in snapshot.walk.files.iter().filter(|file| named_test(&file.path, stem)) {
        named += 1;
        if scores.len() < MAX_TESTS {
            scores.entry(file.path.to_string()).or_default().add(NAME_SCORE, "name".into());
        }
    }
    for file in result.files.iter().filter(|file| is_test_path(&file.path)) {
        let entry = scores.entry(file.path.to_string()).or_insert_with(|| {
            let mut score = Score::default();
            if named_test(&file.path, stem) {
                score.add(NAME_SCORE, "name".into());
            }
            score
        });
        if file.imports > 0 {
            entry.add(IMPORT_SCORE, "imports it".into());
        }
        entry.add(file.matched.min(MENTION_CAP), format!("{} mentions", file.matched));
    }
    let inline = has_inline_tests(ctx, path, target);
    if inline {
        // Its own tests rank first and count as a strong result.
        scores.insert(path.to_owned(), Score { score: usize::MAX, why: vec!["inline tests".into()] });
    }
    let mut ranked: Vec<(String, Score)> = scores.into_iter().collect();
    ranked.sort_unstable_by(|a, b| b.1.score.cmp(&a.1.score).then_with(|| a.0.cmp(&b.0)));
    let found = named + result.test_files - result.named_test_files + usize::from(inline);
    // Mentions alone score at most `MENTION_CAP`, so they come after every named or importing test.
    let strong = named + result.importing_test_files + usize::from(inline);
    let cap = if strong > 0 { (strong + MENTION_ONLY).min(MAX_TESTS) } else { MAX_TESTS };
    ranked.truncate(cap);
    let shown = ranked.len();
    let lines: Vec<String> = ranked.into_iter().map(|(test, score)| format!("{test} ({})", score.why.join(", "))).collect();
    let mut head = head(&[("path", json!(path)), ("stem", json!(stem)), ("found", json!(found))]);
    if found > shown {
        head.insert("omitted_tests".into(), json!(found - shown));
    }
    Item::new(Category::TestsFor, head, Body::Lines(plain_lines(lines)))
}

/// Whether a source file holds its own tests; its text is taken from the call's allowance.
fn has_inline_tests(ctx: &Ctx, path: &str, target: &std::path::Path) -> bool {
    if is_test_path(path) {
        return false;
    }
    let Some(bytes) = super::read_file(ctx.root, target, crate::workspace::MAX_READ_BYTES, ctx.strict) else { return false };
    if !ctx.limit.take_bytes(bytes.len()) {
        return false;
    }
    let text = String::from_utf8_lossy(&bytes);
    INLINE_MARKS.iter().any(|mark| text.contains(mark))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems_skip_generic_file_names() {
        assert_eq!(stem_of("src/foo_bar.test.ts").unwrap(), "foo_bar");
        assert_eq!(stem_of("src/design/mod.rs").unwrap(), "design");
        assert_eq!(stem_of("pkg/billing/index.ts").unwrap(), "billing");
        assert!(stem_of("src/main.rs").unwrap_err().contains("too generic"));
        assert!(stem_of("lib.rs").unwrap_err().contains("too generic"));
        assert!(stem_of("a.rs").unwrap_err().contains("too short"));
    }

    #[test]
    fn recognises_test_paths() {
        for path in ["tests/a.mjs", "src/__tests__/a.ts", "src/a.test.ts", "src/a.spec.tsx", "pkg/a_test.go", "spec/a_spec.rb", "test_a.py", "src/FooTest.java", "src/explore/tests.rs", "pkg/tests.py", "Sources/FooTests.swift", "App.Tests/Foo.cs"] {
            assert!(is_test_path(path), "{path}");
        }
        for path in ["src/a.ts", "src/latest.rs", "src/contest/a.rs", "tests/fixtures/a.ts", "src/__snapshots__/a.test.ts", "tests/data.json", "tests/README.md", "tests/testdata/x.go"] {
            assert!(!is_test_path(path), "{path}");
        }
    }

    #[test]
    fn names_whose_lowercase_changes_length_do_not_panic() {
        // A letter right before the word joins it, whatever its width.
        assert!(!name_has_word("İİİİapp日日.test.ts", "app"));
        assert!(!name_has_word("tests/ȺȺȺȺappé.test.ts", "app"));
        assert!(name_has_word("İİİİ.app.test.ts", "app"));
        assert!(name_has_word("Ⱥ.app.test.ts", "app"));
    }

    #[test]
    fn name_matches_keep_to_identifier_boundaries() {
        for (name, word) in [("app.test.ts", "app"), ("AppTest.java", "App"), ("test_app.py", "app"), ("app_test.go", "app"), ("MyAppTest.java", "App")] {
            assert!(name_has_word(name, word), "{name}");
        }
        for (name, word) in [("snapshot_test.go", "app"), ("wrapper.test.ts", "app"), ("happy.spec.ts", "app")] {
            assert!(!name_has_word(name, word), "{name}");
        }
    }
}
