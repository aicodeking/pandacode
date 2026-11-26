//! Edge cases found in review: the off switch, the byte allowance, file kinds and ordering.
use super::{index::Policy, limit::Limit, tests::Repo, *};

fn with_bytes(repo: &Repo, args: Value, bytes: usize) -> Value {
    run_with(&repo.0, &args, false, Limit::with_bytes(bytes), Policy::Auto).unwrap()
}

fn text(item: &Value) -> &str {
    item["text"].as_str().unwrap_or_default()
}

#[test]
fn a_lossy_copy_of_a_non_utf8_file_is_counted() {
    let repo = Repo::new();
    let mut bytes = b"fn a() {}\n// ".to_vec();
    bytes.extend(std::iter::repeat_n(0xFF, 1_000));
    repo.write("a.rs", &bytes);
    let fits = with_bytes(&repo, json!({"outline":["a.rs"]}), bytes.len() * 5);
    assert!(text(&fits["outline"][0]).contains("a 1-1"), "{fits}");
    // The raw bytes fit; their copy, three bytes for each bad one, does not.
    let spent = with_bytes(&repo, json!({"outline":["a.rs"]}), bytes.len() * 2);
    assert!(spent["outline"][0]["error"].as_str().unwrap().contains("this call"), "{spent}");
}

#[cfg(unix)]
#[test]
fn a_named_file_is_opened_at_the_path_that_was_checked() {
    let repo = Repo::new();
    repo.write("real.rs", "fn a() {}\n");
    std::os::unix::fs::symlink(repo.0.join("real.rs"), repo.0.join("link.rs")).unwrap();
    let limit = Limit::new(Arc::default());
    let ctx = Ctx { root: &repo.0, given: &repo.0, strict: false, limit: &limit, policy: Policy::Auto };
    let (relative, target) = named::resolve_named(&ctx, "link.rs").unwrap();
    assert_eq!((relative.as_str(), target), ("link.rs", repo.0.join("real.rs")));
    assert_eq!(text(&repo.explore(json!({"read":["link.rs"]}))["read"][0]), "1:fn a() {}\n");
}

#[test]
fn a_definition_keyword_says_function_already() {
    let repo = Repo::new();
    repo.write("a.py", "def frob_widget():\n    pass\n");
    repo.write("b.kt", "fun frob_widget() {\n}\n");
    repo.write("c.swift", "func frob_widget() {\n}\n");
    let reply = repo.explore(json!({"symbols":["frob_widget"]}));
    let shown = text(&reply["symbols"][0]);
    assert!(shown.contains("1-2 def frob_widget():") && shown.contains("1-2 fun frob_widget() {") && shown.contains("1-2 func frob_widget() {"), "{shown}");
    assert!(!shown.contains("function"), "{shown}");
    // Ruby's `def` makes a method, which the keyword does not say.
    repo.write("d.rb", "class A\n  def frob_widget\n  end\nend\n");
    let ruby = repo.explore(json!({"symbols":["frob_widget"],"glob":["d.rb"]}));
    assert!(text(&ruby["symbols"][0]).contains("2-3 method def frob_widget"), "{ruby}");
}

#[test]
fn an_outline_of_an_unknown_file_type_takes_nothing() {
    let repo = Repo::new();
    repo.write("notes.txt", "x".repeat(1_000));
    repo.write("a.rs", "fn a() {}\n");
    let reply = with_bytes(&repo, json!({"outline":["notes.txt", "a.rs"]}), 500);
    assert!(reply["outline"][0]["error"].as_str().unwrap().starts_with("No outline"), "{reply}");
    assert!(text(&reply["outline"][1]).contains("fn a"), "{reply}");
}

#[test]
fn outlines_take_the_allowance_in_the_order_asked() {
    let repo = Repo::new();
    // The first file is the slowest to read, so later ones would finish first.
    repo.write("f00.rs", "fn a() {}\n".repeat(200_000));
    let small = "fn b() {}\n".repeat(1_000);
    let files: Vec<String> = (0..12).map(|at| format!("f{at:02}.rs")).collect();
    files[1..].iter().for_each(|name| repo.write(name, &small));
    let allowance = 2_000_000 + 5 * small.len();
    for _ in 0..3 {
        let reply = with_bytes(&repo, json!({"outline":files}), allowance);
        let spent: Vec<usize> = reply["outline"].as_array().unwrap().iter().enumerate().filter(|(_, item)| item["error"].as_str().is_some_and(|error| error.contains("this call"))).map(|(at, _)| at).collect();
        assert_eq!(spent, (6..12).collect::<Vec<_>>(), "{reply}");
    }
}

#[test]
fn a_broad_search_that_fits_its_cap_keeps_every_hit() {
    let repo = Repo::new();
    for at in 0..8 {
        repo.write(&format!("src/m{at}.rs"), "x\nwidget_hit();\ny\nwidget_hit();\nz\nwidget_hit();\n");
    }
    let search = &repo.explore(json!({"search":["widget_hit"]}))["search"][0];
    assert_eq!(search["matches"], 24);
    assert_eq!(text(search).matches(":widget_hit();").count(), 24, "{search}");
    assert!(search.get("truncated").is_none(), "{search}");
}

#[test]
fn a_search_at_the_broad_line_over_its_cap_is_not_trimmed() {
    let repo = Repo::new();
    let call = format!("edge_hit(); // {}\n", "x".repeat(150));
    repo.write("a.rs", call.repeat(BROAD_MATCHES / 2));
    repo.write("b.rs", call.repeat(BROAD_MATCHES / 2));
    let search = &repo.explore(json!({"search":["edge_hit"]}))["search"][0];
    assert_eq!(search["matches"], BROAD_MATCHES, "{search}");
    let shown = text(search);
    // Trimmed, each file would keep `BROAD_FILE_HITS`; untrimmed, each keeps what the cap holds.
    assert!(search.get("omitted_lines").is_none_or(|omitted| omitted.as_u64() < Some(4)), "{search}");
    assert!(shown.split("b.rs").next().unwrap().matches(":edge_hit();").count() > BROAD_FILE_HITS, "{search}");
}

#[test]
fn one_file_over_the_broad_line_and_its_cap_is_not_trimmed() {
    let repo = Repo::new();
    let pad = "x".repeat(130);
    repo.write("a.rs", format!("lone_hit(); // {pad}\nfiller // {pad}\n").repeat(BROAD_MATCHES + 4));
    let search = &repo.explore(json!({"search":["lone_hit"], "context": 1}))["search"][0];
    assert_eq!(search["matches"], BROAD_MATCHES + 4, "{search}");
    // Trimming is for spreading the cap over many files; one file keeps what the cap holds.
    assert!(text(search).matches(":lone_hit();").count() > BROAD_FILE_HITS, "{search}");
}

#[test]
fn no_across_lines_note_when_a_line_matches() {
    let repo = Repo::new();
    repo.write("a.rs", "foo\nbar\n");
    repo.write("b.rs", "foo bar\n");
    let search = &repo.explore(json!({"search":[r"foo\s+bar"]}))["search"][0];
    assert_eq!(search["matches"], 1);
    assert!(search.get("note").is_none(), "{search}");
}

#[test]
fn mentions_alone_never_outrank_a_test_named_for_the_file() {
    let repo = Repo::new();
    repo.write("src/widget.rs", "pub fn a() {}\n");
    repo.write("tests/a_widget_test.rs", "widget::x();\n");
    // An import and three mentions: capped, they tie with the name and its one mention.
    repo.write("tests/b.rs", "use crate::widget;\nwidget::a();\nwidget::b();\n");
    let found = text(&repo.explore(json!({"tests_for":["src/widget.rs"]}))["tests_for"][0]).to_owned();
    let (named, other) = (found.find("tests/a_widget_test.rs").unwrap(), found.find("tests/b.rs").unwrap());
    assert!(named < other, "{found}");
}

#[test]
fn inline_tests_are_looked_for_within_the_allowance() {
    let repo = Repo::new();
    repo.write("src/widget.rs", format!("pub fn a() {{}}\n{}\n#[cfg(test)]\nmod tests {{}}\n", "// x\n".repeat(200)));
    let args = json!({"tests_for":["src/widget.rs"]});
    assert!(text(&repo.explore(args.clone())["tests_for"][0]).contains("(inline tests)"));
    assert!(!text(&with_bytes(&repo, args, 100)["tests_for"][0]).contains("(inline tests)"));
}

#[test]
fn search_text_has_no_carriage_returns() {
    let repo = Repo::new();
    repo.write("a.rs", "a\r\nneedle\r\nb\r\n");
    let search = &repo.explore(json!({"search":["needle"],"context":1}))["search"][0];
    assert_eq!(text(search), "a.rs\n1-a\n2:needle\n3-b\n", "{search}");
}

#[test]
fn a_dollar_joins_a_javascript_name() {
    let repo = Repo::new();
    // `get` defined on this line is not what `$get` names.
    repo.write("b.js", "function get() { return $get; }\n");
    repo.write("a.js", "x = $get;\n");
    let search = &repo.explore(json!({"search":[r"\$get"]}))["search"][0];
    let shown = text(search);
    assert!(shown.find("a.js").unwrap() < shown.find("b.js").unwrap(), "path order, as neither defines it: {shown}");
}

#[test]
fn a_named_file_past_the_named_size_is_said_not_searched() {
    let repo = Repo::new();
    let most = usize::try_from(named::MAX_NAMED_BYTES).unwrap();
    repo.write("at_most.txt", vec![b'x'; most]);
    repo.write("over.txt", vec![b'x'; most + 1]);
    let reply = repo.explore(json!({"search":["needle"],"glob":["at_most.txt", "over.txt"]}));
    assert_eq!(reply["glob_errors"], json!([format!("over.txt: larger than {} MiB, so not searched", most / (1024 * 1024))]), "{reply}");
    // Read by name, each file that cannot be opened says why.
    repo.write("dir/a.rs", "");
    let reply = repo.explore(json!({"read":["over.txt", "at_most.txt:1", "dir", "gone.rs"]}));
    let errors: Vec<&str> = (0..4).map(|at| reply["read"][at]["error"].as_str().unwrap_or("")).collect();
    assert!(errors[0].starts_with("File is larger than") && errors[1].is_empty(), "{reply}");
    assert_eq!(errors[2..], ["This is a folder.", "File not found."], "{reply}");
}

#[test]
fn a_trimmed_search_keeps_each_file_s_definition() {
    let repo = Repo::new();
    let call = format!("foo_hit(); // {}\n", "x".repeat(110));
    repo.write("a.rs", format!("{}fn foo_hit() {{}}\n", call.repeat(10)));
    repo.write("b.rs", call.repeat(10));
    repo.write("c.rs", call.repeat(10));
    let search = &repo.explore(json!({"search":["foo_hit"]}))["search"][0];
    assert!(search["omitted_lines"].as_u64().is_some(), "trimmed: {search}");
    assert!(text(search).contains("11:fn foo_hit() {}"), "{search}");
}

#[test]
fn trailing_space_with_none_present_gives_no_across_lines_note() {
    let repo = Repo::new();
    repo.write("a.rs", "fn a() {}\nfn b() {}\n");
    let reply = repo.explore(json!({"search":[r"\s+$"]}));
    assert!(reply["search"][0].get("note").is_none(), "{reply}");
}

/// Off, or in the cloud, a run gets no tool name (the marker itself is tested in `app_marker`).
#[test]
fn the_off_switch_and_cloud_drop_the_tool() {
    assert_eq!(run_name(false, true, "claude"), Some(RunExplore { name: "pandacode_explore", claude_code: true }));
    assert_eq!(run_name(false, true, "glm").map(|run| run.claude_code), Some(true));
    assert_eq!(run_name(false, true, "codex"), Some(RunExplore { name: "pandacode_explore", claude_code: false }));
    assert_eq!(run_name(false, true, "grok").map(|run| (run.name, run.claude_code)), Some(("pandacode_architect__pandacode_explore", false)));
    assert_eq!(run_name(false, false, "claude"), None);
    assert_eq!(run_name(true, true, "claude"), None);
}

/// Claude Code requires the main marker. Every other harness needs both markers.
#[test]
fn explore_requires_the_main_opt_in_for_all_harnesses() {
    let no = || Ok(false);
    assert!(!effective("claude", Ok(false), no), "the switch is off");
    assert!(!effective("claude", Err("unreadable".into()), no), "fails closed");
    assert!(effective("claude", Ok(true), no), "included when enabled");
    for provider in ["glm", "mimo", "alibaba", "codex", "kimi", "opencode", "pi", "omp", "grok"] {
        assert!(!effective(provider, Ok(false), || Ok(true)), "{provider}: the switch wins");
        assert!(!effective(provider, Err("unreadable".into()), || Ok(true)), "{provider}: main marker fails closed");
        assert!(!effective(provider, Ok(true), no), "{provider}: off until opted in");
        assert!(effective(provider, Ok(true), || Ok(true)), "{provider}: opted in");
        assert!(!effective(provider, Ok(true), || Err("unreadable".into())), "{provider}: harness marker fails closed");
    }
}

#[cfg(unix)]
#[test]
fn a_symlinked_home_is_compared_by_its_real_path() {
    let repo = Repo::new();
    std::fs::create_dir(repo.0.join("real")).unwrap();
    std::os::unix::fs::symlink(repo.0.join("real"), repo.0.join("link")).unwrap();
    let home = real_home(repo.0.join("link"));
    assert_eq!(home, repo.0.join("real").canonicalize().unwrap());
    // The home itself is too broad once the link is resolved.
    assert!(crate::workspace::root_refusal(&home, Some(&home), false).is_some());
    assert_eq!(real_home(repo.0.join("missing")), repo.0.join("missing"));
}

/// Extensions are compared in lowercase: `LOGO.PNG` is media and `Main.RS` is Rust.
#[test]
fn extensions_are_read_in_any_case() {
    assert!(media_path("assets/LOGO.PNG") && media_path("a/b.Png") && !media_path("a/b.rs") && !media_path("png"));
    let repo = Repo::new();
    repo.write("Main.RS", "fn alpha() {}\n");
    let reply = repo.explore(json!({"outline":["Main.RS"]}));
    assert!(reply.to_string().contains("alpha"), "{reply}");
}

/// `path#name` in a file the outline cannot read (Markdown) points to a plain read, not to an
/// outline that would say the same.
#[test]
fn a_named_read_of_a_file_without_definitions_says_read_it() {
    let repo = Repo::new();
    repo.write("README.md", "# Setup\nrun it\n");
    let reply = repo.explore(json!({"read":["README.md#Setup"]}));
    let error = reply["read"][0]["error"].as_str().unwrap_or_default();
    assert!(error.contains("read it") && !error.contains("outline the file"), "{reply}");
    let reply = repo.explore(json!({"read":["main.rs#nothing"]}));
    assert!(reply["read"][0]["error"].is_string(), "{reply}");
}

#[test]
fn tests_for_ranks_test_files() {
    let repo = Repo::new();
    repo.write("src/billing.ts", "export const billing = 1;\n");
    repo.write("src/billing.test.ts", "import { billing } from './billing';\nbilling;\n");
    repo.write("tests/flow.spec.ts", "// billing is mentioned here\n");
    repo.write("tests/multi.spec.ts", "import {\n  billing,\n} from './x';\n");
    repo.write("tests/other.spec.ts", "// nothing here\n");
    repo.write("tests/fixtures/billing.ts", "billing\n");
    repo.write("tests/billing.json", "\"billing\"\n");
    repo.write("src/mentions.ts", "billing\n");
    repo.write("src/inline.rs", "fn a() {}\n#[cfg(test)]\nmod tests {}\n");
    let reply = repo.explore(json!({"tests_for":["src/billing.ts","src/inline.rs",".env","src/main.rs"]}));
    let text = reply["tests_for"][0]["text"].as_str().unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines[0].starts_with("src/billing.test.ts (name, imports it"), "{text}");
    assert!(lines[1].starts_with("tests/multi.spec.ts (imports it"), "{text}");
    assert!(lines[2].starts_with("tests/flow.spec.ts (1 mentions"), "{text}");
    assert_eq!(lines.len(), 3, "{text}");
    assert!(reply["tests_for"][1]["text"].as_str().unwrap().starts_with("src/inline.rs (inline tests)"));
    assert!(reply["tests_for"][2]["error"].is_string());
    assert!(reply["tests_for"][3]["error"].as_str().unwrap().contains("too generic"));
}

#[test]
fn tests_for_reports_what_it_left_out() {
    let repo = Repo::new();
    repo.write("src/billing.ts", "");
    for at in 0..25 {
        repo.write(&format!("tests/t{at}.spec.ts"), "billing\n");
    }
    let reply = repo.explore(json!({"tests_for":["src/billing.ts"]}));
    assert_eq!(reply["tests_for"][0]["omitted_tests"], 5);
    assert_eq!(reply["tests_for"][0]["found"], 25);
    let none = repo.explore(json!({"tests_for":["src/alone.ts"]}));
    assert_eq!(none["tests_for"][0]["found"], 0, "{none}");
    assert_eq!(reply["tests_for"][0]["text"].as_str().unwrap().lines().count(), 20);
}

/// A common stem (`shape`) is a word in many unrelated tests: once a test is named for the file
/// or imports it, at most `MENTION_ONLY` tests that only mention it follow.
#[test]
fn tests_for_caps_mention_only_tests_behind_real_ones() {
    let repo = Repo::new();
    repo.write("src/shape.rs", "");
    repo.write("tests/shape_test.rs", "use crate::shape;\n");
    for at in 0..10 {
        repo.write(&format!("tests/t{at}_test.rs"), "// the shape of it\n");
    }
    let reply = repo.explore(json!({"tests_for":["src/shape.rs"]}));
    let text = reply["tests_for"][0]["text"].as_str().unwrap();
    assert!(text.starts_with("tests/shape_test.rs (name"), "{reply}");
    assert_eq!(text.lines().count(), 4, "{reply}");
    assert_eq!((reply["tests_for"][0]["found"].as_u64(), reply["tests_for"][0]["omitted_tests"].as_u64()), (Some(11), Some(7)), "{reply}");
}

/// Mentions that each reach `MENTION_CAP` are still mention-only: a `>=` would make them strong.
#[test]
fn tests_for_caps_tests_that_mention_the_stem_twice() {
    let repo = Repo::new();
    repo.write("src/shape.rs", "");
    repo.write("tests/shape_test.rs", "");
    for at in 0..5 {
        repo.write(&format!("tests/t{at}_test.rs"), "// shape
// shape again
");
    }
    let reply = repo.explore(json!({"tests_for":["src/shape.rs"]}));
    assert_eq!(text(&reply["tests_for"][0]).lines().count(), 4, "{reply}");
    assert_eq!(reply["tests_for"][0]["omitted_tests"], 2, "{reply}");
}

/// A file's own inline tests are a strong result: mention-only tests behind them are capped.
#[test]
fn tests_for_caps_mentions_behind_inline_tests() {
    let repo = Repo::new();
    repo.write("src/shape.rs", "fn a() {}\n#[cfg(test)]\nmod tests {}\n");
    for at in 0..5 {
        repo.write(&format!("tests/t{at}_test.rs"), "// shape\n");
    }
    let reply = repo.explore(json!({"tests_for":["src/shape.rs"]}));
    let shown = text(&reply["tests_for"][0]);
    assert!(shown.starts_with("src/shape.rs (inline tests)"), "{reply}");
    assert_eq!(shown.lines().count(), 1 + 3, "{reply}");
    assert_eq!(reply["tests_for"][0]["omitted_tests"], 2, "{reply}");
}

/// Only a name's first whole-word use on a line defines it: the property calls in
/// `notify: text => notify(text)` must not push out `function notify(`.
#[test]
fn a_call_after_a_property_of_the_same_name_is_no_definition() {
    let repo = Repo::new();
    let calls = "const a = {\n  notify: text => notify(text),\n};\n".repeat(10);
    repo.write("a.ts", format!("{calls}function notify(text) {{\n  return text;\n}}\n"));
    let search = &repo.explore(json!({"search":[r"notify\("]}))["search"][0];
    assert!(text(search).contains("31:function notify(text) {"), "{search}");
}
