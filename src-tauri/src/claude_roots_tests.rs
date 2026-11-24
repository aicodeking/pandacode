use super::*;

/// A fresh folder under the temp dir, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("pandacode-claude-roots-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect()
}

#[test]
fn the_config_dir_override_wins_and_an_explicit_empty_one_is_unknown() {
    let scratch = Scratch::new("env");
    let cwd = scratch.0.join("project");
    let custom = scratch.0.join("custom-claude");
    let home = scratch.0.join("home");
    let home_env = [("HOME", home.to_str().unwrap()), ("USERPROFILE", home.to_str().unwrap())];
    // An explicit override (absolute or relative to the launch's cwd) beats the inherited value and home.
    let with = |pairs: &[(&str, &str)]| env(&[&home_env[..], pairs].concat());
    let inherited = Some(OsStr::new("inherited"));
    assert_eq!(resolve_claude_config_dir_env_with(&with(&[("CLAUDE_CONFIG_DIR", custom.to_str().unwrap())]), inherited, &cwd, false), Some(custom.clone()));
    assert_eq!(resolve_claude_config_dir_env_with(&with(&[("CLAUDE_CONFIG_DIR", "relative")]), None, &cwd, false), Some(cwd.join("relative")));
    // Set but empty (in the launch or inherited) is not the same as unset: unknown, so callers fail closed.
    assert_eq!(resolve_claude_config_dir_env_with(&with(&[("CLAUDE_CONFIG_DIR", "")]), inherited, &cwd, false), None);
    assert_eq!(resolve_claude_config_dir_env_with(&with(&[]), Some(OsStr::new("")), &cwd, false), None);
    // Inherited from PandaCode's own environment when the launch sets none.
    assert_eq!(resolve_claude_config_dir_env_with(&with(&[]), inherited, &cwd, false), Some(cwd.join("inherited")));
    // Unset everywhere: `<home>/.claude`.
    assert_eq!(resolve_claude_config_dir_env_with(&with(&[]), None, &cwd, false), Some(home.join(".claude")));
    // Windows matches variable names case-insensitively; elsewhere a lowercase name is another variable.
    let lower = with(&[("claude_config_dir", custom.to_str().unwrap())]);
    assert_eq!(resolve_claude_config_dir_env_with(&lower, None, &cwd, true), Some(custom));
    assert_eq!(resolve_claude_config_dir_env_with(&lower, None, &cwd, false), Some(home.join(".claude")));
}

#[test]
fn only_a_missing_registry_policy_key_proves_absence() {
    const NOT_FOUND: i32 = 2;
    const ACCESS_DENIED: i32 = 5;
    let mut asked = Vec::new();
    assert!(!windows_registry_policy_present(|root, path| {
        asked.push((root, path.to_owned()));
        NOT_FOUND
    }));
    assert_eq!(asked.len(), 2, "both HKLM and HKCU are probed");
    assert!(asked.iter().all(|(_, path)| path == r"SOFTWARE\Policies\ClaudeCode"));
    assert!(windows_registry_policy_present(|_, _| 0), "an existing policy key is present");
    assert!(windows_registry_policy_present(|root, _| if root == 0x8000_0001 { 0 } else { NOT_FOUND }), "a user policy key counts too");
    assert!(windows_registry_policy_present(|_, _| ACCESS_DENIED), "an unreadable key fails closed");
}

#[test]
fn a_settings_path_is_absent_only_when_nothing_is_there() {
    let scratch = Scratch::new("absent");
    let file = scratch.0.join("managed-settings.json");
    assert!(settings_path_absent(&file));
    std::fs::write(&file, "{}").unwrap();
    assert!(!settings_path_absent(&file));
    assert!(!settings_path_absent(&scratch.0), "a folder is not absent");
}

#[test]
fn a_plain_repo_walks_to_its_root_and_has_no_main_checkout() {
    let scratch = Scratch::new("plain");
    let repo = scratch.0.join("repo");
    let nested = repo.join("src").join("deep");
    std::fs::create_dir_all(repo.join(".git")).unwrap();
    std::fs::create_dir_all(&nested).unwrap();
    let roots = project_config_roots(&nested);
    assert_eq!(roots.ancestors, vec![nested.clone(), repo.join("src"), repo.clone()]);
    assert_eq!(roots.main_worktree, None);
    assert_eq!(roots.error, None);
    assert_eq!(linked_worktree_main_root(&repo), Ok(None), "a `.git` folder is the main checkout itself");
    assert_eq!(linked_worktree_main_root(&scratch.0), Ok(None), "no `.git` at all");
}

#[test]
fn a_linked_worktrees_gitdir_file_leads_to_its_main_checkout() {
    let scratch = Scratch::new("linked");
    let main = scratch.0.join("main");
    let admin = main.join(".git").join("worktrees").join("wt");
    std::fs::create_dir_all(&admin).unwrap();
    std::fs::write(main.join(".git").join("config"), "[core]\n\tbare = false\n").unwrap();
    std::fs::write(admin.join("commondir"), "../..\n").unwrap();
    let worktree = scratch.0.join("wt");
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
    let main_root = main.canonicalize().unwrap();
    assert_eq!(linked_worktree_main_root(&worktree), Ok(Some(main_root.clone())));
    let roots = project_config_roots(&worktree);
    assert_eq!(roots.ancestors, vec![worktree.clone()]);
    assert_eq!(roots.main_worktree, Some(main_root));
    assert_eq!(roots.error, None);
    // A gitfile pointing nowhere is an error, never silently "no main checkout".
    std::fs::write(worktree.join(".git"), "gitdir: missing\n").unwrap();
    assert_eq!(linked_worktree_main_root(&worktree), Err("unreadable gitdir"));
    // An ordinary gitfile (a submodule's) has no commondir and so no main checkout.
    std::fs::remove_file(admin.join("commondir")).unwrap();
    std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
    assert_eq!(linked_worktree_main_root(&worktree), Ok(None));
}

#[test]
fn only_a_gitfile_with_a_commondir_is_a_linked_worktree() {
    let scratch = Scratch::new("is-linked");
    let main = scratch.0.join("main");
    let admin = main.join(".git").join("worktrees").join("wt");
    let module = main.join(".git").join("modules").join("sub");
    std::fs::create_dir_all(&admin).unwrap();
    std::fs::create_dir_all(&module).unwrap();
    std::fs::write(admin.join("commondir"), "../..\n").unwrap();
    let worktree = scratch.0.join("wt");
    let submodule = main.join("sub");
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::create_dir_all(&submodule).unwrap();
    std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
    std::fs::write(submodule.join(".git"), "gitdir: ../.git/modules/sub\n").unwrap();
    assert!(is_linked_worktree_root(&worktree));
    assert!(!is_linked_worktree_root(&main), "a `.git` folder is a main checkout");
    assert!(!is_linked_worktree_root(&submodule), "a submodule's gitfile has no commondir");
    assert!(!is_linked_worktree_root(&scratch.0), "no `.git` at all");
}

#[test]
fn a_large_common_config_still_resolves_and_an_oversize_one_fails_closed() {
    let scratch = Scratch::new("large-config");
    let main = scratch.0.join("main");
    let admin = main.join(".git").join("worktrees").join("wt");
    std::fs::create_dir_all(&admin).unwrap();
    std::fs::write(admin.join("commondir"), "../..\n").unwrap();
    let worktree = scratch.0.join("wt");
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
    // One section per branch, as `git worktree add -b` with upstream tracking leaves them.
    let branches: String = (0..250)
        .map(|n| format!("[branch \"pandacode/wt-{n}\"]\n\tremote = origin\n\tmerge = refs/heads/pandacode/wt-{n}\n\tvscode-merge-base = origin/main\n"))
        .collect();
    let config = format!("{branches}[core]\n\tbare = false\n");
    assert!(config.len() > 20 * 1024, "well past the 16 KiB pointer-file bound: {} bytes", config.len());
    let config_path = main.join(".git").join("config");
    std::fs::write(&config_path, &config).unwrap();
    let main_root = main.canonicalize().unwrap();
    assert_eq!(linked_worktree_main_root(&worktree), Ok(Some(main_root.clone())));
    assert_eq!(project_config_roots(&worktree).main_worktree, Some(main_root));
    // The pointer files keep their small bound.
    assert_eq!(read_git_metadata(&config_path), Err("invalid worktree metadata file"));
    // Past 1 MiB the config is refused, never read as "no main checkout".
    let comments = "# padding\n".repeat((MAX_GIT_CONFIG_BYTES as usize) / 10 + 1);
    std::fs::write(&config_path, format!("{comments}{config}")).unwrap();
    assert_eq!(linked_worktree_main_root(&worktree), Err("invalid worktree metadata file"));
    assert_eq!(project_config_roots(&worktree).error, Some("invalid worktree metadata file"));
}

#[test]
fn git_dirs_follow_plain_repos_subfolders_and_linked_worktrees() {
    let scratch = Scratch::new("git-dirs");
    assert_eq!((git_dirs_for(&scratch.0), git_checkout_root(&scratch.0)), (None, None), "outside a repository");
    let repo = scratch.0.join("repo");
    let (dot_git, deep, worktree) = (repo.join(".git"), repo.join("src").join("deep"), scratch.0.join("wt"));
    let admin = dot_git.join("worktrees").join("wt");
    for dir in [&admin, &deep, &worktree.join("src")] { std::fs::create_dir_all(dir).unwrap(); }
    for cwd in [&repo, &deep] {
        assert_eq!(git_dirs_for(cwd), Some(Ok((dot_git.clone(), dot_git.clone()))), "{cwd:?}");
        assert_eq!(git_checkout_root(cwd), Some(repo.clone()));
    }
    std::fs::write(admin.join("commondir"), "../..\n").unwrap();
    std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
    assert_eq!(git_dirs_for(&worktree.join("src")), Some(Ok((admin.clone(), admin.join("../..")))));
    assert_eq!(git_checkout_root(&worktree.join("src")), Some(worktree.clone()));
    std::fs::write(admin.join("commondir"), " \n").unwrap();
    assert_eq!(git_dirs_for(&worktree), Some(Err("empty commondir")));
    std::fs::write(worktree.join(".git"), "nonsense\n").unwrap();
    assert_eq!(git_dirs_for(&worktree), Some(Err("invalid gitfile")));
}

#[test]
fn git_config_values_continue_after_an_unescaped_trailing_backslash() {
    let main = Ok((false, Some("../main".to_owned())));
    for config in ["[core]\n worktree = ../ma\\\nin\n", "[core]\r\n worktree = \"../ma\\\r\nin\" # c\r\n", "[core]\n worktree = \\\n  ../main\n"] {
        assert_eq!(git_core_checkout(config), main, "{config:?}");
    }
    // A continued value in another section swallows what would otherwise be a `[core]` header.
    assert_eq!(git_core_checkout("[remote \"origin\"]\n url = a\\\n[core]\n worktree = ../main\n"), Ok((false, None)));
    // Neither a backslash in a comment nor an escaped one continues; a dangling one at the end fails closed.
    assert_eq!(git_core_checkout("[core]\n bare = true # note \\\n worktree = ../main\n"), Ok((true, Some("../main".to_owned()))));
    assert_eq!(git_core_checkout("[core]\n worktree = C:\\\\\n bare\n"), Ok((true, Some("C:\\".to_owned()))));
    assert_eq!(git_core_checkout("[core]\n worktree = a\\"), Err("unterminated git config continuation"));
}

#[test]
fn git_config_includes_apply_in_place_skip_missing_files_and_refuse_cycles() {
    let scratch = Scratch::new("include");
    let (config, extra) = (scratch.0.join("config"), scratch.0.join("extra").join("checkout.config"));
    std::fs::create_dir_all(scratch.0.join("extra")).unwrap();
    std::fs::write(&extra, "[core]\n\tworktree = ../main\n").unwrap();
    let text = "[core]\n bare = true\n[InClUdE]\n PaTh = extra/checkout.config\n path = missing.config\n";
    std::fs::write(&config, text).unwrap();
    assert_eq!(read_git_core_checkout(&config), Ok((true, Some("../main".to_owned()))));
    assert_eq!(git_core_checkout(text), Err("unsupported git config include"), "text alone has no folder to resolve against");
    // Later lines override included ones, as if the file were pasted in place.
    std::fs::write(&config, "[include]\n path = extra/checkout.config\n[core]\n worktree = ../other\n").unwrap();
    assert_eq!(read_git_core_checkout(&config), Ok((false, Some("../other".to_owned()))));
    std::fs::write(&extra, "[include]\n path = ../config\n").unwrap();
    assert_eq!(read_git_core_checkout(&config), Err("cyclic git config include"));
    std::fs::write(&config, "[includeIf \"gitdir:/x/\"]\n path = missing.config\n").unwrap();
    assert_eq!(read_git_core_checkout(&config), Err("unsupported git config include"));
    // d2 through d5 nest four deep (d6 is missing); starting at d1 is one too many.
    (1..=5).for_each(|n| std::fs::write(scratch.0.join(format!("d{n}")), format!("[include]\n path = d{}\n", n + 1)).unwrap());
    std::fs::write(&config, "[include]\n path = d2\n").unwrap();
    assert_eq!(read_git_core_checkout(&config), Ok((false, None)));
    std::fs::write(&config, "[include]\n path = d1\n").unwrap();
    assert_eq!(read_git_core_checkout(&config), Err("git config include too deep"));
}
