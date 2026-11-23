use super::{
    grep::{matching_lines_recording, FileView},
    index::{parallel, Policy, Snapshot},
    limit::Limit,
    *,
};
use std::{collections::BTreeSet, fs};
#[cfg(unix)]
use std::time::Duration;

pub(super) struct Repo(pub(super) PathBuf);

impl Repo {
    pub(super) fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pandacode-explore-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(root.join(".git")).unwrap();
        Self(root.canonicalize().unwrap())
    }
    pub(super) fn write(&self, path: &str, content: impl AsRef<[u8]>) {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    pub(super) fn explore(&self, args: Value) -> Value {
        run(&self.0, &args).unwrap()
    }
    fn strict(&self, args: Value) -> Value {
        run_checked(&self.0, &args, true, Arc::default()).unwrap()
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn limit() -> Limit {
    Limit::new(Arc::default())
}

/// Every matching file+line for one pattern, with the given index policy, past all output caps.
pub(super) fn hits(root: &Path, pattern: &str, policy: Policy) -> BTreeSet<(String, usize)> {
    let compiled = plan::compile(pattern, false).unwrap();
    let limit = limit();
    // Another test refreshing the same root's index makes this one scan; wait until it is done.
    let mut snapshot = Snapshot::open(root, policy, false, &limit);
    for _ in 0..600 {
        if snapshot.indexed() == (policy == Policy::AlwaysIndex) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
        snapshot = Snapshot::open(root, policy, false, &limit);
    }
    assert_eq!(snapshot.indexed(), policy == Policy::AlwaysIndex, "{pattern}");
    let paths: Vec<Arc<str>> = snapshot.candidates(&compiled.plan).unwrap_or_else(|| snapshot.walk.files.iter().map(|file| file.path.clone()).collect());
    let found = parallel(paths.len(), |at| {
        let bytes = super::read_file(root, &root.join(&*paths[at]), crate::workspace::MAX_READ_BYTES, false)?;
        if bytes.contains(&0) {
            return None;
        }
        let view = FileView::new(&paths[at], &bytes, &limit);
        let matches = matching_lines_recording(&compiled, &bytes, &limit, usize::MAX);
        Some(matches.starts.into_iter().map(|start| (paths[at].to_string(), view.line_at(start).unwrap())).collect::<Vec<_>>())
    });
    found.into_iter().flatten().collect()
}

/// The files a search or symbols reply shows, from its text: the lines that are neither a line
/// of code (`12:`, `12-`) nor a symbol (`@ `), less any ` (N hits)`.
pub(super) fn shown_paths(item: &Value) -> Vec<String> {
    let text = item["text"].as_str().unwrap_or("");
    let file_line = |line: &&str| !line.is_empty() && !line.starts_with("@ ") && !line.split([':', '-']).next().is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
    text.lines().filter(file_line).map(|line| line.split(" (").next().unwrap_or(line).to_owned()).collect()
}

fn pairs(list: &[(&str, usize)]) -> BTreeSet<(String, usize)> {
    list.iter().map(|(path, line)| ((*path).to_owned(), *line)).collect()
}

fn both(root: &Path, pattern: &str) -> BTreeSet<(String, usize)> {
    let scanned = hits(root, pattern, Policy::NeverIndex);
    assert_eq!(scanned, hits(root, pattern, Policy::AlwaysIndex), "{pattern}");
    scanned
}

#[test]
fn index_and_scan_agree_on_tricky_patterns() {
    let repo = Repo::new();
    repo.write("a.txt", "Task\nta\u{17F}\u{212A}\nnone\nhéllo wörld\nabc123xyz\n");
    repo.write("b.rs", "fn task_runner() {}\n// ABC\n");
    for pattern in ["task", "Task", "(?i)TASK", "abc|nomatch", r"abc\d+xyz", "héllo", r"\bfn\b", "^$", r"\w+", "ab", "[a-c]{3}", "(abc)+", "x?y?z?", r"ta\S+", "wörld$", r"\Atask", r"abc\s*\z"] {
        both(&repo.0, pattern);
    }
    assert_eq!(both(&repo.0, "task"), pairs(&[("a.txt", 1), ("a.txt", 2), ("b.rs", 1)]));
}

#[test]
fn the_oracle_helper_sees_past_the_recording_cap() {
    let repo = Repo::new();
    repo.write("many.txt", "x\n".repeat(3_000));
    assert_eq!(both(&repo.0, "x").len(), 3_000);
    assert_eq!(repo.explore(json!({"search":["x"]}))["search"][0]["matches"], 3_000);
}

#[test]
fn edits_deletes_and_renames_show_in_the_next_query() {
    let repo = Repo::new();
    repo.write("a.rs", "needle one\n");
    repo.write("b.rs", "hay\n");
    assert_eq!(both(&repo.0, "needle"), pairs(&[("a.rs", 1)]));

    repo.write("b.rs", "hay\nneedle two\n");
    assert_eq!(both(&repo.0, "needle"), pairs(&[("a.rs", 1), ("b.rs", 2)]));

    // Same size and, on a coarse clock, the same stamp: only the racy check sees this.
    repo.write("a.rs", "noodle one\n");
    assert_eq!(both(&repo.0, "needle"), pairs(&[("b.rs", 2)]));
    assert_eq!(both(&repo.0, "noodle"), pairs(&[("a.rs", 1)]));

    fs::rename(repo.0.join("b.rs"), repo.0.join("c.rs")).unwrap();
    assert_eq!(both(&repo.0, "needle"), pairs(&[("c.rs", 2)]));

    fs::remove_file(repo.0.join("c.rs")).unwrap();
    assert!(both(&repo.0, "needle").is_empty());
}

fn skipped_files_repo() -> Repo {
    let repo = Repo::new();
    repo.write(".gitignore", "ignored.txt\n*.log\n");
    repo.write("ignored.txt", "needle");
    repo.write("a.log", "needle");
    repo.write("node_modules/p/i.js", "needle");
    repo.write("image.bin", b"needle\0\x01");
    repo.write("late_nul.bin", [b"needle\n".repeat(20_000), vec![0]].concat());
    repo.write("big.txt", format!("needle{}", "x".repeat(1024 * 1024 + 1)));
    repo.write(".env", "needle");
    repo.write(".ssh/config", "needle");
    repo.write("certs/a.pem", "needle");
    repo.write(".github/ci.yml", "needle");
    repo.write("latin1.txt", b"caf\xe9 needle\n");
    repo.write("keep.rs", "needle");
    repo
}

#[test]
fn walker_respects_gitignore_binary_large_and_secrets() {
    let repo = skipped_files_repo();
    let found: Vec<String> = both(&repo.0, "needle").into_iter().map(|hit| hit.0).collect();
    assert_eq!(found, [".github/ci.yml", "keep.rs", "latin1.txt"]);
}

#[test]
fn an_empty_lookup_names_what_was_skipped_and_why() {
    let repo = skipped_files_repo();
    for args in [json!({"search":["absent_token"]}), json!({"symbols":["absent_token"]}), json!({"search":["needle","absent_token"]})] {
        let reply = repo.explore(args);
        let skipped = &reply["coverage"]["skipped"];
        assert_eq!(skipped["large"], json!({"count":1,"first":["big.txt"]}), "{reply}");
        assert_eq!(skipped["secret"]["count"], 3);
        assert!(skipped["secret"]["first"].as_array().unwrap().contains(&json!(".ssh/")), "a folder is marked as one");
        assert_eq!(skipped["excluded"], json!({"count":1,"first":["node_modules/"]}));
        // Never the `.git` folder, which is not a finding.
        assert!(!reply.to_string().contains("\".git\""));
    }
    let scanned = repo.explore(json!({"search":["needle","absent_token"]}));
    assert_eq!(scanned["coverage"]["skipped"]["binary"], json!({"count":2}), "two `.bin` files: counted, not named");
}

#[test]
fn a_lookup_with_answers_counts_secret_files_and_names_nothing() {
    let repo = skipped_files_repo();
    // Secret files skipped are always counted, so a hidden file is never mistaken for none.
    let reply = repo.explore(json!({"search":["needle"]}));
    assert_eq!(reply["coverage"], json!({"skipped":{"secret":{"count":3}}}), "{reply}");
    assert!(!reply.to_string().contains("big.txt"));
    // A glob makes the scope worth stating.
    let globbed = repo.explore(json!({"search":["needle"],"glob":["*.rs"]}));
    assert_eq!(globbed["coverage"], json!({"files":6,"files_in_scope":1,"skipped":{"secret":{"count":3}}}));
    let clean = Repo::new();
    clean.write("a.rs", "needle");
    assert!(clean.explore(json!({"search":["needle"]})).get("coverage").is_none());
}

#[test]
fn skipped_media_is_counted_but_not_named() {
    let repo = Repo::new();
    repo.write("logo.png", b"\x89PNG\0");
    repo.write("data.dat", b"a\0b");
    let reply = repo.explore(json!({"search":["absent_token"]}));
    assert_eq!(reply["coverage"]["skipped"]["binary"], json!({"count":2,"first":["data.dat"]}), "{reply}");
}

#[test]
fn example_env_files_are_searched_and_real_ones_named_when_a_lookup_is_empty() {
    let repo = Repo::new();
    for path in [".env.sample", ".env.example", ".env.template", ".env.dist", ".env.test", ".env.development", "src/vs/platform/secrets/common/secrets.ts", "config/secrets/prod.yaml"] {
        repo.write(path, "DATABASE_URL=needle\n");
    }
    let found = repo.explore(json!({"search":["DATABASE_URL"]}));
    assert_eq!(shown_paths(&found["search"][0]), [".env.dist", ".env.example", ".env.sample", ".env.template", "src/vs/platform/secrets/common/secrets.ts"]);
    let strict = repo.strict(json!({"search":["DATABASE_URL"]}));
    assert_eq!(shown_paths(&strict["search"][0]), [".env.dist", ".env.example", ".env.sample", ".env.template"]);
    let empty = repo.explore(json!({"search":["NOT_THERE"]}));
    let refused = empty["coverage"]["skipped"]["secret"]["first"].as_array().unwrap();
    for name in [".env.test", ".env.development", "config/secrets/prod.yaml"] {
        assert!(refused.contains(&json!(name)), "{name} in {empty}");
    }
}

#[test]
fn a_call_cut_short_names_what_was_skipped_even_with_answers() {
    let repo = skipped_files_repo();
    // Cut once and then free to run, so the walk still reaches every file it reports.
    let stopped = Arc::new(AtomicBool::new(true));
    let limit = Limit::new(stopped.clone());
    assert!(limit.expired());
    stopped.store(false, Ordering::Relaxed);
    let reply = run_with(&repo.0, &json!({"search":["needle"]}), false, limit, Policy::NeverIndex).unwrap();
    assert_eq!(reply["incomplete"], true);
    assert_eq!(reply["search"][0]["files"], 3);
    assert_eq!(reply["coverage"]["skipped"]["large"], json!({"count":1,"first":["big.txt"]}));
}

#[test]
fn the_two_secret_rules_differ_only_on_names_that_are_not_clear_credentials() {
    let repo = Repo::new();
    for path in ["src/secret_store.rs", ".eslintrc.json", ".env", "secrets.yaml", "plain.rs"] {
        repo.write(path, "needle\n");
    }
    let paths = |reply: &Value| shown_paths(&reply["search"][0]);
    assert_eq!(paths(&repo.explore(json!({"search":["needle"]}))), [".eslintrc.json", "plain.rs", "src/secret_store.rs"]);
    assert_eq!(paths(&repo.strict(json!({"search":["needle"]}))), ["plain.rs"]);
    assert_eq!(repo.explore(json!({"read":["src/secret_store.rs"]}))["read"][0]["text"], "1:needle\n");
    assert!(repo.strict(json!({"read":["src/secret_store.rs"]}))["read"][0]["error"].as_str().unwrap().contains("credentials"));
    assert!(repo.explore(json!({"read":[".env"]}))["read"][0]["error"].as_str().unwrap().contains("credentials"));
}

#[test]
fn a_stray_gitignore_above_a_folder_with_no_repository_hides_nothing() {
    let outer = std::env::temp_dir().join(format!("pandacode-explore-outer-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(outer.join("project")).unwrap();
    fs::write(outer.join(".gitignore"), "*\n").unwrap();
    fs::write(outer.join("project/.gitignore"), "own.txt\n").unwrap();
    fs::write(outer.join("project/a.rs"), "needle\n").unwrap();
    fs::write(outer.join("project/own.txt"), "needle\n").unwrap();
    let reply = run(&outer.join("project"), &json!({"search":["needle"]})).unwrap();
    assert_eq!(reply["search"][0]["files"], 1, "{reply}");
    assert_eq!(shown_paths(&reply["search"][0]), ["a.rs"]);
    fs::remove_dir_all(outer).unwrap();
}

#[cfg(unix)]
#[test]
fn symlinks_are_neither_followed_nor_read() {
    let repo = Repo::new();
    let outside = Repo::new();
    outside.write("notes.txt", "needle");
    repo.write("real.txt", "needle");
    std::os::unix::fs::symlink(outside.0.join("notes.txt"), repo.0.join("link.txt")).unwrap();
    std::os::unix::fs::symlink(&outside.0, repo.0.join("dir")).unwrap();
    std::os::unix::fs::symlink(repo.0.join(".env"), repo.0.join("hidden_env")).unwrap();
    repo.write(".env", "needle");
    assert_eq!(both(&repo.0, "needle"), pairs(&[("real.txt", 1)]));
    let reply = repo.explore(json!({"read":["link.txt","dir/notes.txt","hidden_env","real.txt"]}));
    let reads = reply["read"].as_array().unwrap();
    assert!(reads[0]["error"].as_str().unwrap().contains("outside"), "{reply}");
    assert!(reads[1]["error"].as_str().unwrap().contains("outside"), "{reply}");
    assert!(reads[2]["error"].as_str().unwrap().contains("credentials"), "{reply}");
    assert_eq!(reads[3]["text"], "1:needle\n");
}

#[cfg(unix)]
#[test]
fn a_fifo_does_not_hang_a_call() {
    let repo = Repo::new();
    repo.write("real.rs", "#[test]\nfn a() {}\n");
    let status = std::process::Command::new("mkfifo").arg(repo.0.join("pipe.rs")).status().unwrap();
    assert!(status.success());
    let root = repo.0.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || sender.send(run(&root, &json!({"read":["pipe.rs"],"outline":["pipe.rs"],"tests_for":["pipe.rs"],"search":["fn"]}))));
    let reply = receiver.recv_timeout(Duration::from_secs(20)).expect("a FIFO must not block a call").unwrap();
    assert!(reply["read"][0]["error"].as_str().unwrap().contains("regular"), "{reply}");
    assert!(reply["outline"][0]["error"].as_str().unwrap().contains("regular"), "{reply}");
}

#[test]
fn explicit_paths_refuse_escapes_and_secrets_per_item() {
    let repo = Repo::new();
    repo.write("ok.rs", "fn a() {}\n");
    repo.write(".env", "TOKEN=x\n");
    repo.write(".git/config", "x");
    repo.write("server.key", "x");
    repo.write("zero.bin", b"a\0b");
    let reply = repo.explore(json!({"read":["../x",".env",".git/config","server.key","gone.rs","zero.bin","ok.rs",".","ok.rs:5-1","ok.rs:9","ok.rs#nope"]}));
    let reads = reply["read"].as_array().unwrap();
    for (at, expected) in [(0, "inside"), (1, "credentials"), (2, "credentials"), (3, "credentials"), (4, "not found"), (5, "Binary"), (7, "folder"), (8, "range"), (9, "past the end"), (10, "No definition")] {
        assert!(reads[at]["error"].as_str().is_some_and(|error| error.contains(expected)), "{at}: {}", reads[at]);
    }
    assert_eq!(reads[6]["text"], "1:fn a() {}\n");
    assert!(!reply.to_string().contains("TOKEN"));
    // A bad item never fails the batch, and an outline shares the rules.
    let reply = repo.explore(json!({"outline":["ok.rs",".env"],"search":["(","fn"]}));
    assert!(reply["outline"][1]["error"].is_string());
    assert!(reply["search"][0]["error"].as_str().unwrap().contains("Invalid regular"));
    assert_eq!(reply["search"][1]["matches"], 1);
}

#[test]
fn only_bad_patterns_still_get_their_own_answers() {
    let repo = Repo::new();
    repo.write("a.rs", "x\n");
    let reply = repo.explore(json!({"search":["(", "a\\nb"],"symbols":[" "],"read":["a.rs"]}));
    assert!(reply["search"][0]["error"].as_str().unwrap().contains("Invalid regular"));
    assert!(reply["search"][1]["error"].as_str().unwrap().contains("within one line"));
    assert!(reply["symbols"][0]["error"].is_string());
    assert_eq!(reply["read"][0]["text"], "1:x\n");
    assert!(reply.get("coverage").is_none());
}

#[test]
fn too_broad_a_root_is_refused_for_every_rule() {
    let parent = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().last().unwrap();
    assert!(run(parent, &json!({"read":["etc/hosts"]})).unwrap_err().contains("too broad"));
    assert!(run_checked(parent, &json!({"search":["x"]}), true, Arc::default()).unwrap_err().contains("too broad"));
}

#[test]
fn hits_are_grouped_by_file_and_enclosing_symbol() {
    let repo = Repo::new();
    repo.write("a.rs", "fn first() {\n    needle();\n    other();\n    needle();\n}\n\nfn second() {\n    needle();\n}\nneedle\n");
    let reply = repo.explore(json!({"search":["needle"],"context":1}));
    let result = &reply["search"][0];
    assert_eq!((result["matches"].as_u64(), result["files"].as_u64()), (Some(4), Some(1)));
    assert_eq!(result["text"], "a.rs\n@ first 1-5\n1-fn first() {\n2:needle();\n3-other();\n4:needle();\n5-}\n@ second 7-9\n7-fn second() {\n8:needle();\n9-}\n@ -\n10:needle\n");
}

#[test]
fn symbols_outline_and_ranges() {
    let repo = Repo::new();
    repo.write("src/a.rs", "pub struct Foo {\n    x: u8,\n}\nimpl Foo {\n    pub fn run(&self) {\n        self.x;\n    }\n}\n");
    repo.write("src/b.ts", "export function run(a: string) {\n}\nconst other = run('x');\n");
    let reply = repo.explore(json!({"symbols":["run","Foo::run","missing","run()","run(_:)"],"outline":["src/a.rs"],"read":["src/a.rs:2-3","src/a.rs#run","src/a.rs:7-","src/a.rs:7","src/a.rs#Foo::run"]}));
    let run = &reply["symbols"][0];
    assert_eq!(run["definitions"], 2);
    assert_eq!(run["text"], "src/a.rs\n5-7 pub fn run(&self) {\nsrc/b.ts\n1-2 export function run(a: string) {\n");
    assert_eq!(reply["symbols"][1]["definitions"], 1, "the qualifier narrows");
    assert_eq!(reply["symbols"][2]["definitions"], 0);
    assert_eq!(reply["symbols"][3]["definitions"], 2);
    assert_eq!(reply["symbols"][4]["definitions"], 2);
    let outline = reply["outline"][0]["text"].as_str().unwrap();
    assert_eq!(outline, "struct Foo 1-3\nimpl Foo 4-8\n  fn run 5-7\n");
    assert_eq!(reply["read"][0]["text"], "2:    x: u8,\n3:}\n");
    assert_eq!(reply["read"][1]["from"], 5);
    assert_eq!(reply["read"][1]["to"], 7);
    assert_eq!(reply["read"][2]["text"], "7:    }\n8:}\n");
    assert_eq!((reply["read"][3]["from"].as_u64(), reply["read"][3]["to"].as_u64()), (Some(1), Some(8)), "a location reads around it");
    assert_eq!(reply["read"][4]["from"], 5);
}

#[test]
fn deeply_nested_outlines_bound_retained_text_and_keep_exact_omissions() {
    let repo = Repo::new();
    let total_symbols = 8_000;
    let mut source: String = (0..total_symbols).map(|at| format!("fn f{at}() {{\n")).collect();
    source.push_str(&"}\n".repeat(total_symbols));
    let total_source_lines = source.lines().count();
    repo.write("nested.rs", &source);

    let limit = limit();
    let ctx = Ctx { root: &repo.0, given: &repo.0, strict: false, limit: &limit, policy: Policy::NeverIndex };
    let item = named::outline_item(&ctx, "nested.rs", named::outline_text(&ctx, "nested.rs"));
    assert!(!limit.was_cut());
    assert_eq!(item.total_lines, total_symbols);
    assert_eq!(item.head["total_lines"], total_source_lines);
    let shape::Body::Lines(lines) = &item.body else { panic!("expected outline lines") };
    let retained = lines.len();
    let retained_bytes: usize = lines.iter().map(|line| line.text.len()).sum();
    assert!(retained > named::MAX_OUTLINE_DEPTH && retained < total_symbols, "retained {retained} lines");
    assert!(retained_bytes <= named::MAX_OUTLINE_BYTES, "retained {retained_bytes} bytes");
    assert!(lines.iter().all(|line| line.text.bytes().take_while(|&byte| byte == b' ').count() <= 2 * named::MAX_OUTLINE_DEPTH));

    // Even when all retained lines fit, construction's dropped lines must be reported.
    let mut roomy = Map::new();
    assert!(shape::assemble(vec![item], 2 * named::MAX_OUTLINE_BYTES, &mut roomy));
    let outline = &roomy["outline"][0];
    assert_eq!(outline["text"].as_str().unwrap().lines().count(), retained);
    assert_eq!(outline["truncated"], true);
    assert_eq!(outline["omitted_lines"], total_symbols - retained);

    let reply = repo.explore(json!({"outline":"nested.rs"}));
    let outline = &reply["outline"][0];
    let shown = outline["text"].as_str().unwrap().lines().count();
    assert!(shown > 0 && shown < retained);
    assert_eq!(outline["truncated"], true);
    assert_eq!(shown + outline["omitted_lines"].as_u64().unwrap() as usize, total_symbols);
    assert!(reply.to_string().len() <= BUDGET);
}

#[test]
fn an_ambiguous_name_lists_its_ranges() {
    let repo = Repo::new();
    repo.write("a.rs", "impl A {\n    fn run() {}\n}\nimpl B {\n    fn run() {}\n}\n");
    let reply = repo.explore(json!({"read":["a.rs#run","a.rs#B::run"]}));
    assert_eq!(reply["read"][0]["ambiguous"], json!(["fn run 2-2", "fn run 5-5"]));
    assert!(reply["read"][0].get("text").is_none());
    assert_eq!(reply["read"][1]["text"], "5:    fn run() {}\n");
}

#[test]
fn a_definition_lookup_with_no_result_says_why() {
    let repo = Repo::new();
    repo.write("notes.lua", "function thing() end\n");
    repo.write("a.rs", "// other\n");
    repo.write("b.rs", "call(helper);\n");
    let reply = repo.explore(json!({"symbols":["thing","helper","absent"]}));
    let note = reply["symbols"][0]["note"].as_str().unwrap();
    assert!(note.contains("Mentioned in 1 files") && note.contains("Rust"), "{note}");
    assert!(reply["symbols"][1]["note"].as_str().unwrap().contains("no definition was recognised"));
    assert!(reply["symbols"][2].get("note").is_none());
}

#[test]
fn line_ranges_keep_their_upper_bound_through_a_cut() {
    let repo = Repo::new();
    repo.write("a.rs", "// a line of text that takes up some room in the reply\n".repeat(5_000));
    let reply = repo.explore(json!({"read":["a.rs:100-4000","a.rs"]}));
    let next = reply["read"][0]["next"].as_str().unwrap();
    let (from, upper) = next.strip_prefix("a.rs:").unwrap().split_once('-').unwrap();
    assert!(from.parse::<usize>().unwrap() > 100, "{next}");
    assert_eq!(upper, "4000");
    let whole = reply["read"][1]["next"].as_str().unwrap();
    assert!(whole.ends_with('-'), "{whole}");
    let reply = repo.explore(json!({"read":[next]}));
    assert!(reply["read"][0]["text"].as_str().unwrap().starts_with(from), "{reply}");
}

#[test]
fn a_clipped_line_is_marked_and_shows_its_match() {
    let repo = Repo::new();
    repo.write("min.js", format!("{}needle{}\n", "a".repeat(5_000), "b".repeat(5_000)));
    let reply = repo.explore(json!({"search":["needle"]}));
    let result = &reply["search"][0];
    assert_eq!(result["truncated"], true);
    assert_eq!(result["clipped_lines"], 1);
    assert!(result["text"].as_str().unwrap().contains("needle"), "{reply}");
    // `clipped_lines` says it; nothing of the reply was left out.
    assert!(reply.get("truncated").is_none(), "{reply}");
    let read = repo.explore(json!({"read":["min.js"]}));
    assert_eq!(read["read"][0]["clipped_lines"], 1);
}

#[test]
fn a_read_clipped_to_fit_says_so() {
    let repo = Repo::new();
    let wide = format!("{}\n", "\u{1}".repeat(2_000));
    let names: Vec<String> = (0..20).map(|at| format!("w{at}.txt")).collect();
    names.iter().for_each(|name| repo.write(name, &wide));
    let reply = repo.explore(json!({"read":names}));
    for read in reply["read"].as_array().unwrap() {
        assert_eq!(read["truncated"], true, "{read}");
        assert!(read["clipped_lines"].as_u64().unwrap() >= 1, "{read}");
    }
    assert!(serde_json::to_string(&reply).unwrap().len() <= BUDGET);
}

#[test]
fn a_pattern_that_only_matches_across_lines_says_so() {
    let repo = Repo::new();
    repo.write("a.txt", "abc\ndef\n");
    let reply = repo.explore(json!({"search":[r"abc\s+def","(?s)abc.def",r"abc\s+zzz"]}));
    for at in [0, 1] {
        assert_eq!(reply["search"][at]["matches"], 0);
        assert!(reply["search"][at]["note"].as_str().unwrap().contains("across lines"), "{reply}");
    }
    assert!(reply["search"][2].get("note").is_none());
    assert!(repo.explore(json!({"search":[r"abc\ndef"]}))["search"][0]["error"].as_str().unwrap().contains("within one line"));
}

#[test]
fn odd_read_paths() {
    let repo = Repo::new();
    repo.write("C#/foo.cs", "one\ntwo\nthree\n");
    repo.write("d#1/x.rs", "fn a() {}\n");
    repo.write("a:b.rs", "one\n");
    let reply = repo.explore(json!({"read":["C#/foo.cs:2-3","d#1/x.rs:1","a:b.rs:1:1","C#/foo.cs:1:2"]}));
    assert_eq!(reply["read"][0]["text"], "2:two\n3:three\n");
    assert_eq!(reply["read"][1]["text"], "1:fn a() {}\n");
    assert_eq!(reply["read"][2]["text"], "1:one\n");
    assert_eq!(reply["read"][3]["text"], "1:one\n2:two\n3:three\n", "line 1, column 2: the lines around it");
}

#[test]
fn a_named_file_over_the_search_size_has_a_way_in() {
    let repo = Repo::new();
    let big = "a line of text\n".repeat(80_000) + "needle at the end\n";
    assert!(big.len() > 1024 * 1024);
    repo.write("logs/big.txt", &big);
    repo.write("a.rs", "needle\n");
    let plain = repo.explore(json!({"search":["needle"]}));
    assert_eq!(plain["search"][0]["files"], 1);
    assert!(plain.get("coverage").is_none());
    let empty = repo.explore(json!({"search":["only in the big file"]}));
    assert_eq!(empty["coverage"]["skipped"]["large"]["first"], json!(["logs/big.txt"]), "the way to learn the name");
    let named = repo.explore(json!({"search":["needle"],"glob":["logs/big.txt"]}));
    assert_eq!(named["search"][0]["text"], "logs/big.txt\n80001:needle at the end\n", "{named}");
    let read = repo.explore(json!({"read":["logs/big.txt:80000-80001"]}));
    assert_eq!(read["read"][0]["text"], "80000:a line of text\n80001:needle at the end\n");
    let whole = repo.explore(json!({"read":["logs/big.txt"]}));
    assert!(whole["read"][0]["next"].as_str().unwrap().starts_with("logs/big.txt:"));
    assert!(serde_json::to_string(&whole).unwrap().len() <= BUDGET);
}

#[test]
fn replies_stay_under_budget_with_omitted_counts() {
    let repo = Repo::new();
    for at in 0..300 {
        repo.write(&format!("f{at}.txt"), "needle \u{1} and some padding to fill the line\n".repeat(400));
    }
    repo.write("wide.txt", format!("{}\n", "\u{1}".repeat(900_000)));
    let reply = repo.explore(json!({"search":["needle","\\x01","padding"],"read":["wide.txt","f1.txt"],"outline":["f2.txt"],"context":20}));
    let size = serde_json::to_string(&reply).unwrap().len();
    assert!(size <= BUDGET, "{size}");
    assert_eq!(reply["truncated"], true);
    let first = &reply["search"][0];
    assert_eq!(first["matches"], 300 * 400);
    assert!(first["omitted_lines"].as_u64().unwrap() > 1000);
    assert!(first["omitted_files"].as_u64().unwrap() > 0);
    assert!(first.get("hint").is_none() && reply.get("hint").is_none(), "the counts say what was cut");
    let read = &reply["read"][1];
    assert!(read["next"].as_str().unwrap().starts_with("f1.txt:"), "{read}");
    assert!(read["text"].as_str().unwrap().starts_with("1:needle"));
}

#[test]
fn explicit_reads_are_filled_first() {
    let repo = Repo::new();
    for at in 0..50 {
        repo.write(&format!("many{at}.txt"), "needle and more text on this line\n".repeat(300));
    }
    let file = "x".repeat(60) + "\n";
    repo.write("wanted.rs", file.repeat(150));
    let reply = repo.explore(json!({"search":["needle","and more"],"read":["wanted.rs"]}));
    assert!(reply["read"][0].get("truncated").is_none(), "a read that fits is whole");
    assert!(reply["read"][0]["text"].as_str().unwrap().contains("150:"));
    assert!(!shown_paths(&reply["search"][0]).is_empty(), "searches share the rest");
    // A huge read still leaves room for a search.
    repo.write("huge.rs", file.repeat(5_000));
    let reply = repo.explore(json!({"search":["needle"],"read":["huge.rs"]}));
    assert!(reply["read"][0]["truncated"].as_bool().unwrap());
    assert!(!shown_paths(&reply["search"][0]).is_empty());
    assert!(serde_json::to_string(&reply).unwrap().len() <= BUDGET);
}

#[test]
fn a_broad_search_samples_each_file() {
    let repo = Repo::new();
    // Too long to show every file's first hits within the search's cap.
    let line = format!("needle {}\n", "x".repeat(110));
    repo.write("a.txt", line.repeat(30));
    repo.write("b.txt", format!("{line}other\n").repeat(30));
    let reply = repo.explore(json!({"search":["needle"],"context":1}));
    let result = &reply["search"][0];
    assert_eq!(result["matches"], 60);
    let text = result["text"].as_str().unwrap();
    assert!(text.contains("a.txt (30 hits)") && text.contains("b.txt (30 hits)"), "{text}");
    assert_eq!(text.lines().filter(|line| line.contains(":needle")).count(), 4, "{text}");
    assert_eq!(result["omitted_lines"], 56);
    // A narrow search in one file shows its first hits and says how many there are.
    repo.write("narrow.txt", "lonely\n".repeat(6));
    let narrow = repo.explore(json!({"search":["lonely"]}));
    assert_eq!(narrow["search"][0]["text"].as_str().unwrap().lines().count(), 7);
    assert!(narrow["search"][0].get("omitted_lines").is_none());
    repo.write("many.txt", "plenty\n".repeat(30));
    let many = repo.explore(json!({"search":["plenty"]}));
    assert!(many["search"][0]["text"].as_str().unwrap().starts_with("many.txt (30 hits)\n"));
    assert_eq!(many["search"][0]["omitted_lines"], 22);
}

#[test]
fn a_stopped_task_cuts_the_call_short_and_says_so() {
    let repo = Repo::new();
    repo.write("a.rs", "needle\n");
    let reply = run_checked(&repo.0, &json!({"search":["needle"]}), false, Arc::new(AtomicBool::new(true))).unwrap();
    assert_eq!(reply["incomplete"], true);
    assert_eq!(reply["search"][0]["matches"], 0);
    let reply = repo.explore(json!({"search":["needle"]}));
    assert!(reply.get("incomplete").is_none());
}

#[test]
fn concurrent_queries_all_answer_correctly() {
    let repo = Repo::new();
    for at in 0..200 {
        repo.write(&format!("d{}/f{at}.rs", at % 7), format!("fn item{at}() {{}}\nneedle {at}\n"));
    }
    std::thread::scope(|scope| {
        for worker in 0..12 {
            let root = &repo.0;
            scope.spawn(move || {
                let policy = if worker % 2 == 0 { Policy::NeverIndex } else { Policy::AlwaysIndex };
                for round in 0..10 {
                    let reply = run_with(root, &json!({"search":["needle"]}), false, limit(), policy).unwrap();
                    assert_eq!(reply["search"][0]["matches"], 200, "worker {worker} round {round}");
                }
            });
        }
    });
}

#[test]
fn arguments_are_validated() {
    let repo = Repo::new();
    repo.write("a.rs", "x\n");
    assert!(run(&repo.0, &json!({})).is_err());
    assert!(run(&repo.0, &json!({"glob":["*.rs"]})).is_err());
    assert_eq!(run(&repo.0, &json!({"search":"x"})).unwrap()["search"][0]["matches"], 1);
    assert!(run(&repo.0, &json!({"search":[1]})).unwrap_err().contains("expected a list of strings"));
    assert!(run(Path::new("/nonexistent/pandacode"), &json!({"search":["x"]})).is_err());
}

#[test]
fn case_sensitive_turns_smart_case_off() {
    let repo = Repo::new();
    repo.write("a.txt", "Needle\nneedle\n");
    assert_eq!(repo.explore(json!({"search":["needle"]}))["search"][0]["matches"], 2);
    assert_eq!(repo.explore(json!({"search":["needle"],"case_sensitive":true}))["search"][0]["matches"], 1);
    assert_eq!(repo.explore(json!({"search":["Needle"]}))["search"][0]["matches"], 1);
}

#[test]
fn the_description_stays_within_its_budget() {
    let tools = listed(catalog());
    let bytes = serde_json::to_string(&tools[0]).unwrap().len();
    assert!(bytes < 1500, "{bytes}");
    assert_eq!(tools[0]["name"], EXPLORE_TOOL);
    let description = tools[0]["description"].as_str().unwrap();
    for part in ["omit on a first search", "untrusted", r#"{"search":["#, "Stop once a reply has what you need"] {
        assert!(description.contains(part), "{part}");
    }
    // Edit advice is the instructions' (per harness), never the description's.
    assert!(!description.contains("Edit"));
}


#[test]
fn a_broad_search_keeps_the_definition_over_earlier_lines() {
    let repo = Repo::new();
    for at in 0..6 {
        repo.write(&format!("src/caller{at}.ts"), "handleLogin();\nhandleLogin();\nhandleLogin();\n");
    }
    repo.write("src/auth.ts", "// handleLogin is called on submit\nconst login = handleLogin;\nconst a = 1;\nconst b = 2;\nconst c = 3;\nexport function handleLogin() {\n  return 1;\n}\n");
    let reply = repo.explore(json!({"search":["handleLogin"]}));
    let text = reply["search"][0]["text"].as_str().unwrap();
    assert!(text.contains("6:export function handleLogin()"), "{text}");
}

#[test]
fn an_ambiguous_name_with_thousands_of_definitions_stays_bounded() {
    let repo = Repo::new();
    repo.write("rb.rb", "def a; end\n".repeat(5_000));
    let reply = repo.explore(json!({"read":["rb.rb#a"]}));
    let read = &reply["read"][0];
    let listed: Vec<&str> = read["ambiguous"].as_array().unwrap().iter().map(|label| label.as_str().unwrap()).collect();
    assert_eq!(listed.len(), 20, "{read}");
    for (at, label) in listed.iter().enumerate() {
        assert!(label.ends_with(&format!(" a {0}-{0}", at + 1)), "{label}");
    }
    assert_eq!(read["ambiguous_count"], 5_000);
    assert!(serde_json::to_string(&reply).unwrap().len() <= BUDGET);
}

#[test]
fn many_broad_searches_on_deep_paths_stay_under_budget() {
    let repo = Repo::new();
    let deep = (0..4).map(|at| format!("a_rather_long_folder_name_number_{at}")).collect::<Vec<_>>().join("/");
    for at in 0..60 {
        repo.write(&format!("{deep}/file_with_a_long_name_{at}.txt"), "alpha beta gamma\n".repeat(30));
    }
    let searches: Vec<String> = (0..20).map(|at| format!("alpha|beta{at}")).collect();
    let reply = repo.explore(json!({"search":searches}));
    let size = serde_json::to_string(&reply).unwrap().len();
    assert!(size <= BUDGET, "{size}");
    let reads: Vec<String> = (0..20).map(|at| format!("{deep}/file_with_a_long_name_{at}.txt")).collect();
    let both = repo.explore(json!({"search":searches,"read":reads}));
    let size = serde_json::to_string(&both).unwrap().len();
    assert!(size <= BUDGET, "{size}");
}

#[test]
fn paths_under_the_root_as_given_are_inside_it() {
    let root = std::env::temp_dir().join(format!("pandacode-explore-alias-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(root.join("src/real.ts"), "needle\n").unwrap();
    // On macOS the temporary folder is a symlink, so the root as given is not the canonical one.
    let given = root.join("src/real.ts").to_string_lossy().into_owned();
    let glob = format!("{}/src/**", root.display());
    let reply = run(&root, &json!({"read":[given],"search":["needle"],"glob":[glob]})).unwrap();
    assert_eq!(reply["read"][0]["text"], "1:needle\n", "{reply}");
    assert_eq!(reply["search"][0]["matches"], 1, "{reply}");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_search_whose_only_glob_is_invalid_does_not_search_everything() {
    let repo = Repo::new();
    repo.write("a.rs", "needle\n");
    let reply = repo.explore(json!({"search":["needle"],"glob":["a{"]}));
    assert!(reply["glob_errors"][0].as_str().unwrap().contains("a{"));
    assert!(reply["search"][0]["error"].as_str().unwrap().contains("glob"), "{reply}");
    assert!(reply["search"][0].get("matches").is_none());
}

#[cfg(unix)]
#[test]
fn a_symlink_to_a_file_inside_the_project_reads_its_target() {
    let repo = Repo::new();
    repo.write("AGENTS.md", "notes\n");
    repo.write(".env", "TOKEN=x\n");
    std::os::unix::fs::symlink(repo.0.join("AGENTS.md"), repo.0.join("CLAUDE.md")).unwrap();
    std::os::unix::fs::symlink(repo.0.join(".env"), repo.0.join("config.txt")).unwrap();
    let reply = repo.explore(json!({"read":["CLAUDE.md","config.txt"]}));
    assert_eq!(reply["read"][0]["text"], "1:notes\n", "{reply}");
    assert!(reply["read"][1]["error"].as_str().unwrap().contains("credentials"), "{reply}");
}

#[test]
fn a_line_and_column_from_compiler_output_reads_around_that_line() {
    let repo = Repo::new();
    repo.write("a.rs", (1..=50).map(|n| format!("line {n}\n")).collect::<String>());
    let reply = repo.explore(json!({"read":["a.rs:42:13"]}));
    assert_eq!((reply["read"][0]["from"].as_u64(), reply["read"][0]["to"].as_u64()), (Some(32), Some(50)), "{reply}");
}

/// Restore the calling test thread's cap even when an assertion panics.
struct WalkCapGuard(usize);

impl WalkCapGuard {
    fn set(value: usize) -> Self {
        Self(super::index::WALK_CAP.with(|cap| cap.replace(value)))
    }
}

impl Drop for WalkCapGuard {
    fn drop(&mut self) {
        super::index::WALK_CAP.with(|cap| cap.set(self.0));
    }
}

#[test]
fn refused_entries_count_toward_the_walk_cap_and_quit_early() {
    let repo = Repo::new();
    for at in 0..200 {
        repo.write(&format!("secret{at}.pem"), "secret");
    }
    repo.write("valid.rs", "fn valid() {}\n");
    let _cap = WalkCapGuard::set(4);
    let budget = limit();
    let walk = super::index::walk(&repo.0, false, &budget);
    assert!(walk.incomplete && budget.was_cut());
    assert!(walk.secret.count < 200, "the filter must pass a cut entry to the quitting visitor");
    assert!(walk.files.iter().all(|file| file.path.ends_with(".rs")));
}

#[test]
fn expired_or_stopped_walks_quit_before_recording_refused_entries() {
    let repo = Repo::new();
    for at in 0..2_500 {
        repo.write(&format!("secret{at}.pem"), "secret");
    }
    repo.write("valid.rs", "fn valid() {}\n");
    for budget in [Limit::lasting(std::time::Duration::ZERO, Arc::default()), Limit::new(Arc::new(AtomicBool::new(true)))] {
        let walk = super::index::walk(&repo.0, false, &budget);
        assert!(walk.incomplete && budget.was_cut());
        assert_eq!(walk.secret.count, 0);
        assert!(walk.files.is_empty());
    }
}

#[test]
fn a_walk_stopped_at_its_entry_cap_says_the_reply_is_incomplete() {
    let repo = Repo::new();
    for at in 0..10 {
        repo.write(&format!("f{at}.rs"), "needle\n");
    }
    let _cap = WalkCapGuard::set(3);
    let reply = repo.explore(json!({"search":["needle"]}));
    assert_eq!(reply["incomplete"], true, "{reply}");
}

/// Production-size repro: counting four million definitions must not retain four million.
#[test]
fn repeated_symbol_jobs_bound_retained_metadata_and_keep_exact_counts() {
    let repo = Repo::new();
    for at in 0..40 {
        repo.write(&format!("src/hit{at:02}.rs"), "fn hit() {}\n".repeat(5_000));
    }
    let jobs: Vec<_> = (0..20).map(|_| Job {
        pattern: plan::compile("hit", false).unwrap(),
        kind: Kind::Definition { name: "hit".into(), qualifier: None, folded: false },
    }).collect();
    let mut replies = Vec::new();
    for _ in 0..2 {
        let limit = Limit::lasting(std::time::Duration::from_secs(20), Arc::default());
        let snapshot = Snapshot::open(&repo.0, Policy::NeverIndex, false, &limit);
        let outcome = grep::run_jobs(&repo.0, &snapshot, &jobs, &Scope { allows: &|_| true, named_large: vec![] }, &limit);
        assert!(!limit.was_cut());
        let retained: usize = outcome.jobs.iter().map(|job| job.files.iter().map(|file| file.definitions.len()).sum::<usize>()).sum();
        assert!(retained <= 20 * 256, "retained {retained} definitions");
        let mut items = Vec::new();
        for job in outcome.jobs {
            assert_eq!(job.total_definitions, 200_000);
            assert_eq!(job.definition_files, 40);
            assert!(job.files.iter().all(|file| file.definition_count == 5_000));
            assert!(job.files.len() <= 512);
            assert!(job.files.iter().all(|file| file.definitions.len() <= 64));
            assert!(job.files.iter().map(|file| file.definitions.len()).sum::<usize>() <= 256);
            items.push(symbols_item("hit", job));
        }
        let mut reply = Map::new();
        shape::assemble(items, BUDGET - REPLY_FIELDS, &mut reply);
        for item in reply["symbols"].as_array().unwrap() {
            assert_eq!(item["definitions"], 200_000);
            assert!(item["omitted_lines"].as_u64().unwrap() > 199_000);
        }
        replies.push(reply);
    }
    assert_eq!(replies[0], replies[1]);
}

#[test]
fn search_metadata_caps_keep_late_definitions_and_exact_outside_totals() {
    let repo = Repo::new();
    for at in 0..600 {
        repo.write(&format!("inside/a{at:03}.rs"), "hit();\nhit();\n");
        repo.write(&format!("outside/a{at:03}.rs"), "hit();\nhit();\nhit();\n");
    }
    repo.write("inside/z.rs", "fn hit() {}\n");
    let jobs = [Job { pattern: plan::compile("hit", false).unwrap(), kind: Kind::Search { context: 0 } }];
    let mut replies = Vec::new();
    for _ in 0..2 {
        let limit = limit();
        let snapshot = Snapshot::open(&repo.0, Policy::NeverIndex, false, &limit);
        let mut outcome = grep::run_jobs(&repo.0, &snapshot, &jobs, &Scope { allows: &|path| path.starts_with("inside/"), named_large: vec![] }, &limit);
        let result = outcome.jobs.pop().unwrap();
        assert!(result.files.len() <= 512, "retained {} files", result.files.len());
        assert!(result.outside.len() <= 64);
        assert_eq!(result.total_files, 601);
        assert_eq!(result.outside_files, 600);
        assert_eq!(result.outside_matches, 1_800);
        assert_eq!(&*result.files[0].path, "inside/z.rs");
        assert_eq!(&*result.outside[0].path, "outside/a000.rs");
        let item = search_item("hit", result, 0);
        assert_eq!(item.head["files"], 601);
        assert_eq!(item.head["matches"], 1_201);
        assert_eq!(item.head["outside_glob"], json!({"files":600,"matches":1_800}));
        assert_eq!(item.total_files, 601);
        let mut reply = Map::new();
        shape::assemble(vec![item], BUDGET, &mut reply);
        let shown = &reply["search"][0];
        let more = shown["more_files"].as_str().unwrap();
        let (named, remaining) = if let Some((names, tail)) = more.rsplit_once(", and ") {
            (names.matches("inside/").count(), tail.strip_suffix(" more").unwrap().parse::<usize>().unwrap())
        } else {
            (0, more.strip_suffix(" files").unwrap().parse::<usize>().unwrap())
        };
        assert_eq!(named + remaining, shown["omitted_files"].as_u64().unwrap() as usize, "{shown}");
        replies.push(reply);
    }
    assert_eq!(replies[0], replies[1]);
    let outside_only = repo.explore(json!({"search":"hit", "glob":"missing/**"}));
    assert_eq!(outside_only["search"][0]["outside_glob"]["files"], 1_201);
    assert_eq!(outside_only["search"][0]["outside_glob"]["matches"], 3_001);
    assert!(outside_only["search"][0]["outside_glob"]["hits"][0].as_str().unwrap().starts_with("inside/a000.rs:"));
}

#[test]
fn tests_for_metadata_caps_preserve_combined_ranking_and_exact_union_counts() {
    let repo = Repo::new();
    repo.write("src/billing.ts", "export const billing = 1;\n");
    for at in 0..600 {
        repo.write(&format!("tests/a{at:03}.ts"), "import billing from '../src/billing';\nbilling();\n");
        // Named-only tests overlap the named-and-mentioned set only in the winner below.
        repo.write(&format!("tests/n{at:03}.billing.test.ts"), "// unrelated\n");
    }
    repo.write("tests/z.billing.test.ts", "import billing from '../src/billing';\nbilling();\n");
    // Lots of non-test mentions must never evict a test candidate.
    for at in 0..600 {
        repo.write(&format!("src/a{at:03}.ts"), "billing();\n");
    }
    let limit = limit();
    let snapshot = Snapshot::open(&repo.0, Policy::NeverIndex, false, &limit);
    let jobs = [Job {
        pattern: plan::compile(&crate::workspace::whole_word_pattern("billing"), false).unwrap(),
        kind: Kind::Mention { stem: "billing".into(), target: repo.0.join("src/billing.ts") },
    }];
    let outcome = grep::run_jobs(&repo.0, &snapshot, &jobs, &Scope { allows: &|_| true, named_large: vec![] }, &limit);
    assert!(outcome.jobs[0].files.len() <= 512);
    assert_eq!(outcome.jobs[0].test_files, 601);
    assert_eq!(outcome.jobs[0].named_test_files, 1);
    assert_eq!(outcome.jobs[0].importing_test_files, 600);
    assert!(outcome.jobs[0].files.iter().all(|file| tests_for::is_test_path(&file.path)));
    let args = json!({"tests_for":"src/billing.ts"});
    let first = repo.explore(args.clone());
    let item = &first["tests_for"][0];
    assert_eq!(item["found"], 1_201, "{first}");
    assert_eq!(item["omitted_tests"], 1_181, "{first}");
    assert!(item["text"].as_str().unwrap().starts_with("tests/z.billing.test.ts (name, imports it, 2 mentions)"), "{first}");
    assert_eq!(first, repo.explore(args));
}

#[test]
fn symbol_metadata_caps_preserve_late_definitions_and_exact_empty_notes() {
    let repo = Repo::new();
    for at in 0..600 {
        repo.write(&format!("a{at:03}.txt"), "hit\n");
        repo.write(&format!("b{at:03}.rs"), "// hit\n");
    }
    let empty = repo.explore(json!({"symbols":"hit"}));
    assert!(empty["symbols"][0]["note"].as_str().unwrap().starts_with("Mentioned in 600 files of types with no definition lookup"), "{empty}");
    // A defining file must survive even if every earlier file merely mentions the name.
    repo.write("z.rs", "fn hit() {}\n");
    let defined = repo.explore(json!({"symbols":"hit"}));
    assert_eq!(defined["symbols"][0]["definitions"], 1, "{defined}");
    assert!(defined["symbols"][0]["text"].as_str().unwrap().starts_with("z.rs\n"), "{defined}");
    // With only supported files, the mentioned count still includes files beyond the cap.
    let supported = Repo::new();
    for at in 0..600 {
        supported.write(&format!("a{at:03}.rs"), "// hit\n");
    }
    let empty = supported.explore(json!({"symbols":"hit"}));
    assert!(empty["symbols"][0]["note"].as_str().unwrap().starts_with("Mentioned in 600 files, but no definition"), "{empty}");
}

#[test]
fn symbol_reads_include_object_defaults_and_inline_parameter_types() {
    let repo = Repo::new();
    for (path, text, end) in [
        ("default.js", "export const loadUser = (options = {}) =>\n  validate(options);\n", 2),
        ("typed.ts", "export function loadUser(input: {id: string}):\nUser {\n  return validate(input);\n}\n", 4),
    ] {
        repo.write(path, text);
        let reply = repo.explore(json!({"read":format!("{path}#loadUser")}));
        let read = &reply["read"][0];
        assert_eq!(read["from"], 1, "{reply}");
        assert_eq!(read["to"], end, "{reply}");
        assert!(read["text"].as_str().unwrap().contains("validate"), "{reply}");
    }
}

#[test]
fn symbol_reads_report_parser_limits_and_stops_honestly() {
    let repo = Repo::new();
    for (limit, expected) in [
        (Limit::with_parse_bytes(1), "time or memory limit"),
        (Limit::lasting(std::time::Duration::ZERO, Arc::default()), "time or memory limit"),
        (Limit::new(Arc::new(AtomicBool::new(true))), "Task has stopped."),
    ] {
        let ctx = Ctx { root: &repo.0, given: &repo.0, strict: false, limit: &limit, policy: Policy::NeverIndex };
        let step = named::ReadStep::Symbol { path: "a.rs".into(), text: "fn run() {}\n".into(), name: "run".into() };
        let item = named::read_item(&ctx, "a.rs#run", step);
        assert!(item.head["error"].as_str().unwrap().contains(expected), "{:?}", item.head);
    }
    repo.write("blank.js", "\n".repeat(1_048_576));
    let reply = repo.explore(json!({"read":"blank.js#run"}));
    assert_eq!(reply["incomplete"], true, "{reply}");
    assert!(reply["read"][0]["error"].as_str().unwrap().contains("time or memory limit"), "{reply}");
}

#[test]
fn qualified_definition_searches_keep_exact_counts_and_retention_caps() {
    let repo = Repo::new();
    repo.write("runs.rs", format!("impl Runner {{\n{}}}\n", "fn run() {}\n".repeat(80_000)));
    let limit = limit();
    let snapshot = Snapshot::open(&repo.0, Policy::NeverIndex, false, &limit);
    let jobs: Vec<_> = ["Runner", "Missing"].into_iter().map(|qualifier| Job {
        pattern: plan::compile("run", false).unwrap(),
        kind: Kind::Definition { name: "run".into(), qualifier: Some(qualifier.into()), folded: false },
    }).collect();
    let result = grep::run_jobs(&repo.0, &snapshot, &jobs, &Scope { allows: &|_| true, named_large: vec![] }, &limit);
    assert!(!limit.was_cut());
    assert_eq!(result.jobs[0].total_definitions, 80_000);
    assert_eq!(result.jobs[0].files[0].definition_count, 80_000);
    assert_eq!(result.jobs[0].files[0].definitions.len(), 64);
    assert_eq!(result.jobs[1].total_definitions, 80_000);
    assert!(result.jobs[1].unqualified_fallback);
    assert_eq!(result.jobs[1].files[0].definitions.len(), 64);
}

#[test]
fn optional_null_arguments_are_absent_but_invalid_types_still_fail() {
    let repo = Repo::new();
    repo.write("a.rs", "fn needle() {}\n");
    let found = repo.explore(json!({"search":["needle"],"context":null,"glob":null,"case_sensitive":null,"outline":null,"read":null}));
    assert_eq!(found["search"][0]["matches"], 1);
    assert!(found.get("incomplete").is_none());
    assert!(run(&repo.0, &json!({"search":["needle"],"context":"bad"})).is_err());
}

#[test]
fn receiver_definitions_and_unqualified_fallback_are_actionable() {
    for (path, text, qualified) in [
        ("a.go", "func (s *Server) Run() {}\n", "Server.Run"),
        ("a.cpp", "void A::method() {}\n", "A::method"),
        ("a.kt", "fun Foo.bar() {}\n", "Foo.bar"),
        ("a.rb", "def Foo.bar\nend\n", "Foo.bar"),
    ] {
        let repo = Repo::new();
        repo.write(path, text);
        let found = repo.explore(json!({"symbols":[qualified],"read":[format!("{path}#{qualified}")]}));
        assert_eq!(found["symbols"][0]["definitions"], 1, "{found}");
        assert!(found["symbols"][0].get("note").is_none(), "{found}");
        assert!(found["read"][0]["text"].as_str().unwrap().contains(text.lines().next().unwrap()), "{found}");
    }
    let repo = Repo::new();
    repo.write("a.rs", "fn run() {}\n");
    let found = repo.explore(json!({"symbols":["Other.run"],"read":["a.rs#Other.run"]}));
    assert_eq!(found["symbols"][0]["definitions"], 1, "{found}");
    assert_eq!(found["symbols"][0]["note"], "No definition qualified by Other; showing unqualified run definitions.");
    let error = found["read"][0]["error"].as_str().unwrap();
    assert!(error.contains("No definition qualified by Other here; unqualified run"), "{error}");
    assert!(error.contains("1-1"), "{error}");
    // A qualified result anywhere suppresses fallback results from other files.
    repo.write("b.rs", "impl Other {\n fn run() {}\n}\n");
    let found = repo.explore(json!({"symbols":["Other.run"]}));
    assert_eq!(found["symbols"][0]["definitions"], 1, "{found}");
    assert_eq!(shown_paths(&found["symbols"][0]), ["b.rs"]);
    assert!(found["symbols"][0].get("note").is_none());
}

#[test]
fn cut_lookup_items_carry_partial_notes() {
    let repo = Repo::new();
    repo.write("a.rs", "fn needle() {}\n");
    let found = run_with(&repo.0, &json!({"search":["needle"],"symbols":["needle"]}), false,
        Limit::lasting(std::time::Duration::ZERO, Arc::default()), Policy::NeverIndex).unwrap();
    assert_eq!(found["incomplete"], true);
    for category in ["search", "symbols"] {
        assert!(found[category][0]["note"].as_str().is_some_and(|note| note.contains("Partial:")), "{found}");
    }
}

#[test]
fn partial_lookup_notes_only_mark_the_job_that_hit_a_parser_limit() {
    let repo = Repo::new();
    repo.write("small.txt", "needle\n");
    repo.write("dense.rs", format!("{}fn run() {{}}\n", "\n".repeat(500_000)));
    let found = repo.explore(json!({"search":["needle"],"symbols":["run"]}));
    assert_eq!(found["incomplete"], true, "{found}");
    assert!(found["symbols"][0]["note"].as_str().is_some_and(|note| note.contains("Partial:")), "{found}");
    assert_eq!(found["search"][0]["matches"], 1, "{found}");
    assert!(!found["search"][0]["note"].as_str().is_some_and(|note| note.contains("Partial:")), "{found}");
}

#[test]
fn dense_line_tables_produce_partial_searches_without_panicking() {
    let repo = Repo::new();
    repo.write("dense.txt", format!("{}needle\n", "\n".repeat(4 * 1024 * 1024)));
    let found = repo.explore(json!({"search":["needle"],"glob":["dense.txt"]}));
    assert_eq!(found["incomplete"], true, "{found}");
    assert!(found["search"][0]["note"].as_str().is_some_and(|note| note.contains("Partial:")), "{found}");
}

/// `symbols`, `outline` and `path#name` for each lookup: one definition, read from its line.
fn assert_lookups(repo: &Repo, path: &str, lookups: &[(&str, &str)]) -> Value {
    let symbols: Vec<_> = lookups.iter().map(|(name, _)| *name).collect();
    let reads: Vec<_> = lookups.iter().map(|(name, _)| format!("{path}#{name}")).collect();
    let reply = repo.explore(json!({"symbols":symbols,"outline":[path],"read":reads}));
    for (at, (name, line)) in lookups.iter().enumerate() {
        assert_eq!(reply["symbols"][at]["definitions"], 1, "{name}: {reply}");
        assert!(reply["symbols"][at].get("note").is_none(), "{name} narrows without a fallback: {reply}");
        assert!(reply["symbols"][at]["text"].as_str().unwrap().contains(line), "{name}: {reply}");
        assert!(reply["read"][at].get("error").is_none(), "{name}: {reply}");
        assert!(reply["read"][at]["text"].as_str().unwrap().contains(line), "{name}: {reply}");
    }
    reply
}

#[test]
fn nested_cpp_namespaces_answer_outline_symbols_and_reads() {
    let repo = Repo::new();
    repo.write("a.cpp", "namespace a::b {\nvoid run() {}\n}\nnamespace a::inline b::c {\nint go() { return 1; }\n}\n");
    let reply = assert_lookups(&repo, "a.cpp", &[("a::b", "namespace a::b {"), ("a::b::c", "namespace a::inline b::c {"), ("b::run", "void run() {}"), ("a::b::run", "void run() {}"), ("c::go", "int go() { return 1; }"), ("a::b::c::go", "int go() { return 1; }")]);
    let outline = reply["outline"][0]["text"].as_str().unwrap();
    for entry in ["class a::b 1-3", "function run 2-2", "class a::b::c 4-6", "function go 5-5"] {
        assert!(outline.contains(entry), "{entry}: {outline}");
    }
    assert_eq!(reply["read"][0]["from"], 1);
    assert_eq!(reply["read"][0]["to"], 3);
    assert_eq!(reply["read"][1]["from"], 4);
    assert_eq!(reply["read"][1]["to"], 6);
}

#[test]
fn cpp_one_line_and_template_definitions_answer_outline_symbols_and_reads() {
    let repo = Repo::new();
    repo.write("a.cpp", "class Vec {\n public:\n    int size() const { return n_; }\n    static int zero() { return 0; };\n    int size2() const;\n};\ninline int Vec::cap() const { return c_; }\nint Vec::len() const;\nFoo::Foo() : x_(0) { init(); }\nint add(int a, int b) { return a + b; }\nvoid sub(int a);\ntemplate <typename T>\nvoid Box<T>::put(T v) {\n    std::vector<int>::push_back(v);\n    Box<int>::helper();\n}\ntemplate <typename T>\nBox<T>::Box() {}\ntemplate <typename K, typename V>\ninline int Map<K, V>::size() const { return n_; }\n");
    let reply = assert_lookups(&repo, "a.cpp", &[
        ("Vec::size", "int size() const { return n_; }"),
        ("Vec::zero", "static int zero() { return 0; };"),
        ("Vec::cap", "inline int Vec::cap() const { return c_; }"),
        ("Foo::Foo", "Foo::Foo() : x_(0) { init(); }"),
        ("add", "int add(int a, int b) { return a + b; }"),
        ("Box::put", "void Box<T>::put(T v) {"),
        ("Box::Box", "Box<T>::Box() {}"),
        ("Map::size", "inline int Map<K, V>::size() const { return n_; }"),
    ]);
    let outline = reply["outline"][0]["text"].as_str().unwrap();
    for entry in ["  method size 3-3", "  method zero 4-4", "function cap 7-7", "function Foo 9-9", "function add 10-10", "function put 13-16", "function Box 18-18", "function size 20-20"] {
        assert!(outline.contains(entry), "{entry}: {outline}");
    }
    for absent in ["size2", "len", "sub", "push_back", "helper"] {
        assert!(!outline.contains(absent), "{absent}: {outline}");
    }
    let missing = repo.explore(json!({"symbols":["size2","len","sub","push_back","helper"]}));
    for at in 0..5 {
        assert_eq!(missing["symbols"][at]["definitions"], 0, "{missing}");
    }
}

#[test]
fn java_and_script_one_line_methods_answer_outline_symbols_and_reads() {
    let repo = Repo::new();
    repo.write("A.java", "class Account {\n    public int getBalance() { return balance; }\n    private static String id() { return \"x\"; }\n    public void reset() { count = 0; }\n}\ninterface Shape {\n    int area();\n    abstract void clear();\n}\n");
    let reply = assert_lookups(&repo, "A.java", &[
        ("Account.getBalance", "public int getBalance() { return balance; }"),
        ("id", "private static String id() { return \"x\"; }"),
        ("reset", "public void reset() { count = 0; }"),
    ]);
    assert_eq!(reply["outline"][0]["text"], "class Account 1-5\n  method getBalance 2-2\n  method id 3-3\n  method reset 4-4\nclass Shape 6-9\n");
    repo.write("a.ts", "class Cart {\n  count(): number { return this.items.length; }\n  get total(): number { return this.sum; }\n  set value(v: number) { this.v = v; }\n  private clear() { this.n = 0; }\n  async ping(): Promise<void> { await noop(); }\n  run() {\n    if (ok) { return 1; }\n    for (const x of xs) { f(x); }\n  }\n}\ninterface Counter {\n  size(): number;\n}\n");
    let reply = assert_lookups(&repo, "a.ts", &[
        ("Cart.count", "count(): number { return this.items.length; }"),
        ("total", "get total(): number { return this.sum; }"),
        ("value", "set value(v: number) { this.v = v; }"),
        ("clear", "private clear() { this.n = 0; }"),
        ("Cart.ping", "async ping(): Promise<void> { await noop(); }"),
    ]);
    assert_eq!(reply["outline"][0]["text"], "class Cart 1-11\n  method count 2-2\n  method total 3-3\n  method value 4-4\n  method clear 5-5\n  method ping 6-6\n  method run 7-10\ninterface Counter 12-14\n");
    let missing = repo.explore(json!({"symbols":["area","size"]}));
    assert_eq!(missing["symbols"][0]["definitions"], 0, "{missing}");
    assert_eq!(missing["symbols"][1]["definitions"], 0, "{missing}");
}

#[test]
fn script_object_type_declarations_and_trailing_comments_answer_outline_and_symbols() {
    let repo = Repo::new();
    repo.write("a.ts", "interface View {\n  render(): Props & { id: string };\n  get(): A | { b: number };\n  make(): (x: number) => { id: string };\n  draw(): Props & { id: string }\n  size(): number; // { n }\n}\nclass Store {\n  get(): A | B { return this.a; }\n  count(): number { return this.items.length; } // size\n}\n");
    let reply = assert_lookups(&repo, "a.ts", &[("Store.get", "get(): A | B { return this.a; }"), ("count", "count(): number { return this.items.length; } // size")]);
    assert_eq!(reply["outline"][0]["text"], "interface View 1-7\nclass Store 8-11\n  method get 9-9\n  method count 10-10\n");
    let missing = repo.explore(json!({"symbols":["render","make","draw","size"]}));
    for at in 0..4 {
        assert_eq!(missing["symbols"][at]["definitions"], 0, "{missing}");
    }
}

#[test]
fn cpp_and_java_one_liners_with_trailing_comments_answer_outline_and_symbols() {
    let repo = Repo::new();
    repo.write("a.cpp", "class Vec {\n    int size() const { return n_; } /* fast */\n    int used() const; // { ok }\n};\ninline int Vec::cap() const { return c_; } // O(1)\n");
    let reply = assert_lookups(&repo, "a.cpp", &[("Vec::size", "int size() const { return n_; } /* fast */"), ("Vec::cap", "inline int Vec::cap() const { return c_; } // O(1)")]);
    assert_eq!(reply["outline"][0]["text"], "class Vec 1-4\n  method size 2-2\nfunction cap 5-5\n");
    repo.write("A.java", "class Account {\n    public int getBalance() { return balance; } // getter\n}\ninterface Shape {\n    int area(); // iface\n}\n");
    let reply = assert_lookups(&repo, "A.java", &[("Account.getBalance", "public int getBalance() { return balance; } // getter")]);
    assert_eq!(reply["outline"][0]["text"], "class Account 1-3\n  method getBalance 2-2\nclass Shape 4-6\n");
    let missing = repo.explore(json!({"symbols":["used","area"]}));
    assert_eq!(missing["symbols"][0]["definitions"], 0, "{missing}");
    assert_eq!(missing["symbols"][1]["definitions"], 0, "{missing}");
}

#[test]
fn ruby_nested_classes_and_modules_answer_outline_symbols_reads_and_hits() {
    let repo = Repo::new();
    repo.write("x.rb", "class Foo::Bar\n  def run\n    needle\n  end\nend\nmodule A::B::C\n  def self.go\n    needle\n  end\nend\n");
    let reply = assert_lookups(&repo, "x.rb", &[("Foo::Bar", "class Foo::Bar"), ("A::B::C", "module A::B::C"), ("Bar.run", "def run"), ("Foo::Bar.run", "def run"), ("Foo::Bar#run", "def run"), ("C.go", "def self.go"), ("A::B::C.go", "def self.go")]);
    assert_eq!(reply["outline"][0]["text"], "class Foo::Bar 1-5\n  method run 2-4\nmodule A::B::C 6-10\n  method go 7-9\n");
    assert_eq!((&reply["read"][0]["from"], &reply["read"][0]["to"]), (&json!(1), &json!(5)), "{reply}");
    assert_eq!((&reply["read"][1]["from"], &reply["read"][1]["to"]), (&json!(6), &json!(10)), "{reply}");
    let plain = repo.explore(json!({"symbols":["Bar","C"],"read":["x.rb#Bar"]}));
    assert_eq!(plain["symbols"][0]["definitions"], 1, "{plain}");
    assert_eq!(plain["symbols"][1]["definitions"], 1, "{plain}");
    assert_eq!(plain["read"][0]["from"], 1, "{plain}");
    // A hit right inside a container (no method around it) is labelled with its full path.
    repo.write("y.rb", "class Foo::Bar\n  NEEDLE = 1\nend\nmodule A::B::C\n  NEEDLE = 2\nend\n");
    let found = repo.explore(json!({"search":["NEEDLE"],"glob":["y.rb"]}));
    let text = found["search"][0]["text"].as_str().unwrap();
    assert!(text.contains("@ Foo::Bar 1-3\n"), "{text}");
    assert!(text.contains("@ A::B::C 4-6\n"), "{text}");
}

#[test]
fn an_outer_name_never_reaches_into_a_nested_container() {
    let repo = Repo::new();
    repo.write("x.rb", "class Foo\n  def run\n    :outer\n  end\nend\nclass Foo::Bar\n  def run\n    :inner\n  end\nend\n");
    let lookups = [("Foo.run", 2), ("Foo#run", 2), ("Foo::Bar.run", 7), ("Foo::Bar#run", 7), ("Bar#run", 7)];
    let reply = assert_lookups(&repo, "x.rb", &lookups.map(|(name, _)| (name, "def run")));
    for (at, (name, line)) in lookups.into_iter().enumerate() {
        assert!(reply["symbols"][at]["text"].as_str().unwrap().contains(&format!("{line}-{} method def run", line + 2)), "{name}: {reply}");
        assert_eq!((&reply["read"][at]["from"], &reply["read"][at]["to"]), (&json!(line), &json!(line + 2)), "x.rb#{name}: {reply}");
    }
    repo.write("a.cpp", "namespace a {\nvoid run() { outer(); }\n}\nnamespace a::b {\nvoid run() { inner(); }\n}\n");
    assert_lookups(&repo, "a.cpp", &[("a::run", "outer();"), ("a::b::run", "inner();"), ("b::run", "inner();")]);
}

#[test]
fn search_hits_inside_nested_cpp_namespaces_show_the_full_path() {
    let repo = Repo::new();
    repo.write("a.cpp", "namespace a::b {\nint needle = 1;\n}\nnamespace x {\nint needle = 2;\n}\n");
    let found = repo.explore(json!({"search":["needle"],"glob":["a.cpp"]}));
    let text = found["search"][0]["text"].as_str().unwrap();
    assert!(text.contains("@ a::b 1-3\n2:int needle = 1;\n"), "{text}");
    assert!(text.contains("@ x 4-6\n5:int needle = 2;\n"), "{text}");
    assert!(!text.contains("@ b "), "{text}");
}

#[test]
fn nested_containers_scope_like_their_compact_spellings() {
    let repo = Repo::new();
    repo.write("x.rb", "class Foo\n  def run\n    :outer\n  end\n  class Bar\n    def run\n      :inner\n    end\n  end\nend\n");
    let lookups = [("Foo.run", 2), ("Foo#run", 2), ("Bar.run", 6), ("Bar#run", 6), ("Foo::Bar#run", 6), ("Foo::Bar.run", 6)];
    let reply = assert_lookups(&repo, "x.rb", &lookups.map(|(name, _)| (name, "def run")));
    for (at, (name, line)) in lookups.into_iter().enumerate() {
        assert_eq!((&reply["read"][at]["from"], &reply["read"][at]["to"]), (&json!(line), &json!(line + 2)), "x.rb#{name}: {reply}");
    }
    assert_lookups(&repo, "x.rb", &[("Foo::Bar", "class Bar")]);
    repo.write("m.rb", "module A\n  def go\n    :outer\n  end\n  module B\n    def go\n      :inner\n    end\n  end\nend\n");
    let reply = assert_lookups(&repo, "m.rb", &[("A.go", "def go"), ("B.go", "def go"), ("A::B.go", "def go"), ("A::B", "module B")]);
    for (at, body) in [":outer", ":inner", ":inner"].into_iter().enumerate() {
        assert!(reply["read"][at]["text"].as_str().unwrap().contains(body), "{reply}");
    }
    repo.write("a.cpp", "namespace a {\nvoid run() { outer(); }\nnamespace b {\nvoid run() { inner(); }\n}\n}\n");
    assert_lookups(&repo, "a.cpp", &[("a::run", "outer();"), ("b::run", "inner();"), ("a::b::run", "inner();"), ("a::b", "namespace b {")]);
}

#[test]
fn php_namespaced_reads_split_at_the_file() {
    let repo = Repo::new();
    repo.write("src/Foo.php", "<?php\nnamespace App\\Models;\nclass User {\n    public function save() { return 1; }\n}\nclass Post {\n    public function save() { return 2; }\n}\n");
    let reply = repo.explore(json!({"read":["src/Foo.php#App\\Models\\User::save", "src/Foo.php#\\App\\User::save", "src/Foo.php#Post::save"]}));
    for (at, body) in ["return 1;", "return 1;", "return 2;"].into_iter().enumerate() {
        assert!(reply["read"][at].get("error").is_none(), "{reply}");
        assert!(reply["read"][at]["text"].as_str().unwrap().contains(body), "{reply}");
    }
}

#[test]
fn hash_named_files_and_folders_read_their_symbols() {
    let repo = Repo::new();
    let ruby = "class Foo\n  def bar\n    :bar\n  end\nend\ndef run\n  :run\nend\n";
    let mut files = vec!["a#1.rb", "dir#1/foo.rb", "app/foo.rb"];
    // A literal `\` is a file-name character off Windows, standing in for a Windows path.
    if cfg!(unix) {
        files.push("dir#1\\foo.rb");
    }
    for file in &files {
        repo.write(file, ruby);
    }
    let mut reads = vec!["a#1.rb#Foo#bar", "dir#1/foo.rb#run", "app/foo.rb#Foo#bar"];
    if cfg!(unix) {
        reads.push("dir#1\\foo.rb#Foo#bar");
    }
    let reply = repo.explore(json!({ "read": reads }));
    for (at, raw) in reads.iter().enumerate() {
        let item = &reply["read"][at];
        assert!(item.get("error").is_none(), "{raw}: {reply}");
        assert_eq!(item["path"], json!(files[at]), "{raw}: {reply}");
        let body = if raw.ends_with("#run") { ":run" } else { ":bar" };
        assert!(item["text"].as_str().unwrap().contains(body), "{raw}: {reply}");
    }
    let missing = repo.explore(json!({"read":["gone#1\\foo.rb#Foo#bar", "gone/Foo.php#App\\Models\\User::save"]}));
    for at in 0..2 {
        assert_eq!(missing["read"][at]["error"], json!("File not found."), "{missing}");
    }
}
