//! Glob filters as agents write them (moved from `tests.rs`).
use super::{
    tests::{shown_paths, Repo},
    *,
};

fn search_paths(reply: &Value) -> Vec<String> {
    shown_paths(&reply["search"][0])
}

#[test]
fn globs_filter_in_every_way_an_agent_writes_them() {
    let repo = Repo::new();
    repo.write("src/a.rs", "needle\n");
    repo.write("src/gen/b.rs", "needle\n");
    repo.write("web/c.ts", "needle\n");
    let paths = |globs: Value| search_paths(&repo.explore(json!({"search":["needle"],"glob":globs})));
    assert_eq!(paths(json!(["*.rs"])), ["src/a.rs", "src/gen/b.rs"]);
    assert_eq!(paths(json!(["web/**"])), ["web/c.ts"]);
    assert_eq!(paths(json!(["!**/gen/**", "!*.ts"])), ["src/a.rs"]);
    assert_eq!(paths(json!(["!gen/"])), ["src/a.rs", "web/c.ts"]);
    assert_eq!(paths(json!(["src/../web/**"])), ["web/c.ts"], "`..` that stays inside is fine");
    let wild = repo.explore(json!({"search":["needle"],"glob":["*/../web/**"]}));
    assert!(wild["glob_errors"][0].as_str().unwrap().contains("wildcard"), "{wild}");
    let absolute = format!("{}/web", repo.0.display());
    for glob in ["./web", "web/", "web", "./web/", absolute.as_str()] {
        assert_eq!(paths(json!([glob])), ["web/c.ts"], "{glob}");
    }
    let bad = repo.explore(json!({"search":["needle"],"glob":["a{"]}));
    assert!(bad["glob_errors"][0].as_str().unwrap().contains("a{"), "{bad}");
    assert!(bad["search"][0]["error"].as_str().unwrap().contains("glob"), "an invalid glob searches nothing rather than everything");
    let outside = repo.explore(json!({"search":["needle"],"glob":["/etc/**"]}));
    assert!(outside["glob_errors"][0].as_str().unwrap().contains("outside"), "{outside}");
}

#[test]
fn a_negated_folder_is_anchored_only_when_it_is_a_root_folder() {
    let repo = Repo::new();
    repo.write("web/c.ts", "needle\n");
    repo.write("src/web/d.ts", "needle\n");
    repo.write("src/gen/b.rs", "needle\n");
    let paths = |glob: &str| search_paths(&repo.explore(json!({"search":["needle"],"glob":[glob]})));
    // `web` is a root folder: only it is left out, not `src/web`.
    assert_eq!(paths("!web/"), ["src/gen/b.rs", "src/web/d.ts"]);
    // No root `gen`: it means a `gen` folder anywhere, as rg reads it.
    assert_eq!(paths("!gen/"), ["src/web/d.ts", "web/c.ts"]);
}

#[test]
fn a_glob_list_keeps_classes_escapes_and_real_paths_whole() {
    let repo = Repo::new();
    repo.write("a,b.txt", "needle\n");
    repo.write("a.txt", "needle\n");
    repo.write("dir,x/in.rs", "needle\n");
    repo.write("c.txt", "needle\n");
    let paths = |glob: &str| search_paths(&repo.explore(json!({"search":["needle"],"glob":[glob]})));
    assert_eq!(paths("a,b.txt"), ["a,b.txt"], "a file with a comma in its name");
    assert_eq!(paths("./dir,x"), ["dir,x/in.rs"], "a folder with a comma in its name");
    assert_eq!(paths("a[,.]*txt,c.txt"), ["a,b.txt", "a.txt", "c.txt"]);
    assert_eq!(paths("a\\,b.txt,c.txt"), ["a,b.txt", "c.txt"]);
    // Not a real path: still a list.
    assert_eq!(paths("a.txt,c.txt"), ["a.txt", "c.txt"]);
    let empty = run(&repo.0, &json!({"search":["needle"],"glob":[" , "]}));
    assert!(empty.unwrap_err().contains("glob: an item holds no glob"), "refused, never a whole-project search");
}

#[test]
fn globs_keep_existing_absolute_comma_paths_whole() {
    let repo = Repo::new();
    for path in ["a,b.txt", "b.txt", "src/a.rs", "tests/b.rs", "other.rs"] {
        repo.write(path, "needle\n");
    }
    let limit = limit::Limit::new(Arc::default());
    let ctx = Ctx { root: &repo.0, given: &repo.0, strict: false, limit: &limit, policy: index::Policy::NeverIndex };
    let check_comma_path = |path: String| {
        let globs = glob::Globs::new(&ctx, &[path]);
        assert!(globs.errors.is_empty(), "{:?}", globs.errors);
        assert!(globs.allows("a,b.txt"));
        assert!(!globs.allows("b.txt"), "the file name was split at the comma");
    };
    check_comma_path("a,b.txt".into());
    let absolute = repo.0.join("a,b.txt");
    check_comma_path(absolute.to_str().unwrap().to_owned());
    #[cfg(windows)]
    check_comma_path(crate::path_match::ordinary_windows_path(absolute.to_str().unwrap()).unwrap());

    let globs = glob::Globs::new(&ctx, &["src/*.rs,tests/*.rs".into()]);
    assert!(globs.errors.is_empty(), "{:?}", globs.errors);
    assert!(globs.allows("src/a.rs"));
    assert!(globs.allows("tests/b.rs"));
    assert!(!globs.allows("other.rs"));
}

#[test]
fn windows_absolute_comma_paths_strip_the_volume_but_drive_relative_paths_split() {
    let root = Path::new(r"\\?\C:\repo");
    let given = Path::new(r"C:\repo");
    let split = |raw| glob::split_list(raw, |item| {
        let relative = relative_under(root, given, item, true);
        glob::literal_glob_path(item, relative) == Some("a,b.txt")
    });
    assert_eq!(split(r"C:\repo\a,b.txt"), [r"C:\repo\a,b.txt"]);
    assert_eq!(split(r"C:a,b.txt"), ["C:a", "b.txt"]);
}

#[test]
fn a_dot_glob_means_its_folder() {
    let repo = Repo::new();
    repo.write("src/a.rs", "needle\n");
    repo.write("b.rs", "needle\n");
    let paths = |glob: &str| search_paths(&repo.explore(json!({"search":["needle"],"glob":[glob]})));
    assert_eq!(paths("."), ["b.rs", "src/a.rs"]);
    assert_eq!(paths("./."), ["b.rs", "src/a.rs"]);
    assert_eq!(paths("src/."), ["src/a.rs"]);
}

#[cfg(unix)]
#[test]
fn a_comma_path_is_looked_up_only_inside_the_project() {
    let repo = Repo::new();
    let outside = Repo::new();
    outside.write("x,c.txt", "needle\n");
    std::os::unix::fs::symlink(&outside.0, repo.0.join("link")).unwrap();
    repo.write("c.txt", "needle\n");
    // A Windows drive form: never one path, even where it is a legal file name.
    repo.write("C:x,c.txt", "needle\n");
    let paths = |glob: &str| search_paths(&repo.explore(json!({"search":["needle"],"glob":[glob]})));
    // Through a symlink out of the project, the name is not checked: the list splits.
    assert_eq!(paths("link/x,c.txt"), ["c.txt"]);
    assert_eq!(paths("C:x,c.txt"), ["c.txt"]);
    assert_eq!(paths("src/../c.txt,nothing"), ["c.txt"]);
}

#[test]
fn a_glob_a_later_one_overrides_is_not_said_to_match_nothing() {
    let repo = Repo::new();
    repo.write("src/a.rs", "needle\n");
    repo.write("web/c.ts", "needle\n");
    let reply = repo.explore(json!({"search":["needle"],"glob":["src/**", "*.rs", "*.py"]}));
    assert_eq!(search_paths(&reply), ["src/a.rs"]);
    assert_eq!(reply["glob_warnings"], json!(["*.py matches no searchable file"]), "{reply}");
}

#[test]
fn a_negated_glob_never_names_a_large_file() {
    let repo = Repo::new();
    repo.write("a.rs", "needle\n");
    // A file really named `!big.txt`, past the walk's size: `!big.txt` excludes `big.txt`, so
    // it must not be searched as a file named by the glob.
    let size = usize::try_from(crate::workspace::MAX_READ_BYTES).unwrap() + 1;
    repo.write("!big.txt", [b"needle\n".as_slice(), &vec![b'x'; size]].concat());
    let reply = repo.explore(json!({"search":["needle"],"glob":["!big.txt"]}));
    assert_eq!(search_paths(&reply), ["a.rs"], "{reply}");
}

#[test]
fn a_glob_says_what_it_filtered_out() {
    let repo = Repo::new();
    repo.write("src/a.rs", "needle\nneedle\n");
    repo.write("web/c.ts", "needle\n");
    repo.write("web/d.ts", "needle\n");
    repo.write("web/e.ts", "needle\n");
    repo.write("web/f.ts", "needle\n");
    let reply = repo.explore(json!({"search":["needle"],"glob":["src/**"]}));
    assert_eq!(reply["search"][0]["matches"], 2);
    assert_eq!(reply["search"][0]["outside_glob"], json!({"matches":4,"files":4}), "hits inside: only the counts outside");
    assert_eq!(reply["coverage"]["files_in_scope"], 1);
    assert_eq!(reply["coverage"]["files"], 5);
    let none = repo.explore(json!({"search":["needle"],"glob":["*.py"]}));
    assert_eq!(none["search"][0]["matches"], 0);
    assert_eq!(none["search"][0]["outside_glob"]["files"], 5);
    assert_eq!(none["search"][0]["outside_glob"]["hits"], json!(["src/a.rs:1:needle", "web/c.ts:1:needle", "web/d.ts:1:needle"]), "no hit inside: the first outside it");
    assert_eq!(none["glob_warnings"], json!(["*.py matches no searchable file"]));
    let nothing = repo.explore(json!({"search":["needle"]}));
    assert!(nothing["search"][0].get("outside_glob").is_none() && nothing.get("glob_warnings").is_none());
}

#[test]
fn duplicate_large_file_globs_count_once() {
    let repo = Repo::new();
    let size = usize::try_from(crate::workspace::MAX_READ_BYTES).unwrap() + 1;
    repo.write("large.txt", vec![b'x'; size]);
    repo.write("other.txt", vec![b'x'; size]);
    let limit = limit::Limit::new(Arc::default());
    let ctx = Ctx { root: &repo.0, given: &repo.0, strict: false, limit: &limit, policy: index::Policy::NeverIndex };
    let snapshot = index::Snapshot::open(&repo.0, ctx.policy, false, &limit);
    assert!(snapshot.walk.files.is_empty());
    let globs = glob::Globs::new(&ctx, &["large.txt".into(), "large.txt".into()]);
    assert_eq!(globs.named_large.len(), 1);
    assert_eq!(globs.files_in_scope(&snapshot), 1);
    assert!(globs.warnings(&snapshot).is_empty());
    let ordered = glob::Globs::new(&ctx, &["other.txt".into(), "large.txt".into(), "other.txt".into()]);
    assert_eq!(ordered.named_large.iter().map(|path| &**path).collect::<Vec<_>>(), ["other.txt", "large.txt"]);
    assert_eq!(ordered.files_in_scope(&snapshot), 2);
}

#[test]
fn an_excluded_large_file_does_not_count_in_scope_or_warn() {
    let repo = Repo::new();
    let size = usize::try_from(crate::workspace::MAX_READ_BYTES).unwrap() + 1;
    repo.write("large.txt", vec![b'x'; size]);
    let limit = limit::Limit::new(Arc::default());
    let ctx = Ctx { root: &repo.0, given: &repo.0, strict: false, limit: &limit, policy: index::Policy::NeverIndex };
    let snapshot = index::Snapshot::open(&repo.0, ctx.policy, false, &limit);
    let globs = glob::Globs::new(&ctx, &["large.txt".into(), "!large.txt".into()]);
    assert!(!globs.allows("large.txt"));
    assert_eq!(globs.named_large.len(), 1, "keep excluded paths for the positive glob's warning check");
    assert_eq!(globs.files_in_scope(&snapshot), 0);
    assert!(globs.warnings(&snapshot).is_empty());
}

#[test]
fn a_file_that_grows_after_the_walk_is_counted_once() {
    let repo = Repo::new();
    repo.write("large.txt", "small\n");
    let limit = limit::Limit::new(Arc::default());
    let ctx = Ctx { root: &repo.0, given: &repo.0, strict: false, limit: &limit, policy: index::Policy::NeverIndex };
    let snapshot = index::Snapshot::open(&repo.0, ctx.policy, false, &limit);
    assert_eq!(snapshot.walk.files.len(), 1);
    let size = usize::try_from(crate::workspace::MAX_READ_BYTES).unwrap() + 1;
    repo.write("large.txt", vec![b'x'; size]);
    let globs = glob::Globs::new(&ctx, &["large.txt".into(), "large.txt".into()]);
    assert_eq!(globs.named_large.len(), 1);
    assert_eq!(globs.files_in_scope(&snapshot), 1);
}

#[test]
fn windows_backslash_globs_match_normalized_paths() {
    let repo = Repo::new();
    repo.write("src/a.rs", "needle\n");
    repo.write("src/b.rs", "needle\n");
    repo.write("src/gen/c.rs", "needle\n");
    repo.write("web/d.ts", "needle\n");
    repo.write("src/a,b.txt", "needle\n");
    let paths = |globs: Value| search_paths(&repo.explore(json!({"search":["needle"],"glob":globs})));
    assert_eq!(paths(json!([r"src\a.rs"])), ["src/a.rs"]);
    assert_eq!(paths(json!([r"web\"])), ["web/d.ts"]);
    assert_eq!(paths(json!([r".\web", r".\web\"])), ["web/d.ts"]);
    assert_eq!(paths(json!([r"src\**\*.rs"])), ["src/a.rs", "src/b.rs", "src/gen/c.rs"]);
    assert_eq!(paths(json!([r"src\sub\..\a.rs"])), ["src/a.rs"]);
    assert_eq!(paths(json!([r"!web\"])), ["src/a,b.txt", "src/a.rs", "src/b.rs", "src/gen/c.rs"]);
    assert_eq!(paths(json!([r"!gen\"])), ["src/a,b.txt", "src/a.rs", "src/b.rs", "web/d.ts"]);
    assert_eq!(paths(json!([r"src\{a,b}.rs"])), ["src/a.rs", "src/b.rs"]);
    assert_eq!(paths(json!([r"src\sub\..\a\,b.txt"])), ["src/a,b.txt"]);
    // `Ctx::relative_slash` normalizes backslashes after stripping the root prefix.
    let limit = limit::Limit::new(Arc::default());
    let ctx = Ctx { root: &repo.0, given: &repo.0, strict: false, limit: &limit, policy: index::Policy::Auto };
    let with_backslash = format!("{}/{}", repo.0.display(), r"src\a.rs");
    assert_eq!(ctx.relative_slash(&with_backslash).as_deref(), Some("src/a.rs"));
    let trailing_backslash = format!("{}/{}", repo.0.display(), r"web\");
    assert_eq!(ctx.relative_slash(&trailing_backslash).as_deref(), Some("web/"));
}
