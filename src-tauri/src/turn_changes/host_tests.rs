use super::claude_policy::*;
use crate::claude_roots::*;
use super::*;

fn assert_reported_path_spelling(begin_path: &str, complete_path: &str) {
    let f = crate::turn_changes::tests::Fixture::new(false);
    f.write("src/ours.txt", "before batch\n");
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    let begun = tracker
        .report(json!({"action":"begin","paths":[begin_path]}))
        .unwrap();
    f.write("src/ours.txt", "before batch\nour edit\n");
    tracker
        .report(json!({"action":"complete","captureId":begun["captureId"],"paths":[complete_path]}))
        .unwrap();
    let captured = tracker.finish().unwrap();
    assert_eq!(captured.summary.files.len(), 1);
    assert_eq!(captured.summary.files[0].path, "src/ours.txt");
    assert_eq!((captured.summary.additions, captured.summary.deletions), (1, 0));
    assert!(!captured.summary.truncated);
    assert!(captured.details[0].patch.contains("+our edit"));
}

#[test]
fn reported_paths_normalize_repeated_separators_at_begin_and_complete() {
    for (begin, complete) in [
        ("src//ours.txt", "src/ours.txt"),
        ("src/ours.txt", "src//ours.txt"),
        ("src//ours.txt", "src//ours.txt"),
    ] {
        assert_reported_path_spelling(begin, complete);
    }
}

#[cfg(windows)]
#[test]
fn reported_windows_paths_normalize_backslashes_at_begin_and_complete() {
    for (begin, complete) in [
        (r"src\ours.txt", "src/ours.txt"),
        ("src/ours.txt", r"src\ours.txt"),
        (r"src\ours.txt", r"src\ours.txt"),
    ] {
        assert_reported_path_spelling(begin, complete);
    }
}

#[tokio::test]
async fn reported_shell_batch_is_scoped_frozen_and_cannot_be_reused_by_another_task() {
    let f = crate::turn_changes::tests::Fixture::new(false);
    f.write("ours.txt", "dirty before batch\n");
    let tracker = Arc::new(Mutex::new(Tracker::start(f.root.clone(), f.cache.clone())));
    let stopped = Arc::new(AtomicBool::new(false));
    let host = with_host(None, Some(tracker.clone()), stopped.clone());
    let begun = (host.handler)(TOOL.into(), json!({"action":"begin","paths":["ours.txt"]}))
        .await
        .unwrap();
    // A native edit within an acknowledged batch must not replace its
    // earlier baseline, even if the notification arrives after the write.
    f.write("ours.txt", "dirty before batch\nour script edit\n");
    let native = ToolActivity {
        id: "native".into(),
        name: "Write".into(),
        status: "running".into(),
        input: String::new(),
        output: String::new(),
        write_paths: Some(vec!["ours.txt".into()]),
    };
    tracker.lock().unwrap().observe_tool("native", &native);
    tracker.lock().unwrap().observe_tool(
        "native",
        &ToolActivity {
            status: "completed".into(),
            ..native
        },
    );
    f.write("external.txt", "someone else\n");
    let other = with_host(
        None,
        Some(Arc::new(Mutex::new(Tracker::start(
            f.root.clone(),
            f.cache.clone(),
        )))),
        stopped.clone(),
    );
    let completed =
        json!({"action":"complete","captureId":begun["captureId"],"paths":["ours.txt"]});
    assert!((other.handler)(TOOL.into(), completed.clone())
        .await
        .is_err());
    assert!((host.handler)(
        TOOL.into(),
        json!({"action":"complete","captureId":begun["captureId"],"paths":["external.txt"]})
    )
    .await
    .is_err());
    (host.handler)(TOOL.into(), completed.clone())
        .await
        .unwrap();
    assert!((host.handler)(TOOL.into(), completed).await.is_err());
    f.write("ours.txt", "later editor change\n");
    let captured = tracker.lock().unwrap().finish().unwrap();
    assert_eq!(captured.summary.files.len(), 1);
    assert_eq!(captured.summary.files[0].path, "ours.txt");
    assert_eq!(
        (captured.summary.additions, captured.summary.deletions),
        (1, 0)
    );
    assert!(captured.details[0].patch.contains("+our script edit"));
    assert!(!captured.details[0].patch.contains("later editor change"));
}

#[tokio::test]
async fn report_tool_rejects_traversal_and_stopped_tasks_and_preserves_base_tools() {
    let f = crate::turn_changes::tests::Fixture::new(false);
    let tracker = Arc::new(Mutex::new(Tracker::start(f.root.clone(), f.cache.clone())));
    let stopped = Arc::new(AtomicBool::new(false));
    let base = ToolHost {
        tools: vec![],
        approval_tools: ["other".into()].into(),
        handler: Arc::new(|name, args| {
            Box::pin(async move { Ok(json!({"name":name,"args":args})) })
        }),
    };
    let host = with_host(Some(base), Some(tracker), stopped.clone());
    assert!(host.approval_tools.contains("other"));
    assert_eq!(
        (host.handler)("other".into(), json!({"hello":true}))
            .await
            .unwrap()["args"]["hello"],
        true
    );
    for path in ["../outside", "src/../outside", ".git/config", ".GIT/config", "src//.git/config", "/tmp/absolute"] {
        assert!(
            (host.handler)(TOOL.into(), json!({"action":"begin","paths":[path]}))
                .await
                .is_err()
        );
    }
    stopped.store(true, Ordering::SeqCst);
    assert!(
        (host.handler)(TOOL.into(), json!({"action":"begin","paths":["file.txt"]}))
            .await
            .is_err()
    );
}

// Read-restriction tests use injected launch inputs, never the machine's own settings.
fn read_launch(args: &[&str], env: &[(&str, &str)]) -> crate::connections::Launch {
    crate::connections::Launch {
        executable: None,
        args: args.iter().map(|arg| (*arg).into()).collect(),
        env: env.iter().map(|(key, value)| ((*key).into(), (*value).into())).collect(),
        secrets: vec![],
    }
}

fn restricts_reads(settings: &Settings, provider: &str, connection: Option<crate::connections::Launch>) -> bool {
    let provider_env = vec![("CLAUDE_CONFIG_DIR".to_owned(), settings.base.join("config").display().to_string())];
    restricts_reads_over(settings, provider, provider_env, connection)
}

// The real merge: the saved provider environment first, then the connection's. PandaCode's
// own CLAUDE_CONFIG_DIR (set in every agent session) is injected as absent.
fn restricts_reads_over(settings: &Settings, provider: &str, provider_env: Vec<(String, String)>,
    connection: Option<crate::connections::Launch>) -> bool {
    let cwd = settings.base.join("project");
    claude_restricts_reads_with(provider, &cwd, || Ok(connection), || false,
        |env| launch_config_dir_with(provider_env, env, None, &cwd))
}

#[test]
fn claude_read_and_explore_denials_and_ask_rules_withhold_explore() {
    for kind in ["deny", "ask"] {
        for rule in ["Read(restricted/customer.csv)", "Grep(restricted/**)", "Glob(src/**)",
            "Read", "*", "mcp__pandacode_architect__pandacode_explore",
            "mcp__pandacode_architect__pandacode_explore(src/**)", "mcp__pandacode_architect__*", "  Read (file)  ",
            "Read*", "R*", "*Read*", "Gr*", "Gl*", "mcp__*", "mcp__pandacode_architect",
            "mcp__pandacode_architect*", "mcp__pandacode_architect__pandacode_*"] {
            for file in SETTINGS_FILES {
                for user in [true, false] {
                    let settings = Settings::new();
                    let text = json!({"permissions":{kind:[rule]}}).to_string();
                    if user { settings.user(file, text); } else { settings.project(file, text); }
                    assert!(restricts_reads(&settings, "claude", None), "{kind} {rule} {file} user={user}");
                }
            }
        }
    }
}

#[test]
fn unrelated_permissions_and_absent_settings_leave_explore_available() {
    let settings = Settings::new();
    assert!(!restricts_reads(&settings, "claude", None));
    for value in [json!({}), json!({"permissions":{}}), json!({"permissions":{"deny":[],"ask":[]}}),
        json!({"permissions":{"deny":["Bash(rm *)","Write(.env)","Edit(src/**)","WebFetch"],
            "ask":["Bash","mcp__other__*"],"allow":["Read"],"defaultMode":"bypassPermissions"}})] {
        settings.user("settings.json", value.to_string());
        assert!(!restricts_reads(&settings, "claude", None), "{value}");
    }
}

#[test]
fn tool_name_globs_are_anchored_and_handle_empty_and_repeated_stars() {
    for (pattern, text, expected) in [
        ("", "", true), ("", "Read", false), ("*", "", true), ("**", "Read", true),
        ("Read", "Read", true), ("Read", "ReadMore", false), ("Read*", "ReadMore", true),
        ("*Read*", "BeforeReadAfter", true), ("R**d", "Read", true), ("*e*ad", "Read", true),
        ("*ead", "ReadMore", false), ("Re*ad", "ReXadYad", true), ("*Read", "ReadRead", true),
        ("*ReadX", "ReadRead", false), ("Read?", "Read", false), ("read*", "Read", false),
    ] {
        assert_eq!(wildcard_matches(pattern, text), expected, "{pattern:?} {text:?}");
    }
}

#[test]
fn unrelated_tool_name_wildcards_leave_explore_available() {
    for kind in ["deny", "ask"] {
        for rule in ["Bash*", "Edit*", "Write*", "WebFetch", "mcp__other", "mcp__other__*", "NotebookEdit"] {
            assert!(!settings_restrict_reads(&json!({"permissions":{kind:[rule]}})), "{kind} {rule}");
        }
    }
}

fn linked_checkout(settings: &Settings, bare: bool, relative: bool) -> (PathBuf, PathBuf, PathBuf) {
    let main = settings.base.join("main");
    let common = if bare { settings.base.join("repo.git") } else { main.join(".git") };
    let gitdir = common.join("worktrees/wt");
    let worktree = settings.base.join("wt");
    std::fs::create_dir_all(&gitdir).unwrap();
    std::fs::write(common.join("config"), format!("[core]\n bare = {bare}\n")).unwrap();
    std::fs::create_dir_all(main.join(".claude")).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
    let pointer = if relative {
        if bare { "../repo.git/worktrees/wt".into() } else { "../main/.git/worktrees/wt".into() }
    } else { gitdir.to_str().unwrap().to_owned() };
    std::fs::write(worktree.join(".git"), format!("gitdir: {pointer}\n")).unwrap();
    (main, worktree, gitdir)
}

#[test]
fn linked_worktrees_inherit_main_checkout_local_read_rules() {
    for relative in [false, true] {
        let settings = Settings::new();
        let (main, worktree, _) = linked_checkout(&settings, false, relative);
        let config = settings.base.join("config");
        assert!(!read_deny_rules(&config, &main));
        assert!(!read_deny_rules(&config, &worktree));
        std::fs::write(main.join(".claude/settings.local.json"),
            r#"{"permissions":{"deny":["Read(restricted/customer.csv)"]}}"#).unwrap();
        assert!(read_deny_rules(&config, &main));
        assert!(read_deny_rules(&config, &worktree), "relative={relative}");
        let nested = worktree.join("src/nested");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(read_deny_rules(&config, &nested), "nested relative={relative}");
        assert!(read_deny_rules(&config, &worktree), "home-rooted main checkout is still a project");
        assert!(read_deny_rules(&main.join(".claude"), &worktree), "active config");
    }
}

#[test]
fn linked_worktrees_inherit_only_local_settings_and_bare_repos_have_no_main_checkout() {
    for bare in [false, true] {
        let settings = Settings::new();
        let (main, worktree, _) = linked_checkout(&settings, bare, false);
        // A shared settings.json is not inherited from an unrelated main checkout.
        std::fs::write(main.join(".claude/settings.json"), r#"{"permissions":{"deny":["Read"]}}"#).unwrap();
        if bare {
            // Do not treat the bare repo's parent as a checkout.
            std::fs::create_dir_all(settings.base.join(".claude")).unwrap();
            std::fs::write(settings.base.join(".claude/settings.local.json"), r#"{"permissions":{"deny":["Read"]}}"#).unwrap();
        }
        assert!(!read_deny_rules(&settings.base.join("config"), &worktree), "bare={bare}");
    }
}

fn nonstandard_linked_checkout(settings: &Settings) -> (PathBuf, PathBuf, PathBuf) {
    let main = settings.base.join("super/sub");
    let common = settings.base.join("super/.git/modules/sub");
    let gitdir = common.join("worktrees/wt");
    let worktree = settings.base.join("wt");
    std::fs::create_dir_all(main.join(".claude")).unwrap();
    std::fs::create_dir_all(&gitdir).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
    std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
    (main, worktree, common)
}

fn linked_reads_restricted(settings: &Settings, worktree: &Path) -> bool {
    claude_restricts_reads_with("claude", worktree, || Ok(None), || false,
        |_| Some(settings.base.join("config")))
}

#[test]
fn nonstandard_common_gitdirs_resolve_main_checkout_read_rules() {
    for value in ["../../../sub", "\"../../../sub\""] {
        let settings = Settings::new();
        let (main, worktree, common) = nonstandard_linked_checkout(&settings);
        std::fs::write(common.join("config"), format!(
            "# comment\n[CoRe] ; comment\n BaRe = false\n WoRkTrEe = {value} # main checkout\n[remote \"origin\"]\n worktree = ignored\n[core \"other\"]\n worktree = ignored\n bare = true\n"
        )).unwrap();
        assert_eq!(linked_worktree_main_root(&worktree).unwrap(), Some(main.canonicalize().unwrap()));
        assert!(!linked_reads_restricted(&settings, &worktree), "clean main {value}");
        for kind in ["deny", "ask"] {
            std::fs::write(main.join(".claude/settings.local.json"),
                json!({"permissions":{kind:["Read"]}}).to_string()).unwrap();
            assert!(linked_reads_restricted(&settings, &worktree), "{kind} {value}");
        }
    }
}

#[test]
fn nonstandard_common_gitdirs_need_worktree_or_explicit_bare() {
    let settings = Settings::new();
    let (main, worktree, common) = nonstandard_linked_checkout(&settings);
    for config in ["", "[core]\n bare = false\n", "[core \"subsection\"]\n bare = true\n",
        "[remote \"core\"]\n bare = true\n", "[core]\n bare = true\n[core]\n bare = false\n"] {
        std::fs::write(common.join("config"), config).unwrap();
        assert!(linked_reads_restricted(&settings, &worktree), "{config:?}");
    }
    std::fs::write(main.join(".claude/settings.local.json"), r#"{"permissions":{"deny":["Read"]}}"#).unwrap();
    std::fs::write(common.join("config"), "[core]\n bare = true ; no checkout\n").unwrap();
    assert!(!linked_reads_restricted(&settings, &worktree));
    // An explicit checkout takes precedence over bare, even for a nonstandard gitdir.
    std::fs::write(common.join("config"), "[core]\n bare = true\n worktree = ../../../sub\n").unwrap();
    assert!(linked_reads_restricted(&settings, &worktree));
}

#[test]
fn linked_worktree_config_errors_fail_closed_for_all_common_dir_names() {
    for standard in [false, true] {
        let settings = Settings::new();
        let (worktree, common) = if standard {
            let (main, worktree, _) = linked_checkout(&settings, false, false);
            (worktree, main.join(".git"))
        } else {
            let (_, worktree, common) = nonstandard_linked_checkout(&settings);
            (worktree, common)
        };
        let config = common.join("config");
        for bytes in [b"[core\n bare = true".to_vec(), b"[core] garbage\n bare = true".to_vec(),
            b"[core]\n bare = perhaps".to_vec(), b"[core]\n worktree = \"unfinished".to_vec(),
            b"[core]\n bare = true\n worktree = \"\"".to_vec(), vec![0xff], vec![b' '; 1024 * 1024 + 1]] {
            std::fs::write(&config, &bytes).unwrap();
            assert!(linked_reads_restricted(&settings, &worktree), "standard={standard} len={}", bytes.len());
        }
        std::fs::remove_file(&config).unwrap();
        assert!(linked_reads_restricted(&settings, &worktree), "missing config");
        std::fs::create_dir(&config).unwrap();
        assert!(linked_reads_restricted(&settings, &worktree), "config is directory");
    }
}

#[test]
fn git_config_values_preserve_quoted_comments_and_native_windows_paths() {
    for (value, expected) in [
        (r#""../../../sub # ; space " ; comment"#, "../../../sub # ; space "),
        (r#""C:\\repo\\main" # comment"#, r"C:\repo\main"),
        (r#""\\\\server\\share\\main""#, r"\\server\share\main"),
        (r"C:/repo/main", "C:/repo/main"),
    ] {
        let (_, worktree) = git_core_checkout(&format!("[core]\nworktree = {value}\n")).unwrap();
        assert_eq!(worktree.as_deref(), Some(expected));
        if cfg!(windows) && (expected.starts_with("C:") || expected.starts_with(r"\\")) {
            assert!(Path::new(expected).is_absolute(), "{expected}");
        }
    }
    for config in ["[core]\n bare\n", "[core]\n bare = YES # comment\n"] {
        assert_eq!(git_core_checkout(config).unwrap(), (true, None));
    }
    assert_eq!(git_core_checkout("[core]\n worktree = \\\n next").unwrap(), (false, Some("next".into())));
    for config in ["[core]\n worktree = missing\\",
        "[core \"]", "[core \"bad\\\"]", "[core \"bad\\q\"]",
        "[core]\n bare = true\n[core \"bad\" \"section\"]", "[core]\n worktree = a\0b"] {
        assert!(git_core_checkout(config).is_err(), "{config:?}");
    }
}

#[test]
fn dot_git_common_directory_bare_flag_requires_no_explicit_worktree() {
    let settings = Settings::new();
    let (main, worktree, _) = linked_checkout(&settings, false, false);
    std::fs::write(main.join(".claude/settings.local.json"), r#"{"permissions":{"deny":["Read"]}}"#).unwrap();
    std::fs::write(main.join(".git/config"), "[core]\n bare = true\n").unwrap();
    assert!(!linked_reads_restricted(&settings, &worktree));
    std::fs::write(main.join(".git/config"), "[core]\n bare = true\n worktree = ..\n").unwrap();
    assert!(linked_reads_restricted(&settings, &worktree));
}

fn dot_git_separate_checkout(settings: &Settings, bare: bool, relative: bool) -> (PathBuf, PathBuf, PathBuf) {
    let main = settings.base.join("actual");
    let common = settings.base.join("metadata/.git");
    let gitdir = common.join("worktrees/linked");
    let worktree = settings.base.join("linked");
    std::fs::create_dir_all(&main).unwrap();
    std::fs::create_dir_all(&gitdir).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();
    let value = if relative { "../../actual".to_owned() } else {
        main.to_str().unwrap().replace('\\', "\\\\")
    };
    std::fs::write(common.join("config"), format!("[core]\n bare = {bare}\n worktree = \"{value}\"\n")).unwrap();
    std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
    std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
    assert!(!common.parent().unwrap().join(".claude").exists());
    (main, worktree, common)
}

#[test]
fn dot_git_separate_gitdir_inherits_explicit_main_checkout_read_deny() {
    for bare in [false, true] {
        for relative in [false, true] {
            let settings = Settings::new();
            let (main, worktree, _) = dot_git_separate_checkout(&settings, bare, relative);
            std::fs::create_dir(main.join(".claude")).unwrap();
            std::fs::write(main.join(".claude/settings.local.json"), r#"{"permissions":{"deny":["Read"]}}"#).unwrap();
            assert!(linked_reads_restricted(&settings, &worktree), "bare={bare} relative={relative}");
        }
    }
}

#[test]
fn dot_git_separate_gitdir_clean_explicit_main_checkout_allows_explore() {
    for relative in [false, true] {
        let settings = Settings::new();
        let (main, worktree, _) = dot_git_separate_checkout(&settings, false, relative);
        assert_eq!(linked_worktree_main_root(&worktree).unwrap(), Some(main.canonicalize().unwrap()));
        assert!(!linked_reads_restricted(&settings, &worktree), "relative={relative}");
    }
}

#[test]
fn linked_worktree_git_config_includes_fail_closed() {
    for header in ["include", "InClUdE", "includeIf \"gitdir:../actual/\"", "InClUdEiF \"gitdir:../actual/\""] {
        for bare in [false, true] {
            let settings = Settings::new();
            let (main, worktree, _) = linked_checkout(&settings, bare, false);
            let common = if bare { settings.base.join("repo.git") } else { main.join(".git") };
            let config = format!("[core]\n bare = {bare}\n[{header}]\n path = checkout.config\n");
            std::fs::write(common.join("config"), &config).unwrap();
            // Plain `[include]` skips missing files per git-config(1), so write an invalid target
            // there to prove invalid local includes still fail closed; `[includeIf]` fails closed
            // without reading any target.
            if header.eq_ignore_ascii_case("include") {
                std::fs::write(common.join("checkout.config"), "[core]\n bare = perhaps\n").unwrap();
            }
            assert_eq!(git_core_checkout(&config), Err("unsupported git config include"));
            assert!(linked_reads_restricted(&settings, &worktree), "{header} bare={bare}");
        }
    }
}

#[test]
fn nonstandard_common_gitdirs_reject_dangling_or_file_worktrees() {
    let settings = Settings::new();
    let (_, worktree, common) = nonstandard_linked_checkout(&settings);
    for value in ["../../../absent", "config"] {
        std::fs::write(common.join("config"), format!("[core]\n worktree = {value}\n")).unwrap();
        assert!(linked_reads_restricted(&settings, &worktree), "{value}");
    }
}

#[test]
fn nonstandard_common_gitdirs_accept_absolute_native_paths() {
    let settings = Settings::new();
    let (main, worktree, common) = nonstandard_linked_checkout(&settings);
    let value = main.to_str().unwrap().replace('\\', "\\\\");
    std::fs::write(common.join("config"), format!("[core]\n worktree = \"{value}\"\n")).unwrap();
    assert_eq!(linked_worktree_main_root(&worktree).unwrap(), Some(main.canonicalize().unwrap()));
    assert!(!linked_reads_restricted(&settings, &worktree));
}

#[cfg(unix)]
#[test]
fn unreadable_common_gitdir_config_or_main_checkout_fails_closed() {
    use std::os::unix::fs::PermissionsExt;
    let settings = Settings::new();
    let (main, worktree, common) = nonstandard_linked_checkout(&settings);
    let config = common.join("config");
    std::fs::write(&config, "[core]\n worktree = ../../../sub\n").unwrap();
    for path in [&config, &main] {
        let permissions = std::fs::metadata(path).unwrap().permissions();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let restricted = linked_reads_restricted(&settings, &worktree);
        std::fs::set_permissions(path, permissions).unwrap();
        assert!(restricted, "unreadable {}", path.display());
    }
}

#[test]
fn malformed_linked_worktree_metadata_fails_closed() {
    for name in ["gitfile", "commondir"] {
        for bytes in [b"".to_vec(), b"invalid".to_vec(), b"gitdir: ".to_vec(), vec![0xff], vec![b'x'; 16 * 1024 + 1]] {
            let settings = Settings::new();
            let (_, worktree, gitdir) = linked_checkout(&settings, false, false);
            let path = if name == "gitfile" { worktree.join(".git") } else { gitdir.join("commondir") };
            std::fs::write(path, &bytes).unwrap();
            assert!(read_deny_rules(&settings.base.join("config"), &worktree), "{name} length={}", bytes.len());
        }
    }
    let settings = Settings::new();
    let (_, worktree, gitdir) = linked_checkout(&settings, false, false);
    std::fs::remove_file(gitdir.join("commondir")).unwrap();
    assert!(!read_deny_rules(&settings.base.join("config"), &worktree), "ordinary gitfile/submodule");
    std::fs::create_dir(gitdir.join("commondir")).unwrap();
    assert!(read_deny_rules(&settings.base.join("config"), &worktree), "commondir is not a file");
}

#[cfg(unix)]
#[test]
fn unreadable_and_dangling_worktree_metadata_fails_closed() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    for name in ["gitfile", "commondir"] {
        let settings = Settings::new();
        let (_, worktree, gitdir) = linked_checkout(&settings, false, false);
        let path = if name == "gitfile" { worktree.join(".git") } else { gitdir.join("commondir") };
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let restricted = read_deny_rules(&settings.base.join("config"), &worktree);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(restricted, "unreadable {name}");
        std::fs::remove_file(&path).unwrap();
        symlink(settings.base.join("absent"), &path).unwrap();
        assert!(read_deny_rules(&settings.base.join("config"), &worktree), "dangling {name}");
    }
    let settings = Settings::new();
    let (main, worktree, _) = linked_checkout(&settings, false, false);
    std::fs::write(main.join(".claude/settings.local.json"), r#"{"permissions":{"deny":["Read"]}}"#).unwrap();
    let pointer = worktree.join("pointer");
    std::fs::rename(worktree.join(".git"), &pointer).unwrap();
    symlink(&pointer, worktree.join(".git")).unwrap();
    assert!(read_deny_rules(&settings.base.join("config"), &worktree), "symlink to gitfile");
}

#[test]
fn malformed_read_permissions_fail_closed() {
    let settings = Settings::new();
    for value in [json!(null), json!([]), json!({"permissions":null}), json!({"permissions":[]}),
        json!({"permissions":{"deny":"Read"}}), json!({"permissions":{"ask":{}}}),
        json!({"permissions":{"deny":[false]}}), json!({"permissions":{"ask":[null]}})] {
        settings.user("settings.json", value.to_string());
        assert!(restricts_reads(&settings, "claude", None), "{value}");
    }
    settings.user("settings.json", "not JSON");
    assert!(restricts_reads(&settings, "claude", None));
    settings.user("settings.json", vec![b' '; SETTINGS_LIMIT as usize + 1]);
    assert!(restricts_reads(&settings, "claude", None));
    std::fs::remove_file(settings.base.join("config/settings.json")).unwrap();
    std::fs::create_dir(settings.base.join("config/settings.json")).unwrap();
    assert!(restricts_reads(&settings, "claude", None), "not a regular file");
}

#[cfg(unix)]
#[test]
fn unreadable_read_settings_and_managed_drop_ins_fail_closed() {
    use std::os::unix::fs::PermissionsExt;
    let settings = Settings::new();
    let file = settings.base.join("config/settings.json");
    settings.user("settings.json", "{}");
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
    let restricted = restricts_reads(&settings, "claude", None);
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(restricted);
    let drop_ins = settings.base.join("managed-settings.d");
    std::fs::create_dir(&drop_ins).unwrap();
    std::fs::set_permissions(&drop_ins, std::fs::Permissions::from_mode(0o000)).unwrap();
    let restricted = managed_settings_restrict_reads(Some(&settings.base.join("managed-settings.json")));
    std::fs::set_permissions(&drop_ins, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(restricted);
}

#[test]
fn managed_read_rules_and_json_drop_ins_are_checked() {
    let settings = Settings::new();
    let managed = settings.base.join("managed-settings.json");
    assert!(managed_settings_restrict_reads(None), "unknown path");
    assert!(!managed_settings_restrict_reads(Some(&managed)), "absent policy");
    std::fs::write(&managed, r#"{"permissions":{"deny":["Write"]}}"#).unwrap();
    assert!(!managed_settings_restrict_reads(Some(&managed)), "unrelated policy");
    std::fs::write(&managed, r#"{"permissions":{"deny":["Read(secret)"]}}"#).unwrap();
    assert!(managed_settings_restrict_reads(Some(&managed)));
    std::fs::write(&managed, "{}").unwrap();
    let drop_ins = managed.with_extension("d");
    std::fs::create_dir(&drop_ins).unwrap();
    std::fs::write(drop_ins.join("ignored.txt"), "not json").unwrap();
    assert!(!managed_settings_restrict_reads(Some(&managed)));
    std::fs::write(drop_ins.join("reads.json"), r#"{"permissions":{"ask":["Read(file)"]}}"#).unwrap();
    assert!(managed_settings_restrict_reads(Some(&managed)));
    std::fs::write(drop_ins.join("reads.json"), "invalid JSON").unwrap();
    assert!(managed_settings_restrict_reads(Some(&managed)));
    std::fs::remove_file(drop_ins.join("reads.json")).unwrap();
    std::fs::create_dir(drop_ins.join("directory.json")).unwrap();
    assert!(managed_settings_restrict_reads(Some(&managed)), "JSON entry must be a file");
    std::fs::remove_dir_all(&drop_ins).unwrap();
    std::fs::write(&drop_ins, "not a directory").unwrap();
    assert!(managed_settings_restrict_reads(Some(&managed)));
}

#[cfg(unix)]
#[test]
fn dangling_claude_settings_and_managed_directory_links_fail_closed() {
    use std::os::unix::fs::symlink;
    let settings = Settings::new();
    symlink(settings.base.join("absent"), settings.base.join("config/settings.json")).unwrap();
    assert!(restricts_reads(&settings, "claude", None));
    symlink(settings.base.join("absent"), settings.base.join("managed-settings.d")).unwrap();
    assert!(managed_settings_restrict_reads(Some(&settings.base.join("managed-settings.json"))));
}

#[test]
fn windows_managed_read_paths_and_registry_errors_fail_closed() {
    let settings = Settings::new();
    let program_data = settings.base.as_os_str().to_owned();
    let mut paths = Vec::new();
    let mut keys = Vec::new();
    assert!(!windows_managed_settings_match_with(
        None,
        Some(program_data.clone()),
        |path| {
            paths.push(path.to_owned());
            false
        },
        |root, path| {
            keys.push((root, path.to_owned()));
            2
        }
    ));
    assert_eq!(
        paths,
        [
            windows_policy(r"C:\Program Files", "managed-settings.json"),
            windows_policy(r"C:\Program Files", "managed-settings.d"),
            settings.base.join("ClaudeCode/managed-settings.json"),
            settings.base.join("ClaudeCode/managed-settings.d"),
        ]
    );
    assert_eq!(
        keys,
        vec![
            (0x8000_0002, r"SOFTWARE\Policies\ClaudeCode".into()),
            (0x8000_0001, r"SOFTWARE\Policies\ClaudeCode".into())
        ]
    );
    for key in [0x8000_0002, 0x8000_0001] {
        for status in [0, 5, 3, -1] {
            assert!(windows_managed_settings_match_with(None, Some(program_data.clone()), |_| false,
                |root, _| if root == key { status } else { 2 }));
        }
    }
    for program_data in [None, Some(std::ffi::OsString::new())] {
        assert!(windows_managed_settings_match_with(None, program_data, |_| panic!("no policy root"), |_, _| panic!("no policy root")));
    }
    let managed_dir = settings.base.join("ClaudeCode");
    std::fs::create_dir(&managed_dir).unwrap();
    let probe = |path: &Path| {
        // The Program Files fallback is outside this fixture; never inspect host policy.
        if !path.starts_with(&settings.base) { return false; }
        managed_entry_restricts_reads(path)
    };
    std::fs::write(managed_dir.join("managed-settings.json"), "{}").unwrap();
    assert!(!windows_managed_settings_match_with(None, Some(program_data.clone()), probe, |_, _| 2));
    std::fs::create_dir(managed_dir.join("managed-settings.d")).unwrap();
    std::fs::write(managed_dir.join("managed-settings.d/read.json"), r#"{"permissions":{"deny":["Read"]}}"#).unwrap();
    assert!(windows_managed_settings_match_with(None, Some(program_data), probe, |_, _| 2));
}

#[test]
fn windows_program_files_drop_ins_affect_edit_approval_and_read_restrictions() {
    let settings = Settings::new();
    let program_data = settings.base.as_os_str().to_owned();
    let program_files_drop_ins = windows_policy(r"C:\Program Files", "managed-settings.d");
    let fixture = settings.base.join("managed-settings.d");
    let probe = |check: fn(&Path) -> bool| {
        windows_managed_settings_match_with(
            None,
            Some(program_data.clone()),
            |path| path == program_files_drop_ins.as_path() && check(&fixture),
            |_, _| 2,
        )
    };
    assert!(!probe(managed_path_may_allow));
    assert!(!probe(managed_entry_restricts_reads));
    std::fs::create_dir(&fixture).unwrap();
    std::fs::write(fixture.join("policy.json"), "{}").unwrap();
    assert!(probe(managed_path_may_allow));
    assert!(!probe(managed_entry_restricts_reads));
    std::fs::write(
        fixture.join("policy.json"),
        r#"{"permissions":{"deny":["Read"]}}"#,
    )
    .unwrap();
    assert!(probe(managed_entry_restricts_reads));
}

#[test]
fn relay_reads_ignore_user_and_project_rules_but_honor_managed_policy() {
    let settings = Settings::new();
    settings.user("settings.json", r#"{"permissions":{"deny":["Read"]}}"#)
        .project("settings.local.json", r#"{"permissions":{"ask":["Grep"]}}"#);
    for provider in ["glm", "mimo", "alibaba"] {
        assert!(!restricts_reads(&settings, provider, None), "{provider}");
        assert!(claude_restricts_reads_with(provider, &settings.base, || panic!("managed restriction"),
            || true, |_| panic!("relay config")));
        assert!(restricts_reads(&settings, provider, Some(read_launch(&["--settings=custom.json"], &[]))));
    }
}

#[test]
fn claude_connections_resolve_config_and_reject_unfollowed_flags() {
    let settings = Settings::new();
    assert!(!restricts_reads(&settings, "claude", Some(read_launch(&[], &[("ANTHROPIC_BASE_URL", "https://example.invalid")]))));
    for provider in ["claude", "glm", "mimo", "alibaba"] {
        for flag in ["--settings", "--setting-sources", "--disallowedTools", "--disallowed-tools"] {
            for arg in [flag.to_owned(), format!("{flag}=value")] {
                assert!(restricts_reads(&settings, provider, Some(read_launch(&[&arg], &[]))), "{provider} {arg}");
            }
        }
        assert!(restricts_reads(&settings, provider, Some(read_launch(&[], &[("CLAUDE_CONFIG_DIR", "")]))));
        assert!(claude_restricts_reads_with(provider, &settings.base, || Err("missing saved key".into()),
            || false, |_| panic!("bad connection")));
    }
    let custom = settings.base.join("custom");
    std::fs::create_dir(&custom).unwrap();
    std::fs::write(custom.join("settings.local.json"), r#"{"permissions":{"deny":["Read"]}}"#).unwrap();
    let connection = || Some(read_launch(&[], &[("CLAUDE_CONFIG_DIR", custom.to_str().unwrap())]));
    assert!(restricts_reads(&settings, "claude", connection()));
    std::fs::create_dir(settings.base.join("project/relative-config")).unwrap();
    std::fs::write(settings.base.join("project/relative-config/settings.json"), r#"{"permissions":{"deny":["Read"]}}"#).unwrap();
    assert!(restricts_reads(&settings, "claude", Some(read_launch(&[], &[("CLAUDE_CONFIG_DIR", "relative-config")]))));
    let literal_tilde = settings.base.join("project/~/x");
    std::fs::create_dir_all(&literal_tilde).unwrap();
    std::fs::write(
        literal_tilde.join("settings.json"),
        r#"{"permissions":{"deny":["Read"]}}"#,
    )
    .unwrap();
    assert!(restricts_reads(
        &settings,
        "claude",
        Some(read_launch(&[], &[("CLAUDE_CONFIG_DIR", "~/x")]))
    ));
    #[cfg(windows)]
    assert!(restricts_reads(&settings, "claude", Some(read_launch(&[], &[("claude_config_dir", custom.to_str().unwrap())]))));
    assert!(!restricts_reads(&settings, "glm", connection()));
    settings.user("settings.json", r#"{"permissions":{"deny":["Read"]}}"#);
    std::fs::write(custom.join("settings.local.json"), "{}").unwrap();
    assert!(!restricts_reads(&settings, "claude", connection()), "the connection's folder wins");
    assert!(claude_restricts_reads_with("claude", &settings.base, || Ok(None), || false, |_| None));
}

// A named connection's HOME (USERPROFILE on Windows) picks `<home>/.claude` when no
// CLAUDE_CONFIG_DIR is set, over the saved provider environment's home. PandaCode's own
// CLAUDE_CONFIG_DIR is injected, so the test runs the same inside an agent session.
#[test]
fn a_connection_home_selects_its_own_claude_config() {
    use std::ffi::OsStr;
    let settings = Settings::new();
    let (host_home, conn_home) = (settings.base.join("host-home"), settings.base.join("conn-home"));
    for home in [&host_home, &conn_home] {
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude/settings.json"), "{}").unwrap();
    }
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let provider_env = || vec![(home_var.to_owned(), host_home.display().to_string())];
    let connection = || Some(read_launch(&[], &[(home_var, conn_home.to_str().unwrap())]));
    let cwd = settings.base.join("project");
    let conn_env = connection().unwrap().env;
    assert_eq!(launch_config_dir_with(provider_env(), &conn_env, None, &cwd), Some(conn_home.join(".claude")));
    // PandaCode's own CLAUDE_CONFIG_DIR outranks any home; an empty one is unknown.
    let inherited = settings.base.join("inherited");
    assert_eq!(launch_config_dir_with(provider_env(), &conn_env, Some(inherited.as_os_str()), &cwd), Some(inherited.clone()));
    assert_eq!(launch_config_dir_with(provider_env(), &[], Some(inherited.as_os_str()), &cwd), Some(inherited.clone()));
    assert_eq!(launch_config_dir_with(provider_env(), &conn_env, Some(OsStr::new("")), &cwd), None, "fails closed");
    assert_eq!(launch_config_dir_with(provider_env(), &[], Some(OsStr::new("relative")), &cwd), Some(cwd.join("relative")));
    let named = settings.base.join("named");
    let named_env = [("CLAUDE_CONFIG_DIR".to_owned(), named.display().to_string())];
    assert_eq!(launch_config_dir_with(provider_env(), &named_env, Some(OsStr::new("")), &cwd), Some(named),
        "a launch's own CLAUDE_CONFIG_DIR outranks the inherited one");
    assert!(!restricts_reads_over(&settings, "claude", provider_env(), connection()));
    std::fs::write(conn_home.join(".claude/settings.json"), r#"{"permissions":{"deny":["Read(secrets/**)"]}}"#).unwrap();
    assert!(restricts_reads_over(&settings, "claude", provider_env(), connection()), "the connection's home denies");
    assert!(!restricts_reads_over(&settings, "claude", provider_env(), None), "the host home allows");
    std::fs::write(conn_home.join(".claude/settings.json"), "{}").unwrap();
    std::fs::write(host_home.join(".claude/settings.json"), r#"{"permissions":{"deny":["Read(secrets/**)"]}}"#).unwrap();
    assert!(!restricts_reads_over(&settings, "claude", provider_env(), connection()), "the host home is not read");
    assert!(restricts_reads_over(&settings, "claude", provider_env(), None));
    let empty = || Some(read_launch(&[], &[(home_var, conn_home.to_str().unwrap()), ("CLAUDE_CONFIG_DIR", "")]));
    assert!(restricts_reads_over(&settings, "claude", provider_env(), empty()), "empty folder fails closed");
    assert!(restricts_reads_over(&settings, "glm", provider_env(), empty()), "relays too");
    assert!(!restricts_reads_over(&settings, "glm", provider_env(), connection()));
}

#[test]
fn project_read_rules_stop_at_nearest_git_root_and_skip_overridden_home() {
    let settings = Settings::new();
    let project = settings.base.join("project");
    let nested = project.join("src/nested");
    std::fs::create_dir_all(&nested).unwrap();
    // Worktrees use a .git file, ordinary repositories use a directory.
    std::fs::create_dir(project.join("elsewhere")).unwrap();
    std::fs::write(project.join(".git"), "gitdir: elsewhere").unwrap();
    settings.project("settings.local.json", r#"{"permissions":{"deny":["Read"]}}"#);
    assert!(read_deny_rules(&settings.base.join("config"), &nested));
    std::fs::create_dir(nested.join(".git")).unwrap();
    assert!(!read_deny_rules(&settings.base.join("config"), &nested), "nearest root");
    std::fs::remove_dir(nested.join(".git")).unwrap();
    // CLAUDE_CONFIG_DIR elsewhere: a repository rooted at $HOME still loads $HOME/.claude as
    // project settings, so it is checked (fail closed) rather than skipped.
    assert!(read_deny_rules(&settings.base.join("config"), &nested), "home .claude as project settings");
    assert!(read_deny_rules(&project.join(".claude"), &nested), "active home config");
    std::fs::remove_file(project.join(".git")).unwrap();
    assert!(!read_deny_rules(&settings.base.join("config"), &nested), "no repo: only cwd");
}

#[test]
fn non_claude_harnesses_never_probe_claude_read_settings() {
    for provider in ["codex", "opencode", "kimi"] {
        assert!(!claude_restricts_reads_with(provider, Path::new("unused"),
            || panic!("non-Claude connection"), || panic!("non-Claude policy"),
            |_| panic!("non-Claude config")));
    }
}

fn native(id: &str, status: &str, paths: &[&str]) -> ToolActivity {
    ToolActivity {
        id: id.into(),
        name: "Edit".into(),
        status: status.into(),
        input: String::new(),
        output: String::new(),
        write_paths: Some(paths.iter().map(|p| (*p).into()).collect()),
    }
}

#[test]
fn only_claude_standard_runs_wait_for_an_edit_approval() {
    // Standard is saved as "ask" (`storage::valid_mode`); Claude launches it as `default`.
    for provider in ["claude", "glm", "mimo", "alibaba"] {
        assert!(edits_wait_for_approval(provider, "ask"), "{provider}");
        for mode in ["auto", "review", "plan", "full"] {
            assert!(!edits_wait_for_approval(provider, mode), "{provider} {mode}");
        }
        // Only a mode known to wait counts: an unknown or empty one never does.
        for mode in ["standard", "default", ""] {
            assert!(!edits_wait_for_approval(provider, mode), "{provider} {mode:?}");
        }
    }
    // Codex applies workspace edits without asking even in Standard; ACP agents vary.
    for provider in ["codex", "kimi", "opencode", "pi", "grok", "devin", "zcode"] {
        assert!(!edits_wait_for_approval(provider, "ask"), "{provider}");
    }
}

#[test]
fn instruction_is_one_wording_and_only_waiting_turns_get_the_note() {
    // The cached instruction always asks for the handshake around native edits too: correct
    // in Accept edits / Full access, where a write can land before its event arrives.
    let text = instruction();
    assert!(text.starts_with("\n\nFile change tracking:"));
    assert!(text.contains("native editing tools, shell commands, or scripts"));
    assert!(text.contains("captureId") && text.contains("begin") && text.contains("complete"));
    assert!(!text.contains("tracked automatically"));
    // Standard approvals: the turn's message says native edits are tracked automatically.
    for provider in ["claude", "glm", "mimo", "alibaba", "codex", "kimi", "opencode"] {
        for mode in ["ask", "auto", "review", "plan", "full"] {
            let note = turn_note(edits_wait_for_approval(provider, mode));
            let waits = matches!(provider, "claude" | "glm" | "mimo" | "alibaba") && mode == "ask";
            assert_eq!(note.is_some(), waits, "{provider} {mode}");
        }
    }
    let note = turn_note(true).unwrap();
    assert!(note.contains("tracked automatically") && note.contains("shell commands or scripts") && note.contains("pandacode_track_files"));
    assert!(note.starts_with("\n\n") && !note.trim().contains('\n'), "one line");
    assert!(note.len() < 200, "{} B", note.len());
    eprintln!("change tracking: system instruction {} B (every mode), per-turn note {} B (Standard only)", text.len(), note.len());
}

/// A temporary Claude config folder and project; removed on drop.
struct Settings {
    base: std::path::PathBuf,
}
impl Settings {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("pandacode-claude-settings-{}", crate::storage::id()));
        std::fs::create_dir_all(base.join("config")).unwrap();
        std::fs::create_dir_all(base.join("project/.claude")).unwrap();
        Self { base }
    }
    fn user(&self, name: &str, text: impl AsRef<[u8]>) -> &Self {
        std::fs::write(self.base.join("config").join(name), text).unwrap();
        self
    }
    fn project(&self, name: &str, text: impl AsRef<[u8]>) -> &Self {
        std::fs::write(self.base.join("project/.claude").join(name), text).unwrap();
        self
    }
    fn allows(&self) -> bool {
        edit_allow_rules(&self.base.join("config"), &self.base.join("project"))
    }
}
impl Drop for Settings {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

#[test]
fn a_managed_policy_file_means_the_approval_wait_is_not_relied_on() {
    let settings = Settings::new();
    let managed = settings.base.join("managed-settings.json");
    assert!(managed_settings_may_allow(None), "unknown policy location fails closed");
    assert!(!managed_settings_may_allow(Some(&managed)), "absent");
    std::fs::write(&managed, "{}").unwrap();
    assert!(managed_settings_may_allow(Some(&managed)), "present, even without rules");
    std::fs::write(&managed, "not json").unwrap();
    assert!(managed_settings_may_allow(Some(&managed)), "unparseable");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let locked = settings.base.join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = managed_settings_may_allow(Some(&locked.join("managed-settings.json")));
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(unreadable, "presence cannot be checked");
    }
}

#[test]
fn a_managed_drop_in_directory_requires_the_tracking_handshake() {
    let settings = Settings::new();
    let managed = settings.base.join("managed-settings.json");
    let drop_ins = settings.base.join("managed-settings.d");
    let config = crate::providers::RunConfig {
        mode: "ask".into(),
        ..crate::providers::tests::config("glm")
    };
    let waits = || {
        edits_wait_for_run_using(&config, |config| {
            claude_allows_edits_with(
                config,
                || false,
                || managed_settings_may_allow(Some(&managed)),
                || panic!("relay config"),
            )
        })
    };
    assert!(waits(), "no managed policy");
    std::fs::create_dir(&drop_ins).unwrap();
    assert!(
        !waits(),
        "even an empty drop-in directory requires the handshake"
    );
    std::fs::write(
        drop_ins.join("edits.json"),
        r#"{"permissions":{"allow":["Edit"]}}"#,
    )
    .unwrap();
    assert!(!waits(), "drop-in policy present");
}

#[test]
fn managed_policy_stat_errors_fail_closed_on_every_platform() {
    for kind in [
        std::io::ErrorKind::PermissionDenied,
        std::io::ErrorKind::NotADirectory,
        std::io::ErrorKind::Other,
    ] {
        let config = crate::providers::tests::config("glm");
        let allows = || managed_path_may_allow_with(|| Err(std::io::Error::from(kind)));
        assert!(
            claude_allows_edits_with(&config, || false, allows, || panic!("relay config")),
            "{kind:?}"
        );
    }
    assert!(!managed_path_may_allow_with(|| Err(
        std::io::ErrorKind::NotFound.into()
    )));
    assert!(managed_path_may_allow_with(|| Ok(())));
    assert!(windows_managed_settings_match_with(
        None,
        Some(r"C:\ProgramData".into()),
        |_| managed_path_may_allow_with(|| Err(std::io::ErrorKind::PermissionDenied.into())),
        |_, _| panic!("unreadable policy path already requires tracking"),
    ));
}

#[test]
fn windows_managed_policy_paths_and_registry_keys_are_checked_without_host_state() {
    let program_data = std::path::PathBuf::from(r"D:\Enterprise Data");
    let mut paths = Vec::new();
    let mut keys = Vec::new();
    assert!(!windows_managed_settings_match_with(
        None,
        Some(program_data.clone().into_os_string()),
        |path| {
            paths.push(path.to_owned());
            false
        },
        |root, path| {
            keys.push((root, path.to_owned()));
            2
        },
    ));
    let root = program_data.join("ClaudeCode");
    assert_eq!(
        paths,
        [
            windows_policy(r"C:\Program Files", "managed-settings.json"),
            windows_policy(r"C:\Program Files", "managed-settings.d"),
            root.join("managed-settings.json"),
            root.join("managed-settings.d"),
        ]
    );
    assert_eq!(
        keys,
        [
            (0x8000_0002, r"SOFTWARE\Policies\ClaudeCode".to_owned()),
            (0x8000_0001, r"SOFTWARE\Policies\ClaudeCode".to_owned()),
        ]
    );
    for present in &paths {
        assert!(
            windows_managed_settings_match_with(
                None,
                Some(program_data.clone().into_os_string()),
                |path| path == present,
                |_, _| 2,
            ),
            "{present:?}"
        );
    }
    for unknown in [None, Some(std::ffi::OsString::new())] {
        assert!(windows_managed_settings_match_with(
            None,
            unknown,
            |_| panic!("unknown PROGRAMDATA must fail closed"),
            |_, _| panic!("unknown PROGRAMDATA must fail closed")
        ));
    }
}

#[test]
fn windows_registry_presence_and_errors_require_native_edit_tracking() {
    for policy_root in [0x8000_0002, 0x8000_0001] {
        for status in [0, 5, 3, 87] {
            let config = crate::providers::RunConfig {
                mode: "ask".into(),
                ..crate::providers::tests::config("glm")
            };
            let allows = || {
                windows_managed_settings_match_with(
                    None,
                    Some(r"C:\ProgramData".into()),
                    |_| false,
                    |root, _| if root == policy_root { status } else { 2 },
                )
            };
            assert!(
                !edits_wait_for_run_using(&config, |config| claude_allows_edits_with(
                    config,
                    || false,
                    allows,
                    || panic!("relay config"),
                )),
                "root {policy_root:#x}, status {status}"
            );
        }
    }
}

#[test]
fn a_users_edit_allow_rule_means_the_approval_wait_is_not_relied_on() {
    // No settings, or settings without an edit rule: Standard edits wait for approval.
    assert!(!Settings::new().allows());
    assert!(!Settings::new().user("settings.json", r#"{"permissions":{"allow":["Bash(ls:*)","Read","mcp__x__y"],"deny":["Edit"]}}"#).allows());
    assert!(!Settings::new().user("settings.json", r#"{"model":"opus","permissions":{"defaultMode":"default"}}"#).allows());
    // An allow rule for any native edit tool, user or project level, skips the wait.
    for rule in ["Edit", "Write", "MultiEdit", "NotebookEdit", "Edit(*)", "Write(src/**)", " Edit ", "*"] {
        let text = format!(r#"{{"permissions":{{"allow":["Read",{}]}}}}"#, serde_json::json!(rule));
        for (user, name) in [(true, "settings.json"), (true, "settings.local.json"), (false, "settings.json"), (false, "settings.local.json")] {
            let settings = Settings::new();
            if user { settings.user(name, &text) } else { settings.project(name, &text) };
            assert!(settings.allows(), "{rule} in {name} (user {user})");
        }
    }
    // So does a default mode that never asks.
    assert!(Settings::new().user("settings.json", r#"{"permissions":{"defaultMode":"acceptEdits"}}"#).allows());
    // Anything unreadable or unexpected counts as an allow rule: the wait is never assumed.
    for text in ["not json", "", "[]", "null", r#"{"permissions":[]}"#, r#"{"permissions":{"allow":"Edit"}}"#, r#"{"permissions":{"allow":[{"tool":"Read"}]}}"#] {
        assert!(Settings::new().project("settings.local.json", text).allows(), "{text:?}");
    }
    let huge = format!(r#"{{"permissions":{{"allow":[]}},"pad":"{}"}}"#, "x".repeat(SETTINGS_LIMIT as usize));
    assert!(Settings::new().user("settings.json", huge).allows(), "oversized");
    let folder = Settings::new();
    std::fs::create_dir_all(folder.base.join("config/settings.json")).unwrap();
    assert!(folder.allows(), "a folder where a settings file belongs");
    // The run's message then carries no note: the cached handshake covers native edits too.
    let note = |allows: bool| turn_note(edits_wait_for_approval("claude", "ask") && !allows);
    assert!(note(false).is_some_and(|note| note.contains("tracked automatically")));
    assert!(note(true).is_none());
}

#[test]
fn relays_without_setting_files_and_other_harnesses_skip_the_settings_check() {
    // Non-Claude-family harnesses never check Claude settings or wait for edit approval.
    let codex = crate::providers::RunConfig { provider: "codex".into(), ..crate::providers::tests::config("claude") };
    assert!(!claude_allows_edits(&codex));
    assert!(!edits_wait_for_run(&codex));
    // GLM, MiMo and Alibaba ignore user/project/local settings files, but still inherit
    // enterprise managed-settings.json if present on this host.
    let host_managed = host_managed_settings_may_allow();
    for provider in ["glm", "mimo", "alibaba"] {
        let config = crate::providers::RunConfig { mode: "ask".into(), ..crate::providers::tests::config(provider) };
        assert_eq!(claude_allows_edits(&config), host_managed, "{provider}");
        assert_eq!(edits_wait_for_run(&config), !host_managed, "{provider}");
    }
}

#[test]
fn claude_family_relays_respect_connections_and_managed_settings_but_ignore_user_settings() {
    let with_allow_rule = Settings::new();
    with_allow_rule
        .user("settings.json", r#"{"permissions":{"allow":["Edit"]}}"#)
        .project("settings.json", r#"{"permissions":{"allow":["Write"]}}"#);
    let absent_managed = with_allow_rule.base.join("absent-managed-settings.json");
    let present_managed = with_allow_rule.base.join("managed-settings.json");
    std::fs::write(&present_managed, "{}").unwrap();

    let config_dir = with_allow_rule.base.join("config");
    let project_dir = with_allow_rule.base.join("project");

    for provider in ["glm", "mimo", "alibaba"] {
        let config = crate::providers::RunConfig {
            mode: "ask".into(),
            cwd: project_dir.clone(),
            ..crate::providers::tests::config(provider)
        };
        // Neither named connection nor managed settings: relays skip user/project settings
        // (and never query claude_config_dir), even when an Edit allow rule is present there.
        assert!(
            !claude_allows_edits_with(&config, || false, || managed_settings_may_allow(Some(&absent_managed)), || panic!("relays must not read claude_config_dir")),
            "{provider} without connection or managed settings"
        );
        assert!(
            edits_wait_for_run_using(&config, |c| claude_allows_edits_with(c, || false, || managed_settings_may_allow(Some(&absent_managed)), || Some(config_dir.clone()))),
            "{provider} waits when neither connection nor managed settings apply"
        );
        // A named connection may pass --allowedTools or another config folder: do not rely on the wait.
        assert!(
            claude_allows_edits_with(&config, || true, || managed_settings_may_allow(Some(&absent_managed)), || panic!("connection short-circuits before config dir")),
            "{provider} with named connection"
        );
        assert!(
            !edits_wait_for_run_using(&config, |c| claude_allows_edits_with(c, || true, || managed_settings_may_allow(Some(&absent_managed)), || None)),
            "{provider} does not wait with named connection"
        );
        // Enterprise managed-settings.json still applies even with --setting-sources "".
        assert!(
            claude_allows_edits_with(&config, || false, || managed_settings_may_allow(Some(&present_managed)), || panic!("managed settings short-circuit before config dir")),
            "{provider} with managed settings"
        );
        assert!(
            !edits_wait_for_run_using(&config, |c| claude_allows_edits_with(c, || false, || managed_settings_may_allow(Some(&present_managed)), || None)),
            "{provider} does not wait with managed settings"
        );
    }

    // Plain `claude` still checks claude_config_dir / project settings when no connection or
    // managed policy applies, and treats an unknown config dir as allowing.
    let claude = crate::providers::RunConfig {
        mode: "ask".into(),
        cwd: project_dir,
        ..crate::providers::tests::config("claude")
    };
    assert!(claude_allows_edits_with(&claude, || false, || managed_settings_may_allow(Some(&absent_managed)), || Some(config_dir.clone())));
    assert!(!edits_wait_for_run_using(&claude, |c| claude_allows_edits_with(c, || false, || managed_settings_may_allow(Some(&absent_managed)), || Some(config_dir.clone()))));
    assert!(claude_allows_edits_with(&claude, || false, || managed_settings_may_allow(Some(&absent_managed)), || None));
    let clean = Settings::new();
    let claude_clean = crate::providers::RunConfig {
        mode: "ask".into(),
        cwd: clean.base.join("project"),
        ..crate::providers::tests::config("claude")
    };
    assert!(!claude_allows_edits_with(&claude_clean, || false, || managed_settings_may_allow(Some(&absent_managed)), || Some(clean.base.join("config"))));
    assert!(edits_wait_for_run_using(&claude_clean, |c| claude_allows_edits_with(c, || false, || managed_settings_may_allow(Some(&absent_managed)), || Some(clean.base.join("config")))));

    // Non-Claude-family harnesses short-circuit before connection/managed/config checks.
    let codex = crate::providers::RunConfig {
        mode: "ask".into(),
        ..crate::providers::tests::config("codex")
    };
    assert!(!claude_allows_edits_with(
        &codex,
        || panic!("non-Claude harnesses must not check connections"),
        || panic!("non-Claude harnesses must not check managed settings"),
        || panic!("non-Claude harnesses must not check claude_config_dir"),
    ));
}

#[test]
fn an_unchanged_write_after_this_tasks_own_earlier_edit_stays_clean() {
    // The tracker already holds this path's baseline from an earlier tool call this turn,
    // and the second write leaves the bytes that tool left: a real no-op, not a lost race.
    let f = crate::turn_changes::tests::Fixture::new(false);
    f.write("src/a.txt", "one\n");
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    tracker.observe_tool("first", &native("first", "running", &["src/a.txt"]));
    f.write("src/a.txt", "one\ntwo\n");
    tracker.observe_tool("first", &native("first", "completed", &["src/a.txt"]));
    tracker.observe_tool("same", &native("same", "running", &["src/a.txt"]));
    f.write("src/a.txt", "one\ntwo\n");
    tracker.observe_tool("same", &native("same", "completed", &["src/a.txt"]));
    let captured = tracker.finish().unwrap();
    assert_eq!(captured.summary.files.len(), 1);
    assert_eq!((captured.summary.additions, captured.summary.deletions), (1, 0));
    assert!(!captured.summary.truncated, "{:?}", captured.summary.error);
    // A write that beat its baseline after such an edit is still flagged.
    let f = crate::turn_changes::tests::Fixture::new(false);
    f.write("src/a.txt", "one\n");
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    tracker.observe_tool("first", &native("first", "running", &["src/a.txt"]));
    f.write("src/a.txt", "one\ntwo\n");
    tracker.observe_tool("first", &native("first", "completed", &["src/a.txt"]));
    f.write("src/a.txt", "one\ntwo\nthree\n");
    tracker.observe_tool("late", &native("late", "running", &["src/a.txt"]));
    tracker.observe_tool("late", &native("late", "completed", &["src/a.txt"]));
    assert!(tracker.finish().unwrap().summary.truncated, "a lost race is never silently clean");
}

/// Sets `path`'s modification time to `age` before now.
fn modified_ago(f: &crate::turn_changes::tests::Fixture, path: &str, age: std::time::Duration) {
    let file = std::fs::File::options().write(true).open(f.root.join(path)).unwrap();
    file.set_modified(std::time::SystemTime::now() - age).unwrap();
}

#[test]
fn a_native_write_to_a_file_modified_just_before_the_turn_is_flagged_partial() {
    // File systems keep coarse modification times (1–2 s on some), so a write landing in
    // this turn can read as just before it: when in doubt the turn is marked partial.
    let f = crate::turn_changes::tests::Fixture::new(false);
    f.write("src/a.txt", "one\n");
    modified_ago(&f, "src/a.txt", std::time::Duration::from_millis(500));
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    tracker.observe_tool("noop", &native("noop", "running", &["src/a.txt"]));
    tracker.observe_tool("noop", &native("noop", "completed", &["src/a.txt"]));
    let captured = tracker.finish().unwrap();
    assert!(captured.summary.files.is_empty());
    assert!(captured.summary.truncated, "a modification time within the resolution slack is never trusted");
}

#[test]
fn a_native_write_to_a_file_untouched_this_turn_stays_clean() {
    // The file's bytes predate the turn, and the tool left them alone: truly no change.
    let f = crate::turn_changes::tests::Fixture::new(false);
    f.write("src/a.txt", "one\n");
    modified_ago(&f, "src/a.txt", std::time::Duration::from_secs(3600));
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    tracker.observe_tool("noop", &native("noop", "running", &["src/a.txt"]));
    tracker.observe_tool("noop", &native("noop", "completed", &["src/a.txt"]));
    let captured = tracker.finish().unwrap();
    assert!(captured.summary.files.is_empty());
    assert!(!captured.summary.truncated, "{:?}", captured.summary.error);
}

#[test]
fn native_edit_tools_are_captured_without_a_handshake() {
    let f = crate::turn_changes::tests::Fixture::new(false);
    f.write("src/a.txt", "one\n");
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    // The baseline is taken when the running event arrives, before the tool writes.
    tracker.observe_tool("edit", &native("edit", "running", &["src/a.txt"]));
    f.write("src/a.txt", "one\ntwo\n");
    tracker.observe_tool("edit", &native("edit", "completed", &["src/a.txt"]));
    let captured = tracker.finish().unwrap();
    assert_eq!(captured.summary.files.len(), 1);
    assert_eq!((captured.summary.additions, captured.summary.deletions), (1, 0));
    assert!(!captured.summary.truncated);
}

#[test]
fn a_native_baseline_that_lost_the_race_is_flagged_never_silently_clean() {
    // A harness running without approvals may apply the edit before its event reaches
    // PandaCode; the baseline then already holds the new bytes. That must never read as
    // "no changes": the turn is marked partial so the user knows edits were omitted.
    let f = crate::turn_changes::tests::Fixture::new(false);
    f.write("src/a.txt", "one\n");
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    f.write("src/a.txt", "one\ntwo\n");
    tracker.observe_tool("late", &native("late", "running", &["src/a.txt"]));
    tracker.observe_tool("late", &native("late", "completed", &["src/a.txt"]));
    let captured = tracker.finish().unwrap();
    assert!(captured.summary.files.is_empty());
    assert!(captured.summary.truncated);
    assert!(captured.summary.error.is_some());
}

#[test]
fn an_explicit_capture_completed_without_changes_stays_clean() {
    // A shell batch that turned out to change nothing is not a lost race.
    let f = crate::turn_changes::tests::Fixture::new(false);
    f.write("a.txt", "one\n");
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    let begun = tracker.report(json!({"action":"begin","paths":["a.txt"]})).unwrap();
    tracker.report(json!({"action":"complete","captureId":begun["captureId"],"paths":["a.txt"]})).unwrap();
    let captured = tracker.finish().unwrap();
    assert!(captured.summary.files.is_empty() && !captured.summary.truncated);
}

/// A Windows policy location as `windows_managed_settings_paths` joins it.
fn windows_policy(root: &str, name: &str) -> PathBuf {
    PathBuf::from(root).join("ClaudeCode").join(name)
}

#[test]
fn windows_program_files_are_joined_deduplicated_and_probed_by_the_production_matcher() {
    use std::ffi::OsString;
    let data = r"D:\Enterprise Data";
    let default = r"C:\Program Files";
    for (program_files, roots) in [
        (Some(OsString::from(r"D:\Apps")), vec![default, r"D:\Apps", data]),
        (Some(OsString::from(default)), vec![default, data]),
        (Some(OsString::new()), vec![default, data]),
        (None, vec![default, data]),
    ] {
        let (mut paths, mut keys) = (Vec::new(), Vec::new());
        let label = format!("{program_files:?}");
        assert!(!windows_managed_settings_match_with(
            program_files.clone(),
            Some(OsString::from(data)),
            |path| {
                paths.push(path.to_owned());
                false
            },
            |root, path| {
                keys.push((root, path.to_owned()));
                2
            },
        ), "{label}");
        let expected: Vec<PathBuf> = roots.iter()
            .flat_map(|root| [windows_policy(root, "managed-settings.json"), windows_policy(root, "managed-settings.d")])
            .collect();
        assert_eq!(paths, expected, "{label}");
        assert_eq!(keys, [(0x8000_0002, r"SOFTWARE\Policies\ClaudeCode".to_owned()), (0x8000_0001, r"SOFTWARE\Policies\ClaudeCode".to_owned())]);
        // Each probed file or drop-in directory alone requires tracking.
        for present in &expected {
            assert!(windows_managed_settings_match_with(program_files.clone(), Some(OsString::from(data)),
                |path| path == present.as_path(), |_, _| 2), "{label} {present:?}");
        }
        // Registry presence or any error other than not-found fails closed.
        for status in [0, 5, 87] {
            assert!(windows_managed_settings_match_with(program_files.clone(), Some(OsString::from(data)),
                |_| false, |_, _| status), "{label} status {status}");
        }
        // Missing PROGRAMDATA is an unknown legacy location: fail closed without probing.
        for unknown in [None, Some(OsString::new())] {
            assert!(windows_managed_settings_match_with(program_files.clone(), unknown,
                |_| panic!("no policy root"), |_, _| panic!("no policy root")), "{label}");
        }
    }
}

#[test]
fn managed_drop_in_directories_with_too_many_entries_fail_closed() {
    let settings = Settings::new();
    let drop_ins = settings.base.join("managed-settings.d");
    std::fs::create_dir(&drop_ins).unwrap();
    for index in 0..256 {
        std::fs::write(drop_ins.join(format!("note-{index}.txt")), "").unwrap();
    }
    assert!(!settings_drop_ins_restrict_reads(&drop_ins), "256 entries are walked");
    std::fs::write(drop_ins.join("note-256.txt"), "").unwrap();
    assert!(settings_drop_ins_restrict_reads(&drop_ins), "more than 256 entries fail closed");
}

#[test]
fn an_empty_claude_config_dir_is_unknown_and_fails_closed() {
    let cwd = std::env::temp_dir().join("pandacode-empty-config-dir");
    let empty = [("CLAUDE_CONFIG_DIR".to_owned(), String::new())];
    assert_eq!(resolve_claude_config_dir_env(&empty, &cwd, false), None);
    let later_empty = [("CLAUDE_CONFIG_DIR".to_owned(), "custom".to_owned()), ("CLAUDE_CONFIG_DIR".to_owned(), String::new())];
    assert_eq!(resolve_claude_config_dir_env(&later_empty, &cwd, false), None, "the last value wins");
    assert_eq!(resolve_claude_config_dir_env(&later_empty[..1], &cwd, false), Some(cwd.join("custom")));
    let config = crate::providers::RunConfig { mode: "ask".into(), cwd: cwd.clone(), ..crate::providers::tests::config("claude") };
    let allows = |config: &crate::providers::RunConfig| claude_allows_edits_with(config, || false, || false,
        || resolve_claude_config_dir_env(&empty, &config.cwd, false));
    assert!(allows(&config));
    assert!(!edits_wait_for_run_using(&config, allows));
    assert!(claude_restricts_reads_with("claude", &cwd, || Ok(None), || false,
        |_| resolve_claude_config_dir_env(&empty, &cwd, false)));
}

#[test]
fn edit_allow_rules_cover_ancestors_up_to_the_git_root() {
    let settings = Settings::new();
    let (config, project) = (settings.base.join("config"), settings.base.join("project"));
    let nested = project.join("src/nested");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::create_dir(project.join(".git")).unwrap();
    assert!(!edit_allow_rules(&config, &nested));
    settings.project("settings.json", r#"{"permissions":{"allow":["Edit"]}}"#);
    assert!(edit_allow_rules(&config, &nested), "ancestor up to the .git root");
    let run = crate::providers::RunConfig { mode: "ask".into(), cwd: nested.clone(), ..crate::providers::tests::config("claude") };
    assert!(!edits_wait_for_run_using(&run, |c| claude_allows_edits_with(c, || false, || false, || Some(config.clone()))));
    std::fs::create_dir(nested.join(".git")).unwrap();
    assert!(!edit_allow_rules(&config, &nested), "the walk stops at the nearest root");
    std::fs::remove_dir(nested.join(".git")).unwrap();
    // The active config folder doubling as a project folder is read once and still counts.
    assert!(edit_allow_rules(&project.join(".claude"), &nested));
}

#[test]
fn linked_worktrees_inherit_main_checkout_local_edit_allow_rules() {
    for relative in [false, true] {
        let settings = Settings::new();
        let (main, worktree, _) = linked_checkout(&settings, false, relative);
        let config = settings.base.join("config");
        // A shared settings.json is not inherited from the main checkout.
        std::fs::write(main.join(".claude/settings.json"), r#"{"permissions":{"allow":["Edit"]}}"#).unwrap();
        assert!(edit_allow_rules(&config, &main));
        assert!(!edit_allow_rules(&config, &worktree), "relative={relative}");
        std::fs::write(main.join(".claude/settings.local.json"), r#"{"permissions":{"allow":["Write(src/**)"]}}"#).unwrap();
        assert!(edit_allow_rules(&config, &worktree), "relative={relative}");
        let run = crate::providers::RunConfig { mode: "ask".into(), cwd: worktree.clone(), ..crate::providers::tests::config("claude") };
        assert!(!edits_wait_for_run_using(&run, |c| claude_allows_edits_with(c, || false, || false, || Some(config.clone()))));
    }
}

#[test]
fn unreadable_worktree_metadata_fails_closed_for_edit_allow_rules() {
    let settings = Settings::new();
    let (_, worktree, gitdir) = linked_checkout(&settings, false, false);
    let config = settings.base.join("config");
    assert!(!edit_allow_rules(&config, &worktree));
    std::fs::remove_dir_all(&gitdir).unwrap();
    assert!(edit_allow_rules(&config, &worktree), "missing gitdir");
    std::fs::write(worktree.join(".git"), "not a gitfile\n").unwrap();
    assert!(edit_allow_rules(&config, &worktree), "invalid gitfile");
    std::fs::remove_file(worktree.join(".git")).unwrap();
    std::fs::create_dir(worktree.join(".git")).unwrap();
    assert!(!edit_allow_rules(&config, &worktree), "an ordinary repository is clean");
}
