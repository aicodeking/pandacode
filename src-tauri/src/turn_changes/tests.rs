use super::*;
pub(super) struct Fixture {
    base: PathBuf,
    pub(super) root: PathBuf,
    pub(super) cache: PathBuf,
}
impl Fixture {
    pub(super) fn new(git: bool) -> Self {
        let base = std::env::temp_dir().join(format!("pandacode-changes-{}", storage::id()));
        let root = base.join("project");
        fs::create_dir_all(&root).unwrap();
        let cache = base.join("cache");
        let f = Self { base, root, cache };
        if git {
            f.git(&["init"]);
        }
        f
    }
    pub(super) fn write(&self, path: &str, text: impl AsRef<[u8]>) {
        let path = self.root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    fn git(&self, args: &[&str]) {
        let out = std::process::Command::new("git")
            .current_dir(&self.root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    fn commit(&self) {
        self.git(&["add", "--all"]);
        self.git(&[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "Fixture",
        ]);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}
fn write_tool(tracker: &mut Tracker, id: &str, status: &str, paths: &[&str]) {
    tracker.observe_tool(
        id,
        &crate::providers::ToolActivity {
            id: id.into(),
            name: "Write".into(),
            status: status.into(),
            input: String::new(),
            output: String::new(),
            write_paths: Some(paths.iter().map(|p| (*p).into()).collect()),
        },
    );
}
fn capture(f: &Fixture, edit: impl FnOnce()) -> Captured {
    let before = scan(&f.root, &f.cache, None);
    edit();
    let after = scan(&f.root, &f.cache, Some(&before.known));
    compare(&before, &after, false)
}
#[test]
fn dirty_untracked_and_committed_bytes_compare_against_the_actual_start() {
    let f = Fixture::new(true);
    f.write("tracked.txt", "initial\n");
    f.commit();
    f.write("tracked.txt", "pre-existing dirty\n");
    f.write("unchanged.txt", "pre-existing untracked\n");
    let got = capture(&f, || {
        f.write("tracked.txt", "pre-existing dirty\nnew line\n");
        f.commit();
    });
    assert_eq!(got.summary.files.len(), 1);
    assert_eq!(got.summary.files[0].path, "tracked.txt");
    assert_eq!(got.summary.additions, 1);
    assert_eq!(got.summary.deletions, 0);
    assert!(got.details[0].patch.contains("+new line"));
    assert!(!got.details[0].patch.contains("-initial"));
}
#[test]
fn additions_deletions_exact_renames_binary_and_non_git_projects() {
    let f = Fixture::new(false);
    f.write("gone.txt", "gone\n");
    f.write("old.txt", "move me\n");
    f.write("image.bin", [0, 1, 2]);
    let got = capture(&f, || {
        fs::remove_file(f.root.join("gone.txt")).unwrap();
        fs::rename(f.root.join("old.txt"), f.root.join("new.txt")).unwrap();
        f.write("added.txt", "first\nsecond\n");
        f.write("image.bin", [0, 3, 4]);
    });
    assert_eq!(got.summary.files.len(), 4);
    let find = |name| got.summary.files.iter().find(|x| x.path == name).unwrap();
    assert_eq!(find("gone.txt").status, "deleted");
    assert_eq!(find("new.txt").status, "renamed");
    assert_eq!(find("new.txt").old_path.as_deref(), Some("old.txt"));
    assert_eq!(find("added.txt").additions, Some(2));
    assert!(find("image.bin").binary);
    assert!(find("image.bin").additions.is_none());
}
#[test]
fn patches_are_immutable_scoped_persisted_and_survive_restart() {
    let f = Fixture::new(false);
    f.write("a.txt", "before\n");
    let got = capture(&f, || f.write("a.txt", "after\n"));
    let id = got.summary.id.clone();
    let database = f.base.join("state.sqlite");
    let sid;
    {
        let store = Store::open(&database).unwrap();
        let project = store.add_project(&f.root).unwrap();
        let task = store
            .create_session(&project.id, "claude", "default", "ask")
            .unwrap();
        sid = task.id;
        let user = store.start_turn_message(&sid, "Change a").unwrap();
        let owner = persist(&store, &sid, got).unwrap();
        assert!(owner > user);
        let messages = store.messages(&sid, None).unwrap();
        assert_eq!(messages.last().unwrap().role, "changes");
        assert!(messages.last().unwrap().turn_changes.is_some());
        let other = store
            .create_session(&project.id, "codex", "default", "ask")
            .unwrap();
        assert!(detail(&store, &other.id, &id, "a.txt").is_err());
        assert!(summary(&store, &other.id, &id).is_err());
        assert!(summary(&store, &sid, "invalid-id").is_err());
        assert_eq!(summary(&store, &sid, &id).unwrap().files[0].path, "a.txt");
        assert!(detail(&store, &sid, &id, "../a.txt").is_err());
    }
    f.write("a.txt", "later edit\n");
    let store = Store::open(&database).unwrap();
    assert_eq!(summary(&store, &sid, &id).unwrap().id, id);
    let patch = detail(&store, &sid, &id, "a.txt").unwrap().patch;
    assert!(patch.contains("+after"));
    assert!(!patch.contains("later edit"));
}
#[test]
fn concurrent_checkout_leases_mark_both_runs_but_separate_worktrees_do_not() {
    let f = Fixture::new(false);
    let first = Lease::start(&f.root);
    let separate = Lease::start(&f.base.join("other"));
    assert!(!first.concurrent.load(Ordering::SeqCst));
    let second = Lease::start(&f.root);
    assert!(first.concurrent.load(Ordering::SeqCst));
    assert!(second.concurrent.load(Ordering::SeqCst));
    assert!(!separate.concurrent.load(Ordering::SeqCst));
}
#[test]
fn native_turn_boundaries_create_distinct_snapshots_and_no_duplicate_finish() {
    let f = Fixture::new(false);
    f.write("a.txt", "one\n");
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    write_tool(&mut tracker, "first", "running", &["a.txt"]);
    f.write("a.txt", "two\n");
    write_tool(&mut tracker, "first", "completed", &["a.txt"]);
    let first = tracker.boundary().unwrap();
    assert!(tracker.finish().is_none());
    tracker.started();
    write_tool(&mut tracker, "second", "running", &["a.txt"]);
    f.write("a.txt", "three\n");
    write_tool(&mut tracker, "second", "completed", &["a.txt"]);
    let second = tracker.finish().unwrap();
    assert_ne!(first.summary.id, second.summary.id);
    assert!(second.details[0].patch.contains("-two"));
    assert!(!second.details[0].patch.contains("-one"));
}
#[test]
fn myers_reports_separated_edits_and_newline_changes() {
    let got = text_patch(
        "file",
        None,
        "a\nb\nc\nd\ne\n",
        "a\nB\nc\nd\nE\n",
        true,
        true,
        PATCH_BYTES,
    )
    .unwrap();
    assert_eq!((got.1, got.2), (2, 2));
    assert!(got.0.contains("-b\n+B\n"));
    let got = text_patch("file", None, "same", "same\n", true, true, PATCH_BYTES).unwrap();
    assert_eq!((got.1, got.2), (1, 1));
    assert!(got.0.contains("No newline"));
    let many = "line\n".repeat(1200);
    assert_eq!(
        text_patch("new", None, "", &many, false, true, PATCH_BYTES)
            .unwrap()
            .1,
        1200
    );
}
#[test]
fn snapshot_limits_are_partial_without_false_deletions_or_unchanged_dirty_files() {
    let f = Fixture::new(false);
    f.write("large.txt", vec![b'a'; FILE_BYTES + 10]);
    f.write("ordinary.txt", "unchanged\n");
    let got = capture(&f, || f.write("large.txt", vec![b'b'; FILE_BYTES + 11]));
    assert!(got.summary.truncated);
    assert_eq!(got.summary.files.len(), 1);
    assert_eq!(got.summary.files[0].path, "large.txt");
    assert!(got.summary.files[0].additions.is_none());
    assert!(got.details[0].patch.is_empty());
    let before = scan(&f.root, &f.cache, None);
    let mut after = scan(&f.root, &f.cache, Some(&before.known));
    after.entries.clear();
    after.complete = false;
    after.truncated = true;
    assert!(compare(&before, &after, false).summary.files.is_empty());
}
#[cfg(unix)]
#[test]
fn symlink_targets_are_compared_without_reading_external_contents() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new(false);
    let outside = f.base.join("private.txt");
    fs::write(&outside, "secret never read").unwrap();
    symlink(&outside, f.root.join("link")).unwrap();
    let got = capture(&f, || {
        fs::remove_file(f.root.join("link")).unwrap();
        symlink("different-target", f.root.join("link")).unwrap();
    });
    assert_eq!(got.summary.files.len(), 1);
    assert!(!got.details[0].patch.contains("secret never read"));
    assert!(got.details[0].patch.contains("different-target"));
}
#[cfg(unix)]
#[test]
fn hard_linked_files_are_listed_but_their_content_is_never_stored() {
    let f = Fixture::new(false);
    let outside = f.base.join("id_rsa");
    fs::write(&outside, "PRIVATE KEY one\n").unwrap();
    f.write("plain.txt", "one\n");
    let got = capture(&f, || {
        // An agent links a secret in under an ordinary name, then it changes.
        fs::hard_link(&outside, f.root.join("notes.txt")).unwrap();
        fs::write(&outside, "PRIVATE KEY two\n").unwrap();
        f.write("plain.txt", "two\n");
    });
    let find = |name: &str| got.details.iter().find(|x| x.path == name).unwrap();
    let linked = find("notes.txt");
    assert!(linked.hard_linked() && linked.patch.is_empty() && linked.truncated, "{:?}", linked.error);
    assert!(!find("plain.txt").hard_linked() && find("plain.txt").patch.contains("+two"));
    let file = got.summary.files.iter().find(|x| x.path == "notes.txt").unwrap();
    assert_eq!((file.status.as_str(), file.additions, file.binary), ("added", None, false));
    // A file that was linked at the start and is modified in place keeps no "before" either.
    let modified = capture(&f, || fs::write(&outside, "PRIVATE KEY three\n").unwrap());
    assert_eq!(modified.details.len(), 1);
    assert!(modified.details[0].hard_linked() && modified.details[0].patch.is_empty());
    // Stored as JSON and read back, the marker survives (turn.diff refuses it).
    let blob = serde_json::to_string(&modified.details[0]).unwrap();
    assert!(!blob.contains("PRIVATE KEY"));
    assert!(serde_json::from_str::<TurnChangeDiff>(&blob).unwrap().hard_linked());
    // No snapshot copy of the linked content was written to the cache either.
    let mut pending = vec![f.cache.clone()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
            if entry.path().is_dir() {
                pending.push(entry.path());
            } else {
                assert!(!fs::read(entry.path()).unwrap().starts_with(b"PRIVATE KEY"), "{:?}", entry.path());
            }
        }
    }
}

#[test]
fn bounded_myers_reconstructs_original_inputs_and_matches_minimum_edit_counts() {
    let mut seed = 17u64;
    for _ in 0..500 {
        let mut generate = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (0..(seed % 18))
                .map(|_| {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                    match seed % 4 {
                        0 => "a\n",
                        1 => "b\n",
                        2 => "c\n",
                        _ => "d\n",
                    }
                })
                .collect::<Vec<_>>()
        };
        let a = generate();
        let b = generate();
        let ops = myers(&a, &b).unwrap();
        let mut old = vec![];
        let mut new = vec![];
        let mut edits = 0;
        for op in ops {
            match op {
                Op::Equal(i) => {
                    old.push(a[i]);
                    new.push(a[i]);
                }
                Op::Delete(i) => {
                    old.push(a[i]);
                    edits += 1;
                }
                Op::Add(i) => {
                    new.push(b[i]);
                    edits += 1;
                }
            }
        }
        assert_eq!(old, a);
        assert_eq!(new, b);
        let mut row: Vec<usize> = (0..=b.len()).collect();
        for (i, left) in a.iter().enumerate() {
            let mut next = vec![i + 1; b.len() + 1];
            for (j, right) in b.iter().enumerate() {
                next[j + 1] = if left == right {
                    row[j]
                } else {
                    (next[j] + 1).min(row[j + 1] + 1)
                };
            }
            row = next;
        }
        assert_eq!(edits, row[b.len()]);
    }
}
#[test]
fn autonomous_idle_edits_are_baseline_and_terminal_markers_follow_assistant_rows() {
    let f = Fixture::new(false);
    f.write("a.txt", "first\n");
    let store = Store::open(&f.base.join("state.sqlite")).unwrap();
    let project = store.add_project(&f.root).unwrap();
    let task = store
        .create_session(&project.id, "codex", "default", "ask")
        .unwrap();
    let assistant = Mutex::new(String::new());
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    store.start_turn_message(&task.id, "Do the work").unwrap();
    write_tool(&mut tracker, "first", "running", &["a.txt"]);
    f.write("a.txt", "second\n");
    write_tool(&mut tracker, "first", "completed", &["a.txt"]);
    *assistant.lock().unwrap() = "First final response".into();
    let mut boundary = crate::event(&task.id, "turn_complete", "");
    crate::save_agent_activity(&store, &assistant, &mut boundary, None).unwrap();
    let first = tracker.boundary().unwrap();
    persist(&store, &task.id, first).unwrap();
    f.write("a.txt", "idle edit\n");
    tracker.started();
    write_tool(&mut tracker, "second", "running", &["a.txt"]);
    f.write("a.txt", "idle edit\nthird\n");
    write_tool(&mut tracker, "second", "completed", &["a.txt"]);
    *assistant.lock().unwrap() = "Second final response".into();
    crate::save_agent_activity(&store, &assistant, &mut boundary, None).unwrap();
    let second = tracker.boundary().unwrap();
    assert_eq!(second.summary.additions, 1);
    assert_eq!(second.summary.deletions, 0);
    persist(&store, &task.id, second).unwrap();
    let messages = store.messages(&task.id, None).unwrap();
    assert_eq!(
        messages.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
        vec!["user", "assistant", "changes", "assistant", "changes"]
    );
    assert!(messages[2].turn_changes.is_some());
    assert!(messages[4].turn_changes.is_some());
    assert!(tracker.finish().is_none());
}
#[test]
fn retained_summary_survives_patch_eviction_and_duplicate_ids_roll_back() {
    let f = Fixture::new(false);
    f.write("a.txt", "before\n");
    let store = Store::open(&f.base.join("state.sqlite")).unwrap();
    let project = store.add_project(&f.root).unwrap();
    let task = store
        .create_session(&project.id, "kimi", "default", "ask")
        .unwrap();
    let first = capture(&f, || f.write("a.txt", "after\n"));
    let first_id = first.summary.id.clone();
    persist(&store, &task.id, first).unwrap();
    store
        .db
        .execute(
            "UPDATE turn_changes SET diff_bytes=?1 WHERE id=?2",
            params![RETAINED_BYTES, first_id],
        )
        .unwrap();
    let second = capture(&f, || f.write("a.txt", "latest\n"));
    let second_id = second.summary.id.clone();
    persist(&store, &task.id, second).unwrap();
    assert!(detail(&store, &task.id, &first_id, "a.txt")
        .unwrap()
        .error
        .unwrap()
        .contains("removed"));
    assert!(detail(&store, &task.id, &second_id, "a.txt")
        .unwrap()
        .patch
        .contains("latest"));
    assert_eq!(store.messages(&task.id, None).unwrap().len(), 2);
    let mut duplicate = capture(&f, || {});
    duplicate.summary.id = second_id;
    assert!(persist(&store, &task.id, duplicate).is_err());
    assert_eq!(store.messages(&task.id, None).unwrap().len(), 2);
}
#[cfg(unix)]
#[test]
fn snapshot_git_enumeration_never_runs_user_hooks_filters_or_external_diff_and_preserves_index() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new(true);
    f.write("a.txt", "start\n");
    f.commit();
    let script = f.base.join("must-not-run.sh");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\ntouch '{}'\n",
            f.base.join("side-effect").display()
        ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    f.git(&["config", "core.fsmonitor", script.to_str().unwrap()]);
    f.git(&["config", "diff.external", script.to_str().unwrap()]);
    f.git(&["config", "core.hooksPath", script.to_str().unwrap()]);
    let index = fs::read(f.root.join(".git/index")).unwrap();
    let head = fs::read(f.root.join(".git/HEAD")).unwrap();
    let captured = capture(&f, || f.write("a.txt", "finish\n"));
    assert_eq!(captured.summary.files.len(), 1);
    assert!(!f.base.join("side-effect").exists());
    assert_eq!(fs::read(f.root.join(".git/index")).unwrap(), index);
    assert_eq!(fs::read(f.root.join(".git/HEAD")).unwrap(), head);
}
#[test]
fn newly_unignored_preexisting_files_are_not_mislabeled_as_added() {
    let f = Fixture::new(true);
    f.write(".gitignore", "private/\n");
    f.write("private/pre-existing.txt", "old text\n");
    f.write("visible.txt", "unchanged\n");
    let got = capture(&f, || f.write(".gitignore", ""));
    assert!(!got
        .summary
        .files
        .iter()
        .any(|file| file.path == "private/pre-existing.txt"));
    assert!(got.summary.truncated);
}
#[test]
fn a_newly_visible_preexisting_copy_cannot_be_mistaken_for_a_rename() {
    let f = Fixture::new(true);
    f.write(".gitignore", "hidden/\n");
    f.write("hidden/pre-existing.txt", "same content\n");
    f.write("deleted.txt", "same content\n");
    f.commit();
    let got = capture(&f, || {
        f.write(".gitignore", "");
        fs::remove_file(f.root.join("deleted.txt")).unwrap();
    });
    assert!(!got
        .summary
        .files
        .iter()
        .any(|file| file.path == "hidden/pre-existing.txt"));
    assert_eq!(
        got.summary
            .files
            .iter()
            .find(|file| file.path == "deleted.txt")
            .unwrap()
            .status,
        "deleted"
    );
    assert!(got.summary.truncated);
}
#[cfg(unix)]
#[test]
fn metadata_only_diffs_have_canonical_headers_and_stale_cache_cleanup_is_scoped() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new(false);
    f.write("mode.txt", "unchanged\n");
    let got = capture(&f, || {
        fs::set_permissions(f.root.join("mode.txt"), fs::Permissions::from_mode(0o755)).unwrap()
    });
    let patch = &got.details[0].patch;
    assert!(patch.starts_with("diff --git a/mode.txt b/mode.txt\n"));
    assert!(patch.contains("old mode 100644\nnew mode 100755"));
    let empty = text_patch("space name\t.txt", None, "", "", false, true, PATCH_BYTES)
        .unwrap()
        .0;
    assert!(empty.starts_with("diff --git \"a/space name\\t.txt\""));
    assert!(empty.contains("new file mode 100644"));
    let abandoned = f
        .cache
        .join(format!("capture-2147483647-{}", storage::id()));
    let live = f
        .cache
        .join(format!("capture-{}-{}", std::process::id(), storage::id()));
    let unrelated = f.cache.join("unrelated");
    for path in [&abandoned, &live, &unrelated] {
        fs::create_dir_all(path).unwrap();
        fs::write(path.join("content"), "keep or clean").unwrap();
    }
    cleanup_cache(&f.cache);
    assert!(!abandoned.exists());
    assert!(live.exists());
    assert!(unrelated.exists());
}
#[test]
fn canonical_capture_fixtures_cover_all_change_shapes() {
    let f = Fixture::new(false);
    let mut fixtures = Vec::new();
    f.write("modified.txt", "before\n");
    fixtures.extend(capture(&f, || f.write("modified.txt", "after\n")).details);
    fixtures.extend(capture(&f, || f.write("added.txt", "added\n")).details);
    fixtures.extend(capture(&f, || fs::remove_file(f.root.join("added.txt")).unwrap()).details);
    fixtures.extend(capture(&f, || f.write("empty.txt", "")).details);
    fixtures.extend(capture(&f, || fs::remove_file(f.root.join("empty.txt")).unwrap()).details);
    f.write("before-name.txt", "same content\n");
    fixtures.extend(
        capture(&f, || {
            fs::rename(
                f.root.join("before-name.txt"),
                f.root.join("after-name.txt"),
            )
            .unwrap()
        })
        .details,
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fixtures.extend(
            capture(&f, || {
                fs::set_permissions(
                    f.root.join("modified.txt"),
                    fs::Permissions::from_mode(0o755),
                )
                .unwrap()
            })
            .details,
        );
    }
    // Spaces are supported on every platform; quotes and control characters
    // are Unix-only filename edge cases rather than valid Windows filenames.
    f.write("space name.txt", "before\n");
    fixtures.extend(capture(&f, || f.write("space name.txt", "after\n")).details);
    #[cfg(unix)]
    {
        let quoted = "space \"name\"\tfile.txt";
        f.write(quoted, "before\n");
        fixtures.extend(capture(&f, || f.write(quoted, "after\n")).details);
    }
    f.write("binary.bin", [0, 1, 2]);
    fixtures.extend(capture(&f, || f.write("binary.bin", [0, 3, 4])).details);
    for fixture in &fixtures {
        assert!(
            fixture.binary || fixture.patch.starts_with("diff --git "),
            "{}",
            fixture.path
        );
        assert!(!fixture.truncated);
    }
    if let Ok(path) = std::env::var("PANDACODE_DIFF_FIXTURES") {
        fs::write(path, serde_json::to_vec_pretty(&fixtures).unwrap()).unwrap();
    }
}
#[test]
fn unavailable_checkout_does_not_fabricate_file_deletions() {
    let f = Fixture::new(false);
    f.write("a.txt", "pre-existing\n");
    let before = scan(&f.root, &f.cache, None);
    fs::rename(&f.root, f.base.join("moved-project")).unwrap();
    let after = scan(&f.root, &f.cache, Some(&before.known));
    let result = compare(&before, &after, false);
    assert!(result.summary.files.is_empty());
    assert!(result.summary.truncated);
    assert!(result.summary.error.is_some());
}

#[test]
fn expired_snapshot_budget_does_not_start_git_inventory() {
    let f = Fixture::new(true);
    f.write("tracked.txt", "before\n");
    f.git(&["add", "tracked.txt"]);
    let (paths, _, complete, _) = inventory(&f.root, Instant::now());
    assert!(paths.is_empty());
    assert!(!complete);
}

#[test]
fn a_greeting_in_an_unchanged_non_git_project_has_no_change_tracking_error() {
    let f = Fixture::new(false);
    f.write("notes.txt", "existing notes\n");
    let started = Instant::now();
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    let baseline = started.elapsed();
    let capture = tracker.finish().unwrap();
    assert!(capture.summary.files.is_empty());
    assert!(!capture.summary.truncated);
    assert!(capture.summary.error.is_none());
    eprintln!(
        "unchanged non-Git capture: baseline {baseline:?}, total {:?}",
        started.elapsed()
    );
}

#[test]
fn an_unavailable_baseline_does_not_scan_again_at_completion() {
    let f = Fixture::new(false);
    f.write("before.txt", "pre-existing\n");
    fs::write(&f.cache, "cache is unavailable").unwrap();
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    write_tool(&mut tracker, "write", "running", &["after.txt"]);
    fs::remove_file(&f.cache).unwrap();
    f.write("after.txt", "created during the turn\n");
    let capture = tracker.finish().unwrap();
    assert!(capture.summary.files.is_empty());
    assert!(capture.summary.truncated);
    assert!(capture.summary.error.is_some());
    assert!(
        !f.cache.exists(),
        "a missing baseline cannot support any diff"
    );
}

#[test]
fn a_stalled_filesystem_snapshot_cannot_hold_provider_startup_or_become_a_late_baseline() {
    let (release, wait) = mpsc::channel();
    let (finished, result) = mpsc::channel();
    std::thread::spawn(move || {
        let snapshot = bounded_snapshot(
            move || {
                let _ = wait.recv_timeout(Duration::from_secs(2));
                Snapshot::unavailable("late snapshot must not be used")
            },
            Duration::from_millis(20),
        );
        let _ = finished.send(snapshot);
    });
    let snapshot = result.recv_timeout(Duration::from_secs(1));
    let _ = release.send(());
    let snapshot = snapshot.expect("startup should continue while the filesystem is still blocked");
    assert!(!snapshot.complete);
    assert!(snapshot.entries.is_empty());
    assert!(snapshot.error.as_ref().unwrap().contains("time budget"));
}

#[test]
fn task_write_tools_exclude_other_tasks_and_external_writes_in_the_same_checkout() {
    let f = Fixture::new(true);
    f.write("mine.txt", "committed\n");
    f.commit();
    f.write("mine.txt", "pre-existing dirty\n");
    let mut first = Tracker::start(f.root.clone(), f.cache.clone());
    let mut second = Tracker::start(f.root.clone(), f.cache.clone());
    f.write("external-before.txt", "outside this task\n");
    write_tool(&mut first, "write", "running", &["mine.txt"]);
    write_tool(&mut second, "write", "running", &["theirs.txt"]);
    f.write("mine.txt", "pre-existing dirty\nmy addition\n");
    f.write("theirs.txt", "another task\n");
    f.write("external-during.txt", "editor change\n");
    write_tool(&mut first, "write", "completed", &["mine.txt"]);
    write_tool(&mut second, "write", "completed", &["theirs.txt"]);
    f.write("mine.txt", "external replacement after the tool\n");
    let mine = first.finish().unwrap();
    let theirs = second.finish().unwrap();
    assert_eq!(
        mine.summary
            .files
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        vec!["mine.txt"]
    );
    assert_eq!(
        theirs
            .summary
            .files
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        vec!["theirs.txt"]
    );
    assert_eq!((mine.summary.additions, mine.summary.deletions), (1, 0));
    assert!(mine.details[0].patch.contains("+my addition"));
    assert!(!mine.details[0].patch.contains("external replacement"));
    assert!(mine.summary.concurrent && theirs.summary.concurrent);
}
#[test]
fn failed_read_and_unreported_command_changes_never_claim_checkout_files() {
    let f = Fixture::new(false);
    f.write("existing.txt", "before\n");
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    write_tool(&mut tracker, "failed", "running", &["existing.txt"]);
    f.write("existing.txt", "external write\n");
    write_tool(&mut tracker, "failed", "failed", &["existing.txt"]);
    write_tool(&mut tracker, "shell", "running", &[]);
    f.write("shell.txt", "unknown writer\n");
    write_tool(&mut tracker, "shell", "completed", &[]);
    let got = tracker.finish().unwrap();
    assert!(got.summary.files.is_empty());
    assert!(got.summary.truncated);
}
#[test]
fn shared_file_claims_are_omitted_from_both_overlapping_tasks() {
    let f = Fixture::new(false);
    f.write("shared.txt", "before\n");
    let mut first = Tracker::start(f.root.clone(), f.cache.clone());
    let mut second = Tracker::start(f.root.clone(), f.cache.clone());
    write_tool(&mut first, "a", "running", &["shared.txt"]);
    write_tool(&mut second, "b", "running", &["shared.txt"]);
    f.write("shared.txt", "mixed writes\n");
    write_tool(&mut first, "a", "completed", &["shared.txt"]);
    write_tool(&mut second, "b", "completed", &["shared.txt"]);
    for got in [first.finish().unwrap(), second.finish().unwrap()] {
        assert!(got.summary.files.is_empty());
        assert!(got.summary.truncated);
    }
}
#[test]
fn edits_between_this_tasks_tools_cannot_leak_into_its_net_patch() {
    let f = Fixture::new(false);
    f.write("file.txt", "before\n");
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    write_tool(&mut tracker, "a", "running", &["file.txt"]);
    f.write("file.txt", "first edit\n");
    write_tool(&mut tracker, "a", "completed", &["file.txt"]);
    f.write("file.txt", "external edit\n");
    write_tool(&mut tracker, "b", "running", &["file.txt"]);
    f.write("file.txt", "second edit\n");
    write_tool(&mut tracker, "b", "completed", &["file.txt"]);
    let got = tracker.finish().unwrap();
    assert!(got.summary.files.is_empty());
    assert!(got.summary.truncated);
}
#[test]
fn write_tool_paths_must_stay_inside_the_task_checkout() {
    let f = Fixture::new(false);
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    write_tool(
        &mut tracker,
        "write",
        "running",
        &[
            "../private.txt",
            ".git/config",
            "/etc/passwd",
            "./valid.txt",
        ],
    );
    f.write("valid.txt", "yes\n");
    write_tool(
        &mut tracker,
        "write",
        "completed",
        &[
            "../private.txt",
            ".git/config",
            "/etc/passwd",
            "./valid.txt",
        ],
    );
    let got = tracker.finish().unwrap();
    assert_eq!(got.summary.files.len(), 1);
    assert_eq!(got.summary.files[0].path, "valid.txt");
}
#[test]
fn same_task_native_delegate_writes_are_attributed_to_its_parent() {
    let f = Fixture::new(false);
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    let mut event = crate::event("parent", "subagent", "");
    event.data = Some(
        serde_json::json!({"id":"child","parentId":null,"name":"Worker","prompt":"Edit","status":"running","response":"","tools":[{"id":"write","name":"Write","status":"running","input":"","output":"","writePaths":["child.txt"]}],"startedAt":0,"updatedAt":0}),
    );
    tracker.observe(&event);
    f.write("child.txt", "child work\n");
    event.data.as_mut().unwrap()["tools"][0]["status"] = serde_json::json!("completed");
    tracker.observe(&event);
    assert_eq!(tracker.finish().unwrap().summary.files[0].path, "child.txt");
}

#[test]
fn repeated_sparse_path_updates_cannot_grow_the_capture_without_bounds() {
    let f = Fixture::new(false);
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    for index in 0..CHANGE_FILES + 25 {
        let path = format!("missing-{index}.txt");
        write_tool(&mut tracker, "sparse", "running", &[&path]);
    }
    assert_eq!(tracker.pending["sparse"].known.len(), CHANGE_FILES);
    assert_eq!(tracker.observed_paths.len(), CHANGE_FILES);
    assert_eq!(tracker.retained.len(), CHANGE_FILES);
    assert!(tracker.finish().unwrap().summary.truncated);
}
#[test]
fn old_checkout_summaries_remain_unattributed_and_new_tool_captures_are_marked() {
    let legacy: TurnChanges = serde_json::from_value(serde_json::json!({"id":"legacy","files":[],"additions":0,"deletions":0,"truncated":false,"concurrent":true})).unwrap();
    assert!(!legacy.attributed);
    let f = Fixture::new(false);
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    assert!(tracker.finish().unwrap().summary.attributed);
}

#[test]
fn absolute_provider_paths_accept_the_configured_task_root() {
    let f = Fixture::new(false);
    let tracker = Tracker::start(f.root.clone(), f.cache.clone());
    assert_eq!(
        tracker
            .relative_path(f.root.join("new-file.txt").to_str().unwrap())
            .as_deref(),
        Some("new-file.txt")
    );
}
#[cfg(unix)]
#[test]
fn provider_paths_preserve_a_configured_root_alias_without_following_file_symlinks() {
    let f = Fixture::new(false);
    let alias = f.base.join("alias");
    std::os::unix::fs::symlink(&f.root, &alias).unwrap();
    let tracker = Tracker::start(alias.clone(), f.cache.clone());
    assert_eq!(
        tracker
            .relative_path(alias.join("new-file.txt").to_str().unwrap())
            .as_deref(),
        Some("new-file.txt")
    );
}

#[cfg(unix)]
#[test]
fn unix_literal_backslash_filenames_are_removed_when_task_claims_conflict() {
    let f = Fixture::new(false);
    let name = "literal\\name.txt";
    f.write(name, "before\n");
    let mut first = Tracker::start(f.root.clone(), f.cache.clone());
    let mut second = Tracker::start(f.root.clone(), f.cache.clone());
    write_tool(&mut first, "a", "running", &[name]);
    write_tool(&mut second, "b", "running", &[name]);
    f.write(name, "shared writes\n");
    write_tool(&mut first, "a", "completed", &[name]);
    write_tool(&mut second, "b", "completed", &[name]);
    assert!(first.finish().unwrap().summary.files.is_empty());
    assert!(second.finish().unwrap().summary.files.is_empty());
}
#[cfg(any(target_os = "macos", windows))]
#[test]
fn case_aliases_are_conservatively_treated_as_shared_file_claims() {
    let f = Fixture::new(false);
    f.write("Name.txt", "before\n");
    let mut first = Tracker::start(f.root.clone(), f.cache.clone());
    let mut second = Tracker::start(f.root.clone(), f.cache.clone());
    write_tool(&mut first, "a", "running", &["Name.txt"]);
    write_tool(&mut second, "b", "running", &["name.txt"]);
    f.write("Name.txt", "shared writes\n");
    write_tool(&mut first, "a", "completed", &["Name.txt"]);
    write_tool(&mut second, "b", "completed", &["name.txt"]);
    for got in [first.finish().unwrap(), second.finish().unwrap()] {
        assert!(got.summary.files.is_empty());
        assert!(got.summary.truncated);
    }
}
#[test]
fn a_turn_remembers_its_last_write_until_its_boundary() {
    let f = Fixture::new(false);
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    assert_eq!(tracker.last_write(), 0);
    let before = storage::now();
    write_tool(&mut tracker, "w1", "running", &["a.txt"]);
    f.write("a.txt", "a\n");
    write_tool(&mut tracker, "w1", "completed", &["a.txt"]);
    assert!(tracker.last_write() >= before);
    tracker.boundary();
    assert_eq!(tracker.last_write(), 0, "the next turn starts undated");
}
#[test]
fn only_a_real_write_dates_a_turn() {
    let f = Fixture::new(false);
    let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
    // A shell command reports no paths: it wrote nothing anyone knows of.
    write_tool(&mut tracker, "shell", "completed", &[]);
    assert_eq!(tracker.last_write(), 0);
    write_tool(&mut tracker, "reported:capture", "running", &[]);
    assert!(tracker.last_write() > 0, "a track_files capture is a real write");
}
