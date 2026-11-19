//! Whole calls: the reply budget, broad searches, reads, globs and the shared host.
use super::{
    grep::{run_jobs, Job, Kind, Scope},
    index::{Policy, Snapshot},
    limit::Limit,
    tests::Repo,
    *,
};
use std::{fs, sync::atomic::AtomicBool};

fn size(reply: &Value) -> usize {
    serde_json::to_string(reply).unwrap().len()
}

/// Three files under a 900-byte folder path whose lines are mostly control characters, which
/// JSON escapes to six bytes each.
fn control_repo() -> Repo {
    let repo = Repo::new();
    let deep = (0..4).map(|at| format!("{}{at}", "d".repeat(220))).collect::<Vec<_>>().join("/");
    let noise = "\u{1}".repeat(140);
    let text: String = (0..20).map(|n| format!("{noise}needle{n:02}{noise}\n")).collect();
    for at in 0..3 {
        repo.write(&format!("{deep}/file{at}.txt"), &text);
    }
    repo.write("src/other.rs", "x\n");
    repo
}

#[test]
fn every_byte_of_a_reply_counts_against_the_budget() {
    let repo = control_repo();
    let searches: Vec<String> = (0..20).map(|n| format!("needle{n:02}")).collect();
    let reply = repo.explore(json!({"search":searches,"glob":["src/**"]}));
    assert!(size(&reply) <= BUDGET, "{}", size(&reply));
    assert!(reply["search"][0]["outside_glob"]["files"].as_u64().is_some(), "{reply}");
    let label = "\u{1}".repeat(195);
    let many = |key: &str| (0..20).map(|at| format!("{label}{key}{at}")).collect::<Vec<_>>();
    let mut globs = many("g");
    globs[0] = "src/**".into();
    let reply = run(&repo.0, &json!({"search":searches,"glob":globs,"outline":many("o"),"read":many("r"),"symbols":many("s")})).unwrap();
    assert!(size(&reply) <= BUDGET, "{}", size(&reply));
    for key in ["search", "outline", "read", "symbols"] {
        assert_eq!(reply[key].as_array().unwrap().len(), 20, "every request still answers: {key}");
    }
    // Reads that fill their share leave each other request room to say what it is.
    repo.write("long.txt", "a line long enough to fill a read's share of the reply\n".repeat(400));
    let reads: Vec<String> = (0..20).map(|at| format!("long.txt:{}-400", at + 1)).collect();
    let reply = run(&repo.0, &json!({"search":searches,"glob":["src/**"],"outline":many("o"),"read":reads,"symbols":many("s")})).unwrap();
    assert!(size(&reply) <= BUDGET, "{}", size(&reply));
    for (key, field) in [("search", "matches"), ("symbols", "definitions")] {
        assert!(reply[key].as_array().unwrap().iter().all(|item| item.get(field).is_some()), "{key} keeps {field}: {}", reply[key]);
    }
    assert!(reply["outline"].as_array().unwrap().iter().all(|item| item["error"] == "File not found."), "{}", reply["outline"]);
}

fn broad(repo: &Repo, name: &str) {
    for at in 0..6 {
        repo.write(&format!("src/caller{at}.ts"), format!("{name}();\n{name}();\n{name}();\n"));
    }
}

#[test]
fn a_line_only_assigning_the_name_is_not_its_definition() {
    let repo = Repo::new();
    broad(&repo, "handleLogin");
    repo.write("src/auth.ts", "const a = handleLogin;\nconst b = handleLogin;\nconst c = handleLogin;\nexport function handleLogin() {\n  return 1;\n}\n");
    let text = repo.explore(json!({"search":["handleLogin"]}))["search"][0]["text"].as_str().unwrap().to_owned();
    assert!(text.contains("4:export function handleLogin()"), "{text}");
    repo.write("tasks.py", "run_job = handle_task\nrun_two = handle_task\nrun_three = handle_task\ndef handle_task():\n    pass\n");
    broad(&repo, "handle_task");
    let text = repo.explore(json!({"search":["handle_task"]}))["search"][0]["text"].as_str().unwrap().to_owned();
    assert!(text.contains("4:def handle_task()"), "{text}");
}

#[test]
fn a_definition_after_many_mentions_in_its_file_is_shown() {
    let repo = Repo::new();
    repo.write("a.ts", format!("{}export function handleThing() {{\n}}\n", "handleThing();\n".repeat(9)));
    let text = repo.explore(json!({"search":["handleThing"]}))["search"][0]["text"].as_str().unwrap().to_owned();
    assert!(text.contains("10:export function handleThing()"), "{text}");
}

#[test]
fn which_files_keep_their_lines_does_not_depend_on_thread_timing() {
    let repo = Repo::new();
    for at in 0..600 {
        repo.write(&format!("f{at:03}.txt"), "needle\n".repeat(8));
    }
    let limit = Limit::new(Arc::default());
    let snapshot = Snapshot::open(&repo.0, Policy::NeverIndex, false, &limit);
    let jobs = [Job { pattern: plan::compile("needle", true).unwrap(), kind: Kind::Search { context: 0 } }];
    let scope = Scope { allows: &|_| true, named_large: Vec::new() };
    for _ in 0..3 {
        let outcome = run_jobs(&repo.0, &snapshot, &jobs, &scope, &limit);
        let kept: Vec<&str> = outcome.jobs[0].files.iter().filter(|file| !file.groups.is_empty()).map(|file| &*file.path).collect();
        let first: Vec<String> = (0..500).map(|at| format!("f{at:03}.txt")).collect();
        assert_eq!(kept, first);
    }
}

#[test]
fn a_strict_query_names_no_binary_only_the_plain_walk_saw() {
    let repo = Repo::new();
    repo.write(".vscode/blob.dat", b"a\0b");
    repo.write("a.rs", "fn a() {}\n");
    let ask = json!({"search":["absent_token"]});
    let plain = run_with(&repo.0, &ask, false, Limit::new(Arc::default()), Policy::AlwaysIndex).unwrap();
    assert_eq!(plain["coverage"]["skipped"]["binary"]["first"], json!([".vscode/blob.dat"]), "{plain}");
    let strict = run_with(&repo.0, &ask, true, Limit::new(Arc::default()), Policy::AlwaysIndex).unwrap();
    assert!(strict["coverage"]["skipped"].get("binary").is_none(), "{strict}");
}

#[test]
fn a_line_location_reads_a_window_around_it() {
    let repo = Repo::new();
    repo.write("a.rs", (1..=100).map(|n| format!("line {n}\n")).collect::<String>());
    for (raw, from, to) in [("a.rs:42:57", 32, 72), ("a.rs:42:13:", 32, 72), ("a.rs:42:fn x", 32, 72), ("a.rs:3", 1, 33), ("a.rs:95", 85, 100)] {
        let read = &repo.explore(json!({"read":[raw]}))["read"][0];
        assert_eq!((read["from"].as_u64(), read["to"].as_u64()), (Some(from), Some(to)), "{raw}: {read}");
    }
    let read = &repo.explore(json!({"read":["a.rs:10-12"]}))["read"][0];
    assert_eq!(read["text"], "10:line 10\n11:line 11\n12:line 12\n");
}

#[test]
fn a_stopped_call_says_stopped_even_when_every_slot_is_taken() {
    let gate = limit::Gate::new(0);
    let stopped = Limit::new(Arc::new(AtomicBool::new(true)));
    assert_eq!(gate.enter(&stopped).err(), Some(limit::Refusal::Stopped));
    let late = Limit::lasting(std::time::Duration::from_millis(20), Arc::default());
    assert_eq!(gate.enter(&late).err(), Some(limit::Refusal::Busy));
}

#[test]
fn a_range_read_holds_only_its_lines() {
    let repo = Repo::new();
    repo.write("big.txt", format!("first\nsecond\n{}", "x".repeat(4 * 1024 * 1024)));
    let read = &repo.explore(json!({"read":["big.txt:1-2"]}))["read"][0];
    assert_eq!(read["text"], "1:first\n2:second\n", "{read}");
    assert_eq!(read["total_lines"], 3);
    repo.write("late.bin", [b"a\n".repeat(10).as_slice(), b"\0"].concat());
    assert_eq!(repo.explore(json!({"read":["late.bin:1-2"]}))["read"][0]["error"], "Binary file.");
}

#[test]
fn globs_may_not_climb_out_of_the_project() {
    let repo = Repo::new();
    repo.write("a.rs", "needle\n");
    let outside = repo.0.parent().unwrap().join(format!("{}-big.bin", repo.0.file_name().unwrap().to_string_lossy()));
    fs::write(&outside, vec![b'x'; 17 * 1024 * 1024]).unwrap();
    let name = format!("../{}", outside.file_name().unwrap().to_string_lossy());
    let reply = repo.explore(json!({"search":["needle"],"glob":[name, "src/../../x/**"]}));
    let errors = reply["glob_errors"].to_string();
    fs::remove_file(&outside).unwrap();
    assert!(!errors.contains("MiB"), "{errors}");
    assert_eq!(reply["glob_errors"].as_array().unwrap().len(), 2, "{reply}");
    assert!(errors.contains(".."), "{errors}");
    // Nor say how big a credential file is.
    repo.write("certs/big.pem", vec![b'x'; 17 * 1024 * 1024]);
    let reply = repo.explore(json!({"search":["needle"],"glob":["certs/big.pem"]}));
    assert!(!reply.to_string().contains("MiB"), "{reply}");
}

#[test]
fn a_comma_joined_glob_string_scopes_like_a_list() {
    let repo = Repo::new();
    for path in ["src/a/one.ts", "src/b/two.ts", "src/b/skip.test.ts", "lib/three.ts"] {
        repo.write(path, "needle\n");
    }
    let reply = repo.explore(json!({"search":"needle","glob":"src/a/one.ts, src/b/*.ts,!**/*.test.ts","limit":5}));
    assert_eq!(reply["coverage"]["files_in_scope"], 2, "{reply}");
    let text = reply["search"][0]["text"].as_str().unwrap();
    assert!(text.contains("src/a/one.ts") && text.contains("src/b/two.ts") && !text.contains("skip") && !text.contains("lib/"), "{reply}");
    assert!(reply.get("glob_warnings").is_none(), "{reply}");
}

#[test]
fn a_broad_search_stays_within_its_cap_and_names_its_other_files() {
    let repo = Repo::new();
    for at in 0..40 {
        repo.write(&format!("src/module_{at:02}.rs"), "fn needle_here() { needle(); }\n".repeat(5));
    }
    let reply = repo.explore(json!({"search":["needle"]}));
    let search = &reply["search"][0];
    assert!(size(search) <= shape::SEARCH_CAP, "{}", size(search));
    assert!(search["more_files"].as_str().unwrap().contains("src/module_"), "{search}");
}

#[test]
fn the_shared_host_answers_stops_and_hands_other_tools_to_its_base() {
    let repo = Repo::new();
    repo.write("lib.rs", "fn needle() {}\n");
    let stopped: Arc<AtomicBool> = Arc::default();
    let root = repo.0.clone();
    let base = ToolHost { tools: vec![json!({"name":"other"})], approval_tools: Default::default(), handler: Arc::new(|_, _| Box::pin(async { Ok(json!("base")) })) };
    let host = host(Some(base), move || Ok(root.clone()), stopped.clone(), false);
    assert_eq!(host.tools.len(), 2);
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let found = (host.handler)(EXPLORE_TOOL.into(), json!({"symbols":"needle"})).await.unwrap();
        assert!(found.to_string().contains("lib.rs"), "{found}");
        assert_eq!((host.handler)("other".into(), json!({})).await.unwrap(), "base");
        stopped.store(true, Ordering::SeqCst);
        assert_eq!((host.handler)(EXPLORE_TOOL.into(), json!({"symbols":"needle"})).await.unwrap_err(), "Task has stopped.");
    });
}

#[test]
fn the_trace_fixture_is_the_engines_reply() {
    let fixture: Value = serde_json::from_str(include_str!("../../../tests/fixtures/explore-reply.json")).unwrap();
    let repo = Repo::new();
    for (path, text) in fixture["repo"].as_object().unwrap() {
        repo.write(path, text.as_str().unwrap());
    }
    assert_eq!(repo.explore(fixture["args"].clone()), fixture["reply"]);
}

/// A memory measure: 20 range reads of files just under the named-file cap. Run under `/usr/bin/time -l` for the peak.
#[test]
#[ignore = "writes 300 MiB; a memory measure, not a check"]
fn twenty_range_reads_of_large_files() {
    let repo = Repo::new();
    let text = "a line of text to fill the file\n".repeat(usize::try_from(named::MAX_NAMED_BYTES).unwrap() / 32 - 1);
    let reads: Vec<String> = (0..20).map(|at| format!("f{at}.txt:1-2")).collect();
    for at in 0..20 {
        repo.write(&format!("f{at}.txt"), &text);
    }
    let reply = repo.explore(json!({"read":reads}));
    assert_eq!(reply["read"][19]["text"], "1:a line of text to fill the file\n2:a line of text to fill the file\n");
}

#[test]
fn a_definition_is_recognised_by_its_whole_name_only() {
    let repo = Repo::new();
    // `logger` and `t_logger` end inside the name, `get` and `g` start it: none of them is it.
    repo.write("f2b/util.py", "logger = get_logger(\"a\")\nt_logger = get_logger(\"b\")\nget = get_logger(\"c\")\ng = get_logger(\"d\")\ndef get_logger(name):\n    return name\n");
    for at in 0..7 {
        repo.write(&format!("f2b/m{at}.py"), "get_logger()\nget_logger()\nget_logger()\n");
    }
    let reply = repo.explore(json!({"search":["get_logger"],"glob":["f2b/**"]}));
    let text = reply["search"][0]["text"].as_str().unwrap();
    assert!(text.contains("5:def get_logger(name):"), "{text}");
}

#[test]
fn the_file_defining_the_name_comes_first() {
    let repo = Repo::new();
    for at in 1..=40 {
        repo.write(&format!("a{at:02}.py"), "from z import frob_widget\n".to_owned() + &"frob_widget()\n".repeat(9));
    }
    repo.write("z.py", "def frob_widget():\n    return 1\n");
    // With 20 lines of context the first files alone fill what a search holds.
    for context in [0, 20] {
        let reply = repo.explore(json!({"search":["frob_widget"],"context":context}));
        let text = reply["search"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("z.py\n"), "{context}: {text}");
        assert!(text.contains("1:def frob_widget():"), "{context}: {text}");
    }
}

#[test]
fn equal_requests_that_do_not_all_fit_are_served_in_the_order_asked() {
    let repo = Repo::new();
    let deep = (0..4).map(|at| format!("{}{at}", "p".repeat(210))).collect::<Vec<_>>().join("/");
    let searches: Vec<String> = (0..20).map(|at| format!("needle{at:02}")).collect();
    for at in 0..16 {
        repo.write(&format!("{deep}/f{at:02}.txt"), format!("needle{at:02}\n"));
    }
    let reply = repo.explore(json!({"search":searches}));
    let shown: Vec<usize> = reply["search"].as_array().unwrap().iter().enumerate().filter(|(_, item)| item["text"].as_str().is_some_and(|text| text.contains(":needle"))).map(|(at, _)| at).collect();
    assert!(shown.len() >= 12, "{shown:?}");
    assert_eq!(shown, (0..shown.len()).collect::<Vec<_>>(), "the first asked are answered first");
    assert!(size(&reply) <= BUDGET);
}

#[test]
fn one_call_reads_at_most_its_byte_allowance() {
    let repo = Repo::new();
    let text = "fn a() {}\n".repeat(20_000);
    let files: Vec<String> = (0..20).map(|at| format!("f{at:02}.rs")).collect();
    files.iter().for_each(|name| repo.write(name, &text));
    let with_bytes = |args: Value, bytes: usize| run_with(&repo.0, &args, false, Limit::with_bytes(bytes), Policy::Auto).unwrap();
    let reply = with_bytes(json!({"outline":files}), 1024 * 1024);
    let read = with_bytes(json!({"read":["f00.rs"]}), 200);
    // Each kept line takes its 9 bytes of text.
    assert_eq!(read["read"][0]["text"].as_str().unwrap().lines().count(), 200 / 9);
    assert!(read["read"][0]["next"].is_string());
    let refused = reply["outline"].as_array().unwrap().iter().filter(|item| item["error"].as_str().is_some_and(|error| error.contains("this call"))).count();
    assert!((10..20).contains(&refused), "{refused} refused");
}

#[test]
fn only_a_file_inside_the_project_is_taken_whole() {
    let repo = Repo::new();
    let name = format!("{}-o.rs:3", repo.0.file_name().unwrap().to_string_lossy());
    let outside = repo.0.parent().unwrap().join(&name);
    fs::write(&outside, "a\n").unwrap();
    repo.write("in.rs:3", "x\n");
    repo.write("id_rsa:3", "x\n");
    let limit = Limit::new(Arc::default());
    let ctx = Ctx { root: &repo.0, given: &repo.0, strict: false, limit: &limit, policy: Policy::Auto };
    let outside_whole = named::whole_file(&ctx, &format!("../{name}"));
    fs::remove_file(&outside).unwrap();
    assert!(!outside_whole);
    assert!(named::whole_file(&ctx, "in.rs:3"));
    assert!(!named::whole_file(&ctx, "id_rsa:3"), "a credential is not looked at");
}

#[test]
fn an_empty_definition_lookup_names_what_was_skipped() {
    let repo = Repo::new();
    repo.write("a.rs", "call_it();\n");
    repo.write(".env", "X=1\n");
    let reply = repo.explore(json!({"symbols":["call_it"]}));
    assert_eq!(reply["coverage"]["skipped"]["secret"]["count"], 1, "{reply}");
}

#[test]
fn cut_call_wide_fields_mark_the_reply_truncated() {
    let repo = Repo::new();
    repo.write("a.rs", "x\n");
    let globs: Vec<String> = (0..20).map(|at| format!("a{{{at}{}", "x".repeat(180))).collect();
    let reply = repo.explore(json!({"search":["x"],"glob":globs}));
    assert!(reply["search"][0]["error"].is_string(), "{reply}");
    assert_eq!(reply["truncated"], true, "{reply}");
}

#[test]
fn a_crlf_read_shows_no_carriage_returns() {
    let repo = Repo::new();
    repo.write("a.txt", "one\r\ntwo\r\n");
    assert_eq!(repo.explore(json!({"read":["a.txt"]}))["read"][0]["text"], "1:one\n2:two\n");
}

#[test]
fn a_match_across_lines_outside_the_glob_gets_no_note() {
    let repo = Repo::new();
    repo.write("out/a.rs", "abc\ndef\n");
    repo.write("src/b.rs", "x\n");
    let reply = repo.explore(json!({"search":[r"abc\s+def"],"glob":["src/**"]}));
    assert!(reply["search"][0].get("note").is_none(), "{reply}");
}

#[test]
fn a_test_file_is_not_its_own_inline_test() {
    let repo = Repo::new();
    repo.write("tests/alpha_test.rs", "#[test]\nfn a() {}\n");
    let reply = repo.explore(json!({"tests_for":["tests/alpha_test.rs"]}));
    assert!(!reply["tests_for"][0].to_string().contains("inline tests"), "{reply}");
}

#[test]
fn mentions_count_for_little_beside_a_test_named_for_the_file() {
    let repo = Repo::new();
    repo.write("src/billing.ts", "");
    repo.write("tests/billing.spec.ts", "// nothing\n");
    repo.write("tests/zeta.spec.ts", "billing\n".repeat(5));
    let reply = repo.explore(json!({"tests_for":["src/billing.ts"]}));
    assert!(reply["tests_for"][0]["text"].as_str().unwrap().starts_with("tests/billing.spec.ts (name)"), "{reply}");
}

#[test]
fn a_call_of_only_reads_may_fill_the_whole_reply() {
    let repo = Repo::new();
    repo.write("big.rs", ("x".repeat(60) + "\n").repeat(1_000));
    let reply = repo.explore(json!({"read":["big.rs"]}));
    let read = &reply["read"][0];
    assert!(read["text"].as_str().unwrap().len() > BUDGET * 7 / 8, "{}", read["text"].as_str().unwrap().len());
    assert!(read["note"].as_str().unwrap().contains("next"), "{read}");
    assert!(size(&reply) <= BUDGET);
}
