use super::*;

#[path = "secret_paths_cases.rs"]
mod cases;
use cases::CASES;

#[test]
fn every_case_is_decided_for_both_rules() {
    let wrong: Vec<String> = CASES
        .iter()
        .filter(|&&(path, plain, strict)| secret_path(path, false) != plain || secret_path(path, true) != strict)
        .map(|(path, plain, strict)| format!("{path}: expected plain {plain} strict {strict}, got plain {} strict {}", secret_path(path, false), secret_path(path, true)))
        .collect();
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    for &(path, plain, strict) in CASES {
        assert!(!plain || strict, "strict refuses what plain refuses: {path}");
    }
}

fn refused_root(root: &Path, home: Option<&Path>, strict: bool) -> bool {
    root_refusal(root, home, strict).is_some()
}

/// Asserts each root's verdict in both rules: (root, refused by the plain rule, by the strict).
fn roots(home: &str, cases: &[(&str, bool, bool)]) {
    let home = Some(Path::new(home));
    let wrong: Vec<String> = cases
        .iter()
        .filter(|&&(root, plain, strict)| refused_root(Path::new(root), home, false) != plain || refused_root(Path::new(root), home, true) != strict)
        .map(|(root, plain, strict)| format!("{root}: expected plain {plain} strict {strict}"))
        .collect();
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    for &(root, plain, strict) in cases {
        assert!(!plain || strict, "strict refuses what plain refuses: {root}");
    }
}

/// A project is never refused for its own name, wherever it lives; folders around it that
/// hold logins still are.
#[test]
fn a_project_is_judged_as_a_folder_not_a_file() {
    let mut cases: Vec<(String, bool, bool)> = Vec::new();
    for name in ["keychain-swift", "KeychainAccess", "sealed-secrets", "git-secrets", "detect-secrets", "password-generator", "api-key-service", "credential-helper", "jwt-token-service", "token", "secret-santa", "secrets", "id_rsa-tools", "server.key", "wp-config.php"] {
        for parent in ["/Users/Me/code", "/tmp", "/Volumes/Ext"] {
            cases.push((format!("{parent}/{name}"), false, false));
            // Below a `secrets` folder, files that are not code are credentials (`secret_path`),
            // and a root there would hide that folder from the walk.
            cases.push((format!("{parent}/{name}/src"), name == "secrets", name == "secrets"));
        }
    }
    let cases: Vec<(&str, bool, bool)> = cases.iter().map(|(root, plain, strict)| (root.as_str(), *plain, *strict)).collect();
    roots("/Users/Me", &cases);
    roots("/Users/Me", &[
        // Login and credential folders on the way to the root, inside home or out.
        ("/Users/Me/code/.git", true, true),
        ("/Users/Me/code/app/.aws/x", true, true),
        ("/Users/Me/ops/secrets/prod", true, true),
        ("/Users/Me/ops/credentials.bak/prod", true, true),
        ("/tmp/x/.ssh", true, true),
        ("/tmp/x/.ssh/keys", true, true),
        ("/tmp/backup/.config/gh", true, true),
        ("/tmp/backup/.local/share/keyrings", true, true),
        ("/Volumes/Ext/ops/secrets/prod", true, true),
        ("/tmp/x/.env.d", true, true),
        // A folder named only for credentials holds them, like `secrets`; a root below it
        // would hide that.
        ("/Users/Me/ops/my-secrets/prod", true, true),
        ("/tmp/x/prod-credentials/db", true, true),
        ("/tmp/x/passwords_old/x", true, true),
        ("/tmp/x/my-secrets", false, false),
        // A credential folder opened as the root keeps its contents: the user chose it, and
        // `secret_path` judges paths relative to the root.
        ("/Users/Me/ops/secrets", false, false),
        // Plan mode refuses every unknown dot folder on the way.
        ("/tmp/x/.hidden/app", false, true),
        ("/tmp/x/.github/workflows", false, false),
        ("/Users/Me/code/.worktrees/app", false, true),
    ]);
}

/// Cloud drives and iCloud app folders hold projects; editor and shell dot folders are repos.
#[test]
fn cloud_drives_and_dotfile_repos_under_home_are_explored() {
    roots("/Users/Me", &[
        ("/Users/Me/Library/CloudStorage/Dropbox/code/app", false, false),
        ("/Users/Me/Library/CloudStorage/OneDrive-Personal/app", false, false),
        ("/Users/Me/Library/CloudStorage/GoogleDrive-me@x.com/My Drive/app", false, false),
        ("/Users/Me/Library/CloudStorage/Box-Box/app", false, false),
        ("/Users/Me/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault", false, false),
        ("/Users/Me/Library/Mobile Documents/com~apple~CloudDocs/code/app", false, false),
        // Per-file rules still apply inside them.
        ("/Users/Me/Library/CloudStorage/Dropbox/.ssh", true, true),
        ("/Users/Me/Library/Containers/com.x/Data", true, true),
        ("/Users/Me/.dotfiles", false, true),
        ("/Users/Me/.dotfiles/zsh", false, true),
        ("/Users/Me/.emacs.d", false, true),
        ("/Users/Me/.vim", false, true),
        ("/Users/Me/.vim/pack", false, true),
        // Any other folder under a home dot folder is a tool's app data.
        ("/Users/Me/.claude/skills/x", true, true),
        ("/Users/Me/.codex/sessions", true, true),
        ("/Users/Me/.vimrc.d", true, true),
        ("/Users/Me/.dotfiles-private/.ssh", true, true),
    ]);
}

#[test]
fn an_app_data_refusal_says_so() {
    let home = Some(Path::new("/Users/Me"));
    assert_eq!(root_refusal(Path::new("/Users/Me/Library/Containers/x"), home, false), Some(APP_DATA));
    assert_eq!(root_refusal(Path::new("/Users/Me/.config/gh"), home, false), Some(APP_DATA));
    assert_eq!(root_refusal(Path::new("/Users/Me"), home, false), Some(TOO_BROAD));
    assert_eq!(root_refusal(Path::new("/Users/Me/ops/secrets/x"), home, false), Some(CREDENTIALS));
}

/// Homes are found at the top of a mounted disk (WSL's Windows drive) and as `/root`.
#[test]
fn homes_on_other_disks_and_roots_home_are_refused() {
    roots("/Users/Me", &[
        ("/mnt/c/Users/me", true, true),
        ("/Volumes/Old/Users/me", true, true),
        // The folder of every home on that disk.
        ("/Volumes/Old/Users", true, true),
        ("/Volumes/Old/Users/me/.ssh", true, true),
        ("/Volumes/Old/Users/me/.codex/x", true, true),
        ("/Volumes/Old/Users/me/Library/Keychains", true, true),
        ("/mnt/c/Users/me/AppData/Roaming/x", true, true),
        ("/mnt/c/Users/me/code/app", false, false),
        ("/Volumes/Old/.ssh/Users/me/code", true, true),
        ("/Volumes/Old/Users/me/code/app", false, false),
        ("/Volumes/Old/Users/Shared/app", false, false),
        ("/root", true, true),
        ("/root/app", true, true),
        ("/private/var/home/other/app", true, true),
        // Inside this home, folder names never make a home.
        ("/Users/Me/code/home/bob", false, false),
        ("/Users/Me/code/users/bob/app", false, false),
    ]);
    roots("/root", &[("/root", true, true), ("/root/app", false, false), ("/root/.ssh", true, true), ("/home/me/app", true, true)]);
    roots("/var/home/me", &[("/var/home/me/app", false, false), ("/var/home/other/app", true, true), ("/var/home/me", true, true), ("/var/home", true, true)]);
}

#[test]
fn too_broad_folders_are_refused() {
    let home = Some(Path::new("/Users/Me"));
    for root in ["/", "/Users", "/Users/Me", "/users/me", "/etc", "/var", "/private/var", "/private/tmp", "/tmp", "/proc/1", "/dev/fd", "/Users/Me/Library", "/Users/Me/.ssh", "/Users/Me/.aws/x", "/Volumes/Disk", "/mnt", "/mnt/data", "/media", "/media/me/disk", "/run/media/me/disk", "/Windows/System32", "/ProgramData/x", "/mnt/c/Windows", "/mnt/c/windows/System32", "/mnt/c/ProgramData", "/Volumes/Win/Windows", "/media/me/disk/ProgramData/x"] {
        assert!(refused_root(Path::new(root), home, false), "{root}");
        assert!(refused_root(Path::new(root), home, true), "{root}");
    }
    for root in ["/Users/Me/code/app", "/Users/Me/Library/Mobile Documents/com~apple~CloudDocs/code/app", "/var/www/app", "/private/var/folders/x/T/repo", "/tmp/repo", "/opt/app", "/Volumes/Disk/code/app", "/mnt/data/app", "/media/me/disk/app", "/run/media/me/disk/app", "/Users/Shared/app", "/System/Volumes/Data/Users/Me/code/app", "/opt", "/srv", "/private/tmp/repo", "/mnt/c/code/app", "/private/x"] {
        assert!(!refused_root(Path::new(root), home, false), "{root}");
        assert!(!refused_root(Path::new(root), home, true), "{root}");
    }
    assert!(refused_root(Path::new("/"), None, false));
    // With no home known, nobody's home can be told apart, so every home is refused.
    for root in ["/Users/Me", "/Users/Me/code/app", "/home/me/app"] {
        assert!(refused_root(Path::new(root), None, false), "{root}");
    }
    assert!(!refused_root(Path::new("/opt/app"), None, false));
    // Every dot folder directly under home holds logins (`.config/github-copilot`,
    // `.local/share/keyrings`) for both rules.
    for root in ["/Users/Me/.claude", "/Users/Me/.codex", "/Users/Me/.config", "/Users/Me/.local"] {
        assert!(refused_root(Path::new(root), home, true), "{root}");
        assert!(refused_root(Path::new(root), home, false), "{root}");
    }
    // Under `~/.config`, `~/.local`, `~/Library` and `~/AppData` tools keep logins, tokens and
    // browser profiles: only the editor and shell folders on the allowlist may be explored.
    for root in [
        "/Users/Me/.config/gh", "/Users/Me/.config/gh/x", "/Users/Me/.config/gcloud", "/Users/Me/.config/github-copilot", "/Users/Me/.local/share", "/Users/Me/.local/share/keyrings",
        "/Users/Me/.config/glab-cli", "/Users/Me/.config/doctl", "/Users/Me/.config/op", "/Users/Me/.config/stripe", "/Users/Me/.config/hub", "/Users/Me/.config/configstore", "/Users/Me/.config/heroku", "/Users/Me/.config/hcloud", "/Users/Me/.config/x",
        "/Users/Me/.local/share/x", "/Users/Me/.local/state/app",
        "/Users/Me/Library/Application Support", "/Users/Me/Library/Application Support/Google/Chrome/Default", "/Users/Me/Library/Containers/com.x",
        "/Users/Me/AppData/Roaming/gh", "/Users/Me/AppData/Local/x",
    ] {
        assert!(refused_root(Path::new(root), home, false), "{root}");
        assert!(refused_root(Path::new(root), home, true), "{root}");
    }
    for name in ["nvim", "fish", "zed", "helix", "alacritty", "kitty", "wezterm"] {
        for root in [format!("/Users/Me/.config/{name}"), format!("/Users/Me/.config/{name}/lua")] {
            assert!(!refused_root(Path::new(&root), home, false), "{root}");
            // Plan mode refuses every unknown dot folder.
            assert!(refused_root(Path::new(&root), home, true), "{root}");
        }
    }
    // Other users' homes, root's home, and this home through the data-volume firmlink.
    for root in ["/Users/Other", "/Users/Other/code/app", "/home/other/app", "/home/other", "/var/root", "/var/root/x", "/private/var/root/x", "/System/Volumes/Data", "/System/Volumes/Data/Users", "/System/Volumes/Data/Users/Me", "/System/Volumes/Data/Users/Me/.ssh", "/System/Volumes/Data/Users/Me/Library/Containers/x"] {
        assert!(refused_root(Path::new(root), home, false), "{root}");
        assert!(refused_root(Path::new(root), home, true), "{root}");
    }
    // macOS keeps the system on its own volume, which reaches every home through a firmlink.
    for root in ["/System", "/System/Volumes", "/system/volumes"] {
        assert!(refused_root(Path::new(root), home, false), "{root}");
        assert!(refused_root(Path::new(root), home, true), "{root}");
    }
    let linux = Some(Path::new("/home/me"));
    assert!(!refused_root(Path::new("/home/me/app"), linux, false));
    assert!(refused_root(Path::new("/home/you/app"), linux, false));
    assert!(refused_root(Path::new("/Users/you/app"), linux, false));
}

/// A `home` or `users` folder is a folder of homes only at the top of a disk.
#[test]
fn home_and_users_folders_in_projects_are_explored() {
    let cases = [
        "/tmp/x/home/site", "/tmp/x/services/users", "/tmp/x/services/users/src", "/srv/app/services/users", "/var/www/home/app", "/workspace/home", "/data/home/web",
        "/Volumes/SSD/code/users", "/opt/home/app", "/srv/www/home", "/tmp/repo/users/alice", "/srv/backup/home", "/mnt/c/code/Users/me", "/media/u/disk/x/home/me",
    ];
    let cases: Vec<(&str, bool, bool)> = cases.iter().map(|root| (*root, false, false)).collect();
    roots("/Users/Me", &cases);
    roots("/home/me", &cases);
    roots("/Users/Me", &[
        ("/mnt/c/Users/me", true, true),
        ("/mnt/c/Users", true, true),
        ("/Volumes/Old/Users/me", true, true),
        ("/media/u/disk/home/me", true, true),
        ("/run/media/u/disk/home/me", true, true),
        ("/media/u/disk/home/me/code/app", false, false),
        ("/run/media/u/disk/home/me/.ssh", true, true),
        ("/home/other", true, true),
        ("/var/home/other", true, true),
    ]);
}

/// Other agent apps keep their worktrees in a dot folder; a worktree is a project.
#[test]
fn agent_app_worktrees_are_explored() {
    roots("/Users/Me", &[
        ("/Users/Me/.codex/worktrees/a1b2/app", false, false),
        ("/Users/Me/.cursor/worktrees/app/x1", false, false),
        ("/Users/Me/code/app/.claude/worktrees/x", false, false),
        ("/tmp/repo/.claude/worktrees/x/src", false, false),
        ("/Users/Me/.claude/worktrees/app", false, false),
        // Per-folder rules still apply, and the rest of those dot folders stays refused.
        ("/Users/Me/.codex/worktrees/a1b2/app/.ssh", true, true),
        ("/Users/Me/.codex/sessions", true, true),
        ("/Users/Me/.codex", true, true),
        ("/Users/Me/code/app/.claude/skills", false, true),
        ("/Users/Me/code/app/.vscode/worktrees/x", false, true),
    ]);
}

/// Folders named like env files are folders; the user's home and its ancestors are only ever
/// too broad, never inside app data.
#[test]
fn env_named_folders_and_ancestors_of_home() {
    roots("/Users/Me", &[
        ("/Users/Me/code/my.env.tools/app", false, false),
        ("/Users/Me/code/.env-tools", false, true),
        ("/tmp/x/my.env.tools", false, false),
        ("/tmp/x/.env.d", true, true),
    ]);
    roots("/var/lib/jenkins", &[("/var/lib", true, true), ("/var/lib/jenkins/app", false, false)]);
}

#[test]
fn home_falls_back_to_the_system_record() {
    assert_eq!(home_with(|_| None), std::env::home_dir().filter(|home| !home.as_os_str().is_empty()));
    assert_eq!(home_with(|key| (key == "USERPROFILE").then(|| "/u".into())), Some("/u".into()));
    assert!(home_with(|_| Some("".into())).is_some_and(|home| !home.as_os_str().is_empty()) || std::env::home_dir().is_none());
}

/// A home is compared without macOS's aliases, as the root is.
#[test]
fn a_home_under_private_is_this_home() {
    roots("/private/var/folders/x/home", &[("/private/var/folders/x/home", true, true), ("/var/folders/x/home", true, true), ("/private/var/folders/x/home/app", false, false), ("/private/var/folders/x/home/.ssh", true, true)]);
    roots("/System/Volumes/Data/Users/Me", &[("/Users/Me", true, true), ("/Users/Me/code/app", false, false), ("/Users/Me/.codex/x", true, true)]);
}

/// Folder names are compared in the system's own case: on Linux `/home/Me` is someone else.
#[test]
fn homes_are_compared_in_the_systems_case() {
    let home = Some(Path::new("/home/me"));
    for strict in [false, true] {
        assert_eq!(refusal(Path::new("/home/Me/p"), home, strict, false), Some(TOO_BROAD));
        assert_eq!(refusal(Path::new("/home/me/p"), home, strict, false), None);
        assert_eq!(refusal(Path::new("/home/Me/p"), home, strict, true), None);
        assert_eq!(refusal(Path::new("/home/me/p"), Some(Path::new("/home/Me")), strict, false), Some(TOO_BROAD));
        assert_eq!(refusal(Path::new("/HOME/me/p"), home, strict, false), Some(TOO_BROAD));
        // Rule names stay case-blind: `.SSH` is a login folder anywhere.
        assert_eq!(refusal(Path::new("/home/me/p/.SSH"), home, strict, false), Some(CREDENTIALS));
        assert_eq!(refusal(Path::new("/System/Volumes/Data/home/me/p"), home, strict, false), None);
    }
    assert_eq!(root_refusal(Path::new("/home/Me/p"), home, false).is_some(), !cfg!(any(target_os = "macos", windows)));
}
