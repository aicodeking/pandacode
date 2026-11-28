use super::*;

#[test]
fn postings_round_trip_wide_gaps() {
    let mut posting = Posting::default();
    let ids = [0, 1, 200, 70_000, 4_000_000_000];
    ids.iter().for_each(|&id| posting.push(id));
    assert_eq!(posting.ids(), ids);
}

#[test]
fn intersect_keeps_common_ids() {
    assert_eq!(intersect(&[1, 3, 5, 9], &[0, 3, 9, 10]), [3, 9]);
}

fn temp_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("pandacode-explore-index-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::write(root.join("a.rs"), "needle\n").unwrap();
    root.canonicalize().unwrap()
}

fn limit() -> Limit {
    Limit::new(Arc::default())
}

fn fingerprint(mtime: i128) -> Fingerprint {
    Fingerprint { size: 1, mtime, ctime: mtime, inode: 7 }
}

#[test]
fn a_panicking_worker_is_not_silently_missing_results() {
    assert_eq!(parallel(3, Some).len(), 3);
    let outcome = std::panic::catch_unwind(|| parallel(3, |at| (at < 9).then(|| panic!("worker {at}")).or(Some(at))));
    assert!(outcome.is_err());
}

#[test]
fn a_held_refresh_means_a_scan_not_a_wait() {
    let root = temp_root();
    let store = store_for(&root);
    let held = store.refreshing.lock().unwrap();
    assert!(!Snapshot::open(&root, Policy::AlwaysIndex, false, &limit()).indexed());
    drop(held);
    assert!(Snapshot::open(&root, Policy::AlwaysIndex, false, &limit()).indexed());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn delta_rereads_a_file_read_too_soon_after_it_was_written() {
    let store = Store::default();
    let path: Arc<str> = "a.rs".into();
    let walk = Walk { files: vec![WalkedFile { path: path.clone(), fingerprint: fingerprint(0) }], ..Walk::default() };
    store.table.write().unwrap().add(path.clone(), fingerprint(0), RACY_NS - 1, Some(vec![1]));
    assert_eq!(delta(&store, &walk).unwrap().0, [0], "racy: same stamp, read within the window");
    store.table.write().unwrap().add(path.clone(), fingerprint(0), RACY_NS + 1, Some(vec![1]));
    assert!(delta(&store, &walk).unwrap().0.is_empty(), "settled");
    let changed = Walk { files: vec![WalkedFile { path, fingerprint: fingerprint(1) }], ..Walk::default() };
    assert_eq!(delta(&store, &changed).unwrap().0, [0], "the stamp moved");
    let removed = delta(&store, &Walk::default()).unwrap().1;
    assert_eq!(removed.len(), 1);
}

#[test]
fn the_memory_ceiling_empties_the_table_and_later_queries_scan() {
    let root = temp_root();
    std::fs::write(root.join("b.rs"), "plenty of distinct text for several trigrams\n").unwrap();
    let store = store_for(&root);
    store.table.write().unwrap().posting_limit = Some(8);
    assert!(!Snapshot::open(&root, Policy::AlwaysIndex, false, &limit()).indexed());
    {
        let table = store.table.read().unwrap();
        assert!(table.oversize);
        assert_eq!((table.posting_bytes, table.paths.len(), table.slots.len()), (0, 0, 0));
    }
    assert!(!Snapshot::open(&root, Policy::AlwaysIndex, false, &limit()).indexed());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_table_given_up_after_this_query_refreshed_means_all_files_not_none() {
    let root = temp_root();
    let snapshot = Snapshot::open(&root, Policy::AlwaysIndex, false, &limit());
    assert!(snapshot.indexed());
    let plan = Plan::Trigram(super::super::plan::trigram(b'n', b'e', b'e'));
    assert_eq!(snapshot.candidates(&plan).unwrap().len(), 1);
    *store_for(&root).table.write().unwrap() = Table { oversize: true, ..Table::default() };
    assert!(snapshot.candidates(&plan).is_none(), "None means read every file");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn candidates_follow_this_query_s_walk_not_a_stale_table() {
    let root = temp_root();
    std::fs::write(root.join("b.rs"), "needle\n").unwrap();
    let snapshot = Snapshot::open(&root, Policy::AlwaysIndex, false, &limit());
    assert!(snapshot.indexed());
    let plan = Plan::Trigram(super::super::plan::trigram(b'n', b'e', b'e'));
    // Another query with an older walk forgot b.rs, and indexed a file this walk does not see.
    let store = store_for(&root);
    let mut table = store.table.write().unwrap();
    table.forget("b.rs");
    table.add("gone.rs".into(), fingerprint(0), 0, Some(vec![super::super::plan::trigram(b'n', b'e', b'e')]));
    drop(table);
    let mut found: Vec<String> = snapshot.candidates(&plan).unwrap().iter().map(|path| path.to_string()).collect();
    found.sort();
    assert_eq!(found, ["a.rs", "b.rs"]);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn idle_roots_are_dropped() {
    let now = Instant::now();
    let stored = |used| Stored { root: PathBuf::from("/a"), used, store: Arc::default() };
    let mut stores = vec![stored(now), stored(now)];
    stores[1].used = now.checked_sub(IDLE_ROOT + Duration::from_secs(1)).unwrap_or(now);
    drop_idle(&mut stores, now);
    assert_eq!(stores.len(), 1);
    drop_idle(&mut stores, now + IDLE_ROOT);
    assert!(stores.is_empty());
}

#[test]
fn one_table_serves_both_secret_rules() {
    let root = temp_root();
    std::fs::write(root.join("secret_store.rs"), "needle\n").unwrap();
    assert!(Arc::ptr_eq(&store_for(&root), &store_for(&root)));
    let plan = Plan::Trigram(super::super::plan::trigram(b'n', b'e', b'e'));
    let names = |snapshot: &Snapshot| snapshot.candidates(&plan).unwrap().iter().map(|path| path.to_string()).collect::<Vec<_>>();
    let plain = Snapshot::open(&root, Policy::AlwaysIndex, false, &limit());
    assert_eq!(names(&plain), ["a.rs", "secret_store.rs"]);
    let strict = Snapshot::open(&root, Policy::AlwaysIndex, true, &limit());
    assert!(strict.indexed());
    assert_eq!(names(&strict), ["a.rs"], "the strict rule hides it");
    let again = Snapshot::open(&root, Policy::AlwaysIndex, false, &limit());
    assert_eq!(names(&again), ["a.rs", "secret_store.rs"], "a strict refresh did not forget it");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_expired_limit_ends_the_walk_and_says_so() {
    let root = temp_root();
    let done = Limit::lasting(Duration::ZERO, Arc::default());
    let snapshot = Snapshot::open(&root, Policy::AlwaysIndex, false, &done);
    assert!(snapshot.walk.incomplete && !snapshot.indexed() && done.was_cut());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn compaction_drops_dead_ids_only() {
    let stamp = fingerprint(0);
    let mut table = Table::default();
    let path: Arc<str> = "a.rs".into();
    for _ in 0..2000 {
        table.add(path.clone(), stamp, 0, Some(vec![7]));
    }
    table.add("b.rs".into(), stamp, 0, Some(vec![7, 8]));
    let before = table.posting_bytes;
    table.compact();
    assert!(table.posting_bytes < before);
    assert_eq!(table.dead, 0);
    let live: Vec<_> = table.eval(&Plan::Trigram(7)).unwrap().into_iter().filter_map(|id| table.paths[id as usize].clone()).collect();
    assert_eq!(live, [path, "b.rs".into()]);
    assert_eq!(table.eval(&Plan::Trigram(8)).unwrap().len(), 1);
    assert_eq!(table.eval(&Plan::Trigram(9)).unwrap().len(), 0);
}

#[test]
fn fair_rules_for_when_to_index() {
    let walk = Walk { files: vec![WalkedFile { path: "a".into(), fingerprint: fingerprint(0) }], ..Walk::default() };
    assert!(!indexable(&walk, Policy::Auto));
    assert!(indexable(&walk, Policy::AlwaysIndex));
    assert!(!indexable(&walk, Policy::NeverIndex));
    let incomplete = Walk { incomplete: true, ..Walk::default() };
    assert!(!indexable(&incomplete, Policy::AlwaysIndex));
    let at_cap = |count: usize| Walk { files: (0..count).map(|at| WalkedFile { path: at.to_string().into(), fingerprint: fingerprint(0) }).collect(), ..Walk::default() };
    assert!(indexable(&at_cap(68_000), Policy::Auto), "the largest real project");
    assert!(indexable(&at_cap(MAX_INDEX_FILES), Policy::Auto));
    assert!(!indexable(&at_cap(MAX_INDEX_FILES + 1), Policy::Auto));
    let many = Walk { files: (0..INDEX_MIN_FILES).map(|at| WalkedFile { path: at.to_string().into(), fingerprint: fingerprint(0) }).collect(), ..Walk::default() };
    assert!(indexable(&many, Policy::Auto));
    let huge = Walk { files: vec![WalkedFile { path: "a".into(), fingerprint: Fingerprint { size: MAX_INDEX_BYTES + 1, mtime: 0, ctime: 0, inode: 0 } }], ..Walk::default() };
    assert!(!indexable(&huge, Policy::AlwaysIndex));
}

/// Another query may have indexed a binary this query's rule hides: it is not named.
#[test]
fn binaries_named_are_only_those_this_walk_saw() {
    let store = Arc::new(Store::default());
    store.table.write().unwrap().add("hidden/blob.dat".into(), fingerprint(0), 0, None);
    store.table.write().unwrap().add("seen.dat".into(), fingerprint(0), 0, None);
    let walk = Walk { files: vec![WalkedFile { path: "seen.dat".into(), fingerprint: fingerprint(0) }], ..Walk::default() };
    let snapshot = Snapshot { walk, store: Some(store) };
    assert_eq!(snapshot.binary().first, ["seen.dat"]);
}

#[test]
fn a_walked_file_the_table_holds_older_is_a_candidate() {
    let root = temp_root();
    std::fs::write(root.join("b.rs"), "needle\n").unwrap();
    let snapshot = Snapshot::open(&root, Policy::AlwaysIndex, false, &limit());
    let plan = Plan::Trigram(super::super::plan::trigram(b'n', b'e', b'e'));
    // Another query indexed b.rs as it was before, without the trigram.
    let store = store_for(&root);
    let mut table = store.table.write().unwrap();
    table.forget("b.rs");
    table.add("b.rs".into(), fingerprint(0), 0, Some(vec![super::super::plan::trigram(b'x', b'y', b'z')]));
    drop(table);
    let found: Vec<String> = snapshot.candidates(&plan).unwrap().iter().map(|path| path.to_string()).collect();
    assert_eq!(found, ["a.rs", "b.rs"]);
    std::fs::remove_dir_all(root).unwrap();
}
