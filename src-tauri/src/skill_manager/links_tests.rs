//! Tests for `links.rs`: the platform decisions run everywhere, the file system steps on Unix.
use super::*;

#[test]
fn skill_manager_links_windows_directory_links_are_removed_as_directories() {
    assert_eq!(unlink_kind(true, true), Unlink::Dir);
    assert_eq!(unlink_kind(true, false), Unlink::File);
    // Unix links are file entries even when they lead to a folder.
    assert_eq!(unlink_kind(false, true), Unlink::File);
    assert_eq!(unlink_kind(false, false), Unlink::File);
}

#[test]
fn skill_manager_links_windows_restore_falls_back_to_a_junction_then_a_copy() {
    use Make::*;
    assert_eq!(
        plan(true, Target::Dir, Purpose::Restore),
        [SymlinkDir, Junction, CopyDir]
    );
    assert_eq!(
        plan(true, Target::File, Purpose::Restore),
        [SymlinkFile, CopyFile]
    );
    assert_eq!(plan(true, Target::Missing, Purpose::Restore), [SymlinkDir]);
    for target in [Target::Dir, Target::File, Target::Missing] {
        assert_eq!(plan(false, target, Purpose::Restore), [Symlink]);
        assert_eq!(plan(false, target, Purpose::Copy), [Symlink]);
    }
}

#[test]
fn skill_manager_links_folder_copies_never_junction_or_copy_a_link_target() {
    for target in [Target::Dir, Target::File, Target::Missing] {
        let steps = plan(true, target, Purpose::Copy);
        assert!(!steps.is_empty());
        assert!(steps
            .iter()
            .all(|s| matches!(s, Make::SymlinkDir | Make::SymlinkFile)));
    }
}

#[test]
fn skill_manager_links_restore_tries_each_way_and_never_reports_a_skip_as_success() {
    let steps = plan(true, Target::Dir, Purpose::Restore);
    let mut tried = Vec::new();
    attempt(steps, |step| {
        tried.push(step);
        if step == Make::CopyDir {
            Ok(())
        } else {
            Err(io::Error::other("no privilege"))
        }
    })
    .unwrap();
    assert_eq!(tried, steps);
    // Every way failing is an error, never a silent success.
    let error = attempt(steps, |_| Err(io::Error::other("no"))).unwrap_err();
    assert_eq!(error.to_string(), "no");
    assert!(attempt(&[], |_| Ok(())).is_err());
}

#[test]
fn skill_manager_links_an_occupied_path_stops_the_fallbacks() {
    let mut tried = Vec::new();
    let error = attempt(plan(true, Target::Dir, Purpose::Restore), |step| {
        tried.push(step);
        Err(io::Error::from(io::ErrorKind::AlreadyExists))
    })
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(tried, [Make::SymlinkDir]);
}

#[test]
fn skill_manager_links_junction_paths_refuse_cmd_expansion() {
    for text in [r#"C:\a"b"#, r"C:\%PATH%", r"C:\a!b", "C:\\a\nb"] {
        assert!(unsafe_for_cmd(text), "{text}");
    }
    assert!(!unsafe_for_cmd(r"C:\Program Files (x86)\skills\a & b"));
}

#[cfg(unix)]
mod unix {
    use super::*;
    use crate::skill_manager::tests::Fixture;

    #[test]
    fn skill_manager_links_remove_link_unlinks_only_the_alias() {
        let f = Fixture::new();
        f.skill("target", "keep");
        let link = f.0.join("link");
        std::os::unix::fs::symlink(f.0.join("target"), &link).unwrap();
        remove_link(&link).unwrap();
        assert!(fs::symlink_metadata(&link).is_err());
        assert!(f.0.join("target/SKILL.md").is_file());
        // A real folder is never removed as if it were a link.
        assert!(remove_link(&f.0.join("target")).is_err());
        assert!(f.0.join("target/SKILL.md").is_file());
    }

    #[test]
    fn skill_manager_links_recreate_puts_back_relative_and_dangling_links() {
        let f = Fixture::new();
        f.skill("root/target", "keep");
        recreate(Path::new("target"), &f.0.join("root/relative")).unwrap();
        assert_eq!(
            fs::read_link(f.0.join("root/relative")).unwrap(),
            Path::new("target")
        );
        assert!(f.0.join("root/relative/SKILL.md").is_file());
        recreate(&f.0.join("gone"), &f.0.join("root/dangling")).unwrap();
        assert!(fs::symlink_metadata(f.0.join("root/dangling"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn skill_manager_links_recreate_never_replaces_what_is_there() {
        let f = Fixture::new();
        f.skill("target", "keep");
        f.skill("occupied", "mine");
        let error = recreate(&f.0.join("target"), &f.0.join("occupied")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read_to_string(f.0.join("occupied/SKILL.md")).unwrap(),
            "mine"
        );
    }

    #[test]
    fn skill_manager_links_remove_any_unlinks_links_and_deletes_folders() {
        let f = Fixture::new();
        f.skill("target", "keep");
        f.skill("folder", "x");
        std::os::unix::fs::symlink(f.0.join("target"), f.0.join("link")).unwrap();
        remove_any(&f.0.join("link")).unwrap();
        remove_any(&f.0.join("folder")).unwrap();
        assert!(f.0.join("target/SKILL.md").is_file());
        assert!(!f.0.join("folder").exists());
    }

    #[test]
    fn skill_manager_links_copy_dir_and_file_fallbacks_refuse_an_occupied_path() {
        let f = Fixture::new();
        f.skill("target", "keep");
        copy_dir(&f.0.join("target"), &f.0.join("copy")).unwrap();
        assert_eq!(
            fs::read_to_string(f.0.join("copy/SKILL.md")).unwrap(),
            "keep"
        );
        assert!(copy_dir(&f.0.join("target"), &f.0.join("copy")).is_err());
        copy_file(&f.0.join("target/SKILL.md"), &f.0.join("file.md")).unwrap();
        let error = copy_file(&f.0.join("target/SKILL.md"), &f.0.join("file.md")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        // No temporary copies are left behind.
        let names: Vec<_> = fs::read_dir(&f.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            names.iter().all(|n| !n.contains("pandacode-restore")),
            "{names:?}"
        );
    }
}
